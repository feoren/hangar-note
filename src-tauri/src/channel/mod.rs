//! The local channel, Hangar Note's side (ADR 0002, "Local channel"): loopback HTTP on
//! 127.0.0.1 with a random port, through which Hangar (and `hangar-note capture`) reach the
//! running app.
//!
//! - `endpoint.json` `{ version: 1, port, token }` in Hangar Note's local data folder, written
//!   atomically with user-only permissions (0600 on Unix; on Windows the folder in the user
//!   profile carries the profile's ACL, as all of the app's files). Removed again on quit.
//! - The token is 32 random bytes from the OS (64 hex digits), new on every start. It is checked
//!   in constant time, after a browser `Origin` (or `Sec-Fetch-*`) and any `Host` other than
//!   `127.0.0.1:<port>` were refused, as in Hangar's hook endpoint (`gate_service.rs`).
//! - Every request body and every answer carries `version`; an unknown one gets
//!   `unsupported-version`, never a guess. Errors are fixed codes (`{ version, error }`).
//! - Routes of phase 1: `open`, `quick`, `capture`, `create`, `search`, `excerpts`, `flush`.
//! - Neither a note's text nor the token is ever logged.
//!
//! The routes call [`Actions`], which the app implements; this module holds no notes logic.

pub mod http;

use std::io::{self, BufReader, Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use self::http::{Head, Status};
use crate::fsio::{read_capped, write_atomic};
use crate::notes::NotesError;
use crate::service::{Excerpt, HitRow, ServiceError};

pub const ENDPOINT_FILE: &str = "endpoint.json";
pub const ENDPOINT_VERSION: u32 = 1;
/// The message version of every request and answer.
pub const MESSAGE_VERSION: u64 = 1;
pub const TOKEN_BYTES: usize = 32;
/// Connections handled at the same time; one more is closed unanswered.
pub const MAX_CONNECTIONS: usize = 16;
/// Body limit of `capture` and `create`: 1 MiB of text, which JSON escaping may grow.
pub const MAX_TEXT_BODY_BYTES: u64 = 8 * 1024 * 1024;
/// Body limit of every other route.
pub const MAX_SMALL_BODY_BYTES: u64 = 64 * 1024;
const HEAD_TIME: Duration = Duration::from_secs(5);
const BODY_TIME: Duration = Duration::from_secs(15);
const WRITE_TIME: Duration = Duration::from_secs(5);
const LINGER_TIME: Duration = Duration::from_secs(1);
const LINGER_BYTES: u64 = 64 * 1024;
const MAX_ENDPOINT_BYTES: usize = 4096;

/// The fixed error codes of the channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    BadRequest,
    UnsupportedVersion,
    Unauthorized,
    Forbidden,
    UnknownRoute,
    MethodNotAllowed,
    LengthRequired,
    TooLarge,
    HeadersTooLarge,
    NotImplemented,
    ReadOnly,
    UnknownNote,
    Invalid,
    Internal,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BadRequest => "bad-request",
            Self::UnsupportedVersion => "unsupported-version",
            Self::Unauthorized => "unauthorized",
            Self::Forbidden => "forbidden",
            Self::UnknownRoute => "unknown-route",
            Self::MethodNotAllowed => "method-not-allowed",
            Self::LengthRequired => "length-required",
            Self::TooLarge => "too-large",
            Self::HeadersTooLarge => "headers-too-large",
            Self::NotImplemented => "not-implemented",
            Self::ReadOnly => "read-only",
            Self::UnknownNote => "unknown-note",
            Self::Invalid => "invalid",
            Self::Internal => "internal",
        }
    }

    pub fn status(self) -> Status {
        match self {
            Self::BadRequest | Self::UnsupportedVersion | Self::Invalid => Status::BadRequest,
            Self::Unauthorized => Status::Unauthorized,
            Self::Forbidden => Status::Forbidden,
            Self::UnknownRoute | Self::UnknownNote => Status::NotFound,
            Self::MethodNotAllowed => Status::MethodNotAllowed,
            Self::LengthRequired => Status::LengthRequired,
            Self::TooLarge => Status::PayloadTooLarge,
            Self::HeadersTooLarge => Status::HeadersTooLarge,
            Self::NotImplemented => Status::NotImplemented,
            Self::ReadOnly => Status::Conflict,
            Self::Internal => Status::Internal,
        }
    }

    fn from_status(status: Status) -> Self {
        match status {
            Status::MethodNotAllowed => Self::MethodNotAllowed,
            Status::LengthRequired => Self::LengthRequired,
            Status::HeadersTooLarge => Self::HeadersTooLarge,
            Status::NotImplemented => Self::NotImplemented,
            _ => Self::BadRequest,
        }
    }
}

