//! What the command line and the local channel ask of the notes area, held until it has loaded
//! and taken them (`take_hub_requests`), plus the folder "This project" stands for. In phase 1
//! that folder comes from `--folder` (ADR 0002); later Hangar's running sessions name it.
//!
//! Pure: [`plan`] turns a command into requests, so the start logic is testable without windows.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;

use crate::cli::CliCommand;
use crate::fsio::lock;

/// Requests waiting beyond this are dropped from the front: nobody reads a hundred of them. Only
/// requests without content go (`open`, `quick`, `openNote`, all of whose notes are on disk); a
/// capture's text is never dropped (security review B1).
const MAX_PENDING: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum HubRequest {
    /// Show the notes of "This project" (or General without a folder).
    ShowProject,
    /// Open one note; `folder` `None` is General.
    OpenNote { folder: Option<PathBuf>, id: String },
    /// Start a quick note in "This project".
    Quick,
    /// A captured text that could not become a note in the backend (a capture that started the
    /// app while the notes stayed read only): the notes area holds it in a draft to copy. A
    /// capture over the local channel is on disk first and arrives as [`HubRequest::OpenNote`].
    Capture { folder: PathBuf, text: String },
    /// `--shared` was asked for; shared notes come in a later phase.
    SharedUnavailable,
}

impl std::fmt::Display for HubRequest {
    // Logs name the kind only, never a captured text.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let kind = match self {
            Self::ShowProject => "show project",
            Self::OpenNote { .. } => "open note",
            Self::Quick => "quick note",
            Self::Capture { .. } => "capture",
            Self::SharedUnavailable => "shared unavailable",
        };
        f.write_str(kind)
    }
}

/// What a command does: the new "This project" folder (if it names one) and the requests.
pub fn plan(command: CliCommand, text: Option<String>) -> (Option<PathBuf>, Vec<HubRequest>) {
    match command {
        CliCommand::Start => (None, Vec::new()),
        CliCommand::Open {
            folder,
            shared,
            note,
        } => {
            let mut requests = Vec::new();
            if shared {
                requests.push(HubRequest::SharedUnavailable);
            }
            requests.push(match note {
                Some(id) => HubRequest::OpenNote {
                    folder: folder.clone(),
                    id,
                },
                None => HubRequest::ShowProject,
            });
            (folder, requests)
        }
        CliCommand::Quick { folder } => (folder, vec![HubRequest::Quick]),
        CliCommand::Capture { folder } => {
            let requests = match text {
                Some(text) => vec![HubRequest::Capture {
                    folder: folder.clone(),
                    text,
                }],
                // A capture forwarded as arguments only (its text went over the channel or is
                // lost): show the folder's notes.
                None => vec![HubRequest::ShowProject],
            };
            (Some(folder), requests)
        }
    }
}

#[derive(Debug, Default)]
pub struct Requests {
    pending: Mutex<VecDeque<HubRequest>>,
    project: Mutex<Option<PathBuf>>,
}

impl Requests {
    pub fn push(&self, request: HubRequest) {
        let mut pending = lock(&self.pending);
        pending.push_back(request);
        while pending.len() > MAX_PENDING {
            let Some(oldest) = pending
                .iter()
                .position(|request| !matches!(request, HubRequest::Capture { .. }))
            else {
                break;
            };
            pending.remove(oldest);
        }
    }

    pub fn take(&self) -> Vec<HubRequest> {
        lock(&self.pending).drain(..).collect()
    }

    pub fn project(&self) -> Option<PathBuf> {
        lock(&self.project).clone()
    }

    /// Returns whether it changed.
    pub fn set_project(&self, folder: PathBuf) -> bool {
        let mut project = lock(&self.project);
        let changed = project.as_ref() != Some(&folder);
        *project = Some(folder);
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn abs() -> PathBuf {
        PathBuf::from(if cfg!(windows) { r"C:\p" } else { "/p" })
    }

    #[test]
    fn commands_become_requests() {
        assert_eq!(plan(CliCommand::Start, None), (None, vec![]));
        assert_eq!(
            plan(
                CliCommand::Open {
                    folder: Some(abs()),
                    shared: true,
                    note: Some("x".into())
                },
                None
            ),
            (
                Some(abs()),
                vec![
                    HubRequest::SharedUnavailable,
                    HubRequest::OpenNote {
                        folder: Some(abs()),
                        id: "x".into()
                    }
                ]
            )
        );
        assert_eq!(
            plan(CliCommand::Quick { folder: None }, None),
            (None, vec![HubRequest::Quick])
        );
        assert_eq!(
            plan(CliCommand::Capture { folder: abs() }, Some("t".into())),
            (
                Some(abs()),
                vec![HubRequest::Capture {
                    folder: abs(),
                    text: "t".into()
                }]
            )
        );
        assert_eq!(
            plan(CliCommand::Capture { folder: abs() }, None).1,
            vec![HubRequest::ShowProject]
        );
    }

    #[test]
    fn requests_wait_in_order_and_the_oldest_go_first_when_too_many() {
        let requests = Requests::default();
        for _ in 0..MAX_PENDING {
            requests.push(HubRequest::Quick);
        }
        requests.push(HubRequest::ShowProject);
        let taken = requests.take();
        assert_eq!(taken.len(), MAX_PENDING);
        assert_eq!(taken.last(), Some(&HubRequest::ShowProject));
        assert!(requests.take().is_empty());
        assert!(requests.set_project(abs()));
        assert!(!requests.set_project(abs()));
        assert_eq!(requests.project(), Some(abs()));
        let capture = HubRequest::Capture {
            folder: abs(),
            text: "marker-text-9c2".into(),
        };
        assert!(!capture.to_string().contains("marker"));
        assert_eq!(serde_json::to_value(&capture).unwrap()["kind"], "capture");
        let open = HubRequest::OpenNote {
            folder: Some(abs()),
            id: "x".into(),
        };
        assert_eq!(
            serde_json::to_value(&open).unwrap(),
            serde_json::json!({ "kind": "openNote", "folder": abs(), "id": "x" })
        );
    }

    /// Security review B1: a held capture text survives any number of requests without content.
    #[test]
    fn a_capture_is_never_dropped_for_requests_without_content() {
        let requests = Requests::default();
        let capture = HubRequest::Capture {
            folder: abs(),
            text: "marker-held-3a7".into(),
        };
        requests.push(capture.clone());
        for _ in 0..3 * MAX_PENDING {
            requests.push(HubRequest::Quick);
        }
        let taken = requests.take();
        assert_eq!(taken.len(), MAX_PENDING);
        assert_eq!(taken[0], capture);
    }
}
