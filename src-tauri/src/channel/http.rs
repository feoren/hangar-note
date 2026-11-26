//! The smallest HTTP/1.1 the local channel needs: `POST` with `Content-Length`, at most a hello
//! and one request per connection (ADR 0002, "One exchange, one connection"); every answer says
//! whether the connection stays open (`Connection: keep-alive`) or closes. Taken from Hangar's
//! `hook_http.rs` (MIT, same owner), which made the same choice: a few routes on 127.0.0.1 for
//! one client, every limit explicit here. hyper or axum would add an async server, routing and
//! general keep-alive handling for no gain. Anything unusual is refused rather than interpreted: chunked bodies, a second
//! `Content-Length`, folded headers, control characters, oversized heads.

use std::io::{self, BufRead, Read};

use zeroize::{Zeroize as _, Zeroizing};

/// The buffer of a [`WipingReader`]: a request head fits several times.
const READER_BUFFER_BYTES: usize = 8 * 1024;

/// A buffered reader whose buffer never keeps what it handed out (security review B5): consumed
/// bytes are overwritten with zeros at once, the rest when it is dropped. `std::io::BufReader`
/// keeps a request head, the bearer token included, in its buffer until the buffer is reused or
/// freed without being wiped. Used for every head the channel reads, on both sides.
pub struct WipingReader<R> {
    inner: R,
    buffer: Zeroizing<Vec<u8>>,
    position: usize,
    filled: usize,
}

impl<R: Read> WipingReader<R> {
    pub fn new(inner: R) -> Self {
        Self {
            inner,
            buffer: Zeroizing::new(vec![0; READER_BUFFER_BYTES]),
            position: 0,
            filled: 0,
        }
    }

    pub fn get_mut(&mut self) -> &mut R {
        &mut self.inner
    }

    /// What was read from the source but not consumed yet.
    pub fn buffer(&self) -> &[u8] {
        &self.buffer[self.position..self.filled]
    }

    /// The whole buffer, consumed part included, for the test that it holds nothing old.
    #[cfg(test)]
    pub fn raw_buffer(&self) -> &[u8] {
        &self.buffer
    }
}

impl<R: Read> Read for WipingReader<R> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        // Nothing buffered and a large read (a body): straight into the caller's buffer.
        if self.position == self.filled && out.len() >= self.buffer.len() {
            return self.inner.read(out);
        }
        let available = self.fill_buf()?;
        let n = available.len().min(out.len());
        out[..n].copy_from_slice(&available[..n]);
        self.consume(n);
        Ok(n)
    }
}

impl<R: Read> BufRead for WipingReader<R> {
    fn fill_buf(&mut self) -> io::Result<&[u8]> {
        if self.position >= self.filled {
            // Everything before was consumed, and so already wiped.
            self.position = 0;
            self.filled = self.inner.read(&mut self.buffer)?;
        }
        Ok(&self.buffer[self.position..self.filled])
    }

    fn consume(&mut self, amount: usize) {
        let end = self.position.saturating_add(amount).min(self.filled);
        self.buffer[self.position..end].zeroize();
        self.position = end;
    }
}

/// Reads a body of exactly `length` bytes, at most `max`, into one buffer allocated at its final
/// size and wiped when dropped (security review L4). `read_to_end` into a growing `Vec` would
/// reallocate and leave unwiped copies of a note's text behind; `read_exact` into a buffer that
/// is already `length` bytes long never grows it.
pub fn read_body(reader: &mut impl Read, length: u64, max: u64) -> io::Result<Zeroizing<Vec<u8>>> {
    if length > max {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "body too large"));
    }
    let size = usize::try_from(length)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "body too large"))?;
    let mut body = Zeroizing::new(vec![0u8; size]);
    reader.read_exact(&mut body)?;
    Ok(body)
}

use super::proof::{NONCE_HEADER, PROOF_HEADER};

/// Request line plus headers, in bytes.
pub const MAX_HEAD_BYTES: usize = 16 * 1024;
pub const MAX_HEADERS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Ok,
    BadRequest,
    Unauthorized,
    Forbidden,
    NotFound,
    MethodNotAllowed,
    Conflict,
    LengthRequired,
    PayloadTooLarge,
    UnsupportedMediaType,
    HeadersTooLarge,
    Internal,
    NotImplemented,
    Unavailable,
}

