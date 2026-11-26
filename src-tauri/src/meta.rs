//! Hangar Note's own data about each note (ADR 0002): its color and, as a sticky note, its place,
//! size, whether it is on the desktop and kept on top. Kept in `meta.json` in Hangar Note's data
//! folder, never in Hangar's index files, keyed by scope key and note ID:
//!
//! ```json
//! { "version": 1, "notes": { "general": { "<id>": { "color": "mint", "bounds": null,
//!   "open": false, "onTop": false } } } }
//! ```
//!
//! Every change is written atomically. A corrupt or newer file is set aside and the defaults
//! apply, so a broken `meta.json` costs colors and places, never a note. An entry of a note that
//! was deleted stays, so a restored note keeps its color.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize, Serializer};

use crate::fsio::{lock, read_capped, set_aside, write_atomic, StorageCode};

pub const META_FILE: &str = "meta.json";
pub const META_VERSION: u32 = 1;
/// Larger remembered sides are taken for garbage, not for a huge screen.
pub const MAX_SIDE: f64 = 16_384.0;
/// Room for tens of thousands of entries of about 150 bytes each.
const MAX_META_BYTES: usize = 16 * 1024 * 1024;

/// The eight note colors (ADR 0001). Their light and dark values live in `src/colors.ts`.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Serialize, Deserialize,
)]
#[serde(rename_all = "lowercase")]
pub enum NoteColor {
    #[default]
    Lemon,
    Peach,
    Mint,
    Sky,
    Lilac,
    Rose,
    Sand,
    Slate,
}

/// A window's place in logical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Bounds {
    /// Finite, with a size above zero and at most [`MAX_SIDE`]; anything else is garbage.
    pub fn plausible(&self) -> bool {
        let finite = [self.x, self.y, self.width, self.height]
            .iter()
            .all(|v| v.is_finite());
        finite
            && self.width > 0.0
            && self.height > 0.0
            && self.width <= MAX_SIDE
            && self.height <= MAX_SIDE
            && self.x.abs() <= 10.0 * MAX_SIDE
            && self.y.abs() <= 10.0 * MAX_SIDE
    }
}

/// What Hangar Note keeps about one note.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteLook {
    #[serde(default)]
    pub color: NoteColor,
    #[serde(default)]
    pub bounds: Option<Bounds>,
    /// The note sits on the desktop as a sticky note; reopened on the next start.
    #[serde(default)]
    pub open: bool,
    #[serde(default)]
    pub on_top: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct MetaFile {
    version: u32,
    /// Scope key, then note ID.
    #[serde(default)]
    notes: BTreeMap<String, BTreeMap<String, NoteLook>>,
}

impl Default for MetaFile {
    fn default() -> Self {
        Self {
            version: META_VERSION,
            notes: BTreeMap::new(),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum MetaError {
    #[error("Invalid window bounds")]
    InvalidBounds,
    /// Shown and logged without the path (security review B3).
    #[error("{}", crate::fsio::storage_log_io(path, source))]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

impl MetaError {
    /// The fixed code of a failed write; the path stays in the log (`NotesError::storage_code`).
    pub fn storage_code(&self) -> Option<StorageCode> {
        match self {
            Self::Io { source, .. } => Some(StorageCode::of(source)),
            Self::InvalidBounds => None,
        }
    }

    /// The fixed code of every variant (security review B4).
    pub fn code(&self) -> &'static str {
        match self.storage_code() {
            Some(code) => code.as_str(),
            None => crate::notes::INVALID_CODE,
        }
    }
}

impl Serialize for MetaError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.code())
    }
}

/// The entries in memory, written through on every change.
#[derive(Debug)]
pub struct MetaStore {
    path: PathBuf,
    state: Mutex<MetaFile>,
}

fn clean(look: &mut NoteLook) {
    if look.bounds.is_some_and(|b| !b.plausible()) {
        look.bounds = None;
    }
}

