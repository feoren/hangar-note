//! The client of "drive-local 1" (Hangar Drive repository, ADR 0003, sections 2 and 3), on the
//! HTTP subset and the proven exchange of Hangar Note's own channel (`channel::exchange`), with
//! this contract's proof label [`DRIVE_KEY_LABEL`].
//!
//! - Every exchange is a hello with a nonce and no token, then exactly one request with the token
//!   and `Connection: close`. An unproven hello or answer means "Drive is not running"
//!   ([`DriveError::NotRunning`]).
//! - Answers are read up to 4 MiB; unknown fields are ignored, an unknown `reason` counts as none,
//!   and every path of an answer passes the path rule (`paths.rs`) or is dropped. A proven answer
//!   without `"version": 1` or with the wrong shape is [`DriveError::Malformed`].
//! - The token never reaches a log, an error or `Debug`; error codes from Drive are kept only in
//!   their documented form.

use std::collections::BTreeSet;
use std::io;
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;
use zeroize::Zeroizing;

use super::discovery::Endpoint;
use super::paths;
use super::state::{Account, DriveStatus, NotesState};
use crate::channel::{exchange, proof, Answer, ExchangeError, Peer, StreamSlot};

/// The label of this contract's proof key, `SHA-256(label || token)`. It differs from Hangar
/// Note's own `hangar-channel-server`, so a proof of one contract never passes under the other.
pub const DRIVE_KEY_LABEL: &[u8] = b"hangar-drive-local-server";
pub const MESSAGE_VERSION: u64 = 1;
pub const STATUS_PATH: &str = "/v1/status";
pub const FOLDERS_REQUEST_PATH: &str = "/v1/folders/request";
pub const ITEMS_STATUS_PATH: &str = "/v1/items/status";
pub const EVENTS_PATH: &str = "/v1/events";
/// The one profile Hangar Note asks for.
pub const PROFILE: &str = "hangar-note-1";
/// At most this many items per `items/status` request.
pub const MAX_ITEMS: usize = 256;
/// The longest wait of an `events` long poll the contract allows.
pub const MAX_WAIT_MS: u64 = 25_000;
/// Every route but `events`.
const REQUEST_TIME: Duration = Duration::from_secs(10);
/// The read timeout of `events` exceeds its wait by this, at least the 5 s the contract asks.
const EVENTS_MARGIN: Duration = Duration::from_secs(7);
/// The longest cursor the contract allows.
const MAX_CURSOR: usize = 64;
/// The most paths of one `events` answer that are looked at; more would have been a `reset`.
const MAX_EVENT_PATHS: usize = 1024;
/// The longest folder name shown, in characters.
const MAX_FOLDER_NAME_CHARS: usize = 255;
/// The longest error code kept from an answer.
const MAX_CODE: usize = 32;

#[derive(Debug, thiserror::Error)]
pub enum DriveError {
    /// Nothing listens, or what listens did not prove itself.
    #[error("Hangar Drive is not running")]
    NotRunning,
    #[error("Hangar Drive is busy")]
    Busy,
    /// The request went out, but no proven answer came back.
    #[error("Hangar Drive did not confirm the request")]
    Unconfirmed,
    /// A proven error answer, with its documented code (`unknown` for any other text).
    #[error("Hangar Drive refused the request: {status} {code}")]
    Refused { status: u16, code: String },
    /// A proven answer this build does not understand.
    #[error("Hangar Drive sent an answer this version does not understand")]
    Malformed,
    #[error("The connection to Hangar Drive failed: {0}")]
    Io(io::Error),
}

impl DriveError {
    /// `items/status` while the notes are not active on this device.
    pub fn is_not_active(&self) -> bool {
        matches!(self, Self::Refused { status: 409, code } if code == "not-active")
    }

    /// Worth trying again soon with the last state kept: Drive had no slot free (at the hello, or
    /// as its proven `503 busy`), or the connection was cut. Every other error means Drive is not
    /// usable as it is, and the worker looks for it again.
    pub fn is_transient(&self) -> bool {
        matches!(
            self,
            Self::Busy | Self::Unconfirmed | Self::Io(_) | Self::Refused { status: 503, .. }
        )
    }
}

