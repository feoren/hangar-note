//! Hangar Note: Hangar's notes area as an app of its own, with sticky notes on the desktop
//! (ADR 0001, ADR 0002 in `docs/wiki/pages/decisions/`).

pub mod access;
pub mod bounds;
pub mod channel;
pub mod cli;
pub mod commands;
pub mod desktop;
pub mod export;
pub mod fsio;
pub mod install;
pub mod meta;
pub mod notes;
pub mod replies;
pub mod requests;
pub mod service;
pub mod settings;
pub mod tray;
pub mod windows;
#[cfg(windows)]
pub mod winsec;

#[cfg(test)]
mod test_support;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Manager as _, RunEvent, Runtime};

use crate::access::{Access, AccessGate, RootKind};
use crate::channel::{Actions, Channel, ClientError};
use crate::cli::CliCommand;
use crate::meta::MetaStore;
use crate::notes::{NoteFolder, NotesError, NotesStore};
use crate::replies::{QuitMemory, Replies};
use crate::requests::Requests;
use crate::service::{Excerpt, HitRow, NotesService, ServiceError};
use crate::settings::SettingsStore;
use crate::windows::BoundsSaver;

/// The identifier of `tauri.conf.json`; Tauri's `app_local_data_dir` is
/// `dirs::data_local_dir()/<identifier>` (checked in Hangar against tauri 2.12.5).
pub const IDENTIFIER: &str = "com.feoren.hangar-note";
/// `meta.json` of a development root sits inside that root, so a test run never mixes its
/// colors and places into the person's own `meta.json`.
const DEV_META_FILE: &str = ".hangar-note-meta.json";

/// Hangar Note's local data folder, without Tauri (for the `capture` client).
pub fn data_dir() -> Option<PathBuf> {
    dirs::data_local_dir().map(|dir| dir.join(IDENTIFIER))
}

/// The notes root a start would use, without Tauri: what `setup` resolves, from the same values
/// (`app.path().local_data_dir()` is `dirs::data_local_dir()`).
fn start_root() -> Result<access::NotesRoot, access::RootError> {
    access::resolve_root(
        std::env::var_os(access::ROOT_ENV),
        cfg!(debug_assertions),
        dirs::data_local_dir(),
    )
}

/// Whether a start could save a captured text: the development root, or a folder Hangar handed
/// over. Checked before a `capture` becomes the app, so a text that would only be shown and then
/// lost ends with [`cli::EXIT_READ_ONLY`] instead.
pub fn notes_writable_at_start() -> bool {
    start_root()
        .is_ok_and(|root| root.kind == RootKind::Development || access::handed_over(&root.path))
}

/// `hangar-note capture`: hands the text to the running app over the local channel (never in
/// argv, which Windows limits to 32 767 characters). [`ClientError::NotRunning`] and
/// [`ClientError::NotProven`] mean the app has to start itself with the text.
pub fn send_capture(folder: &Path, text: &str) -> Result<(), ClientError> {
    let dir = data_dir().ok_or(ClientError::NotRunning)?;
    let endpoint = channel::read_endpoint(&dir).map_err(|_| ClientError::NotRunning)?;
    channel::post(
        &endpoint,
        "/capture",
        &serde_json::json!({
            "version": channel::MESSAGE_VERSION,
            "folder": folder,
            "text": text,
        }),
    )
    .map(drop)
}

/// What the local channel's routes do in the running app.
struct AppActions {
    app: AppHandle,
}

impl AppActions {
    fn deliver(&self, command: CliCommand, text: Option<String>) {
        let (project, list) = requests::plan(command, text);
        windows::deliver(&self.app, &self.app.state::<Requests>(), project, list);
    }

    fn service(&self) -> Arc<NotesService> {
        self.app.state::<Arc<NotesService>>().inner().clone()
    }
}

impl Actions for AppActions {
    fn open(
        &self,
        folder: Option<PathBuf>,
        shared: bool,
        note: Option<String>,
    ) -> Result<(), ServiceError> {
        self.deliver(
            CliCommand::Open {
                folder,
                shared,
                note,
            },
            None,
        );
        Ok(())
    }

    fn quick(&self, folder: Option<PathBuf>) -> Result<(), ServiceError> {
        self.deliver(CliCommand::Quick { folder }, None);
        Ok(())
    }

