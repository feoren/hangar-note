//! The notes service: Hangar's private notes (`notes.rs`) together with Hangar Note's own data
//! about them (`meta.rs`). Commands, the local channel and the windows call this; it holds the
//! rules that join both, and no Tauri types.
//!
//! - A note's color comes from `meta.json`; a note without an entry is Lemon.
//! - "On the desktop" is the `open` flag of its entry: then the note has a sticky window, and that
//!   window is its only editor (ADR 0002, phase 1: one editor per note at any time).
//! - Notes created in this run with a provisional title ("Note 3") are *auto titled*: their title
//!   follows the first line until the person renames them, and one left empty goes to the trash
//!   (Hangar's quick note).

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Serialize, Serializer};

use crate::fsio::lock;
use crate::meta::{MetaError, MetaStore, NoteColor, NoteLook};
use crate::notes::{
    check_id, excerpt, folder_key, FolderInfo, NoteFolder, NotesError, NotesStore, SearchHit,
    MAX_NOTE_BYTES,
};

/// Bytes of each note the list carries for its excerpt and checklist progress.
pub const PREVIEW_BYTES: usize = 16 * 1024;
/// At most this many notes per `excerpts` answer.
pub const MAX_EXCERPTS: usize = 200;

/// What the notes area receives when it tries to write a note that sits on the desktop.
pub const ON_DESKTOP_CODE: &str = "on-desktop";
/// What a sticky note receives when it writes a note that is no longer on the desktop.
pub const NOT_OPEN_CODE: &str = "not-open";

#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    #[error(transparent)]
    Notes(#[from] NotesError),
    #[error(transparent)]
    Meta(#[from] MetaError),
    /// The note sits on the desktop: its sticky note is its only editor.
    #[error("The note sits on the desktop; its sticky note is its editor")]
    OnDesktop,
    /// A sticky note wrote after it was taken off the desktop.
    #[error("The note is no longer on the desktop")]
    NotOpen,
}

impl ServiceError {
    /// The fixed code of every variant (security review B4).
    pub fn code(&self) -> &'static str {
        match self {
            Self::Notes(error) => error.code(),
            Self::Meta(error) => error.code(),
            Self::OnDesktop => ON_DESKTOP_CODE,
            Self::NotOpen => NOT_OPEN_CODE,
        }
    }
}

impl Serialize for ServiceError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.code())
    }
}

/// Which editor writes a note (ADR 0002, phase 1: one editor per note at any time).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Editor {
    /// The notes area: only while the note is not on the desktop.
    Hub,
    /// The note's sticky window: only while the note is on the desktop.
    Sticky,
}

/// One row of the notes list.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRow {
    pub folder_key: String,
    pub path: Option<PathBuf>,
    pub id: String,
    pub title: String,
    pub updated_at: Option<u64>,
    pub order: u32,
    pub color: NoteColor,
    pub on_desktop: bool,
    /// The first [`PREVIEW_BYTES`] of the content.
    pub preview: String,
}

/// A search hit with its color, for the color filter.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HitRow {
    #[serde(flatten)]
    pub hit: SearchHit,
    pub color: NoteColor,
    pub on_desktop: bool,
}

/// A note with everything an editor needs.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedNote {
    pub folder_key: String,
    pub path: Option<PathBuf>,
    pub id: String,
    pub title: String,
    pub text: String,
    /// The file's version when `text` was read; an editor hands it back as `expected` on its next
    /// write (security review B8). Opaque.
    pub version: String,
    pub color: NoteColor,
    pub on_desktop: bool,
    pub on_top: bool,
    /// The title follows the first line (a provisional title given in this run).
    pub auto_titled: bool,
}

/// A deleted note as "Recently deleted" shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashRow {
    pub folder_key: String,
    pub path: Option<PathBuf>,
    pub id: String,
    pub title: String,
    pub deleted_at: Option<u64>,
    pub color: NoteColor,
}

/// A note's start for Hangar (`excerpts` route).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Excerpt {
    pub id: String,
    pub title: String,
    pub excerpt: String,
    pub updated_at: Option<u64>,
}

/// A note, named by scope key and ID: what sticky windows and `meta.json` know.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct NoteKey {
    pub scope: String,
    pub id: String,
}

/// A test's callback inside [`NotesService::write`].
#[cfg(test)]
pub struct TestHook(pub std::sync::Arc<dyn Fn() + Send + Sync>);

