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

#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    #[error(transparent)]
    Notes(#[from] NotesError),
    #[error(transparent)]
    Meta(#[from] MetaError),
}

impl Serialize for ServiceError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
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

/// A note's start for Hangar's handover (`excerpts` route).
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

#[derive(Debug)]
pub struct NotesService {
    store: NotesStore,
    meta: MetaStore,
    auto_titled: Mutex<HashSet<NoteKey>>,
}

impl NotesService {
    pub fn new(store: NotesStore, meta: MetaStore) -> Self {
        Self {
            store,
            meta,
            auto_titled: Mutex::default(),
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
        let text = self.store.read_note(folder, &key.id)?;
        let title = self.store.title(folder, &key.id)?;
        let look = self.meta.get(&key.scope, &key.id);
        Ok(OpenedNote {
            auto_titled: lock(&self.auto_titled).contains(&key),
            folder_key: key.scope,
            path: folder.path.clone(),
            id: key.id,
            title,
            text,
            color: look.color,
            on_desktop: look.open,
            on_top: look.on_top,
        })
    }

    pub fn write(&self, folder: &NoteFolder, id: &str, text: &str) -> Result<(), ServiceError> {
        Ok(self.store.write_note(folder, id, text)?)
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
