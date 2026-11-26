//! Hangar's private notes, in place (ADR 0002, storage option 1). Ported from Hangar's
//! `src-tauri/src/notes.rs` (MIT, same owner; Hangar ADR 0004 and its notes contract), so the
//! files stay byte for byte what Hangar reads and writes:
//!
//! ```text
//! notes/
//!   general/                   the General area, without a folder
//!   <32 hex from SHA-256>/     per working folder, key from the normalized path
//!     folder.json              original path, title, order and stable IDs
//!     <title>.md               the notes, readable in Explorer as well
//!     .trash/                  deleted notes (moved, not deleted)
//!       trash.json             ID, title and time of each deleted note, for restoring
//! ```
//!
//! A note's ID is stored only in `folder.json`, so the file name can follow the title. If a file
//! is missing, its entry is dropped; a `.md` file added from outside is adopted with an ID derived
//! from its scope and name (`stable_id`), the same whether the store may write or not.
//! The store never follows a symbolic link or junction in the notes tree: a linked scope folder
//! or trash counts as missing, and the migration leaves links where they are.
//! Hangar Note never adds a field to `folder.json` or `trash.json` (both parsed with
//! `deny_unknown_fields`, as in Hangar). Contents are never logged.
//!
//! **Shared with Hangar** (ADR 0005, contract "notes-shared 1"). Hangar writes the same folder at
//! the same time. Every read-modify-write of a scope's `folder.json` or `.trash/trash.json` holds
//! the scope lock, an exclusive OS file lock on `<scope>/.lock` ([`SCOPE_LOCK_FILE`]), waits for
//! it at most [`SCOPE_LOCK_WAIT`], re-reads the file from disk under it and writes it atomically.
//! Nothing is written from a copy kept in memory. A note's text is written only while its file is
//! still at the version the editor read ([`NotesStore::write_note_checked`]); new files are
//! created without replacing one that appeared meanwhile, and moves never replace a file.
//!
//! **Read only** (another Hangar Note holds the writer lock, `access.rs`): the store writes
//! nothing at all, no sync, no set-aside metadata, no migration, not even the scope lock file.
//! Reading still syncs in memory; a file without an entry then gets an ID derived from its scope
//! and name, so the same note keeps the same ID between two calls without anything being written.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf, Prefix};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize, Serializer};
use sha2::{Digest, Sha256};

use crate::fsio::{
    create_private_dir, lock, log_cause, millis, read_capped, read_prefix, rename_no_replace,
    storage_log, storage_log_io, utf8_prefix, write_atomic, write_atomic_versioned, StorageCode,
};
use crate::naming::{is_reserved_on_windows, without_invisible, FORBIDDEN_CHARS, JOINERS};
use crate::watch::Watch;

pub const GENERAL_KEY: &str = "general";
const META_FILE: &str = "folder.json";
pub const TRASH_DIR: &str = ".trash";
/// Folder names before Hangar's English localization; [`NotesStore::migrate_legacy_layout`]
/// moves them, as Hangar does on every start.
const LEGACY_GENERAL_KEY: &str = "allgemein";
const LEGACY_TRASH_DIR: &str = ".papierkorb";
const META_VERSION: u32 = 1;
pub const MAX_NOTE_BYTES: usize = 1024 * 1024;
const MAX_META_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_TITLE_CHARS: usize = 200;
/// Short enough that even deep profile paths on Windows stay below 260 characters.
const MAX_STEM_CHARS: usize = 80;
const FALLBACK_STEM: &str = "Note";
const TRASH_META_FILE: &str = "trash.json";
const TRASH_META_VERSION: u32 = 1;
/// The scope lock of contract "notes-shared 1" (ADR 0005): held by Hangar and Hangar Note around
/// every read-modify-write of the scope's `folder.json` and `.trash/trash.json`. Never a note.
pub const SCOPE_LOCK_FILE: &str = ".lock";
/// How long a write waits for the scope lock before it gives up with the storage code `io`.
pub const SCOPE_LOCK_WAIT: Duration = Duration::from_secs(2);
/// The pause between two tries while the other program holds the lock.
const SCOPE_LOCK_RETRY: Duration = Duration::from_millis(10);
/// At most this many hits per search; title hits first, then the newest notes.
pub const MAX_SEARCH_RESULTS: usize = 50;
pub const MAX_QUERY_CHARS: usize = 200;
/// A search reads at most this many note files, so a huge notes folder cannot stall it.
const MAX_SEARCH_FILES: usize = 5000;
/// A search reads at most this many bytes of note content in total.
const MAX_SEARCH_BYTES: usize = 64 * 1024 * 1024;
/// Characters of context before a hit in the excerpt.
const EXCERPT_CONTEXT: usize = 60;
const EXCERPT_MAX_CHARS: usize = 160;

/// A scope: `{ "path": "C:\\..." }` or `{ "path": null }` for the General area.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NoteFolder {
    #[serde(default)]
    pub path: Option<PathBuf>,
}

impl NoteFolder {
    pub fn general() -> Self {
        Self { path: None }
    }

    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self {
            path: Some(path.into()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    pub folder_key: String,
    /// `null` for the General area.
    pub path: Option<PathBuf>,
    /// The last segment of `path` (the project folder's name), or the whole path where it has
    /// none (a drive root); `null` for the General area, whose name the window translates.
    pub name: Option<String>,
    pub note_count: usize,
    /// Unix time in milliseconds of the newest note; `null` without notes.
    pub updated_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteInfo {
    pub id: String,
    pub title: String,
    /// Unix time in milliseconds (modification time of the file).
    pub updated_at: Option<u64>,
    pub order: u32,
}

/// A hit of [`NotesStore::search`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub folder_key: String,
    /// The scope's working folder, `null` for the General area.
    pub path: Option<PathBuf>,
    pub id: String,
    pub title: String,
    /// Text around the first hit in the content (whitespace collapsed), or the start of the
    /// content when only the title matches.
    pub excerpt: String,
    pub updated_at: Option<u64>,
}

/// A deleted note in the scope's trash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashInfo {
    pub id: String,
    pub title: String,
    /// Unix time in milliseconds of the deletion.
    pub deleted_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrashMeta {
    version: u32,
    items: Vec<TrashEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrashEntry {
    id: String,
    title: String,
    /// File name inside `.trash/`.
    file: String,
    deleted_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FolderMeta {
    version: u32,
    path: Option<PathBuf>,
    notes: Vec<NoteEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NoteEntry {
    id: String,
    title: String,
    /// Only the file name, without folder.
    file: String,
    order: u32,
}

/// What the frontend receives for [`NotesError::ReadOnly`], so it can show its calm hint.
pub const READ_ONLY_CODE: &str = "read-only";

#[derive(Debug, thiserror::Error)]
pub enum NotesError {
    #[error("Invalid title: {0}")]
    InvalidTitle(&'static str),
    #[error("Invalid note ID: expected a UUID")]
    InvalidId,
    #[error("Note not found")]
    UnknownNote,
    #[error("Invalid folder: {0}")]
    InvalidFolder(&'static str),
    #[error("Note too large: {size} bytes, at most {max} allowed")]
    TooLarge { size: usize, max: usize },
    #[error("The note file is not UTF-8 text")]
    NotText,
    #[error("Invalid search: {0}")]
    InvalidQuery(&'static str),
    /// Another Hangar Note holds the writer lock, or the folder cannot be locked (`access.rs`).
    #[error("{READ_ONLY_CODE}")]
    ReadOnly,
    /// The file is no longer at the version the editor read (another program changed it).
    #[error("The note changed on disk since it was read")]
    Changed,
    /// Shown and logged as scope key, kind of file and cause only (security review B3): the file
    /// name of a note is its title.
    #[error("{}", crate::fsio::storage_log_io(path, source))]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

impl NotesError {
    /// The fixed code a storage failure reaches the window with (ADR 0002, "Errors for people"):
    /// never the OS text or the path, which only the log gets. `None` for the errors that are not
    /// about storage (titles, IDs, queries; read only has a code of its own).
    pub fn storage_code(&self) -> Option<StorageCode> {
        match self {
            Self::Io { source, .. } => Some(StorageCode::of(source)),
            Self::TooLarge { .. } => Some(StorageCode::TooLarge),
            Self::UnknownNote => Some(StorageCode::NotFound),
            _ => None,
        }
    }

    /// The fixed code of every variant (security review B4); the text goes to the log only.
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidTitle(_) => INVALID_TITLE_CODE,
            Self::InvalidId => INVALID_ID_CODE,
            Self::InvalidFolder(_) | Self::InvalidQuery(_) | Self::NotText => INVALID_CODE,
            Self::ReadOnly => READ_ONLY_CODE,
            Self::Changed => CHANGED_CODE,
            Self::UnknownNote | Self::TooLarge { .. } | Self::Io { .. } => self
                .storage_code()
                .map_or(INVALID_CODE, StorageCode::as_str),
        }
    }
}

pub const INVALID_TITLE_CODE: &str = "invalid-title";
pub const INVALID_ID_CODE: &str = "invalid-id";
/// A folder, a query or a file that is not text: nothing the person can fix by retrying.
pub const INVALID_CODE: &str = "invalid";
pub const CHANGED_CODE: &str = "changed";

impl Serialize for NotesError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.code())
    }
}

/// The version of a note file as an editor holds it (security review B8): modification time in
/// nanoseconds and length, opaque to the window. A write by another program changes at least one
/// of them on every file system with sub-second times; on one with whole seconds, a change of the
/// same length within the same second goes unnoticed.
pub fn version(meta: &fs::Metadata) -> String {
    let nanos = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |since| since.as_nanos());
    format!("{nanos}-{}", meta.len())
}

/// The metadata of a file through a handle of its own, as [`read_capped_with_meta`] takes it, so
/// both give the same version of the same file.
fn handle_meta(path: &Path) -> io::Result<fs::Metadata> {
    fs::File::open(path)?.metadata()
}

/// At most `max` bytes of a regular file with the metadata of the same handle; `Ok(None)` when
/// it holds more.
fn read_capped_with_meta(path: &Path, max: usize) -> io::Result<Option<(Vec<u8>, fs::Metadata)>> {
    use std::io::Read as _;
    if !fs::symlink_metadata(path)?.file_type().is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a regular file",
        ));
    }
    let file = fs::File::open(path)?;
    let meta = file.metadata()?;
    let mut bytes = Vec::new();
    let limit = u64::try_from(max).unwrap_or(u64::MAX).saturating_add(1);
    (&file).take(limit).read_to_end(&mut bytes)?;
    Ok((bytes.len() <= max).then_some((bytes, meta)))
}

fn io_error(path: &Path) -> impl FnOnce(io::Error) -> NotesError + '_ {
    move |source| NotesError::Io {
        path: path.to_path_buf(),
        source,
    }
}

/// Path in comparison form: separators unified, `.` and doubled separators removed, no
/// trailing separator, `\\?\C:\` like `C:\`. On Windows also lowercased, because NTFS is
/// case-insensitive by default and dialogs, shells and user input spell the same folder
/// differently. `..` stays as is (no resolving without the file system, symbolic links would make
/// it wrong), and nothing is canonicalized either, because the folder may be missing or sit on a
/// slow network drive. Identical to Hangar's: the scope key depends on it.
pub fn normalize_path(path: &Path) -> String {
    let windows = cfg!(windows);
    let separator = if windows { "\\" } else { "/" };
    let mut prefix = String::new();
    let mut rooted = false;
    let mut parts: Vec<String> = Vec::new();
    for component in path.components() {
        match component {
            Component::Prefix(p) => {
                prefix = match p.kind() {
                    Prefix::Disk(d) | Prefix::VerbatimDisk(d) => format!("{}:", char::from(d)),
                    Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => format!(
                        "\\\\{}\\{}",
                        server.to_string_lossy(),
                        share.to_string_lossy()
                    ),
                    _ => p.as_os_str().to_string_lossy().into_owned(),
                }
            }
            Component::RootDir => rooted = true,
            Component::CurDir => {}
            Component::ParentDir => parts.push("..".into()),
            Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
        }
    }
    let mut text = prefix;
    if rooted {
        text.push_str(separator);
    }
    text.push_str(&parts.join(separator));
    if windows {
        text.to_lowercase()
    } else {
        text
    }
}

/// Folder key: `general` or 32 hex digits (128 bits) from SHA-256 of the normalized path.
/// Stable across versions and machines, without path parts in the folder name.
pub fn folder_key(folder: &NoteFolder) -> Result<String, NotesError> {
    let Some(path) = &folder.path else {
        return Ok(GENERAL_KEY.to_owned());
    };
    if path.as_os_str().is_empty() || !path.is_absolute() {
        return Err(NotesError::InvalidFolder("path must be absolute"));
    }
    let digest = Sha256::digest(normalize_path(path).as_bytes());
    Ok(digest.iter().take(16).map(|b| format!("{b:02x}")).collect())
}

pub fn is_folder_key(name: &str) -> bool {
    name == GENERAL_KEY || (name.len() == 32 && name.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Check and clean up a display title: invisible characters (`naming::without_invisible`, the
/// direction marks among them, while emoji sequences and Persian or Indic spelling keep their
/// joiners) and outer white space are dropped, as typed or pasted titles carry them by accident
/// and they could reorder or hide what the list shows (security review L2).
/// Titles of files already on disk go through here as well, so such a file is still listed, under
/// its visible name.
pub fn validate_title(title: &str) -> Result<String, NotesError> {
    let visible = without_invisible(title);
    let title = visible.trim();
    if title.is_empty() {
        return Err(NotesError::InvalidTitle("must not be empty"));
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(NotesError::InvalidTitle("too long"));
    }
    if title.chars().any(char::is_control) {
        return Err(NotesError::InvalidTitle("contains control characters"));
    }
    Ok(title.to_owned())
}

/// File name (without `.md`) from a title, safe on all platforms by the shared naming rule
/// (`naming.rs`): no path parts, forbidden or invisible characters, no dot or space at the end
/// (Windows strips them), no dot at the start (hidden, and `.trash` stays unambiguous), no
/// reserved device names, limited length. Sanitized rather than refused: the title stays as
/// given, only its file name differs.
pub fn file_stem(title: &str) -> String {
    let cleaned: String = without_invisible(title)
        .chars()
        .map(|c| {
            if c.is_control() || FORBIDDEN_CHARS.contains(c) {
                '_'
            } else {
                c
            }
        })
        .take(MAX_STEM_CHARS)
        .collect();
    // A joiner the length limit cut off from its second character would end the name unseen.
    let mut stem = cleaned
        .trim_start()
        .trim_end_matches(|c: char| c == '.' || c == ' ' || JOINERS.contains(&c))
        .to_owned();
    if stem.starts_with('.') {
        stem.insert(0, '_');
    }
    if stem.is_empty() {
        return FALLBACK_STEM.to_owned();
    }
    if is_reserved_on_windows(&stem) {
        stem.insert(0, '_');
    }
    stem
}

/// "Note 1", "Note 2" …: the smallest free number after `base`, compared without case, so new
/// titles do not repeat (Hangar's `untitledTitle`).
pub fn untitled_title(base: &str, existing: &[String]) -> String {
    let taken: HashSet<String> = existing
        .iter()
        .map(|title| title.trim().to_lowercase())
        .collect();
    (1u32..)
        .map(|number| format!("{} {number}", base.trim()))
        .find(|title| !taken.contains(&title.to_lowercase()))
        .unwrap_or_else(|| base.to_owned())
}

/// A plain `.md` file name: a single path component, no folder, no `..`, none of the characters
/// Windows refuses in a name and no control character. Metadata on disk (`folder.json`,
/// `trash.json`) is a file like any other; an entry naming anything else must never make the
/// store read, rename or write outside its folder, and `:` would name an NTFS alternate data
/// stream (`x.md:hidden`) of a file instead of the file.
fn plain_markdown_name(name: &str) -> bool {
    let mut parts = Path::new(name).components();
    let single = matches!(
        (parts.next(), parts.next()),
        (Some(Component::Normal(part)), None) if part == name
    );
    let clean = !name
        .chars()
        .any(|c| c.is_control() || FORBIDDEN_CHARS.contains(c));
    single && clean && is_markdown(name)
}

/// Whether `path` is a symbolic link, a junction or another name surrogate (`symlink_metadata`
/// does not follow it). Logged by path only: the notes tree never follows one, so a link placed
/// in it cannot make the store read or move files elsewhere.
fn is_link(path: &Path) -> bool {
    let link = fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink());
    if link {
        log_link(path);
    }
    link
}

fn log_link(path: &Path) {
    eprintln!(
        "hangar-note: skipping a link: {}",
        storage_log(path, "a link, not a folder")
    );
}

/// A folder of the notes tree itself, not a link or junction to one.
fn is_plain_dir(path: &Path) -> bool {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            log_link(path);
            false
        }
        Ok(meta) => meta.is_dir(),
        Err(_) => false,
    }
}