impl MetaStore {
    /// Opens `path` (normally `<data>/meta.json`).
    pub fn open(path: &Path) -> Self {
        let file = match read_capped(path, MAX_META_BYTES) {
            Ok(Some(bytes)) => match serde_json::from_slice::<MetaFile>(&bytes) {
                Ok(mut file) if file.version == META_VERSION => {
                    for look in file.notes.values_mut().flat_map(|notes| notes.values_mut()) {
                        clean(look);
                    }
                    file
                }
                _ => {
                    set_aside(path);
                    MetaFile::default()
                }
            },
            Ok(None) => {
                set_aside(path);
                MetaFile::default()
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => MetaFile::default(),
            Err(error) => {
                eprintln!(
                    "hangar-note: not read: {}",
                    crate::fsio::storage_log_io(path, &error)
                );
                MetaFile::default()
            }
        };
        Self {
            path: path.to_path_buf(),
            state: Mutex::new(file),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The entry of a note; the defaults for a note without one.
    pub fn get(&self, scope: &str, id: &str) -> NoteLook {
        lock(&self.state)
            .notes
            .get(scope)
            .and_then(|notes| notes.get(id))
            .copied()
            .unwrap_or_default()
    }

    /// Whether the note has an entry (a color of its own).
    pub fn known(&self, scope: &str, id: &str) -> bool {
        lock(&self.state)
            .notes
            .get(scope)
            .is_some_and(|notes| notes.contains_key(id))
    }

    /// Changes one entry and writes the file when something changed; a failed write changes
    /// nothing in memory either.
    pub fn update(
        &self,
        scope: &str,
        id: &str,
        change: impl FnOnce(&mut NoteLook),
    ) -> Result<NoteLook, MetaError> {
        let mut state = lock(&self.state);
        let had = state.notes.get(scope).and_then(|n| n.get(id)).copied();
        let mut look = had.unwrap_or_default();
        change(&mut look);
        if look.bounds.is_some_and(|b| !b.plausible()) {
            return Err(MetaError::InvalidBounds);
        }
        if had == Some(look) {
            return Ok(look);
        }
        let mut next = state.clone();
        next.notes
            .entry(scope.to_owned())
            .or_default()
            .insert(id.to_owned(), look);
        self.write(&next)?;
        *state = next;
        Ok(look)
    }

    /// Carries an entry over to a new ID (a restored note whose old ID was taken again).
    pub fn rename(&self, scope: &str, from: &str, to: &str) -> Result<(), MetaError> {
        if from == to {
            return Ok(());
        }
        let look = self.get(scope, from);
        self.update(scope, to, |next| *next = look).map(|_| ())
    }

    /// Every note on the desktop: scope key, ID and entry.
    pub fn open_notes(&self) -> Vec<(String, String, NoteLook)> {
        lock(&self.state)
            .notes
            .iter()
            .flat_map(|(scope, notes)| {
                notes
                    .iter()
                    .filter(|(_, look)| look.open)
                    .map(|(id, look)| (scope.clone(), id.clone(), *look))
            })
            .collect()
    }

    fn write(&self, file: &MetaFile) -> Result<(), MetaError> {
        let io_error = |source| MetaError::Io {
            path: self.path.clone(),
            source,
        };
        let bytes = serde_json::to_vec_pretty(file).map_err(|e| io_error(io::Error::other(e)))?;
        write_atomic(&self.path, &bytes).map_err(io_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use std::fs;

    const ID: &str = "1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5";

    #[test]
    fn entries_persist_per_scope_and_id() {
        let dir = TempDir::new("meta-roundtrip");
        let path = dir.path().join(META_FILE);
        let meta = MetaStore::open(&path);
        assert_eq!(meta.get("general", ID), NoteLook::default());
        assert!(!meta.known("general", ID));
        let bounds = Bounds {
            x: -1200.0,
            y: 40.0,
            width: 320.0,
            height: 300.0,
        };
        meta.update("general", ID, |look| {
            look.color = NoteColor::Sky;
            look.open = true;
            look.on_top = true;
            look.bounds = Some(bounds);
        })
        .unwrap();
        let again = MetaStore::open(&path);
        let look = again.get("general", ID);
        assert_eq!(look.color, NoteColor::Sky);
        assert_eq!(look.bounds, Some(bounds));
        assert!(again.known("general", ID));
        // Another scope with the same ID is another note.
        assert_eq!(
            again.get("0123456789abcdef0123456789abcdef", ID),
            NoteLook::default()
        );
        assert_eq!(
            again.open_notes(),
            vec![("general".into(), ID.into(), look)]
        );
        let json: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(json["version"], 1);
        assert_eq!(
            json["notes"]["general"][ID],
            serde_json::json!({
                "color": "sky",
                "bounds": { "x": -1200.0, "y": 40.0, "width": 320.0, "height": 300.0 },
                "open": true,
                "onTop": true
            })
        );
    }

    #[test]
    fn garbage_is_refused_and_a_broken_file_set_aside() {
        let dir = TempDir::new("meta-broken");
        let path = dir.path().join(META_FILE);
        let meta = MetaStore::open(&path);
        let bad = Bounds {
            x: f64::NAN,
            y: 0.0,
            width: 10.0,
            height: 10.0,
        };
        assert!(matches!(
            meta.update("general", ID, |look| look.bounds = Some(bad)),
            Err(MetaError::InvalidBounds)
        ));
        assert!(!path.exists(), "nothing written for a refused change");
        fs::write(&path, "{ broken").unwrap();
        let reopened = MetaStore::open(&path);
        assert_eq!(reopened.get("general", ID), NoteLook::default());
        assert!(fs::read_dir(dir.path()).unwrap().flatten().any(|e| e
            .file_name()
            .to_string_lossy()
            .starts_with("meta.json.broken-")));
        // A newer version is not overwritten either.
        fs::write(&path, r#"{"version":9,"notes":{}}"#).unwrap();
        MetaStore::open(&path);
        assert!(!path.exists());
    }

    #[test]
    fn an_entry_follows_a_new_id() {
        let dir = TempDir::new("meta-rename");
        let meta = MetaStore::open(&dir.path().join(META_FILE));
        meta.update("general", "a", |look| look.color = NoteColor::Rose)
            .unwrap();
        meta.rename("general", "a", "b").unwrap();
        assert_eq!(meta.get("general", "b").color, NoteColor::Rose);
    }
}
