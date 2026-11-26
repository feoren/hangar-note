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