impl From<ExchangeError> for DriveError {
    fn from(error: ExchangeError) -> Self {
        match error {
            ExchangeError::NotRunning | ExchangeError::NotProven => Self::NotRunning,
            ExchangeError::Busy => Self::Busy,
            ExchangeError::Unconfirmed => Self::Unconfirmed,
            ExchangeError::Io(error) => Self::Io(error),
        }
    }
}

/// One note for `items/status`: its contract path and its version (`notes::content_version`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemQuery {
    pub path: String,
    pub sha256: String,
}

/// What one `events` answer said, folded.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Events {
    /// The cursor for the next call; `None` if the answer had none in the documented form, so the
    /// next call starts over (and gets `reset`).
    pub cursor: Option<String>,
    /// Something in `/v1/status` changed.
    pub status: bool,
    /// Ask for everything shown.
    pub reset: bool,
    /// These paths may have changed; every one passed the path rule.
    pub paths: BTreeSet<String>,
}

/// A client for one endpoint. The token and the proof key are wiped when dropped.
pub struct DriveClient {
    port: u16,
    token: Zeroizing<String>,
    key: Zeroizing<[u8; 32]>,
}

impl std::fmt::Debug for DriveClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DriveClient")
            .field("port", &self.port)
            .finish_non_exhaustive()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusIn {
    version: u64,
    account: String,
    notes: NotesIn,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotesIn {
    state: String,
    #[serde(default)]
    reason: Option<Value>,
    #[serde(default)]
    folder_name: Option<Value>,
    #[serde(default)]
    last_sync_ms: Option<Value>,
}

impl NotesIn {
    fn into_state(self) -> NotesState {
        NotesState::parse(
            &self.state,
            self.reason.as_ref().and_then(Value::as_str),
            self.folder_name
                .as_ref()
                .and_then(Value::as_str)
                .and_then(clean_name),
            self.last_sync_ms.as_ref().and_then(Value::as_u64),
        )
    }
}

#[derive(Deserialize)]
struct RequestIn {
    version: u64,
    state: String,
    #[serde(default)]
    reason: Option<Value>,
}

#[derive(Deserialize)]
struct ItemsIn {
    version: u64,
    items: Vec<Value>,
}

#[derive(Deserialize)]
struct EventsIn {
    version: u64,
    #[serde(default)]
    cursor: Option<Value>,
    #[serde(default)]
    events: Vec<Value>,
}

/// A folder name to show: control characters dropped, at most [`MAX_FOLDER_NAME_CHARS`].
fn clean_name(name: &str) -> Option<String> {
    let cleaned: String = name
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_FOLDER_NAME_CHARS)
        .collect();
    let trimmed = cleaned.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// An error code of an answer, if it has the documented form (lowercase letters and `-`).
fn error_code(body: &[u8]) -> String {
    serde_json::from_slice::<Value>(body)
        .ok()
        .as_ref()
        .and_then(|value| value.get("error"))
        .and_then(Value::as_str)
        .filter(|code| {
            !code.is_empty()
                && code.len() <= MAX_CODE
                && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')
        })
        .unwrap_or("unknown")
        .to_owned()
}

fn is_cursor(text: &str) -> bool {
    !text.is_empty() && text.len() <= MAX_CURSOR && text.bytes().all(|b| (0x21..0x7f).contains(&b))
}

/// The events of an `events` answer, folded; unknown kinds are skipped.
fn fold_events(events: &[Value]) -> Events {
    let mut folded = Events::default();
    let mut looked_at = 0usize;
    for event in events {
        match event.get("kind").and_then(Value::as_str) {
            Some("status") => folded.status = true,
            Some("reset") => folded.reset = true,
            Some("items") => {
                let Some(paths) = event.get("paths").and_then(Value::as_array) else {
                    continue;
                };
                for path in paths {
                    looked_at += 1;
                    if looked_at > MAX_EVENT_PATHS {
                        // Too many to look at one by one: ask for everything.
                        folded.reset = true;
                        break;
                    }
                    if let Some(path) = path.as_str().filter(|path| paths::is_valid(path)) {
                        folded.paths.insert(path.to_owned());
                    }
                }
            }
            _ => {}
        }
    }
    folded
}

/// The `synced` answers of an `items/status` answer, for requested paths only; entries that are
/// malformed, break the path rule or were not asked for are dropped.
fn synced_items(items: &[Value], asked: &BTreeSet<&str>) -> Vec<(String, bool)> {
    items
        .iter()
        .filter_map(|item| {
            let path = item.get("path")?.as_str()?;
            let state = item.get("state")?.as_str()?;
            (paths::is_valid(path) && asked.contains(path))
                .then(|| (path.to_owned(), state == "synced"))
        })
        .collect()
}

impl DriveClient {
    pub fn new(endpoint: &Endpoint) -> Self {
        Self {
            port: endpoint.port,
            token: endpoint.token.clone(),
            key: proof::key_with_label(DRIVE_KEY_LABEL, &endpoint.token),
        }
    }

    /// One proven exchange; a proven answer other than 200 is [`DriveError::Refused`].
    fn call(
        &self,
        path: &str,
        body: &Value,
        time: Duration,
        slot: Option<&StreamSlot>,
    ) -> Result<Answer, DriveError> {
        let bytes = serde_json::to_vec(body).map_err(|_| DriveError::Malformed)?;
        let peer = Peer {
            port: self.port,
            token: &self.token,
            key: &self.key,
        };
        let answer = exchange(&peer, path, &bytes, time, slot)?;
        if answer.status == 200 {
            Ok(answer)
        } else {
            Err(DriveError::Refused {
                status: answer.status,
                code: error_code(&answer.body),
            })
        }
    }

    fn parse<T: for<'de> Deserialize<'de>>(
        answer: &Answer,
        version: impl Fn(&T) -> u64,
    ) -> Result<T, DriveError> {
        let parsed: T = serde_json::from_slice(&answer.body).map_err(|_| DriveError::Malformed)?;
        if version(&parsed) == MESSAGE_VERSION {
            Ok(parsed)
        } else {
            Err(DriveError::Malformed)
        }
    }

    /// `/v1/status`.
    pub fn status(&self, slot: Option<&StreamSlot>) -> Result<DriveStatus, DriveError> {
        let answer = self.call(
            STATUS_PATH,
            &serde_json::json!({ "version": MESSAGE_VERSION }),
            REQUEST_TIME,
            slot,
        )?;
        let parsed: StatusIn = Self::parse(&answer, |s: &StatusIn| s.version)?;
        Ok(DriveStatus {
            account: Account::parse(&parsed.account),
            notes: parsed.notes.into_state(),
        })
    }

    /// `/v1/folders/request` with the profile `hangar-note-1`; the answer is the outside state
    /// right after it (Drive never waits for the person).
    pub fn request_folder(&self, slot: Option<&StreamSlot>) -> Result<NotesState, DriveError> {
        let answer = self.call(
            FOLDERS_REQUEST_PATH,
            &serde_json::json!({ "version": MESSAGE_VERSION, "profile": PROFILE }),
            REQUEST_TIME,
            slot,
        )?;
        let parsed: RequestIn = Self::parse(&answer, |r: &RequestIn| r.version)?;
        Ok(NotesState::parse(
            &parsed.state,
            parsed.reason.as_ref().and_then(Value::as_str),
            None,
            None,
        ))
    }

    /// `/v1/items/status` for at most [`MAX_ITEMS`] notes: per requested path whether Drive
    /// answered `synced`. Paths Drive left out are not in the result.
    pub fn items_status(
        &self,
        items: &[ItemQuery],
        slot: Option<&StreamSlot>,
    ) -> Result<Vec<(String, bool)>, DriveError> {
        if items.is_empty() {
            return Ok(Vec::new());
        }
        if items.len() > MAX_ITEMS {
            return Err(DriveError::Io(io::Error::new(
                io::ErrorKind::InvalidInput,
                "more items than one request takes",
            )));
        }
        let body = serde_json::json!({
            "version": MESSAGE_VERSION,
            "items": items
                .iter()
                .map(|item| serde_json::json!({ "path": item.path, "sha256": item.sha256 }))
                .collect::<Vec<_>>(),
        });
        let answer = self.call(ITEMS_STATUS_PATH, &body, REQUEST_TIME, slot)?;
        let parsed: ItemsIn = Self::parse(&answer, |i: &ItemsIn| i.version)?;
        let asked: BTreeSet<&str> = items.iter().map(|item| item.path.as_str()).collect();
        Ok(synced_items(&parsed.items, &asked))
    }

    /// `/v1/events`: waits up to `wait_ms` (at most [`MAX_WAIT_MS`]) for changes after `cursor`.
    pub fn events(
        &self,
        cursor: Option<&str>,
        wait_ms: u64,
        slot: Option<&StreamSlot>,
    ) -> Result<Events, DriveError> {
        let wait_ms = wait_ms.min(MAX_WAIT_MS);
        let body = serde_json::json!({
            "version": MESSAGE_VERSION,
            "cursor": cursor,
            "waitMs": wait_ms,
        });
        let time = Duration::from_millis(wait_ms) + EVENTS_MARGIN;
        let answer = self.call(EVENTS_PATH, &body, time, slot)?;
        let parsed: EventsIn = Self::parse(&answer, |e: &EventsIn| e.version)?;
        let mut events = fold_events(&parsed.events);
        events.cursor = parsed
            .cursor
            .as_ref()
            .and_then(Value::as_str)
            .filter(|cursor| is_cursor(cursor))
            .map(str::to_owned);
        Ok(events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Known answers computed independently with Python's `hashlib` and `hmac`:
    /// `key = sha256(b"hangar-drive-local-server" + token)`,
    /// `proof = hmac(key, nonce + path + status + body, sha256)`.
    #[test]
    fn the_drive_proof_matches_pinned_vectors() {
        let token = "0123456789abcdef".repeat(4);
        let nonce = "fedcba9876543210".repeat(4);
        let key = proof::key_with_label(DRIVE_KEY_LABEL, &token);
        assert_eq!(
            proof::hex(&key[..]),
            "e3afae7af3b9bc2f02809a0e76cb7b7de442ce3af940f3cdbee0215e8d9465d5"
        );
        let hello = "53801ead49349d55ba6171b890c26b1031d72efd32a740940904161b902b0432";
        assert_eq!(
            proof::proof(&key, &nonce, "/v1/hello", 200, br#"{"version":1}"#),
            hello
        );
        assert!(proof::verify(
            &key,
            &nonce,
            "/v1/hello",
            200,
            br#"{"version":1}"#,
            hello
        ));
        assert_eq!(
            proof::proof(
                &key,
                &nonce,
                ITEMS_STATUS_PATH,
                409,
                br#"{"version":1,"error":"not-active"}"#
            ),
            "c01676a5a5f08cd589a43007c846e88817649c0657a96bb16dc3aebd7e917a20"
        );
        // The label separates the contracts: Hangar Note's own key never verifies a Drive proof.
        let channel_key = proof::key(&token);
        assert_ne!(&channel_key[..], &key[..]);
        assert!(!proof::verify(
            &channel_key,
            &nonce,
            "/v1/hello",
            200,
            br#"{"version":1}"#,
            hello
        ));
    }

    #[test]
    fn error_codes_are_kept_only_in_their_documented_form() {
        assert_eq!(
            error_code(br#"{"version":1,"error":"not-active"}"#),
            "not-active"
        );
        for body in [
            &br#"{"version":1,"error":"Not Active"}"#[..],
            br#"{"version":1,"error":"a\nb"}"#,
            br#"{"version":1,"error":""}"#,
            br#"{"version":1,"error":7}"#,
            br#"{"version":1}"#,
            b"not json",
        ] {
            assert_eq!(error_code(body), "unknown");
        }
        let long = format!(r#"{{"error":"{}"}}"#, "a".repeat(MAX_CODE + 1));
        assert_eq!(error_code(long.as_bytes()), "unknown");
        assert!(DriveError::Refused {
            status: 409,
            code: "not-active".into()
        }
        .is_not_active());
        assert!(!DriveError::Refused {
            status: 400,
            code: "not-active".into()
        }
        .is_not_active());
    }

    /// A Drive without a free slot is busy, not gone: the worker keeps the last state and the
    /// marks instead of showing "not running" for a moment.
    #[test]
    fn busy_and_cut_connections_are_transient_and_refusals_are_not() {
        for error in [
            DriveError::Busy,
            DriveError::Unconfirmed,
            DriveError::Io(io::ErrorKind::TimedOut.into()),
            DriveError::Refused {
                status: 503,
                code: "busy".into(),
            },
        ] {
            assert!(error.is_transient(), "{error:?}");
        }
        for error in [
            DriveError::NotRunning,
            DriveError::Malformed,
            DriveError::Refused {
                status: 401,
                code: "unauthorized".into(),
            },
            DriveError::Refused {
                status: 500,
                code: "internal".into(),
            },
        ] {
            assert!(!error.is_transient(), "{error:?}");
        }
    }

    #[test]
    fn events_fold_and_drop_what_breaks_the_rules() {
        let events: Vec<Value> = serde_json::from_str(
            r#"[
                {"kind":"status"},
                {"kind":"items","paths":["general/A.md","../x.md","general\\B.md",7,"k/C.md"]},
                {"kind":"future","paths":["general/Z.md"]},
                {"kind":"items"},
                {"nokind":true}
            ]"#,
        )
        .unwrap();
        let folded = fold_events(&events);
        assert!(folded.status);
        assert!(!folded.reset);
        assert_eq!(
            folded.paths,
            BTreeSet::from(["general/A.md".to_owned(), "k/C.md".to_owned()])
        );
        let many: Vec<Value> = vec![serde_json::json!({
            "kind": "items",
            "paths": (0..MAX_EVENT_PATHS + 1).map(|i| format!("general/{i}.md")).collect::<Vec<_>>(),
        })];
        assert!(fold_events(&many).reset);
        assert!(fold_events(&[serde_json::json!({"kind":"reset"})]).reset);
    }

    #[test]
    fn cursors_and_names_are_checked() {
        assert!(is_cursor("c-118f2a-45"));
        assert!(!is_cursor(""));
        assert!(!is_cursor(&"a".repeat(MAX_CURSOR + 1)));
        assert!(is_cursor(&"a".repeat(MAX_CURSOR)));
        assert!(!is_cursor("a b"));
        assert!(!is_cursor("ä"));
        assert_eq!(clean_name("Hangar\u{7}Note"), Some("HangarNote".into()));
        assert_eq!(clean_name("  "), None);
        assert_eq!(
            clean_name(&"n".repeat(400)).map(|n| n.chars().count()),
            Some(MAX_FOLDER_NAME_CHARS)
        );
    }

    #[test]
    fn only_asked_and_valid_paths_come_back() {
        let items: Vec<Value> = serde_json::from_str(
            r#"[
                {"path":"general/A.md","state":"synced","extra":1},
                {"path":"general/B.md","state":"pending","direction":"up"},
                {"path":"general/C.md","state":"synced"},
                {"path":"general/../A.md","state":"synced"},
                {"path":"general/D.md","state":"somethingNew"},
                {"state":"synced"},
                "junk"
            ]"#,
        )
        .unwrap();
        let asked = BTreeSet::from(["general/A.md", "general/B.md", "general/D.md"]);
        assert_eq!(
            synced_items(&items, &asked),
            vec![
                ("general/A.md".to_owned(), true),
                ("general/B.md".to_owned(), false),
                ("general/D.md".to_owned(), false),
            ]
        );
    }

    #[test]
    fn the_client_never_shows_its_token() {
        let token = "abcdef0123456789".repeat(4);
        let client = DriveClient::new(&Endpoint {
            port: 9,
            token: Zeroizing::new(token.clone()),
        });
        let shown = format!("{client:?}");
        assert!(!shown.contains(&token), "{shown}");
        for error in [
            DriveError::NotRunning,
            DriveError::Busy,
            DriveError::Unconfirmed,
            DriveError::Malformed,
            DriveError::Refused {
                status: 401,
                code: "unauthorized".into(),
            },
        ] {
            assert!(!error.to_string().contains(&token));
        }
    }
}
