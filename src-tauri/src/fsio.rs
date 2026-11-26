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
        if target.exists() {
            continue;
        }
        if let Err(error) = fs::rename(path, &target) {
            eprintln!("hangar-note: corrupt {name} not set aside: {error}");
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
}
