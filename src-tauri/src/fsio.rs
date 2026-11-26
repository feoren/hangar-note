//! File helpers every store uses: atomic writes, private folders and files, capped reads.
//! Written the same way as Hangar's `persist.rs` (MIT, same owner), so files Hangar and Hangar
//! Note write look and behave alike: a temporary file `.<name>.<pid>.<n>.tmp` in the same folder,
//! `sync_all`, then a rename over the target. On Windows the rename is tried again for at most
//! [`RENAME_RETRY_BUDGET`] while another program holds the target open (ADR 0005, amendment 2).

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read as _, Write as _};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const TEMP_EXT: &str = "tmp";

/// How long an atomic write keeps trying the rename over a target another program holds open
/// (contract "notes-shared 1", amendment 2). Hangar reads and writes the same files; on Windows a
/// rename over a file that is open without `FILE_SHARE_DELETE` fails until that handle closes,
/// which for a reader of a small note is a few milliseconds.
pub const RENAME_RETRY_BUDGET: Duration = Duration::from_secs(1);
/// The pause between two tries of that rename.
const RENAME_RETRY_STEP: Duration = Duration::from_millis(15);

/// Whether `name` is a temporary or hidden file of the notes folder rather than a note: every
/// dotfile (the temporary files of an atomic write, `.<name>.<pid>.<n>.tmp`, of either app, the
/// scope lock `.lock`, the trash folder) and every `*.tmp`. Listers and the watcher skip these,
/// so another app's write in progress never shows up as a note.
pub fn is_hidden_or_temp(name: &str) -> bool {
    name.starts_with('.')
        || Path::new(name)
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case(TEMP_EXT))
}

/// Whether `meta` (from `symlink_metadata`, which does not follow) is a link of any kind: a
/// symbolic link, a junction, or on Windows any reparse point at all. Hangar creates none in its
/// local data folder, so a reparse point there is never followed. Non-link reparse points (cloud
/// placeholders, deduplicated files) are refused as well, on purpose: telling them apart needs
/// the reparse tag, which the standard library does not expose.
pub fn is_link_meta(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt as _;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// A plain file at `path`, without following a link: not a folder, not a link, not a reparse
/// point.
pub fn is_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_file() && !is_link_meta(&meta))
}

/// A plain folder at `path`, without following a link or junction.
pub fn is_regular_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir() && !is_link_meta(&meta))
}

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
        ".lock" => "scope lock",
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
    write_atomic_with(path, data, create_private_file).map(drop)
}

/// Like [`write_atomic`], and returns the metadata of the written file, taken from the temporary
/// file's own handle after `sync_all` and before the rename. A rename keeps modification time and
/// length, so this is the version of what this call wrote, even when another program replaces the
/// target right after the rename (a look at the path afterwards could see that file instead).
pub fn write_atomic_versioned(path: &Path, data: &[u8]) -> io::Result<fs::Metadata> {
    write_atomic_with(path, data, create_private_file)
}

/// Like [`write_atomic`] for a file only its owner may open on every platform: 0600 on Unix, an
/// explicit protected DACL for the user and SYSTEM on Windows (`winsec.rs`), which a profile
/// folder's inherited ACL never widens. For files that hold a secret (`endpoint.json`).
pub fn write_atomic_owner_only(path: &Path, data: &[u8]) -> io::Result<()> {
    #[cfg(windows)]
    {
        write_atomic_with(path, data, crate::winsec::create_owner_only).map(drop)
    }
    #[cfg(not(windows))]
    {
        write_atomic_with(path, data, create_private_file).map(drop)
    }
}

fn write_atomic_with(
    path: &Path,
    data: &[u8],
    create: fn(&Path) -> io::Result<File>,
) -> io::Result<fs::Metadata> {
    write_atomic_within(path, data, create, RENAME_RETRY_BUDGET)
}

/// [`write_atomic_with`] with the rename's retry budget as a parameter, so a test of the timeout
/// is quick.
fn write_atomic_within(
    path: &Path,
    data: &[u8],
    create: fn(&Path) -> io::Result<File>,
    budget: Duration,
) -> io::Result<fs::Metadata> {
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
        let written = file.metadata()?;
        drop(file);
        rename_over(&temp, path, budget)?;
        Ok(written)
    })();
    if result.is_err() {
        // Never an in-place write instead: the target keeps its old content, the temporary file
        // goes.
        let _ = fs::remove_file(&temp);
    }
    result
}