impl From<&ServiceError> for ErrorCode {
    fn from(error: &ServiceError) -> Self {
        match error {
            ServiceError::Notes(NotesError::ReadOnly) => Self::ReadOnly,
            ServiceError::Notes(NotesError::UnknownNote) => Self::UnknownNote,
            ServiceError::Notes(
                NotesError::InvalidTitle(_)
                | NotesError::InvalidId
                | NotesError::InvalidFolder(_)
                | NotesError::InvalidQuery(_)
                | NotesError::TooLarge { .. }
                | NotesError::NotText,
            ) => Self::Invalid,
            ServiceError::Notes(NotesError::Io { .. }) | ServiceError::Meta(_) => Self::Internal,
        }
    }
}

/// What the routes ask the app to do.
pub trait Actions: Send + Sync + 'static {
    /// Shows the notes area (scope "This project" for `folder`) or the note `note`.
    fn open(
        &self,
        folder: Option<PathBuf>,
        shared: bool,
        note: Option<String>,
    ) -> Result<(), ServiceError>;
    /// Starts a quick note in the notes area.
    fn quick(&self, folder: Option<PathBuf>) -> Result<(), ServiceError>;
    /// A new note with captured text in `folder`, shown in the notes area.
    fn capture(&self, folder: PathBuf, text: String) -> Result<(), ServiceError>;
    /// A note with a title and text; returns its ID.
    fn create(
        &self,
        folder: Option<PathBuf>,
        title: String,
        text: String,
    ) -> Result<String, ServiceError>;
    fn search(&self, query: &str) -> Result<Vec<HitRow>, ServiceError>;
    fn excerpts(&self, folder: Option<PathBuf>, limit: usize)
        -> Result<Vec<Excerpt>, ServiceError>;
    /// Asks every editor to save; `true` once everything typed is on disk.
    fn flush(&self) -> bool;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EndpointFile {
    pub version: u32,
    pub port: u16,
    pub token: String,
}

/// 32 random bytes from the OS as 64 lowercase hex digits.
pub fn new_token() -> io::Result<String> {
    let mut bytes = [0u8; TOKEN_BYTES];
    getrandom::fill(&mut bytes).map_err(|error| io::Error::other(error.to_string()))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Compares two tokens in time that depends on their length only, not on where they differ
/// (Hangar's `token_eq`).
pub fn token_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let diff = a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y));
    std::hint::black_box(diff) == 0
}

pub fn write_endpoint(dir: &Path, endpoint: &EndpointFile) -> io::Result<()> {
    let bytes = serde_json::to_vec_pretty(endpoint).map_err(io::Error::other)?;
    write_atomic(&dir.join(ENDPOINT_FILE), &bytes)
}

pub fn read_endpoint(dir: &Path) -> io::Result<EndpointFile> {
    let bytes = read_capped(&dir.join(ENDPOINT_FILE), MAX_ENDPOINT_BYTES)?
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "endpoint.json too large"))?;
    let endpoint: EndpointFile = serde_json::from_slice(&bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "endpoint.json unreadable"))?;
    if endpoint.version != ENDPOINT_VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "endpoint.json of another version",
        ));
    }
    Ok(endpoint)
}

