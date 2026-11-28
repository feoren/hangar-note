//! The local channel, Hangar Note's side (ADR 0002, "Local channel"): loopback HTTP on
//! 127.0.0.1 with a random port, through which Hangar (and `hangar-note capture`) reach the
//! running app.
//!
//! - `endpoint.json` `{ version: 1, port, pid, token, teamToken }` in Hangar Note's local data
//!   folder, written atomically and readable by its owner only (0600 on Unix; on Windows an
//!   explicit protected DACL for the user and SYSTEM plus a medium integrity label, `winsec.rs`).
//!   Removed again on quit.
//! - Both tokens are 32 random bytes from the OS (64 hex digits), new on every start, held in
//!   `Zeroizing` and never in `Debug`. `token` serves every route but the team routes
//!   (`/team/...`), which take `teamToken` only ([`route_scope`]), so whoever may search or create
//!   notes never opens or seals a team note. A token is checked in constant time, after a browser
//!   `Origin` (or `Sec-Fetch-*`), any `Host` other than `127.0.0.1:<port>` and any `Content-Type`
//!   other than `application/json` (415) were refused, as in Hangar's hook endpoint
//!   (`gate_service.rs`).
//! - **The server proves itself first** (`proof.rs`): a client sends `POST /v1/hello` with a
//!   nonce and neither token nor content, and goes on only after a valid `X-Channel-Proof`. Every
//!   answer to a request with a nonce carries the proof over that nonce, the request's path, its
//!   status and its body.
//! - **One exchange, one connection:** the hello and the real request travel over the same
//!   connection, which stays open after the hello for exactly one more request and then closes.
//!   Content can only reach the program that proved itself; a connection that closes after the
//!   hello gets nothing more from the client ([`ClientError::NotProven`]).
//! - Connections: separate slots before and after authentication, the oldest silent one gives
//!   way, 2 s for each head (`slots.rs`). A connection gives its head slot back before it is
//!   answered, and an answer without a valid token waits at most [`QUICK_LINGER_TIME`] for the
//!   client to finish, in a bounded count of its own, so finished hellos never fill the slots.
//!   On Windows the socket holds its address with `SO_EXCLUSIVEADDRUSE`.
//! - Every request body and every answer carries `version`; an unknown one gets
//!   `unsupported-version`, never a guess. Errors are fixed codes (`{ version, error }`); storage
//!   failures are `denied`, `disk-full`, `too-large`, `not-found` or `io`, never the OS text.
//! - Routes of phase 1: `open`, `quick`, `capture`, `create`, `search`, `excerpts`, `flush`.
//! - Neither a note's text nor the token is ever logged.
//!
//! The routes call [`Actions`], which the app implements; this module holds no notes logic.

pub mod http;
pub mod proof;
mod slots;

use std::io::{self, BufRead, Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicUsize;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use self::http::{Head, Status, WipingReader};
use self::slots::{
    Deadline, HeadSlot, Heads, Slot, AFTER_HELLO_GRACE, HEAD_GRACE, HEAD_TIME, MAX_AUTHENTICATED,
};
use crate::fsio::{read_capped_wiped, write_atomic_owner_only, StorageCode};
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
/// The prefix of the team routes, which take the team token only.
pub const TEAM_PREFIX: &str = "/team/";
/// A hello and one request: the most a connection carries.
pub const MAX_REQUESTS_PER_CONNECTION: usize = 2;
const BODY_TIME: Duration = Duration::from_secs(15);
const WRITE_TIME: Duration = Duration::from_secs(5);
/// How long an authenticated answer waits for the client to finish before the socket closes.
const LINGER_TIME: Duration = Duration::from_secs(1);
/// The same for an answer to a request without a valid token (a hello, a refusal): short, so a
/// stream of finished hellos cannot keep threads waiting (second security review, N-C).
pub const QUICK_LINGER_TIME: Duration = Duration::from_millis(100);
/// Answers without a valid token that wait at once; beyond, the socket closes without waiting.
const MAX_QUICK_LINGERING: usize = 32;
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
    /// Storage failures ([`StorageCode`]); `too-large` is [`ErrorCode::TooLarge`].
    Denied,
    DiskFull,
    NotFound,
    Io,
    Internal,
}

impl From<StorageCode> for ErrorCode {
    fn from(code: StorageCode) -> Self {
        match code {
            StorageCode::Denied => Self::Denied,
            StorageCode::DiskFull => Self::DiskFull,
            StorageCode::TooLarge => Self::TooLarge,
            StorageCode::NotFound => Self::NotFound,
            StorageCode::Io => Self::Io,
        }
    }
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
            Self::Denied => StorageCode::Denied.as_str(),
            Self::DiskFull => StorageCode::DiskFull.as_str(),
            Self::NotFound => StorageCode::NotFound.as_str(),
            Self::Io => StorageCode::Io.as_str(),
            Self::Internal => "internal",
        }
    }

    pub fn status(self) -> Status {
        match self {
            Self::BadRequest | Self::UnsupportedVersion | Self::Invalid => Status::BadRequest,
            Self::Unauthorized => Status::Unauthorized,
            Self::Forbidden => Status::Forbidden,
            Self::UnknownRoute | Self::UnknownNote | Self::NotFound => Status::NotFound,
            Self::MethodNotAllowed => Status::MethodNotAllowed,
            Self::LengthRequired => Status::LengthRequired,
            Self::TooLarge => Status::PayloadTooLarge,
            Self::UnsupportedMediaType => Status::UnsupportedMediaType,
            Self::HeadersTooLarge => Status::HeadersTooLarge,
            Self::NotImplemented => Status::NotImplemented,
            Self::Busy => Status::Unavailable,
            Self::ReadOnly => Status::Conflict,
            Self::Denied | Self::DiskFull | Self::Io | Self::Internal => Status::Internal,
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
                | NotesError::NotText,
            ) => Self::Invalid,
            ServiceError::Notes(NotesError::TooLarge { .. } | NotesError::IndexFull(_)) => {
                Self::TooLarge
            }
            ServiceError::Notes(NotesError::Io { source, .. }) => StorageCode::of(source).into(),
            ServiceError::Meta(error) => error.storage_code().map_or(Self::Internal, Self::from),
            // Editor rules of the windows; no route writes an open note.
            ServiceError::Notes(NotesError::Changed)
            | ServiceError::OnDesktop
            | ServiceError::NotOpen => Self::Internal,
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
    /// A new note with captured text in `folder`, written to disk before this returns and then
    /// shown in the notes area (security review B1); returns its ID. Answers
    /// [`NotesError::ReadOnly`] while the notes are read only, so the text is never taken in
    /// without a place to go.
    fn capture(&self, folder: PathBuf, text: String) -> Result<String, ServiceError>;
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

/// `endpoint.json`. The tokens are wiped when dropped and never shown by `Debug`.
#[derive(Clone, PartialEq, Eq)]
pub struct EndpointFile {
    pub version: u32,
    pub port: u16,
    /// The process that serves the port, for diagnostics and Hangar's checks.
    pub pid: u32,
    /// Every route but the team routes; the key of the server proof is derived from it.
    pub token: Zeroizing<String>,
    /// The team routes (`/team/...`) only.
    pub team_token: Zeroizing<String>,
}

/// Which token a route takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// `open`, `quick`, `capture`, `create`, `search`, `excerpts`, `flush`: `token`.
    Notes,
    /// `/team/...`: `teamToken`.
    Team,
}