/// `fs::rename(from, to)`, tried again every [`RENAME_RETRY_STEP`] for at most `budget` while the
/// error says another program holds a file open ([`is_held_open`]). Any other error, or the last
/// one after the budget, is returned as is.
fn rename_over(from: &Path, to: &Path, budget: Duration) -> io::Result<()> {
    let deadline = Instant::now() + budget;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) if is_held_open(&error) && Instant::now() < deadline => {
                std::thread::sleep(RENAME_RETRY_STEP);
            }
            Err(error) => return Err(error),
        }
    }
}

/// Whether a failed rename means only that another program holds the target (or the temporary
/// file) open: on Windows `ERROR_ACCESS_DENIED` (what a replace over a file open without
/// `FILE_SHARE_DELETE` gives), `ERROR_SHARING_VIOLATION` and `ERROR_LOCK_VIOLATION`. A real lack of
/// rights gives `ERROR_ACCESS_DENIED` too and costs one budget of waiting before the error.
/// Elsewhere a rename replaces an open file, so nothing is retried.
fn is_held_open(error: &io::Error) -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{
            ERROR_ACCESS_DENIED, ERROR_LOCK_VIOLATION, ERROR_SHARING_VIOLATION,
        };
        error
            .raw_os_error()
            .and_then(|code| u32::try_from(code).ok())
            .is_some_and(|code| {
                matches!(
                    code,
                    ERROR_ACCESS_DENIED | ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION
                )
            })
    }
    #[cfg(not(windows))]
    {
        let _ = error;
        false
    }
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

fn not_regular() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "not a regular file")
}

/// Opens `path` for reading only if it is a regular file: a link, junction, reparse point,
/// folder, FIFO or device named like a note is refused, since it could lead outside the folder or
/// never end. The check is made on the opened handle, so a link swapped in between a look and the
/// open is refused too.
///
/// - Windows: opened with `FILE_FLAG_OPEN_REPARSE_POINT`, which opens a reparse point itself
///   instead of its target; the handle's attributes then show it and it is refused.
/// - Unix: a look without following (`lstat`), the open, then the handle's device and inode must
///   be the ones of that look.
pub fn open_regular(path: &Path) -> io::Result<File> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        let meta = file.metadata()?;
        if !meta.is_file() || is_link_meta(&meta) {
            return Err(not_regular());
        }
        Ok(file)
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::MetadataExt as _;
        let seen = fs::symlink_metadata(path)?;
        if !seen.file_type().is_file() {
            return Err(not_regular());
        }
        let file = File::open(path)?;
        let opened = file.metadata()?;
        if !opened.is_file() || opened.dev() != seen.dev() || opened.ino() != seen.ino() {
            return Err(not_regular());
        }
        Ok(file)
    }
}

/// What a lock file's handle says about the file: its identity, its number of names and whether
/// it is a plain file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LockFileInfo {
    /// Windows: volume serial number and file index; Unix: device and inode.
    id: (u64, u64),
    links: u64,
    regular: bool,
}

#[cfg(windows)]
fn lock_file_info(file: &File) -> io::Result<LockFileInfo> {
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY,
        FILE_ATTRIBUTE_REPARSE_POINT,
    };
    // SAFETY: BY_HANDLE_FILE_INFORMATION is a plain C struct of integers, for which all zero bytes
    // are a valid value.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: the handle is open for the lifetime of `file`, and `info` is a valid, writable
    // BY_HANDLE_FILE_INFORMATION the call fills in.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let index = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
    Ok(LockFileInfo {
        id: (u64::from(info.dwVolumeSerialNumber), index),
        links: u64::from(info.nNumberOfLinks),
        regular: info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)
            == 0,
    })
}

#[cfg(not(windows))]
fn lock_file_info(file: &File) -> io::Result<LockFileInfo> {
    use std::os::unix::fs::MetadataExt as _;
    let meta = file.metadata()?;
    Ok(LockFileInfo {
        id: (meta.dev(), meta.ino()),
        links: meta.nlink(),
        regular: meta.file_type().is_file(),
    })
}

/// The refusal of a lock file with a second name: a hard link to a file elsewhere would let a
/// foreign file stand in for the lock (security review of "notes-shared 1", L2).
fn lock_with_more_names() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "the lock file has more than one name",
    )
}