impl Status {
    pub fn code(self) -> u16 {
        match self {
            Status::Ok => 200,
            Status::BadRequest => 400,
            Status::Unauthorized => 401,
            Status::Forbidden => 403,
            Status::NotFound => 404,
            Status::MethodNotAllowed => 405,
            Status::Conflict => 409,
            Status::LengthRequired => 411,
            Status::PayloadTooLarge => 413,
            Status::UnsupportedMediaType => 415,
            Status::HeadersTooLarge => 431,
            Status::Internal => 500,
            Status::NotImplemented => 501,
            Status::Unavailable => 503,
        }
    }

    fn reason(self) -> &'static str {
        match self {
            Status::Ok => "OK",
            Status::BadRequest => "Bad Request",
            Status::Unauthorized => "Unauthorized",
            Status::Forbidden => "Forbidden",
            Status::NotFound => "Not Found",
            Status::MethodNotAllowed => "Method Not Allowed",
            Status::Conflict => "Conflict",
            Status::LengthRequired => "Length Required",
            Status::PayloadTooLarge => "Payload Too Large",
            Status::UnsupportedMediaType => "Unsupported Media Type",
            Status::HeadersTooLarge => "Request Header Fields Too Large",
            Status::Internal => "Internal Server Error",
            Status::NotImplemented => "Not Implemented",
            Status::Unavailable => "Service Unavailable",
        }
    }
}

/// What went wrong while reading a request; [`HeadError::status`] is the answer.
#[derive(Debug, thiserror::Error)]
pub enum HeadError {
    #[error("Malformed request")]
    Malformed,
    #[error("Request head too large")]
    TooLarge,
    #[error("Only POST is accepted")]
    Method,
    #[error("Content-Length missing")]
    NoLength,
    #[error("Transfer encodings are not supported")]
    Encoding,
    #[error(transparent)]
    Io(#[from] io::Error),
}

impl HeadError {
    /// `None`: the connection is gone or timed out, nothing to answer.
    pub fn status(&self) -> Option<Status> {
        match self {
            HeadError::Malformed => Some(Status::BadRequest),
            HeadError::TooLarge => Some(Status::HeadersTooLarge),
            HeadError::Method => Some(Status::MethodNotAllowed),
            HeadError::NoLength => Some(Status::LengthRequired),
            HeadError::Encoding => Some(Status::NotImplemented),
            HeadError::Io(_) => None,
        }
    }
}

/// The parts of a request head the channel uses.
#[derive(Clone, PartialEq, Eq)]
pub struct Head {
    /// The path, without a query.
    pub path: String,
    /// The bearer token of `Authorization`, if any; wiped when dropped.
    pub token: Option<Zeroizing<String>>,
    pub content_length: u64,
    /// `Host` as sent; the channel wants exactly its own `127.0.0.1:<port>`.
    pub host: Option<String>,
    /// `Origin` or a `Sec-Fetch-*` header: a browser sent it (a web page trying the local port).
    pub from_browser: bool,
    /// `Content-Type` names `application/json` (parameters such as `charset` aside).
    pub json: bool,
    /// [`NONCE_HEADER`] as sent; the channel checks its form.
    pub nonce: Option<String>,
    /// The client asked to close after this request: `Connection: close`, or HTTP/1.0 without
    /// `Connection: keep-alive`.
    pub close: bool,
}

impl std::fmt::Debug for Head {
    // The token stays out of every debug print.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Head")
            .field("path", &self.path)
            .field("token", &self.token.as_ref().map(|_| "<redacted>"))
            .field("content_length", &self.content_length)
            .field("host", &self.host)
            .field("from_browser", &self.from_browser)
            .field("json", &self.json)
            .field("nonce", &self.nonce)
            .field("close", &self.close)
            .finish()
    }
}

/// Reads one line ending in LF (CR before it is dropped) into `line`, counting against `budget`.
fn read_line(
    reader: &mut impl BufRead,
    line: &mut Vec<u8>,
    budget: &mut usize,
) -> Result<(), HeadError> {
    line.clear();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Err(HeadError::Io(io::ErrorKind::UnexpectedEof.into()));
        }
        let (chunk, done) = match available.iter().position(|b| *b == b'\n') {
            Some(at) => (&available[..=at], true),
            None => (available, false),
        };
        if chunk.len() > *budget {
            return Err(HeadError::TooLarge);
        }
        *budget -= chunk.len();
        line.extend_from_slice(chunk);
        let used = chunk.len();
        reader.consume(used);
        if done {
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return Ok(());
        }
    }
}