fn is_markdown(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("md"))
}

fn modified(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(millis)
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// The ID of an adopted file (one without an entry): the same for the same scope and file name,
/// whether the store may write or not, so a note keeps its ID when Hangar hands the folder over.
/// A UUID v4 in form (version nibble 4, RFC 4122 variant), which is all Hangar checks.
fn stable_id(scope: &str, file: &str) -> String {
    let digest = Sha256::digest(format!("{scope}\n{}", file.to_lowercase()).as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    uuid::Builder::from_random_bytes(bytes)
        .into_uuid()
        .to_string()
}

/// [`stable_id`], unless an entry already holds it (a note adopted under this name was renamed
/// and a new file took the name): then the first free one of a fixed sequence, so the result
/// still depends on the folder's contents only.
fn free_stable_id(scope: &str, file: &str, taken: &HashSet<String>) -> String {
    let first = stable_id(scope, file);
    if !taken.contains(&first) {
        return first;
    }
    (1u32..)
        .map(|n| stable_id(scope, &format!("{file}\n{n}")))
        .find(|id| !taken.contains(id))
        .unwrap_or_else(new_id)
}

/// Canonical UUID (8-4-4-4-12 hex digits), upper or lower case, returned in lowercase because
/// file names on Windows and macOS ignore case.
pub fn check_id(id: &str) -> Result<String, NotesError> {
    let bytes = id.as_bytes();
    let valid = bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => *b == b'-',
            _ => b.is_ascii_hexdigit(),
        });
    if valid {
        Ok(id.to_ascii_lowercase())
    } else {
        Err(NotesError::InvalidId)
    }
}

/// Reads a regular file of at most `max` bytes. `Ok(None)`: file missing. `Err`: reason without
/// content (larger, a link, a folder).
fn read_limited(path: &Path, max: usize) -> Result<Option<Vec<u8>>, String> {
    match read_capped(path, max) {
        Ok(Some(bytes)) => Ok(Some(bytes)),
        Ok(None) => Err(format!("larger than {max} bytes")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        // The number, not the OS text (security review B3).
        Err(error) => Err(log_cause(&error)),
    }
}

/// Storage of all private notes. A lock keeps reading, changing and writing `folder.json`
/// together. Clones share the lock and the write permission.
#[derive(Debug, Clone)]
pub struct NotesStore {
    root: PathBuf,
    guard: Arc<Mutex<()>>,
    writable: Arc<AtomicBool>,
    watch: Arc<Watch>,
    lock_wait: Duration,
}

/// The held scope lock; dropping it releases the lock (and closing the handle does on a crash).
#[derive(Debug)]
struct ScopeLock {
    _file: fs::File,
}

/// Takes `<dir>/.lock` exclusively, trying again every [`SCOPE_LOCK_RETRY`] for at most `wait`.
/// On timeout [`io::ErrorKind::TimedOut`], which reaches the window as the storage code `io`.
fn lock_scope(dir: &Path, wait: Duration) -> io::Result<ScopeLock> {
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(dir.join(SCOPE_LOCK_FILE))?;
    let deadline = Instant::now() + wait;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(ScopeLock { _file: file }),
            Err(fs::TryLockError::WouldBlock) => {
                if Instant::now() >= deadline {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "another program holds the scope lock",
                    ));
                }
                std::thread::sleep(SCOPE_LOCK_RETRY);
            }
            Err(fs::TryLockError::Error(error)) => return Err(error),
        }
    }
}

/// How [`NotesStore::open`] treats the scope lock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Hold {
    /// Reading: the lock is taken only if the sync has to save, and released again.
    WhileSyncing,
    /// Changing the scope: the lock is held from the read until the returned [`Folder`] drops.
    UntilDone,
}

struct Folder {
    key: String,
    dir: PathBuf,
    meta: FolderMeta,
    /// Held while the scope is being changed ([`Hold::UntilDone`]).
    _lock: Option<ScopeLock>,
}

impl Folder {
    fn entry(&self, id: &str) -> Result<&NoteEntry, NotesError> {
        let id = check_id(id)?;
        self.meta
            .notes
            .iter()
            .find(|n| n.id == id)
            .ok_or(NotesError::UnknownNote)
    }

    fn file(&self, entry: &NoteEntry) -> PathBuf {
        self.dir.join(&entry.file)
    }

    /// Free file name for `title`; `except` is the note's own name when renaming.
    fn free_file_name(&self, title: &str, except: Option<&str>) -> String {
        let stem = file_stem(title);
        let taken: HashSet<String> = self
            .meta
            .notes
            .iter()
            .map(|n| n.file.to_lowercase())
            .filter(|f| except.is_none_or(|e| e.to_lowercase() != *f))
            .collect();
        let is_free = |name: &str| {
            let lower = name.to_lowercase();
            if except.is_some_and(|e| e.to_lowercase() == lower) {
                return true;
            }
            !taken.contains(&lower) && !self.dir.join(name).exists()
        };
        let mut candidate = format!("{stem}.md");
        let mut n = 2;
        while !is_free(&candidate) {
            candidate = format!("{stem} ({n}).md");
            n += 1;
        }
        candidate
    }

    fn next_order(&self) -> u32 {
        self.meta
            .notes
            .iter()
            .map(|n| n.order.saturating_add(1))
            .max()
            .unwrap_or(0)
    }

    fn save(&self) -> Result<(), NotesError> {
        let path = self.dir.join(META_FILE);
        let json = serde_json::to_vec_pretty(&self.meta)
            .map_err(|e| io_error(&path)(io::Error::new(io::ErrorKind::InvalidData, e)))?;
        write_atomic(&path, &json).map_err(io_error(&path))
    }

    /// Sync with the folder: missing files are dropped, foreign `.md` files are added under their
    /// [`stable_id`], read only or not.
    fn sync(&mut self) -> Result<bool, NotesError> {
        let before = self.meta.notes.len();
        let dir = self.dir.clone();
        self.meta.notes.retain(|n| dir.join(&n.file).is_file());
        let mut changed = self.meta.notes.len() != before;
        let known: HashSet<String> = self
            .meta
            .notes
            .iter()
            .map(|n| n.file.to_lowercase())
            .collect();
        let mut found: Vec<String> = Vec::new();
        for entry in fs::read_dir(&self.dir).map_err(io_error(&self.dir))? {
            let Ok(entry) = entry else { continue };
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            let is_file = entry.file_type().is_ok_and(|t| t.is_file());
            if is_file && is_markdown(&name) && !known.contains(&name.to_lowercase()) {
                found.push(name);
            }
        }
        found.sort();
        let mut ids: HashSet<String> = self.meta.notes.iter().map(|n| n.id.clone()).collect();
        for name in found {
            let stem = Path::new(&name)
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let title = validate_title(&stem).unwrap_or_else(|_| FALLBACK_STEM.to_owned());
            let order = self.next_order();
            let id = free_stable_id(&self.key, &name, &ids);
            ids.insert(id.clone());
            self.meta.notes.push(NoteEntry {
                id,
                title,
                file: name,
                order,
            });
            changed = true;
        }
        Ok(changed)
    }
}

/// The name a scope is shown with: the last segment of its working folder, or the whole path
/// where it has none (`C:\`, `/`).
pub fn display_name(path: &Path) -> String {
    path.file_name().map_or_else(
        || path.to_string_lossy().into_owned(),
        |name| name.to_string_lossy().into_owned(),
    )
}

/// Creates an empty file in `dir` under the name `pick` returns, never over a file that is
/// already there: a name found free can be taken by Hangar before the file is made, and an atomic
/// write would replace that note. On [`io::ErrorKind::AlreadyExists`] `pick` runs again.
fn create_free_file(dir: &Path, mut pick: impl FnMut() -> String) -> io::Result<String> {
    let mut last = None;
    for _ in 0..MAX_MOVE_ATTEMPTS {
        let name = pick();
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(dir.join(&name)) {
            Ok(file) => {
                file.sync_all()?;
                return Ok(name);
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => last = Some(error),
            Err(error) => return Err(error),
        }
    }
    Err(last.unwrap_or_else(|| io::ErrorKind::AlreadyExists.into()))
}

fn log_migration_error(path: &Path, error: &io::Error) {
    eprintln!(
        "hangar-note: notes not moved to the new folder names: {}",
        storage_log_io(path, error)
    );
}

/// How often a move looks for another free name after the one it found was taken in between.
const MAX_MOVE_ATTEMPTS: usize = 16;

/// Moves `from` into `dir` under the name `pick` returns, never over a file that is already there
/// (security review L3): a name found free can be taken before the rename, by Hangar or another
/// program, and `fs::rename` would replace that file. On [`io::ErrorKind::AlreadyExists`] `pick`
/// is asked again (it sees the new file), at most [`MAX_MOVE_ATTEMPTS`] times.
fn move_to_free_name(
    from: &Path,
    dir: &Path,
    mut pick: impl FnMut() -> String,
) -> io::Result<String> {
    for _ in 0..MAX_MOVE_ATTEMPTS {
        let name = pick();
        match rename_no_replace(from, &dir.join(&name)) {
            Ok(()) => return Ok(name),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "no free file name",
    ))
}

/// `name` in `dir` if free, otherwise `stem (2).ext`, `stem (3).ext` and so on.
fn free_name(dir: &Path, name: &str) -> String {
    if !dir.join(name).exists() {
        return name.to_owned();
    }
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .map_or_else(|| name.to_owned(), |s| s.to_string_lossy().into_owned());
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    (2u32..)
        .map(|n| format!("{stem} ({n}){ext}"))
        .find(|candidate| !dir.join(candidate).exists())
        .unwrap_or_else(|| name.to_owned())
}

/// Moves the entries of `old` into the existing folder `new` without overwriting anything.
/// Subfolders are merged the same way. Returns the moved files as (old name, new name). Names
/// that are not valid UTF-8 and the names in `skip` stay in `old`.
fn merge_dir(old: &Path, new: &Path, skip: &[&str]) -> io::Result<Vec<(String, String)>> {
    let mut names: Vec<String> = fs::read_dir(old)?
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| !skip.contains(&n.as_str()))
        .collect();
    names.sort();
    let mut moved = Vec::new();
    for name in names {
        let from = old.join(&name);
        // Without following links: a link stays where it is, its target is never touched.
        let kind = fs::symlink_metadata(&from)?.file_type();
        if kind.is_symlink() {
            log_link(&from);
            continue;
        }
        if kind.is_dir() {
            move_dir(&from, &new.join(&name))?;
            continue;
        }
        let target = move_to_free_name(&from, new, || free_name(new, &name))?;
        moved.push((name, target));
    }
    Ok(moved)
}

/// Whether `old` may be moved to `new` at all: `old` is a plain folder and `new` is not a link.
/// A link on either side is skipped (and logged), so the migration never follows one.
fn movable(old: &Path, new: &Path) -> bool {
    is_plain_dir(old) && !is_link(new)
}

/// Whether `path` exists, without following a link.
fn present(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

/// Renames `old` to `new`, or merges it into `new` if that already exists. Missing `old` is not
/// an error. `old` is removed only once it is empty; `remove_dir` never deletes contents.
fn move_dir(old: &Path, new: &Path) -> io::Result<()> {
    if !movable(old, new) {
        return Ok(());
    }
    if !present(new) {
        return fs::rename(old, new);
    }
    merge_dir(old, new, &[])?;
    let _ = fs::remove_dir(old);
    Ok(())
}

/// Like [`move_dir`], but on a merge the entries of the old `folder.json` move along, so the
/// moved notes keep their IDs, titles and relative order. An unreadable old `folder.json`, or an
/// unreadable one in `new`, stays untouched; the moved `.md` files are then adopted with a new ID
/// on the next sync, as for files added from outside.
fn migrate_general(old: &Path, new: &Path) -> io::Result<()> {
    if !movable(old, new) {
        return Ok(());
    }
    if !present(new) {
        return fs::rename(old, new);
    }
    let moved = merge_dir(old, new, &[META_FILE])?;
    let old_meta_path = old.join(META_FILE);
    let new_meta_path = new.join(META_FILE);
    let old_meta = NotesStore::read_meta(old);
    let new_meta = if new_meta_path.exists() {
        NotesStore::read_meta(new)
    } else {
        Some(FolderMeta {
            version: META_VERSION,
            path: None,
            notes: Vec::new(),
        })
    };
    if let (Some(mut old_meta), Some(mut meta)) = (old_meta, new_meta) {
        let mut ids: HashSet<String> = meta.notes.iter().map(|n| n.id.clone()).collect();
        let mut order = meta
            .notes
            .iter()
            .map(|n| n.order.saturating_add(1))
            .max()
            .unwrap_or(0);
        old_meta.notes.sort_by_key(|n| n.order);
        for entry in old_meta.notes {
            let Some((_, file)) = moved.iter().find(|(from, _)| *from == entry.file) else {
                continue;
            };
            let id = if ids.insert(entry.id.clone()) {
                entry.id
            } else {
                let id = new_id();
                ids.insert(id.clone());
                id
            };
            meta.notes.push(NoteEntry {
                id,
                title: entry.title,
                file: file.clone(),
                order,
            });
            order = order.saturating_add(1);
        }
        let json = serde_json::to_vec_pretty(&meta)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        write_atomic(&new_meta_path, &json)?;
        // Everything it described is now in the new folder.json.
        fs::remove_file(&old_meta_path)?;
    }
    let _ = fs::remove_dir(old);
    Ok(())
}

/// Search text: trimmed, not longer than [`MAX_QUERY_CHARS`], no control characters. `None` for
/// an empty query, which finds nothing.
pub fn validate_query(query: &str) -> Result<Option<String>, NotesError> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(None);
    }
    if query.chars().count() > MAX_QUERY_CHARS {
        return Err(NotesError::InvalidQuery("too long"));
    }
    if query.chars().any(char::is_control) {
        return Err(NotesError::InvalidQuery("contains control characters"));
    }
    Ok(Some(query.to_lowercase()))
}