/// Checks what [`open_lock_file`] opened: a plain file with exactly one name. A count of 0 (the
/// file was deleted after the open) passes here and fails [`lock_file_matches`] later.
fn checked_lock_info(file: &File) -> io::Result<LockFileInfo> {
    let info = lock_file_info(file)?;
    if !info.regular {
        return Err(not_regular());
    }
    if info.links > 1 {
        return Err(lock_with_more_names());
    }
    Ok(info)
}

/// Opens a lock file (`notes/<scope>/.lock`) for reading and writing, creating it if missing,
/// without ever following a link, also not while creating it:
///
/// - Windows: `FILE_FLAG_OPEN_REPARSE_POINT`, so a link or junction is opened itself (and then
///   refused) instead of its target; shared for reading and writing only, without
///   `FILE_SHARE_DELETE`, so nobody can delete or rename the file while the handle is open
///   (security review L1).
/// - Unix: `O_NOFOLLOW` (a link at the path fails with `ELOOP`, a dangling one is never created
///   through) and `O_NONBLOCK` (a FIFO named `.lock` cannot hang the open), mode 0600.
///
/// The handle must show a regular file with one name ([`checked_lock_info`]); anything else is
/// refused with an error (storage code `io`).
pub fn open_lock_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        options
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        // A link or folder in the way fails the open (`ELOOP`, or access denied for a junction):
        // that is a lock failure, not a lack of rights.
        Err(_) if fs::symlink_metadata(path).is_ok_and(|meta| !meta.file_type().is_file()) => {
            return Err(not_regular());
        }
        Err(error) => return Err(error),
    };
    checked_lock_info(&file)?;
    Ok(file)
}

/// Whether `path` still names the file `file` holds open, looked at without following a link:
/// after a lock is taken, the file may have been deleted or renamed and a new one created under
/// the name, and then a lock on the old handle keeps nobody out (security review L1). `Ok(false)`
/// when the path is gone, a link or another file; an error when the file there has a second name
/// (L2) or cannot be looked at.
///
/// - Windows: the path is opened again (attributes only, with `FILE_FLAG_OPEN_REPARSE_POINT`, all
///   sharing allowed so the held handle is not disturbed) and volume serial number and file index
///   of both handles are compared.
/// - Unix: `lstat` of the path, compared by device and inode.
pub fn lock_file_matches(file: &File, path: &Path) -> io::Result<bool> {
    let held = checked_lock_info(file)?;
    #[cfg(windows)]
    let now = {
        use std::os::windows::fs::OpenOptionsExt as _;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
            FILE_SHARE_WRITE,
        };
        let opened = OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path);
        match opened {
            Ok(again) => lock_file_info(&again)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error),
        }
    };
    #[cfg(not(windows))]
    let now = {
        use std::os::unix::fs::MetadataExt as _;
        match fs::symlink_metadata(path) {
            Ok(meta) => LockFileInfo {
                id: (meta.dev(), meta.ino()),
                links: meta.nlink(),
                regular: meta.file_type().is_file(),
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error),
        }
    };
    if !now.regular || now.id != held.id {
        return Ok(false);
    }
    if now.links > 1 {
        return Err(lock_with_more_names());
    }
    Ok(true)
}

/// Whether `name` is exactly the temporary file of an atomic write, `.<name>.<pid>.<n>.tmp` with
/// a non-empty name and decimal `<pid>` and `<n>` (contract "notes-shared 1", amendment 2), the
/// only kind of file a sweep of stale temporary files may remove.
pub fn is_atomic_temp_name(name: &str) -> bool {
    let Some(inner) = name
        .strip_prefix('.')
        .and_then(|rest| rest.strip_suffix(&format!(".{TEMP_EXT}")))
    else {
        return false;
    };
    let mut parts = inner.rsplitn(3, '.');
    let digits = |part: Option<&str>| {
        part.is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
    };
    digits(parts.next()) && digits(parts.next()) && parts.next().is_some_and(|n| !n.is_empty())
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
    if let Err(error) = try_set_aside(path) {
        eprintln!(
            "hangar-note: corrupt file not set aside: {}",
            storage_log_io(path, &error)
        );
    }
}