// ---- Messages ---------------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenBody {
    #[allow(dead_code)]
    version: u64,
    #[serde(default)]
    folder: Option<PathBuf>,
    #[serde(default)]
    shared: bool,
    #[serde(default)]
    note: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QuickBody {
    #[allow(dead_code)]
    version: u64,
    #[serde(default)]
    folder: Option<PathBuf>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CaptureBody {
    #[allow(dead_code)]
    version: u64,
    folder: PathBuf,
    text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateBody {
    #[allow(dead_code)]
    version: u64,
    #[serde(default)]
    folder: Option<PathBuf>,
    title: String,
    #[serde(default)]
    text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SearchBody {
    #[allow(dead_code)]
    version: u64,
    query: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExcerptsBody {
    #[allow(dead_code)]
    version: u64,
    #[serde(default)]
    folder: Option<PathBuf>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FlushBody {
    #[allow(dead_code)]
    version: u64,
}

fn answer(body: serde_json::Value) -> (Status, String) {
    let mut body = body;
    if let Some(object) = body.as_object_mut() {
        object.insert("version".into(), MESSAGE_VERSION.into());
    }
    (Status::Ok, body.to_string())
}

pub fn error_body(code: ErrorCode) -> (Status, String) {
    (
        code.status(),
        serde_json::json!({ "version": MESSAGE_VERSION, "error": code.as_str() }).to_string(),
    )
}

/// The version is checked before the shape, so a newer message gets `unsupported-version`
/// rather than `bad-request`.
fn parse<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, ErrorCode> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| ErrorCode::BadRequest)?;
    match value.get("version").and_then(serde_json::Value::as_u64) {
        Some(MESSAGE_VERSION) => {}
        Some(_) => return Err(ErrorCode::UnsupportedVersion),
        None => return Err(ErrorCode::BadRequest),
    }
    serde_json::from_value(value).map_err(|_| ErrorCode::BadRequest)
}

fn absolute(folder: Option<PathBuf>) -> Result<Option<PathBuf>, ErrorCode> {
    match folder {
        Some(path) if !path.is_absolute() => Err(ErrorCode::Invalid),
        other => Ok(other),
    }
}

fn done<T>(
    result: Result<T, ServiceError>,
    ok: impl FnOnce(T) -> serde_json::Value,
) -> (Status, String) {
    match result {
        Ok(value) => answer(ok(value)),
        Err(error) => error_body(ErrorCode::from(&error)),
    }
}

/// The answer to one request whose body is `bytes`. Pure: the routes and their checks are
/// testable without a socket.
pub fn route(actions: &dyn Actions, path: &str, bytes: &[u8]) -> (Status, String) {
    let result = (|| -> Result<(Status, String), ErrorCode> {
        Ok(match path {
            "/open" => {
                let body: OpenBody = parse(bytes)?;
                let folder = absolute(body.folder)?;
                let shared = body.shared;
                done(actions.open(folder, shared, body.note), |()| {
                    if shared {
                        serde_json::json!({ "ok": true, "shared": "unavailable" })
                    } else {
                        serde_json::json!({ "ok": true })
                    }
                })
            }
            "/quick" => {
                let body: QuickBody = parse(bytes)?;
                done(
                    actions.quick(absolute(body.folder)?),
                    |()| serde_json::json!({ "ok": true }),
                )
            }
            "/capture" => {
                let body: CaptureBody = parse(bytes)?;
                let folder = absolute(Some(body.folder))?.ok_or(ErrorCode::Invalid)?;
                if body.text.len() > crate::cli::MAX_CAPTURE_BYTES {
                    return Err(ErrorCode::TooLarge);
                }
                done(
                    actions.capture(folder, body.text),
                    |()| serde_json::json!({ "ok": true }),
                )
            }
            "/create" => {
                let body: CreateBody = parse(bytes)?;
                done(
                    actions.create(absolute(body.folder)?, body.title, body.text),
                    |id| serde_json::json!({ "id": id }),
                )
            }
            "/search" => {
                let body: SearchBody = parse(bytes)?;
                done(
                    actions.search(&body.query),
                    |hits| serde_json::json!({ "hits": hits }),
                )
            }
            "/excerpts" => {
                let body: ExcerptsBody = parse(bytes)?;
                let limit = body.limit.unwrap_or(crate::service::MAX_EXCERPTS);
                done(
                    actions.excerpts(absolute(body.folder)?, limit),
                    |notes| serde_json::json!({ "notes": notes }),
                )
            }
            "/flush" => {
                let _: FlushBody = parse(bytes)?;
                answer(serde_json::json!({ "saved": actions.flush() }))
            }
            _ => return Err(ErrorCode::UnknownRoute),
        })
    })();
    result.unwrap_or_else(error_body)
}

fn body_limit(path: &str) -> u64 {
    match path {
        "/capture" | "/create" => MAX_TEXT_BODY_BYTES,
        _ => MAX_SMALL_BODY_BYTES,
    }
}

// ---- Server -----------------------------------------------------------------------------------

/// Reads from a stream with one total deadline, however slowly the client sends.
struct Deadline<'a> {
    stream: &'a TcpStream,
    until: Instant,
}

impl<'a> Deadline<'a> {
    fn new(stream: &'a TcpStream, limit: Duration) -> Self {
        Self {
            stream,
            until: Instant::now() + limit,
        }
    }

    fn restart(&mut self, limit: Duration) {
        self.until = Instant::now() + limit;
    }
}

impl Read for Deadline<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let left = self.until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(io::ErrorKind::TimedOut.into());
        }
        self.stream.set_read_timeout(Some(left))?;
        let mut stream = self.stream;
        stream.read(buf)
    }
}

