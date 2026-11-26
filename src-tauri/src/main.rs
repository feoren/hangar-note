// No extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::ExitCode;

use hangar_note_lib::channel::ClientError;
use hangar_note_lib::cli::{self, CliCommand};

fn main() -> ExitCode {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let command = match cli::parse(&args) {
        Ok(command) => command,
        Err(error) => {
            eprintln!("hangar-note: {error}");
            return ExitCode::from(2);
        }
    };
    let mut capture_text = None;
    if let CliCommand::Capture { folder } = &command {
        let text = match cli::read_capture(std::io::stdin().lock()) {
            Ok(Some(text)) => text,
            Ok(None) => {
                eprintln!("hangar-note: capture takes at most 1 MiB of UTF-8 text on stdin");
                return ExitCode::from(2);
            }
            Err(error) => {
                eprintln!("hangar-note: stdin not read: {error}");
                return ExitCode::from(1);
            }
        };
        match hangar_note_lib::send_capture(folder, &text) {
            Ok(()) => return ExitCode::SUCCESS,
            // No running app: this process becomes it and keeps the text.
            Err(ClientError::NotRunning) => capture_text = Some(text),
            Err(error) => {
                eprintln!("hangar-note: {error}");
                return ExitCode::from(1);
            }
        }
    }
    if matches!(command, CliCommand::Open { shared: true, .. }) {
        eprintln!("hangar-note: shared notes are not available yet; opening the private notes");
    }
    match hangar_note_lib::run(command, capture_text) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Hangar Note could not start: {error}");
            ExitCode::from(1)
        }
    }
}
