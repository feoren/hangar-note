//! Tauri commands: thin wrappers that check the calling window and hand over to `store`,
//! `settings` and `windows`. Every command that creates or closes a window is async: a
//! synchronous command runs on the main thread, and building a window there deadlocks on Windows.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter as _, State, WebviewWindow};
use tauri_plugin_autostart::ManagerExt as _;

use crate::replies::{NoteReply, Replies};
use crate::settings::{Settings, SettingsStore};
use crate::store::{NoteColor, NoteContent, NoteMeta, NoteSummary, Store, TrashItem};
use crate::tray::{self, TrayLabels};
use crate::windows::{self, check_access, AppError, BoundsSaver, HUB_LABEL};

/// The settings plus "Start with the system", which is the OS state, not a stored value.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    #[serde(flatten)]
    pub settings: Settings,
    pub autostart: bool,
}

fn hub_only(window: &WebviewWindow) -> Result<(), AppError> {
    if window.label() == HUB_LABEL {
        Ok(())
    } else {
        Err(AppError::NotAllowed)
    }
}

#[tauri::command]
pub async fn list_notes(
    window: WebviewWindow,
    store: State<'_, Arc<Store>>,
) -> Result<Vec<NoteSummary>, AppError> {
    hub_only(&window)?;
    Ok(store.list())
}

#[tauri::command]
pub async fn read_note(
    window: WebviewWindow,
    store: State<'_, Arc<Store>>,
    id: String,
) -> Result<NoteContent, AppError> {
    check_access(window.label(), &id)?;
    Ok(store.read(&id)?)
}

#[tauri::command]
pub async fn write_note(
    app: AppHandle,
    window: WebviewWindow,
    store: State<'_, Arc<Store>>,
    id: String,
    text: String,
) -> Result<NoteMeta, AppError> {
    check_access(window.label(), &id)?;
    let meta = store.write(&id, &text)?;
    let _ = app.emit_to(HUB_LABEL, windows::NOTES_CHANGED_EVENT, ());
    Ok(meta)
}

#[tauri::command]
pub async fn create_note(
    app: AppHandle,
    window: WebviewWindow,
    store: State<'_, Arc<Store>>,
    settings: State<'_, SettingsStore>,
) -> Result<NoteMeta, AppError> {
    windows::create_note(&app, &store, &settings, Some(window.label()))
}

#[tauri::command]
pub async fn set_note_color(
    app: AppHandle,
    window: WebviewWindow,
    store: State<'_, Arc<Store>>,
    id: String,
    color: NoteColor,
) -> Result<NoteMeta, AppError> {
    check_access(window.label(), &id)?;
    let meta = store.set_color(&id, color)?;
    let _ = app.emit_to(HUB_LABEL, windows::NOTES_CHANGED_EVENT, ());
    Ok(meta)
}

#[tauri::command]
pub async fn set_note_on_top(
    window: WebviewWindow,
    store: State<'_, Arc<Store>>,
    id: String,
    on_top: bool,
) -> Result<NoteMeta, AppError> {
    check_access(window.label(), &id)?;
    let meta = store.set_on_top(&id, on_top)?;
    window.set_always_on_top(on_top)?;
    Ok(meta)
}

#[tauri::command]
pub async fn delete_note(
    app: AppHandle,
    window: WebviewWindow,
    store: State<'_, Arc<Store>>,
    saver: State<'_, BoundsSaver>,
    replies: State<'_, Replies>,
    id: String,
) -> Result<TrashItem, AppError> {
    check_access(window.label(), &id)?;
    windows::delete_note(&app, &store, &saver, &replies, window.label(), &id)
}

/// A note window's answer to `note-delete-requested` or `note-flush-requested`: whether
/// everything typed is on disk.
#[tauri::command]
pub async fn note_flushed(
    window: WebviewWindow,
    replies: State<'_, Replies>,
    saved: bool,
) -> Result<(), AppError> {
    let id = windows::note_id_of(window.label()).ok_or(AppError::NotAllowed)?;
    let reply = if saved {
        NoteReply::Saved
    } else {
        NoteReply::NotSaved
    };
    replies.answer(&id, reply);
    Ok(())
}

#[tauri::command]
pub async fn list_trash(
    window: WebviewWindow,
    store: State<'_, Arc<Store>>,
) -> Result<Vec<TrashItem>, AppError> {
    hub_only(&window)?;
    Ok(store.list_trash()?)
}

#[tauri::command]
pub async fn restore_note(
    window: WebviewWindow,
    store: State<'_, Arc<Store>>,
    id: String,
) -> Result<NoteMeta, AppError> {
    hub_only(&window)?;
    Ok(store.restore(&id)?)
}

#[tauri::command]
pub async fn open_note(
    app: AppHandle,
    window: WebviewWindow,
    store: State<'_, Arc<Store>>,
    id: String,
) -> Result<(), AppError> {
    check_access(window.label(), &id)?;
    windows::open_note(&app, &store, &id)
}

#[tauri::command]
pub async fn close_note(
    app: AppHandle,
    window: WebviewWindow,
    store: State<'_, Arc<Store>>,
    saver: State<'_, BoundsSaver>,
    id: String,
) -> Result<(), AppError> {
    check_access(window.label(), &id)?;
    windows::close_note(&app, &store, &saver, &id)
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
pub async fn set_tray_labels(app: AppHandle, labels: TrayLabels) -> Result<(), AppError> {
    Ok(tray::set_labels(&app, &labels)?)
}

/// The calling window has rendered its view: show it.
#[tauri::command]
pub async fn window_ready(window: WebviewWindow) -> Result<(), AppError> {
    windows::show_and_focus(&window);
    Ok(())
}
