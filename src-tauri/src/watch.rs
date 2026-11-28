//! Changes another program makes to the shared notes folder (ADR 0005, contract "notes-shared 1").
//!
//! Hangar writes the same folder as Hangar Note at the same time, so the notes area and the sticky
//! notes must learn about Hangar's changes without anyone pressing a key. A light poll does that:
//! once a second [`Watch::poll`] takes the state ([`stat_version`], modification time and length)
//! of every file that matters (each scope's `folder.json`, its `.md` notes and `.trash/trash.json`) and names the
//! scopes where something differs from the last look.
//!
//! **Why a poll and not the `notify` crate:** a poll needs no dependency and behaves the same on
//! every platform, network drives included, where change notifications are unreliable. For a
//! notes folder (a few hundred small files) one pass is a directory listing per scope and one
//! metadata call per file, well below a millisecond per scope; [`MAX_WATCHED_FILES`] bounds it.
//!
//! **Own writes are not news:** the store records the state it left a file in ([`Watch::own`]);
//! a difference that matches it is skipped, so typing in the notes area does not reload its own
//! list every second. A later change by Hangar gives another state and is reported.
//!
//! **Detection only.** The poll uses cheap file states; whether a save may overwrite a note is
//! decided by the content hash under the scope lock (`notes.rs`, `write_note_checked`). Hidden
//! and temporary files (`.<name>.<pid>.<n>.tmp` of either app, `.lock`) and links are never
//! looked at.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::fsio::{is_hidden_or_temp, is_link_meta, is_regular_dir, lock};
use crate::notes::{scope_keys, MAX_DIR_ENTRIES, TRASH_DIR};

/// How often the folder is looked at; changes show up within about this long.
pub const POLL_INTERVAL: Duration = Duration::from_secs(1);
/// At most this many files are looked at per pass, so a huge folder cannot stall the app.
pub const MAX_WATCHED_FILES: usize = 5000;

const META_FILE: &str = "folder.json";
const TRASH_META_FILE: &str = "trash.json";

/// Every watched file with its version, and the scope folders that exist.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Snapshot {
    files: BTreeMap<PathBuf, String>,
    scopes: BTreeSet<String>,
}

/// A note's file name as the poll sees it: `.md`, and no hidden or temporary file.
fn is_note_name(name: &str) -> bool {
    !is_hidden_or_temp(name)
        && Path::new(name)
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("md"))
}

/// The cheap state of a file for change detection: modification time in nanoseconds and length.
/// Never a conflict decision (that is the content hash, `notes::content_version`).
pub fn stat_version(meta: &fs::Metadata) -> String {
    let nanos = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |since| since.as_nanos());
    format!("{nanos}-{}", meta.len())
}

/// A folder itself, never a link, junction or reparse point (the store does not follow those
/// either). Silent: this runs every second, and the store logs links when it meets them.
fn plain_dir(path: &Path) -> bool {
    is_regular_dir(path)
}

/// The state of a file now, `None` when it is gone or not a regular file (a link, a reparse
/// point, a folder).
pub fn state_of(path: &Path) -> Option<String> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.file_type().is_file() || is_link_meta(&meta) {
        return None;
    }
    // Through the path again, so the state matches what `own` records for the same file.
    fs::metadata(path).ok().map(|meta| stat_version(&meta))
}

/// Takes the versions of every watched file under `root`: the scopes of [`scope_keys`], and per
/// scope at most [`MAX_DIR_ENTRIES`] entries of its listing, so neither a flood of scope folders
/// nor of files makes a pass unbounded before the budget applies (security review H1).
pub fn scan(root: &Path) -> Snapshot {
    let mut snapshot = Snapshot::default();
    let Ok(keys) = scope_keys(root) else {
        return snapshot;
    };
    let mut budget = MAX_WATCHED_FILES;
    for key in keys {
        let dir = root.join(&key);
        if !plain_dir(&dir) {
            continue;
        }
        snapshot.scopes.insert(key);
        let mut take = |path: PathBuf| {
            if budget == 0 {
                return;
            }
            if let Some(state) = state_of(&path) {
                budget -= 1;
                snapshot.files.insert(path, state);
            }
        };
        take(dir.join(META_FILE));
        let trash = dir.join(TRASH_DIR);
        if plain_dir(&trash) {
            take(trash.join(TRASH_META_FILE));
        }
        let Ok(files) = fs::read_dir(&dir) else {
            continue;
        };
        let mut names: Vec<String> = files
            .take(MAX_DIR_ENTRIES)
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| is_note_name(name))
            .collect();
        names.sort();
        for name in names {
            take(dir.join(name));
        }
    }
    snapshot
}

