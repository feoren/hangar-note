//! Connection slots of the channel (security review of phase 1, finding M2), taken from Hangar's
//! `gate_service.rs` (MIT, same owner), which met the same problem at a larger scale.
//!
//! Until its head is read, a connection holds one of [`MAX_UNAUTHENTICATED`] head slots and has
//! [`HEAD_TIME`] in total for its head, however slowly it sends. With all of them taken, a new
//! connection closes the oldest *silent* one: it waited [`HEAD_GRACE`] and nothing of its head
//! waits unread. Hangar and the command line send their head at once, so silent local programs
//! cannot keep them out. Past [`MAX_HEAD_THREADS`] busy head threads with none of them silent, a
//! new connection is closed unanswered. An authenticated request then moves to one of
//! [`MAX_AUTHENTICATED`] slots for its body and answer.

use std::collections::VecDeque;
use std::io::{self, Read};
use std::net::{Shutdown, TcpStream};
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::fsio::lock;

/// Connections whose head is not read yet that may stay silent before the oldest gives way.
pub const MAX_UNAUTHENTICATED: usize = 16;
/// Threads reading a head at once, closed ones that have not noticed yet included.
pub const MAX_HEAD_THREADS: usize = 32;
/// Authenticated requests handled at the same time; one more is answered `busy`.
pub const MAX_AUTHENTICATED: usize = 16;
/// The whole head (request line and headers), however slowly it arrives.
pub const HEAD_TIME: Duration = Duration::from_secs(2);
/// How long a connection may wait silently for its head before a newer one may close it.
pub const HEAD_GRACE: Duration = Duration::from_secs(1);
/// How often a connection reading its head looks whether a newer one took its slot.
const HEAD_POLL: Duration = Duration::from_millis(100);

/// One counted slot of the authenticated requests, given back when dropped.
pub struct Slot(Arc<AtomicUsize>);