/// The scope of a route by its path. Pure, so the separation is testable without a socket.
pub fn route_scope(path: &str) -> Scope {
    if path.starts_with(TEAM_PREFIX) {
        Scope::Team
    } else {
        Scope::Notes
    }
}

/// Whether `presented` is the token of `path`'s scope; a token of the other scope never is.
/// Compared in constant time.
pub fn authorized(path: &str, presented: Option<&str>, token: &str, team_token: &str) -> bool {
    let expected = match route_scope(path) {
        Scope::Notes => token,
        Scope::Team => team_token,
    };
    presented.is_some_and(|presented| token_eq(presented.as_bytes(), expected.as_bytes()))
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
#[serde(rename_all = "camelCase")]
struct EndpointOut<'a> {
    version: u32,
    port: u16,
    pid: u32,
    token: &'a str,
    team_token: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EndpointIn {
    version: u32,
    port: u16,
    pid: u32,
    token: String,
    team_token: String,
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

/// Counts the bytes written to it and keeps none.
struct ByteCount(usize);

impl Write for ByteCount {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 += bytes.len();
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// `value` as JSON in a buffer of exactly its size, wiped when dropped (security review B5): a
/// buffer that grows while serializing leaves copies of what it held (a token, a captured text)
/// in memory it gave back. Measured in a first pass that keeps nothing.
pub fn to_json_wiped<T: Serialize + ?Sized>(
    value: &T,
    pretty: bool,
) -> io::Result<Zeroizing<Vec<u8>>> {
    let mut count = ByteCount(0);
    if pretty {
        serde_json::to_writer_pretty(&mut count, value)
    } else {
        serde_json::to_writer(&mut count, value)
    }
    .map_err(io::Error::other)?;
    let mut bytes = Zeroizing::new(Vec::with_capacity(count.0));
    if pretty {
        serde_json::to_writer_pretty(&mut *bytes, value)
    } else {
        serde_json::to_writer(&mut *bytes, value)
    }
    .map_err(io::Error::other)?;
    Ok(bytes)
}

pub fn write_endpoint(dir: &Path, endpoint: &EndpointFile) -> io::Result<()> {
    let out = EndpointOut {
        version: endpoint.version,
        port: endpoint.port,
        pid: endpoint.pid,
        token: endpoint.token.as_str(),
        team_token: endpoint.team_token.as_str(),
    };
    let bytes = to_json_wiped(&out, true)?;
    write_atomic_owner_only(&dir.join(ENDPOINT_FILE), &bytes)
}

pub fn read_endpoint(dir: &Path) -> io::Result<EndpointFile> {
    let invalid = |reason: &str| io::Error::new(io::ErrorKind::InvalidData, reason.to_owned());
    let bytes = read_capped_wiped(&dir.join(ENDPOINT_FILE), MAX_ENDPOINT_BYTES)?
        .ok_or_else(|| invalid("endpoint.json too large"))?;
    let parsed: EndpointIn =
        serde_json::from_slice(&bytes).map_err(|_| invalid("endpoint.json unreadable"))?;
    let token = Zeroizing::new(parsed.token);
    let team_token = Zeroizing::new(parsed.team_token);
    if parsed.version != ENDPOINT_VERSION {
        return Err(invalid("endpoint.json of another version"));
    }
    if !proof::is_hex64(&token) || !proof::is_hex64(&team_token) {
        return Err(invalid("endpoint.json holds no valid token"));
    }
    // One token for both scopes would undo their separation.
    if token_eq(token.as_bytes(), team_token.as_bytes()) {
        return Err(invalid("endpoint.json holds the same token twice"));
    }
    Ok(EndpointFile {
        version: parsed.version,
        port: parsed.port,
        pid: parsed.pid,
        token,
        team_token,
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
        Err(error) => {
            let code = ErrorCode::from(&error);
            // The caller gets the code; the path and the OS error (never content) go to the log.
            if matches!(
                code,
                ErrorCode::Denied
                    | ErrorCode::DiskFull
                    | ErrorCode::NotFound
                    | ErrorCode::Io
                    | ErrorCode::Internal
            ) {
                eprintln!("hangar-note: channel {}: {error}", code.as_str());
            }
            error_body(code)
        }
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
                    |id| serde_json::json!({ "ok": true, "id": id }),
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
    team_token: Zeroizing<String>,
}

impl std::fmt::Debug for Channel {
    // The tokens stay out of every debug print.
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
        let team_token = new_token()?;
        let shared = Arc::new(Server {
            port,
            key: proof::key(&token),
            token: token.clone(),
            team_token: team_token.clone(),
            actions,
            heads: Arc::default(),
            authenticated: Arc::default(),
            lingering: Arc::default(),
        });
        thread::Builder::new()
            .name("channel-accept".to_owned())
            .spawn(move || shared.accept(&listener))?;
        Ok(Self {
            port,
            token,
            team_token,
        })
    }

    pub fn endpoint(&self) -> EndpointFile {
        EndpointFile {
            version: ENDPOINT_VERSION,
            port: self.port,
            pid: std::process::id(),
            token: self.token.clone(),
            team_token: self.team_token.clone(),
        }
    }
}

struct Server {
    port: u16,
    token: Zeroizing<String>,
    team_token: Zeroizing<String>,
    key: Zeroizing<[u8; 32]>,
    actions: Arc<dyn Actions>,
    heads: Arc<Mutex<Heads>>,
    authenticated: Arc<AtomicUsize>,
    /// Answers without a valid token waiting for their client to finish.
    lingering: Arc<AtomicUsize>,
}

/// What a request head is admitted to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Admitted {
    /// `/v1/hello`: the proof alone, without a token.
    Hello,
    /// A route, with the token of its scope.
    Request,
}

/// What follows one answer on a connection.
enum After {
    /// A hello was answered and the connection stays open for the request, which has a head slot
    /// of its own.
    Next(HeadSlot),
    Closed,
}

type ConnectionReader<'a> = WipingReader<Deadline<'a>>;

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
    /// hello need a token, and each the token of its scope.
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
        let presented = head.token.as_ref().map(|token| token.as_str());
        if authorized(&head.path, presented, &self.token, &self.team_token) {
            Ok(Admitted::Request)
        } else {
            Err(ErrorCode::Unauthorized)
        }
    }

    /// At most [`MAX_REQUESTS_PER_CONNECTION`] requests: a hello whose client asked to keep the
    /// connection, then one more; anything else closes after its answer.
    fn serve(&self, stream: &TcpStream, first: HeadSlot) {
        let _ = stream.set_write_timeout(Some(WRITE_TIME));
        let deadline = Deadline::for_head(stream, HEAD_TIME, Arc::clone(&first.state));
        let mut reader = WipingReader::new(deadline);
        let mut slot = first;
        for turn in 1..=MAX_REQUESTS_PER_CONNECTION {
            let may_continue = turn < MAX_REQUESTS_PER_CONNECTION;
            match self.serve_one(stream, &mut reader, slot, may_continue) {
                After::Next(next) => {
                    reader
                        .get_mut()
                        .watch_head(HEAD_TIME, Arc::clone(&next.state));
                    slot = next;
                }
                After::Closed => return,
            }
        }
    }

    /// One request on the connection, from its head to its answer.
    fn serve_one(
        &self,
        stream: &TcpStream,
        reader: &mut ConnectionReader<'_>,
        unauthenticated: HeadSlot,
        may_continue: bool,
    ) -> After {
        let read = http::read_head(reader);
        // Out of the head slots before the answer is written: the accept thread switches the
        // socket of a connection in them to non-blocking for a moment. `false`: a newer
        // connection closed this one first.
        if !unauthenticated.head_read() {
            return After::Closed;
        }
        let head = match read {
            Ok(head) => head,
            Err(error) => {
                drop(unauthenticated);
                if let Some(status) = error.status() {
                    let (status, body) = error_body(ErrorCode::from_status(status));
                    self.answer_quickly(stream, &http::response(status, &body, None, false));
                }
                return After::Closed;
            }
        };
        let nonce = head.nonce.clone().filter(|nonce| proof::is_hex64(nonce));
        let respond = |(status, body): (Status, String), keep_alive: bool| {
            let proof = nonce.as_deref().map(|nonce| {
                proof::proof(&self.key, nonce, &head.path, status.code(), body.as_bytes())
            });
            http::response(status, &body, proof.as_deref(), keep_alive)
        };
        let refusal = match self.admit(&head) {
            Err(code) => code,
            Ok(_) if head.content_length > body_limit(&head.path) => ErrorCode::TooLarge,
            Ok(Admitted::Hello) => {
                // Given back before the answer is written (N-C); the request that may follow
                // gets a slot of its own, with the short grace of a client that just checked
                // the proof. Without one, the hello says so and the connection closes.
                drop(unauthenticated);
                let next = if may_continue && !head.close {
                    HeadSlot::take(&self.heads, stream, AFTER_HELLO_GRACE)
                } else {
                    None
                };
                let response = respond(answer(serde_json::json!({})), next.is_some());
                return match next {
                    Some(next) if write_all(stream, &response) => After::Next(next),
                    Some(_) => After::Closed,
                    None => {
                        self.answer_quickly(stream, &response);
                        After::Closed
                    }
                };
            }
            Ok(Admitted::Request) => {
                drop(unauthenticated);
                let Some(_authenticated) = Slot::take(&self.authenticated, MAX_AUTHENTICATED)
                else {
                    self.answer_quickly(stream, &respond(error_body(ErrorCode::Busy), false));
                    return After::Closed;
                };
                reader.get_mut().restart(BODY_TIME);
                // The length was checked against the route's limit above.
                let Ok(bytes) =
                    http::read_body(reader, head.content_length, body_limit(&head.path))
                else {
                    return After::Closed;
                };
                let response = respond(route(self.actions.as_ref(), &head.path, &bytes), false);
                // The authenticated slot is held until the socket closes: such an answer may
                // wait the full linger time for its client.
                answer_and_close(stream, &response, LINGER_TIME);
                return After::Closed;
            }
        };
        drop(unauthenticated);
        self.answer_quickly(stream, &respond(error_body(refusal), false));
        After::Closed
    }

    /// Answers a request without a valid token and closes: it waits at most
    /// [`QUICK_LINGER_TIME`] for the client, and only while fewer than [`MAX_QUICK_LINGERING`]
    /// others do; beyond, the socket closes at once.
    fn answer_quickly(&self, stream: &TcpStream, response: &[u8]) {
        match Slot::take(&self.lingering, MAX_QUICK_LINGERING) {
            Some(_lingering) => answer_and_close(stream, response, QUICK_LINGER_TIME),
            None => {
                if write_all(stream, response) {
                    let _ = stream.shutdown(Shutdown::Write);
                }
            }
        }
    }
}

fn write_all(stream: &TcpStream, bytes: &[u8]) -> bool {
    let mut writer = stream;
    writer
        .write_all(bytes)
        .and_then(|()| writer.flush())
        .is_ok()
}

/// Writes the answer and closes gracefully: the write side first, then whatever the client
/// still sends within `linger` is read and dropped, so Windows does not reset the connection on
/// close and the client gets the whole answer (Hangar measured this).
fn answer_and_close(stream: &TcpStream, response: &[u8], linger: Duration) {
    if !write_all(stream, response) {
        return;
    }
    let _ = stream.shutdown(Shutdown::Write);
    let mut rest = Deadline::new(stream, linger).take(LINGER_BYTES);
    let _ = io::copy(&mut rest, &mut io::sink());
}

// ---- Client -----------------------------------------------------------------------------------

const CONNECT_TIME: Duration = Duration::from_secs(2);
const HELLO_TIME: Duration = Duration::from_secs(5);
const REQUEST_TIME: Duration = Duration::from_secs(30);
/// How long the client looks whether the server closed the connection after the hello, before
/// it sends the request. A server that closes does so right after its answer, so on loopback
/// this is ample; on an open connection it is what the look costs.
const STILL_OPEN_TIME: Duration = Duration::from_millis(2);
/// The most of an answer's head the client reads.
const MAX_ANSWER_HEAD_BYTES: usize = 16 * 1024;
/// The most of an answer's body the client reads.
const MAX_ANSWER_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    /// No endpoint file, or nothing listens on its port: no Hangar Note runs.
    #[error("Hangar Note is not running")]
    NotRunning,
    /// Something answers on the port but cannot prove that it knows the token (a program that
    /// took the port of a crashed run, or a broken answer), or the connection closed after the
    /// hello. Only the nonce was sent; the client treats the app as not running.
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
    /// The server keeps the connection open for one more request.
    keep_alive: bool,
    /// Wiped when dropped: an answer may carry a note's text (`excerpts`, `search`).
    body: Zeroizing<Vec<u8>>,
}

