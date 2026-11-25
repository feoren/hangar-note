// No extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Err(error) = hangar_note_lib::run() {
        eprintln!("Hangar Note could not start: {error}");
        std::process::exit(1);
    }
}
