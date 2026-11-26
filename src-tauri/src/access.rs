//! Who may write Hangar's private notes (ADR 0002, "Ownership and the single writer").
//!
//! - **Root.** Hangar's notes folder `<local data>/com.feoren.hangar/notes`, or in debug builds the
//!   folder named by [`ROOT_ENV`] (the development root), which counts as handed over.
//! - **Handover marker.** Hangar writes `notes/.handover.json` with `contract >= 1` once it stops
//!   writing notes. Without it Hangar Note only reads, because Hangar may still write the same
//!   files. Hangar Note never writes the marker.
//! - **Writer lock.** `notes/.writer.lock`, held open with an exclusive OS file lock
//!   (`File::try_lock`, `LockFileEx` on Windows, `flock` on Unix) for as long as the app runs. The
//!   lock goes with the process, also on a crash, so a stale lock file never blocks anyone. The
//!   standard library has it since Rust 1.89, so no crate is needed (fs2 and fs4 do the same).
//!   It is taken only once the folder is handed over: a read-only Hangar Note writes nothing at
//!   all into Hangar's folder, not even the lock file.

use std::ffi::OsString;
use std::fs::{File, OpenOptions};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;

use crate::fsio::{create_private_dir, lock, read_capped};
use crate::notes::normalize_path;

/// The environment variable of the development root; read only in debug builds.
pub const ROOT_ENV: &str = "HANGAR_NOTE_NOTES_ROOT";
/// Hangar's identifier: its notes live in its local data folder (in-place storage, ADR 0002).
pub const HANGAR_IDENTIFIER: &str = "com.feoren.hangar";
pub const NOTES_DIR: &str = "notes";
pub const HANDOVER_FILE: &str = ".handover.json";
pub const WRITER_LOCK_FILE: &str = ".writer.lock";
/// The oldest handover contract this Hangar Note understands.
pub const HANDOVER_CONTRACT: u64 = 1;
const MAX_HANDOVER_BYTES: usize = 4096;

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
    #[error("The local data folder of this user is unknown")]
    NoDataFolder,
}

/// The notes root. `env` is the value of [`ROOT_ENV`], honored only when `debug` is true, so a
/// release build always uses Hangar's folder. `data_local` is the user's local data folder.
///
/// A development root that is Hangar's own folder or lies inside it (spelled differently, through
/// `..`, or through a link or junction) is not one: it would skip the handover marker for the
/// person's real notes. It is then treated as if none was given, with a note in the log.
pub fn resolve_root(
    env: Option<OsString>,
    debug: bool,
    data_local: Option<PathBuf>,
) -> Result<NotesRoot, RootError> {
    let hangar = data_local.map(|base| base.join(HANGAR_IDENTIFIER).join(NOTES_DIR));
    if debug {
        if let Some(value) = env.filter(|value| !value.is_empty()) {
            let path = PathBuf::from(value);
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

/// Whether Hangar handed the folder over: `.handover.json` is a small regular file with a
/// `contract` of at least [`HANDOVER_CONTRACT`]. Other fields (`version`, `since`) are not
/// required, so a newer Hangar may add more.
pub fn handed_over(root: &Path) -> bool {
    let Ok(Some(bytes)) = read_capped(&root.join(HANDOVER_FILE), MAX_HANDOVER_BYTES) else {
        return false;
    };
    serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|value| value.get("contract").and_then(serde_json::Value::as_u64))
        .is_some_and(|contract| contract >= HANDOVER_CONTRACT)
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
pub fn take_writer_lock(root: &Path) -> Result<WriterLock, LockError> {
    create_private_dir(root)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(root.join(WRITER_LOCK_FILE))?;
    match file.try_lock() {
        Ok(()) => Ok(WriterLock { _file: file }),
        Err(std::fs::TryLockError::WouldBlock) => Err(LockError::Held),
        Err(std::fs::TryLockError::Error(error)) => Err(LockError::Io(error)),
    }
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
    /// No handover marker: Hangar still keeps these notes.
    NotHandedOver,
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
            state: Mutex::new((Access::ReadOnly(ReadOnlyReason::NotHandedOver), None)),
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

    /// Looks again while read only: Hangar may have handed the folder over meanwhile, or the
    /// other writer ended. Once writable, it stays so while the app runs.
    pub fn refresh(&self) -> Access {
        let mut state = lock(&self.state);
        if state.0 == Access::Writable {
            return state.0;
        }
        let handed = self.root.kind == RootKind::Development || handed_over(&self.root.path);
        let next = if !handed {
            (Access::ReadOnly(ReadOnlyReason::NotHandedOver), None)
        } else {
            match take_writer_lock(&self.root.path) {
                Ok(held) => (Access::Writable, Some(held)),
                Err(LockError::Held) => (Access::ReadOnly(ReadOnlyReason::OtherWriter), None),
                Err(LockError::Io(error)) => {
                    eprintln!("hangar-note: notes stay read only: {error}");
                    (Access::ReadOnly(ReadOnlyReason::LockFailed), None)
                }
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

    #[test]
    fn without_a_marker_hangars_folder_stays_untouched() {
        let dir = TempDir::new("access-marker");
        let root = hangar(&dir);
        fs::create_dir_all(&root.path).unwrap();
        let gate = AccessGate::open(root.clone());
        assert_eq!(
            gate.current(),
            Access::ReadOnly(ReadOnlyReason::NotHandedOver)
        );
        assert!(!gate.writable_flag().load(Ordering::SeqCst));
        // Not even the lock file was written.
        assert_eq!(fs::read_dir(&root.path).unwrap().count(), 0);

        for (text, handed) in [
            ("{\"version\":1,\"contract\":0,\"since\":1}", false),
            ("{\"version\":1,\"since\":1}", false),
            ("not json", false),
            ("{\"version\":1,\"contract\":1,\"since\":1}", true),
            (
                "{\"version\":2,\"contract\":3,\"since\":1,\"by\":\"x\"}",
                true,
            ),
        ] {
            fs::write(root.path.join(HANDOVER_FILE), text).unwrap();
            assert_eq!(handed_over(&root.path), handed, "{text}");
        }
        assert_eq!(gate.refresh(), Access::Writable);
        assert!(gate.writable_flag().load(Ordering::SeqCst));
        assert!(root.path.join(WRITER_LOCK_FILE).is_file());
    }

    #[test]
    fn the_development_root_counts_as_handed_over() {
        let dir = TempDir::new("access-dev");
        let gate = AccessGate::open(dev(&dir));
        assert_eq!(gate.current(), Access::Writable);
        assert!(!gate.root().path.join(HANDOVER_FILE).exists());
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

    #[test]
    fn access_reaches_the_window_in_a_fixed_shape() {
        assert_eq!(
            serde_json::to_value(Access::Writable).unwrap(),
            serde_json::json!({ "state": "writable" })
        );
        assert_eq!(
            serde_json::to_value(Access::ReadOnly(ReadOnlyReason::NotHandedOver)).unwrap(),
            serde_json::json!({ "state": "readOnly", "reason": "notHandedOver" })
        );
    }
}
