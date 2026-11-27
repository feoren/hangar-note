//! Whether this Hangar Note may write Hangar's private notes (ADR 0005, contract "notes-shared 1").
//!
//! - **Root.** Hangar's notes folder `<local data>/com.feoren.hangar/notes`, or in debug builds the
//!   folder named by [`ROOT_ENV`] (the development root).
//! - **Shared with Hangar.** Hangar and Hangar Note both write the folder at the same time; there
//!   is no handover. Every read-modify-write of a scope's index files holds the scope lock
//!   (`notes.rs`, `<scope>/.lock`); every note write holds it too and carries the version (the
//!   content hash) the editor read.
//! - **Writer lock.** `notes/.writer.lock`, held open with an exclusive OS file lock
//!   (`File::try_lock`, `LockFileEx` on Windows, `flock` on Unix) for as long as the app runs. It
//!   keeps a second Hangar Note (another user session, a second copy) from writing alongside the
//!   first; Hangar does not take it. The lock goes with the process, also on a crash, so a stale
//!   lock file never blocks anyone. The standard library has it since Rust 1.89, so no crate is
//!   needed (fs2 and fs4 do the same).

use std::ffi::OsString;
use std::fs::File;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;

use crate::fsio::{create_private_dir, lock, lock_file_matches, open_lock_file};
use crate::notes::normalize_path;

/// The environment variable of the development root; read only in debug builds.
pub const ROOT_ENV: &str = "HANGAR_NOTE_NOTES_ROOT";
/// Hangar's identifier: its notes live in its local data folder (in-place storage, ADR 0002).
pub const HANGAR_IDENTIFIER: &str = "com.feoren.hangar";
pub const NOTES_DIR: &str = "notes";
pub const WRITER_LOCK_FILE: &str = ".writer.lock";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RootKind {
    /// Hangar's own notes folder.
    Hangar,
    /// `HANGAR_NOTE_NOTES_ROOT` in a debug build.
    Development,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotesRoot {
    pub path: PathBuf,
    pub kind: RootKind,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RootError {
    #[error("{ROOT_ENV} must be an absolute path")]
    RelativeRoot,
    #[error("{ROOT_ENV} must be a folder on this computer, not a network or device path")]
    NetworkRoot,
    #[error("The local data folder of this user is unknown")]
    NoDataFolder,
}

/// The notes root. `env` is the value of [`ROOT_ENV`], honored only when `debug` is true, so a
/// release build always uses Hangar's folder. `data_local` is the user's local data folder.
///
/// A development root that is Hangar's own folder or lies inside it (spelled differently, through
/// `..`, or through a link or junction) is not one: a debug build would then write the person's
/// real notes while it claims to use a test folder, and keep their colors in the test `meta.json`.
/// It is then treated as if none was given, with a note in the log.
pub fn resolve_root(
    env: Option<OsString>,
    debug: bool,
    data_local: Option<PathBuf>,
) -> Result<NotesRoot, RootError> {
    let hangar = data_local.map(|base| base.join(HANGAR_IDENTIFIER).join(NOTES_DIR));
    if debug {
        if let Some(value) = env.filter(|value| !value.is_empty()) {
            let path = PathBuf::from(value);
            if is_network_or_device(&path) {
                return Err(RootError::NetworkRoot);
            }
            if !path.is_absolute() {
                return Err(RootError::RelativeRoot);
            }
            if hangar
                .as_deref()
                .is_some_and(|real| within_folder(&path, real))
            {
                eprintln!("hangar-note: {ROOT_ENV} names Hangar's own notes folder; ignoring it");
            } else {
                return Ok(NotesRoot {
                    path,
                    kind: RootKind::Development,
                });
            }
        }
    }
    Ok(NotesRoot {
        path: hangar.ok_or(RootError::NoDataFolder)?,
        kind: RootKind::Hangar,
    })
}

/// A path on a share (`\\server\share`, `\\?\UNC\server\share`) or in the device namespace
/// (`\\.\`). Windows only: on a share the writer lock and the atomic rename are only as reliable
/// as the server, and another machine would hold the notes. Unix paths have no such prefix.
fn is_network_or_device(path: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::path::Prefix;
        matches!(
            path.components().next(),
            Some(Component::Prefix(prefix))
                if matches!(
                    prefix.kind(),
                    Prefix::UNC(..) | Prefix::VerbatimUNC(..) | Prefix::DeviceNS(..)
                )
        )
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        false
    }
}

/// The path with `.` and `..` resolved lexically, and its longest existing ancestor resolved
/// through the file system (links, junctions, short names, case on Windows).
fn comparable(path: &Path) -> String {
    let mut lexical = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                lexical.pop();
            }
            other => lexical.push(other),
        }
    }
    let mut rest = Vec::new();
    let mut current = lexical.as_path();
    let resolved = loop {
        if let Ok(resolved) = std::fs::canonicalize(current) {
            break rest
                .iter()
                .rev()
                .fold(resolved, |acc: PathBuf, part| acc.join(part));
        }
        match (current.file_name(), current.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name.to_owned());
                current = parent;
            }
            _ => break lexical.clone(),
        }
    };
    normalize_path(&resolved)
}

