// No extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::ExitCode;

use hangar_note_lib::cli::{self, CaptureStep, CliCommand};

fn main() -> ExitCode {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let command = match cli::parse(&args) {
        Ok(command) => command,
        Err(error) => {
            eprintln!("hangar-note: {error}");
            return ExitCode::from(cli::EXIT_USAGE);
        }
    };
    let mut capture_text = None;
    if let CliCommand::Capture { folder } = &command {
        let text = match cli::read_capture(std::io::stdin().lock()) {
            Ok(Some(text)) => text,
            Ok(None) => {
                eprintln!("hangar-note: capture takes at most 1 MiB of UTF-8 text on stdin");
                return ExitCode::from(cli::EXIT_USAGE);
            }
            Err(error) => {
                eprintln!("hangar-note: stdin not read: {error}");
                return ExitCode::from(cli::EXIT_FAILED);
            }
        };
        match cli::capture_step(&hangar_note_lib::send_capture(folder, &text)) {
            CaptureStep::Delivered => return ExitCode::SUCCESS,
            CaptureStep::Fail { code, message } => {
                eprintln!("hangar-note: {message}");
                return ExitCode::from(code);
            }
            // No running app proved itself: this process becomes it and keeps the text, unless
            // nothing could be saved anyway. Should another Hangar Note hold the single instance
            // after all, the capture guard in `run` exits with EXIT_NOT_DELIVERED instead of 0.
            CaptureStep::StartApp if !hangar_note_lib::notes_writable_at_start() => {
                eprintln!("hangar-note: {}", cli::READ_ONLY_MESSAGE);
                return ExitCode::from(cli::EXIT_READ_ONLY);
            }
            CaptureStep::StartApp => capture_text = Some(text),
        }
    }
    if matches!(command, CliCommand::Open { shared: true, .. }) {
        eprintln!("hangar-note: shared notes are not available yet; opening the private notes");
    }
    match hangar_note_lib::run(command, capture_text) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Hangar Note could not start: {error}");
            ExitCode::from(cli::EXIT_FAILED)
        }
    }
}
