//! Tauri commands: thin wrappers that check the calling window and hand over to the notes service
//! (`service.rs`), the settings and the windows. Every command is async, so none runs on the main
//! thread: building a window there deadlocks on Windows, and the editors' answers to a save
//! request arrive through it.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter as _, Manager as _, State, WebviewWindow};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_clipboard_manager::ClipboardExt as _;

use crate::access::{Access, AccessGate, RootKind};
use crate::export::{self, ExportError};
use crate::meta::NoteColor;
use crate::notes::{FolderInfo, NoteFolder};
use crate::replies::{NoteReply, Replies};
use crate::requests::{HubRequest, Requests};
use crate::service::{Editor, HitRow, NoteRow, NotesService, OpenedNote, TrashRow};
use crate::settings::{Settings, SettingsStore};
use crate::tray::{self, TrayLabels};
use crate::windows::{self, checked_key, notify_hub, AppError, BoundsSaver, HUB_LABEL};

type Service<'a> = State<'a, Arc<NotesService>>;

/// The settings plus "Start with the system", which is the OS state, not a stored value.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    #[serde(flatten)]
    pub settings: Settings,
    pub autostart: bool,
}

/// What every window needs to know about the notes folder.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusView {
    pub access: Access,
    pub root_kind: RootKind,
    /// The folder "This project" stands for, `null` without one.
    pub project: Option<PathBuf>,
}

fn hub_only(window: &WebviewWindow) -> Result<(), AppError> {
    if window.label() == HUB_LABEL {
        Ok(())
    } else {
        Err(AppError::NotAllowed)
    }
}

#[tauri::command]
pub async fn get_status(
    access: State<'_, AccessGate>,
    requests: State<'_, Requests>,
) -> Result<StatusView, AppError> {
    Ok(StatusView {
        // Hangar may have handed the folder over since the last look.
        access: access.refresh(),
        root_kind: access.root().kind,
        project: requests.project(),
    })
}

#[tauri::command]
pub async fn take_hub_requests(
    window: WebviewWindow,
    requests: State<'_, Requests>,
) -> Result<Vec<HubRequest>, AppError> {
    hub_only(&window)?;
    Ok(requests.take())
}

#[tauri::command]
pub async fn list_note_folders(
    window: WebviewWindow,
    service: Service<'_>,
) -> Result<Vec<FolderInfo>, AppError> {
    hub_only(&window)?;
    Ok(service.list_folders()?)
}

#[tauri::command]
pub async fn list_notes(
    window: WebviewWindow,
    service: Service<'_>,
    folder: NoteFolder,
) -> Result<Vec<NoteRow>, AppError> {
    hub_only(&window)?;
    Ok(service.list_notes(&folder)?)
}

#[tauri::command]
pub async fn search_notes(
    window: WebviewWindow,
    service: Service<'_>,
    query: String,
) -> Result<Vec<HitRow>, AppError> {
    hub_only(&window)?;
    Ok(service.search(&query)?)
}

#[tauri::command]
pub async fn read_note(
    window: WebviewWindow,
    service: Service<'_>,
    folder: NoteFolder,
    id: String,
) -> Result<OpenedNote, AppError> {
    checked_key(window.label(), &folder, &id)?;
    Ok(service.open_note(&folder, &id)?)
}

/// The note of the calling sticky window.
#[tauri::command]
pub async fn get_sticky(
    window: WebviewWindow,
    service: Service<'_>,
) -> Result<OpenedNote, AppError> {
    windows::sticky_note(&service, window.label())
}

/// Saves a note; returns the file's new version. `expected`: the version the editor read (or last
/// wrote); if the file has another one, nothing is written and the answer is `changed` (B8).
/// One editor per note (B2): the notes area gets `on-desktop` for a note on the desktop, a sticky
/// note `not-open` for its note once it left the desktop.
#[tauri::command]
pub async fn write_note(
    app: AppHandle,
    window: WebviewWindow,
    service: Service<'_>,
    folder: NoteFolder,
    id: String,
    text: String,
    expected: Option<String>,
) -> Result<String, AppError> {
    checked_key(window.label(), &folder, &id)?;
    let editor = if window.label() == HUB_LABEL {
        Editor::Hub
    } else {
        Editor::Sticky
    };
    let version = service.write(editor, &folder, &id, &text, expected.as_deref())?;
    if editor == Editor::Sticky {
        notify_hub(&app);
    }
    Ok(version)
}