/// Whether `path` is `folder` or lies inside it, after normalization (as the scope key compares
/// paths) and after resolving links where the folders exist.
pub fn within_folder(path: &Path, folder: &Path) -> bool {
    let separator = if cfg!(windows) { '\\' } else { '/' };
    let inside = |path: String, folder: String| {
        path == folder
            || path
                .strip_prefix(folder.trim_end_matches(separator))
                .is_some_and(|rest| rest.starts_with(separator))
    };
    inside(normalize_path(path), normalize_path(folder))
        || inside(comparable(path), comparable(folder))
}

/// The held writer lock; dropping it releases the lock.
#[derive(Debug)]
pub struct WriterLock {
    _file: File,
}

#[derive(Debug, thiserror::Error)]
pub enum LockError {
    #[error("Another program writes these notes")]
    Held,
    #[error("The writer lock cannot be taken: {0}")]
    Io(#[from] std::io::Error),
}

/// Takes `root/.writer.lock` exclusively without waiting. Creates the root if needed.
///
/// Opened like the scope lock ([`open_lock_file`], security review N5): never through a link,
/// also not while creating it, only a plain file with one name (a hard link could make a foreign
/// file stand in for the lock), and on Windows not deletable or renamable while held. Once
/// locked, the path must still name the locked file ([`lock_file_matches`]); anything else is a
/// lock failure and leaves the notes read only.
pub fn take_writer_lock(root: &Path) -> Result<WriterLock, LockError> {
    create_private_dir(root)?;
    let path = root.join(WRITER_LOCK_FILE);
    let file = open_lock_file(&path)?;
    match file.try_lock() {
        Ok(()) => {}
        Err(std::fs::TryLockError::WouldBlock) => return Err(LockError::Held),
        Err(std::fs::TryLockError::Error(error)) => return Err(LockError::Io(error)),
    }
    if !lock_file_matches(&file, &path)? {
        return Err(LockError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "the writer lock file was replaced",
        )));
    }
    Ok(WriterLock { _file: file })
}