/// The scope key a path below `root` belongs to.
fn scope_of(root: &Path, path: &Path) -> Option<String> {
    path.strip_prefix(root)
        .ok()?
        .components()
        .next()
        .and_then(|part| part.as_os_str().to_str())
        .map(str::to_owned)
}

/// The scopes where `next` differs from `last`, leaving out every file whose new state is the one
/// this app wrote (`own`).
pub fn changed_scopes(
    root: &Path,
    last: &Snapshot,
    next: &Snapshot,
    own: &HashMap<PathBuf, Option<String>>,
) -> BTreeSet<String> {
    let mut changed: BTreeSet<String> = last
        .scopes
        .symmetric_difference(&next.scopes)
        .cloned()
        .collect();
    let paths: BTreeSet<&PathBuf> = last.files.keys().chain(next.files.keys()).collect();
    for path in paths {
        let before = last.files.get(path);
        let after = next.files.get(path);
        if before == after {
            continue;
        }
        if own.get(path).is_some_and(|mine| mine.as_ref() == after) {
            continue;
        }
        if let Some(scope) = scope_of(root, path) {
            changed.insert(scope);
        }
    }
    changed
}

#[derive(Debug, Default)]
struct WatchState {
    last: Option<Snapshot>,
    /// What this app left each file as, with the sequence number of the record.
    own: HashMap<PathBuf, (u64, Option<String>)>,
    seq: u64,
}

/// Told about every file the store itself wrote or moved away (Hangar Drive's per note status,
/// `drive/`). Called right after the store's write, possibly with its locks held, so it must only
/// hand the path on and never block.
pub type OwnObserver = Arc<dyn Fn(&Path) + Send + Sync>;

/// The last look at the folder and the app's own writes since then; shared by the store's clones.
pub struct Watch {
    root: PathBuf,
    state: Mutex<WatchState>,
    observer: Mutex<Option<OwnObserver>>,
}

impl std::fmt::Debug for Watch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Watch")
            .field("root", &self.root)
            .field("state", &self.state)
            .finish_non_exhaustive()
    }
}

