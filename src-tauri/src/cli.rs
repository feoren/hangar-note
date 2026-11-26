//! The command line (ADR 0002, "Detection and start"). Hangar starts Hangar Note as an argv array:
//!
//! ```text
//! hangar-note                                   opens the app (the notes area)
//! hangar-note open [--folder <path>] [--shared] [--note <id>]
//! hangar-note quick [--folder <path>]
//! hangar-note capture --folder <path>           text on stdin, at most 1 MiB
//! ```
//!
//! Pure parsing; `main.rs` and the single-instance handler act on the result. `--shared` is
//! accepted and reported: shared notes come in phase 3, until then the private notes open.

use std::ffi::OsString;
use std::path::PathBuf;

use crate::channel::{ClientError, ErrorCode};

/// The most text `capture` takes from stdin (Hangar's note size limit).
pub const MAX_CAPTURE_BYTES: usize = 1024 * 1024;

/// Exit codes of the command line. `capture` exits 0 only once the running app confirmed the
/// text, with a proven answer (ADR 0002, security review N4).
pub const EXIT_FAILED: u8 = 1;
/// A wrong command line, or more than 1 MiB of text or no UTF-8 on stdin.
pub const EXIT_USAGE: u8 = 2;
/// The notes are read only (Hangar has not handed them over): the text was not saved.
pub const EXIT_READ_ONLY: u8 = 3;
/// A Hangar Note runs but did not take the text (no proven answer, or it got the arguments only).
pub const EXIT_NOT_DELIVERED: u8 = 4;

pub const READ_ONLY_MESSAGE: &str =
    "the notes are read only until Hangar hands them over; the text was not saved";
pub const NOT_DELIVERED_MESSAGE: &str =
    "Hangar Note is running but did not take the text over its local channel; the text was not saved";
pub const UNCONFIRMED_MESSAGE: &str =
    "Hangar Note did not confirm the text; it may not have been saved";

/// What `capture` does after it tried the running app's channel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureStep {
    /// The app confirmed the text: exit 0.
    Delivered,
    /// No app answered with a valid proof: this process becomes the app and keeps the text.
    StartApp,
    /// Exit with `code` and `message`; the text did not arrive (or may not have).
    Fail { code: u8, message: String },
}