impl Reply {
    /// Whether this is the proven answer to the request sent to `path` with `nonce`.
    fn proven(&self, key: &[u8; 32], path: &str, nonce: &str) -> bool {
        self.proof.as_deref().is_some_and(|claimed| {
            proof::verify(key, nonce, path, self.status, &self.body, claimed)
        })
    }
}

/// Reads one answer: its head up to the blank line, then exactly `Content-Length` bytes, so the
/// connection can carry the next request. Anything unusual is a broken answer.
fn read_reply(reader: &mut impl BufRead) -> io::Result<Reply> {
    let broken = || io::Error::new(io::ErrorKind::InvalidData, "not an HTTP answer");
    // Room for the longest head up front and wiped when dropped (B5).
    let mut head = Zeroizing::new(Vec::with_capacity(MAX_ANSWER_HEAD_BYTES));
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() >= MAX_ANSWER_HEAD_BYTES {
            return Err(broken());
        }
        let mut byte = [0u8; 1];
        reader.read_exact(&mut byte)?;
        head.push(byte[0]);
    }
    let head = std::str::from_utf8(&head[..head.len() - 4]).map_err(|_| broken())?;
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
    let mut length: Option<u64> = None;
    let mut keep_alive = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return Err(broken());
        };
        let (name, value) = (name.trim(), value.trim());
        if name.eq_ignore_ascii_case(proof::PROOF_HEADER) {
            if proof.replace(value.to_owned()).is_some() {
                return Err(broken());
            }
        } else if name.eq_ignore_ascii_case("content-length") {
            let parsed = value.parse().map_err(|_| broken())?;
            if length.replace(parsed).is_some() {
                return Err(broken());
            }
        } else if name.eq_ignore_ascii_case("connection") {
            keep_alive = value.eq_ignore_ascii_case("keep-alive");
        }
    }
    let length = length.ok_or_else(broken)?;
    if length > MAX_ANSWER_BYTES {
        return Err(broken());
    }
    let body = http::read_body(reader, length, MAX_ANSWER_BYTES)?;
    Ok(Reply {
        status,
        proof,
        keep_alive,
        body,
    })
}

