//! The notes domain (ADR 0001): index, content, trash and recovery. No Tauri types; the window
//! and command layers call it.
//!
//! ```text
//! notes/
//!   notes.json                 index: color, bounds, open, on top and times of every note
//!   <id>.md                    the content, UTF-8 Markdown, at most 1 MiB
//!   notes.json.broken-<ms>     a corrupt index, set aside before it was rebuilt
//!   .trash/
//!     <id>.md                  deleted notes (moved, never deleted for good)
//!     trash.json               ID, color and time of each deleted note
//! ```
//!
//! IDs are UUID v4 in lowercase, so no file name depends on user text. Every write is atomic
//! (temporary file in the same folder, `sync_all`, then rename): a crash or a full disk leaves the
//! previous file whole. The index can always be rebuilt from the `.md` files, so a corrupt or
//! missing `notes.json` never loses a note. Contents are never logged, and no error text contains
//! content.

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize, Serializer};

pub const NOTES_DIR: &str = "notes";
pub const INDEX_FILE: &str = "notes.json";
pub const TRASH_DIR: &str = ".trash";
pub const TRASH_FILE: &str = "trash.json";
pub const INDEX_VERSION: u32 = 1;
pub const TRASH_VERSION: u32 = 1;
pub const MAX_NOTE_BYTES: usize = 1024 * 1024;
/// More notes than anyone keeps as sticky notes; it bounds the index and every listing.
pub const MAX_NOTES: usize = 10_000;
/// Bytes of each note the list carries for the cards and the search in "All notes". A sticky
/// note is short; a longer one is found by its first 16 KiB.
pub const PREVIEW_BYTES: usize = 16 * 1024;
/// Larger remembered sides are taken for garbage, not for a huge screen.
pub const MAX_SIDE: f64 = 16_384.0;
/// Room for [`MAX_NOTES`] entries of about 250 bytes each, with margin.
const MAX_INDEX_BYTES: usize = 16 * 1024 * 1024;
const NOTE_EXT: &str = "md";
const TEMP_EXT: &str = "tmp";
const BROKEN_PREFIX: &str = "notes.json.broken-";

/// The eight note colors (ADR 0001). Their light and dark values live in `src/colors.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
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

/// One entry of `notes.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMeta {
    pub id: String,
    #[serde(default)]
    pub color: NoteColor,
    #[serde(default)]
    pub bounds: Option<Bounds>,
    /// Whether the note has a window; reopened on the next start.
    #[serde(default)]
    pub open: bool,
    #[serde(default)]
    pub on_top: bool,
    /// Unix time in milliseconds.
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Index {
    version: u32,
    notes: Vec<NoteMeta>,
}

impl Default for Index {
    fn default() -> Self {
        Self {
            version: INDEX_VERSION,
            notes: Vec::new(),
        }
    }
}

/// A note as the list in "All notes" shows it: its entry plus the start of its content.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    #[serde(flatten)]
    pub meta: NoteMeta,
    /// At most [`PREVIEW_BYTES`] of the content, cut at a character boundary.
    pub preview: String,
}

/// A note with its whole content.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteContent {
    #[serde(flatten)]
    pub meta: NoteMeta,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrashEntry {
    id: String,
    #[serde(default)]
    color: NoteColor,
    #[serde(default)]
    deleted_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct TrashIndex {
    version: u32,
    items: Vec<TrashEntry>,
}

/// A deleted note as "Recently deleted" shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub id: String,
    pub color: NoteColor,
    pub deleted_at: u64,
    pub preview: String,
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("Invalid note ID: expected a UUID")]
    InvalidId,
    #[error("Note not found")]
    UnknownNote,
    #[error("Note too large: {size} bytes, at most {max} allowed")]
    TooLarge { size: usize, max: usize },
    #[error("The note file is not UTF-8 text")]
    NotText,
    #[error("Invalid window bounds")]
    InvalidBounds,
    #[error("Too many notes: at most {0} allowed")]
    TooMany(usize),
    #[error("The note is already in the list")]
    AlreadyPresent,
    #[error("File {path} cannot be read or written: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

/// Errors reach the frontend as readable text. No error text contains note content.
impl Serialize for StoreError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

fn io_error(path: &Path) -> impl FnOnce(io::Error) -> StoreError + '_ {
    move |source| StoreError::Io {
        path: path.to_path_buf(),
        source,
    }
}

