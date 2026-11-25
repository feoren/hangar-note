// The app commands are registered here explicitly. Tauri then generates one permission per
// command (allow-<command>), and each window may only call what its capability grants
// (capabilities/hub.json, capabilities/note.json).
const COMMANDS: &[&str] = &[
    "list_notes",
    "read_note",
    "write_note",
    "create_note",
    "set_note_color",
    "set_note_on_top",
    "delete_note",
    "note_flushed",
    "list_trash",
    "restore_note",
    "open_note",
    "close_note",
    "open_hub",
    "get_settings",
    "set_settings",
    "set_autostart",
    "set_tray_labels",
    "window_ready",
];

fn main() {
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS));
    // A build script reports errors to Cargo by panicking; that is the intended interface.
    if let Err(error) = tauri_build::try_build(attributes) {
        panic!("Tauri build failed: {error:#}");
    }
}