impl Slot {
    pub fn take(counter: &Arc<AtomicUsize>, limit: usize) -> Option<Slot> {
        if counter.fetch_add(1, Ordering::SeqCst) >= limit {
            counter.fetch_sub(1, Ordering::SeqCst);
            return None;
        }
        Some(Slot(Arc::clone(counter)))
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Where a connection reading its head stands, shared by its reader and the accept thread.
///
/// The reader takes bytes out of the socket only while it holds them (`HOLDING`, set with a
/// compare and swap after a peek saw them), and the accept thread closes a connection only from
/// `WAITING` with nothing in its socket. So a connection whose head has arrived is never closed as
/// silent, however late its reader runs on a busy machine.
pub struct HeadState(AtomicU8);

impl HeadState {
    const WAITING: u8 = 0;
    const HOLDING: u8 = 1;
    const CLOSED: u8 = 2;

    fn new() -> Self {
        Self(AtomicU8::new(Self::WAITING))
    }

    /// A newer connection took this one's slot.
    pub fn closed(&self) -> bool {
        self.0.load(Ordering::SeqCst) == Self::CLOSED
    }

    /// The reader is done with what it held and waits for more; `false` once closed.
    fn wait(&self) -> bool {
        match self.0.compare_exchange(
            Self::HOLDING,
            Self::WAITING,
            Ordering::SeqCst,
            Ordering::SeqCst,
        ) {
            Ok(_) => true,
            Err(current) => current == Self::WAITING,
        }
    }

    /// The reader saw bytes and is about to take them; `false` once closed.
    fn hold(&self) -> bool {
        match self.0.compare_exchange(
            Self::WAITING,
            Self::HOLDING,
            Ordering::SeqCst,
            Ordering::SeqCst,
        ) {
            Ok(_) => true,
            Err(current) => current == Self::HOLDING,
        }
    }

    /// Closes a waiting connection; `false` when its reader holds bytes (or it is closed).
    fn close_waiting(&self) -> bool {
        self.0
            .compare_exchange(
                Self::WAITING,
                Self::CLOSED,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_ok()
    }
}

/// Nothing arrived on `stream` that its reader has not taken yet. Asked only under the [`Heads`]
/// lock for a connection still reading its head, whose reader treats a would-block as a timeout
/// while this switches the socket to non-blocking for a moment. When the socket cannot be asked,
/// it counts as not silent: a request is never cut on a guess.
fn nothing_buffered(stream: &TcpStream) -> bool {
    if stream.set_nonblocking(true).is_err() {
        return false;
    }
    let mut probe = [0u8; 1];
    let empty = match stream.peek(&mut probe) {
        // Closed by the client: nothing will come.
        Ok(0) => true,
        Ok(_) => false,
        Err(error) => error.kind() != io::ErrorKind::Interrupted,
    };
    let _ = stream.set_nonblocking(false);
    empty
}

/// Connections whose head is still being read.
#[derive(Default)]
pub struct Heads {
    next: u64,
    /// The ones holding a slot, oldest first: id, a handle to close it, its state, when it was
    /// accepted.
    open: VecDeque<(u64, TcpStream, Arc<HeadState>, Instant)>,
    /// Threads still reading a head, the closed ones that have not noticed yet included.
    alive: usize,
}

/// A connection reading its head: one of [`MAX_UNAUTHENTICATED`] slots until the head is read or
/// a newer connection takes the slot.
pub struct HeadSlot {
    heads: Arc<Mutex<Heads>>,
    id: u64,
    pub state: Arc<HeadState>,
}

impl HeadSlot {
    /// A slot for `stream`; with [`MAX_UNAUTHENTICATED`] or more open, or every head thread busy,
    /// the oldest silent connection (it waited `grace`) is closed for this one. `None` (closed
    /// unanswered) only when [`MAX_HEAD_THREADS`] threads are busy and none of them is silent.
    pub fn take(heads: &Arc<Mutex<Heads>>, stream: &TcpStream, grace: Duration) -> Option<Self> {
        let handle = stream.try_clone().ok()?;
        let state = Arc::new(HeadState::new());
        let now = Instant::now();
        let (id, evicted) = {
            let mut list = lock(heads);
            let crowded = list.open.len() >= MAX_UNAUTHENTICATED || list.alive >= MAX_HEAD_THREADS;
            // Oldest first; the ones after the first within its grace are younger still.
            let silent = if crowded {
                list.open
                    .iter()
                    .take_while(|(_, _, _, since)| now.saturating_duration_since(*since) >= grace)
                    .position(|(_, other, other_state, _)| {
                        nothing_buffered(other) && other_state.close_waiting()
                    })
            } else {
                None
            };
            let evicted = silent.and_then(|at| list.open.remove(at));
            if evicted.is_none() && list.alive >= MAX_HEAD_THREADS {
                return None;
            }
            let id = list.next;
            list.next = list.next.wrapping_add(1);
            list.open.push_back((id, handle, Arc::clone(&state), now));
            list.alive += 1;
            (id, evicted)
        };
        if let Some((_, oldest, _, _)) = evicted {
            // Wakes its reader where the platform does; its state ends it within HEAD_POLL.
            let _ = oldest.shutdown(Shutdown::Both);
        }
        Some(Self {
            heads: Arc::clone(heads),
            id,
            state,
        })
    }

    /// Reading the head is over, read or failed: this connection leaves the slots a newer one may
    /// take, before its request is looked at or answered, so it is never closed while answered.
    /// `false` when a newer one took its slot first (its stream is closed then).
    pub fn head_read(&self) -> bool {
        let mut list = lock(&self.heads);
        let before = list.open.len();
        list.open.retain(|(id, _, _, _)| *id != self.id);
        before != list.open.len() && !self.state.closed()
    }
}

impl Drop for HeadSlot {
    fn drop(&mut self) {
        let mut list = lock(&self.heads);
        list.open.retain(|(id, _, _, _)| *id != self.id);
        list.alive = list.alive.saturating_sub(1);
    }
}

/// Reads with one deadline for all reads together: each read may take only the time left, so a
/// client sending a byte now and then cannot stretch a limit meant for the whole request.
pub struct Deadline<'a> {
    stream: &'a TcpStream,
    until: Instant,
    /// Set while the head is read: bytes leave the socket only while they are held
    /// ([`HeadState`]), and reading stops within [`HEAD_POLL`] once a newer connection took this
    /// one's slot.
    head: Option<Arc<HeadState>>,
}

impl<'a> Deadline<'a> {
    pub fn new(stream: &'a TcpStream, limit: Duration) -> Self {
        Self {
            stream,
            until: Instant::now() + limit,
            head: None,
        }
    }

    /// Reading a head that `state` guards.
    pub fn for_head(stream: &'a TcpStream, limit: Duration, state: Arc<HeadState>) -> Self {
        Self {
            head: Some(state),
            ..Self::new(stream, limit)
        }
    }

    /// A fresh total from now, for the next part of the request.
    pub fn restart(&mut self, limit: Duration) {
        self.until = Instant::now() + limit;
        self.head = None;
    }
}

impl Read for Deadline<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        loop {
            if self.head.as_ref().is_some_and(|head| !head.wait()) {
                return Err(io::ErrorKind::ConnectionAborted.into());
            }
            let left = self.until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(io::ErrorKind::TimedOut.into());
            }
            let slice = match self.head {
                Some(_) => left.min(HEAD_POLL),
                None => left,
            };
            self.stream.set_read_timeout(Some(slice))?;
            let mut stream = self.stream;
            let Some(head) = &self.head else {
                return stream.read(buf);
            };
            // Peeked first, so the bytes stay in the socket until they are held: the accept
            // thread sees them there or sees them held, never neither.
            match stream.peek(buf) {
                Ok(0) => return Ok(0),
                Ok(_) if head.hold() => return stream.read(buf),
                Ok(_) => return Err(io::ErrorKind::ConnectionAborted.into()),
                // The accept thread may switch the socket to non-blocking for a moment.
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) => {}
                Err(error) => return Err(error),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::net::{Ipv4Addr, TcpListener};

    fn pair(listener: &TcpListener, port: u16) -> (TcpStream, TcpStream) {
        let client = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        (client, listener.accept().unwrap().0)
    }

    #[test]
    fn silent_connections_give_way_to_newer_ones() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let heads = Arc::new(Mutex::new(Heads::default()));
        let mut clients = Vec::new();
        let (client, first_stream) = pair(&listener, port);
        clients.push(client);
        let first = HeadSlot::take(&heads, &first_stream, Duration::ZERO).unwrap();
        assert!(first.head_read());
        // Every slot taken and then some, with no grace: each newcomer closes the oldest one still
        // reading its head, never the one being answered.
        let mut others = Vec::new();
        for _ in 0..2 * MAX_UNAUTHENTICATED {
            let (client, stream) = pair(&listener, port);
            clients.push(client);
            others.push(HeadSlot::take(&heads, &stream, Duration::ZERO).unwrap());
        }
        assert!(!first.state.closed());
        let evicted = others.iter().find(|slot| slot.state.closed()).unwrap();
        assert!(!evicted.head_read());
    }