    fn capture(&self, folder: PathBuf, text: String) -> Result<(), ServiceError> {
        // The notes area would get a text it cannot save: refused here, so the caller knows.
        // Read only turns writable at most once and never back while the app runs.
        if self.app.state::<AccessGate>().refresh() != Access::Writable {
            return Err(NotesError::ReadOnly.into());
        }
        self.deliver(CliCommand::Capture { folder }, Some(text));
        Ok(())
    }

    fn create(
        &self,
        folder: Option<PathBuf>,
        title: String,
        text: String,
    ) -> Result<String, ServiceError> {
        let color = self.app.state::<SettingsStore>().get().new_note_color;
        let id =
            self.service()
                .create_with_text(&NoteFolder { path: folder }, &title, &text, color)?;
        windows::notify_hub(&self.app);
        Ok(id)
    }

    fn search(&self, query: &str) -> Result<Vec<HitRow>, ServiceError> {
        self.service().search(query)
    }

    fn excerpts(
        &self,
        folder: Option<PathBuf>,
        limit: usize,
    ) -> Result<Vec<Excerpt>, ServiceError> {
        self.service().excerpts(&NoteFolder { path: folder }, limit)
    }

    fn flush(&self) -> bool {
        windows::flush_all(&self.app)
    }
}

/// The running channel and where its endpoint file lies, to remove it on quit.
struct ChannelState {
    channel: Channel,
    dir: PathBuf,
}

/// Removes `endpoint.json` if it is still this run's (a newer start may have replaced it).
fn remove_endpoint(state: &ChannelState) {
    if channel::read_endpoint(&state.dir).is_ok_and(|file| file == state.channel.endpoint()) {
        let _ = std::fs::remove_file(state.dir.join(channel::ENDPOINT_FILE));
    }
}

/// Armed while a `capture` that found no proven app starts the app with its text (security
/// review N4). Should another Hangar Note hold the single instance after all (its channel is
/// missing or broken), the single-instance plugin hands over the arguments only, without the
/// text, runs `cleanup_before_exit` and exits with 0. That cleanup clears the resource table and
/// so drops this guard, which ends the process with [`cli::EXIT_NOT_DELIVERED`] first. The app's
/// own setup disarms it: from there this process is the app and keeps the text.
///
/// Verified in the code of tauri 2.12.7 (`cleanup_before_exit` clears the resource table) and
/// tauri-plugin-single-instance 2.5.5 on Windows and Linux. On macOS the plugin exits without
/// that cleanup, so there a capture in this rare case still exits 0 [UNVERIFIED on macOS].
struct CaptureGuard(Arc<AtomicBool>);

impl tauri::Resource for CaptureGuard {}

impl Drop for CaptureGuard {
    fn drop(&mut self) {
        if self.0.load(Ordering::SeqCst) {
            eprintln!("hangar-note: {}", cli::NOT_DELIVERED_MESSAGE);
            std::process::exit(i32::from(cli::EXIT_NOT_DELIVERED));
        }
    }
}

/// The switch of the [`CaptureGuard`], for the app's setup.
struct CaptureArmed(Arc<AtomicBool>);

/// Registered before the single-instance plugin, so the guard is in place when it decides.
fn capture_guard<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("capture-guard")
        .setup(|app, _api| {
            let armed = Arc::new(AtomicBool::new(true));
            app.resources_table().add(CaptureGuard(armed.clone()));
            app.manage(CaptureArmed(armed));
            Ok(())
        })
        .build()
}