/// A sticky note saves its own text; the note is the one its window shows. Like `write_note`:
/// `expected`, the new version back, `not-open` once the note left the desktop.
#[tauri::command]
pub async fn write_sticky(
    app: AppHandle,
    window: WebviewWindow,
    service: Service<'_>,
    text: String,
    expected: Option<String>,
) -> Result<String, AppError> {
    let key = windows::sticky_of(window.label()).ok_or(AppError::NotAllowed)?;
    let folder = windows::folder_of(&service, &key)?;
    let version = service.write(Editor::Sticky, &folder, &key.id, &text, expected.as_deref())?;
    notify_hub(&app);
    Ok(version)
}

/// A new, empty note in `folder` titled "`base` N", for the notes area's quick note.
#[tauri::command]
pub async fn create_note(
    window: WebviewWindow,
    service: Service<'_>,
    settings: State<'_, SettingsStore>,
    folder: NoteFolder,
    base: String,
) -> Result<OpenedNote, AppError> {
    hub_only(&window)?;
    Ok(service.create_untitled(&folder, &base, settings.get().new_note_color)?)
}

/// "New note" in a sticky note: a new sticky note in the same scope, next to it.
#[tauri::command]
pub async fn new_sticky(
    app: AppHandle,
    window: WebviewWindow,
    service: Service<'_>,
    settings: State<'_, SettingsStore>,
    base: String,
) -> Result<OpenedNote, AppError> {
    let from = windows::sticky_of(window.label()).map(|_| window.label().to_owned());
    windows::create_sticky(&app, &service, &settings, from.as_deref(), &base)
}

/// `byPerson`: the person chose the title (F2), else it follows the first line.
#[tauri::command]
pub async fn rename_note(
    app: AppHandle,
    window: WebviewWindow,
    service: Service<'_>,
    folder: NoteFolder,
    id: String,
    title: String,
    by_person: bool,
) -> Result<(), AppError> {
    let key = checked_key(window.label(), &folder, &id)?;
    service.rename(&folder, &id, &title, by_person)?;
    // The sticky window's title follows, also when the title follows the first line.
    windows::retitle_sticky(&app, &service, &key);
    notify_hub(&app);
    Ok(())
}

#[tauri::command]
pub async fn delete_note(
    app: AppHandle,
    window: WebviewWindow,
    service: Service<'_>,
    saver: State<'_, BoundsSaver>,
    replies: State<'_, Replies>,
    folder: NoteFolder,
    id: String,
) -> Result<(), AppError> {
    checked_key(window.label(), &folder, &id)?;
    windows::delete_note(
        &app,
        &service,
        &saver,
        &replies,
        window.label(),
        &folder,
        &id,
    )
}

/// An editor's answer to `note-delete-requested` or `note-flush-requested`: whether everything
/// typed is on disk.
#[tauri::command]
pub async fn note_flushed(
    window: WebviewWindow,
    replies: State<'_, Replies>,
    saved: bool,
) -> Result<(), AppError> {
    let label = window.label();
    if label != HUB_LABEL && windows::sticky_of(label).is_none() {
        return Err(AppError::NotAllowed);
    }
    let reply = if saved {
        NoteReply::Saved
    } else {
        NoteReply::NotSaved
    };
    replies.answer(label, reply);
    Ok(())
}

#[tauri::command]
pub async fn list_trash(
    window: WebviewWindow,
    service: Service<'_>,
    folder: NoteFolder,
) -> Result<Vec<TrashRow>, AppError> {
    hub_only(&window)?;
    Ok(service.list_trash(&folder)?)
}

#[tauri::command]
pub async fn restore_note(
    window: WebviewWindow,
    service: Service<'_>,
    folder: NoteFolder,
    id: String,
) -> Result<String, AppError> {
    hub_only(&window)?;
    Ok(service.restore(&folder, &id)?)
}