/// Canonical UUID (8-4-4-4-12 hex digits), upper or lower case, returned in lowercase because
/// file names on Windows and macOS ignore case. Everything else, above all path separators, `..`
/// and drive letters, is rejected.
pub fn normalize_id(id: &str) -> Result<String, StoreError> {
    let bytes = id.as_bytes();
    let valid = bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => *b == b'-',
            _ => b.is_ascii_hexdigit(),
        });
    if valid {
        Ok(id.to_ascii_lowercase())
    } else {
        Err(StoreError::InvalidId)
    }
}

pub fn now_ms() -> u64 {
    millis(SystemTime::now())
}

fn millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| u64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

fn modified_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .map(millis)
        .unwrap_or(0)
}

/// Locks a mutex even if another thread panicked while holding it. The index stays consistent
/// because it is only replaced as a whole after the file write succeeded.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Writes to a unique temporary file in the same folder first, then renames it over the target.
/// `rename` replaces the target on all platforms and within one folder is a single operation, so
/// readers see either the old or the new file, never half of one.
pub(crate) fn write_atomic(path: &Path, data: &[u8]) -> io::Result<()> {
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
        let mut file = create_private_file(&temp)?;
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
pub(crate) fn create_private_dir(dir: &Path) -> io::Result<()> {
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

/// At most `max` bytes of a regular file; `Ok(None)` when it holds more. A link, folder, FIFO or
/// device named like a note is refused: it could lead outside the folder or never end.
pub(crate) fn read_capped(path: &Path, max: usize) -> io::Result<Option<Vec<u8>>> {
    if !fs::symlink_metadata(path)?.file_type().is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a regular file",
        ));
    }
    let file = File::open(path)?;
    let mut bytes = Vec::new();
    let limit = u64::try_from(max).unwrap_or(u64::MAX).saturating_add(1);
    file.take(limit).read_to_end(&mut bytes)?;
    Ok((bytes.len() <= max).then_some(bytes))
}

/// The longest prefix of `bytes` that is valid UTF-8, at most `max` bytes.
fn utf8_prefix(bytes: &[u8], max: usize) -> String {
    let cut = &bytes[..bytes.len().min(max)];
    match std::str::from_utf8(cut) {
        Ok(text) => text.to_owned(),
        Err(error) => String::from_utf8_lossy(&cut[..error.valid_up_to()]).into_owned(),
    }
}

/// `<uuid>.md` in lowercase: the ID, else `None`.
fn id_of_file(name: &str) -> Option<String> {
    let stem = name.strip_suffix(".md")?;
    normalize_id(stem).ok().filter(|id| id == stem)
}

/// The `.md` files directly in `dir` named after a valid ID, as IDs.
fn note_files(dir: &Path) -> HashSet<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return HashSet::new();
    };
    entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|entry| id_of_file(&entry.file_name().to_string_lossy()))
        .collect()
}

/// Removes temporary files a crash left behind. Only this app's own pattern (`.<name>.*.tmp`);
/// a second instance is ruled out by the single instance plugin.
fn remove_stale_temps(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') && name.ends_with(&format!(".{TEMP_EXT}")) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

enum Loaded<T> {
    Missing,
    Valid(T),
    Corrupt,
}

fn load_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Loaded<T>, StoreError> {
    let bytes = match read_capped(path, MAX_INDEX_BYTES) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Ok(Loaded::Corrupt),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Loaded::Missing),
        Err(error) if error.kind() == io::ErrorKind::InvalidInput => return Ok(Loaded::Corrupt),
        Err(error) => return Err(io_error(path)(error)),
    };
    Ok(match serde_json::from_slice(&bytes) {
        Ok(value) => Loaded::Valid(value),
        Err(_) => Loaded::Corrupt,
    })
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), StoreError> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| StoreError::Io {
        path: path.to_path_buf(),
        source: io::Error::other(error),
    })?;
    write_atomic(path, &bytes).map_err(io_error(path))
}