/// A slot of [`MAX_CONNECTIONS`]; released on drop.
struct Slot(Arc<AtomicUsize>);

impl Slot {
    fn take(count: &Arc<AtomicUsize>) -> Option<Self> {
        let mut current = count.load(Ordering::SeqCst);
        while current < MAX_CONNECTIONS {
            match count.compare_exchange(current, current + 1, Ordering::SeqCst, Ordering::SeqCst) {
                Ok(_) => return Some(Self(count.clone())),
                Err(seen) => current = seen,
            }
        }
        None
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// The running channel.
pub struct Channel {
    pub port: u16,
    token: String,
}

impl std::fmt::Debug for Channel {
    // The token stays out of every debug print.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Channel").field("port", &self.port).finish()
    }
}

impl Channel {
    /// Binds 127.0.0.1 on a random port and serves `actions` on a thread of its own.
    pub fn start(actions: Arc<dyn Actions>) -> io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        let port = listener.local_addr()?.port();
        let token = new_token()?;
        let shared = Arc::new(Server {
            port,
            token: token.clone(),
            actions,
            connections: Arc::default(),
        });
        thread::Builder::new()
            .name("channel-accept".to_owned())
            .spawn(move || shared.accept(&listener))?;
        Ok(Self { port, token })
    }

    pub fn endpoint(&self) -> EndpointFile {
        EndpointFile {
            version: ENDPOINT_VERSION,
            port: self.port,
            token: self.token.clone(),
        }
    }
}

struct Server {
    port: u16,
    token: String,
    actions: Arc<dyn Actions>,
    connections: Arc<AtomicUsize>,
}

impl Server {
    fn accept(self: &Arc<Self>, listener: &TcpListener) {
        for stream in listener.incoming() {
            let stream = match stream {
                Ok(stream) => stream,
                Err(error) => {
                    eprintln!("hangar-note: channel accept failed: {error}");
                    thread::sleep(Duration::from_millis(100));
                    continue;
                }
            };
            let loopback = stream
                .peer_addr()
                .is_ok_and(|peer: SocketAddr| peer.ip().is_loopback());
            if !loopback {
                continue;
            }
            let Some(slot) = Slot::take(&self.connections) else {
                continue;
            };
            let server = Arc::clone(self);
            let _ = thread::Builder::new()
                .name("channel-conn".to_owned())
                .spawn(move || {
                    let _slot = slot;
                    server.serve(&stream);
                });
        }
    }

    /// Who sent the request: a browser page or a foreign `Host` is refused before the token is
    /// looked at.
    fn admit(&self, head: &Head) -> Result<(), ErrorCode> {
        let expected = format!("127.0.0.1:{}", self.port);
        if head.from_browser || head.host.as_deref() != Some(expected.as_str()) {
            return Err(ErrorCode::Forbidden);
        }
        match &head.token {
            Some(token) if token_eq(token.as_bytes(), self.token.as_bytes()) => Ok(()),
            _ => Err(ErrorCode::Unauthorized),
        }
    }

