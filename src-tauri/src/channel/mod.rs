//! The local channel, Hangar Note's side (ADR 0002, "Local channel"): loopback HTTP on
//! 127.0.0.1 with a random port, through which Hangar (and `hangar-note capture`) reach the
//! running app.
//!
//! - `endpoint.json` `{ version: 1, port, pid, token }` in Hangar Note's local data folder, written
//!   atomically and readable by its owner only (0600 on Unix; on Windows an explicit protected
//!   DACL for the user and SYSTEM, `winsec.rs`). Removed again on quit.
//! - The token is 32 random bytes from the OS (64 hex digits), new on every start, held in
//!   `Zeroizing` and never in `Debug`. It is checked in constant time, after a browser `Origin`
//!   (or `Sec-Fetch-*`), any `Host` other than `127.0.0.1:<port>` and any `Content-Type` other
//!   than `application/json` (415) were refused, as in Hangar's hook endpoint (`gate_service.rs`).
//! - **The server proves itself first** (`proof.rs`): a client sends `POST /v1/hello` with a
//!   nonce and neither token nor content, and goes on only after a valid `X-Channel-Proof`. Every
//!   answer to a request with a nonce carries the proof over that nonce, its status and its body.
//! - Connections: separate slots before and after authentication, the oldest silent one gives
//!   way, 2 s for the head (`slots.rs`). On Windows the socket holds its address with
//!   `SO_EXCLUSIVEADDRUSE`.
//! - Every request body and every answer carries `version`; an unknown one gets
//!   `unsupported-version`, never a guess. Errors are fixed codes (`{ version, error }`).
//! - Routes of phase 1: `open`, `quick`, `capture`, `create`, `search`, `excerpts`, `flush`.
//! - Neither a note's text nor the token is ever logged.
//!
//! The routes call [`Actions`], which the app implements; this module holds no notes logic.

pub mod http;
pub mod proof;
mod slots;

use std::io::{self, BufReader, Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicUsize;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use self::http::{Head, Status};
use self::slots::{Deadline, HeadSlot, Heads, Slot, HEAD_GRACE, HEAD_TIME, MAX_AUTHENTICATED};
use crate::fsio::{read_capped, write_atomic_owner_only};
use crate::notes::NotesError;
use crate::service::{Excerpt, HitRow, ServiceError};

pub use self::slots::MAX_UNAUTHENTICATED;

pub const ENDPOINT_FILE: &str = "endpoint.json";
pub const ENDPOINT_VERSION: u32 = 1;
/// The message version of every request and answer.
pub const MESSAGE_VERSION: u64 = 1;
pub const TOKEN_BYTES: usize = 32;
/// The route on which the server proves itself, before any token or content is sent.
pub const HELLO_PATH: &str = "/v1/hello";
/// Body limit of `capture` and `create`: 1 MiB of text, which JSON escaping may grow.
pub const MAX_TEXT_BODY_BYTES: u64 = 8 * 1024 * 1024;
/// Body limit of every other route.
pub const MAX_SMALL_BODY_BYTES: u64 = 64 * 1024;
const BODY_TIME: Duration = Duration::from_secs(15);
const WRITE_TIME: Duration = Duration::from_secs(5);
const LINGER_TIME: Duration = Duration::from_secs(1);
const LINGER_BYTES: u64 = 64 * 1024;
const MAX_ENDPOINT_BYTES: usize = 4096;
const HEX_DIGITS: &[u8; 16] = b"0123456789abcdef";

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
    UnsupportedMediaType,
    HeadersTooLarge,
    NotImplemented,
    Busy,
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
            Self::UnsupportedMediaType => "unsupported-media-type",
            Self::HeadersTooLarge => "headers-too-large",
            Self::NotImplemented => "not-implemented",
            Self::Busy => "busy",
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
            Self::UnsupportedMediaType => Status::UnsupportedMediaType,
            Self::HeadersTooLarge => Status::HeadersTooLarge,
            Self::NotImplemented => Status::NotImplemented,
            Self::Busy => Status::Unavailable,
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
    /// A new note with captured text in `folder`, shown in the notes area. Answers
    /// [`NotesError::ReadOnly`] while the notes are read only, so the text is never taken in
    /// without a place to go.
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

/// `endpoint.json`. The token is wiped when dropped and never shown by `Debug`.
#[derive(Clone, PartialEq, Eq)]
pub struct EndpointFile {
    pub version: u32,
    pub port: u16,
    /// The process that serves the port, for diagnostics and Hangar's checks.
    pub pid: u32,
    pub token: Zeroizing<String>,
}

impl std::fmt::Debug for EndpointFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EndpointFile")
            .field("version", &self.version)
            .field("port", &self.port)
            .field("pid", &self.pid)
            .finish_non_exhaustive()
    }
}