/// One request as the client sends it. `token` goes out only on a real request, after the hello
/// was proven.
struct Request<'a> {
    path: &'a str,
    nonce: &'a str,
    token: Option<&'a str>,
    body: &'a [u8],
}

fn write_request(
    stream: &TcpStream,
    port: u16,
    request: &Request<'_>,
    keep_alive: bool,
) -> io::Result<()> {
    let connection = if keep_alive { "keep-alive" } else { "close" };
    let port = port.to_string();
    let length = request.body.len().to_string();
    let parts: [&str; 15] = [
        "POST ",
        request.path,
        " HTTP/1.1\r\nHost: 127.0.0.1:",
        &port,
        "\r\n",
        if request.token.is_some() {
            "Authorization: Bearer "
        } else {
            ""
        },
        request.token.unwrap_or(""),
        if request.token.is_some() { "\r\n" } else { "" },
        "Content-Type: application/json\r\n",
        proof::NONCE_HEADER,
        ": ",
        request.nonce,
        "\r\nContent-Length: ",
        &length,
        "\r\nConnection: ",
    ];
    // Assembled in a buffer of its final size, so the token is never left behind by a growing
    // one (B5); wiped when dropped.
    let size = parts.iter().map(|part| part.len()).sum::<usize>() + connection.len() + 4;
    let mut head = Zeroizing::new(String::with_capacity(size));
    for part in parts {
        head.push_str(part);
    }
    head.push_str(connection);
    head.push_str("\r\n\r\n");
    let mut writer = stream;
    writer.write_all(head.as_bytes())?;
    writer.write_all(request.body)?;
    writer.flush()
}

/// Whether the server still holds the connection open, with nothing unread from it. After the
/// hello, a closed or reset connection, or bytes nobody asked for, end the exchange before the
/// token or any content goes out.
fn still_open(stream: &TcpStream, buffered: &[u8]) -> bool {
    if !buffered.is_empty() || stream.set_read_timeout(Some(STILL_OPEN_TIME)).is_err() {
        return false;
    }
    let mut probe = [0u8; 1];
    match stream.peek(&mut probe) {
        Ok(_) => false,
        Err(error) => matches!(
            error.kind(),
            io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
        ),
    }
}

/// The other end of a client exchange: where it listens, the token it serves, and the key its
/// proofs are made with (the token under the contract's label, [`proof::key_with_label`]). The
/// token is borrowed and never copied.
pub struct Peer<'a> {
    pub port: u16,
    pub token: &'a str,
    pub key: &'a [u8; 32],
}

/// The open connection of an exchange in progress, so another thread can cut a long wait short
/// (Hangar Drive's `events` long poll when the app quits): [`StreamSlot::cancel`] shuts the socket
/// down, and the blocked read returns at once.
#[derive(Debug, Default)]
pub struct StreamSlot {
    stream: Mutex<Option<TcpStream>>,
    cancelled: std::sync::atomic::AtomicBool,
}

impl StreamSlot {
    /// Keeps a handle of `stream` for [`StreamSlot::cancel`]; `false` when the slot is cancelled
    /// (also by a cancel that raced with this call) or no handle could be made, and the exchange
    /// must not start.
    fn hold(&self, stream: &TcpStream) -> bool {
        if self.cancelled() {
            return false;
        }
        let Ok(clone) = stream.try_clone() else {
            return false;
        };
        *crate::fsio::lock(&self.stream) = Some(clone);
        // A cancel between the first look and storing the handle found nothing to shut down.
        if self.cancelled() {
            if let Some(stream) = crate::fsio::lock(&self.stream).take() {
                let _ = stream.shutdown(Shutdown::Both);
            }
            return false;
        }
        true
    }

    fn release(&self) {
        crate::fsio::lock(&self.stream).take();
    }

    /// Whether [`StreamSlot::cancel`] was called.
    pub fn cancelled(&self) -> bool {
        self.cancelled.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Ends the exchange in progress, and every later one through this slot.
    pub fn cancel(&self) {
        self.cancelled
            .store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(stream) = crate::fsio::lock(&self.stream).take() {
            let _ = stream.shutdown(Shutdown::Both);
        }
    }
}

/// A proven answer: its status and its body, wiped when dropped.
pub struct Answer {
    pub status: u16,
    pub body: Zeroizing<Vec<u8>>,
}

/// Why an exchange gave no proven answer. Never carries the token, a nonce or a body.
#[derive(Debug, thiserror::Error)]
pub enum ExchangeError {
    /// Nothing listens on the port.
    #[error("nothing listens on the port")]
    NotRunning,
    /// Something answered the hello without a valid proof, or closed the connection after it;
    /// only the nonce went out.
    #[error("the program on the port did not prove itself")]
    NotProven,
    /// The server proved itself but takes no request on this connection now.
    #[error("the server is busy")]
    Busy,
    /// The request went out, but no proven answer came back.
    #[error("the request was not confirmed")]
    Unconfirmed,
    #[error("the connection failed: {0}")]
    Io(#[from] io::Error),
}

/// One proven exchange (ADR 0002, "One exchange, one connection"): `POST /v1/hello` with a nonce
/// and neither token nor content; only after a valid proof, and only while that connection is
/// still open, the token and `body` go to `path` with a new nonce and `Connection: close`. The
/// answer counts only with a valid proof of its own, errors included. `request_time` bounds the
/// write and the read of the real request (a long poll needs more than the default). With `slot`,
/// the connection can be cut short from another thread.
pub fn exchange(
    peer: &Peer<'_>,
    path: &str,
    body: &[u8],
    request_time: Duration,
    slot: Option<&StreamSlot>,
) -> Result<Answer, ExchangeError> {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, peer.port));
    let stream = match TcpStream::connect_timeout(&address, CONNECT_TIME) {
        Ok(stream) => stream,
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::ConnectionRefused | io::ErrorKind::TimedOut
            ) =>
        {
            return Err(ExchangeError::NotRunning)
        }
        Err(error) => return Err(error.into()),
    };
    if let Some(slot) = slot {
        if !slot.hold(&stream) {
            return Err(ExchangeError::Io(io::ErrorKind::Interrupted.into()));
        }
    }
    let result = exchange_on(&stream, peer, path, body, request_time, slot);
    if let Some(slot) = slot {
        slot.release();
    }
    result
}