#[tauri::command]
pub async fn set_note_color(
    app: AppHandle,
    window: WebviewWindow,
    service: Service<'_>,
    folder: NoteFolder,
    id: String,
    color: NoteColor,
) -> Result<NoteColor, AppError> {
    let key = checked_key(window.label(), &folder, &id)?;
    let look = service.set_color(&folder, &id, color)?;
    windows::notify_sticky(&app, &key, &look);
    notify_hub(&app);
    Ok(look.color)
}

#[tauri::command]
pub async fn set_note_on_top(
    window: WebviewWindow,
    service: Service<'_>,
    on_top: bool,
) -> Result<bool, AppError> {
    let key = windows::sticky_of(window.label()).ok_or(AppError::NotAllowed)?;
    let look = service
        .meta()
        .update(&key.scope, &key.id, |look| look.on_top = on_top)?;
    window.set_always_on_top(look.on_top)?;
    Ok(look.on_top)
}

/// Puts a note on the desktop, or brings its sticky note to the front ("Bring to front").
#[tauri::command]
pub async fn to_desktop(
    app: AppHandle,
    window: WebviewWindow,
    service: Service<'_>,
    folder: NoteFolder,
    id: String,
) -> Result<(), AppError> {
    hub_only(&window)?;
    windows::open_sticky(&app, &service, &folder, &id)
}

/// "Back into the list": the sticky note saves and closes, the notes area edits it again.
#[tauri::command]
pub async fn from_desktop(
    app: AppHandle,
    window: WebviewWindow,
    service: Service<'_>,
    saver: State<'_, BoundsSaver>,
    replies: State<'_, Replies>,
    folder: NoteFolder,
    id: String,
) -> Result<(), AppError> {
    hub_only(&window)?;
    let key = NotesService::key(&folder, &id)?;
    windows::return_sticky(&app, &service, &saver, &replies, &key)
}

/// A sticky note closes itself (its close button, Alt+F4) after it saved.
#[tauri::command]
pub async fn close_note(
    app: AppHandle,
    window: WebviewWindow,
    service: Service<'_>,
    saver: State<'_, BoundsSaver>,
) -> Result<(), AppError> {
    let key = windows::sticky_of(window.label()).ok_or(AppError::NotAllowed)?;
    windows::close_sticky(&app, &service, &saver, &key)
}

/// Saves a note as `.md`: the backend opens the save dialog, so the window never chooses a path.
/// `null` when the dialog was cancelled, otherwise the path written.
#[tauri::command]
pub async fn export_note(
    app: AppHandle,
    window: WebviewWindow,
    service: Service<'_>,
    folder: NoteFolder,
    id: String,
) -> Result<Option<String>, AppError> {
    use tauri_plugin_dialog::DialogExt as _;
    hub_only(&window)?;
    let (title, content) = service.store().note_for_export(&folder, &id)?;
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_parent(&window)
            .set_file_name(export::note_file_name(&title))
            .add_filter(export::NOTE_FILTER, &[export::NOTE_EXTENSION])
            .blocking_save_file()
    })
    .await
    .map_err(|error| AppError::Task(error.to_string()))?;
    let Some(chosen) = chosen else {
        return Ok(None);
    };
    let path = chosen.into_path().map_err(|_| ExportError::NotAPath)?;
    export::write(&path, &content)?;
    Ok(Some(path.display().to_string()))
}

#[tauri::command]
pub async fn reveal_note(
    window: WebviewWindow,
    service: Service<'_>,
    folder: NoteFolder,
    id: String,
) -> Result<(), AppError> {
    hub_only(&window)?;
    let path = service.store().note_path(&folder, &id)?;
    crate::desktop::reveal(&path)
        .map_err(|source| crate::notes::NotesError::Io { path, source })?;
    Ok(())
}

#[tauri::command]
pub async fn reveal_notes_folder(
    window: WebviewWindow,
    service: Service<'_>,
    folder: NoteFolder,
) -> Result<(), AppError> {
    hub_only(&window)?;
    let path = service.store().folder_dir(&folder)?;
    crate::desktop::open_folder(&path)
        .map_err(|source| crate::notes::NotesError::Io { path, source })?;
    Ok(())
}