    fn serve(&self, stream: &TcpStream) {
        let _ = stream.set_write_timeout(Some(WRITE_TIME));
        let mut reader = BufReader::new(Deadline::new(stream, HEAD_TIME));
        let (status, body) = match http::read_head(&mut reader) {
            Err(error) => match error.status() {
                Some(status) => error_body(ErrorCode::from_status(status)),
                None => return,
            },
            Ok(head) => match self.admit(&head) {
                Err(code) => error_body(code),
                Ok(()) if head.content_length > body_limit(&head.path) => {
                    error_body(ErrorCode::TooLarge)
                }
                Ok(()) => {
                    reader.get_mut().restart(BODY_TIME);
                    let mut bytes = Vec::new();
                    let read = (&mut reader)
                        .take(head.content_length)
                        .read_to_end(&mut bytes);
                    match read {
                        Ok(n) if n as u64 == head.content_length => {
                            route(self.actions.as_ref(), &head.path, &bytes)
                        }
                        _ => return,
                    }
                }
            },
        };
        answer_and_close(stream, &http::response(status, &body));
    }
}

/// Writes the answer and closes gracefully: the write side first, then whatever the client
/// still sends is read and dropped, so Windows does not reset the connection on close and the
/// client gets the whole answer (Hangar measured this).
fn answer_and_close(stream: &TcpStream, response: &[u8]) {
    let mut writer = stream;
    if writer
        .write_all(response)
        .and_then(|()| writer.flush())
        .is_err()
    {
        return;
    }
    let _ = stream.shutdown(Shutdown::Write);
    let mut rest = Deadline::new(stream, LINGER_TIME).take(LINGER_BYTES);
    let _ = io::copy(&mut rest, &mut io::sink());
}

// ---- Client -----------------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    /// No running Hangar Note answers: no endpoint file, or nothing listens on its port.
    #[error("Hangar Note is not running")]
    NotRunning,
    #[error("Hangar Note refused the request: {0}")]
    Refused(String),
    #[error("The local channel failed: {0}")]
    Io(#[from] io::Error),
}