/// [`set_aside`] that reports whether it worked and returns the new path. The move never replaces
/// a file ([`rename_no_replace`]): a `.broken-` copy another program made in the same millisecond
/// stays, this one takes the next suffix.
pub fn try_set_aside(path: &Path) -> io::Result<std::path::PathBuf> {
    let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path without file name",
        ));
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
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
            Ok(()) => return Ok(target),
        }
    }
    Err(io::ErrorKind::AlreadyExists.into())
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

    /// Opens `path` the way a reader that does not allow deletes holds it: without
    /// `FILE_SHARE_DELETE`, so a rename over it fails until the handle closes.
    #[cfg(windows)]
    fn hold_open(path: &Path) -> File {
        use std::os::windows::fs::OpenOptionsExt as _;
        use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
        OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(path)
            .unwrap()
    }

    /// Amendment 2: a target another program holds open for a moment is replaced once it lets go,
    /// within the retry budget; nothing is written in place meanwhile.
    #[cfg(windows)]
    #[test]
    fn a_rename_waits_for_a_target_held_open_for_a_moment() {
        let dir = TempDir::new("fsio-held-short");
        let path = dir.path().join("held.md");
        fs::write(&path, "marker-old-4a1").unwrap();
        let held = hold_open(&path);
        // Without the retry the very first rename fails: proof that the handle blocks it.
        let blocked = fs::write(dir.path().join("probe.md"), "x")
            .and_then(|()| fs::rename(dir.path().join("probe.md"), &path))
            .unwrap_err();
        assert!(is_held_open(&blocked), "{blocked:?}");
        let _ = fs::remove_file(dir.path().join("probe.md"));
        let (go, gone) = std::sync::mpsc::channel();
        let holder = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            drop(held);
            go.send(()).unwrap();
        });
        let started = Instant::now();
        write_atomic(&path, b"marker-new-4a1").unwrap();
        assert!(started.elapsed() >= Duration::from_millis(150));
        assert!(started.elapsed() < RENAME_RETRY_BUDGET);
        gone.recv().unwrap();
        holder.join().unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"marker-new-4a1");
        assert_eq!(names(dir.path()), ["held.md"]);
    }

    /// Amendment 2: a target held open past the budget ends in an error; the target keeps its
    /// content and the temporary file is gone.
    #[cfg(windows)]
    #[test]
    fn a_target_held_open_too_long_fails_and_leaves_no_temporary_file() {
        let dir = TempDir::new("fsio-held-long");
        let path = dir.path().join("held.md");
        fs::write(&path, "marker-old-9c3").unwrap();
        let held = hold_open(&path);
        let budget = Duration::from_millis(120);
        let started = Instant::now();
        let error =
            write_atomic_within(&path, b"marker-new-9c3", create_private_file, budget).unwrap_err();
        assert!(started.elapsed() >= budget);
        assert!(is_held_open(&error), "{error:?}");
        assert_eq!(StorageCode::of(&error), StorageCode::Denied);
        drop(held);
        assert_eq!(fs::read(&path).unwrap(), b"marker-old-9c3");
        assert_eq!(names(dir.path()), ["held.md"]);
    }

    #[test]
    fn hidden_and_temporary_names_are_no_notes() {
        for name in [
            ".lock",
            ".trash",
            ".Plan.md.4711.3.tmp",
            ".x.md",
            "Plan.md.tmp",
            "x.TMP",
        ] {
            assert!(is_hidden_or_temp(name), "{name}");
        }
        for name in ["Plan.md", "a.tmp.md", "folder.json"] {
            assert!(!is_hidden_or_temp(name), "{name}");
        }
        // The name an atomic write gives its temporary file is one of them.
        let dir = TempDir::new("fsio-temp-name");
        let path = dir.path().join("Plan.md");
        thread_local! {
            static SEEN: std::cell::RefCell<String> = const { std::cell::RefCell::new(String::new()) };
        }
        fn spy(path: &Path) -> io::Result<File> {
            SEEN.with(|seen| {
                *seen.borrow_mut() = path.file_name().unwrap().to_string_lossy().into_owned();
            });
            create_private_file(path)
        }
        write_atomic_with(&path, b"x", spy).unwrap();
        let temp_name = SEEN.with(|seen| seen.borrow().clone());
        let pid = std::process::id().to_string();
        let parts: Vec<&str> = temp_name.split('.').collect();
        assert_eq!(parts[..4], ["", "Plan", "md", pid.as_str()], "{temp_name}");
        assert!(parts[4].bytes().all(|b| b.is_ascii_digit()), "{temp_name}");
        assert_eq!(parts[5], "tmp");
        assert!(is_hidden_or_temp(&temp_name));
    }

    /// A link to a file elsewhere is never read through, and a folder junction counts as no
    /// folder. File symlinks need rights on Windows; without them that half is skipped.
    #[test]
    fn links_are_not_regular_files_or_folders() {
        let dir = TempDir::new("fsio-links");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("x.md"), "marker-outside-5d0").unwrap();
        let inside = dir.path().join("inside");
        fs::create_dir_all(&inside).unwrap();
        assert!(is_regular_dir(&inside));
        assert!(is_regular_file(&outside.join("x.md")));
        if crate::test_support::make_dir_link(&outside, &inside.join("linked")) {
            assert!(!is_regular_dir(&inside.join("linked")));
            assert!(open_regular(&inside.join("linked").join("x.md")).is_ok());
        }
        #[cfg(windows)]
        let file_link =
            std::os::windows::fs::symlink_file(outside.join("x.md"), inside.join("l.md"));
        #[cfg(unix)]
        let file_link = std::os::unix::fs::symlink(outside.join("x.md"), inside.join("l.md"));
        match file_link {
            Ok(()) => {
                assert!(!is_regular_file(&inside.join("l.md")));
                assert!(open_regular(&inside.join("l.md")).is_err());
                assert!(read_capped(&inside.join("l.md"), 100).is_err());
            }
            Err(error) => eprintln!("no file symlinks here ({error}); skipped"),
        }
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

    /// Three set-asides in a row, mostly within one millisecond: each copy keeps its own bytes,
    /// none replaces another (`rename_no_replace` plus the counter suffix).
    #[test]
    fn a_set_aside_never_replaces_an_earlier_copy() {
        let dir = TempDir::new("fsio-aside-many");
        let path = dir.path().join("folder.json");
        let mut targets = Vec::new();
        for round in 0..3 {
            fs::write(&path, format!("marker-junk-{round}")).unwrap();
            targets.push(try_set_aside(&path).unwrap());
        }
        assert!(!path.exists());
        let mut kept: Vec<String> = targets
            .iter()
            .map(|target| fs::read_to_string(target).unwrap())
            .collect();
        kept.sort();
        assert_eq!(kept, ["marker-junk-0", "marker-junk-1", "marker-junk-2"]);
        assert!(names(dir.path())
            .iter()
            .all(|n| n.starts_with("folder.json.broken-")));
    }

    #[test]
    fn only_exact_atomic_temp_names_match() {
        for name in [
            ".Plan.md.4711.3.tmp",
            ".folder.json.1.0.tmp",
            ".a.b.c.md.12.345.tmp",
        ] {
            assert!(is_atomic_temp_name(name), "{name}");
        }
        for name in [
            "Plan.md.4711.3.tmp",
            ".Plan.md.4711.tmp",
            ".Plan.md.x.3.tmp",
            ".Plan.md.4711.3x.tmp",
            "..4711.3.tmp",
            ".Plan.md.4711.3.TMP.bak",
            ".Plan.md.-1.3.tmp",
            ".lock",
            "Old.tmp",
        ] {
            assert!(!is_atomic_temp_name(name), "{name}");
        }
    }

    /// The lock file is created as a plain file, a folder in its place is refused (storage code
    /// `io`), and the identity check tells the held file from another one and from a gone one.
    #[test]
    fn lock_files_are_plain_and_checked_by_identity() {
        let dir = TempDir::new("fsio-lockfile");
        let path = dir.path().join(".lock");
        let held = open_lock_file(&path).unwrap();
        assert!(is_regular_file(&path));
        assert!(lock_file_matches(&held, &path).unwrap());
        let other = dir.path().join(".other");
        let _other_file = open_lock_file(&other).unwrap();
        assert!(!lock_file_matches(&held, &other).unwrap());
        assert!(!lock_file_matches(&held, &dir.path().join(".missing")).unwrap());
        // A second name on the held file is refused by the check as well.
        fs::hard_link(&path, dir.path().join("second")).unwrap();
        assert_eq!(
            lock_file_matches(&held, &path).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        let folder = dir.path().join(".dirlock");
        fs::create_dir_all(&folder).unwrap();
        let refused = open_lock_file(&folder).unwrap_err();
        assert_eq!(StorageCode::of(&refused), StorageCode::Io, "{refused}");
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