#[derive(Serialize)]
struct EndpointOut<'a> {
    version: u32,
    port: u16,
    pid: u32,
    token: &'a str,
}

#[derive(Deserialize)]
struct EndpointIn {
    version: u32,
    port: u16,
    pid: u32,
    token: String,
}

/// 32 random bytes from the OS as 64 lowercase hex digits.
pub fn new_token() -> io::Result<Zeroizing<String>> {
    let mut bytes = Zeroizing::new([0u8; TOKEN_BYTES]);
    getrandom::fill(&mut bytes[..]).map_err(|error| io::Error::other(error.to_string()))?;
    let mut token = Zeroizing::new(String::with_capacity(2 * TOKEN_BYTES));
    for byte in bytes.iter() {
        token.push(char::from(HEX_DIGITS[usize::from(byte >> 4)]));
        token.push(char::from(HEX_DIGITS[usize::from(byte & 0x0f)]));
    }
    Ok(token)
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
    let out = EndpointOut {
        version: endpoint.version,
        port: endpoint.port,
        pid: endpoint.pid,
        token: endpoint.token.as_str(),
    };
    let bytes = Zeroizing::new(serde_json::to_vec_pretty(&out).map_err(io::Error::other)?);
    write_atomic_owner_only(&dir.join(ENDPOINT_FILE), &bytes)
}

pub fn read_endpoint(dir: &Path) -> io::Result<EndpointFile> {
    let invalid = |reason: &str| io::Error::new(io::ErrorKind::InvalidData, reason.to_owned());
    let bytes = Zeroizing::new(
        read_capped(&dir.join(ENDPOINT_FILE), MAX_ENDPOINT_BYTES)?
            .ok_or_else(|| invalid("endpoint.json too large"))?,
    );
    let parsed: EndpointIn =
        serde_json::from_slice(&bytes).map_err(|_| invalid("endpoint.json unreadable"))?;
    let token = Zeroizing::new(parsed.token);
    if parsed.version != ENDPOINT_VERSION {
        return Err(invalid("endpoint.json of another version"));
    }
    if !proof::is_hex64(&token) {
        return Err(invalid("endpoint.json holds no valid token"));
    }
    Ok(EndpointFile {
        version: parsed.version,
        port: parsed.port,
        pid: parsed.pid,
        token,
    })
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
        HELLO_PATH => 0,
        "/capture" | "/create" => MAX_TEXT_BODY_BYTES,
        _ => MAX_SMALL_BODY_BYTES,
    }
}

// ---- Server -----------------------------------------------------------------------------------

/// Binds 127.0.0.1 on a random port; on Windows with `SO_EXCLUSIVEADDRUSE` set first, so no other
/// socket can share the address while the app holds it (security review H3).
fn bind_loopback() -> io::Result<TcpListener> {
    #[cfg(windows)]
    {
        use socket2::{Domain, Protocol, Socket, Type};
        let socket = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))?;
        crate::winsec::set_exclusive_address(&socket)?;
        socket.bind(&SocketAddr::from((Ipv4Addr::LOCALHOST, 0)).into())?;
        socket.listen(128)?;
        Ok(socket.into())
    }
    #[cfg(not(windows))]
    {
        TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
    }
}

/// The running channel.
pub struct Channel {
    pub port: u16,
    token: Zeroizing<String>,
}

impl std::fmt::Debug for Channel {
    // The token stays out of every debug print.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Channel")
            .field("port", &self.port)
            .finish_non_exhaustive()
    }
}