/// "Copy as Markdown": the saved text goes onto the clipboard from the backend.
#[tauri::command]
pub async fn copy_note(
    app: AppHandle,
    window: WebviewWindow,
    service: Service<'_>,
    folder: NoteFolder,
    id: String,
) -> Result<(), AppError> {
    checked_key(window.label(), &folder, &id)?;
    let text = service.store().read_note(&folder, &id)?;
    app.clipboard()
        .write_text(text)
        .map_err(|error| AppError::Clipboard(error.to_string()))
}

/// "Copy as Markdown" of text that exists only in a window: a capture that could not become a
/// note, or a note whose save keeps failing. The notes area and sticky notes only, at most one
/// note's size; the text is never logged and never part of an error.
#[tauri::command]
pub async fn copy_text(
    app: AppHandle,
    window: WebviewWindow,
    text: String,
) -> Result<(), AppError> {
    windows::check_copy(window.label(), &text)?;
    app.clipboard()
        .write_text(text)
        .map_err(|error| AppError::Clipboard(error.to_string()))
}

#[tauri::command]
pub async fn open_hub(app: AppHandle) -> Result<(), AppError> {
    windows::open_hub(&app)
}

#[tauri::command]
pub async fn get_settings(
    app: AppHandle,
    settings: State<'_, SettingsStore>,
) -> Result<SettingsView, AppError> {
    // A platform without autostart support reads as "off" rather than failing the settings.
    let autostart = app.autolaunch().is_enabled().unwrap_or(false);
    Ok(SettingsView {
        settings: settings.get(),
        autostart,
    })
}

#[tauri::command]
pub async fn set_settings(
    app: AppHandle,
    window: WebviewWindow,
    settings: State<'_, SettingsStore>,
    value: Settings,
) -> Result<Settings, AppError> {
    hub_only(&window)?;
    let saved = settings.set(value)?;
    windows::apply_theme(&app, saved.theme);
    let _ = app.emit(windows::SETTINGS_CHANGED_EVENT, &saved);
    Ok(saved)
}

/// "Always on top" of the notes area: stored in `settings.json`, applied now and on every start.
/// Returns the stored value; every window gets the new settings.
#[tauri::command]
pub async fn set_hub_on_top(
    app: AppHandle,
    window: WebviewWindow,
    settings: State<'_, SettingsStore>,
    on_top: bool,
) -> Result<bool, AppError> {
    hub_only(&window)?;
    let saved = settings.set_hub_on_top(on_top)?;
    window.set_always_on_top(saved.hub_on_top)?;
    let _ = app.emit(windows::SETTINGS_CHANGED_EVENT, &saved);
    Ok(saved.hub_on_top)
}

#[tauri::command]
pub async fn set_autostart(
    app: AppHandle,
    window: WebviewWindow,
    enabled: bool,
) -> Result<bool, AppError> {
    hub_only(&window)?;
    let autolaunch = app.autolaunch();
    let result = if enabled {
        autolaunch.enable()
    } else {
        autolaunch.disable()
    };
    result.map_err(|error| AppError::Autostart(error.to_string()))?;
    autolaunch
        .is_enabled()
        .map_err(|error| AppError::Autostart(error.to_string()))
}

#[tauri::command]
pub async fn set_tray_labels(
    app: AppHandle,
    window: WebviewWindow,
    service: Service<'_>,
    labels: TrayLabels,
) -> Result<(), AppError> {
    let hub_exists = app.get_webview_window(HUB_LABEL).is_some();
    if !tray::may_set_labels(window.label(), hub_exists, &tray::current_labels(&app)) {
        return Err(AppError::NotAllowed);
    }
    tray::set_labels(&app, &labels)?;
    // An untitled sticky window is named in the language these texts come in.
    windows::retitle_stickies(&app, &service);
    Ok(())
}

/// The calling window has rendered its view: show it.
#[tauri::command]
pub async fn window_ready(window: WebviewWindow) -> Result<(), AppError> {
    windows::show_and_focus(&window);
    Ok(())
}
