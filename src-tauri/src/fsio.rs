//! File helpers every store uses: atomic writes, private folders and files, capped reads.
//! Written the same way as Hangar's `persist.rs` (MIT, same owner), so files Hangar and Hangar
//! Note write look and behave alike: a temporary file `.<name>.<pid>.<n>.tmp` in the same folder,
//! `sync_all`, then a rename over the target.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read as _, Write as _};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

const TEMP_EXT: &str = "tmp";

/// What a failed file operation means for the person, as a fixed code (ADR 0002, "Errors for
/// people"). The window and the local channel get only this code, never the operating system's
/// text or a path; those go to the log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StorageCode {
    /// Access denied, a write protected file or medium, or a file another program holds open.
    Denied,
    /// The disk (or the quota) is full.
    DiskFull,
    /// The file is larger than allowed (the note limit, or the file system's own).
    TooLarge,
    /// The file or a folder on its way is gone.
    NotFound,
    /// Anything else.
    Io,
}

impl StorageCode {
    pub const ALL: [StorageCode; 5] = [
        Self::Denied,
        Self::DiskFull,
        Self::TooLarge,
        Self::NotFound,
        Self::Io,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Denied => "denied",
            Self::DiskFull => "disk-full",
            Self::TooLarge => "too-large",
            Self::NotFound => "not-found",
            Self::Io => "io",
        }
    }

    /// The code of an I/O error: the operating system's own error number first, where one is
    /// known to mean something specific, then the portable kind.
    pub fn of(error: &io::Error) -> Self {
        if let Some(code) = error.raw_os_error().and_then(Self::of_os) {
            return code;
        }
        match error.kind() {
            io::ErrorKind::PermissionDenied | io::ErrorKind::ReadOnlyFilesystem => Self::Denied,
            io::ErrorKind::StorageFull | io::ErrorKind::QuotaExceeded => Self::DiskFull,
            io::ErrorKind::FileTooLarge => Self::TooLarge,
            io::ErrorKind::NotFound => Self::NotFound,
            _ => Self::Io,
        }
    }

    /// Windows system error codes (`winerror.h`).
    #[cfg(windows)]
    fn of_os(code: i32) -> Option<Self> {
        use windows_sys::Win32::Foundation::{
            ERROR_ACCESS_DENIED, ERROR_DISK_FULL, ERROR_FILE_NOT_FOUND, ERROR_HANDLE_DISK_FULL,
            ERROR_LOCK_VIOLATION, ERROR_PATH_NOT_FOUND, ERROR_SHARING_VIOLATION,
            ERROR_WRITE_PROTECT,
        };
        match u32::try_from(code).ok()? {
            // 5, 19; 32 and 33: another program (a sync client, a virus scanner, an editor)
            // holds the file, which for the person is the same "may not change it".
            ERROR_ACCESS_DENIED
            | ERROR_WRITE_PROTECT
            | ERROR_SHARING_VIOLATION
            | ERROR_LOCK_VIOLATION => Some(Self::Denied),
            // 112, 39.
            ERROR_DISK_FULL | ERROR_HANDLE_DISK_FULL => Some(Self::DiskFull),
            ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => Some(Self::NotFound),
            _ => None,
        }
    }

    /// POSIX error numbers; these have the same values on Linux and macOS (`errno.h`), so no
    /// `libc` is needed for them. `EDQUOT`, which differs, comes through `QuotaExceeded`.
    #[cfg(unix)]
    fn of_os(code: i32) -> Option<Self> {
        const EPERM: i32 = 1;
        const ENOENT: i32 = 2;
        const EACCES: i32 = 13;
        const EFBIG: i32 = 27;
        const ENOSPC: i32 = 28;
        const EROFS: i32 = 30;
        match code {
            EACCES | EPERM | EROFS => Some(Self::Denied),
            ENOSPC => Some(Self::DiskFull),
            EFBIG => Some(Self::TooLarge),
            ENOENT => Some(Self::NotFound),
            _ => None,
        }
    }
}

/// The kinds of file a log line may name (security review B3). Nothing more specific: a note's
/// file name is its title.
pub const LOG_FILE_KINDS: [&str; 8] = [
    "note",
    "folder.json",
    "trash.json",
    "meta.json",
    "settings.json",
    "endpoint.json",
    "folder",
    "file",
];

