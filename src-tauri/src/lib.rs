//! Hangar Note: sticky notes on the desktop (ADR 0001, docs/wiki/pages/decisions/0001-foundation.md).

pub mod bounds;
pub mod commands;
pub mod replies;
pub mod settings;
pub mod store;
pub mod tray;
pub mod windows;

#[cfg(test)]
mod test_support;

use std::sync::Arc;

use tauri::{Manager as _, RunEvent};

use crate::replies::{QuitMemory, Replies};
use crate::settings::SettingsStore;
use crate::store::Store;
use crate::windows::BoundsSaver;

pub fn run() -> tauri::Result<()> {
    let app = tauri::Builder::default()
        // First of all plugins, so a second start hands over and exits before anything else
        // runs. Unlike Hangar, debug builds are not exempt: a dev build and an installed one share
        // the same notes folder, and two writers of one index would lose changes.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // No command line contract: the arguments are deliberately ignored.
            if let Err(error) = windows::open_hub(app) {
                eprintln!("hangar-note: All notes not opened: {error}");
            }
        }))
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .on_window_event(windows::on_window_event)
        .setup(|app| {
            let data_dir = app.path().app_local_data_dir()?;
            let store = Arc::new(Store::open(&data_dir.join(store::NOTES_DIR))?);
            app.manage(SettingsStore::open(&data_dir));
            app.manage(BoundsSaver::start(store.clone()));
            app.manage(store.clone());
            app.manage(Replies::default());
            app.manage(QuitMemory::default());
            if let Err(error) = tray::create(app.handle()) {
                eprintln!("hangar-note: no notification area icon: {error}");
            }
            windows::restore(app.handle(), &store)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_notes,
            commands::read_note,
            commands::write_note,
            commands::create_note,
            commands::set_note_color,
            commands::set_note_on_top,
            commands::delete_note,
            commands::note_flushed,
            commands::list_trash,
            commands::restore_note,
            commands::open_note,
            commands::close_note,
            commands::open_hub,
            commands::get_settings,
            commands::set_settings,
            commands::set_autostart,
            commands::set_tray_labels,
            commands::window_ready,
        ])
        .build(tauri::generate_context!())?;

    app.run(|handle, event| match event {
        // The last window closed: with a tray icon the app keeps running there.
        RunEvent::ExitRequested {
            code: None, api, ..
        } if tray::present(handle) => api.prevent_exit(),
        RunEvent::Exit => handle.state::<BoundsSaver>().flush(None),
        _ => {}
    });
    Ok(())
}