/// Byte offset in `text` of the character at which `lower_pos` (an offset in
/// `text.to_lowercase()`) starts. Lowercasing can change byte lengths, so offsets differ.
fn original_offset(text: &str, lower_pos: usize) -> usize {
    let mut lowered = 0;
    for (index, c) in text.char_indices() {
        if lowered >= lower_pos {
            return index;
        }
        lowered += c.to_lowercase().map(char::len_utf8).sum::<usize>();
    }
    text.len()
}

fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Up to [`EXCERPT_MAX_CHARS`] characters around the first match of `query_lower` in `content`,
/// whitespace collapsed; `…` marks a cut. Without a match the start of the content.
pub fn excerpt(content: &str, query_lower: &str) -> String {
    let lower = content.to_lowercase();
    let start = if query_lower.is_empty() {
        0
    } else {
        lower.find(query_lower).map_or(0, |pos| {
            let at = original_offset(content, pos);
            content[..at]
                .char_indices()
                .rev()
                .nth(EXCERPT_CONTEXT.saturating_sub(1))
                .map_or(0, |(index, _)| index)
        })
    };
    let window: String = content[start..]
        .chars()
        .take(EXCERPT_MAX_CHARS * 2)
        .collect();
    let mut text: String = collapse_whitespace(&window)
        .chars()
        .take(EXCERPT_MAX_CHARS)
        .collect();
    let cut_end = content[start..].chars().count() > EXCERPT_MAX_CHARS
        && collapse_whitespace(&content[start..]).chars().count() > EXCERPT_MAX_CHARS;
    if cut_end {
        text.push('…');
    }
    if start > 0 && !content[..start].trim().is_empty() {
        text.insert(0, '…');
    }
    text
}

/// Title of a trash file without a record: `<millis>-<file>.md` back to `<file>`.
fn trash_title(file: &str) -> (String, Option<u64>) {
    let stem = Path::new(file)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let (stamp, rest) = match stem.split_once('-') {
        Some((digits, rest))
            if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) =>
        {
            (digits.parse().ok(), rest.to_owned())
        }
        _ => (None, stem.clone()),
    };
    let title = validate_title(&rest).unwrap_or_else(|_| FALLBACK_STEM.to_owned());
    (title, stamp)
}

impl NotesStore {
    /// `root` is the notes folder itself (`<Hangar local data>/notes` or the development root).
    /// `writable` is shared with the access gate, which turns it on once the writer lock is held.
    pub fn new(root: &Path, writable: Arc<AtomicBool>) -> Self {
        Self {
            root: root.to_path_buf(),
            guard: Arc::default(),
            writable,
            watch: Arc::new(Watch::new(root)),
            lock_wait: SCOPE_LOCK_WAIT,
        }
    }

    /// The same store with another wait for the scope lock, so a test of the timeout is quick.
    #[cfg(test)]
    fn with_lock_wait(mut self, wait: Duration) -> Self {
        self.lock_wait = wait;
        self
    }

    /// The scopes another program (Hangar) changed since the last call; the first call names
    /// none. For the poll in `lib.rs`; see `watch.rs`.
    pub fn outside_changes(&self) -> std::collections::BTreeSet<String> {
        self.watch.poll()
    }

    /// Records files this store just wrote or moved away, so the poll does not report them.
    fn own(&self, paths: &[&Path]) {
        for path in paths {
            self.watch.own(path);
        }
    }

    fn lock_scope(&self, dir: &Path) -> Result<ScopeLock, NotesError> {
        lock_scope(dir, self.lock_wait).map_err(io_error(&dir.join(SCOPE_LOCK_FILE)))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn writable(&self) -> bool {
        self.writable.load(Ordering::SeqCst)
    }

    fn check_writable(&self) -> Result<(), NotesError> {
        if self.writable() {
            Ok(())
        } else {
            Err(NotesError::ReadOnly)
        }
    }

    fn read_meta(dir: &Path) -> Option<FolderMeta> {
        let path = dir.join(META_FILE);
        let bytes = match read_limited(&path, MAX_META_BYTES) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => return None,
            Err(reason) => {
                eprintln!("hangar-note: ignoring {}", storage_log(&path, &reason));
                return None;
            }
        };
        match serde_json::from_slice::<FolderMeta>(&bytes) {
            Ok(mut meta) if meta.version == META_VERSION => {
                // An entry pointing elsewhere is dropped; a plain `.md` file of the folder comes
                // back on the next sync under a new ID.
                meta.notes.retain(|n| {
                    plain_markdown_name(&n.file) && check_id(&n.id).is_ok_and(|id| id == n.id)
                });
                Some(meta)
            }
            Ok(_) => {
                eprintln!(
                    "hangar-note: ignoring {}",
                    storage_log(&path, "unknown version")
                );
                None
            }
            Err(error) => {
                let cause = format!("JSON error {:?} on line {}", error.classify(), error.line());
                eprintln!("hangar-note: ignoring {}", storage_log(&path, &cause));
                None
            }
        }
    }

    /// Opens the scope. With `create` it is created; otherwise the result is `None` if it is
    /// missing. An unusable `folder.json` is set aside and rebuilt from the files. Read only,
    /// nothing is created, set aside, locked or saved.
    ///
    /// While writable, `folder.json` is read again under the scope lock before anything is saved
    /// ([`Hold`]): with [`Hold::UntilDone`] the lock stays with the returned folder, so the
    /// caller's change and its save see no write of Hangar in between.
    fn open(
        &self,
        folder: &NoteFolder,
        create: bool,
        hold: Hold,
    ) -> Result<Option<Folder>, NotesError> {
        let key = folder_key(folder)?;
        let dir = self.root.join(&key);
        let writable = self.writable();
        if is_link(&dir) {
            return if create {
                Err(NotesError::InvalidFolder("a link, not a folder"))
            } else {
                Ok(None)
            };
        }
        if !dir.is_dir() {
            if !create || !writable {
                return Ok(None);
            }
            create_private_dir(&dir).map_err(io_error(&dir))?;
        }
        if !writable {
            return Self::load(key, dir, folder, false).map(|(opened, _)| Some(opened));
        }
        if hold == Hold::WhileSyncing {
            let (opened, changed) = Self::load(key.clone(), dir.clone(), folder, false)?;
            if !changed {
                return Ok(Some(opened));
            }
        }
        let held = self.lock_scope(&dir)?;
        let (mut opened, changed) = Self::load(key, dir, folder, true)?;
        if changed {
            opened.save()?;
        }
        if hold == Hold::UntilDone {
            opened._lock = Some(held);
        }
        Ok(Some(opened))
    }

    /// Reads `folder.json` from disk and syncs it with the files. `repair`: an unusable
    /// `folder.json` is set aside (only under the scope lock). Returns whether it needs saving.
    fn load(
        key: String,
        dir: PathBuf,
        folder: &NoteFolder,
        repair: bool,
    ) -> Result<(Folder, bool), NotesError> {
        let meta_path = dir.join(META_FILE);
        let (meta, mut changed) = match Self::read_meta(&dir) {
            Some(meta) => (meta, false),
            None => {
                if repair && meta_path.exists() {
                    let aside = dir.join(format!(
                        "{META_FILE}.broken-{}",
                        millis(SystemTime::now()).unwrap_or(0)
                    ));
                    fs::rename(&meta_path, &aside).map_err(io_error(&meta_path))?;
                }
                let meta = FolderMeta {
                    version: META_VERSION,
                    path: folder.path.clone(),
                    notes: Vec::new(),
                };
                (meta, true)
            }
        };
        let mut opened = Folder {
            key,
            dir,
            meta,
            _lock: None,
        };
        changed |= opened.sync()?;
        Ok((opened, changed))
    }

    fn opened(&self, folder: &NoteFolder) -> Result<Folder, NotesError> {
        self.open(folder, false, Hold::WhileSyncing)?
            .ok_or(NotesError::UnknownNote)
    }

    /// The scope for a change, with its lock held until the folder drops.
    fn opened_for_change(&self, folder: &NoteFolder) -> Result<Folder, NotesError> {
        self.open(folder, false, Hold::UntilDone)?
            .ok_or(NotesError::UnknownNote)
    }

    /// The scope a folder key belongs to: General, or the path its `folder.json` records, if that
    /// path gives the same key again. For reopening sticky notes, which remember only the key.
    pub fn folder_for_key(&self, key: &str) -> Option<NoteFolder> {
        if key == GENERAL_KEY {
            return Some(NoteFolder::general());
        }
        if !is_folder_key(key) {
            return None;
        }
        let _guard = lock(&self.guard);
        let dir = self.root.join(key);
        if !is_plain_dir(&dir) {
            return None;
        }
        let path = Self::read_meta(&dir)?.path?;
        let folder = NoteFolder { path: Some(path) };
        (folder_key(&folder).ok()? == key).then_some(folder)
    }