/// What the window shows about the notes folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state", content = "reason")]
pub enum Access {
    Writable,
    ReadOnly(ReadOnlyReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReadOnlyReason {
    /// Another writer holds the lock (a second Hangar Note of another user session, a tool).
    OtherWriter,
    /// The lock file could not be created or locked (permissions, a full disk).
    LockFailed,
}

/// The access state, shared with the notes store through `writable`.
#[derive(Debug)]
pub struct AccessGate {
    root: NotesRoot,
    writable: Arc<AtomicBool>,
    state: Mutex<(Access, Option<WriterLock>)>,
}

impl AccessGate {
    /// Checks the folder once; call [`AccessGate::refresh`] to look again later.
    pub fn open(root: NotesRoot) -> Self {
        let gate = Self {
            root,
            writable: Arc::new(AtomicBool::new(false)),
            state: Mutex::new((Access::ReadOnly(ReadOnlyReason::LockFailed), None)),
        };
        gate.refresh();
        gate
    }

    pub fn root(&self) -> &NotesRoot {
        &self.root
    }

    /// The flag the notes store reads before every write.
    pub fn writable_flag(&self) -> Arc<AtomicBool> {
        self.writable.clone()
    }

    pub fn current(&self) -> Access {
        lock(&self.state).0
    }

    /// Looks again while read only: the other writer may have ended, or the folder may have
    /// become writable. Once writable, it stays so while the app runs.
    pub fn refresh(&self) -> Access {
        let mut state = lock(&self.state);
        if state.0 == Access::Writable {
            return state.0;
        }
        let next = match take_writer_lock(&self.root.path) {
            Ok(held) => (Access::Writable, Some(held)),
            Err(LockError::Held) => (Access::ReadOnly(ReadOnlyReason::OtherWriter), None),
            Err(LockError::Io(error)) => {
                eprintln!("hangar-note: notes stay read only: {error}");
                (Access::ReadOnly(ReadOnlyReason::LockFailed), None)
            }
        };
        *state = next;
        self.writable
            .store(state.0 == Access::Writable, Ordering::SeqCst);
        state.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use std::fs;

    fn dev(dir: &TempDir) -> NotesRoot {
        NotesRoot {
            path: dir.path().join("notes"),
            kind: RootKind::Development,
        }
    }

    fn hangar(dir: &TempDir) -> NotesRoot {
        NotesRoot {
            path: dir.path().join("notes"),
            kind: RootKind::Hangar,
        }
    }

    #[test]
    fn release_builds_always_use_hangars_folder() {
        let data = PathBuf::from(if cfg!(windows) { r"C:\data" } else { "/data" });
        let env = Some(OsString::from(if cfg!(windows) {
            r"C:\dev"
        } else {
            "/dev"
        }));
        let release = resolve_root(env.clone(), false, Some(data.clone())).unwrap();
        assert_eq!(release.kind, RootKind::Hangar);
        assert_eq!(release.path, data.join("com.feoren.hangar").join("notes"));
        let debug = resolve_root(env, true, Some(data.clone())).unwrap();
        assert_eq!(debug.kind, RootKind::Development);
        assert_eq!(
            resolve_root(Some("relative".into()), true, Some(data.clone())),
            Err(RootError::RelativeRoot)
        );
        assert_eq!(
            resolve_root(Some(OsString::new()), true, Some(data))
                .unwrap()
                .kind,
            RootKind::Hangar
        );
        assert_eq!(resolve_root(None, true, None), Err(RootError::NoDataFolder));
    }

    #[cfg(windows)]
    #[test]
    fn a_network_path_is_no_development_root() {
        let data = Some(PathBuf::from(r"C:\data"));
        for path in [
            r"\\server\share\notes",
            r"\\server\share",
            r"\\?\UNC\server\share\notes",
            r"\\.\pipe\notes",
            "//server/share/notes",
        ] {
            let result = resolve_root(Some(path.into()), true, data.clone());
            assert!(result.is_err(), "{path}: {result:?}");
        }
        assert_eq!(
            resolve_root(Some(r"\\server\share\notes".into()), true, data.clone()),
            Err(RootError::NetworkRoot)
        );
        // A release build ignores the variable altogether.
        assert_eq!(
            resolve_root(Some(r"\\server\share\notes".into()), false, data.clone())
                .unwrap()
                .kind,
            RootKind::Hangar
        );
        // A local drive, also in its verbatim spelling, stays a development root.
        for path in [r"D:\dev notes", r"\\?\D:\dev notes"] {
            let root = resolve_root(Some(path.into()), true, data.clone()).unwrap();
            assert_eq!(root.kind, RootKind::Development, "{path}");
        }
    }

    #[test]
    fn a_development_root_that_is_hangars_folder_is_not_one() {
        let dir = TempDir::new("access-dev-real");
        let data = dir.path().to_path_buf();
        let real = data.join(HANGAR_IDENTIFIER).join(NOTES_DIR);
        fs::create_dir_all(&real).unwrap();
        let mut spellings = vec![
            real.clone(),
            real.join("."),
            real.join("general").join(".."),
            data.join("other")
                .join("..")
                .join(HANGAR_IDENTIFIER)
                .join(NOTES_DIR),
        ];
        if cfg!(windows) {
            spellings.push(PathBuf::from(real.to_string_lossy().to_uppercase()));
            spellings.push(PathBuf::from(real.to_string_lossy().replace('\\', "/")));
        }
        // A junction (Windows) or a symbolic link (Unix) to Hangar's folder.
        let link = data.join("link to notes");
        if crate::test_support::make_dir_link(&real, &link) {
            spellings.push(link.clone());
        }
        for spelling in spellings {
            let root =
                resolve_root(Some(spelling.clone().into()), true, Some(data.clone())).unwrap();
            assert_eq!(root.kind, RootKind::Hangar, "{}", spelling.display());
            assert_eq!(root.path, real);
        }
        // Inside it is refused as well.
        let inside = resolve_root(Some(real.join("general").into()), true, Some(data.clone()));
        assert_eq!(inside.unwrap().kind, RootKind::Hangar);
        // Any other folder stays a development root, also one next to Hangar's.
        for other in [
            data.join(HANGAR_IDENTIFIER).join("notes-dev"),
            data.join(HANGAR_IDENTIFIER),
        ] {
            let root = resolve_root(Some(other.clone().into()), true, Some(data.clone())).unwrap();
            assert_eq!(root.kind, RootKind::Development, "{}", other.display());
        }
    }

    /// Contract "notes-shared 1" (ADR 0005): Hangar's own folder is writable at once, without any
    /// marker from Hangar, and Hangar Note writes no marker either.
    #[test]
    fn hangars_folder_is_writable_without_a_marker() {
        let dir = TempDir::new("access-shared");
        let root = hangar(&dir);
        fs::create_dir_all(&root.path).unwrap();
        let gate = AccessGate::open(root.clone());
        assert_eq!(gate.current(), Access::Writable);
        assert!(gate.writable_flag().load(Ordering::SeqCst));
        assert!(root.path.join(WRITER_LOCK_FILE).is_file());
        assert!(!root.path.join(".handover.json").exists());

        // The folder does not even have to exist yet: it is created with the lock.
        let fresh = TempDir::new("access-shared-fresh");
        let gate = AccessGate::open(hangar(&fresh));
        assert_eq!(gate.current(), Access::Writable);
    }

    #[test]
    fn the_development_root_is_writable() {
        let dir = TempDir::new("access-dev");
        let gate = AccessGate::open(dev(&dir));
        assert_eq!(gate.current(), Access::Writable);
    }

    /// A second Hangar Note on Hangar's own folder is still refused, until the first ends.
    #[test]
    fn a_second_hangar_note_on_hangars_folder_stays_read_only() {
        let dir = TempDir::new("access-shared-second");
        let first = AccessGate::open(hangar(&dir));
        assert_eq!(first.current(), Access::Writable);
        let second = AccessGate::open(hangar(&dir));
        assert_eq!(
            second.current(),
            Access::ReadOnly(ReadOnlyReason::OtherWriter)
        );
        assert!(!second.writable_flag().load(Ordering::SeqCst));
        drop(first);
        assert_eq!(second.refresh(), Access::Writable);
    }

    #[test]
    fn a_second_writer_is_refused_until_the_first_ends() {
        let dir = TempDir::new("access-lock");
        let first = AccessGate::open(dev(&dir));
        assert_eq!(first.current(), Access::Writable);
        let second = AccessGate::open(dev(&dir));
        assert_eq!(
            second.current(),
            Access::ReadOnly(ReadOnlyReason::OtherWriter)
        );
        drop(first);
        assert_eq!(second.refresh(), Access::Writable);
    }

    /// Security review N5: the writer lock is opened like the scope lock (`fsio::open_lock_file`):
    /// a `.writer.lock` with a second name (a hard link to a file elsewhere) or a folder in its
    /// place is a lock failure, and the other file is not touched.
    #[test]
    fn a_writer_lock_that_is_not_a_plain_file_is_refused() {
        let dir = TempDir::new("access-lock-link");
        let root = dev(&dir);
        fs::create_dir_all(&root.path).unwrap();
        let foreign = dir.path().join("foreign.txt");
        fs::write(&foreign, "marker-foreign-9e3").unwrap();
        fs::hard_link(&foreign, root.path.join(WRITER_LOCK_FILE)).unwrap();
        let gate = AccessGate::open(root.clone());
        assert_eq!(gate.current(), Access::ReadOnly(ReadOnlyReason::LockFailed));
        assert!(!gate.writable_flag().load(Ordering::SeqCst));
        assert_eq!(fs::read(&foreign).unwrap(), b"marker-foreign-9e3");

        fs::remove_file(root.path.join(WRITER_LOCK_FILE)).unwrap();
        fs::create_dir_all(root.path.join(WRITER_LOCK_FILE)).unwrap();
        assert_eq!(
            AccessGate::open(root.clone()).current(),
            Access::ReadOnly(ReadOnlyReason::LockFailed)
        );
        fs::remove_dir(root.path.join(WRITER_LOCK_FILE)).unwrap();
        assert_eq!(AccessGate::open(root).current(), Access::Writable);
    }

    #[test]
    fn access_reaches_the_window_in_a_fixed_shape() {
        assert_eq!(
            serde_json::to_value(Access::Writable).unwrap(),
            serde_json::json!({ "state": "writable" })
        );
        assert_eq!(
            serde_json::to_value(Access::ReadOnly(ReadOnlyReason::OtherWriter)).unwrap(),
            serde_json::json!({ "state": "readOnly", "reason": "otherWriter" })
        );
        assert_eq!(
            serde_json::to_value(Access::ReadOnly(ReadOnlyReason::LockFailed)).unwrap(),
            serde_json::json!({ "state": "readOnly", "reason": "lockFailed" })
        );
    }
}