#[cfg(test)]
impl std::fmt::Debug for TestHook {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TestHook")
    }
}

#[derive(Debug)]
pub struct NotesService {
    store: NotesStore,
    meta: MetaStore,
    auto_titled: Mutex<HashSet<NoteKey>>,
    /// "One editor per note" made atomic (security review B2): writing a note's text and checking
    /// or changing whether it is on the desktop happen under this one lock, so no write of the
    /// notes area lands after its note went onto the desktop, and none of a sticky note after it
    /// left. One lock for all notes: an editor writes a note in milliseconds, and the windows
    /// write one at a time anyway.
    editors: Mutex<()>,
    /// Tests only: called between the notes area's editor check and its write, so a test can
    /// put the switch onto the desktop exactly there (B2).
    #[cfg(test)]
    after_hub_check: Option<TestHook>,
}

impl NotesService {
    pub fn new(store: NotesStore, meta: MetaStore) -> Self {
        Self {
            store,
            meta,
            auto_titled: Mutex::default(),
            editors: Mutex::default(),
            #[cfg(test)]
            after_hub_check: None,
        }
    }

    pub fn store(&self) -> &NotesStore {
        &self.store
    }

    pub fn meta(&self) -> &MetaStore {
        &self.meta
    }

    /// Scope key and normalized ID of a note.
    pub fn key(folder: &NoteFolder, id: &str) -> Result<NoteKey, ServiceError> {
        Ok(NoteKey {
            scope: folder_key(folder)?,
            id: check_id(id)?,
        })
    }

    pub fn look(&self, folder: &NoteFolder, id: &str) -> Result<NoteLook, ServiceError> {
        let key = Self::key(folder, id)?;
        Ok(self.meta.get(&key.scope, &key.id))
    }

    pub fn is_on_desktop(&self, folder: &NoteFolder, id: &str) -> bool {
        self.look(folder, id).is_ok_and(|look| look.open)
    }

    pub fn list_folders(&self) -> Result<Vec<FolderInfo>, ServiceError> {
        Ok(self.store.list_folders()?)
    }

    /// The scopes another program changed since the last call (`watch.rs`, ADR 0005).
    pub fn outside_changes(&self) -> std::collections::BTreeSet<String> {
        self.store.outside_changes()
    }

    pub fn list_notes(&self, folder: &NoteFolder) -> Result<Vec<NoteRow>, ServiceError> {
        let scope = folder_key(folder)?;
        Ok(self
            .store
            .list_with_previews(folder, PREVIEW_BYTES)?
            .into_iter()
            .map(|(info, preview)| {
                let look = self.meta.get(&scope, &info.id);
                NoteRow {
                    folder_key: scope.clone(),
                    path: folder.path.clone(),
                    id: info.id,
                    title: info.title,
                    updated_at: info.updated_at,
                    order: info.order,
                    color: look.color,
                    on_desktop: look.open,
                    preview,
                }
            })
            .collect())
    }

    pub fn search(&self, query: &str) -> Result<Vec<HitRow>, ServiceError> {
        Ok(self
            .store
            .search(query)?
            .into_iter()
            .map(|hit| {
                let look = self.meta.get(&hit.folder_key, &hit.id);
                HitRow {
                    hit,
                    color: look.color,
                    on_desktop: look.open,
                }
            })
            .collect())
    }

    pub fn open_note(&self, folder: &NoteFolder, id: &str) -> Result<OpenedNote, ServiceError> {
        let key = Self::key(folder, id)?;
        let (text, version) = self.store.read_note_versioned(folder, &key.id)?;
        let title = self.store.title(folder, &key.id)?;
        let look = self.meta.get(&key.scope, &key.id);
        Ok(OpenedNote {
            auto_titled: lock(&self.auto_titled).contains(&key),
            folder_key: key.scope,
            path: folder.path.clone(),
            id: key.id,
            title,
            text,
            version,
            color: look.color,
            on_desktop: look.open,
            on_top: look.on_top,
        })
    }