/// The kind of file `path` is, for the log: what the file is named after, never the name itself.
/// A temporary file of an atomic write (`.<name>.<pid>.<n>.tmp`) counts as the file it replaces;
/// a set-aside copy (`<name>.broken-<millis>`) as the file it was.
fn log_file_kind(path: &Path) -> &'static str {
    let Some(name) = path
        .file_name()
        .map(|name| name.to_string_lossy().to_lowercase())
    else {
        return "folder";
    };
    let mut base = name.as_str();
    if let Some(temp) = base.strip_suffix(&format!(".{TEMP_EXT}")) {
        // `.<name>.<pid>.<n>`: the name is everything before the last two parts.
        let temp = temp.strip_prefix('.').unwrap_or(temp);
        base = temp.rsplitn(3, '.').nth(2).unwrap_or(temp);
    }
    if let Some((before, _)) = base.split_once(".broken-") {
        base = before;
    }
    match base {
        "folder.json" => "folder.json",
        "trash.json" => "trash.json",
        "meta.json" | ".hangar-note-meta.json" => "meta.json",
        "settings.json" => "settings.json",
        "endpoint.json" => "endpoint.json",
        _ if Path::new(base)
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("md")) =>
        {
            "note"
        }
        _ if path.extension().is_none() => "folder",
        _ => "file",
    }
}

/// Whether `name` is a scope folder of the notes tree: `general`, Hangar's old `allgemein`, or 32
/// hex digits (the hash of a working folder, which names nothing on its own).
fn is_area(name: &str) -> bool {
    matches!(name, "general" | "allgemein")
        || (name.len() == 32 && name.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// The scope folder `path` belongs to: itself, its folder, or, for the trash, the folder above.
/// `-` outside the notes tree. Only the scope key ever reaches the log, never a name below it.
fn log_area(path: &Path) -> String {
    let name = |p: Option<&Path>| {
        p.and_then(Path::file_name)
            .map(|n| n.to_string_lossy().into_owned())
    };
    let own = name(Some(path));
    let parent = name(path.parent());
    let grandparent = name(path.parent().and_then(Path::parent));
    let trash = |n: &Option<String>| matches!(n.as_deref(), Some(".trash" | ".papierkorb"));
    [
        own.clone().filter(|_| path.extension().is_none()),
        parent.clone(),
        grandparent.filter(|_| trash(&parent) || trash(&own)),
    ]
    .into_iter()
    .flatten()
    .find(|candidate| is_area(candidate))
    .unwrap_or_else(|| "-".to_owned())
}

/// What caused an I/O error, for the log: the operating system's error number, else the portable
/// kind. Never the OS text, which can quote a path.
pub fn log_cause(error: &io::Error) -> String {
    match error.raw_os_error() {
        Some(code) => format!("os error {code}"),
        None => format!("{:?}", error.kind()),
    }
}

/// A storage failure as the log shows it (security review B3): the scope key, the kind of file and
/// the cause, nothing else. Pure, so it is tested: no file name, no path below the notes root, no
/// title, no content. `cause` is [`log_cause`] or a fixed reason.
pub fn storage_log(path: &Path, cause: &str) -> String {
    format!(
        "{} in area {} ({cause})",
        log_file_kind(path),
        log_area(path)
    )
}

/// [`storage_log`] for an I/O error.
pub fn storage_log_io(path: &Path, error: &io::Error) -> String {
    storage_log(path, &log_cause(error))
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Locks a mutex even if another thread panicked while holding it. Every value guarded here is
/// only replaced as a whole after its file write succeeded, so it stays consistent.
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

pub fn now_ms() -> u64 {
    millis(SystemTime::now()).unwrap_or(0)
}

pub fn millis(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| u64::try_from(d.as_millis()).ok())
}

/// Writes to a unique temporary file in the same folder first, then renames it over the target.
/// `rename` replaces the target on all platforms and within one folder is a single operation, so
/// readers see either the old or the new file, never half of one.
pub fn write_atomic(path: &Path, data: &[u8]) -> io::Result<()> {
    write_atomic_with(path, data, create_private_file)
}

/// Like [`write_atomic`] for a file only its owner may open on every platform: 0600 on Unix, an
/// explicit protected DACL for the user and SYSTEM on Windows (`winsec.rs`), which a profile
/// folder's inherited ACL never widens. For files that hold a secret (`endpoint.json`).
pub fn write_atomic_owner_only(path: &Path, data: &[u8]) -> io::Result<()> {
    #[cfg(windows)]
    {
        write_atomic_with(path, data, crate::winsec::create_owner_only)
    }
    #[cfg(not(windows))]
    {
        write_atomic_with(path, data, create_private_file)
    }
}

fn write_atomic_with(
    path: &Path,
    data: &[u8],
    create: fn(&Path) -> io::Result<File>,
) -> io::Result<()> {
    let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path without folder or file name",
        ));
    };
    create_private_dir(dir)?;
    let temp = dir.join(format!(
        ".{}.{}.{}.{TEMP_EXT}",
        name.to_string_lossy(),
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = create(&temp)?;
        file.write_all(data)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

/// Folders 0700 on Unix. On Windows the folder lives in the user profile and inherits its ACL.
pub fn create_private_dir(dir: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)
}

fn create_private_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Opens `path` for reading only if it is a regular file: a link, folder, FIFO or device named
/// like a note is refused, since it could lead outside the folder or never end.
fn open_regular(path: &Path) -> io::Result<File> {
    if !fs::symlink_metadata(path)?.file_type().is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a regular file",
        ));
    }
    File::open(path)
}