impl Channel {
    /// Binds 127.0.0.1 on a random port and serves `actions` on a thread of its own.
    pub fn start(actions: Arc<dyn Actions>) -> io::Result<Self> {
        let listener = bind_loopback()?;
        let port = listener.local_addr()?.port();
        let token = new_token()?;
        let shared = Arc::new(Server {
            port,
            key: proof::key(&token),
            token: token.clone(),
            actions,
            heads: Arc::default(),
            authenticated: Arc::default(),
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
            pid: std::process::id(),
            token: self.token.clone(),
        }
    }
}

struct Server {
    port: u16,
    token: Zeroizing<String>,
    key: Zeroizing<[u8; 32]>,
    actions: Arc<dyn Actions>,
    heads: Arc<Mutex<Heads>>,
    authenticated: Arc<AtomicUsize>,
}

/// What a request head is admitted to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Admitted {
    /// `/v1/hello`: the proof alone, without a token.
    Hello,
    /// A route, with the token.
    Request,
}

impl Server {
    fn accept(self: &Arc<Self>, listener: &TcpListener) {
        for stream in listener.incoming() {
            let stream = match stream {
                Ok(stream) => stream,
                Err(error) => {
                    // Out of handles and similar: do not spin.
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
            // No head thread left and nobody silent to give way: closed unanswered, without a
            // read or a write that could block this thread.
            let Some(slot) = HeadSlot::take(&self.heads, &stream, HEAD_GRACE) else {
                continue;
            };
            let server = Arc::clone(self);
            // A failed spawn drops the closure with its slot and stream.
            let _ = thread::Builder::new()
                .name("channel-conn".to_owned())
                .spawn(move || server.serve(&stream, slot));
        }
    }

    /// Who sent the request: a browser page or a foreign `Host` is refused first, then anything
    /// that is not JSON, then a request without a well-formed nonce; only routes other than the
    /// hello need the token.
    fn admit(&self, head: &Head) -> Result<Admitted, ErrorCode> {
        let expected = format!("127.0.0.1:{}", self.port);
        if head.from_browser || head.host.as_deref() != Some(expected.as_str()) {
            return Err(ErrorCode::Forbidden);
        }
        if !head.json {
            return Err(ErrorCode::UnsupportedMediaType);
        }
        if !head.nonce.as_deref().is_some_and(proof::is_hex64) {
            return Err(ErrorCode::BadRequest);
        }
        if head.path == HELLO_PATH {
            return Ok(Admitted::Hello);
        }
        match &head.token {
            Some(token) if token_eq(token.as_bytes(), self.token.as_bytes()) => {
                Ok(Admitted::Request)
            }
            _ => Err(ErrorCode::Unauthorized),
        }
    }

    fn serve(&self, stream: &TcpStream, unauthenticated: HeadSlot) {
        let _ = stream.set_write_timeout(Some(WRITE_TIME));
        let deadline = Deadline::for_head(stream, HEAD_TIME, Arc::clone(&unauthenticated.state));
        let mut reader = BufReader::new(deadline);
        // Held until the connection closes, once the request is authenticated.
        let mut _authenticated = None;
        let mut nonce = None;
        let (status, body) = match http::read_head(&mut reader) {
            // Out of the head slots before the answer is written: the accept thread switches the
            // socket of a connection in them to non-blocking for a moment.
            Err(error) => match error.status() {
                Some(status) if unauthenticated.head_read() => {
                    error_body(ErrorCode::from_status(status))
                }
                _ => return,
            },
            Ok(_) if !unauthenticated.head_read() => return,
            Ok(head) => {
                nonce = head.nonce.clone().filter(|nonce| proof::is_hex64(nonce));
                match self.admit(&head) {
                    Err(code) => error_body(code),
                    Ok(_) if head.content_length > body_limit(&head.path) => {
                        error_body(ErrorCode::TooLarge)
                    }
                    Ok(Admitted::Hello) => answer(serde_json::json!({})),
                    Ok(Admitted::Request) => {
                        drop(unauthenticated);
                        match Slot::take(&self.authenticated, MAX_AUTHENTICATED) {
                            None => error_body(ErrorCode::Busy),
                            Some(slot) => {
                                _authenticated = Some(slot);
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
                        }
                    }
                }
            }
        };
        let proof =
            nonce.map(|nonce| proof::proof(&self.key, &nonce, status.code(), body.as_bytes()));
        answer_and_close(stream, &http::response(status, &body, proof.as_deref()));
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

const CONNECT_TIME: Duration = Duration::from_secs(2);
const HELLO_TIME: Duration = Duration::from_secs(5);
const REQUEST_TIME: Duration = Duration::from_secs(30);
/// The most of an answer the client reads.
const MAX_ANSWER_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    /// No endpoint file, or nothing listens on its port: no Hangar Note runs.
    #[error("Hangar Note is not running")]
    NotRunning,
    /// Something answers on the port but cannot prove that it knows the token (a program that
    /// took the port of a crashed run, or a broken answer). Only the nonce was sent; the client
    /// treats the app as not running.
    #[error("The program on Hangar Note's port did not prove itself")]
    NotProven,
    /// The content was sent, but no proven answer came back: it may not have arrived.
    #[error("Hangar Note did not confirm the request")]
    Unconfirmed,
    #[error("Hangar Note refused the request: {0}")]
    Refused(String),
    #[error("The local channel failed: {0}")]
    Io(#[from] io::Error),
}

/// One answer as the client reads it.
struct Reply {
    status: u16,
    proof: Option<String>,
    body: Vec<u8>,
}

impl Reply {
    fn proven(&self, key: &[u8; 32], nonce: &str) -> bool {
        self.proof
            .as_deref()
            .is_some_and(|claimed| proof::verify(key, nonce, self.status, &self.body, claimed))
    }
}

/// Why an exchange failed: before anything was sent, or after.
enum Exchange {
    Connect(io::Error),
    Broken,
}

fn parse_reply(raw: &[u8]) -> io::Result<Reply> {
    let broken = || io::Error::new(io::ErrorKind::InvalidData, "not an HTTP answer");
    let split = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(broken)?;
    let head = std::str::from_utf8(&raw[..split]).map_err(|_| broken())?;
    let mut lines = head.split("\r\n");
    let status_line = lines.next().ok_or_else(broken)?;
    let mut parts = status_line.split(' ');
    let (Some(version), Some(code)) = (parts.next(), parts.next()) else {
        return Err(broken());
    };
    if !version.starts_with("HTTP/1.")
        || code.len() != 3
        || !code.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(broken());
    }
    let status = code.parse().map_err(|_| broken())?;
    let mut proof = None;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case(proof::PROOF_HEADER) {
                if proof.is_some() {
                    return Err(broken());
                }
                proof = Some(value.trim().to_owned());
            }
        }
    }
    Ok(Reply {
        status,
        proof,
        body: raw[split + 4..].to_vec(),
    })
}

/// One request on a connection of its own. `token` is sent only on a real request, after the
/// hello was proven.
fn exchange(
    endpoint: &EndpointFile,
    path: &str,
    nonce: &str,
    token: Option<&str>,
    body: &[u8],
    time: Duration,
) -> Result<Reply, Exchange> {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, endpoint.port));
    let mut stream =
        TcpStream::connect_timeout(&address, CONNECT_TIME).map_err(Exchange::Connect)?;
    let sent = (|| -> io::Result<Reply> {
        stream.set_read_timeout(Some(time))?;
        stream.set_write_timeout(Some(time))?;
        let authorization = token
            .map(|token| Zeroizing::new(format!("Authorization: Bearer {token}\r\n")))
            .unwrap_or_default();
        let head = Zeroizing::new(format!(
            "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n{}Content-Type: application/json\r\n\
             {}: {nonce}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            endpoint.port,
            authorization.as_str(),
            proof::NONCE_HEADER,
            body.len()
        ));
        stream.write_all(head.as_bytes())?;
        stream.write_all(body)?;
        stream.flush()?;
        let mut raw = Vec::new();
        (&mut stream).take(MAX_ANSWER_BYTES).read_to_end(&mut raw)?;
        parse_reply(&raw)
    })();
    sent.map_err(|_| Exchange::Broken)
}