/// Moves a corrupt file aside under `<name>.broken-<millis>` (a counter keeps two in one
/// millisecond apart), so nothing the user could still rescue is overwritten.
fn set_aside(path: &Path) {
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

/// Brings an index in line with the files: invalid IDs, duplicates and entries without a file
/// are dropped, implausible bounds forgotten, and `.md` files without an entry adopted with
/// default values. Returns whether anything changed.
fn reconcile(index: &mut Index, files: &HashSet<String>, dir: &Path) -> bool {
    let before = index.notes.clone();
    let mut seen = HashSet::new();
    let mut kept = Vec::with_capacity(index.notes.len());
    for mut meta in std::mem::take(&mut index.notes) {
        let Ok(id) = normalize_id(&meta.id) else {
            continue;
        };
        if !files.contains(&id) || !seen.insert(id.clone()) {
            continue;
        }
        meta.id = id;
        if meta.bounds.is_some_and(|b| !b.plausible()) {
            meta.bounds = None;
        }
        kept.push(meta);
    }
    let mut adopted: Vec<&String> = files.iter().filter(|id| !seen.contains(*id)).collect();
    adopted.sort();
    for id in adopted {
        let time = modified_ms(&dir.join(format!("{id}.{NOTE_EXT}")));
        kept.push(NoteMeta {
            id: id.clone(),
            color: NoteColor::default(),
            bounds: None,
            open: false,
            on_top: false,
            created_at: time,
            updated_at: time,
        });
    }
    index.notes = kept;
    index.version = INDEX_VERSION;
    index.notes != before
}

/// Storage of all notes. One lock keeps reading, changing and writing the index together.
#[derive(Debug)]
pub struct Store {
    dir: PathBuf,
    index: Mutex<Index>,
}

impl Store {
    /// Opens the notes folder, creating it if needed. A corrupt index is set aside and rebuilt
    /// from the `.md` files; the result is written back when it differs from the file.
    pub fn open(dir: &Path) -> Result<Self, StoreError> {
        create_private_dir(dir).map_err(io_error(dir))?;
        remove_stale_temps(dir);
        remove_stale_temps(&dir.join(TRASH_DIR));
        let path = dir.join(INDEX_FILE);
        let (mut index, mut dirty) = match load_json::<Index>(&path)? {
            Loaded::Valid(index) if index.version == INDEX_VERSION => (index, false),
            Loaded::Missing => (Index::default(), false),
            // Another schema version counts as corrupt: it is set aside, never overwritten.
            Loaded::Valid(_) | Loaded::Corrupt => {
                set_aside(&path);
                (Index::default(), true)
            }
        };
        dirty |= reconcile(&mut index, &note_files(dir), dir);
        if dirty {
            write_json(&path, &index)?;
        }
        Ok(Self {
            dir: dir.to_path_buf(),
            index: Mutex::new(index),
        })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn note_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.{NOTE_EXT}"))
    }

    fn trash_dir(&self) -> PathBuf {
        self.dir.join(TRASH_DIR)
    }

    fn trash_path(&self, id: &str) -> PathBuf {
        self.trash_dir().join(format!("{id}.{NOTE_EXT}"))
    }

    /// Writes `next` and only then takes it as the index, so a failed write changes nothing.
    fn commit(&self, current: &mut Index, next: Index) -> Result<(), StoreError> {
        write_json(&self.dir.join(INDEX_FILE), &next)?;
        *current = next;
        Ok(())
    }

    /// Every note, the most recently changed first.
    pub fn list(&self) -> Vec<NoteSummary> {
        let mut notes = lock(&self.index).notes.clone();
        notes.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.id.cmp(&b.id)));
        notes
            .into_iter()
            .map(|meta| {
                let preview = self.preview(&self.note_path(&meta.id));
                NoteSummary { meta, preview }
            })
            .collect()
    }

    fn preview(&self, path: &Path) -> String {
        match read_capped(path, MAX_NOTE_BYTES) {
            Ok(Some(bytes)) => utf8_prefix(&bytes, PREVIEW_BYTES),
            // Too large: still show its start.
            Ok(None) => File::open(path)
                .and_then(|file| {
                    let mut bytes = Vec::new();
                    file.take(PREVIEW_BYTES as u64).read_to_end(&mut bytes)?;
                    Ok(utf8_prefix(&bytes, PREVIEW_BYTES))
                })
                .unwrap_or_default(),
            Err(_) => String::new(),
        }
    }

    /// The entries of the notes that had a window when the app last ran.
    pub fn open_notes(&self) -> Vec<NoteMeta> {
        lock(&self.index)
            .notes
            .iter()
            .filter(|n| n.open)
            .cloned()
            .collect()
    }

    pub fn get(&self, id: &str) -> Result<NoteMeta, StoreError> {
        let id = normalize_id(id)?;
        lock(&self.index)
            .notes
            .iter()
            .find(|n| n.id == id)
            .cloned()
            .ok_or(StoreError::UnknownNote)
    }

    pub fn read(&self, id: &str) -> Result<NoteContent, StoreError> {
        let meta = self.get(id)?;
        let path = self.note_path(&meta.id);
        let bytes = match read_capped(&path, MAX_NOTE_BYTES) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => {
                let size = fs::metadata(&path)
                    .map(|m| usize::try_from(m.len()).unwrap_or(usize::MAX))
                    .unwrap_or(MAX_NOTE_BYTES + 1);
                return Err(StoreError::TooLarge {
                    size,
                    max: MAX_NOTE_BYTES,
                });
            }
            Err(error) => return Err(io_error(&path)(error)),
        };
        let text = String::from_utf8(bytes).map_err(|_| StoreError::NotText)?;
        Ok(NoteContent { meta, text })
    }

    /// Replaces a note's content and stamps it as changed now.
    pub fn write(&self, id: &str, text: &str) -> Result<NoteMeta, StoreError> {
        if text.len() > MAX_NOTE_BYTES {
            return Err(StoreError::TooLarge {
                size: text.len(),
                max: MAX_NOTE_BYTES,
            });
        }
        let id = normalize_id(id)?;
        let mut index = lock(&self.index);
        let position = index
            .notes
            .iter()
            .position(|n| n.id == id)
            .ok_or(StoreError::UnknownNote)?;
        let path = self.note_path(&id);
        write_atomic(&path, text.as_bytes()).map_err(io_error(&path))?;
        let mut next = index.clone();
        next.notes[position].updated_at = now_ms();
        let meta = next.notes[position].clone();
        self.commit(&mut index, next)?;
        Ok(meta)
    }

    /// A new, empty note with a window (`open`).
    pub fn create(&self, color: NoteColor, bounds: Option<Bounds>) -> Result<NoteMeta, StoreError> {
        if bounds.is_some_and(|b| !b.plausible()) {
            return Err(StoreError::InvalidBounds);
        }
        let mut index = lock(&self.index);
        if index.notes.len() >= MAX_NOTES {
            return Err(StoreError::TooMany(MAX_NOTES));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let path = self.note_path(&id);
        write_atomic(&path, b"").map_err(io_error(&path))?;
        let now = now_ms();
        let meta = NoteMeta {
            id,
            color,
            bounds,
            open: true,
            on_top: false,
            created_at: now,
            updated_at: now,
        };
        let mut next = index.clone();
        next.notes.push(meta.clone());
        if let Err(error) = self.commit(&mut index, next) {
            let _ = fs::remove_file(&path);
            return Err(error);
        }
        Ok(meta)
    }

    /// Changes one entry; the index is written only when something changed.
    fn update(&self, id: &str, change: impl FnOnce(&mut NoteMeta)) -> Result<NoteMeta, StoreError> {
        let id = normalize_id(id)?;
        let mut index = lock(&self.index);
        let position = index
            .notes
            .iter()
            .position(|n| n.id == id)
            .ok_or(StoreError::UnknownNote)?;
        let mut next = index.clone();
        change(&mut next.notes[position]);
        let meta = next.notes[position].clone();
        if next != *index {
            self.commit(&mut index, next)?;
        }
        Ok(meta)
    }

    pub fn set_color(&self, id: &str, color: NoteColor) -> Result<NoteMeta, StoreError> {
        self.update(id, |meta| meta.color = color)
    }

    pub fn set_on_top(&self, id: &str, on_top: bool) -> Result<NoteMeta, StoreError> {
        self.update(id, |meta| meta.on_top = on_top)
    }

    pub fn set_open(&self, id: &str, open: bool) -> Result<NoteMeta, StoreError> {
        self.update(id, |meta| meta.open = open)
    }

    pub fn set_bounds(&self, id: &str, bounds: Bounds) -> Result<NoteMeta, StoreError> {
        if !bounds.plausible() {
            return Err(StoreError::InvalidBounds);
        }
        self.update(id, |meta| meta.bounds = Some(bounds))
    }

    /// Moves a note into the trash. Order for a crash in between: the file moves first, so a
    /// note is never in neither place; the next start drops the entry without a file and the
    /// trash listing adopts the moved file.
    pub fn delete(&self, id: &str) -> Result<TrashItem, StoreError> {
        let id = normalize_id(id)?;
        let mut index = lock(&self.index);
        let position = index
            .notes
            .iter()
            .position(|n| n.id == id)
            .ok_or(StoreError::UnknownNote)?;
        let trash_dir = self.trash_dir();
        create_private_dir(&trash_dir).map_err(io_error(&trash_dir))?;
        let from = self.note_path(&id);
        let to = self.trash_path(&id);
        match fs::rename(&from, &to) {
            Ok(()) => {}
            // Removed from outside meanwhile: there is nothing to keep, only the entry to drop.
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                write_atomic(&to, b"").map_err(io_error(&to))?;
            }
            Err(error) => return Err(io_error(&from)(error)),
        }
        let color = index.notes[position].color;
        let entry = TrashEntry {
            id: id.clone(),
            color,
            deleted_at: now_ms(),
        };
        let mut trash = self.load_trash()?;
        trash.items.retain(|item| item.id != id);
        trash.items.push(entry.clone());
        write_json(&trash_dir.join(TRASH_FILE), &trash)?;
        let mut next = index.clone();
        next.notes.remove(position);
        self.commit(&mut index, next)?;
        Ok(TrashItem {
            preview: self.preview(&to),
            id: entry.id,
            color: entry.color,
            deleted_at: entry.deleted_at,
        })
    }

    /// The trash, brought in line with its files like the index: items without a file are
    /// dropped, files without an item adopted.
    fn load_trash(&self) -> Result<TrashIndex, StoreError> {
        let dir = self.trash_dir();
        let path = dir.join(TRASH_FILE);
        let mut trash = match load_json::<TrashIndex>(&path)? {
            Loaded::Valid(trash) if trash.version == TRASH_VERSION => trash,
            Loaded::Missing => TrashIndex {
                version: TRASH_VERSION,
                items: Vec::new(),
            },
            Loaded::Valid(_) | Loaded::Corrupt => {
                set_aside(&path);
                TrashIndex {
                    version: TRASH_VERSION,
                    items: Vec::new(),
                }
            }
        };
        let files = note_files(&dir);
        let mut seen = HashSet::new();
        trash.items.retain(|item| {
            normalize_id(&item.id).is_ok_and(|id| id == item.id)
                && files.contains(&item.id)
                && seen.insert(item.id.clone())
        });
        let mut adopted: Vec<&String> = files.iter().filter(|id| !seen.contains(*id)).collect();
        adopted.sort();
        for id in adopted {
            trash.items.push(TrashEntry {
                id: id.clone(),
                color: NoteColor::default(),
                deleted_at: modified_ms(&dir.join(format!("{id}.{NOTE_EXT}"))),
            });
        }
        Ok(trash)
    }

    /// The deleted notes, the most recently deleted first.
    pub fn list_trash(&self) -> Result<Vec<TrashItem>, StoreError> {
        let _index = lock(&self.index);
        let mut items: Vec<TrashItem> = self
            .load_trash()?
            .items
            .into_iter()
            .map(|entry| TrashItem {
                preview: self.preview(&self.trash_path(&entry.id)),
                id: entry.id,
                color: entry.color,
                deleted_at: entry.deleted_at,
            })
            .collect();
        items.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at).then(a.id.cmp(&b.id)));
        Ok(items)
    }

    /// Moves a deleted note back into the list (closed, at the default place).
    pub fn restore(&self, id: &str) -> Result<NoteMeta, StoreError> {
        let id = normalize_id(id)?;
        let mut index = lock(&self.index);
        if index.notes.len() >= MAX_NOTES {
            return Err(StoreError::TooMany(MAX_NOTES));
        }
        let mut trash = self.load_trash()?;
        let position = trash
            .items
            .iter()
            .position(|item| item.id == id)
            .ok_or(StoreError::UnknownNote)?;
        let target = self.note_path(&id);
        if index.notes.iter().any(|n| n.id == id) || target.exists() {
            return Err(StoreError::AlreadyPresent);
        }
        let from = self.trash_path(&id);
        fs::rename(&from, &target).map_err(io_error(&from))?;
        let entry = trash.items.remove(position);
        let time = modified_ms(&target);
        let meta = NoteMeta {
            id: id.clone(),
            color: entry.color,
            bounds: None,
            open: false,
            on_top: false,
            created_at: time,
            updated_at: time,
        };
        let mut next = index.clone();
        next.notes.push(meta.clone());
        self.commit(&mut index, next)?;
        // The note is back in the list already; a stale trash item would be dropped on the next
        // listing anyway, because its file is gone.
        if let Err(error) = write_json(&self.trash_dir().join(TRASH_FILE), &trash) {
            eprintln!("hangar-note: trash list not updated after a restore: {error}");
        }
        Ok(meta)
    }
}

