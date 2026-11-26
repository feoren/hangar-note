// The app commands are registered here explicitly. Tauri then generates one permission per
// command (allow-<command>), and each window may only call what its capability grants
// (capabilities/hub.json, capabilities/note.json).
const COMMANDS: &[&str] = &[
    "get_status",
    "take_hub_requests",
    "list_note_folders",
    "list_notes",
    "search_notes",
    "read_note",
    "get_sticky",
    "write_note",
    "write_sticky",
    "create_note",
    "new_sticky",
    "rename_note",
    "delete_note",
    "note_flushed",
    "list_trash",
    "restore_note",
    "set_note_color",
    "set_note_on_top",
    "to_desktop",
    "from_desktop",
    "close_note",
    "export_note",
    "reveal_note",
    "reveal_notes_folder",
    "copy_note",
    "copy_text",
    "open_hub",
    "get_settings",
    "set_settings",
    "set_autostart",
    "set_tray_labels",
    "set_hub_on_top",
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