/// Sends one request to the running app (used by `hangar-note capture`) and returns the JSON
/// answer. First the server proves on `/v1/hello` that it knows the token; only then do the token
/// and `body` go out, and the answer counts only with a valid proof of its own.
pub fn post(
    endpoint: &EndpointFile,
    path: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value, ClientError> {
    let key = proof::key(&endpoint.token);
    let hello_nonce = proof::new_nonce()?;
    let hello = match exchange(endpoint, HELLO_PATH, &hello_nonce, None, b"", HELLO_TIME) {
        Ok(reply) => reply,
        Err(Exchange::Connect(error))
            if matches!(
                error.kind(),
                io::ErrorKind::ConnectionRefused | io::ErrorKind::TimedOut
            ) =>
        {
            return Err(ClientError::NotRunning)
        }
        Err(Exchange::Connect(error)) => return Err(error.into()),
        Err(Exchange::Broken) => return Err(ClientError::NotProven),
    };
    if hello.status != 200 || !hello.proven(&key, &hello_nonce) {
        return Err(ClientError::NotProven);
    }
    let nonce = proof::new_nonce()?;
    let text = Zeroizing::new(body.to_string());
    let reply = match exchange(
        endpoint,
        path,
        &nonce,
        Some(&endpoint.token),
        text.as_bytes(),
        REQUEST_TIME,
    ) {
        Ok(reply) => reply,
        // Nothing went out: the request was not delivered.
        Err(Exchange::Connect(error)) => return Err(error.into()),
        Err(Exchange::Broken) => return Err(ClientError::Unconfirmed),
    };
    if !reply.proven(&key, &nonce) {
        return Err(ClientError::Unconfirmed);
    }
    let value: serde_json::Value =
        serde_json::from_slice(&reply.body).unwrap_or(serde_json::Value::Null);
    if reply.status == 200 {
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
        assert!(proof::is_hex64(&a));
        assert_ne!(a, b);
        assert!(token_eq(a.as_bytes(), a.as_bytes()));
        assert!(!token_eq(a.as_bytes(), b.as_bytes()));
        assert!(!token_eq(a.as_bytes(), &a.as_bytes()[1..]));
        // Neither the channel nor its endpoint file shows the token in a debug print.
        let channel = Channel {
            port: 1,
            token: a.clone(),
        };
        assert!(!format!("{channel:?}").contains(a.as_str()));
        assert!(!format!("{:?}", channel.endpoint()).contains(a.as_str()));
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

    fn nonce_header(nonce: &str) -> String {
        format!("{}: {nonce}\r\n", proof::NONCE_HEADER)
    }

    #[test]
    fn the_server_admits_only_its_own_token_host_json_and_no_browser() {
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
        let auth = format!("Authorization: Bearer {}\r\n", endpoint.token.as_str());
        let json_type = "Content-Type: application/json\r\n";
        let nonce = nonce_header(&proof::new_nonce().unwrap());
        let good = format!("{host}{auth}{json_type}{nonce}");
        assert!(raw(port, &request(&good)).starts_with("HTTP/1.1 200"));
        for (headers, status) in [
            (format!("{host}{json_type}{nonce}"), "401"),
            (
                format!(
                    "{host}Authorization: Bearer {}\r\n{json_type}{nonce}",
                    "0".repeat(64)
                ),
                "401",
            ),
            (format!("{good}Origin: http://example.invalid\r\n"), "403"),
            (format!("{good}Sec-Fetch-Site: cross-site\r\n"), "403"),
            (
                format!("Host: localhost:{port}\r\n{auth}{json_type}{nonce}"),
                "403",
            ),
            (
                format!("Host: attacker.invalid:{port}\r\n{auth}{json_type}{nonce}"),
                "403",
            ),
            (format!("{auth}{json_type}{nonce}"), "403"),
            // Not JSON, or no type at all: 415, also for the channel's own client.
            (
                format!("{host}{auth}Content-Type: text/plain\r\n{nonce}"),
                "415",
            ),
            (format!("{host}{auth}{nonce}"), "415"),
            // No nonce, or one of the wrong form.
            (format!("{host}{auth}{json_type}"), "400"),
            (
                format!("{host}{auth}{json_type}{}", nonce_header("abc")),
                "400",
            ),
        ] {
            let answer = raw(port, &request(&headers));
            assert!(
                answer.starts_with(&format!("HTTP/1.1 {status}")),
                "{headers:?}: {answer}"
            );
        }
        // A body over the route's limit is refused before it is read.
        let big = format!(
            "POST /flush HTTP/1.1\r\n{good}Content-Length: {}\r\n\r\n",
            MAX_SMALL_BODY_BYTES + 1
        );
        assert!(raw(port, &big).starts_with("HTTP/1.1 413"));
        assert!(raw(port, &format!("GET / HTTP/1.1\r\n{host}\r\n")).starts_with("HTTP/1.1 405"));
    }

    #[test]
    fn the_server_proves_itself_on_hello_without_the_token() {
        let fake = Arc::new(Fake::default());
        let channel = Channel::start(fake.clone()).unwrap();
        let endpoint = channel.endpoint();
        let key = proof::key(&endpoint.token);
        let nonce = proof::new_nonce().unwrap();
        let reply = match exchange(&endpoint, HELLO_PATH, &nonce, None, b"", HELLO_TIME) {
            Ok(reply) => reply,
            Err(_) => panic!("hello failed"),
        };
        assert_eq!(reply.status, 200);
        assert_eq!(reply.body, br#"{"version":1}"#);
        assert!(reply.proven(&key, &nonce));
        // Another token's key, or another nonce, does not verify.
        assert!(!reply.proven(&proof::key(&"0".repeat(64)), &nonce));
        assert!(!reply.proven(&key, &proof::new_nonce().unwrap()));
        // Errors carry the proof as well, so a client can trust a refusal.
        let refused = match exchange(
            &endpoint,
            "/flush",
            &nonce,
            None,
            b"{\"version\":1}",
            HELLO_TIME,
        ) {
            Ok(reply) => reply,
            Err(_) => panic!("request failed"),
        };
        assert_eq!(refused.status, 401);
        assert!(refused.proven(&key, &nonce));
        // The hello takes no body and calls nothing.
        let with_body = match exchange(&endpoint, HELLO_PATH, &nonce, None, b"{}", HELLO_TIME) {
            Ok(reply) => reply,
            Err(_) => panic!("hello failed"),
        };
        assert_eq!(with_body.status, 413);
        assert!(fake.calls().is_empty());
    }

    #[test]
    fn the_client_delivers_a_capture_and_knows_when_nobody_listens() {
        let fake = Arc::new(Fake::default());
        let channel = Channel::start(fake.clone()).unwrap();
        let dir = TempDir::new("channel-endpoint");
        write_endpoint(dir.path(), &channel.endpoint()).unwrap();
        let endpoint = read_endpoint(dir.path()).unwrap();
        assert_eq!(endpoint, channel.endpoint());
        assert_eq!(endpoint.pid, std::process::id());
        let file: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.path().join(ENDPOINT_FILE)).unwrap())
                .unwrap();
        let mut fields: Vec<&str> = file
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        fields.sort_unstable();
        assert_eq!(fields, ["pid", "port", "token", "version"]);
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

    #[test]
    fn a_read_only_capture_is_refused_over_the_channel() {
        let fake = Arc::new(Fake {
            read_only: true,
            ..Fake::default()
        });
        let channel = Channel::start(fake.clone()).unwrap();
        let result = post(
            &channel.endpoint(),
            "/capture",
            &serde_json::json!({ "version": 1, "folder": abs(), "text": "marker-capture-4d1" }),
        );
        match result {
            Err(ClientError::Refused(code)) => assert_eq!(code, ErrorCode::ReadOnly.as_str()),
            other => panic!("{other:?}"),
        }
        assert_eq!(fake.calls().len(), 1);
    }

    /// A program that took the port of a crashed run answers like the channel, but cannot know
    /// the token: it gets the hello's nonce and nothing else.
    #[test]
    fn a_squatter_without_the_proof_never_sees_the_text() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let squatter = thread::spawn(move || {
            let mut seen = Vec::new();
            // Answers every connection, as long as the client keeps coming.
            listener.set_nonblocking(false).unwrap();
            for _ in 0..2 {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                stream
                    .set_read_timeout(Some(Duration::from_millis(500)))
                    .unwrap();
                let mut buffer = vec![0u8; 64 * 1024];
                let mut got = Vec::new();
                while let Ok(n) = stream.read(&mut buffer) {
                    if n == 0 {
                        break;
                    }
                    got.extend_from_slice(&buffer[..n]);
                    if got.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                let body = r#"{"version":1}"#;
                let fake_proof = "0".repeat(64);
                let answer = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n{}: {fake_proof}\r\n\
                     Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    proof::PROOF_HEADER,
                    body.len()
                );
                let _ = stream.write_all(answer.as_bytes());
                seen.push(got);
            }
            seen
        });
        let stale = EndpointFile {
            version: ENDPOINT_VERSION,
            port,
            pid: 1,
            token: new_token().unwrap(),
        };
        let result = post(
            &stale,
            "/capture",
            &serde_json::json!({ "version": 1, "folder": abs(), "text": "marker-squat-7e3" }),
        );
        assert!(matches!(result, Err(ClientError::NotProven)), "{result:?}");
        // Unblock the squatter's second accept, which never comes from the client.
        let _ = TcpStream::connect((Ipv4Addr::LOCALHOST, port));
        let seen = squatter.join().unwrap();
        assert!(!seen.is_empty());
        let all: Vec<u8> = seen.concat();
        let text = String::from_utf8_lossy(&all);
        assert!(text.contains(HELLO_PATH), "{text}");
        assert!(!text.contains("marker-squat-7e3"), "{text}");
        assert!(!text.contains(stale.token.as_str()), "{text}");
        assert!(!text.contains("/capture"), "{text}");
        assert!(!text.contains("Authorization"), "{text}");
    }

    fn valid_flush(port: u16, token: &str) -> String {
        let body = r#"{"version":1}"#;
        raw(
            port,
            &format!(
                "POST /flush HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\n\
                 Content-Type: application/json\r\n{}Content-Length: {}\r\n\r\n{body}",
                nonce_header(&proof::new_nonce().unwrap()),
                body.len()
            ),
        )
    }

    #[test]
    fn silent_connections_do_not_keep_a_valid_request_out() {
        let fake = Arc::new(Fake::default());
        let channel = Channel::start(fake.clone()).unwrap();
        let endpoint = channel.endpoint();
        let port = endpoint.port;
        let silent: Vec<TcpStream> = (0..MAX_UNAUTHENTICATED)
            .map(|_| TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap())
            .collect();
        let answer = valid_flush(port, &endpoint.token);
        assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
        drop(silent);
    }

    #[test]
    fn the_oldest_silent_connection_gives_way_when_every_head_thread_is_taken() {
        let fake = Arc::new(Fake::default());
        let channel = Channel::start(fake.clone()).unwrap();
        let endpoint = channel.endpoint();
        let port = endpoint.port;
        let opened = std::time::Instant::now();
        let mut silent: Vec<TcpStream> = (0..slots::MAX_HEAD_THREADS)
            .map(|_| TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap())
            .collect();
        thread::sleep(HEAD_GRACE + Duration::from_millis(200));
        let answer = valid_flush(port, &endpoint.token);
        assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
        // The oldest was closed for it, well before its own head time ran out.
        let mut probe = [0u8; 1];
        silent[0]
            .set_read_timeout(Some(Duration::from_millis(200)))
            .unwrap();
        let closed = matches!(silent[0].read(&mut probe), Ok(0) | Err(_));
        assert!(closed);
        assert!(opened.elapsed() < HEAD_TIME + Duration::from_millis(500));
        silent.clear();
    }

    /// Windows lets a second socket with `SO_REUSEADDR` bind a port another one listens on unless
    /// the first holds it with `SO_EXCLUSIVEADDRUSE` (Microsoft's documentation).
    #[cfg(windows)]
    #[test]
    fn no_other_socket_binds_the_channels_address() {
        use socket2::{Domain, Socket, Type};
        let channel = Channel::start(Arc::new(Fake::default())).unwrap();
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, channel.port));
        let same = Socket::new(Domain::IPV4, Type::STREAM, None).unwrap();
        same.set_reuse_address(true).unwrap();
        assert!(
            same.bind(&address.into()).is_err(),
            "the same address was bound"
        );
    }

    #[cfg(windows)]
    #[test]
    fn endpoint_json_is_for_its_owner_only() {
        let dir = TempDir::new("channel-dacl");
        let channel = Channel::start(Arc::new(Fake::default())).unwrap();
        write_endpoint(dir.path(), &channel.endpoint()).unwrap();
        // Written twice: the replacement keeps the owner-only descriptor too.
        write_endpoint(dir.path(), &channel.endpoint()).unwrap();
        let sddl = crate::winsec::dacl_sddl(&dir.path().join(ENDPOINT_FILE)).unwrap();
        assert!(sddl.starts_with("D:P"), "{sddl}");
        for foreign in [";;;BU)", ";;;WD)", ";;;AU)"] {
            assert!(!sddl.contains(foreign), "{foreign} in {sddl}");
        }
        assert_eq!(sddl.matches("(A;").count(), 2, "{sddl}");
    }
}