/// Whether `name` is a set-aside index (for tests and support).
pub fn is_broken_index_name(name: &str) -> bool {
    name.starts_with(BROKEN_PREFIX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    /// A harmless marker that must never show up in an error text.
    const MARKER: &str = "marker-text-7f3a";

    fn store(dir: &TempDir) -> Store {
        Store::open(dir.path()).unwrap()
    }

    fn files_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_new_note_is_open_empty_and_listed() {
        let dir = TempDir::new("store-create");
        let store = store(&dir);
        let meta = store.create(NoteColor::Mint, None).unwrap();
        assert!(meta.open);
        assert_eq!(meta.color, NoteColor::Mint);
        assert_eq!(normalize_id(&meta.id).unwrap(), meta.id);
        assert_eq!(store.read(&meta.id).unwrap().text, "");
        let list = store.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].meta.id, meta.id);
        // The index on disk holds the same entry.
        let reopened = Store::open(dir.path()).unwrap();
        assert_eq!(reopened.get(&meta.id).unwrap(), meta);
    }

    #[test]
    fn writes_are_atomic_and_leave_no_temporary_files() {
        let dir = TempDir::new("store-atomic");
        let store = store(&dir);
        let meta = store.create(NoteColor::Lemon, None).unwrap();
        store.write(&meta.id, "first version").unwrap();
        store.write(&meta.id, "# Second\n- [ ] task\n").unwrap();
        assert_eq!(store.read(&meta.id).unwrap().text, "# Second\n- [ ] task\n");
        let names = files_in(dir.path());
        assert!(
            names.iter().all(|n| !n.ends_with(".tmp")),
            "temporary files left: {names:?}"
        );
        assert_eq!(
            names,
            vec![format!("{}.md", meta.id), INDEX_FILE.to_owned()]
        );
    }

    #[test]
    fn a_failed_atomic_write_keeps_the_target_and_cleans_up() {
        let dir = TempDir::new("store-atomic-fail");
        // A folder where the file should go: the rename fails on every platform.
        let target = dir.path().join("blocked.md");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("inside.txt"), "keep").unwrap();
        assert!(write_atomic(&target, b"new").is_err());
        assert_eq!(
            fs::read_to_string(target.join("inside.txt")).unwrap(),
            "keep"
        );
        assert_eq!(files_in(dir.path()), vec!["blocked.md".to_owned()]);
    }

    #[test]
    fn stale_temporary_files_are_removed_on_open() {
        let dir = TempDir::new("store-stale");
        fs::write(dir.path().join(".notes.json.123.0.tmp"), "half").unwrap();
        let _store = store(&dir);
        assert!(!dir.path().join(".notes.json.123.0.tmp").exists());
    }

    #[test]
    fn a_corrupt_index_is_set_aside_and_rebuilt_from_the_files() {
        let dir = TempDir::new("store-recover");
        let store = store(&dir);
        let kept = store.create(NoteColor::Rose, None).unwrap();
        store.write(&kept.id, "kept text").unwrap();
        drop(store);
        fs::write(dir.path().join(INDEX_FILE), "{ not json").unwrap();
        let store = Store::open(dir.path()).unwrap();
        let list = store.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].meta.id, kept.id);
        assert_eq!(list[0].preview, "kept text");
        // Rebuilt with default values.
        assert_eq!(list[0].meta.color, NoteColor::Lemon);
        assert!(!list[0].meta.open);
        let broken: Vec<String> = files_in(dir.path())
            .into_iter()
            .filter(|n| is_broken_index_name(n))
            .collect();
        assert_eq!(broken.len(), 1, "{broken:?}");
        assert_eq!(
            fs::read_to_string(dir.path().join(&broken[0])).unwrap(),
            "{ not json"
        );
        // The rebuilt index is on disk and valid.
        let again = Store::open(dir.path()).unwrap();
        assert_eq!(again.list().len(), 1);
    }

    #[test]
    fn an_index_of_another_version_is_set_aside_not_overwritten() {
        let dir = TempDir::new("store-version");
        fs::write(dir.path().join(INDEX_FILE), r#"{"version":99,"notes":[]}"#).unwrap();
        let store = store(&dir);
        assert!(store.list().is_empty());
        assert!(files_in(dir.path()).iter().any(|n| is_broken_index_name(n)));
    }

    #[test]
    fn files_without_entry_are_adopted_and_entries_without_file_dropped() {
        let dir = TempDir::new("store-reconcile");
        let store = store(&dir);
        let gone = store.create(NoteColor::Sky, None).unwrap();
        drop(store);
        fs::remove_file(dir.path().join(format!("{}.md", gone.id))).unwrap();
        let orphan = "0b7f6a0e-3c1d-4c5e-9a8b-1f2e3d4c5b6a";
        fs::write(dir.path().join(format!("{orphan}.md")), "from outside").unwrap();
        // Not a note: wrong name, uppercase ID, other extension.
        fs::write(dir.path().join("readme.md"), "x").unwrap();
        fs::write(
            dir.path().join("0B7F6A0E-3C1D-4C5E-9A8B-1F2E3D4C5B6B.md"),
            "x",
        )
        .unwrap();
        fs::write(dir.path().join(format!("{orphan}.txt")), "x").unwrap();
        let store = Store::open(dir.path()).unwrap();
        let ids: Vec<String> = store.list().into_iter().map(|n| n.meta.id).collect();
        assert_eq!(ids, vec![orphan.to_owned()]);
        assert!(matches!(store.get(&gone.id), Err(StoreError::UnknownNote)));
    }

    #[test]
    fn duplicate_entries_and_implausible_bounds_are_cleaned() {
        let dir = TempDir::new("store-clean");
        let id = "1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5";
        fs::write(dir.path().join(format!("{id}.md")), "x").unwrap();
        let entry = |x: f64| {
            serde_json::json!({
                "id": id.to_uppercase(), "color": "mint",
                "bounds": { "x": x, "y": 0.0, "width": -5.0, "height": 10.0 },
                "open": true, "onTop": false, "createdAt": 1, "updatedAt": 2
            })
        };
        let index = serde_json::json!({ "version": 1, "notes": [entry(1.0), entry(2.0)] });
        fs::write(dir.path().join(INDEX_FILE), index.to_string()).unwrap();
        let store = store(&dir);
        let list = store.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].meta.id, id);
        assert_eq!(list[0].meta.color, NoteColor::Mint);
        assert_eq!(list[0].meta.bounds, None);
    }

    #[test]
    fn delete_moves_to_the_trash_and_restore_brings_it_back() {
        let dir = TempDir::new("store-trash");
        let store = store(&dir);
        let meta = store.create(NoteColor::Lilac, None).unwrap();
        store.write(&meta.id, "shopping list").unwrap();
        let item = store.delete(&meta.id).unwrap();
        assert_eq!(item.id, meta.id);
        assert_eq!(item.color, NoteColor::Lilac);
        assert_eq!(item.preview, "shopping list");
        assert!(store.list().is_empty());
        assert!(!dir.path().join(format!("{}.md", meta.id)).exists());
        assert!(dir
            .path()
            .join(TRASH_DIR)
            .join(format!("{}.md", meta.id))
            .exists());
        let trash = store.list_trash().unwrap();
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].id, meta.id);

        let restored = store.restore(&meta.id).unwrap();
        assert_eq!(restored.id, meta.id);
        assert_eq!(restored.color, NoteColor::Lilac);
        assert!(!restored.open);
        assert_eq!(store.read(&meta.id).unwrap().text, "shopping list");
        assert!(store.list_trash().unwrap().is_empty());
        assert!(matches!(
            store.restore(&meta.id),
            Err(StoreError::UnknownNote)
        ));
    }

    #[test]
    fn the_trash_survives_a_corrupt_trash_list() {
        let dir = TempDir::new("store-trash-recover");
        let store = store(&dir);
        let meta = store.create(NoteColor::Peach, None).unwrap();
        store.delete(&meta.id).unwrap();
        fs::write(dir.path().join(TRASH_DIR).join(TRASH_FILE), "garbage").unwrap();
        let trash = store.list_trash().unwrap();
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].id, meta.id);
        store.restore(&meta.id).unwrap();
        assert_eq!(store.list().len(), 1);
    }

    #[test]
    fn notes_above_one_mebibyte_are_refused() {
        let dir = TempDir::new("store-size");
        let store = store(&dir);
        let meta = store.create(NoteColor::Sand, None).unwrap();
        let fits = "a".repeat(MAX_NOTE_BYTES);
        store.write(&meta.id, &fits).unwrap();
        let too_big = "a".repeat(MAX_NOTE_BYTES + 1);
        assert!(matches!(
            store.write(&meta.id, &too_big),
            Err(StoreError::TooLarge { .. })
        ));
        // The previous content stays.
        assert_eq!(store.read(&meta.id).unwrap().text.len(), MAX_NOTE_BYTES);
        // A file grown from outside is not read whole, yet still previewed.
        fs::write(dir.path().join(format!("{}.md", meta.id)), &too_big).unwrap();
        assert!(matches!(
            store.read(&meta.id),
            Err(StoreError::TooLarge { .. })
        ));
        assert_eq!(store.list()[0].preview.len(), PREVIEW_BYTES);
    }

    #[test]
    fn invalid_ids_are_refused_before_any_file_access() {
        let dir = TempDir::new("store-ids");
        let store = store(&dir);
        for id in [
            "",
            "..",
            "../notes",
            "C:\\x",
            "not-a-uuid",
            "1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f",
            "1c2d3e4f/5a6b-4c7d-8e9f-a0b1c2d3e4f5",
            "1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4fg",
        ] {
            assert!(matches!(store.read(id), Err(StoreError::InvalidId)), "{id}");
            assert!(
                matches!(store.write(id, "x"), Err(StoreError::InvalidId)),
                "{id}"
            );
            assert!(
                matches!(store.delete(id), Err(StoreError::InvalidId)),
                "{id}"
            );
            assert!(
                matches!(store.restore(id), Err(StoreError::InvalidId)),
                "{id}"
            );
        }
        assert_eq!(
            normalize_id("1C2D3E4F-5A6B-4C7D-8E9F-A0B1C2D3E4F5").unwrap(),
            "1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5"
        );
        // A valid but unknown ID is no note.
        assert!(matches!(
            store.read("1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5"),
            Err(StoreError::UnknownNote)
        ));
    }

    #[test]
    fn error_texts_never_contain_note_content() {
        let dir = TempDir::new("store-errors");
        let store = store(&dir);
        let meta = store.create(NoteColor::Slate, None).unwrap();
        store.write(&meta.id, MARKER).unwrap();
        let mut errors = vec![
            store
                .write(&meta.id, &MARKER.repeat(MAX_NOTE_BYTES / MARKER.len() + 1))
                .unwrap_err(),
            store.write(MARKER, MARKER).unwrap_err(),
        ];
        // Not UTF-8: the error names the problem, not the bytes.
        let mut bytes = MARKER.as_bytes().to_vec();
        bytes.push(0xff);
        fs::write(dir.path().join(format!("{}.md", meta.id)), bytes).unwrap();
        errors.push(store.read(&meta.id).unwrap_err());
        // An I/O error: the note's file replaced by a folder.
        let path = dir.path().join(format!("{}.md", meta.id));
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        errors.push(store.write(&meta.id, MARKER).unwrap_err());
        errors.push(store.read(&meta.id).unwrap_err());
        for error in errors {
            let text = error.to_string();
            let json = serde_json::to_string(&error).unwrap();
            assert!(!text.contains(MARKER), "{text}");
            assert!(!json.contains(MARKER), "{json}");
        }
    }

    #[test]
    fn entry_changes_persist_and_bounds_are_checked() {
        let dir = TempDir::new("store-update");
        let store = store(&dir);
        let meta = store.create(NoteColor::Lemon, None).unwrap();
        store.set_color(&meta.id, NoteColor::Sky).unwrap();
        store.set_on_top(&meta.id, true).unwrap();
        store.set_open(&meta.id, false).unwrap();
        let bounds = Bounds {
            x: -1200.0,
            y: 40.0,
            width: 320.0,
            height: 300.0,
        };
        store.set_bounds(&meta.id, bounds).unwrap();
        let bad = Bounds {
            x: f64::NAN,
            ..bounds
        };
        assert!(matches!(
            store.set_bounds(&meta.id, bad),
            Err(StoreError::InvalidBounds)
        ));
        let reopened = Store::open(dir.path()).unwrap();
        let saved = reopened.get(&meta.id).unwrap();
        assert_eq!(saved.color, NoteColor::Sky);
        assert!(saved.on_top);
        assert!(!saved.open);
        assert_eq!(saved.bounds, Some(bounds));
        assert!(reopened.open_notes().is_empty());
    }

    #[test]
    fn the_index_matches_the_documented_format() {
        let dir = TempDir::new("store-format");
        let store = store(&dir);
        let meta = store.create(NoteColor::Lemon, None).unwrap();
        let json: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.path().join(INDEX_FILE)).unwrap()).unwrap();
        assert_eq!(json["version"], 1);
        let entry = &json["notes"][0];
        assert_eq!(entry["id"], meta.id.as_str());
        assert_eq!(entry["color"], "lemon");
        assert!(entry["bounds"].is_null());
        assert_eq!(entry["open"], true);
        assert_eq!(entry["onTop"], false);
        assert!(entry["createdAt"].is_u64());
        assert!(entry["updatedAt"].is_u64());
    }

    #[test]
    fn the_list_is_newest_first_and_previews_cut_at_characters() {
        let dir = TempDir::new("store-order");
        let store = store(&dir);
        let old = store.create(NoteColor::Lemon, None).unwrap();
        let new = store.create(NoteColor::Lemon, None).unwrap();
        store.update(&old.id, |meta| meta.updated_at = 1).unwrap();
        store.update(&new.id, |meta| meta.updated_at = 2).unwrap();
        let ids: Vec<String> = store.list().into_iter().map(|n| n.meta.id).collect();
        assert_eq!(ids, vec![new.id, old.id]);
        // "ä" is two bytes: a cut in its middle drops it rather than garbling it.
        assert_eq!(utf8_prefix("aä".as_bytes(), 2), "a");
    }
}