    /// All scopes with notes; the General area always comes first, even without notes.
    pub fn list_folders(&self) -> Result<Vec<FolderInfo>, NotesError> {
        let _guard = lock(&self.guard);
        let mut general = FolderInfo {
            folder_key: GENERAL_KEY.to_owned(),
            path: None,
            name: None,
            note_count: 0,
            updated_at: None,
        };
        let mut others = Vec::new();
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(vec![general]),
            Err(error) => return Err(io_error(&self.root)(error)),
        };
        for entry in entries.flatten() {
            let Ok(key) = entry.file_name().into_string() else {
                continue;
            };
            let dir = entry.path();
            if !is_folder_key(&key) || !is_plain_dir(&dir) {
                continue;
            }
            // Read only: an overview must not rewrite anything. Without a readable folder.json the
            // original path is unknown; the scope shows up as soon as it is opened again.
            let Some(meta) = Self::read_meta(&dir) else {
                continue;
            };
            let files: Vec<PathBuf> = meta
                .notes
                .iter()
                .map(|n| dir.join(&n.file))
                .filter(|p| p.is_file())
                .collect();
            let info = FolderInfo {
                folder_key: key.clone(),
                name: meta.path.as_deref().map(display_name),
                path: meta.path,
                note_count: files.len(),
                updated_at: files.iter().filter_map(|p| modified(p)).max(),
            };
            if key == GENERAL_KEY {
                general = FolderInfo {
                    path: None,
                    name: None,
                    ..info
                };
            } else if info.note_count > 0 {
                others.push(info);
            }
        }
        others.sort_by_key(|info| std::cmp::Reverse(info.updated_at));
        let mut list = vec![general];
        list.extend(others);
        Ok(list)
    }

    pub fn list_notes(&self, folder: &NoteFolder) -> Result<Vec<NoteInfo>, NotesError> {
        Ok(self
            .list_with_previews(folder, 0)?
            .into_iter()
            .map(|(info, _)| info)
            .collect())
    }

    /// The notes of a scope sorted by their order, each with the first `preview` bytes of its
    /// content (cut at a character), under one lock, for the notes list.
    pub fn list_with_previews(
        &self,
        folder: &NoteFolder,
        preview: usize,
    ) -> Result<Vec<(NoteInfo, String)>, NotesError> {
        let _guard = lock(&self.guard);
        let Some(opened) = self.open(folder, false, Hold::WhileSyncing)? else {
            return Ok(Vec::new());
        };
        let mut notes: Vec<(NoteInfo, String)> = opened
            .meta
            .notes
            .iter()
            .map(|n| {
                let path = opened.file(n);
                let text = if preview == 0 {
                    String::new()
                } else {
                    read_prefix(&path, preview)
                        .map(|bytes| utf8_prefix(&bytes, preview))
                        .unwrap_or_default()
                };
                let info = NoteInfo {
                    id: n.id.clone(),
                    title: n.title.clone(),
                    updated_at: modified(&path),
                    order: n.order,
                };
                (info, text)
            })
            .collect();
        notes.sort_by(|(a, _), (b, _)| a.order.cmp(&b.order).then_with(|| a.title.cmp(&b.title)));
        Ok(notes)
    }

    /// The title of a note.
    pub fn title(&self, folder: &NoteFolder, id: &str) -> Result<String, NotesError> {
        let _guard = lock(&self.guard);
        let opened = self.opened(folder)?;
        Ok(opened.entry(id)?.title.clone())
    }

    pub fn read_note(&self, folder: &NoteFolder, id: &str) -> Result<String, NotesError> {
        self.read_note_versioned(folder, id).map(|(text, _)| text)
    }

    /// The text of a note with the [`version`] of the file it came from, so an editor can tell
    /// later whether something else changed the file meanwhile (security review B8). The version
    /// is taken from the same handle the text was read through.
    pub fn read_note_versioned(
        &self,
        folder: &NoteFolder,
        id: &str,
    ) -> Result<(String, String), NotesError> {
        let _guard = lock(&self.guard);
        let opened = self.opened(folder)?;
        let path = opened.file(opened.entry(id)?);
        let read = read_capped_with_meta(&path, MAX_NOTE_BYTES).map_err(io_error(&path))?;
        let Some((bytes, meta)) = read else {
            // The size only names the problem; the content was never read past the limit.
            let size = fs::metadata(&path)
                .ok()
                .and_then(|m| usize::try_from(m.len()).ok())
                .unwrap_or(MAX_NOTE_BYTES + 1);
            return Err(NotesError::TooLarge {
                size,
                max: MAX_NOTE_BYTES,
            });
        };
        let text = String::from_utf8(bytes).map_err(|_| NotesError::NotText)?;
        Ok((text, version(&meta)))
    }

    pub fn write_note(
        &self,
        folder: &NoteFolder,
        id: &str,
        content: &str,
    ) -> Result<(), NotesError> {
        self.write_note_checked(folder, id, content, None).map(drop)
    }

    /// Writes a note; with `expected`, only while the file is still at that [`version`]
    /// ([`NotesError::Changed`] otherwise, and nothing is written). Returns the version of the
    /// file written. Another program may still write between the check and the rename; the window
    /// for that is the length of one write, where without the check it was the whole edit.
    pub fn write_note_checked(
        &self,
        folder: &NoteFolder,
        id: &str,
        content: &str,
        expected: Option<&str>,
    ) -> Result<String, NotesError> {
        if content.len() > MAX_NOTE_BYTES {
            return Err(NotesError::TooLarge {
                size: content.len(),
                max: MAX_NOTE_BYTES,
            });
        }
        self.check_writable()?;
        let _guard = lock(&self.guard);
        let opened = self.opened(folder)?;
        let path = opened.file(opened.entry(id)?);
        if let Some(expected) = expected {
            let current = handle_meta(&path).map_err(io_error(&path))?;
            if version(&current) != expected {
                return Err(NotesError::Changed);
            }
        }
        // The version comes from the written file's own handle, not from a look at the path after
        // the rename, which could already see a file Hangar saved in between.
        let written = write_atomic_versioned(&path, content.as_bytes()).map_err(io_error(&path))?;
        let written = version(&written);
        self.watch.own_as(&path, Some(written.clone()));
        Ok(written)
    }

    /// Creates an empty note and returns its ID.
    pub fn create_note(&self, folder: &NoteFolder, title: &str) -> Result<String, NotesError> {
        let title = validate_title(title)?;
        self.check_writable()?;
        let _guard = lock(&self.guard);
        let mut opened = self
            .open(folder, true, Hold::UntilDone)?
            .ok_or(NotesError::InvalidFolder("cannot be created"))?;
        let file = create_free_file(&opened.dir, || opened.free_file_name(&title, None))
            .map_err(io_error(&opened.dir))?;
        let path = opened.dir.join(&file);
        let id = new_id();
        let order = opened.next_order();
        opened.meta.notes.push(NoteEntry {
            id: id.clone(),
            title,
            file,
            order,
        });
        opened.save()?;
        self.own(&[&path, &opened.dir.join(META_FILE)]);
        Ok(id)
    }

    /// Creates an empty note titled "`base` N" with the smallest free N; returns ID and title.
    pub fn create_untitled(
        &self,
        folder: &NoteFolder,
        base: &str,
    ) -> Result<(String, String), NotesError> {
        let base = validate_title(base)?;
        let existing: Vec<String> = self
            .list_notes(folder)?
            .into_iter()
            .map(|n| n.title)
            .collect();
        let title = untitled_title(&base, &existing);
        let id = self.create_note(folder, &title)?;
        Ok((id, title))
    }

    /// New title; the file is renamed along with it, the ID stays.
    pub fn rename_note(
        &self,
        folder: &NoteFolder,
        id: &str,
        title: &str,
    ) -> Result<(), NotesError> {
        let title = validate_title(title)?;
        self.check_writable()?;
        let _guard = lock(&self.guard);
        let mut opened = self.opened_for_change(folder)?;
        let entry = opened.entry(id)?.clone();
        let first = opened.free_file_name(&title, Some(&entry.file));
        let file = if first == entry.file {
            first
        } else {
            let from = opened.dir.join(&entry.file);
            let mut pick = Some(first);
            // After a clash the note's own name no longer counts as free: on a case-sensitive
            // file system another file may sit under the new spelling of it.
            move_to_free_name(&from, &opened.dir, || {
                pick.take()
                    .unwrap_or_else(|| opened.free_file_name(&title, None))
            })
            .map_err(io_error(&from))?
        };
        if let Some(note) = opened.meta.notes.iter_mut().find(|n| n.id == entry.id) {
            note.title = title;
            note.file.clone_from(&file);
        }
        opened.save()?;
        self.own(&[
            &opened.dir.join(&entry.file),
            &opened.dir.join(&file),
            &opened.dir.join(META_FILE),
        ]);
        Ok(())
    }

    /// Moves the file to `.trash/`; nothing is ever deleted for good.
    pub fn delete_note(&self, folder: &NoteFolder, id: &str) -> Result<(), NotesError> {
        self.check_writable()?;
        let _guard = lock(&self.guard);
        let mut opened = self.opened_for_change(folder)?;
        let entry = opened.entry(id)?.clone();
        let trash = opened.dir.join(TRASH_DIR);
        if is_link(&trash) {
            return Err(NotesError::InvalidFolder(
                "the trash is a link, not a folder",
            ));
        }
        create_private_dir(&trash).map_err(io_error(&trash))?;
        let stamp = millis(SystemTime::now()).unwrap_or(0);
        // Whatever the file holds now goes to the trash, also a text Hangar saved a moment ago:
        // nothing is lost, and restoring brings that text back.
        let from = opened.file(&entry);
        let wanted = format!("{stamp}-{}", entry.file);
        let file = move_to_free_name(&from, &trash, || free_name(&trash, &wanted))
            .map_err(io_error(&from))?;
        opened.meta.notes.retain(|n| n.id != entry.id);
        opened.save()?;
        // Without the record the file is still adopted by `list_trash`, only under a new ID.
        // Read again here, under the scope lock that `opened` holds.
        let mut items = Self::read_trash(&trash);
        items.push(TrashEntry {
            id: entry.id,
            title: entry.title,
            file,
            deleted_at: Some(stamp),
        });
        if let Err(error) = Self::save_trash(&trash, items) {
            eprintln!("hangar-note: trash record not saved: {error}");
        }
        self.own(&[
            &from,
            &opened.dir.join(META_FILE),
            &trash.join(TRASH_META_FILE),
        ]);
        Ok(())
    }

    /// A record names a plain `.md` file inside `.trash/` and carries a valid ID and title.
    /// `trash.json` is a file on disk like any other: a record pointing elsewhere (`../x.md`) must
    /// never move a foreign file into the notes. A dropped record's file is adopted again by
    /// [`Self::synced_trash`] under a new ID.
    fn trusted_entry(entry: &TrashEntry) -> bool {
        plain_markdown_name(&entry.file)
            && check_id(&entry.id).is_ok_and(|id| id == entry.id)
            && validate_title(&entry.title).is_ok_and(|title| title == entry.title)
    }

    fn read_trash(trash: &Path) -> Vec<TrashEntry> {
        let path = trash.join(TRASH_META_FILE);
        match read_limited(&path, MAX_META_BYTES) {
            Ok(Some(bytes)) => match serde_json::from_slice::<TrashMeta>(&bytes) {
                Ok(meta) if meta.version == TRASH_META_VERSION => {
                    meta.items.into_iter().filter(Self::trusted_entry).collect()
                }
                _ => {
                    eprintln!("hangar-note: ignoring {}", storage_log(&path, "unreadable"));
                    Vec::new()
                }
            },
            Ok(None) => Vec::new(),
            Err(reason) => {
                eprintln!("hangar-note: ignoring {}", storage_log(&path, &reason));
                Vec::new()
            }
        }
    }

    fn save_trash(trash: &Path, items: Vec<TrashEntry>) -> Result<(), NotesError> {
        let path = trash.join(TRASH_META_FILE);
        let meta = TrashMeta {
            version: TRASH_META_VERSION,
            items,
        };
        let json = serde_json::to_vec_pretty(&meta)
            .map_err(|e| io_error(&path)(io::Error::new(io::ErrorKind::InvalidData, e)))?;
        write_atomic(&path, &json).map_err(io_error(&path))
    }

    /// The trash records matched with the files: records without a file are dropped, `.md` files
    /// without a record (deleted before records existed) are adopted under their [`stable_id`].
    /// Returns whether the records differ from `trash.json`; the caller saves under the lock.
    fn synced_trash(key: &str, trash: &Path) -> Result<(Vec<TrashEntry>, bool), NotesError> {
        let mut items = Self::read_trash(trash);
        let before = items.clone();
        items.retain(|item| trash.join(&item.file).is_file());
        let known: HashSet<String> = items.iter().map(|i| i.file.to_lowercase()).collect();
        let mut found: Vec<String> = fs::read_dir(trash)
            .map_err(io_error(trash))?
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|name| is_markdown(name) && !known.contains(&name.to_lowercase()))
            .collect();
        found.sort();
        let scope = format!("{key}/{TRASH_DIR}");
        let mut ids: HashSet<String> = items.iter().map(|item| item.id.clone()).collect();
        for file in found {
            let (title, stamp) = trash_title(&file);
            let deleted_at = stamp.or_else(|| modified(&trash.join(&file)));
            let id = free_stable_id(&scope, &file, &ids);
            ids.insert(id.clone());
            items.push(TrashEntry {
                id,
                title,
                file,
                deleted_at,
            });
        }
        let changed = items != before;
        Ok((items, changed))
    }

    /// Deleted notes of the scope, the most recently deleted first; `[]` without a trash.
    pub fn list_trash(&self, folder: &NoteFolder) -> Result<Vec<TrashInfo>, NotesError> {
        let key = folder_key(folder)?;
        let dir = self.root.join(&key);
        let trash = dir.join(TRASH_DIR);
        let _guard = lock(&self.guard);
        if !is_plain_dir(&dir) || !is_plain_dir(&trash) {
            return Ok(Vec::new());
        }
        let (mut items, changed) = Self::synced_trash(&key, &trash)?;
        if changed && self.writable() {
            // Read again under the scope lock, so a record Hangar added meanwhile stays.
            let _held = self.lock_scope(&dir)?;
            let (fresh, changed) = Self::synced_trash(&key, &trash)?;
            if changed {
                Self::save_trash(&trash, fresh.clone())?;
            }
            items = fresh;
        }
        let mut list: Vec<TrashInfo> = items
            .into_iter()
            .map(|item| TrashInfo {
                id: item.id,
                title: item.title,
                deleted_at: item.deleted_at,
            })
            .collect();
        list.sort_by_key(|item| std::cmp::Reverse(item.deleted_at));
        Ok(list)
    }

    /// Moves a deleted note back to the end of the scope's list and returns its ID: the old one,
    /// unless a note with that ID exists again.
    pub fn restore_note(&self, folder: &NoteFolder, id: &str) -> Result<String, NotesError> {
        let id = check_id(id)?;
        self.check_writable()?;
        let _guard = lock(&self.guard);
        let mut opened = self.opened_for_change(folder)?;
        let trash = opened.dir.join(TRASH_DIR);
        if !is_plain_dir(&trash) {
            return Err(NotesError::UnknownNote);
        }
        let (mut items, _) = Self::synced_trash(&opened.key, &trash)?;
        let index = items
            .iter()
            .position(|item| item.id == id)
            .ok_or(NotesError::UnknownNote)?;
        let item = items.remove(index);
        let from = trash.join(&item.file);
        let file = move_to_free_name(&from, &opened.dir, || {
            opened.free_file_name(&item.title, None)
        })
        .map_err(io_error(&from))?;
        let restored = if opened.meta.notes.iter().any(|n| n.id == item.id) {
            new_id()
        } else {
            item.id
        };
        let order = opened.next_order();
        let path = opened.dir.join(&file);
        opened.meta.notes.push(NoteEntry {
            id: restored.clone(),
            title: item.title,
            file,
            order,
        });
        opened.save()?;
        Self::save_trash(&trash, items)?;
        self.own(&[
            &from,
            &path,
            &opened.dir.join(META_FILE),
            &trash.join(TRASH_META_FILE),
        ]);
        Ok(restored)
    }

    /// Title and content of a note, for exporting it.
    pub fn note_for_export(
        &self,
        folder: &NoteFolder,
        id: &str,
    ) -> Result<(String, String), NotesError> {
        let content = self.read_note(folder, id)?;
        let title = self.title(folder, id)?;
        Ok((title, content))
    }

    /// Full path of the note's file, for showing it in the file manager.
    pub fn note_path(&self, folder: &NoteFolder, id: &str) -> Result<PathBuf, NotesError> {
        let _guard = lock(&self.guard);
        let opened = self.opened(folder)?;
        Ok(opened.file(opened.entry(id)?))
    }

    /// Case-insensitive substring search in titles and contents of all scopes, read only (no
    /// folder is synced or rewritten). Files above [`MAX_NOTE_BYTES`] or not UTF-8 are skipped.
    /// Title hits come first, then by modification time, newest first.
    pub fn search(&self, query: &str) -> Result<Vec<SearchHit>, NotesError> {
        let Some(query) = validate_query(query)? else {
            return Ok(Vec::new());
        };
        // Only the metadata is read under the lock; the files are read afterwards, so a long
        // search never blocks saving a note.
        let scopes = {
            let _guard = lock(&self.guard);
            let entries = match fs::read_dir(&self.root) {
                Ok(entries) => entries,
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
                Err(error) => return Err(io_error(&self.root)(error)),
            };
            let mut keys: Vec<String> = entries
                .flatten()
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|key| is_folder_key(key))
                .collect();
            keys.sort();
            keys.into_iter()
                .filter_map(|key| {
                    let dir = self.root.join(&key);
                    if !is_plain_dir(&dir) {
                        return None;
                    }
                    let meta = Self::read_meta(&dir)?;
                    let path = if key == GENERAL_KEY { None } else { meta.path };
                    Some((key, dir, path, meta.notes))
                })
                .collect::<Vec<_>>()
        };
        let mut hits: Vec<(bool, SearchHit)> = Vec::new();
        let mut files = 0usize;
        let mut budget = MAX_SEARCH_BYTES;
        'scopes: for (key, dir, path, notes) in scopes {
            for note in notes {
                if files >= MAX_SEARCH_FILES || budget == 0 {
                    break 'scopes;
                }
                files += 1;
                let file = dir.join(&note.file);
                let Ok(Some(bytes)) = read_capped(&file, MAX_NOTE_BYTES.min(budget)) else {
                    continue;
                };
                budget -= bytes.len();
                let Ok(content) = String::from_utf8(bytes) else {
                    continue;
                };
                let in_title = note.title.to_lowercase().contains(&query);
                if !in_title && !content.to_lowercase().contains(&query) {
                    continue;
                }
                hits.push((
                    in_title,
                    SearchHit {
                        folder_key: key.clone(),
                        path: path.clone(),
                        id: note.id,
                        title: note.title,
                        excerpt: excerpt(&content, &query),
                        updated_at: modified(&file),
                    },
                ));
            }
        }
        hits.sort_by(|(a_title, a), (b_title, b)| {
            b_title
                .cmp(a_title)
                .then_with(|| b.updated_at.cmp(&a.updated_at))
        });
        Ok(hits
            .into_iter()
            .take(MAX_SEARCH_RESULTS)
            .map(|(_, hit)| hit)
            .collect())
    }

    /// Folder of the scope, for opening it in the file manager: created if needed while the store
    /// may write; read only, the scope's folder if it exists, else the notes root.
    pub fn folder_dir(&self, folder: &NoteFolder) -> Result<PathBuf, NotesError> {
        let _guard = lock(&self.guard);
        if !self.writable() {
            let dir = self.root.join(folder_key(folder)?);
            return Ok(if is_plain_dir(&dir) {
                dir
            } else {
                self.root.clone()
            });
        }
        let opened = self
            .open(folder, true, Hold::WhileSyncing)?
            .ok_or(NotesError::InvalidFolder("cannot be created"))?;
        Ok(opened.dir.clone())
    }

    /// One-time move from the German folder names (`allgemein/`, `.papierkorb/`) to the current
    /// ones, exactly as Hangar does it on startup; idempotent. Every step is a rename within the
    /// notes folder, nothing is overwritten, and only folders that are empty afterwards are
    /// removed. Errors are logged and never stop the app. Does nothing while read only.
    pub fn migrate_legacy_layout(&self) {
        if !self.writable() {
            return;
        }
        let _guard = lock(&self.guard);
        let Ok(entries) = fs::read_dir(&self.root) else {
            return;
        };
        let dirs: Vec<PathBuf> = entries
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_str()
                    .is_some_and(|n| is_folder_key(n) || n == LEGACY_GENERAL_KEY)
            })
            .map(|e| e.path())
            .filter(|p| is_plain_dir(p))
            .collect();
        // Trash first, so that merging the General area below already finds `.trash` on both sides.
        for dir in dirs {
            let old = dir.join(LEGACY_TRASH_DIR);
            if let Err(error) = move_dir(&old, &dir.join(TRASH_DIR)) {
                log_migration_error(&old, &error);
            }
        }
        let old = self.root.join(LEGACY_GENERAL_KEY);
        if let Err(error) = migrate_general(&old, &self.root.join(GENERAL_KEY)) {
            log_migration_error(&old, &error);
        }
    }
}