    /// An editor saves a note: the notes area only while the note is not on the desktop
    /// ([`ServiceError::OnDesktop`]), its sticky note only while it is ([`ServiceError::NotOpen`]).
    /// With `expected`, only while the file is still at that version (`changed`). The check and
    /// the write happen under the editor lock (B2). Returns the new version.
    pub fn write(
        &self,
        editor: Editor,
        folder: &NoteFolder,
        id: &str,
        text: &str,
        expected: Option<&str>,
    ) -> Result<String, ServiceError> {
        let key = Self::key(folder, id)?;
        let _editors = lock(&self.editors);
        let open = self.meta.get(&key.scope, &key.id).open;
        match (editor, open) {
            (Editor::Hub, true) => return Err(ServiceError::OnDesktop),
            (Editor::Sticky, false) => return Err(ServiceError::NotOpen),
            _ => {}
        }
        #[cfg(test)]
        if editor == Editor::Hub {
            if let Some(hook) = &self.after_hub_check {
                (hook.0)();
            }
        }
        Ok(self
            .store
            .write_note_checked(folder, &key.id, text, expected)?)
    }

    /// Puts a note onto the desktop or takes it off, under the editor lock (B2): once this
    /// returns `true`, no write of the notes area lands any more; once `false`, none of the
    /// sticky note. Returns the new look.
    pub fn set_open(&self, key: &NoteKey, open: bool) -> Result<NoteLook, ServiceError> {
        self.set_open_with(key, open, |_| {})
    }

    /// [`Self::set_open`] with further changes to the look in the same step and under the same
    /// lock, such as the first place of a new sticky note.
    pub fn set_open_with(
        &self,
        key: &NoteKey,
        open: bool,
        change: impl FnOnce(&mut NoteLook),
    ) -> Result<NoteLook, ServiceError> {
        let _editors = lock(&self.editors);
        Ok(self.meta.update(&key.scope, &key.id, |look| {
            change(look);
            look.open = open;
        })?)
    }

    /// A captured text as a new note in `folder` (local channel `capture`, ADR 0002): the capture
    /// block (`capture.rs`) under a title that follows its first line, as a quick note's does.
    /// The note is on disk when this returns; returns its ID.
    pub fn capture(
        &self,
        folder: &NoteFolder,
        captured: &crate::capture::Captured,
        color: NoteColor,
    ) -> Result<String, ServiceError> {
        let id = self.create_with_text(folder, &captured.title, &captured.content, color)?;
        lock(&self.auto_titled).insert(Self::key(folder, &id)?);
        Ok(id)
    }

    /// A new, empty note titled "`base` N", in `color`; auto titled. Returns the note.
    pub fn create_untitled(
        &self,
        folder: &NoteFolder,
        base: &str,
        color: NoteColor,
    ) -> Result<OpenedNote, ServiceError> {
        let (id, _) = self.store.create_untitled(folder, base)?;
        let key = Self::key(folder, &id)?;
        self.meta
            .update(&key.scope, &key.id, |look| look.color = color)?;
        lock(&self.auto_titled).insert(key);
        self.open_note(folder, &id)
    }

    /// [`Self::create_untitled`] put straight onto the desktop, with `place` changing its look in
    /// the same step ([`Self::set_open_with`]). The note answers as it is afterwards, so its
    /// sticky note and the notes area see it on the desktop. Returns the note and its look.
    pub fn create_untitled_on_desktop(
        &self,
        folder: &NoteFolder,
        base: &str,
        color: NoteColor,
        place: impl FnOnce(&mut NoteLook),
    ) -> Result<(OpenedNote, NoteLook), ServiceError> {
        let mut note = self.create_untitled(folder, base, color)?;
        let key = Self::key(folder, &note.id)?;
        let look = self.set_open_with(&key, true, place)?;
        note.on_desktop = look.open;
        note.on_top = look.on_top;
        Ok((note, look))
    }

    /// A note with a title and text of its own (the daily review over the local channel).
    pub fn create_with_text(
        &self,
        folder: &NoteFolder,
        title: &str,
        text: &str,
        color: NoteColor,
    ) -> Result<String, ServiceError> {
        if text.len() > MAX_NOTE_BYTES {
            return Err(NotesError::TooLarge {
                size: text.len(),
                max: MAX_NOTE_BYTES,
            }
            .into());
        }
        let id = self.store.create_note(folder, title)?;
        let key = Self::key(folder, &id)?;
        self.store.write_note(folder, &id, text)?;
        self.meta
            .update(&key.scope, &key.id, |look| look.color = color)?;
        Ok(id)
    }

    /// A new title. `by_person`: the person chose it, so it no longer follows the first line.
    pub fn rename(
        &self,
        folder: &NoteFolder,
        id: &str,
        title: &str,
        by_person: bool,
    ) -> Result<(), ServiceError> {
        let key = Self::key(folder, id)?;
        self.store.rename_note(folder, &key.id, title)?;
        if by_person {
            lock(&self.auto_titled).remove(&key);
        }
        Ok(())
    }