/// At most `max` bytes of a regular file; `Ok(None)` when it holds more.
pub fn read_capped(path: &Path, max: usize) -> io::Result<Option<Vec<u8>>> {
    let file = open_regular(path)?;
    let mut bytes = Vec::new();
    let limit = u64::try_from(max).unwrap_or(u64::MAX).saturating_add(1);
    file.take(limit).read_to_end(&mut bytes)?;
    Ok((bytes.len() <= max).then_some(bytes))
}

/// The first `max` bytes of a regular file, however large it is.
pub fn read_prefix(path: &Path, max: usize) -> io::Result<Vec<u8>> {
    let file = open_regular(path)?;
    let mut bytes = Vec::new();
    file.take(u64::try_from(max).unwrap_or(u64::MAX))
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// The longest prefix of `bytes` that is valid UTF-8, at most `max` bytes.
pub fn utf8_prefix(bytes: &[u8], max: usize) -> String {
    let cut = &bytes[..bytes.len().min(max)];
    match std::str::from_utf8(cut) {
        Ok(text) => text.to_owned(),
        Err(error) => String::from_utf8_lossy(&cut[..error.valid_up_to()]).into_owned(),
    }
}

/// Renames `from` to `to` only while `to` does not exist, in one step: a file that appeared under
/// `to` after a check for a free name is never replaced (security review L3); the caller gets
/// [`io::ErrorKind::AlreadyExists`] and picks the next name. `std::fs::rename` replaces the
/// target on every platform.
///
/// - Windows: `MoveFileExW` without `MOVEFILE_REPLACE_EXISTING`. A change of case only
///   (`a.md` to `A.md`) renames the file itself.
/// - Unix: `hard_link` (which fails if `to` exists), then `remove_file(from)`. A change of case
///   only on a file system that compares names without case (macOS) finds `to` "taken" by the
///   file itself and renames it in place. A file system without hard links (FAT, some network
///   shares) falls back to a check and `rename`, the one case left with a short window.
pub fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
        let from_wide = wide_verbatim(from)?;
        let to_wide = wide_verbatim(to)?;
        // SAFETY: both buffers are NUL-terminated UTF-16 strings that live until the call returns;
        // flags 0 means: fail if the target exists, never copy across volumes.
        let moved = unsafe { MoveFileExW(from_wide.as_ptr(), to_wide.as_ptr(), 0) };
        if moved == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        match fs::hard_link(from, to) {
            Ok(()) => {
                if let Err(error) = fs::remove_file(from) {
                    // Undo the second name, so the note is not listed twice.
                    let _ = fs::remove_file(to);
                    return Err(error);
                }
                Ok(())
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                if only_case_differs(from, to) && same_file(from, to)? {
                    fs::rename(from, to)
                } else {
                    Err(error)
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::Unsupported | io::ErrorKind::PermissionDenied
                ) =>
            {
                // No hard links here. A real lack of rights fails the rename the same way.
                if fs::symlink_metadata(to).is_ok() {
                    return Err(io::ErrorKind::AlreadyExists.into());
                }
                fs::rename(from, to)
            }
            Err(error) => Err(error),
        }
    }
}