fn exchange_on(
    stream: &TcpStream,
    peer: &Peer<'_>,
    path: &str,
    body: &[u8],
    request_time: Duration,
    slot: Option<&StreamSlot>,
) -> Result<Answer, ExchangeError> {
    // One deadline for all reads of an answer (security review of the Drive client, N2): a server
    // that sends a byte now and then cannot stretch a limit meant for the whole answer.
    let mut reader = WipingReader::new(Deadline::new(stream, HELLO_TIME));
    let cancelled = || slot.is_some_and(StreamSlot::cancelled);

    let hello_nonce = proof::new_nonce()?;
    let hello = (|| -> io::Result<Reply> {
        stream.set_write_timeout(Some(HELLO_TIME))?;
        let hello = Request {
            path: HELLO_PATH,
            nonce: &hello_nonce,
            token: None,
            body: b"",
        };
        write_request(stream, peer.port, &hello, true)?;
        // Cancellable also here, so quitting never waits out the hello time of a program on the
        // port that takes the connection and never answers.
        if let Some(slot) = slot {
            let left = wait_for_answer(stream, HELLO_TIME, slot)?;
            reader.get_mut().restart(left);
        }
        read_reply(&mut reader)
    })()
    .map_err(|error| {
        if cancelled() {
            ExchangeError::Io(error)
        } else {
            ExchangeError::NotProven
        }
    })?;
    if hello.status != 200 || !hello.proven(peer.key, HELLO_PATH, &hello_nonce) {
        return Err(ExchangeError::NotProven);
    }
    if !hello.keep_alive {
        return Err(ExchangeError::Busy);
    }
    if !still_open(stream, reader.buffer()) {
        return Err(ExchangeError::NotProven);
    }
    if cancelled() {
        return Err(ExchangeError::Io(io::ErrorKind::Interrupted.into()));
    }

    let nonce = proof::new_nonce()?;
    let reply = (|| -> io::Result<Reply> {
        reader.get_mut().restart(request_time);
        stream.set_write_timeout(Some(request_time))?;
        let request = Request {
            path,
            nonce: &nonce,
            token: Some(peer.token),
            body,
        };
        write_request(stream, peer.port, &request, false)?;
        if let Some(slot) = slot {
            let left = wait_for_answer(stream, request_time, slot)?;
            reader.get_mut().restart(left);
        }
        read_reply(&mut reader)
    })()
    .map_err(|_| ExchangeError::Unconfirmed)?;
    if !reply.proven(peer.key, path, &nonce) {
        return Err(ExchangeError::Unconfirmed);
    }
    Ok(Answer {
        status: reply.status,
        body: reply.body,
    })
}

/// How often a cancellable wait looks at its [`StreamSlot`].
const CANCEL_STEP: Duration = Duration::from_millis(100);

/// Waits until the first byte of the answer arrives, at most `limit`, in steps of
/// [`CANCEL_STEP`] so a [`StreamSlot::cancel`] ends the wait without relying on a shutdown from
/// another thread waking a blocked read: on Windows 11 it did not in the test
/// `stopping_cuts_the_long_poll_short` (the stop took the full 25 s wait), which matches no
/// documented guarantee either way. Returns the time left of `limit`.
fn wait_for_answer(stream: &TcpStream, limit: Duration, slot: &StreamSlot) -> io::Result<Duration> {
    let deadline = std::time::Instant::now() + limit;
    let mut probe = [0u8; 1];
    loop {
        if slot.cancelled() {
            return Err(io::ErrorKind::Interrupted.into());
        }
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            return Err(io::ErrorKind::TimedOut.into());
        }
        stream.set_read_timeout(Some(left.min(CANCEL_STEP)))?;
        match stream.peek(&mut probe) {
            // Bytes, or the end of the stream, which the read then reports.
            Ok(_) => return Ok(left),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) => {}
            Err(error) => return Err(error),
        }
    }
}