    /// Into the trash. The sticky window, if any, is the caller's to close; its entry no longer
    /// counts as on the desktop.
    pub fn delete(&self, folder: &NoteFolder, id: &str) -> Result<(), ServiceError> {
        let key = Self::key(folder, id)?;
        let _editors = lock(&self.editors);
        self.store.delete_note(folder, &key.id)?;
        lock(&self.auto_titled).remove(&key);
        if self.meta.get(&key.scope, &key.id).open {
            self.meta
                .update(&key.scope, &key.id, |look| look.open = false)?;
        }
        Ok(())
    }

    pub fn list_trash(&self, folder: &NoteFolder) -> Result<Vec<TrashRow>, ServiceError> {
        let scope = folder_key(folder)?;
        Ok(self
            .store
            .list_trash(folder)?
            .into_iter()
            .map(|item| TrashRow {
                color: self.meta.get(&scope, &item.id).color,
                folder_key: scope.clone(),
                path: folder.path.clone(),
                id: item.id,
                title: item.title,
                deleted_at: item.deleted_at,
            })
            .collect())
    }

    /// Back from the trash; the color comes along even when the note gets a new ID.
    pub fn restore(&self, folder: &NoteFolder, id: &str) -> Result<String, ServiceError> {
        let key = Self::key(folder, id)?;
        let restored = self.store.restore_note(folder, &key.id)?;
        if self.meta.known(&key.scope, &key.id) {
            self.meta.rename(&key.scope, &key.id, &restored)?;
        }
        Ok(restored)
    }

    pub fn set_color(
        &self,
        folder: &NoteFolder,
        id: &str,
        color: NoteColor,
    ) -> Result<NoteLook, ServiceError> {
        // Only notes that exist get an entry.
        self.store.title(folder, id)?;
        let key = Self::key(folder, id)?;
        Ok(self
            .meta
            .update(&key.scope, &key.id, |look| look.color = color)?)
    }