fn visible_ascii(bytes: &[u8]) -> bool {
    bytes
        .iter()
        .all(|b| (0x20..0x7f).contains(b) || *b == b'\t')
}

/// Reads and checks a request head. The body is left in `reader`.
pub fn read_head(reader: &mut impl BufRead) -> Result<Head, HeadError> {
    let mut budget = MAX_HEAD_BYTES;
    // Room for the whole head up front, so a line holding the token is never copied by a
    // growing buffer and left behind unwiped (B5); wiped when dropped.
    let mut line = Zeroizing::new(Vec::with_capacity(MAX_HEAD_BYTES));
    read_line(reader, &mut line, &mut budget)?;
    if !visible_ascii(&line) {
        return Err(HeadError::Malformed);
    }
    let text = String::from_utf8_lossy(&line).into_owned();
    let mut parts = text.split(' ');
    let (Some(method), Some(target), Some(version), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(HeadError::Malformed);
    };
    if version != "HTTP/1.1" && version != "HTTP/1.0" {
        return Err(HeadError::Malformed);
    }
    if !target.starts_with('/') {
        return Err(HeadError::Malformed);
    }
    let method_ok = method == "POST";

    let mut token: Option<Zeroizing<String>> = None;
    let mut content_type: Option<String> = None;
    let mut nonce: Option<String> = None;
    let mut host: Option<String> = None;
    let mut from_browser = false;
    let mut length: Option<u64> = None;
    let mut connection_close = false;
    let mut connection_keep_alive = false;
    let mut headers = 0;
    loop {
        read_line(reader, &mut line, &mut budget)?;
        if line.is_empty() {
            break;
        }
        headers += 1;
        if headers > MAX_HEADERS {
            return Err(HeadError::TooLarge);
        }
        // Folded continuation lines are obsolete (RFC 9112) and refused.
        if line[0] == b' ' || line[0] == b'\t' || !visible_ascii(&line) {
            return Err(HeadError::Malformed);
        }
        // The line may hold the token: wiped once the header is read.
        let header = Zeroizing::new(String::from_utf8_lossy(&line).into_owned());
        line.iter_mut().for_each(|b| *b = 0);
        let Some((name, value)) = header.split_once(':') else {
            return Err(HeadError::Malformed);
        };
        if name.is_empty() || name.ends_with([' ', '\t']) {
            return Err(HeadError::Malformed);
        }
        let value = value.trim_matches([' ', '\t']);
        if name.eq_ignore_ascii_case("content-length") {
            if length.is_some() || value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
                return Err(HeadError::Malformed);
            }
            length = Some(value.parse().unwrap_or(u64::MAX));
        } else if name.eq_ignore_ascii_case("host") {
            if host.is_some() {
                return Err(HeadError::Malformed);
            }
            host = Some(value.to_owned());
        } else if name.eq_ignore_ascii_case("origin")
            || name
                .get(..10)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("sec-fetch-"))
        {
            from_browser = true;
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            return Err(HeadError::Encoding);
        } else if name.eq_ignore_ascii_case("authorization") {
            if token.is_some() {
                return Err(HeadError::Malformed);
            }
            let bearer = value
                .split_once(' ')
                .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
                .map(|(_, rest)| rest.trim().to_owned());
            token = Some(Zeroizing::new(bearer.unwrap_or_default()));
        } else if name.eq_ignore_ascii_case("content-type") {
            if content_type.is_some() {
                return Err(HeadError::Malformed);
            }
            content_type = Some(value.to_owned());
        } else if name.eq_ignore_ascii_case(NONCE_HEADER) {
            if nonce.is_some() {
                return Err(HeadError::Malformed);
            }
            nonce = Some(value.to_owned());
        } else if name.eq_ignore_ascii_case("connection") {
            for option in value.split(',').map(|option| option.trim()) {
                connection_close |= option.eq_ignore_ascii_case("close");
                connection_keep_alive |= option.eq_ignore_ascii_case("keep-alive");
            }
        }
    }
    if !method_ok {
        return Err(HeadError::Method);
    }
    let content_length = length.ok_or(HeadError::NoLength)?;
    let path = target.split_once('?').map_or(target, |(path, _)| path);
    let json = content_type.is_some_and(|value| {
        value
            .split(';')
            .next()
            .is_some_and(|media| media.trim().eq_ignore_ascii_case("application/json"))
    });
    Ok(Head {
        path: path.to_owned(),
        token: token.filter(|t| !t.is_empty()),
        content_length,
        host,
        from_browser,
        json,
        nonce,
        close: connection_close || (version == "HTTP/1.0" && !connection_keep_alive),
    })
}