#[cfg(test)]
mod tests {
    //! Hangar's tests of `notes.rs`, ported (the cases and expected values unchanged), plus the
    //! read-only mode and the byte format.
    use super::*;

    struct TempNotes(NotesStore, crate::test_support::TempDir);

    impl TempNotes {
        fn new(name: &str) -> Self {
            let dir = crate::test_support::TempDir::new(&format!("notes-{name}"));
            let store = NotesStore::new(&dir.path().join("notes"), Arc::new(AtomicBool::new(true)));
            Self(store, dir)
        }

        fn read_only(&self) -> NotesStore {
            NotesStore::new(self.0.root(), Arc::new(AtomicBool::new(false)))
        }
    }

    fn project() -> NoteFolder {
        let path = if cfg!(windows) {
            r"C:\Users\Test User\Project"
        } else {
            "/home/test/Project"
        };
        NoteFolder::at(path)
    }

    fn general() -> NoteFolder {
        NoteFolder::general()
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    /// Every file below `dir` with its bytes, to prove that nothing changed.
    fn snapshot(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut all = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(next) = stack.pop() {
            for entry in fs::read_dir(&next).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else {
                    all.push((path.clone(), fs::read(&path).unwrap()));
                }
            }
        }
        all.sort();
        all
    }

    #[test]
    fn folder_key_is_stable_and_normalized() {
        assert_eq!(folder_key(&general()).unwrap(), GENERAL_KEY);
        let key = folder_key(&project()).unwrap();
        assert_eq!(key.len(), 32);
        assert!(key.bytes().all(|b| b.is_ascii_hexdigit()));
        let same = |p: &str| folder_key(&NoteFolder::at(p)).unwrap();
        if cfg!(windows) {
            let base = same(r"C:\Users\Test User\Project");
            for variant in [
                r"c:\users\test user\project",
                r"C:\Users\Test User\Project\",
                "C:/Users/Test User/Project",
                r"C:\Users\.\Test User\\Project",
                r"\\?\C:\Users\Test User\Project",
            ] {
                assert_eq!(same(variant), base, "{variant}");
            }
            assert_ne!(same(r"C:\Users\Test User\Project2"), base);
            assert_ne!(same(r"D:\Users\Test User\Project"), base);
            assert_eq!(same(r"\\Server\Share\x"), same(r"\\?\UNC\server\share\X"));
            // Known value, computed independently (Python hashlib): SHA-256 of "c:\x", 16 bytes.
            assert_eq!(same(r"C:\x"), "6e6ef9e1f001ea8d5164e716aaf511bf");
        } else {
            let base = same("/home/test/Project");
            assert_eq!(same("/home/test/Project/"), base);
            assert_eq!(same("/home//test/./Project"), base);
            // Unix is case-sensitive.
            assert_ne!(same("/home/test/project"), base);
        }
        // Known value: the key must never change between versions.
        let fixed = if cfg!(windows) { r"C:\x" } else { "/x" };
        let expected: String = Sha256::digest(normalize_path(Path::new(fixed)).as_bytes())
            .iter()
            .take(16)
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(same(fixed), expected);
        assert_eq!(
            normalize_path(Path::new(fixed)),
            if cfg!(windows) { r"c:\x" } else { "/x" }
        );
        for bad in ["", "relative\\folder", "relative/folder"] {
            assert!(matches!(
                folder_key(&NoteFolder::at(bad)),
                Err(NotesError::InvalidFolder(_))
            ));
        }
    }

    #[test]
    fn titles_become_safe_file_names() {
        assert_eq!(file_stem("Ideas"), "Ideas");
        assert_eq!(file_stem("a/b\\c:d*e?f\"g<h>i|j"), "a_b_c_d_e_f_g_h_i_j");
        assert_eq!(file_stem("../../etc/passwd"), "_.._.._etc_passwd");
        assert_eq!(file_stem("..."), FALLBACK_STEM);
        assert_eq!(file_stem("End. . "), "End");
        assert_eq!(file_stem(".hidden"), "_.hidden");
        assert_eq!(file_stem("CON"), "_CON");
        assert_eq!(file_stem("nul.txt"), "_nul.txt");
        assert_eq!(file_stem("Com1 "), "_Com1");
        assert_eq!(file_stem("CONSOLE"), "CONSOLE");
        assert_eq!(file_stem("line\ttwo"), "line_two");
        assert_eq!(file_stem(&"ä".repeat(300)).chars().count(), MAX_STEM_CHARS);
        assert_eq!(file_stem("Café äöü 😀"), "Café äöü 😀");
        assert!(validate_title("  ").is_err());
        assert!(validate_title("a\nb").is_err());
        assert!(validate_title(&"x".repeat(MAX_TITLE_CHARS + 1)).is_err());
        assert_eq!(validate_title("  Title ").unwrap(), "Title");
    }

    /// One naming rule for notes and export (security review L2): invisible characters never
    /// reach a file name or a new title, and every name Windows reserves for a device gets a `_`
    /// in front, superscript digits and the console names included.
    #[test]
    fn names_follow_the_shared_rule() {
        for (title, stem) in [
            ("a\u{202E}dm", "adm"),
            ("\u{200B}CON", "_CON"),
            ("Plan\u{FEFF}\u{2066}", "Plan"),
            ("\u{200B}\u{200D}", FALLBACK_STEM),
            ("COM\u{B9}", "_COM\u{B9}"),
            ("com\u{B2}.txt", "_com\u{B2}.txt"),
            ("LPT\u{B3}. .", "_LPT\u{B3}"),
            ("conin$", "_conin$"),
            ("CONOUT$ .log", "_CONOUT$ .log"),
            ("CONOUT$x", "CONOUT$x"),
            ("COM\u{B9}0", "COM\u{B9}0"),
        ] {
            assert_eq!(file_stem(title), stem, "{title:?}");
        }
        // A new title loses its invisible characters the way it loses its outer white space;
        // nothing left is no title.
        assert_eq!(validate_title(" a\u{202E}b\u{200B} ").unwrap(), "ab");
        assert!(validate_title("\u{200B}\u{FEFF}").is_err());
        // An emoji sequence is a title and a file name of its own, not three loose emoji.
        let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
        assert_eq!(validate_title(family).unwrap(), family);
        assert_eq!(file_stem(&format!("{family}\u{202E}")), family);
        assert_eq!(file_stem("ad\u{200D}min"), "admin");
        // A cut at the length limit never leaves a joiner at the end of the name.
        let start = "a".repeat(MAX_STEM_CHARS - 2);
        let cut = format!("{start}\u{1F468}\u{200D}\u{1F4BB}");
        assert_eq!(file_stem(&cut), format!("{start}\u{1F468}"));
        assert_eq!(validate_title("COM\u{B9}").unwrap(), "COM\u{B9}");
    }

    /// A file Hangar wrote under a name the rule would never create stays listed and readable;
    /// only the title shown drops the invisible characters.
    #[test]
    fn existing_files_with_invisible_names_stay_readable() {
        let t = TempNotes::new("invisible");
        let folder = project();
        t.0.create_note(&folder, "own").unwrap();
        let dir = t.0.root().join(folder_key(&folder).unwrap());
        let name = "a\u{200B}b\u{202E}c.md";
        fs::write(dir.join(name), "marker-kept-81e").unwrap();
        let notes = t.0.list_notes(&folder).unwrap();
        let adopted = notes.iter().find(|n| n.title == "abc").unwrap();
        assert_eq!(
            t.0.read_note(&folder, &adopted.id).unwrap(),
            "marker-kept-81e"
        );
        assert!(dir.join(name).is_file());
        // Renaming it gives a file name without them.
        t.0.rename_note(&folder, &adopted.id, "x\u{200B}y").unwrap();
        assert!(dir.join("xy.md").is_file());
        assert!(!dir.join(name).exists());
    }

    #[test]
    fn untitled_titles_take_the_smallest_free_number() {
        let existing = vec![
            "Notiz 1".to_owned(),
            "notiz 3".to_owned(),
            "Plan".to_owned(),
        ];
        assert_eq!(untitled_title("Notiz", &existing), "Notiz 2");
        assert_eq!(untitled_title("Note", &[]), "Note 1");
    }

    #[test]
    fn create_write_read_rename_delete() {
        let t = TempNotes::new("crud");
        let folder = project();
        assert!(t.0.list_notes(&folder).unwrap().is_empty());
        let id = t.0.create_note(&folder, "Ideas").unwrap();
        assert!(check_id(&id).is_ok());
        let text = "# Ideas\n\n- äöü 😀\r\n";
        t.0.write_note(&folder, &id, text).unwrap();
        assert_eq!(t.0.read_note(&folder, &id).unwrap(), text);

        let dir = t.0.root().join(folder_key(&folder).unwrap());
        assert_eq!(fs::read_to_string(dir.join("Ideas.md")).unwrap(), text);

        // The same title gets its own file name, even with different casing.
        let second = t.0.create_note(&folder, "ideas").unwrap();
        assert!(dir.join("ideas (2).md").is_file());

        t.0.rename_note(&folder, &id, "Plan: Q4/2026").unwrap();
        assert!(!dir.join("Ideas.md").exists());
        assert!(dir.join("Plan_ Q4_2026.md").is_file());
        assert_eq!(t.0.read_note(&folder, &id).unwrap(), text);
        // Changing only the case works on Windows as well.
        t.0.rename_note(&folder, &second, "IDEAS (2)").unwrap();

        let notes = t.0.list_notes(&folder).unwrap();
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[0].id, id);
        assert_eq!(notes[0].title, "Plan: Q4/2026");
        assert_eq!(notes[1].title, "IDEAS (2)");
        assert!(notes[0].updated_at.is_some());