/// `path` as a NUL-terminated verbatim path (`\\?\C:\...`, `\\?\UNC\server\share\...`), which
/// `MoveFileExW` takes beyond 260 characters whatever the process's long path setting. Made
/// absolute first (`GetFullPathNameW`, which also resolves `.`, `..` and `/`), since a verbatim
/// path is used exactly as written.
#[cfg(windows)]
fn wide_verbatim(path: &Path) -> io::Result<Vec<u16>> {
    use std::os::windows::ffi::OsStrExt;
    let full = std::path::absolute(path)?;
    let wide: Vec<u16> = full.as_os_str().encode_wide().collect();
    if wide.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path with a NUL character",
        ));
    }
    let utf16 = |text: &str| text.encode_utf16().collect::<Vec<u16>>();
    let (prefix, rest) = if wide.starts_with(&utf16(r"\\?\")) || wide.starts_with(&utf16(r"\\.\")) {
        (Vec::new(), &wide[..])
    } else if wide.starts_with(&utf16(r"\\")) {
        (utf16(r"\\?\UNC\"), &wide[2..])
    } else {
        (utf16(r"\\?\"), &wide[..])
    };
    let mut out = Vec::with_capacity(prefix.len() + rest.len() + 1);
    out.extend_from_slice(&prefix);
    out.extend_from_slice(rest);
    out.push(0);
    Ok(out)
}

/// Same folder, and the names differ in case only.
#[cfg(not(windows))]
fn only_case_differs(from: &Path, to: &Path) -> bool {
    let name = |path: &Path| path.file_name().map(|n| n.to_string_lossy().to_lowercase());
    from.parent() == to.parent() && from != to && name(from).is_some() && name(from) == name(to)
}

/// Whether both names lead to the same file, without following a link.
#[cfg(not(windows))]
fn same_file(a: &Path, b: &Path) -> io::Result<bool> {
    use std::os::unix::fs::MetadataExt;
    let (a, b) = (fs::symlink_metadata(a)?, fs::symlink_metadata(b)?);
    Ok(a.dev() == b.dev() && a.ino() == b.ino())
}

/// Moves a corrupt file aside under `<name>.broken-<millis>` (a counter keeps two in one
/// millisecond apart), so nothing the user could still rescue is overwritten.
pub fn set_aside(path: &Path) {
    let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
        return;
    };
    let stamp = now_ms();
    for attempt in 0..100u32 {
        let suffix = if attempt == 0 {
            String::new()
        } else {
            format!("-{attempt}")
        };
        let target = path.with_file_name(format!("{name}.broken-{stamp}{suffix}"));
        match rename_no_replace(path, &target) {
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => eprintln!(
                "hangar-note: corrupt file not set aside: {}",
                storage_log_io(path, &error)
            ),
            Ok(()) => {}
        }
        return;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn io_errors_become_fixed_codes() {
        let os = io::Error::from_raw_os_error;
        #[cfg(windows)]
        for (code, expected) in [
            (5, StorageCode::Denied),
            (19, StorageCode::Denied),
            (32, StorageCode::Denied),
            (33, StorageCode::Denied),
            (112, StorageCode::DiskFull),
            (39, StorageCode::DiskFull),
            (2, StorageCode::NotFound),
            (3, StorageCode::NotFound),
            // ERROR_INVALID_FUNCTION, ERROR_CRC (a failing disk): just "io".
            (1, StorageCode::Io),
            (23, StorageCode::Io),
        ] {
            assert_eq!(StorageCode::of(&os(code)), expected, "{code}");
        }
        #[cfg(unix)]
        for (code, expected) in [
            (13, StorageCode::Denied),
            (1, StorageCode::Denied),
            (30, StorageCode::Denied),
            (28, StorageCode::DiskFull),
            (27, StorageCode::TooLarge),
            (2, StorageCode::NotFound),
            // EIO.
            (5, StorageCode::Io),
        ] {
            assert_eq!(StorageCode::of(&os(code)), expected, "{code}");
        }
        // Errors without an OS number go by their kind.
        for (kind, expected) in [
            (io::ErrorKind::PermissionDenied, StorageCode::Denied),
            (io::ErrorKind::ReadOnlyFilesystem, StorageCode::Denied),
            (io::ErrorKind::StorageFull, StorageCode::DiskFull),
            (io::ErrorKind::QuotaExceeded, StorageCode::DiskFull),
            (io::ErrorKind::FileTooLarge, StorageCode::TooLarge),
            (io::ErrorKind::NotFound, StorageCode::NotFound),
            (io::ErrorKind::InvalidData, StorageCode::Io),
            (io::ErrorKind::Other, StorageCode::Io),
        ] {
            assert_eq!(StorageCode::of(&kind.into()), expected, "{kind:?}");
        }
        let codes: Vec<&str> = StorageCode::ALL.iter().map(|c| c.as_str()).collect();
        assert_eq!(
            codes,
            ["denied", "disk-full", "too-large", "not-found", "io"]
        );
    }

    /// Security review B3: a log line names the scope key, the kind of file and the cause, never a
    /// file name or a path below the notes root.
    #[test]
    fn log_lines_name_no_file_below_the_root() {
        let root = Path::new(if cfg!(windows) {
            r"C:\Users\someone\AppData\Local\com.feoren.hangar\notes"
        } else {
            "/home/someone/.local/share/com.feoren.hangar/notes"
        });
        let key = "6e6ef9e1f001ea8d5164e716aaf511bf";
        let marker = "marker-titel-71b";
        let denied = io::Error::from_raw_os_error(if cfg!(windows) { 5 } else { 13 });
        let os = if cfg!(windows) {
            "os error 5"
        } else {
            "os error 13"
        };
        for (path, expected) in [
            (
                root.join(key).join(format!("{marker}.md")),
                format!("note in area {key} ({os})"),
            ),
            (
                root.join(key).join(format!(".{marker}.md.4711.3.tmp")),
                format!("note in area {key} ({os})"),
            ),
            (
                root.join("general")
                    .join(".trash")
                    .join(format!("17-{marker}.md")),
                format!("note in area general ({os})"),
            ),
            (
                root.join(key).join(".trash").join("trash.json"),
                format!("trash.json in area {key} ({os})"),
            ),
            (
                root.join(key).join("folder.json"),
                format!("folder.json in area {key} ({os})"),
            ),
            (
                root.join(key).join("folder.json.broken-17"),
                format!("folder.json in area {key} ({os})"),
            ),
            (root.join(key), format!("folder in area {key} ({os})")),
            (
                root.join(key).join(".trash"),
                format!("folder in area {key} ({os})"),
            ),
            (
                root.join(".hangar-note-meta.json"),
                format!("meta.json in area - ({os})"),
            ),
            (
                root.join("..").join("settings.json"),
                format!("settings.json in area - ({os})"),
            ),
            (
                root.join(key).join(format!("{marker}.txt")),
                format!("file in area {key} ({os})"),
            ),
        ] {
            let line = storage_log_io(&path, &denied);
            assert_eq!(line, expected, "{}", path.display());
            assert!(!line.contains(marker), "{line}");
            assert!(!line.contains("someone"), "{line}");
        }
        // Without an OS number, the portable kind; never the error's own text.
        let custom = io::Error::new(io::ErrorKind::InvalidInput, format!("{marker} broke"));
        let line = storage_log_io(&root.join(key).join(format!("{marker}.md")), &custom);
        assert_eq!(line, format!("note in area {key} (InvalidInput)"));
        assert!(LOG_FILE_KINDS.iter().all(|kind| !kind.contains('/')));
    }

    /// A real refusal from the file system, not a made-up error number.
    #[test]
    fn a_read_only_target_is_denied() {
        let dir = TempDir::new("fsio-denied");
        let path = dir.path().join("locked.md");
        fs::write(&path, "keep").unwrap();
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions.clone()).unwrap();
        let opened = OpenOptions::new().write(true).open(&path);
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(false);
        fs::set_permissions(&path, permissions).unwrap();
        let missing = File::open(dir.path().join("gone.md")).unwrap_err();
        assert_eq!(StorageCode::of(&missing), StorageCode::NotFound);
        // Root on Unix may write anyway; there the open succeeds and there is nothing to check.
        match opened {
            Err(error) => assert_eq!(StorageCode::of(&error), StorageCode::Denied, "{error}"),
            #[cfg(windows)]
            Ok(_) => panic!("a read-only file was opened for writing"),
            #[cfg(not(windows))]
            Ok(_) => {}
        }
    }

    #[test]
    fn writes_are_atomic_and_leave_no_temporary_files() {
        let dir = TempDir::new("fsio-atomic");
        let path = dir.path().join("a b.json");
        write_atomic(&path, b"first").unwrap();
        write_atomic(&path, b"second").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");
        assert_eq!(names(dir.path()), ["a b.json"]);
    }

    #[test]
    fn a_failed_atomic_write_keeps_the_target_and_cleans_up() {
        let dir = TempDir::new("fsio-atomic-fail");
        // A folder where the file should go: the rename fails on every platform.
        let target = dir.path().join("blocked.md");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("inside.txt"), "keep").unwrap();
        assert!(write_atomic(&target, b"new").is_err());
        assert_eq!(
            fs::read_to_string(target.join("inside.txt")).unwrap(),
            "keep"
        );
        assert_eq!(names(dir.path()), ["blocked.md"]);
    }

    #[test]
    fn capped_and_prefix_reads_stop_at_the_limit() {
        let dir = TempDir::new("fsio-capped");
        let path = dir.path().join("x.md");
        fs::write(&path, "abcdef").unwrap();
        assert_eq!(read_capped(&path, 6).unwrap().unwrap(), b"abcdef");
        assert_eq!(read_capped(&path, 5).unwrap(), None);
        assert_eq!(read_prefix(&path, 3).unwrap(), b"abc");
        assert!(read_capped(dir.path(), 10).is_err());
        // "ä" is two bytes: a cut in its middle drops it rather than garbling it.
        assert_eq!(utf8_prefix("aä".as_bytes(), 2), "a");
    }

    #[test]
    fn corrupt_files_are_set_aside_not_overwritten() {
        let dir = TempDir::new("fsio-aside");
        let path = dir.path().join("meta.json");
        fs::write(&path, "{ broken").unwrap();
        set_aside(&path);
        let all = names(dir.path());
        assert_eq!(all.len(), 1);
        assert!(all[0].starts_with("meta.json.broken-"), "{all:?}");
    }

    /// A rename never replaces a file that is already there (security review L3): the target
    /// may appear between the check for a free name and the rename.
    #[test]
    fn a_rename_never_replaces_an_existing_file() {
        let dir = TempDir::new("fsio-noreplace");
        let from = dir.path().join("moving note.md");
        let to = dir.path().join("taken.md");
        fs::write(&from, "marker-moving-1c4").unwrap();
        fs::write(&to, "marker-taken-6b0").unwrap();
        let error = rename_no_replace(&from, &to).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(&from).unwrap(), "marker-moving-1c4");
        assert_eq!(fs::read_to_string(&to).unwrap(), "marker-taken-6b0");
        // A free name works, and the source is gone afterwards.
        let free = dir.path().join("free ä.md");
        rename_no_replace(&from, &free).unwrap();
        assert!(!from.exists());
        assert_eq!(fs::read_to_string(&free).unwrap(), "marker-moving-1c4");
        assert_eq!(names(dir.path()), ["free ä.md", "taken.md"]);
        // A missing source is an error of its own, not a replaced target.
        let error = rename_no_replace(&dir.path().join("gone.md"), &to).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
        assert_eq!(fs::read_to_string(&to).unwrap(), "marker-taken-6b0");
    }

    /// Changing only the case of a name renames the file itself, also where the file system
    /// compares names without case (Windows, macOS) and the target therefore "exists".
    #[test]
    fn a_rename_may_change_only_the_case() {
        let dir = TempDir::new("fsio-case");
        let from = dir.path().join("idea.md");
        fs::write(&from, "marker-case-0d9").unwrap();
        rename_no_replace(&from, &dir.path().join("IDEA.md")).unwrap();
        assert_eq!(names(dir.path()), ["IDEA.md"]);
        assert_eq!(
            fs::read_to_string(dir.path().join("IDEA.md")).unwrap(),
            "marker-case-0d9"
        );
    }

    /// Paths beyond Windows' 260 characters, which a deep profile folder and the trash's
    /// time-stamped names can reach.
    #[test]
    fn a_rename_works_on_long_paths() {
        let dir = TempDir::new("fsio-long");
        let deep = dir.path().join("d".repeat(120)).join("e".repeat(120));
        fs::create_dir_all(&deep).unwrap();
        let from = deep.join(format!("{}.md", "f".repeat(60)));
        let to = deep.join(format!("{}.md", "g".repeat(60)));
        assert!(to.as_os_str().len() > 260);
        fs::write(&from, "marker-long-5e2").unwrap();
        rename_no_replace(&from, &to).unwrap();
        assert_eq!(fs::read_to_string(&to).unwrap(), "marker-long-5e2");
        fs::write(&from, "x").unwrap();
        let error = rename_no_replace(&from, &to).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
    }
}