/// A complete response with a JSON body; `proof` goes into [`PROOF_HEADER`]. `keep_alive`: the
/// connection stays open for one more request (only after a hello), else it closes.
pub fn response(status: Status, body: &str, proof: Option<&str>, keep_alive: bool) -> Vec<u8> {
    let proof = proof
        .map(|proof| format!("{PROOF_HEADER}: {proof}\r\n"))
        .unwrap_or_default();
    let connection = if keep_alive { "keep-alive" } else { "close" };
    let mut out = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\n{proof}Connection: {connection}\r\n\r\n",
        status.code(),
        status.reason(),
        body.len()
    )
    .into_bytes();
    out.extend_from_slice(body.as_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A body lands in one buffer of exactly its length, allocated once and wiped when dropped
    /// (security review L4): a growing `Vec` would leave copies of the content in the memory it
    /// gave back on every reallocation.
    #[test]
    fn a_body_is_read_into_one_buffer_of_its_length() {
        let content = b"marker-body-3f7 ".repeat(2048);
        let length = content.len() as u64;
        let mut source = WipingReader::new(&content[..]);
        let body = read_body(&mut source, length, length).unwrap();
        assert_eq!(&body[..], &content[..]);
        assert_eq!(body.capacity(), content.len());
        // Fewer bytes than announced, or more announced than allowed, are refused; the limit is
        // checked before anything is allocated.
        let mut short = WipingReader::new(&content[..10]);
        assert_eq!(
            read_body(&mut short, 11, 64).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
        let mut empty = WipingReader::new(&b""[..]);
        assert_eq!(
            read_body(&mut empty, u64::MAX, 64).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert!(read_body(&mut empty, 0, 0).unwrap().is_empty());
    }

    fn head(raw: &[u8]) -> Result<Head, HeadError> {
        read_head(&mut io::BufReader::new(raw))
    }

    #[test]
    fn a_plain_post_is_read() {
        let parsed = head(
            b"POST /capture?x=1 HTTP/1.1\r\nHost: 127.0.0.1:4711\r\n\
              Authorization: Bearer abc\r\nContent-Length: 12\r\n\r\nbody",
        )
        .unwrap();
        assert_eq!(parsed.path, "/capture");
        assert_eq!(parsed.token.as_deref().map(String::as_str), Some("abc"));
        assert_eq!(parsed.content_length, 12);
        assert_eq!(parsed.host.as_deref(), Some("127.0.0.1:4711"));
        assert!(!parsed.from_browser);
        assert!(!parsed.json);
        assert_eq!(parsed.nonce, None);
        assert!(!format!("{parsed:?}").contains("abc"));
    }

    /// Security review B5: once the head is read, the reader's buffer no longer holds the token,
    /// while the body after it is still there to read.
    #[test]
    fn the_reader_keeps_no_token_once_the_head_is_read() {
        let token = "marker-token-5e1c";
        let raw = format!(
            "POST /flush HTTP/1.1\r\nHost: 127.0.0.1:1\r\nAuthorization: Bearer {token}\r\n\
             Content-Length: 13\r\n\r\n{{\"version\":1}}"
        );
        let mut reader = WipingReader::new(raw.as_bytes());
        let parsed = read_head(&mut reader).unwrap();
        assert_eq!(parsed.token.as_deref().map(String::as_str), Some(token));
        let held = String::from_utf8_lossy(reader.raw_buffer()).into_owned();
        assert!(!held.contains(token), "{held}");
        assert!(!held.contains("Bearer"), "{held}");
        let mut body = Vec::new();
        reader.read_to_end(&mut body).unwrap();
        assert_eq!(body, br#"{"version":1}"#);
        // Read whole, nothing is left in it either.
        assert!(reader.raw_buffer().iter().all(|b| *b == 0));
    }

    #[test]
    fn content_type_and_nonce_are_read_once() {
        for (value, json) in [
            ("application/json", true),
            ("Application/JSON; charset=utf-8", true),
            ("text/plain", false),
            ("application/json-patch+json", false),
            ("", false),
        ] {
            let raw = format!(
                "POST / HTTP/1.1\r\nContent-Type: {value}\r\nX-Channel-Nonce: n\r\n\
                 Content-Length: 0\r\n\r\n"
            );
            let parsed = head(raw.as_bytes()).unwrap();
            assert_eq!(parsed.json, json, "{value}");
            assert_eq!(parsed.nonce.as_deref(), Some("n"));
        }
        for twice in [
            "Content-Type: application/json\r\nContent-Type: application/json",
            "X-Channel-Nonce: a\r\nx-channel-nonce: b",
        ] {
            let raw = format!("POST / HTTP/1.1\r\n{twice}\r\nContent-Length: 0\r\n\r\n");
            assert!(matches!(head(raw.as_bytes()), Err(HeadError::Malformed)));
        }
    }

    #[test]
    fn browsers_and_unusual_requests_are_recognized() {
        for header in [
            "Origin: http://example.invalid",
            "origin: null",
            "Sec-Fetch-Mode: cors",
        ] {
            let raw = format!("POST / HTTP/1.1\r\n{header}\r\nContent-Length: 0\r\n\r\n");
            assert!(head(raw.as_bytes()).unwrap().from_browser, "{header}");
        }
        assert!(matches!(
            head(b"GET / HTTP/1.1\r\nContent-Length: 0\r\n\r\n"),
            Err(HeadError::Method)
        ));
        assert!(matches!(
            head(b"POST / HTTP/1.1\r\n\r\n"),
            Err(HeadError::NoLength)
        ));
        assert!(matches!(
            head(b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n"),
            Err(HeadError::Encoding)
        ));
        assert!(matches!(
            head(b"POST / HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\n"),
            Err(HeadError::Malformed)
        ));
        assert!(matches!(
            head(b"POST / HTTP/1.1\r\nHost: a\r\nHost: b\r\nContent-Length: 0\r\n\r\n"),
            Err(HeadError::Malformed)
        ));
        assert!(matches!(
            head(b"POST / HTTP/1.1\r\nX: a\r\n folded\r\nContent-Length: 0\r\n\r\n"),
            Err(HeadError::Malformed)
        ));
        let huge = format!(
            "POST / HTTP/1.1\r\nX: {}\r\n\r\n",
            "a".repeat(MAX_HEAD_BYTES)
        );
        assert!(matches!(head(huge.as_bytes()), Err(HeadError::TooLarge)));
        assert!(
            head(b"POST / HTTP/1.1\r\nAuthorization: Basic x\r\nContent-Length: 0\r\n\r\n")
                .unwrap()
                .token
                .is_none()
        );
    }

    #[test]
    fn the_client_may_ask_to_close() {
        for (version, connection, close) in [
            ("HTTP/1.1", "", false),
            ("HTTP/1.1", "Connection: keep-alive\r\n", false),
            ("HTTP/1.1", "Connection: close\r\n", true),
            ("HTTP/1.1", "connection: Keep-Alive, Close\r\n", true),
            ("HTTP/1.0", "", true),
            ("HTTP/1.0", "Connection: keep-alive\r\n", false),
        ] {
            let raw = format!("POST / {version}\r\n{connection}Content-Length: 0\r\n\r\n");
            assert_eq!(
                head(raw.as_bytes()).unwrap().close,
                close,
                "{version} {connection}"
            );
        }
    }

    #[test]
    fn responses_say_whether_the_connection_stays_open() {
        let text = String::from_utf8(response(Status::Conflict, "{}", None, false)).unwrap();
        assert!(text.starts_with("HTTP/1.1 409 Conflict\r\n"));
        assert!(!text.contains(PROOF_HEADER));
        let proven = String::from_utf8(response(Status::Ok, "{}", Some("ab"), true)).unwrap();
        assert!(proven.contains("X-Channel-Proof: ab\r\n"));
        assert!(proven.contains("Connection: keep-alive\r\n"));
        assert!(text.contains("Content-Length: 2\r\n"));
        assert!(text.contains("Connection: close\r\n"));
        assert!(text.ends_with("\r\n\r\n{}"));
    }
}
