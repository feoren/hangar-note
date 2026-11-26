//! The smallest HTTP/1.1 the local channel needs: one `POST` with `Content-Length` per
//! connection, answered with `Connection: close`. Taken from Hangar's `hook_http.rs` (MIT, same
//! owner), which made the same choice: a few routes on 127.0.0.1 for one client, every limit
//! explicit here. hyper or axum would add an async server, routing and keep-alive handling for
//! no gain. Anything unusual is refused rather than interpreted: chunked bodies, a second
//! `Content-Length`, folded headers, control characters, oversized heads.

use std::io::{self, BufRead};

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
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Head {
    /// The path, without a query.
    pub path: String,
    /// The bearer token of `Authorization`, if any.
    pub token: Option<String>,
    pub content_length: u64,
    /// `Host` as sent; the channel wants exactly its own `127.0.0.1:<port>`.
    pub host: Option<String>,
    /// `Origin` or a `Sec-Fetch-*` header: a browser sent it (a web page trying the local port).
    pub from_browser: bool,
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
    let mut line = Vec::new();
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

    let mut token = None;
    let mut host: Option<String> = None;
    let mut from_browser = false;
    let mut length: Option<u64> = None;
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
        let header = String::from_utf8_lossy(&line);
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
            token = Some(bearer.unwrap_or_default());
        }
    }
    if !method_ok {
        return Err(HeadError::Method);
    }
    let content_length = length.ok_or(HeadError::NoLength)?;
    let path = target.split_once('?').map_or(target, |(path, _)| path);
    Ok(Head {
        path: path.to_owned(),
        token: token.filter(|t| !t.is_empty()),
        content_length,
        host,
        from_browser,
    })
}

/// A complete response with a JSON body that closes the connection.
pub fn response(status: Status, body: &str) -> Vec<u8> {
    let mut out = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nConnection: close\r\n\r\n",
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
        assert_eq!(parsed.token.as_deref(), Some("abc"));
        assert_eq!(parsed.content_length, 12);
        assert_eq!(parsed.host.as_deref(), Some("127.0.0.1:4711"));
        assert!(!parsed.from_browser);
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
    fn responses_close_the_connection() {
        let text = String::from_utf8(response(Status::Conflict, "{}")).unwrap();
        assert!(text.starts_with("HTTP/1.1 409 Conflict\r\n"));
        assert!(text.contains("Content-Length: 2\r\n"));
        assert!(text.contains("Connection: close\r\n"));
        assert!(text.ends_with("\r\n\r\n{}"));
    }
}