impl Watch {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
            state: Mutex::default(),
            observer: Mutex::default(),
        }
    }

    /// Sets the one observer of own writes ([`OwnObserver`]).
    pub fn observe_own(&self, observer: OwnObserver) {
        *lock(&self.observer) = Some(observer);
    }

    /// Records the state this app just left `path` in (written, or gone after a move). Called by
    /// the store right after its own write, while it still holds its locks.
    pub fn own(&self, path: &Path) {
        self.own_as(path, state_of(path));
    }

    /// Records `now` as the state this app left `path` in, for a write whose version is known
    /// from its own handle (a look at the path could already see another program's file).
    pub fn own_as(&self, path: &Path, now: Option<String>) {
        {
            let mut state = lock(&self.state);
            state.seq += 1;
            let seq = state.seq;
            state.own.insert(path.to_path_buf(), (seq, now));
        }
        let observer = lock(&self.observer).clone();
        if let Some(observer) = observer {
            observer(path);
        }
    }

    /// Looks at the folder and names the scopes another program changed since the last look.
    /// The first call only takes the starting point and names nothing.
    pub fn poll(&self) -> BTreeSet<String> {
        let mark = lock(&self.state).seq;
        // The scan runs without the lock, so the store never waits for it.
        let next = scan(&self.root);
        let mut state = lock(&self.state);
        let changed = match &state.last {
            None => BTreeSet::new(),
            Some(last) => {
                let own: HashMap<PathBuf, Option<String>> = state
                    .own
                    .iter()
                    .map(|(path, (_, mine))| (path.clone(), mine.clone()))
                    .collect();
                changed_scopes(&self.root, last, &next, &own)
            }
        };
        // Records from before the scan are reflected in it; later ones wait for the next pass.
        state.own.retain(|_, (seq, _)| *seq > mark);
        state.last = Some(next);
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    const KEY: &str = "6e6ef9e1f001ea8d5164e716aaf511bf";

    /// Waits long enough that a rewrite gets another modification time even where the file system
    /// keeps coarse times; the length differs in the tests anyway.
    fn later() {
        std::thread::sleep(Duration::from_millis(20));
    }

    #[test]
    fn outside_changes_are_named_by_scope() {
        let dir = TempDir::new("watch-outside");
        let root = dir.path().join("notes");
        let scope = root.join(KEY);
        fs::create_dir_all(scope.join(TRASH_DIR)).unwrap();
        fs::create_dir_all(root.join("general")).unwrap();
        fs::write(scope.join(META_FILE), "{}").unwrap();
        fs::write(scope.join("a.md"), "one").unwrap();
        let watch = Watch::new(&root);
        assert!(watch.poll().is_empty(), "the first look names nothing");
        assert!(watch.poll().is_empty(), "nothing changed");

        later();
        fs::write(scope.join("a.md"), "one, edited").unwrap();
        assert_eq!(watch.poll(), BTreeSet::from([KEY.to_owned()]));
        assert!(watch.poll().is_empty());

        fs::write(root.join("general").join("new.md"), "new").unwrap();
        assert_eq!(watch.poll(), BTreeSet::from(["general".to_owned()]));

        fs::remove_file(scope.join("a.md")).unwrap();
        assert_eq!(watch.poll(), BTreeSet::from([KEY.to_owned()]));

        later();
        fs::write(scope.join(META_FILE), "{ \"reordered\": true }").unwrap();
        assert_eq!(watch.poll(), BTreeSet::from([KEY.to_owned()]));

        fs::write(scope.join(TRASH_DIR).join(TRASH_META_FILE), "{}").unwrap();
        assert_eq!(watch.poll(), BTreeSet::from([KEY.to_owned()]));

        let other = "0123456789abcdef0123456789abcdef";
        fs::create_dir_all(root.join(other)).unwrap();
        assert_eq!(watch.poll(), BTreeSet::from([other.to_owned()]));

        // Files that are no notes are not watched: the lock, other files, and the temporary
        // files of an atomic write by either app (dotfiles, `*.tmp`), even named like a note.
        fs::write(scope.join(".lock"), "").unwrap();
        fs::write(scope.join("picture.png"), "x").unwrap();
        fs::write(scope.join(".a.md.4711.0.tmp"), "half").unwrap();
        fs::write(scope.join(".hidden.md"), "x").unwrap();
        fs::write(scope.join("b.md.tmp"), "x").unwrap();
        assert!(watch.poll().is_empty());
    }

    #[test]
    fn own_writes_are_no_news_but_a_later_outside_write_is() {
        let dir = TempDir::new("watch-own");
        let root = dir.path().join("notes");
        let scope = root.join(KEY);
        fs::create_dir_all(&scope).unwrap();
        fs::write(scope.join("a.md"), "one").unwrap();
        let watch = Watch::new(&root);
        watch.poll();

        later();
        fs::write(scope.join("a.md"), "mine").unwrap();
        watch.own(&scope.join("a.md"));
        fs::write(scope.join("b.md"), "mine too").unwrap();
        watch.own(&scope.join("b.md"));
        assert!(watch.poll().is_empty());

        // Gone by this app's own move: no news either.
        fs::remove_file(scope.join("b.md")).unwrap();
        watch.own(&scope.join("b.md"));
        assert!(watch.poll().is_empty());

        // This app wrote, then another program wrote the same file before the next look.
        later();
        fs::write(scope.join("a.md"), "mine again").unwrap();
        watch.own(&scope.join("a.md"));
        later();
        fs::write(scope.join("a.md"), "theirs, longer").unwrap();
        assert_eq!(watch.poll(), BTreeSet::from([KEY.to_owned()]));
    }

    #[test]
    fn a_missing_root_is_empty_and_links_are_not_followed() {
        let dir = TempDir::new("watch-missing");
        let root = dir.path().join("notes");
        assert_eq!(scan(&root), Snapshot::default());
        let elsewhere = dir.path().join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        fs::write(elsewhere.join("x.md"), "x").unwrap();
        fs::create_dir_all(&root).unwrap();
        if crate::test_support::make_dir_link(&elsewhere, &root.join(KEY)) {
            assert!(scan(&root).files.is_empty());
        }
    }
}