/// Sends one request to the running app (used by `hangar-note capture`) and returns the JSON
/// answer.
pub fn post(
    endpoint: &EndpointFile,
    path: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value, ClientError> {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, endpoint.port));
    let mut stream = match TcpStream::connect_timeout(&address, Duration::from_secs(2)) {
        Ok(stream) => stream,
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::ConnectionRefused | io::ErrorKind::TimedOut
            ) =>
        {
            return Err(ClientError::NotRunning)
        }
        Err(error) => return Err(error.into()),
    };
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    stream.set_write_timeout(Some(Duration::from_secs(30)))?;
    let body = body.to_string();
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        endpoint.port,
        endpoint.token,
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body.as_bytes())?;
    stream.flush()?;
    let mut response = Vec::new();
    stream.take(1024 * 1024).read_to_end(&mut response)?;
    let text = String::from_utf8_lossy(&response);
    let (head, json) = text
        .split_once("\r\n\r\n")
        .ok_or_else(|| ClientError::Refused("no answer".into()))?;
    let value: serde_json::Value = serde_json::from_str(json).unwrap_or(serde_json::Value::Null);
    if head.starts_with("HTTP/1.1 200") {
        Ok(value)
    } else {
        let code = value
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("unknown")
            .to_owned();
        Err(ClientError::Refused(code))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    use crate::test_support::TempDir;

    /// Records the calls; the text is kept only to check it arrived whole.
    #[derive(Default)]
    struct Fake {
        calls: Mutex<Vec<String>>,
        read_only: bool,
    }

    impl Fake {
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }

        fn record(&self, call: String) -> Result<(), ServiceError> {
            self.calls.lock().unwrap().push(call);
            if self.read_only {
                Err(NotesError::ReadOnly.into())
            } else {
                Ok(())
            }
        }
    }

    impl Actions for Fake {
        fn open(
            &self,
            folder: Option<PathBuf>,
            shared: bool,
            note: Option<String>,
        ) -> Result<(), ServiceError> {
            self.record(format!("open {folder:?} {shared} {note:?}"))
        }
        fn quick(&self, folder: Option<PathBuf>) -> Result<(), ServiceError> {
            self.record(format!("quick {folder:?}"))
        }
        fn capture(&self, folder: PathBuf, text: String) -> Result<(), ServiceError> {
            self.record(format!("capture {folder:?} {}", text.len()))
        }
        fn create(
            &self,
            _folder: Option<PathBuf>,
            title: String,
            _text: String,
        ) -> Result<String, ServiceError> {
            self.record(format!("create {title}"))
                .map(|()| "1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5".into())
        }
        fn search(&self, query: &str) -> Result<Vec<HitRow>, ServiceError> {
            self.record(format!("search {query}")).map(|()| Vec::new())
        }
        fn excerpts(
            &self,
            _folder: Option<PathBuf>,
            limit: usize,
        ) -> Result<Vec<Excerpt>, ServiceError> {
            self.record(format!("excerpts {limit}"))
                .map(|()| Vec::new())
        }
        fn flush(&self) -> bool {
            true
        }
    }

    fn abs() -> &'static str {
        if cfg!(windows) {
            r"C:\Projects\demo"
        } else {
            "/projects/demo"
        }
    }

    fn json(text: &str) -> serde_json::Value {
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn tokens_are_32_random_bytes_and_compared_whole() {
        let a = new_token().unwrap();
        let b = new_token().unwrap();
        assert_eq!(a.len(), 2 * TOKEN_BYTES);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
        assert!(token_eq(a.as_bytes(), a.as_bytes()));
        assert!(!token_eq(a.as_bytes(), b.as_bytes()));
        assert!(!token_eq(a.as_bytes(), &a.as_bytes()[1..]));
        let channel = Channel {
            port: 1,
            token: a.clone(),
        };
        assert!(!format!("{channel:?}").contains(&a));
    }

    #[test]
    fn every_route_checks_its_version_and_shape() {
        let fake = Fake::default();
        let body = |value: serde_json::Value| value.to_string().into_bytes();
        let (status, text) = route(
            &fake,
            "/open",
            &body(serde_json::json!({ "version": 1, "folder": abs(), "shared": true })),
        );
        assert_eq!(status, Status::Ok);
        assert_eq!(
            json(&text),
            serde_json::json!({ "version": 1, "ok": true, "shared": "unavailable" })
        );
        let (status, text) = route(&fake, "/open", &body(serde_json::json!({ "version": 2 })));
        assert_eq!(status, Status::BadRequest);
        assert_eq!(json(&text)["error"], "unsupported-version");
        let (_, text) = route(
            &fake,
            "/quick",
            &body(serde_json::json!({ "folder": abs() })),
        );
        assert_eq!(json(&text)["error"], "bad-request");
        let (_, text) = route(
            &fake,
            "/quick",
            &body(serde_json::json!({ "version": 1, "extra": 1 })),
        );
        assert_eq!(json(&text)["error"], "bad-request");
        let (_, text) = route(
            &fake,
            "/quick",
            &body(serde_json::json!({ "version": 1, "folder": "relative" })),
        );
        assert_eq!(json(&text)["error"], "invalid");
        let (status, text) = route(&fake, "/nope", b"{}");
        assert_eq!(status, Status::NotFound);
        assert_eq!(json(&text)["error"], "unknown-route");
        let (_, text) = route(&fake, "/flush", &body(serde_json::json!({ "version": 1 })));
        assert_eq!(
            json(&text),
            serde_json::json!({ "version": 1, "saved": true })
        );
        let (_, text) = route(
            &fake,
            "/create",
            &body(serde_json::json!({ "version": 1, "title": "Review", "text": "x" })),
        );
        assert_eq!(json(&text)["id"], "1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5");
        route(
            &fake,
            "/excerpts",
            &body(serde_json::json!({ "version": 1, "limit": 3 })),
        );
        route(
            &fake,
            "/search",
            &body(serde_json::json!({ "version": 1, "query": "x" })),
        );
        assert_eq!(fake.calls().len(), 4);
    }

    #[test]
    fn capture_takes_at_most_one_mebibyte_and_read_only_is_a_fixed_code() {
        let fake = Fake::default();
        let big = "x".repeat(crate::cli::MAX_CAPTURE_BYTES + 1);
        let body = serde_json::json!({ "version": 1, "folder": abs(), "text": big }).to_string();
        let (status, text) = route(&fake, "/capture", body.as_bytes());
        assert_eq!(status, Status::PayloadTooLarge);
        assert_eq!(json(&text)["error"], "too-large");
        let read_only = Fake {
            read_only: true,
            ..Fake::default()
        };
        let body = serde_json::json!({ "version": 1, "title": "x" }).to_string();
        let (status, text) = route(&read_only, "/create", body.as_bytes());
        assert_eq!(status, Status::Conflict);
        assert_eq!(json(&text)["error"], "read-only");
    }

    fn raw(port: u16, request: &str) -> String {
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut answer = String::new();
        stream.read_to_string(&mut answer).unwrap();
        answer
    }

    #[test]
    fn the_server_admits_only_its_own_token_host_and_no_browser() {
        let fake = Arc::new(Fake::default());
        let channel = Channel::start(fake.clone()).unwrap();
        let endpoint = channel.endpoint();
        let port = endpoint.port;
        let body = r#"{"version":1}"#;
        let request = |headers: &str| {
            format!(
                "POST /flush HTTP/1.1\r\n{headers}Content-Length: {}\r\n\r\n{body}",
                body.len()
            )
        };
        let host = format!("Host: 127.0.0.1:{port}\r\n");
        let auth = format!("Authorization: Bearer {}\r\n", endpoint.token);
        assert!(raw(port, &request(&format!("{host}{auth}"))).starts_with("HTTP/1.1 200"));
        for headers in [
            host.clone(),
            format!("{host}Authorization: Bearer {}\r\n", "0".repeat(64)),
            format!("{host}{auth}Origin: http://example.invalid\r\n"),
            format!("{host}{auth}Sec-Fetch-Site: cross-site\r\n"),
            format!("Host: localhost:{port}\r\n{auth}"),
            format!("Host: attacker.invalid:{port}\r\n{auth}"),
            auth.clone(),
        ] {
            let answer = raw(port, &request(&headers));
            assert!(
                answer.starts_with("HTTP/1.1 401") || answer.starts_with("HTTP/1.1 403"),
                "{headers:?}: {answer}"
            );
        }
        // A body over the route's limit is refused before it is read.
        let big = format!(
            "POST /flush HTTP/1.1\r\n{host}{auth}Content-Length: {}\r\n\r\n",
            MAX_SMALL_BODY_BYTES + 1
        );
        assert!(raw(port, &big).starts_with("HTTP/1.1 413"));
        assert!(raw(port, &format!("GET / HTTP/1.1\r\n{host}\r\n")).starts_with("HTTP/1.1 405"));
    }

    #[test]
    fn the_client_delivers_a_capture_and_knows_when_nobody_listens() {
        let fake = Arc::new(Fake::default());
        let channel = Channel::start(fake.clone()).unwrap();
        let dir = TempDir::new("channel-endpoint");
        write_endpoint(dir.path(), &channel.endpoint()).unwrap();
        let endpoint = read_endpoint(dir.path()).unwrap();
        assert_eq!(endpoint, channel.endpoint());
        let text = "ä".repeat(400_000);
        let answer = post(
            &endpoint,
            "/capture",
            &serde_json::json!({ "version": 1, "folder": abs(), "text": text }),
        )
        .unwrap();
        assert_eq!(answer["ok"], true);
        assert_eq!(
            fake.calls(),
            [format!("capture {:?} {}", PathBuf::from(abs()), text.len())]
        );
        // Nothing listens on a port that was just freed.
        let free = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let gone = EndpointFile {
            port: free.local_addr().unwrap().port(),
            ..endpoint
        };
        drop(free);
        assert!(matches!(
            post(&gone, "/flush", &serde_json::json!({ "version": 1 })),
            Err(ClientError::NotRunning)
        ));
        assert!(read_endpoint(&dir.path().join("missing")).is_err());
    }
}