/// Sends one request to the running app (used by `hangar-note capture`) and returns the JSON
/// answer, through one proven [`exchange`] with the token of the route's scope.
pub fn post(
    endpoint: &EndpointFile,
    path: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value, ClientError> {
    let key = proof::key(&endpoint.token);
    let token = match route_scope(path) {
        Scope::Notes => endpoint.token.as_str(),
        Scope::Team => endpoint.team_token.as_str(),
    };
    let peer = Peer {
        port: endpoint.port,
        token,
        key: &key,
    };
    let text = to_json_wiped(body, false).map_err(ClientError::Io)?;
    let reply = exchange(&peer, path, &text, REQUEST_TIME, None).map_err(|error| match error {
        ExchangeError::NotRunning => ClientError::NotRunning,
        ExchangeError::NotProven => ClientError::NotProven,
        // The app proved itself but takes no request on this connection now.
        ExchangeError::Busy => ClientError::Refused(ErrorCode::Busy.as_str().to_owned()),
        ExchangeError::Unconfirmed => ClientError::Unconfirmed,
        ExchangeError::Io(error) => ClientError::Io(error),
    })?;
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

/// [`post`] for a route whose contract confirms with `"ok": true` (`open`, `quick`, `capture`):
/// a proven answer without it is refused with `invalid` (security review L1), so a server that
/// answers 200 but did not do the work never counts as having done it.
pub fn post_confirmed(
    endpoint: &EndpointFile,
    path: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value, ClientError> {
    let value = post(endpoint, path, body)?;
    if value.get("ok") == Some(&serde_json::Value::Bool(true)) {
        Ok(value)
    } else {
        Err(ClientError::Refused(ErrorCode::Invalid.as_str().to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::test_support::TempDir;
    use std::io::BufReader;

    /// Records the calls; the text is kept only to check it arrived whole.
    #[derive(Default)]
    struct Fake {
        calls: Mutex<Vec<String>>,
        read_only: bool,
        /// Every call fails with this I/O error on a file named like a secret.
        io_failure: Option<io::ErrorKind>,
    }

    const SECRET_FILE: &str = "Secret plan.md";

    impl Fake {
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }

        fn record(&self, call: String) -> Result<(), ServiceError> {
            self.calls.lock().unwrap().push(call);
            if let Some(kind) = self.io_failure {
                return Err(NotesError::Io {
                    path: PathBuf::from(abs()).join(SECRET_FILE),
                    source: kind.into(),
                }
                .into());
            }
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
        fn capture(&self, folder: PathBuf, text: String) -> Result<String, ServiceError> {
            self.record(format!("capture {folder:?} {}", text.len()))
                .map(|()| "0b7f6a0e-3c1d-4c5e-9a8b-1f2e3d4c5b6a".into())
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
        // Neither the channel nor its endpoint file shows a token in a debug print.
        let channel = Channel {
            port: 1,
            token: a.clone(),
            team_token: b.clone(),
        };
        for shown in [format!("{channel:?}"), format!("{:?}", channel.endpoint())] {
            assert!(!shown.contains(a.as_str()), "{shown}");
            assert!(!shown.contains(b.as_str()), "{shown}");
        }
    }

    #[test]
    fn team_routes_take_the_team_token_and_every_other_route_the_notes_token() {
        let token = "1".repeat(64);
        let team = "2".repeat(64);
        for (path, scope) in [
            ("/team/status", Scope::Team),
            ("/team/open", Scope::Team),
            ("/team/", Scope::Team),
            ("/team", Scope::Notes),
            ("/teams/open", Scope::Notes),
            ("/search", Scope::Notes),
            ("/flush", Scope::Notes),
            (HELLO_PATH, Scope::Notes),
        ] {
            assert_eq!(route_scope(path), scope, "{path}");
        }
        assert!(authorized("/search", Some(&token), &token, &team));
        assert!(!authorized("/search", Some(&team), &token, &team));
        assert!(authorized("/team/status", Some(&team), &token, &team));
        assert!(!authorized("/team/status", Some(&token), &token, &team));
        assert!(!authorized("/team/status", None, &token, &team));
        assert!(!authorized("/search", Some(""), &token, &team));
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

    #[test]
    fn storage_failures_are_fixed_codes_without_path_or_os_text() {
        let body = serde_json::json!({ "version": 1, "title": "x" }).to_string();
        for (kind, status, code) in [
            (io::ErrorKind::PermissionDenied, Status::Internal, "denied"),
            (io::ErrorKind::StorageFull, Status::Internal, "disk-full"),
            (io::ErrorKind::NotFound, Status::NotFound, "not-found"),
            (
                io::ErrorKind::FileTooLarge,
                Status::PayloadTooLarge,
                "too-large",
            ),
            (io::ErrorKind::InvalidData, Status::Internal, "io"),
        ] {
            let failing = Fake {
                io_failure: Some(kind),
                ..Fake::default()
            };
            let (got, text) = route(&failing, "/create", body.as_bytes());
            assert_eq!(got, status, "{kind:?}");
            assert_eq!(
                json(&text),
                serde_json::json!({ "version": 1, "error": code })
            );
            assert!(!text.contains(SECRET_FILE), "{text}");
        }
        // A note over the limit is too large, not malformed.
        let error = ServiceError::Notes(NotesError::TooLarge { size: 2, max: 1 });
        assert_eq!(ErrorCode::from(&error), ErrorCode::TooLarge);
    }

    /// One request on a connection of its own, which closes after the answer.
    fn exchange(
        endpoint: &EndpointFile,
        path: &str,
        nonce: &str,
        token: Option<&str>,
        body: &[u8],
    ) -> Reply {
        let stream = TcpStream::connect((Ipv4Addr::LOCALHOST, endpoint.port)).unwrap();
        stream.set_read_timeout(Some(HELLO_TIME)).unwrap();
        let request = Request {
            path,
            nonce,
            token,
            body,
        };
        write_request(&stream, endpoint.port, &request, false).unwrap();
        read_reply(&mut BufReader::new(&stream)).unwrap()
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
        let reply = exchange(&endpoint, HELLO_PATH, &nonce, None, b"");
        assert_eq!(reply.status, 200);
        // The client asked to close: so does the server.
        assert!(!reply.keep_alive);
        assert_eq!(&reply.body[..], br#"{"version":1}"#);
        assert!(reply.proven(&key, HELLO_PATH, &nonce));
        // Another token's key, or another nonce, does not verify.
        assert!(!reply.proven(&proof::key(&"0".repeat(64)), HELLO_PATH, &nonce));
        assert!(!reply.proven(&key, HELLO_PATH, &proof::new_nonce().unwrap()));
        // The proof binds the path the request was sent to (security review L1b).
        assert!(!reply.proven(&key, "/capture", &nonce));
        // Errors carry the proof as well, so a client can trust a refusal.
        let refused = exchange(&endpoint, "/flush", &nonce, None, b"{\"version\":1}");
        assert_eq!(refused.status, 401);
        assert!(refused.proven(&key, "/flush", &nonce));
        assert!(!refused.proven(&key, HELLO_PATH, &nonce));
        // The hello takes no body and calls nothing.
        let with_body = exchange(&endpoint, HELLO_PATH, &nonce, None, b"{}");
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
        assert_eq!(fields, ["pid", "port", "teamToken", "token", "version"]);
        assert_ne!(file["token"], file["teamToken"]);
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
    fn an_endpoint_file_needs_two_different_tokens() {
        let dir = TempDir::new("channel-endpoint-tokens");
        let token = "a".repeat(64);
        let file = |team: Option<String>| {
            let mut value =
                serde_json::json!({ "version": 1, "port": 1, "pid": 1, "token": token });
            if let Some(team) = team {
                value["teamToken"] = team.into();
            }
            value
        };
        for (file, valid) in [
            (file(Some("b".repeat(64))), true),
            (file(None), false),
            (file(Some(token.clone())), false),
            (file(Some("short".into())), false),
        ] {
            std::fs::write(dir.path().join(ENDPOINT_FILE), file.to_string()).unwrap();
            assert_eq!(read_endpoint(dir.path()).is_ok(), valid, "{file}");
        }
    }

    #[test]
    fn team_routes_refuse_the_notes_token_over_the_channel() {
        let fake = Arc::new(Fake::default());
        let channel = Channel::start(fake.clone()).unwrap();
        let endpoint = channel.endpoint();
        let key = proof::key(&endpoint.token);
        let body = br#"{"version":1}"#;
        for (path, token, status) in [
            // No team route exists yet: the team token gets as far as the routes.
            ("/team/status", endpoint.team_token.as_str(), 404),
            ("/team/status", endpoint.token.as_str(), 401),
            ("/flush", endpoint.team_token.as_str(), 401),
            ("/flush", endpoint.token.as_str(), 200),
        ] {
            let nonce = proof::new_nonce().unwrap();
            let reply = exchange(&endpoint, path, &nonce, Some(token), body);
            assert_eq!(reply.status, status, "{path}");
            assert!(reply.proven(&key, path, &nonce));
        }
        assert!(fake.calls().is_empty());
        // The client sends the team token on a team route.
        match post(
            &endpoint,
            "/team/status",
            &serde_json::json!({ "version": 1 }),
        ) {
            Err(ClientError::Refused(code)) => assert_eq!(code, "unknown-route"),
            other => panic!("{other:?}"),
        }
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
                stream
                    .set_read_timeout(Some(Duration::from_millis(300)))
                    .unwrap();
                while let Ok(n) = stream.read(&mut buffer) {
                    if n == 0 {
                        break;
                    }
                    got.extend_from_slice(&buffer[..n]);
                }
                seen.push(got);
            }
            seen
        });
        let stale = EndpointFile {
            version: ENDPOINT_VERSION,
            port,
            pid: 1,
            token: new_token().unwrap(),
            team_token: new_token().unwrap(),
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

    fn hello_request(nonce: &str) -> Request<'_> {
        Request {
            path: HELLO_PATH,
            nonce,
            token: None,
            body: b"",
        }
    }

    /// Hello and request on one connection, as the client does it; then the server closes.
    #[test]
    fn hello_and_request_travel_over_one_connection() {
        let fake = Arc::new(Fake::default());
        let channel = Channel::start(fake.clone()).unwrap();
        let endpoint = channel.endpoint();
        let key = proof::key(&endpoint.token);
        let connect = || {
            let stream = TcpStream::connect((Ipv4Addr::LOCALHOST, endpoint.port)).unwrap();
            stream.set_read_timeout(Some(HELLO_TIME)).unwrap();
            stream
        };

        let stream = connect();
        let mut reader = BufReader::new(&stream);
        let hello_nonce = proof::new_nonce().unwrap();
        write_request(&stream, endpoint.port, &hello_request(&hello_nonce), true).unwrap();
        let hello = read_reply(&mut reader).unwrap();
        assert_eq!(hello.status, 200);
        assert!(hello.keep_alive);
        assert!(hello.proven(&key, HELLO_PATH, &hello_nonce));
        let nonce = proof::new_nonce().unwrap();
        let flush = Request {
            path: "/flush",
            nonce: &nonce,
            token: Some(&endpoint.token),
            body: br#"{"version":1}"#,
        };
        write_request(&stream, endpoint.port, &flush, true).unwrap();
        let reply = read_reply(&mut reader).unwrap();
        assert_eq!(reply.status, 200);
        assert!(reply.proven(&key, "/flush", &nonce));
        // The second request is the last, whatever the client asked for.
        assert!(!reply.keep_alive);
        let mut rest = Vec::new();
        assert_eq!(reader.read_to_end(&mut rest).unwrap(), 0);

        // At most two requests: a second hello is answered, and then the connection closes.
        let stream = connect();
        let mut reader = BufReader::new(&stream);
        for keep_alive in [true, false] {
            let nonce = proof::new_nonce().unwrap();
            write_request(&stream, endpoint.port, &hello_request(&nonce), true).unwrap();
            let reply = read_reply(&mut reader).unwrap();
            assert_eq!(reply.status, 200);
            assert_eq!(reply.keep_alive, keep_alive);
        }
        let mut rest = Vec::new();
        assert_eq!(reader.read_to_end(&mut rest).unwrap(), 0);

        // A request without a hello is answered and closes the connection, as before.
        let stream = connect();
        let mut reader = BufReader::new(&stream);
        let nonce = proof::new_nonce().unwrap();
        let flush = Request {
            nonce: &nonce,
            ..flush
        };
        write_request(&stream, endpoint.port, &flush, true).unwrap();
        let reply = read_reply(&mut reader).unwrap();
        assert_eq!(reply.status, 200);
        assert!(!reply.keep_alive);
    }

    /// What a server that proves itself does after the hello, for the client tests.
    #[derive(Clone, Copy, Debug)]
    enum AfterHello {
        /// Answers the request on the same connection.
        Serve,
        /// Closes its side right after the proven hello.
        Close,
        /// Says in the proven hello that the connection closes.
        Busy,
    }

    /// A server that knows the token and answers the way `after` says, with an answer that
    /// confirms (`ok: true`) and a proof over the path it was asked on. Returns its port and a
    /// handle with everything it received and how many connections it accepted.
    fn proving_server(
        token: &str,
        after: AfterHello,
    ) -> (u16, thread::JoinHandle<(Vec<u8>, usize)>) {
        proving_server_with(token, after, r#"{"version":1,"ok":true}"#, |path| path)
    }

    /// [`proving_server`] with the body of every answer and the path its proof is signed for.
    fn proving_server_with(
        token: &str,
        after: AfterHello,
        text: &'static str,
        signed_path: fn(&str) -> &str,
    ) -> (u16, thread::JoinHandle<(Vec<u8>, usize)>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let key = proof::key(token);
        let handle = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut seen = Vec::new();
            let mut reader = BufReader::new(&stream);
            let answer = |reader: &mut BufReader<&TcpStream>,
                          seen: &mut Vec<u8>,
                          keep_alive: bool|
             -> bool {
                let Ok(head) = http::read_head(reader) else {
                    return false;
                };
                let mut body = Vec::new();
                let _ = reader.take(head.content_length).read_to_end(&mut body);
                seen.extend_from_slice(head.path.as_bytes());
                seen.extend_from_slice(if head.token.is_some() {
                    b" Authorization "
                } else {
                    b" "
                });
                seen.extend_from_slice(&body);
                let nonce = head.nonce.unwrap_or_default();
                let path = signed_path(&head.path);
                let claimed = proof::proof(&key, &nonce, path, 200, text.as_bytes());
                let response = http::response(Status::Ok, text, Some(&claimed), keep_alive);
                write_all(&stream, &response)
            };
            match after {
                AfterHello::Serve => {
                    answer(&mut reader, &mut seen, true);
                    answer(&mut reader, &mut seen, false);
                }
                AfterHello::Close | AfterHello::Busy => {
                    answer(&mut reader, &mut seen, matches!(after, AfterHello::Close));
                    let _ = stream.shutdown(Shutdown::Write);
                    // Whatever the client still sends shows up here.
                    let mut rest = Vec::new();
                    let _ = reader.read_to_end(&mut rest);
                    seen.extend_from_slice(&rest);
                }
            }
            // Any second connection would be counted.
            listener.set_nonblocking(true).unwrap();
            thread::sleep(Duration::from_millis(200));
            let more = std::iter::from_fn(|| listener.accept().ok()).count();
            (seen, 1 + more)
        });
        (port, handle)
    }

    fn endpoint_for(port: u16, token: &Zeroizing<String>) -> EndpointFile {
        EndpointFile {
            version: ENDPOINT_VERSION,
            port,
            pid: 1,
            token: token.clone(),
            team_token: new_token().unwrap(),
        }
    }

    #[test]
    fn the_client_sends_hello_and_request_over_one_connection() {
        let token = new_token().unwrap();
        let (port, server) = proving_server(&token, AfterHello::Serve);
        let answer = post(
            &endpoint_for(port, &token),
            "/capture",
            &serde_json::json!({ "version": 1, "folder": abs(), "text": "marker-one-9c2" }),
        )
        .unwrap();
        assert_eq!(answer["version"], 1);
        let (seen, connections) = server.join().unwrap();
        let seen = String::from_utf8_lossy(&seen);
        assert_eq!(connections, 1, "{seen}");
        assert!(seen.starts_with(HELLO_PATH), "{seen}");
        assert!(seen.contains("/capture Authorization "), "{seen}");
        assert!(seen.contains("marker-one-9c2"), "{seen}");
    }

    /// A proven 200 confirms a route only with `"ok": true` (security review L1): anything else
    /// is refused with `invalid` and never counts as delivered.
    #[test]
    fn a_confirmed_post_needs_ok_true() {
        for (text, confirmed) in [
            (r#"{"version":1,"ok":true}"#, true),
            (r#"{"version":1}"#, false),
            (r#"{"version":1,"ok":false}"#, false),
            (r#"{"version":1,"ok":"true"}"#, false),
            (r#"{"version":1,"ok":1}"#, false),
            ("[]", false),
        ] {
            let token = new_token().unwrap();
            let (port, server) = proving_server_with(&token, AfterHello::Serve, text, |path| path);
            let result = post_confirmed(
                &endpoint_for(port, &token),
                "/capture",
                &serde_json::json!({ "version": 1, "folder": abs(), "text": "marker-ok-4d1" }),
            );
            server.join().unwrap();
            match result {
                Ok(answer) => assert!(confirmed, "{text}: {answer}"),
                Err(ClientError::Refused(code)) => {
                    assert!(!confirmed, "{text}");
                    assert_eq!(code, ErrorCode::Invalid.as_str(), "{text}");
                }
                Err(other) => panic!("{text}: {other:?}"),
            }
        }
    }

    /// A proof the server signed for another path does not count: on the hello the program is
    /// not proven, on the request the answer is not confirmed (security review L1b).
    #[test]
    fn a_proof_signed_for_another_path_does_not_count() {
        let body =
            || serde_json::json!({ "version": 1, "folder": abs(), "text": "marker-path-2a6" });
        let token = new_token().unwrap();
        let (port, server) = proving_server_with(
            &token,
            AfterHello::Serve,
            r#"{"version":1,"ok":true}"#,
            |_| "/capture",
        );
        let result = post(&endpoint_for(port, &token), "/capture", &body());
        assert!(matches!(result, Err(ClientError::NotProven)), "{result:?}");
        let (seen, _) = server.join().unwrap();
        assert!(!String::from_utf8_lossy(&seen).contains("marker-path-2a6"));

        let token = new_token().unwrap();
        let (port, server) = proving_server_with(
            &token,
            AfterHello::Serve,
            r#"{"version":1,"ok":true}"#,
            |_| HELLO_PATH,
        );
        let result = post(&endpoint_for(port, &token), "/capture", &body());
        assert!(
            matches!(result, Err(ClientError::Unconfirmed)),
            "{result:?}"
        );
        server.join().unwrap();
    }

    /// Closed between hello and request (or the proven hello says it closes): the client sends
    /// nothing more, neither token nor text, and opens no second connection.
    #[test]
    fn a_connection_that_ends_after_the_hello_gets_nothing_more() {
        for after in [AfterHello::Close, AfterHello::Busy] {
            let token = new_token().unwrap();
            let (port, server) = proving_server(&token, after);
            let result = post(
                &endpoint_for(port, &token),
                "/capture",
                &serde_json::json!({ "version": 1, "folder": abs(), "text": "marker-gone-5b8" }),
            );
            match (after, &result) {
                (AfterHello::Close, Err(ClientError::NotProven)) => {}
                (AfterHello::Busy, Err(ClientError::Refused(code))) if code == "busy" => {}
                _ => panic!("{after:?}: {result:?}"),
            }
            let (seen, connections) = server.join().unwrap();
            let seen = String::from_utf8_lossy(&seen);
            assert_eq!(connections, 1, "{after:?}: {seen}");
            assert_eq!(seen, format!("{HELLO_PATH} "), "{after:?}");
        }
    }

    /// Second security review, N-C: complete hellos, sent without pause by clients that then
    /// neither read nor close, must not fill the slots; a valid exchange still gets 200.
    #[test]
    fn a_stream_of_finished_hellos_does_not_keep_a_valid_request_out() {
        let fake = Arc::new(Fake::default());
        let channel = Channel::start(fake.clone()).unwrap();
        let endpoint = channel.endpoint();
        let port = endpoint.port;
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let hello = format!(
            "POST {HELLO_PATH} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: \
             application/json\r\n{}Content-Length: 0\r\nConnection: close\r\n\r\n",
            nonce_header(&"ab".repeat(32))
        );
        let flooders: Vec<_> = (0..4)
            .map(|_| {
                let stop = Arc::clone(&stop);
                let hello = hello.clone();
                thread::spawn(move || {
                    let mut held = std::collections::VecDeque::new();
                    let mut sent = 0usize;
                    while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                        if let Ok(mut stream) = TcpStream::connect((Ipv4Addr::LOCALHOST, port)) {
                            if stream.write_all(hello.as_bytes()).is_ok() {
                                sent += 1;
                            }
                            // Held open, never read.
                            held.push_back(stream);
                            if held.len() > 64 {
                                held.pop_front();
                            }
                        }
                        thread::sleep(Duration::from_millis(1));
                    }
                    sent
                })
            })
            .collect();
        thread::sleep(Duration::from_millis(300));
        for _ in 0..3 {
            let answer = post(&endpoint, "/flush", &serde_json::json!({ "version": 1 }));
            assert!(
                matches!(&answer, Ok(value) if value["saved"] == true),
                "{answer:?}"
            );
            thread::sleep(Duration::from_millis(150));
        }
        stop.store(true, std::sync::atomic::Ordering::SeqCst);
        let sent: usize = flooders.into_iter().map(|f| f.join().unwrap()).sum();
        // Well past what the slots hold within one linger time of the old code.
        assert!(sent > 2 * slots::MAX_HEAD_THREADS, "{sent}");
    }

    /// Connections that sent a hello and then stay silent hold a head slot only for the short
    /// grace after a hello; a valid exchange then takes the place of the oldest.
    #[test]
    fn connections_silent_after_their_hello_give_way() {
        let fake = Arc::new(Fake::default());
        let channel = Channel::start(fake.clone()).unwrap();
        let endpoint = channel.endpoint();
        let waiting: Vec<TcpStream> = (0..slots::MAX_HEAD_THREADS)
            .map(|_| {
                let stream = TcpStream::connect((Ipv4Addr::LOCALHOST, endpoint.port)).unwrap();
                stream.set_read_timeout(Some(HELLO_TIME)).unwrap();
                let nonce = proof::new_nonce().unwrap();
                write_request(&stream, endpoint.port, &hello_request(&nonce), true).unwrap();
                let reply = read_reply(&mut BufReader::new(&stream)).unwrap();
                assert_eq!(reply.status, 200);
                stream
            })
            .collect();
        thread::sleep(AFTER_HELLO_GRACE + Duration::from_millis(200));
        let answer = post(&endpoint, "/flush", &serde_json::json!({ "version": 1 }));
        assert!(
            matches!(&answer, Ok(value) if value["saved"] == true),
            "{answer:?}"
        );
        drop(waiting);
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
        let path = dir.path().join(ENDPOINT_FILE);
        let sddl = crate::winsec::dacl_sddl(&path).unwrap();
        assert!(sddl.starts_with("D:P"), "{sddl}");
        for foreign in [";;;BU)", ";;;WD)", ";;;AU)"] {
            assert!(!sddl.contains(foreign), "{foreign} in {sddl}");
        }
        assert_eq!(sddl.matches("(A;").count(), 2, "{sddl}");
        // Medium integrity, no read, write or execute up (N-B), also after the replacement.
        let label = crate::winsec::label_sddl(&path).unwrap();
        assert!(label.contains("ML;;NWNRNX;;;ME"), "{label}");
    }

    /// Security review of the Drive client, N3: a cancelled slot never lets an exchange start, and
    /// a cancel shuts the held connection down.
    #[test]
    fn a_cancelled_slot_holds_nothing() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let stream = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (server, _) = listener.accept().unwrap();
        let slot = StreamSlot::default();
        assert!(slot.hold(&stream));
        slot.cancel();
        assert!(slot.cancelled());
        // The held handle was shut down: the other end reads the end of the stream.
        let mut probe = [0u8; 1];
        server
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        assert_eq!((&server).read(&mut probe).unwrap(), 0);
        assert!(!slot.hold(&stream));
        slot.release();
    }
}