    #[test]
    fn within_the_grace_nobody_is_closed() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let heads = Arc::new(Mutex::new(Heads::default()));
        let mut clients = Vec::new();
        let slots: Vec<HeadSlot> = (0..MAX_UNAUTHENTICATED + 4)
            .map(|_| {
                let (client, stream) = pair(&listener, port);
                clients.push(client);
                HeadSlot::take(&heads, &stream, HEAD_GRACE).unwrap()
            })
            .collect();
        assert!(slots.iter().all(|slot| !slot.state.closed()));
    }

    #[test]
    fn a_connection_whose_head_has_arrived_is_never_closed_as_silent() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let heads = Arc::new(Mutex::new(Heads::default()));
        let mut clients = Vec::new();
        let head = b"POST / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
        let (mut client, unread_stream) = pair(&listener, port);
        client.write_all(head).unwrap();
        clients.push(client);
        let mut probe = [0u8; 1];
        // Blocks until the bytes are there, so no timing decides the outcome.
        assert_eq!(unread_stream.peek(&mut probe).unwrap(), 1);
        let unread = HeadSlot::take(&heads, &unread_stream, Duration::ZERO).unwrap();
        let mut silent = Vec::new();
        for _ in 0..2 * MAX_UNAUTHENTICATED {
            let (client, stream) = pair(&listener, port);
            clients.push(client);
            silent.push(HeadSlot::take(&heads, &stream, Duration::ZERO).unwrap());
        }
        assert!(silent.iter().any(|slot| slot.state.closed()));
        assert!(unread.head_read());
    }

    #[test]
    fn authenticated_slots_are_counted_and_given_back() {
        let counter = Arc::new(AtomicUsize::new(0));
        let held: Vec<Slot> = (0..MAX_AUTHENTICATED)
            .map(|_| Slot::take(&counter, MAX_AUTHENTICATED).unwrap())
            .collect();
        assert!(Slot::take(&counter, MAX_AUTHENTICATED).is_none());
        drop(held);
        assert_eq!(counter.load(Ordering::SeqCst), 0);
    }
}