        t.0.delete_note(&folder, &id).unwrap();
        assert!(matches!(
            t.0.read_note(&folder, &id),
            Err(NotesError::UnknownNote)
        ));
        let trash: Vec<_> = names(&dir.join(TRASH_DIR))
            .into_iter()
            .filter(|name| name != TRASH_META_FILE)
            .collect();
        assert_eq!(trash.len(), 1);
        assert!(trash[0].ends_with("-Plan_ Q4_2026.md"));
        // The trash does not show up as a note.
        assert_eq!(t.0.list_notes(&folder).unwrap().len(), 1);
    }

    #[test]
    fn the_files_are_byte_for_byte_hangars_format() {
        let t = TempNotes::new("format");
        let folder = project();
        let id = t.0.create_note(&folder, "Plan").unwrap();
        let dir = t.0.root().join(folder_key(&folder).unwrap());
        let path = serde_json::to_string(folder.path.as_ref().unwrap()).unwrap();
        let expected = format!(
            "{{\n  \"version\": 1,\n  \"path\": {path},\n  \"notes\": [\n    {{\n      \"id\": \"{id}\",\n      \"title\": \"Plan\",\n      \"file\": \"Plan.md\",\n      \"order\": 0\n    }}\n  ]\n}}"
        );
        assert_eq!(fs::read_to_string(dir.join(META_FILE)).unwrap(), expected);
        t.0.delete_note(&folder, &id).unwrap();
        let trash: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.join(TRASH_DIR).join(TRASH_META_FILE)).unwrap())
                .unwrap();
        let item = &trash["items"][0];
        let mut fields: Vec<&str> = item
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        fields.sort_unstable();
        assert_eq!(fields, ["deletedAt", "file", "id", "title"]);
        assert_eq!(trash["version"], 1);
        // The General area records `null` as its path.
        t.0.create_note(&general(), "x").unwrap();
        let general_meta: serde_json::Value = serde_json::from_slice(
            &fs::read(t.0.root().join(GENERAL_KEY).join(META_FILE)).unwrap(),
        )
        .unwrap();
        assert!(general_meta["path"].is_null());
    }

    #[test]
    fn an_unknown_field_is_hangars_rejection_too() {
        let t = TempNotes::new("unknown-field");
        let id = t.0.create_note(&general(), "a").unwrap();
        let path = t.0.root().join(GENERAL_KEY).join(META_FILE);
        let mut meta: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        meta["notes"][0]["color"] = "mint".into();
        fs::write(&path, meta.to_string()).unwrap();
        // Like Hangar: the metadata is set aside and the note adopted again under a new ID.
        let notes = t.0.list_notes(&general()).unwrap();
        assert_eq!(notes.len(), 1);
        assert_ne!(notes[0].id, id);
    }

    #[test]
    fn limits_and_errors() {
        let t = TempNotes::new("limits");
        let folder = general();
        let id = t.0.create_note(&folder, "a").unwrap();
        let max = "x".repeat(MAX_NOTE_BYTES);
        t.0.write_note(&folder, &id, &max).unwrap();
        assert!(matches!(
            t.0.write_note(&folder, &id, &format!("{max}x")),
            Err(NotesError::TooLarge { .. })
        ));
        assert_eq!(t.0.read_note(&folder, &id).unwrap().len(), MAX_NOTE_BYTES);
        for bad in ["", "../folder", "x"] {
            assert!(matches!(
                t.0.read_note(&folder, bad),
                Err(NotesError::InvalidId)
            ));
        }
        let unknown = new_id();
        assert!(matches!(
            t.0.write_note(&folder, &unknown, "x"),
            Err(NotesError::UnknownNote)
        ));
        // Scope without notes: reading reports "not found", listing returns nothing.
        assert!(t.0.list_notes(&project()).unwrap().is_empty());
        assert!(matches!(
            t.0.read_note(&project(), &unknown),
            Err(NotesError::UnknownNote)
        ));
        assert!(matches!(
            t.0.create_note(&folder, " "),
            Err(NotesError::InvalidTitle(_))
        ));
        // Error texts never contain the content.
        let secret = "marker-secret-71b";
        let error =
            t.0.write_note(&folder, &id, &format!("{secret}{max}"))
                .unwrap_err();
        assert!(!error.to_string().contains(secret));
    }

    #[test]
    fn sync_with_files_added_from_outside() {
        let t = TempNotes::new("sync");
        let folder = project();
        let id = t.0.create_note(&folder, "own").unwrap();
        let dir = t.0.root().join(folder_key(&folder).unwrap());
        fs::write(dir.join("From outside.md"), "hello").unwrap();
        fs::write(dir.join("not-markdown.txt"), "x").unwrap();
        fs::remove_file(dir.join("own.md")).unwrap();
        let notes = t.0.list_notes(&folder).unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].title, "From outside");
        assert_ne!(notes[0].id, id);
        // The adopted ID stays stable.
        assert_eq!(t.0.list_notes(&folder).unwrap()[0].id, notes[0].id);
        assert_eq!(t.0.read_note(&folder, &notes[0].id).unwrap(), "hello");
    }

    /// A target that appears between the free-name check and the rename is never replaced: the
    /// move takes the next free name (security review L3).
    #[test]
    fn a_name_taken_during_the_move_is_skipped() {
        let t = TempNotes::new("race");
        let dir = t.1.path().join("race");
        fs::create_dir_all(&dir).unwrap();
        let from = dir.join("source.md");
        fs::write(&from, "marker-source-a17").unwrap();
        let mut picks = 0;
        let moved = move_to_free_name(&from, &dir, || {
            picks += 1;
            if picks == 1 {
                // Someone else writes the name right after it was found free.
                fs::write(dir.join("x.md"), "marker-other-3c5").unwrap();
                "x.md".to_owned()
            } else {
                free_name(&dir, "x.md")
            }
        })
        .unwrap();
        assert_eq!(moved, "x (2).md");
        assert_eq!(picks, 2);
        assert_eq!(
            fs::read_to_string(dir.join("x.md")).unwrap(),
            "marker-other-3c5"
        );
        assert_eq!(
            fs::read_to_string(dir.join("x (2).md")).unwrap(),
            "marker-source-a17"
        );
        // Bounded: a name that is always taken ends in an error, with the source untouched.
        fs::write(&from, "marker-source-a17").unwrap();
        let error = move_to_free_name(&from, &dir, || "x.md".to_owned()).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(&from).unwrap(), "marker-source-a17");
        assert_eq!(
            fs::read_to_string(dir.join("x.md")).unwrap(),
            "marker-other-3c5"
        );
    }

    /// Rename, delete and restore go through the move that never replaces and still carry the
    /// note's text.
    #[test]
    fn rename_delete_and_restore_still_move_the_file() {
        let t = TempNotes::new("noreplace");
        let folder = project();
        let id = t.0.create_note(&folder, "first").unwrap();
        t.0.write_note(&folder, &id, "marker-first-77a").unwrap();
        let dir = t.0.root().join(folder_key(&folder).unwrap());
        t.0.rename_note(&folder, &id, "Plan").unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("Plan.md")).unwrap(),
            "marker-first-77a"
        );
        t.0.delete_note(&folder, &id).unwrap();
        let restored = t.0.restore_note(&folder, &id).unwrap();
        assert_eq!(
            t.0.read_note(&folder, &restored).unwrap(),
            "marker-first-77a"
        );
    }

    #[test]
    fn broken_metadata_loses_no_notes() {
        let t = TempNotes::new("broken");
        let folder = project();
        let id = t.0.create_note(&folder, "important").unwrap();
        t.0.write_note(&folder, &id, "content").unwrap();
        let dir = t.0.root().join(folder_key(&folder).unwrap());
        fs::write(dir.join(META_FILE), "{ broken").unwrap();
        let notes = t.0.list_notes(&folder).unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].title, "important");
        assert_eq!(t.0.read_note(&folder, &notes[0].id).unwrap(), "content");
        assert!(names(&dir)
            .iter()
            .any(|n| n.starts_with("folder.json.broken-")));
    }

    #[test]
    fn folder_overview() {
        let t = TempNotes::new("folders");
        let list = t.0.list_folders().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].folder_key, GENERAL_KEY);
        assert_eq!(list[0].path, None);
        assert_eq!(list[0].note_count, 0);

        t.0.create_note(&project(), "x").unwrap();
        t.0.create_note(&project(), "y").unwrap();
        t.0.create_note(&general(), "z").unwrap();
        // A scope without notes does not show up.
        let empty = NoteFolder::at(t.1.path().join("empty"));
        let gone = t.0.create_note(&empty, "gone").unwrap();
        t.0.delete_note(&empty, &gone).unwrap();

        let list = t.0.list_folders().unwrap();
        assert_eq!(list.len(), 2, "{list:?}");
        assert_eq!(list[0].folder_key, GENERAL_KEY);
        assert_eq!(list[0].note_count, 1);
        assert_eq!(list[1].path, project().path);
        assert_eq!(list[1].name.as_deref(), Some("Project"));
        assert_eq!(list[0].name, None);
        assert_eq!(list[1].note_count, 2);
        assert!(list[1].updated_at.is_some());
        let json = serde_json::to_value(&list[1]).unwrap();
        assert!(json["folderKey"].is_string());
        assert_eq!(json["name"], "Project");
        assert!(json["noteCount"].is_number());
        assert!(json.get("updatedAt").is_some());
        assert!(serde_json::to_value(&list[0]).unwrap()["name"].is_null());
        // The key of a scope leads back to its folder.
        assert_eq!(t.0.folder_for_key(&list[1].folder_key), Some(project()));
        assert_eq!(t.0.folder_for_key(GENERAL_KEY), Some(general()));
        assert_eq!(t.0.folder_for_key("../x"), None);
    }

    #[test]
    fn a_scope_is_named_after_its_folder() {
        let (project, root) = if cfg!(windows) {
            (r"C:\Users\Test User\My Project", r"C:\")
        } else {
            ("/home/test/My Project", "/")
        };
        assert_eq!(display_name(Path::new(project)), "My Project");
        assert_eq!(display_name(Path::new(root)), root);
    }

    // Contract "notes-shared 1" (ADR 0005): Hangar writes the same folder at the same time.

    /// What Hangar does under the contract: takes the scope lock, reads `folder.json`, changes it
    /// and writes it back. Here it holds the lock for a while in between.
    fn hangar_adds_an_entry(
        dir: &Path,
        file: &str,
        hold: Duration,
        locked: Option<std::sync::mpsc::Sender<()>>,
    ) {
        let _held = lock_scope(dir, SCOPE_LOCK_WAIT).unwrap();
        let path = dir.join(META_FILE);
        let mut meta: FolderMeta = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        if let Some(locked) = locked {
            locked.send(()).unwrap();
        }
        std::thread::sleep(hold);
        fs::write(dir.join(file), "from Hangar").unwrap();
        let order = meta.notes.iter().map(|n| n.order + 1).max().unwrap_or(0);
        meta.notes.push(NoteEntry {
            id: new_id(),
            title: file.trim_end_matches(".md").to_owned(),
            file: file.to_owned(),
            order,
        });
        write_atomic(&path, &serde_json::to_vec_pretty(&meta).unwrap()).unwrap();
    }

    #[test]
    fn a_change_waits_for_hangars_lock_and_keeps_its_entry() {
        let t = TempNotes::new("shared-wait");
        t.0.create_note(&project(), "First").unwrap();
        let dir = t.0.root().join(folder_key(&project()).unwrap());
        let (taken, wait_taken) = std::sync::mpsc::channel();
        let hangar = {
            let dir = dir.clone();
            std::thread::spawn(move || {
                hangar_adds_an_entry(
                    &dir,
                    "From Hangar.md",
                    Duration::from_millis(300),
                    Some(taken),
                );
            })
        };
        // Hangar holds the lock and has read folder.json; this change must wait and read again.
        wait_taken.recv().unwrap();
        let started = Instant::now();
        let second = t.0.create_note(&project(), "Second").unwrap();
        hangar.join().unwrap();
        let notes = t.0.list_notes(&project()).unwrap();
        let titles: Vec<&str> = notes.iter().map(|n| n.title.as_str()).collect();
        assert_eq!(titles, ["First", "From Hangar", "Second"], "no entry lost");
        // The entry itself survived, not only its file (which would come back under a new ID).
        assert_eq!(notes[2].id, second);
        assert!(started.elapsed() >= Duration::from_millis(100), "it waited");
        assert!(dir.join(SCOPE_LOCK_FILE).is_file());
    }

    /// Two writers, each with a store of its own (as two programs), change the same scope at the
    /// same time: the scope lock serialises them, so no entry is lost.
    #[test]
    fn the_scope_lock_serialises_two_writers() {
        let t = TempNotes::new("shared-two");
        t.0.create_note(&project(), "Start").unwrap();
        let other = NotesStore::new(t.0.root(), Arc::new(AtomicBool::new(true)));
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let writers: Vec<_> = [("a", t.0.clone()), ("b", other)]
            .into_iter()
            .map(|(name, store)| {
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    for n in 0..15 {
                        let id = store
                            .create_note(&project(), &format!("{name} {n}"))
                            .unwrap();
                        if n % 5 == 0 {
                            store
                                .rename_note(&project(), &id, &format!("{name} {n} renamed"))
                                .unwrap();
                        }
                    }
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }
        let notes = t.0.list_notes(&project()).unwrap();
        assert_eq!(notes.len(), 31, "{notes:?}");
        let dir = t.0.root().join(folder_key(&project()).unwrap());
        let files = names(&dir).into_iter().filter(|n| is_markdown(n)).count();
        assert_eq!(files, 31, "every file has its entry");
        for name in ["a", "b"] {
            assert!(notes
                .iter()
                .any(|n| n.title == format!("{name} 10 renamed")));
        }
    }

    #[test]
    fn a_held_lock_ends_in_a_storage_error_after_the_wait() {
        let t = TempNotes::new("shared-timeout");
        let id = t.0.create_note(&project(), "Kept").unwrap();
        let dir = t.0.root().join(folder_key(&project()).unwrap());
        let before = fs::read(dir.join(META_FILE)).unwrap();
        let quick = t.0.clone().with_lock_wait(Duration::from_millis(150));
        let held = lock_scope(&dir, SCOPE_LOCK_WAIT).unwrap();

        let started = Instant::now();
        let refused = quick.create_note(&project(), "New").unwrap_err();
        assert!(started.elapsed() >= Duration::from_millis(150));
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(refused.code(), "io", "{refused}");
        assert!(matches!(
            &refused,
            NotesError::Io { source, .. } if source.kind() == io::ErrorKind::TimedOut
        ));
        assert_eq!(
            quick
                .rename_note(&project(), &id, "Other")
                .unwrap_err()
                .code(),
            "io"
        );
        assert_eq!(quick.delete_note(&project(), &id).unwrap_err().code(), "io");
        // Reading needs no lock, and writing the text of a note does not either.
        assert_eq!(quick.list_notes(&project()).unwrap().len(), 1);
        quick.write_note(&project(), &id, "text").unwrap();
        assert_eq!(fs::read(dir.join(META_FILE)).unwrap(), before);
        assert!(!dir.join("New.md").exists());

        drop(held);
        quick.create_note(&project(), "New").unwrap();
    }

    #[test]
    fn a_read_only_store_takes_no_scope_lock() {
        let t = TempNotes::new("shared-read-only");
        t.0.create_note(&project(), "x").unwrap();
        let dir = t.0.root().join(folder_key(&project()).unwrap());
        fs::remove_file(dir.join(SCOPE_LOCK_FILE)).unwrap();
        // A file without an entry would make a writable store save.
        fs::write(dir.join("from outside.md"), "y").unwrap();
        assert_eq!(t.read_only().list_notes(&project()).unwrap().len(), 2);
        assert!(!dir.join(SCOPE_LOCK_FILE).exists());
    }

    #[test]
    fn a_write_with_a_stale_version_is_refused() {
        let t = TempNotes::new("shared-stale");
        let id = t.0.create_note(&project(), "Note").unwrap();
        let (_, read) = t.0.read_note_versioned(&project(), &id).unwrap();
        let path = t.0.note_path(&project(), &id).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        fs::write(&path, "Hangar's text").unwrap();
        let refused = t.0.write_note_checked(&project(), &id, "mine", Some(&read));
        assert!(matches!(refused, Err(NotesError::Changed)));
        assert_eq!(fs::read_to_string(&path).unwrap(), "Hangar's text");
        let (_, fresh) = t.0.read_note_versioned(&project(), &id).unwrap();
        t.0.write_note_checked(&project(), &id, "mine", Some(&fresh))
            .unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "mine");
    }

    /// The version a write returns is the one of the file it wrote, taken before the rename, and
    /// it is what a look at the file right afterwards gives too.
    #[test]
    fn a_write_returns_the_version_of_the_file_it_wrote() {
        let t = TempNotes::new("shared-written-version");
        let id = t.0.create_note(&project(), "Note").unwrap();
        let path = t.0.note_path(&project(), &id).unwrap();
        let mut expected = None;
        for text in ["first", "second, longer", ""] {
            let written =
                t.0.write_note_checked(&project(), &id, text, expected.as_deref())
                    .unwrap();
            assert_eq!(written, version(&handle_meta(&path).unwrap()), "{text:?}");
            let (read_text, read) = t.0.read_note_versioned(&project(), &id).unwrap();
            assert_eq!(
                (read_text.as_str(), read.as_str()),
                (text, written.as_str())
            );
            expected = Some(written);
        }
        // Its own write is no news for the poll.
        assert!(t.0.outside_changes().is_empty());
    }

    #[test]
    fn a_new_note_never_replaces_a_file_that_appeared() {
        let t = TempNotes::new("shared-create");
        let dir = t.1.path().join("scope");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("Taken.md"), "Hangar's note").unwrap();
        let mut picks = vec!["Free.md".to_owned(), "Taken.md".to_owned()];
        let made = create_free_file(&dir, || picks.pop().unwrap()).unwrap();
        assert_eq!(made, "Free.md");
        assert_eq!(
            fs::read_to_string(dir.join("Taken.md")).unwrap(),
            "Hangar's note"
        );
        assert_eq!(fs::read(dir.join("Free.md")).unwrap(), b"");
    }

    #[test]
    fn a_delete_moves_the_text_hangar_saved_last() {
        let t = TempNotes::new("shared-delete");
        let id = t.0.create_note(&project(), "Note").unwrap();
        let path = t.0.note_path(&project(), &id).unwrap();
        fs::write(&path, "saved by Hangar a moment ago").unwrap();
        t.0.delete_note(&project(), &id).unwrap();
        let restored = t.0.restore_note(&project(), &id).unwrap();
        assert_eq!(
            t.0.read_note(&project(), &restored).unwrap(),
            "saved by Hangar a moment ago"
        );
    }

    #[test]
    fn hangars_changes_are_seen_and_own_changes_are_not() {
        let t = TempNotes::new("shared-watch");
        let id = t.0.create_note(&project(), "Note").unwrap();
        let key = folder_key(&project()).unwrap();
        let dir = t.0.root().join(&key);
        assert!(
            t.0.outside_changes().is_empty(),
            "the first look names nothing"
        );

        // Own changes: a write, a new note, a rename, a delete and a restore.
        t.0.write_note(&project(), &id, "typed here").unwrap();
        let other = t.0.create_note(&project(), "Other").unwrap();
        t.0.rename_note(&project(), &other, "Renamed").unwrap();
        t.0.delete_note(&project(), &other).unwrap();
        t.0.restore_note(&project(), &other).unwrap();
        assert!(t.0.outside_changes().is_empty());

        // Hangar edits a note.
        std::thread::sleep(Duration::from_millis(20));
        fs::write(dir.join("Note.md"), "typed in Hangar").unwrap();
        assert_eq!(t.0.outside_changes(), [key.clone()].into());
        // Hangar adds a note with its entry, under the lock.
        hangar_adds_an_entry(&dir, "Hangar's.md", Duration::ZERO, None);
        assert_eq!(t.0.outside_changes(), [key.clone()].into());
        // Hangar writes into General.
        let general_dir = t.0.root().join(GENERAL_KEY);
        fs::create_dir_all(&general_dir).unwrap();
        fs::write(general_dir.join("Quick.md"), "x").unwrap();
        assert_eq!(t.0.outside_changes(), [GENERAL_KEY.to_owned()].into());
        assert!(t.0.outside_changes().is_empty());
    }

    /// Turns the current layout into the one written before the English folder names.
    fn make_legacy(root: &Path) {
        for entry in fs::read_dir(root).unwrap() {
            let dir = entry.unwrap().path();
            if dir.join(TRASH_DIR).is_dir() {
                fs::rename(dir.join(TRASH_DIR), dir.join(LEGACY_TRASH_DIR)).unwrap();
            }
        }
        fs::rename(root.join(GENERAL_KEY), root.join(LEGACY_GENERAL_KEY)).unwrap();
    }

    #[test]
    fn migration_on_fresh_install_changes_nothing() {
        let t = TempNotes::new("migrate-fresh");
        t.0.migrate_legacy_layout();
        assert!(!t.0.root().exists());
        let id = t.0.create_note(&general(), "x").unwrap();
        t.0.migrate_legacy_layout();
        assert_eq!(names(t.0.root()), [GENERAL_KEY]);
        assert_eq!(t.0.list_notes(&general()).unwrap()[0].id, id);
    }

    #[test]
    fn migration_moves_the_old_layout() {
        let t = TempNotes::new("migrate-old");
        let id = t.0.create_note(&general(), "Plan: Q4/2026").unwrap();
        t.0.write_note(&general(), &id, "content").unwrap();
        let gone = t.0.create_note(&general(), "gone").unwrap();
        t.0.delete_note(&general(), &gone).unwrap();
        let project_id = t.0.create_note(&project(), "p").unwrap();
        let gone = t.0.create_note(&project(), "q").unwrap();
        t.0.delete_note(&project(), &gone).unwrap();
        make_legacy(t.0.root());
        let project_key = folder_key(&project()).unwrap();
        assert!(t.0.root().join(LEGACY_GENERAL_KEY).is_dir());

        t.0.migrate_legacy_layout();

        let mut expected = vec![GENERAL_KEY.to_owned(), project_key.clone()];
        expected.sort();
        assert_eq!(names(t.0.root()), expected);
        let notes = t.0.list_notes(&general()).unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].id, id);
        assert_eq!(notes[0].title, "Plan: Q4/2026");
        assert_eq!(t.0.read_note(&general(), &id).unwrap(), "content");
        for key in [GENERAL_KEY, project_key.as_str()] {
            let dir = t.0.root().join(key);
            let notes: Vec<String> = names(&dir.join(TRASH_DIR))
                .into_iter()
                .filter(|name| is_markdown(name))
                .collect();
            assert_eq!(notes.len(), 1, "{key}");
            assert!(!dir.join(LEGACY_TRASH_DIR).exists(), "{key}");
        }
        assert_eq!(t.0.list_notes(&project()).unwrap()[0].id, project_id);
    }

    #[test]
    fn migration_merges_both_layouts_without_losing_notes() {
        let t = TempNotes::new("migrate-both");
        let old_id = t.0.create_note(&general(), "same").unwrap();
        t.0.write_note(&general(), &old_id, "old").unwrap();
        let titled = t.0.create_note(&general(), "Plan: A").unwrap();
        make_legacy(t.0.root());
        let legacy = t.0.root().join(LEGACY_GENERAL_KEY);
        fs::create_dir_all(legacy.join(LEGACY_TRASH_DIR)).unwrap();
        fs::write(legacy.join(LEGACY_TRASH_DIR).join("1-x.md"), "old trash").unwrap();

        let new_id = t.0.create_note(&general(), "same").unwrap();
        t.0.write_note(&general(), &new_id, "new").unwrap();
        let dir = t.0.root().join(GENERAL_KEY);
        fs::create_dir_all(dir.join(TRASH_DIR)).unwrap();
        fs::write(dir.join(TRASH_DIR).join("1-x.md"), "new trash").unwrap();

        t.0.migrate_legacy_layout();

        assert!(!legacy.exists());
        let notes = t.0.list_notes(&general()).unwrap();
        assert_eq!(notes.len(), 3, "{notes:?}");
        assert_eq!(notes[0].id, new_id);
        assert_eq!(t.0.read_note(&general(), &new_id).unwrap(), "new");
        assert_eq!(t.0.read_note(&general(), &old_id).unwrap(), "old");
        assert_eq!(fs::read_to_string(dir.join("same.md")).unwrap(), "new");
        assert_eq!(fs::read_to_string(dir.join("same (2).md")).unwrap(), "old");
        assert!(notes.iter().any(|n| n.id == old_id && n.title == "same"));
        assert!(notes.iter().any(|n| n.id == titled && n.title == "Plan: A"));
        let trash = dir.join(TRASH_DIR);
        assert_eq!(names(&trash), ["1-x (2).md", "1-x.md"]);
        assert_eq!(
            fs::read_to_string(trash.join("1-x.md")).unwrap(),
            "new trash"
        );
        assert_eq!(
            fs::read_to_string(trash.join("1-x (2).md")).unwrap(),
            "old trash"
        );
    }

    #[test]
    fn migration_keeps_unreadable_legacy_metadata() {
        let t = TempNotes::new("migrate-broken");
        t.0.create_note(&general(), "a").unwrap();
        make_legacy(t.0.root());
        let legacy = t.0.root().join(LEGACY_GENERAL_KEY);
        fs::write(legacy.join(META_FILE), "{ broken").unwrap();
        t.0.create_note(&general(), "b").unwrap();

        t.0.migrate_legacy_layout();

        assert_eq!(names(&legacy), [META_FILE]);
        let titles: Vec<String> =
            t.0.list_notes(&general())
                .unwrap()
                .into_iter()
                .map(|n| n.title)
                .collect();
        assert_eq!(titles, ["b", "a"]);
    }

    #[test]
    fn migration_is_idempotent() {
        let t = TempNotes::new("migrate-repeat");
        let id = t.0.create_note(&general(), "x").unwrap();
        let gone = t.0.create_note(&general(), "y").unwrap();
        t.0.delete_note(&general(), &gone).unwrap();
        make_legacy(t.0.root());

        t.0.migrate_legacy_layout();
        let first = t.0.list_notes(&general()).unwrap();
        let trash = names(&t.0.root().join(GENERAL_KEY).join(TRASH_DIR));
        t.0.migrate_legacy_layout();

        assert_eq!(t.0.list_notes(&general()).unwrap(), first);
        assert_eq!(first[0].id, id);
        assert_eq!(names(t.0.root()), [GENERAL_KEY]);
        assert_eq!(names(&t.0.root().join(GENERAL_KEY).join(TRASH_DIR)), trash);
    }

    #[test]
    fn search_across_folders() {
        let t = TempNotes::new("search");
        let a = t.0.create_note(&project(), "Deploy plan").unwrap();
        t.0.write_note(&project(), &a, "Steps:\n\n1. Build\n2. Ship it")
            .unwrap();
        let b = t.0.create_note(&general(), "Groceries").unwrap();
        t.0.write_note(&general(), &b, "Milk, bread\nand the DEPLOY checklist")
            .unwrap();
        let c = t.0.create_note(&general(), "Other").unwrap();
        t.0.write_note(&general(), &c, "nothing here").unwrap();

        let hits = t.0.search("deploy").unwrap();
        assert_eq!(hits.len(), 2, "{hits:?}");
        // The title hit comes first.
        assert_eq!(hits[0].id, a);
        assert_eq!(hits[0].path, project().path);
        assert_eq!(hits[0].folder_key, folder_key(&project()).unwrap());
        assert!(
            hits[0].excerpt.starts_with("Steps: 1. Build"),
            "{:?}",
            hits[0].excerpt
        );
        assert_eq!(hits[1].id, b);
        assert_eq!(hits[1].path, None);
        assert_eq!(hits[1].folder_key, GENERAL_KEY);
        assert!(hits[1].excerpt.contains("the DEPLOY checklist"));
        assert!(hits[1].updated_at.is_some());
        let json = serde_json::to_value(&hits[1]).unwrap();
        for field in ["folderKey", "path", "id", "title", "excerpt", "updatedAt"] {
            assert!(json.get(field).is_some(), "{field}");
        }

        // Case-insensitive beyond ASCII; regex characters are plain text.
        t.0.write_note(&general(), &c, "Größe ÄRGER (a+b)*")
            .unwrap();
        assert_eq!(t.0.search("ärger").unwrap()[0].id, c);
        assert_eq!(t.0.search("(a+b)*").unwrap()[0].id, c);
        assert!(t.0.search(".*").unwrap().is_empty());
        // Empty finds nothing; too long or with control characters is an error.
        assert!(t.0.search("   ").unwrap().is_empty());
        assert!(matches!(
            t.0.search(&"x".repeat(MAX_QUERY_CHARS + 1)),
            Err(NotesError::InvalidQuery(_))
        ));
        assert!(matches!(
            t.0.search("a\nb"),
            Err(NotesError::InvalidQuery(_))
        ));
        // A file above the size limit is skipped, not an error.
        let dir = t.0.root().join(GENERAL_KEY);
        fs::write(
            dir.join("Groceries.md"),
            "deploy ".repeat(MAX_NOTE_BYTES / 6),
        )
        .unwrap();
        let hits = t.0.search("deploy").unwrap();
        assert_eq!(hits.len(), 1);
        // A search changes nothing on disk.
        assert!(!dir.join(TRASH_DIR).exists());
    }

    #[test]
    fn metadata_naming_other_files_is_not_trusted() {
        let t = TempNotes::new("trusted");
        let folder = general();
        let id = t.0.create_note(&folder, "own").unwrap();
        let dir = t.0.root().join(GENERAL_KEY);
        fs::write(t.0.root().join("outside.md"), "foreign").unwrap();
        let mut meta: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(META_FILE)).unwrap()).unwrap();
        let notes = meta["notes"].as_array_mut().unwrap();
        for (n, file) in ["../outside.md", "sub/x.md", "x.txt", "C:\\x.md"]
            .iter()
            .enumerate()
        {
            notes.push(serde_json::json!({
                "id": format!("00000000-0000-4000-8000-00000000000{n}"),
                "title": "evil",
                "file": file,
                "order": 9
            }));
        }
        fs::write(dir.join(META_FILE), meta.to_string()).unwrap();
        let listed = t.0.list_notes(&folder).unwrap();
        assert_eq!(listed.len(), 1, "{listed:?}");
        assert_eq!(listed[0].id, id);
        for n in 0..4 {
            let foreign = format!("00000000-0000-4000-8000-00000000000{n}");
            assert!(t.0.read_note(&folder, &foreign).is_err());
        }
        assert!(t.0.search("foreign").unwrap().is_empty());
        assert!(plain_markdown_name("a b.md"));
        assert!(!plain_markdown_name(".."));
        assert!(!plain_markdown_name("a/b.md"));
        assert!(!plain_markdown_name("a\\b.md"));
    }

    /// `:` names an NTFS alternate data stream of a file, and Windows refuses the other
    /// characters in names: an entry with any of them is not trusted (security review N2).
    #[test]
    fn entries_with_forbidden_or_control_characters_are_not_trusted() {
        for name in [
            "note.md:hidden.md",
            "a:b.md",
            "a<b.md",
            "a>b.md",
            "a\"b.md",
            "a|b.md",
            "a?b.md",
            "a*b.md",
            "a\tb.md",
            "a\nb.md",
            "a\u{7f}b.md",
        ] {
            assert!(!plain_markdown_name(name), "{name:?}");
        }
        assert!(plain_markdown_name("Café äöü (2).md"));
        let t = TempNotes::new("forbidden-names");
        let folder = general();
        let id = t.0.create_note(&folder, "own").unwrap();
        let dir = t.0.root().join(GENERAL_KEY);
        let mut meta: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(META_FILE)).unwrap()).unwrap();
        meta["notes"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "id": "00000000-0000-4000-8000-000000000009",
                "title": "stream",
                "file": "own.md:marker",
                "order": 9
            }));
        fs::write(dir.join(META_FILE), meta.to_string()).unwrap();
        let listed = t.0.list_notes(&folder).unwrap();
        assert_eq!(listed.len(), 1, "{listed:?}");
        assert_eq!(listed[0].id, id);
        assert!(matches!(
            t.0.read_note(&folder, "00000000-0000-4000-8000-000000000009"),
            Err(NotesError::UnknownNote)
        ));
    }

    /// Abnahme: a file Hangar wrote without an entry keeps its ID when the folder turns writable.
    #[test]
    fn an_adopted_note_keeps_its_id_from_read_only_to_writable() {
        let t = TempNotes::new("stable-handover");
        let folder = project();
        t.0.create_note(&folder, "own").unwrap();
        let dir = t.0.root().join(folder_key(&folder).unwrap());
        fs::write(dir.join("From Hangar.md"), "fresh").unwrap();
        let trash = t.0.root().join(GENERAL_KEY).join(TRASH_DIR);
        fs::create_dir_all(&trash).unwrap();
        fs::write(trash.join("1-Old.md"), "old").unwrap();

        let ro = t.read_only();
        let seen = ro.list_notes(&folder).unwrap();
        let read_only_id = seen
            .iter()
            .find(|n| n.title == "From Hangar")
            .unwrap()
            .id
            .clone();
        let read_only_trash = ro.list_trash(&general()).unwrap()[0].id.clone();

        let listed = t.0.list_notes(&folder).unwrap();
        let writable_id = &listed.iter().find(|n| n.title == "From Hangar").unwrap().id;
        assert_eq!(*writable_id, read_only_id);
        assert_eq!(t.0.list_trash(&general()).unwrap()[0].id, read_only_trash);
        // Written down now, and still the same on the next look.
        assert!(fs::read_to_string(dir.join(META_FILE))
            .unwrap()
            .contains(&read_only_id));
        assert_eq!(
            t.0.list_notes(&folder).unwrap(),
            listed,
            "the ID stays once written"
        );
        // A UUID v4 in form, which is what Hangar assumes of every ID.
        for id in [&read_only_id, &read_only_trash] {
            let parsed = uuid::Uuid::parse_str(id).unwrap();
            assert_eq!(parsed.get_version_num(), 4, "{id}");
            assert_eq!(parsed.get_variant(), uuid::Variant::RFC4122, "{id}");
            assert_eq!(check_id(id).unwrap(), *id);
        }
    }

    #[test]
    fn a_new_file_under_an_adopted_name_gets_its_own_id() {
        let t = TempNotes::new("stable-collision");
        let folder = general();
        t.0.create_note(&folder, "keep").unwrap();
        let dir = t.0.root().join(GENERAL_KEY);
        fs::write(dir.join("Adopted.md"), "first").unwrap();
        let first = t.0.list_notes(&folder).unwrap();
        let adopted = first
            .iter()
            .find(|n| n.title == "Adopted")
            .unwrap()
            .id
            .clone();
        t.0.rename_note(&folder, &adopted, "Renamed").unwrap();
        fs::write(dir.join("Adopted.md"), "second").unwrap();
        let ro = t.read_only();
        let ro_ids: Vec<String> = ro
            .list_notes(&folder)
            .unwrap()
            .into_iter()
            .map(|n| n.id)
            .collect();
        let notes = t.0.list_notes(&folder).unwrap();
        let ids: HashSet<&str> = notes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids.len(), 3, "{notes:?}");
        let newcomer = notes.iter().find(|n| n.title == "Adopted").unwrap();
        assert_ne!(newcomer.id, adopted);
        assert!(
            ro_ids.contains(&newcomer.id),
            "read only and writable agree"
        );
        assert_eq!(t.0.read_note(&folder, &newcomer.id).unwrap(), "second");
        assert_eq!(t.0.read_note(&folder, &adopted).unwrap(), "first");
    }

    /// Security review N3: neither the scopes nor the migration follow a link or junction.
    #[test]
    fn links_in_the_notes_tree_are_never_followed() {
        use crate::test_support::make_dir_link;
        let t = TempNotes::new("links");
        // Hangar Note's notes, and a folder elsewhere with notes of its own.
        t.0.create_note(&general(), "own").unwrap();
        let elsewhere = t.1.path().join("elsewhere");
        fs::create_dir_all(elsewhere.join(LEGACY_TRASH_DIR)).unwrap();
        fs::write(elsewhere.join("Foreign.md"), "marker-foreign-2b8").unwrap();
        fs::write(elsewhere.join(LEGACY_TRASH_DIR).join("1-x.md"), "x").unwrap();
        let before = snapshot(&elsewhere);

        // A scope folder that is a link, a legacy General area that is a link, and a legacy
        // trash inside a real scope that is a link.
        let linked_key = folder_key(&project()).unwrap();
        if !make_dir_link(&elsewhere, &t.0.root().join(&linked_key)) {
            eprintln!("no links on this system; skipped");
            return;
        }
        assert!(make_dir_link(
            &elsewhere,
            &t.0.root().join(LEGACY_GENERAL_KEY)
        ));
        assert!(make_dir_link(
            &elsewhere.join(LEGACY_TRASH_DIR),
            &t.0.root().join(GENERAL_KEY).join(LEGACY_TRASH_DIR)
        ));

        t.0.migrate_legacy_layout();
        assert!(t.0.list_notes(&project()).unwrap().is_empty());
        assert!(matches!(
            t.0.create_note(&project(), "x"),
            Err(NotesError::InvalidFolder(_))
        ));
        assert!(t.0.list_trash(&project()).unwrap().is_empty());
        assert!(t.0.search("marker-foreign").unwrap().is_empty());
        let keys: Vec<String> =
            t.0.list_folders()
                .unwrap()
                .into_iter()
                .map(|f| f.folder_key)
                .collect();
        assert_eq!(keys, [GENERAL_KEY]);
        assert_eq!(t.0.folder_for_key(&linked_key), None);
        // The General area kept its own note only; the links are still there, untouched.
        let general_notes = t.0.list_notes(&general()).unwrap();
        assert_eq!(general_notes.len(), 1);
        assert_eq!(general_notes[0].title, "own");
        assert!(!t.0.root().join(GENERAL_KEY).join(TRASH_DIR).exists());
        assert!(fs::symlink_metadata(t.0.root().join(LEGACY_GENERAL_KEY))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(snapshot(&elsewhere), before);
    }

    #[test]
    fn capped_read_never_reads_past_the_limit() {
        let t = TempNotes::new("capped");
        let id = t.0.create_note(&general(), "big").unwrap();
        let path = t.0.note_path(&general(), &id).unwrap();
        fs::write(&path, "x".repeat(MAX_NOTE_BYTES + 1)).unwrap();
        assert!(matches!(
            t.0.read_note(&general(), &id),
            Err(NotesError::TooLarge { .. })
        ));
        // A large note is still previewed from its start.
        let listed = t.0.list_with_previews(&general(), 16).unwrap();
        assert_eq!(listed[0].1, "x".repeat(16));
    }

    #[test]
    fn search_limits_results() {
        let t = TempNotes::new("search-limit");
        for n in 0..(MAX_SEARCH_RESULTS + 5) {
            t.0.create_note(&general(), &format!("hit {n}")).unwrap();
        }
        assert_eq!(t.0.search("HIT").unwrap().len(), MAX_SEARCH_RESULTS);
        assert!(t.0.search("hit").is_ok());
        let missing = NotesStore::new(&t.1.path().join("missing"), Arc::default());
        assert!(missing.search("x").unwrap().is_empty());
    }

    #[test]
    fn excerpts_cut_on_characters() {
        let long = format!("{}needle{}", "ä ".repeat(100), "ö".repeat(400));
        let text = excerpt(&long, "needle");
        assert!(text.starts_with('…'));
        assert!(text.ends_with('…'));
        assert!(text.contains("needle"));
        assert!(text.chars().count() <= EXCERPT_MAX_CHARS + 2);
        // Lowercasing that changes byte lengths does not shift the cut (İ lowercases to two chars).
        let tricky = format!("{}Needle", "İ".repeat(80));
        assert!(excerpt(&tricky, "needle").contains("Needle"));
        assert_eq!(excerpt("short\n\ttext", "zzz"), "short text");
        assert_eq!(excerpt("start of\nit", ""), "start of it");
    }

    #[test]
    fn trash_lists_and_restores() {
        let t = TempNotes::new("trash");
        let folder = project();
        assert!(t.0.list_trash(&folder).unwrap().is_empty());
        let id = t.0.create_note(&folder, "Plan: Q4/2026").unwrap();
        t.0.write_note(&folder, &id, "content").unwrap();
        let other = t.0.create_note(&folder, "stays").unwrap();
        t.0.delete_note(&folder, &id).unwrap();

        let trash = t.0.list_trash(&folder).unwrap();
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].id, id);
        assert_eq!(trash[0].title, "Plan: Q4/2026");
        assert!(trash[0].deleted_at.is_some());
        let json = serde_json::to_value(&trash[0]).unwrap();
        assert!(json.get("deletedAt").is_some());

        // A new note took the file name meanwhile: the restored one gets its own.
        let squatter = t.0.create_note(&folder, "Plan: Q4/2026").unwrap();
        let restored = t.0.restore_note(&folder, &id).unwrap();
        assert_eq!(restored, id);
        assert_eq!(t.0.read_note(&folder, &id).unwrap(), "content");
        let notes = t.0.list_notes(&folder).unwrap();
        let ids: Vec<&str> = notes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, [other.as_str(), squatter.as_str(), id.as_str()]);
        assert!(t.0.list_trash(&folder).unwrap().is_empty());
        assert!(matches!(
            t.0.restore_note(&folder, &id),
            Err(NotesError::UnknownNote)
        ));
        assert!(matches!(
            t.0.restore_note(&folder, "../x"),
            Err(NotesError::InvalidId)
        ));
    }

    #[test]
    fn trash_adopts_files_without_record() {
        let t = TempNotes::new("trash-adopt");
        let folder = general();
        t.0.create_note(&folder, "keep").unwrap();
        let trash = t.0.root().join(GENERAL_KEY).join(TRASH_DIR);
        fs::create_dir_all(&trash).unwrap();
        // As written before trash.json existed.
        fs::write(trash.join("1700000000000-Old idea.md"), "old").unwrap();
        fs::write(trash.join("not a note.txt"), "x").unwrap();
        let list = t.0.list_trash(&folder).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].title, "Old idea");
        assert_eq!(list[0].deleted_at, Some(1_700_000_000_000));
        // The adopted ID stays stable and can be restored.
        assert_eq!(t.0.list_trash(&folder).unwrap()[0].id, list[0].id);
        let id = t.0.restore_note(&folder, &list[0].id).unwrap();
        assert_eq!(t.0.read_note(&folder, &id).unwrap(), "old");
        assert!(t.0.root().join(GENERAL_KEY).join("Old idea.md").is_file());
        // A broken record does not hide the files.
        let gone = t.0.create_note(&folder, "gone").unwrap();
        t.0.delete_note(&folder, &gone).unwrap();
        fs::write(trash.join(TRASH_META_FILE), "{ broken").unwrap();
        assert_eq!(t.0.list_trash(&folder).unwrap()[0].title, "gone");
    }

    #[test]
    fn trash_records_pointing_elsewhere_are_ignored() {
        let t = TempNotes::new("trash-outside");
        let folder = general();
        t.0.create_note(&folder, "keep").unwrap();
        let dir = t.0.root().join(GENERAL_KEY);
        let trash = dir.join(TRASH_DIR);
        fs::create_dir_all(&trash).unwrap();
        fs::write(t.0.root().join("outside.md"), "foreign").unwrap();
        let forged = new_id();
        let sep = std::path::MAIN_SEPARATOR;
        let record = serde_json::json!({
            "version": TRASH_META_VERSION,
            "items": [
                { "id": forged, "title": "x", "file": format!("..{sep}..{sep}outside.md"), "deletedAt": 1 },
                { "id": "not-an-id", "title": "y", "file": "y.md", "deletedAt": 2 },
            ]
        });
        fs::write(trash.join(TRASH_META_FILE), record.to_string()).unwrap();
        fs::write(trash.join("y.md"), "kept").unwrap();
        let list = t.0.list_trash(&folder).unwrap();
        assert_eq!(list.len(), 1, "{list:?}");
        assert_ne!(list[0].id, "not-an-id");
        assert!(matches!(
            t.0.restore_note(&folder, &forged),
            Err(NotesError::UnknownNote)
        ));
        assert!(t.0.root().join("outside.md").is_file());
    }

    #[test]
    fn export_and_path_of_a_note() {
        let t = TempNotes::new("export");
        let id = t.0.create_note(&general(), "a/b").unwrap();
        t.0.write_note(&general(), &id, "text").unwrap();
        assert_eq!(
            t.0.note_for_export(&general(), &id).unwrap(),
            ("a/b".to_owned(), "text".to_owned())
        );
        let path = t.0.note_path(&general(), &id).unwrap();
        assert!(path.is_file());
        assert!(path.starts_with(t.0.root()));
        assert!(matches!(
            t.0.note_path(&general(), &new_id()),
            Err(NotesError::UnknownNote)
        ));
    }

    #[test]
    fn read_only_reads_everything_and_writes_nothing() {
        let t = TempNotes::new("read-only");
        let id = t.0.create_note(&project(), "Plan").unwrap();
        t.0.write_note(&project(), &id, "content").unwrap();
        let gone = t.0.create_note(&general(), "gone").unwrap();
        t.0.delete_note(&general(), &gone).unwrap();
        let dir = t.0.root().join(folder_key(&project()).unwrap());
        // What Hangar could leave behind: a file without an entry, a trash file without a record,
        // a broken index elsewhere and the old folder names.
        fs::write(dir.join("From Hangar.md"), "fresh").unwrap();
        fs::write(
            t.0.root()
                .join(GENERAL_KEY)
                .join(TRASH_DIR)
                .join("1-Old.md"),
            "old",
        )
        .unwrap();
        fs::create_dir_all(t.0.root().join(LEGACY_GENERAL_KEY)).unwrap();
        let broken = NoteFolder::at(t.1.path().join("broken"));
        let broken_dir = t.0.root().join(folder_key(&broken).unwrap());
        fs::create_dir_all(&broken_dir).unwrap();
        fs::write(broken_dir.join(META_FILE), "{ broken").unwrap();
        fs::write(broken_dir.join("kept.md"), "kept").unwrap();
        let before = snapshot(t.0.root());

        let ro = t.read_only();
        ro.migrate_legacy_layout();
        let notes = ro.list_notes(&project()).unwrap();
        assert_eq!(notes.len(), 2);
        let adopted = notes.iter().find(|n| n.title == "From Hangar").unwrap();
        // The same ID twice, though nothing was written down.
        assert_eq!(ro.list_notes(&project()).unwrap(), notes);
        assert_eq!(ro.read_note(&project(), &adopted.id).unwrap(), "fresh");
        assert_eq!(ro.read_note(&project(), &id).unwrap(), "content");
        assert_eq!(ro.list_notes(&broken).unwrap().len(), 1);
        let trash = ro.list_trash(&general()).unwrap();
        assert_eq!(trash.len(), 2);
        assert_eq!(ro.list_trash(&general()).unwrap(), trash);
        assert_eq!(
            ro.search("fresh").unwrap().len(),
            0,
            "unlisted files are not indexed"
        );
        assert_eq!(ro.search("plan").unwrap().len(), 1);
        assert!(ro.list_folders().is_ok());
        assert!(ro
            .folder_dir(&NoteFolder::at(t.1.path().join("none")))
            .is_ok());

        for result in [
            ro.write_note(&project(), &id, "x").map(|_| ()),
            ro.create_note(&general(), "x").map(|_| ()),
            ro.rename_note(&project(), &id, "x"),
            ro.delete_note(&project(), &id),
            ro.restore_note(&general(), &trash[0].id).map(|_| ()),
        ] {
            let error = result.unwrap_err();
            assert!(matches!(error, NotesError::ReadOnly), "{error}");
            assert_eq!(serde_json::to_value(&error).unwrap(), READ_ONLY_CODE);
        }
        assert_eq!(snapshot(t.0.root()), before);
    }

    #[cfg(unix)]
    #[test]
    fn unix_permissions_only_for_owner() {
        use std::os::unix::fs::PermissionsExt;
        let t = TempNotes::new("mode");
        let id = t.0.create_note(&general(), "x").unwrap();
        t.0.write_note(&general(), &id, "y").unwrap();
        let dir = t.0.root().join(GENERAL_KEY);
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&dir.join("x.md")), 0o600);
        assert_eq!(mode(&dir.join(META_FILE)), 0o600);
    }
}