    /// The notes of a scope with a plain start of their content, newest first, at most `limit`.
    pub fn excerpts(
        &self,
        folder: &NoteFolder,
        limit: usize,
    ) -> Result<Vec<Excerpt>, ServiceError> {
        let mut rows = self.list_notes(folder)?;
        rows.sort_by_key(|row| std::cmp::Reverse(row.updated_at));
        Ok(rows
            .into_iter()
            .take(limit.min(MAX_EXCERPTS))
            .map(|row| Excerpt {
                excerpt: excerpt(&row.preview, ""),
                id: row.id,
                title: row.title,
                updated_at: row.updated_at,
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    fn service(dir: &TempDir) -> NotesService {
        let store = NotesStore::new(&dir.path().join("notes"), Arc::new(AtomicBool::new(true)));
        let meta = MetaStore::open(&dir.path().join("meta.json"));
        NotesService::new(store, meta)
    }

    #[test]
    fn colors_live_in_meta_and_never_in_hangars_files() {
        let dir = TempDir::new("service-colors");
        let service = service(&dir);
        let folder = NoteFolder::general();
        let note = service
            .create_untitled(&folder, "Notiz", NoteColor::Mint)
            .unwrap();
        assert_eq!(note.title, "Notiz 1");
        assert!(note.auto_titled);
        assert_eq!(note.color, NoteColor::Mint);
        service
            .set_color(&folder, &note.id, NoteColor::Rose)
            .unwrap();
        let rows = service.list_notes(&folder).unwrap();
        assert_eq!(rows[0].color, NoteColor::Rose);
        let index = std::fs::read_to_string(dir.path().join("notes/general/folder.json")).unwrap();
        assert!(
            !index.contains("rose") && !index.contains("color"),
            "{index}"
        );
        // An unknown note gets no entry.
        assert!(service
            .set_color(
                &folder,
                "1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5",
                NoteColor::Sky
            )
            .is_err());
    }

    /// A folder.json that is not JSON is set aside and rebuilt under the derived IDs. A note
    /// Hangar's files already carried under its derived ID keeps its color through that; a note
    /// whose random ID only the lost index knew gets its derived ID, and its color entry stays in
    /// meta.json under the old ID (back if the `.broken-` copy is restored by hand).
    #[test]
    fn colors_of_derived_ids_survive_a_rebuilt_index() {
        let dir = TempDir::new("service-rebuilt");
        let service = service(&dir);
        let folder = NoteFolder::general();
        let own = service
            .create_untitled(&folder, "Note", NoteColor::Mint)
            .unwrap();
        let scope = dir.path().join("notes/general");
        std::fs::write(scope.join("Idea.md"), "marker-idea-7d1").unwrap();
        let idea = "ac27f523-b8fe-4881-8d5d-7d91b6d8f214";
        assert!(service
            .list_notes(&folder)
            .unwrap()
            .iter()
            .any(|n| n.id == idea));
        service.set_color(&folder, idea, NoteColor::Rose).unwrap();
        std::fs::write(scope.join("folder.json"), "{ cut off").unwrap();
        let rows = service.list_notes(&folder).unwrap();
        assert_eq!(rows.len(), 2);
        let row = rows.iter().find(|n| n.id == idea).unwrap();
        assert_eq!(row.color, NoteColor::Rose);
        assert!(rows.iter().all(|n| n.id != own.id));
        // A fresh start reads the rebuilt index: same IDs, same colors.
        let again = self::service(&dir).list_notes(&folder).unwrap();
        assert_eq!(
            again.iter().map(|n| (&n.id, n.color)).collect::<Vec<_>>(),
            rows.iter().map(|n| (&n.id, n.color)).collect::<Vec<_>>()
        );
    }

    #[test]
    fn a_rename_by_the_person_ends_the_auto_title() {
        let dir = TempDir::new("service-title");
        let service = service(&dir);
        let folder = NoteFolder::general();
        let note = service
            .create_untitled(&folder, "Note", NoteColor::Lemon)
            .unwrap();
        service
            .rename(&folder, &note.id, "From the first line", false)
            .unwrap();
        assert!(service.open_note(&folder, &note.id).unwrap().auto_titled);
        service.rename(&folder, &note.id, "Mine", true).unwrap();
        assert!(!service.open_note(&folder, &note.id).unwrap().auto_titled);
    }

    #[test]
    fn deleting_takes_a_note_off_the_desktop_and_restoring_keeps_its_color() {
        let dir = TempDir::new("service-trash");
        let service = service(&dir);
        let folder = NoteFolder::general();
        let id = service
            .create_with_text(&folder, "Review", "- [ ] one", NoteColor::Peach)
            .unwrap();
        let key = NotesService::key(&folder, &id).unwrap();
        service
            .meta()
            .update(&key.scope, &key.id, |look| look.open = true)
            .unwrap();
        assert!(service.is_on_desktop(&folder, &id));
        service.delete(&folder, &id).unwrap();
        assert!(!service.is_on_desktop(&folder, &id));
        let trash = service.list_trash(&folder).unwrap();
        assert_eq!(trash[0].color, NoteColor::Peach);
        let restored = service.restore(&folder, &id).unwrap();
        assert_eq!(
            service.look(&folder, &restored).unwrap().color,
            NoteColor::Peach
        );
        assert_eq!(
            service.open_note(&folder, &restored).unwrap().text,
            "- [ ] one"
        );
    }

    /// Security review B2: once a note is on the desktop, the notes area's write is refused.
    #[test]
    fn the_notes_area_does_not_write_a_note_on_the_desktop() {
        let dir = TempDir::new("service-on-desktop");
        let service = service(&dir);
        let folder = NoteFolder::general();
        let id = service
            .create_with_text(&folder, "Plan", "first", NoteColor::Sky)
            .unwrap();
        let key = NotesService::key(&folder, &id).unwrap();
        service.set_open(&key, true).unwrap();
        assert!(matches!(
            service.write(Editor::Hub, &folder, &id, "from the list", None),
            Err(ServiceError::OnDesktop)
        ));
        assert_eq!(service.open_note(&folder, &id).unwrap().text, "first");
        service
            .write(Editor::Sticky, &folder, &id, "from the desktop", None)
            .unwrap();
        assert_eq!(
            service.open_note(&folder, &id).unwrap().text,
            "from the desktop"
        );
    }

    /// Security review B2: a sticky note that writes after it was taken off the desktop is
    /// refused, and the file stays as it was.
    #[test]
    fn a_sticky_note_does_not_write_once_it_left_the_desktop() {
        let dir = TempDir::new("service-not-open");
        let service = service(&dir);
        let folder = NoteFolder::general();
        let id = service
            .create_with_text(&folder, "Plan", "kept", NoteColor::Sky)
            .unwrap();
        let key = NotesService::key(&folder, &id).unwrap();
        // Never on the desktop, and on it then off it again.
        assert!(matches!(
            service.write(Editor::Sticky, &folder, &id, "late", None),
            Err(ServiceError::NotOpen)
        ));
        service.set_open(&key, true).unwrap();
        service.set_open(&key, false).unwrap();
        let file = service.store().note_path(&folder, &id).unwrap();
        let before = std::fs::read(&file).unwrap();
        assert!(matches!(
            service.write(Editor::Sticky, &folder, &id, "late", None),
            Err(ServiceError::NotOpen)
        ));
        assert_eq!(std::fs::read(&file).unwrap(), before);
        service
            .write(Editor::Hub, &folder, &id, "list again", None)
            .unwrap();
    }

    /// Security review B2, under load: the notes area keeps writing while the note goes onto the
    /// desktop and its sticky note writes. With the check and the write apart, a write of the
    /// notes area that passed the check before the switch could land after it; under the editor
    /// lock it never does.
    #[test]
    fn no_write_of_the_notes_area_lands_after_the_switch() {
        use std::sync::mpsc;
        use std::time::Duration;
        // The first write of the notes area in each round reports its passed check and then
        // waits up to `HOLD` for the test to have switched. Without the editor lock the switch
        // and the sticky note's write (a few milliseconds of atomic writes) fit in it and end the
        // wait at once; with it the switch waits for the write and the wait runs out. Every round
        // forces that order, so a few rounds are enough; rounds times `HOLD` is the test's length.
        const HOLD: Duration = Duration::from_millis(50);
        const ROUNDS: usize = 20;
        let dir = TempDir::new("service-switch");
        let (checked_tx, checked) = mpsc::channel::<()>();
        let (go, go_rx) = mpsc::channel::<()>();
        let go_rx = Arc::new(Mutex::new(go_rx));
        let checked_tx = Mutex::new(checked_tx);
        let mut hooked = service(&dir);
        // Armed once per round: only the first write of the notes area waits.
        let armed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let armed_hook = Arc::clone(&armed);
        let hook_go = Arc::clone(&go_rx);
        hooked.after_hub_check = Some(TestHook(Arc::new(move || {
            if armed_hook.swap(false, std::sync::atomic::Ordering::SeqCst) {
                let _ = lock(&checked_tx).send(());
                let _ = lock(&hook_go).recv_timeout(HOLD);
            }
        })));
        let service = Arc::new(hooked);
        let folder = NoteFolder::general();
        let id = service
            .create_with_text(&folder, "Race", "start", NoteColor::Sky)
            .unwrap();
        let key = NotesService::key(&folder, &id).unwrap();
        for round in 0..ROUNDS {
            service.set_open(&key, false).unwrap();
            // A `go` the last round sent after its wait ran out would end this round's wait at
            // once.
            while checked.try_recv().is_ok() {}
            while lock(&go_rx).try_recv().is_ok() {}
            armed.store(true, std::sync::atomic::Ordering::SeqCst);
            let hub = {
                let service = Arc::clone(&service);
                let folder = folder.clone();
                let id = id.clone();
                std::thread::spawn(move || loop {
                    match service.write(Editor::Hub, &folder, &id, "hub", None) {
                        Ok(_) => {}
                        Err(ServiceError::OnDesktop) => return,
                        Err(other) => panic!("{other}"),
                    }
                })
            };
            checked.recv().unwrap();
            service.set_open(&key, true).unwrap();
            // What the sticky note reads when it opens: no write of the notes area may follow.
            let at_switch = service.store().read_note(&folder, &id).unwrap();
            let _ = go.send(());
            hub.join().unwrap();
            assert_eq!(
                service.store().read_note(&folder, &id).unwrap(),
                at_switch,
                "round {round}: the notes area wrote after the switch"
            );
            service
                .write(Editor::Sticky, &folder, &id, "sticky", None)
                .unwrap();
            assert_eq!(
                service.store().read_note(&folder, &id).unwrap(),
                "sticky",
                "round {round}"
            );
        }
    }

    /// Security review B8: a write against an older version is refused with `changed` and writes
    /// nothing; without `expected` it writes as before; every write returns the new version.
    #[test]
    fn a_change_from_outside_is_not_overwritten() {
        let dir = TempDir::new("service-version");
        let service = service(&dir);
        let folder = NoteFolder::general();
        let id = service
            .create_with_text(&folder, "Plan", "read", NoteColor::Sky)
            .unwrap();
        let opened = service.open_note(&folder, &id).unwrap();
        assert!(!opened.version.is_empty());
        let json = serde_json::to_value(&opened).unwrap();
        assert_eq!(json["version"], opened.version.as_str());
        assert_eq!(json["text"], "read");
        // The editor saves twice, each time with the version it got back.
        let first = service
            .write(Editor::Hub, &folder, &id, "one", Some(&opened.version))
            .unwrap();
        let second = service
            .write(Editor::Hub, &folder, &id, "two!", Some(&first))
            .unwrap();
        assert_ne!(first, second);
        assert_eq!(service.open_note(&folder, &id).unwrap().version, second);
        // Another program writes the file.
        let file = service.store().note_path(&folder, &id).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&file, "from outside").unwrap();
        let refused = service.write(Editor::Hub, &folder, &id, "mine", Some(&second));
        assert!(
            matches!(refused, Err(ServiceError::Notes(NotesError::Changed))),
            "{refused:?}"
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "from outside");
        // Without `expected`, as before.
        service
            .write(Editor::Hub, &folder, &id, "mine", None)
            .unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "mine");
        // The sticky note's writes follow the same rule.
        let key = NotesService::key(&folder, &id).unwrap();
        service.set_open(&key, true).unwrap();
        assert!(matches!(
            service.write(Editor::Sticky, &folder, &id, "x", Some("0-0")),
            Err(ServiceError::Notes(NotesError::Changed))
        ));
    }

    /// A rename keeps the file's version (F2 while typing, or the title following the first
    /// line): the editor's next save with the version it holds is not refused as `changed`.
    #[test]
    fn a_rename_keeps_the_version() {
        let dir = TempDir::new("service-rename-version");
        let service = service(&dir);
        let folder = NoteFolder::general();
        let id = service
            .create_with_text(&folder, "Plan", "read", NoteColor::Sky)
            .unwrap();
        let opened = service.open_note(&folder, &id).unwrap();
        let saved = service
            .write(Editor::Hub, &folder, &id, "typed", Some(&opened.version))
            .unwrap();
        let before = service.store().note_path(&folder, &id).unwrap();
        // Past the resolution of any file time, so a rename that touched it would show.
        std::thread::sleep(std::time::Duration::from_millis(20));
        service.rename(&folder, &id, "Plan B", true).unwrap();
        assert_ne!(service.store().note_path(&folder, &id).unwrap(), before);
        assert_eq!(service.open_note(&folder, &id).unwrap().version, saved);
        let next = service
            .write(Editor::Hub, &folder, &id, "typed on", Some(&saved))
            .unwrap();
        // Renamed again after the first line, and by case alone.
        service.rename(&folder, &id, "typed on", false).unwrap();
        service.rename(&folder, &id, "Typed On", true).unwrap();
        let last = service
            .write(Editor::Hub, &folder, &id, "typed on and on", Some(&next))
            .unwrap();
        // The sticky note's saves follow the same rule.
        let key = NotesService::key(&folder, &id).unwrap();
        service.set_open(&key, true).unwrap();
        service
            .rename(&folder, &id, "On the desktop", true)
            .unwrap();
        service
            .write(
                Editor::Sticky,
                &folder,
                &id,
                "from the desktop",
                Some(&last),
            )
            .unwrap();
        assert_eq!(
            service.open_note(&folder, &id).unwrap().text,
            "from the desktop"
        );
    }

    /// A note in the trash is written by no editor: the notes area gets `not-found`, with or
    /// without `expected`; its sticky note, taken off the desktop by the delete, `not-open`. No
    /// file anywhere takes the late text, and the trashed one keeps its own.
    #[test]
    fn a_note_in_the_trash_is_not_written() {
        let dir = TempDir::new("service-trash-write");
        let service = service(&dir);
        let folder = NoteFolder::general();
        let id = service
            .create_with_text(&folder, "Plan", "marker-kept-7c2", NoteColor::Sky)
            .unwrap();
        let opened = service.open_note(&folder, &id).unwrap();
        let key = NotesService::key(&folder, &id).unwrap();
        service.set_open(&key, true).unwrap();
        service.delete(&folder, &id).unwrap();
        for (editor, expected, code) in [
            (Editor::Hub, None, "not-found"),
            (Editor::Hub, Some(opened.version.as_str()), "not-found"),
            (Editor::Sticky, None, NOT_OPEN_CODE),
            (Editor::Sticky, Some(opened.version.as_str()), NOT_OPEN_CODE),
        ] {
            let refused = service.write(editor, &folder, &id, "marker-late-7c2", expected);
            let error = refused.expect_err("a trashed note was written");
            assert_eq!(error.code(), code, "{editor:?} {error:?}");
        }
        assert_eq!(service.list_trash(&folder).unwrap().len(), 1);
        assert!(service.store().note_path(&folder, &id).is_err());
        let mut texts = Vec::new();
        let mut stack = vec![dir.path().to_path_buf()];
        while let Some(next) = stack.pop() {
            for entry in std::fs::read_dir(&next).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if let Ok(text) = std::fs::read_to_string(&path) {
                    texts.push(text);
                }
            }
        }
        assert!(!texts.iter().any(|text| text.contains("marker-late-7c2")));
        assert!(texts.iter().any(|text| text == "marker-kept-7c2"));
    }

    /// Security review N2: a new sticky note's place and `open` are set in one step, under the
    /// editor lock, and from then on the notes area does not write it.
    #[test]
    fn opening_with_a_place_is_one_step_under_the_editor_rule() {
        let dir = TempDir::new("service-open-with");
        let service = service(&dir);
        let folder = NoteFolder::general();
        let id = service
            .create_with_text(&folder, "Plan", "first", NoteColor::Sky)
            .unwrap();
        let key = NotesService::key(&folder, &id).unwrap();
        let place = crate::meta::Bounds {
            x: 40.0,
            y: 60.0,
            width: 320.0,
            height: 280.0,
        };
        let look = service
            .set_open_with(&key, true, |look| {
                // `open` is the caller's argument, never the closure's.
                look.open = false;
                look.bounds = Some(place);
            })
            .unwrap();
        assert!(look.open);
        assert_eq!(look.bounds, Some(place));
        assert_eq!(service.meta().get(&key.scope, &key.id), look);
        assert!(matches!(
            service.write(Editor::Hub, &folder, &id, "from the list", None),
            Err(ServiceError::OnDesktop)
        ));
    }

    /// A new sticky note answers as being on the desktop: the note is read before it goes there.
    #[test]
    fn a_new_sticky_note_answers_as_on_the_desktop() {
        let dir = TempDir::new("service-new-sticky");
        let service = service(&dir);
        let folder = NoteFolder::general();
        let place = crate::meta::Bounds {
            x: 40.0,
            y: 60.0,
            width: 320.0,
            height: 280.0,
        };
        let (note, look) = service
            .create_untitled_on_desktop(&folder, "Notiz", NoteColor::Mint, |look| {
                look.bounds = Some(place);
            })
            .unwrap();
        assert!(note.on_desktop);
        assert!(look.open);
        assert_eq!(look.bounds, Some(place));
        assert_eq!(note.title, "Notiz 1");
        assert!(note.auto_titled);
        assert_eq!(note.color, NoteColor::Mint);
        assert_eq!(service.open_note(&folder, &note.id).unwrap(), note);
        assert!(matches!(
            service.write(Editor::Hub, &folder, &note.id, "from the list", None),
            Err(ServiceError::OnDesktop)
        ));
    }

    #[test]
    fn search_hits_and_excerpts_carry_what_the_list_needs() {
        let dir = TempDir::new("service-search");
        let service = service(&dir);
        let folder = NoteFolder::general();
        let id = service
            .create_with_text(&folder, "Plan", "Ship\n\nthe   release", NoteColor::Sky)
            .unwrap();
        let hits = service.search("release").unwrap();
        assert_eq!(hits[0].hit.id, id);
        assert_eq!(hits[0].color, NoteColor::Sky);
        let json = serde_json::to_value(&hits[0]).unwrap();
        assert_eq!(json["color"], "sky");
        assert_eq!(json["title"], "Plan");
        let excerpts = service.excerpts(&folder, 10).unwrap();
        assert_eq!(excerpts[0].excerpt, "Ship the release");
        assert!(service
            .create_with_text(
                &folder,
                "x",
                &"x".repeat(MAX_NOTE_BYTES + 1),
                NoteColor::Sky
            )
            .is_err());
    }
}