/// Starts the app with the command it was launched with; `capture_text` is the text of a
/// `capture` that found no running app.
pub fn run(command: CliCommand, capture_text: Option<String>) -> tauri::Result<()> {
    let mut builder = tauri::Builder::default();
    if capture_text.is_some() {
        builder = builder.plugin(capture_guard());
    }
    let app = builder
        // First of all plugins (after the capture guard), so a second start hands over and exits
        // before anything else runs. Unlike Hangar, debug builds are not exempt: a dev build and
        // an installed one share Hangar's notes folder, and two writers would lose changes (the
        // writer lock refuses the second one anyway).
        .plugin(tauri_plugin_single_instance::init(
            |app, args, _cwd| match cli::parse_forwarded(&args) {
                Ok(command) => {
                    let (project, list) = requests::plan(command, None);
                    windows::deliver(app, &app.state::<Requests>(), project, list);
                }
                Err(error) => {
                    eprintln!("hangar-note: ignoring the forwarded command line: {error}");
                    if let Err(error) = windows::open_hub(app) {
                        eprintln!("hangar-note: notes area not opened: {error}");
                    }
                }
            },
        ))
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .on_window_event(windows::on_window_event)
        .setup(move |app| {
            // This process is the single instance: whatever comes, it keeps the captured text.
            if let Some(armed) = app.try_state::<CaptureArmed>() {
                armed.0.store(false, Ordering::SeqCst);
            }
            let data_dir = app.path().app_local_data_dir()?;
            fsio::create_private_dir(&data_dir)?;
            let root = access::resolve_root(
                std::env::var_os(access::ROOT_ENV),
                cfg!(debug_assertions),
                app.path().local_data_dir().ok(),
            )
            .map_err(|error| tauri::Error::Anyhow(error.into()))?;
            let meta_path = match root.kind {
                RootKind::Hangar => data_dir.join(meta::META_FILE),
                RootKind::Development => root.path.join(DEV_META_FILE),
            };
            let gate = AccessGate::open(root.clone());
            let store = NotesStore::new(&root.path, gate.writable_flag());
            store.migrate_legacy_layout();
            let service = Arc::new(NotesService::new(store, MetaStore::open(&meta_path)));

            if let Ok(exe) = std::env::current_exe() {
                if let Err(error) = install::write(&data_dir, &install::Install::current(exe)) {
                    eprintln!("hangar-note: install.json not written: {error}");
                }
            }

            app.manage(gate);
            app.manage(SettingsStore::open(&data_dir));
            app.manage(BoundsSaver::start(service.clone()));
            app.manage(service.clone());
            app.manage(Replies::default());
            app.manage(QuitMemory::default());
            app.manage(Requests::default());
            app.manage(tray::CurrentLabels::default());

            let actions = Arc::new(AppActions {
                app: app.handle().clone(),
            });
            match Channel::start(actions) {
                Ok(channel) => {
                    if let Err(error) = channel::write_endpoint(&data_dir, &channel.endpoint()) {
                        eprintln!("hangar-note: endpoint.json not written: {error}");
                    }
                    app.manage(ChannelState {
                        channel,
                        dir: data_dir.clone(),
                    });
                }
                Err(error) => eprintln!("hangar-note: local channel not started: {error}"),
            }

            if let Err(error) = tray::create(app.handle()) {
                eprintln!("hangar-note: no notification area icon: {error}");
            }
            let with_command = command != CliCommand::Start;
            windows::restore(app.handle(), &service, with_command)?;
            if with_command {
                let (project, list) = requests::plan(command.clone(), capture_text.clone());
                windows::deliver(app.handle(), &app.state::<Requests>(), project, list);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_status,
            commands::take_hub_requests,
            commands::list_note_folders,
            commands::list_notes,
            commands::search_notes,
            commands::read_note,
            commands::get_sticky,
            commands::write_note,
            commands::write_sticky,
            commands::create_note,
            commands::new_sticky,
            commands::rename_note,
            commands::delete_note,
            commands::note_flushed,
            commands::list_trash,
            commands::restore_note,
            commands::set_note_color,
            commands::set_note_on_top,
            commands::to_desktop,
            commands::from_desktop,
            commands::close_note,
            commands::export_note,
            commands::reveal_note,
            commands::reveal_notes_folder,
            commands::copy_note,
            commands::copy_text,
            commands::open_hub,
            commands::get_settings,
            commands::set_settings,
            commands::set_autostart,
            commands::set_tray_labels,
            commands::set_hub_on_top,
            commands::window_ready,
        ])
        .build(tauri::generate_context!())?;

    app.run(|handle, event| match event {
        // The last window closed: with a tray icon the app keeps running there.
        RunEvent::ExitRequested {
            code: None, api, ..
        } if tray::present(handle) => api.prevent_exit(),
        RunEvent::Exit => {
            handle.state::<BoundsSaver>().flush(None);
            if let Some(state) = handle.try_state::<ChannelState>() {
                remove_endpoint(&state);
            }
        }
        _ => {}
    });
    Ok(())
}