/// Pure, so every way a capture can end is testable without a running app.
pub fn capture_step(result: &Result<(), ClientError>) -> CaptureStep {
    let fail = |code: u8, message: &str| CaptureStep::Fail {
        code,
        message: message.to_owned(),
    };
    match result {
        Ok(()) => CaptureStep::Delivered,
        Err(ClientError::NotRunning | ClientError::NotProven) => CaptureStep::StartApp,
        Err(ClientError::Refused(code)) if code == ErrorCode::ReadOnly.as_str() => {
            fail(EXIT_READ_ONLY, READ_ONLY_MESSAGE)
        }
        Err(ClientError::Refused(code)) => fail(
            EXIT_FAILED,
            &format!("Hangar Note refused the text ({code}); it was not saved"),
        ),
        Err(ClientError::Unconfirmed) => fail(EXIT_NOT_DELIVERED, UNCONFIRMED_MESSAGE),
        Err(ClientError::Io(error)) => fail(
            EXIT_FAILED,
            &format!("the local channel failed ({error}); the text was not saved"),
        ),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliCommand {
    /// No command: open the app.
    Start,
    Open {
        folder: Option<PathBuf>,
        shared: bool,
        note: Option<String>,
    },
    Quick {
        folder: Option<PathBuf>,
    },
    Capture {
        folder: PathBuf,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CliError {
    #[error("Unknown command {0:?}; expected open, quick or capture")]
    UnknownCommand(String),
    #[error("Unknown option {0:?}")]
    UnknownOption(String),
    #[error("{0} needs a value")]
    MissingValue(&'static str),
    #[error("{0} is given twice")]
    Repeated(&'static str),
    #[error("--folder must be an absolute path")]
    RelativeFolder,
    #[error("capture needs --folder")]
    CaptureWithoutFolder,
    #[error("An argument is not valid Unicode")]
    NotUnicode,
}

#[derive(Default)]
struct Options {
    folder: Option<PathBuf>,
    shared: bool,
    note: Option<String>,
}

/// Parses the arguments after the program name.
pub fn parse(args: &[OsString]) -> Result<CliCommand, CliError> {
    let Some(first) = args.first() else {
        return Ok(CliCommand::Start);
    };
    let command = first.to_str().ok_or(CliError::NotUnicode)?;
    let allowed: &[&str] = match command {
        "open" => &["--folder", "--shared", "--note"],
        "quick" => &["--folder"],
        "capture" => &["--folder"],
        other => return Err(CliError::UnknownCommand(other.to_owned())),
    };
    let mut options = Options::default();
    let mut rest = args[1..].iter();
    while let Some(arg) = rest.next() {
        let name = arg.to_str().ok_or(CliError::NotUnicode)?;
        if !allowed.contains(&name) {
            return Err(CliError::UnknownOption(name.to_owned()));
        }
        match name {
            "--folder" => {
                let value = rest.next().ok_or(CliError::MissingValue("--folder"))?;
                if options.folder.is_some() {
                    return Err(CliError::Repeated("--folder"));
                }
                let path = PathBuf::from(value);
                if !path.is_absolute() {
                    return Err(CliError::RelativeFolder);
                }
                options.folder = Some(path);
            }
            "--note" => {
                let value = rest.next().ok_or(CliError::MissingValue("--note"))?;
                if options.note.is_some() {
                    return Err(CliError::Repeated("--note"));
                }
                options.note = Some(value.to_str().ok_or(CliError::NotUnicode)?.to_owned());
            }
            _ => {
                if options.shared {
                    return Err(CliError::Repeated("--shared"));
                }
                options.shared = true;
            }
        }
    }
    Ok(match command {
        "open" => CliCommand::Open {
            folder: options.folder,
            shared: options.shared,
            note: options.note,
        },
        "quick" => CliCommand::Quick {
            folder: options.folder,
        },
        _ => CliCommand::Capture {
            folder: options.folder.ok_or(CliError::CaptureWithoutFolder)?,
        },
    })
}

/// The arguments the single-instance plugin hands over: the second process's whole argv, the
/// program name first.
pub fn parse_forwarded(argv: &[String]) -> Result<CliCommand, CliError> {
    let args: Vec<OsString> = argv.iter().skip(1).map(OsString::from).collect();
    parse(&args)
}

/// Reads at most [`MAX_CAPTURE_BYTES`] of UTF-8 text; `None` when there is more or it is no text.
pub fn read_capture(input: impl std::io::Read) -> std::io::Result<Option<String>> {
    use std::io::Read as _;
    let mut bytes = Vec::new();
    input
        .take(MAX_CAPTURE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_CAPTURE_BYTES {
        return Ok(None);
    }
    Ok(String::from_utf8(bytes).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    fn abs() -> &'static str {
        if cfg!(windows) {
            r"C:\Users\Test User\Project"
        } else {
            "/home/test/Project"
        }
    }

    #[test]
    fn the_three_commands_and_their_options() {
        assert_eq!(parse(&[]), Ok(CliCommand::Start));
        assert_eq!(
            parse(&args(&["open"])),
            Ok(CliCommand::Open {
                folder: None,
                shared: false,
                note: None
            })
        );
        assert_eq!(
            parse(&args(&[
                "open",
                "--note",
                "x",
                "--shared",
                "--folder",
                abs()
            ])),
            Ok(CliCommand::Open {
                folder: Some(abs().into()),
                shared: true,
                note: Some("x".into())
            })
        );
        assert_eq!(
            parse(&args(&["quick", "--folder", abs()])),
            Ok(CliCommand::Quick {
                folder: Some(abs().into())
            })
        );
        assert_eq!(
            parse(&args(&["capture", "--folder", abs()])),
            Ok(CliCommand::Capture {
                folder: abs().into()
            })
        );
    }

    #[test]
    fn anything_unexpected_is_refused() {
        assert_eq!(
            parse(&args(&["delete"])),
            Err(CliError::UnknownCommand("delete".into()))
        );
        assert_eq!(
            parse(&args(&["quick", "--note", "x"])),
            Err(CliError::UnknownOption("--note".into()))
        );
        assert_eq!(
            parse(&args(&["capture", "--shared"])),
            Err(CliError::UnknownOption("--shared".into()))
        );
        assert_eq!(
            parse(&args(&["open", "--folder"])),
            Err(CliError::MissingValue("--folder"))
        );
        assert_eq!(
            parse(&args(&["open", "--folder", "relative"])),
            Err(CliError::RelativeFolder)
        );
        assert_eq!(
            parse(&args(&["open", "--shared", "--shared"])),
            Err(CliError::Repeated("--shared"))
        );
        assert_eq!(
            parse(&args(&["open", "--folder", abs(), "--folder", abs()])),
            Err(CliError::Repeated("--folder"))
        );
        assert_eq!(
            parse(&args(&["capture"])),
            Err(CliError::CaptureWithoutFolder)
        );
    }

    #[test]
    fn forwarded_arguments_skip_the_program_name() {
        let argv = vec!["C:\\x\\hangar-note.exe".to_owned(), "quick".to_owned()];
        assert_eq!(
            parse_forwarded(&argv),
            Ok(CliCommand::Quick { folder: None })
        );
        assert_eq!(parse_forwarded(&argv[..1]), Ok(CliCommand::Start));
    }

    #[test]
    fn capture_succeeds_only_when_the_text_arrived() {
        assert_eq!(capture_step(&Ok(())), CaptureStep::Delivered);
        for not_reached in [ClientError::NotRunning, ClientError::NotProven] {
            assert_eq!(capture_step(&Err(not_reached)), CaptureStep::StartApp);
        }
        let code = |result: Result<(), ClientError>| match capture_step(&result) {
            CaptureStep::Fail { code, message } => {
                assert!(message.contains("not"), "{message}");
                code
            }
            other => panic!("{other:?}"),
        };
        assert_eq!(
            code(Err(ClientError::Refused("read-only".into()))),
            EXIT_READ_ONLY
        );
        assert_eq!(
            code(Err(ClientError::Refused("too-large".into()))),
            EXIT_FAILED
        );
        assert_eq!(code(Err(ClientError::Unconfirmed)), EXIT_NOT_DELIVERED);
        assert_eq!(
            code(Err(ClientError::Io(std::io::ErrorKind::BrokenPipe.into()))),
            EXIT_FAILED
        );
        // Every failure is distinct from success and from a wrong command line.
        for failure in [EXIT_FAILED, EXIT_READ_ONLY, EXIT_NOT_DELIVERED] {
            assert_ne!(failure, 0);
            assert_ne!(failure, EXIT_USAGE);
        }
    }

    #[test]
    fn capture_reads_at_most_one_mebibyte_of_text() {
        let fits = "ä".repeat(MAX_CAPTURE_BYTES / 2);
        assert_eq!(read_capture(fits.as_bytes()).unwrap(), Some(fits.clone()));
        let more = format!("{fits}x");
        assert_eq!(read_capture(more.as_bytes()).unwrap(), None);
        assert_eq!(read_capture(&[0xff, 0xfe][..]).unwrap(), None);
    }
}
