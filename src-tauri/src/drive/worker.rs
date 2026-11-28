//! The background side of the sync status: one worker thread that finds Hangar Drive, reads its
//! status, asks once for the notes folder, and keeps the per note marks; one thread for the
//! `events` long poll while Drive runs. Neither ever runs on a window's thread: the windows only
//! read the last [`DriveSyncView`] and get `drive-sync-changed` when it changes.
//!
//! - **Absent or not running:** a look into Drive's folder every [`Config::discovery_interval`].
//! - **Running:** `status`; `folders/request` once when `notes.state` is `none`; then `events`
//!   from a `null` cursor. `items` asks for those paths again, `reset` for every note, `status`
//!   for the status.
//! - **Own changes** (a save, a new, renamed or deleted note: every file the store writes, and
//!   every scope the watcher reports) are collected and asked for after [`Config::debounce`],
//!   at most [`Config::max_debounce`] after the first one.
//! - **Failures** back off from [`Config::backoff_min`] to [`Config::backoff_max`]; an unproven
//!   answer means Drive is not running.
//! - **Quitting** cuts every open connection short ([`StreamSlot::cancel`]) and joins both threads.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use super::client::{DriveClient, DriveError, Events, ItemQuery, MAX_ITEMS, MAX_WAIT_MS};
use super::discovery::{discover, Found};
use super::paths;
use super::state::{phase_of, DriveSyncView, Link, Marks, NoteRef};
use crate::channel::StreamSlot;
use crate::fsio::{lock, read_capped};
use crate::notes::{content_version, is_folder_key, NoteFile, NotesStore, MAX_NOTE_BYTES};
use crate::watch::{stat_version, OwnObserver};

/// Where the notes come from: the store in the app, a fake in tests.
pub trait NoteSource: Send + Sync + 'static {
    /// The notes folder.
    fn root(&self) -> &Path;
    /// The active notes of every scope, or of one scope (`NotesStore::note_files`).
    fn note_files(&self, scope: Option<&str>) -> Vec<NoteFile>;
}

impl NoteSource for NotesStore {
    fn root(&self) -> &Path {
        NotesStore::root(self)
    }

    fn note_files(&self, scope: Option<&str>) -> Vec<NoteFile> {
        NotesStore::note_files(self, scope)
    }
}

/// Where a changed view goes: the windows in the app, a recorder in tests.
pub trait ViewSink: Send + Sync + 'static {
    fn changed(&self, view: &DriveSyncView);
}

#[derive(Debug, Clone)]
pub struct Config {
    /// Drive's local data folder (`discovery::drive_dir`).
    pub drive_dir: PathBuf,
    pub discovery_interval: Duration,
    pub debounce: Duration,
    pub max_debounce: Duration,
    pub backoff_min: Duration,
    pub backoff_max: Duration,
    /// `waitMs` of every `events` call.
    pub wait_ms: u64,
}

impl Config {
    pub fn new(drive_dir: PathBuf) -> Self {
        Self {
            drive_dir,
            discovery_interval: Duration::from_secs(10),
            debounce: Duration::from_millis(1500),
            max_debounce: Duration::from_secs(5),
            backoff_min: Duration::from_secs(2),
            backoff_max: Duration::from_secs(60),
            wait_ms: MAX_WAIT_MS,
        }
    }
}

/// Every `events` round lasts at least this long, whatever the answer said, so a server that
/// never waits cannot make the long poll spin (security review of the Drive client, N1).
const MIN_EVENTS_ROUND: Duration = Duration::from_millis(250);
/// The longest pause after `reset` answers in a row. Each `reset` makes the worker ask for every
/// note, so a server (or a cursor that never validates) answering `reset` again and again is
/// slowed down: the second in a row waits [`MIN_EVENTS_ROUND`] twice, the third four times and so
/// on, up to this.
const MAX_RESET_PAUSE: Duration = Duration::from_secs(30);
/// Pauses of the long poll look at the stop this often.
const PAUSE_STEP: Duration = Duration::from_millis(50);

/// How long a round of the long poll lasts at least: [`MIN_EVENTS_ROUND`], doubled for every
/// `reset` in a row after the first, at most [`MAX_RESET_PAUSE`].
fn events_round(resets_in_a_row: u32) -> Duration {
    let doublings = resets_in_a_row.saturating_sub(1).min(16);
    (MIN_EVENTS_ROUND * 2u32.pow(doublings)).min(MAX_RESET_PAUSE)
}
/// How long the worker sleeps when nothing is scheduled; any message wakes it earlier.
const IDLE_WAIT: Duration = Duration::from_secs(60);

enum Msg {
    /// A file the store wrote or moved away.
    Own(PathBuf),
    /// Scopes another program changed (the watcher).
    Scopes(BTreeSet<String>),
    Events {
        generation: u64,
        result: Result<Events, DriveError>,
    },
    Stop,
}

struct Shared {
    view: Mutex<DriveSyncView>,
    stop: AtomicBool,
    /// The worker's own requests.
    worker_slot: StreamSlot,
    /// The long poll of the current `events` thread.
    events_slot: Mutex<Option<Arc<StreamSlot>>>,
}

/// The handle the app keeps: the current view, the inputs, and the stop.
pub struct DriveSync {
    shared: Arc<Shared>,
    sender: Option<Sender<Msg>>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl std::fmt::Debug for DriveSync {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DriveSync")
            .field("view", &self.view())
            .finish_non_exhaustive()
    }
}

impl DriveSync {
    /// No client at all: the view stays [`Phase::Absent`](super::state::Phase::Absent). For a
    /// notes folder Drive does not sync (a development root).
    pub fn disabled() -> Self {
        Self {
            shared: Arc::new(Shared {
                view: Mutex::new(DriveSyncView::absent()),
                stop: AtomicBool::new(true),
                worker_slot: StreamSlot::default(),
                events_slot: Mutex::default(),
            }),
            sender: None,
            thread: Mutex::default(),
        }
    }

    /// Starts the worker.
    pub fn start(config: Config, source: Arc<dyn NoteSource>, sink: Arc<dyn ViewSink>) -> Self {
        let mut sync = Self::disabled();
        sync.shared.stop.store(false, Ordering::SeqCst);
        let (sender, receiver) = mpsc::channel();
        let worker = Worker {
            backoff: config.backoff_min,
            config,
            source,
            sink,
            shared: sync.shared.clone(),
            receiver,
            sender: sender.clone(),
            link: Link::Absent,
            client: None,
            asked: false,
            marks: Marks::default(),
            hashes: HashMap::new(),
            pending: Pending::default(),
            next_contact: Some(Instant::now()),
            events: None,
            generation: 0,
        };
        match thread::Builder::new()
            .name("drive-sync".into())
            .spawn(move || worker.run())
        {
            Ok(handle) => {
                *lock(&sync.thread) = Some(handle);
                sync.sender = Some(sender);
            }
            Err(error) => {
                eprintln!("hangar-note: Hangar Drive status not started: {error}");
                sync.shared.stop.store(true, Ordering::SeqCst);
            }
        }
        sync
    }

    pub fn view(&self) -> DriveSyncView {
        lock(&self.shared.view).clone()
    }

    /// The observer for the store's own writes (`NotesStore::observe_own_writes`); `None` while
    /// no worker runs.
    pub fn own_writes_observer(&self) -> Option<OwnObserver> {
        let sender = self.sender.clone()?;
        Some(Arc::new(move |path: &Path| {
            let _ = sender.send(Msg::Own(path.to_path_buf()));
        }))
    }

    /// Scopes another program changed (the watcher in `lib.rs`).
    pub fn scopes_changed(&self, scopes: &BTreeSet<String>) {
        if scopes.is_empty() {
            return;
        }
        if let Some(sender) = &self.sender {
            let _ = sender.send(Msg::Scopes(scopes.clone()));
        }
    }

    /// Ends both threads: open connections are cut short, so this returns quickly.
    pub fn stop(&self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        if let Some(sender) = &self.sender {
            let _ = sender.send(Msg::Stop);
        }
        self.shared.worker_slot.cancel();
        if let Some(slot) = lock(&self.shared.events_slot).as_ref() {
            slot.cancel();
        }
        let handle = lock(&self.thread).take();
        if let Some(handle) = handle {
            let _ = handle.join();
        }
    }
}

impl Drop for DriveSync {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Work collected for the next `items/status` round.
#[derive(Debug, Default)]
struct Pending {
    all: bool,
    scopes: BTreeSet<String>,
    paths: BTreeSet<String>,
    first: Option<Instant>,
    due: Option<Instant>,
}

impl Pending {
    fn is_empty(&self) -> bool {
        !self.all && self.scopes.is_empty() && self.paths.is_empty()
    }

    fn now(&mut self, now: Instant) {
        self.first.get_or_insert(now);
        self.due = Some(now);
    }

    fn debounced(&mut self, now: Instant, debounce: Duration, max: Duration) {
        let first = *self.first.get_or_insert(now);
        let due = (now + debounce).min(first + max);
        self.due = Some(match self.due {
            Some(earlier) if earlier <= now => earlier,
            _ => due,
        });
    }
}

struct EventsRun {
    generation: u64,
    slot: Arc<StreamSlot>,
    handle: JoinHandle<()>,
}

struct Worker {
    config: Config,
    source: Arc<dyn NoteSource>,
    sink: Arc<dyn ViewSink>,
    shared: Arc<Shared>,
    receiver: Receiver<Msg>,
    sender: Sender<Msg>,
    link: Link,
    client: Option<Arc<DriveClient>>,
    /// `folders/request` went to this endpoint already.
    asked: bool,
    marks: Marks,
    /// Per path the file state and the version computed for it, so an unchanged note is not read
    /// again.
    hashes: HashMap<String, (String, String)>,
    pending: Pending,
    next_contact: Option<Instant>,
    backoff: Duration,
    events: Option<EventsRun>,
    generation: u64,
}

impl Worker {
    fn stopped(&self) -> bool {
        self.shared.stop.load(Ordering::SeqCst)
    }

    fn active(&self) -> bool {
        matches!(&self.link, Link::Running(status) if status.notes_active())
    }

    fn can_query(&self) -> bool {
        self.active() && self.client.is_some() && !self.pending.is_empty()
    }

    fn run(mut self) {
        loop {
            if self.stopped() {
                break;
            }
            let now = Instant::now();
            if self.next_contact.is_some_and(|at| at <= now) {
                self.contact();
                continue;
            }
            if self.can_query() && self.pending.due.is_some_and(|at| at <= now) {
                self.query();
                continue;
            }
            let mut wake = self.next_contact;
            if self.can_query() {
                wake = match (wake, self.pending.due) {
                    (Some(a), Some(b)) => Some(a.min(b)),
                    (a, b) => a.or(b),
                };
            }
            let timeout = wake.map_or(IDLE_WAIT, |at| at.saturating_duration_since(now));
            match self.receiver.recv_timeout(timeout) {
                Ok(Msg::Stop) | Err(RecvTimeoutError::Disconnected) => break,
                Ok(message) => self.handle(message),
                Err(RecvTimeoutError::Timeout) => {}
            }
        }
        self.stop_events();
    }

    fn handle(&mut self, message: Msg) {
        let now = Instant::now();
        match message {
            Msg::Own(path) => {
                if !self.active() {
                    return;
                }
                match self.own_change(&path) {
                    Some(OwnChange::Note(path)) => {
                        // The file just changed: its cached version is stale whatever its state.
                        self.hashes.remove(&path);
                        self.pending.paths.insert(path);
                    }
                    Some(OwnChange::Scope(scope)) => {
                        self.pending.scopes.insert(scope);
                    }
                    None => return,
                }
                self.pending
                    .debounced(now, self.config.debounce, self.config.max_debounce);
            }
            Msg::Scopes(scopes) => {
                if !self.active() {
                    return;
                }
                let valid: BTreeSet<String> =
                    scopes.into_iter().filter(|s| is_folder_key(s)).collect();
                if valid.is_empty() {
                    return;
                }
                self.pending.scopes.extend(valid);
                self.pending
                    .debounced(now, self.config.debounce, self.config.max_debounce);
            }
            Msg::Events { generation, result } => {
                if self.events.as_ref().map(|run| run.generation) != Some(generation) {
                    return;
                }
                match result {
                    Ok(events) => {
                        self.backoff = self.config.backoff_min;
                        if events.status {
                            self.refresh_status();
                        }
                        if !self.active() {
                            return;
                        }
                        if events.reset {
                            self.pending.all = true;
                        }
                        self.pending.paths.extend(events.paths);
                        if !self.pending.is_empty() {
                            self.pending.now(now);
                        }
                    }
                    Err(error) => {
                        self.stop_events();
                        // Drive restarted or stopped: look again (a new endpoint, a new token).
                        self.client = None;
                        if !matches!(error, DriveError::NotRunning) {
                            eprintln!("hangar-note: Hangar Drive events: {error}");
                        }
                        self.retry_later();
                    }
                }
            }
            Msg::Stop => {}
        }
    }

    /// What a file the store wrote means for the marks.
    fn own_change(&self, path: &Path) -> Option<OwnChange> {
        let relative = path.strip_prefix(self.source.root()).ok()?;
        let mut parts = relative.components().map(|component| match component {
            Component::Normal(part) => part.to_str(),
            _ => None,
        });
        let scope = parts.next()??;
        if !is_folder_key(scope) {
            return None;
        }
        let rest: Vec<&str> = parts.collect::<Option<Vec<_>>>()?;
        match rest.as_slice() {
            [file] if is_markdown(file) => paths::note_path(scope, file).map(OwnChange::Note),
            // `folder.json` and the trash: notes came, went or were renamed.
            [_] | [_, _] => Some(OwnChange::Scope(scope.to_owned())),
            _ => None,
        }
    }

    fn retry_later(&mut self) {
        self.next_contact = Some(Instant::now() + self.backoff);
        self.backoff = (self.backoff * 2).min(self.config.backoff_max);
    }

    /// Finds Drive if no client is held, then reads its status.
    fn contact(&mut self) {
        self.next_contact = None;
        if self.client.is_none() {
            match discover(&self.config.drive_dir) {
                Found::Absent => {
                    self.disconnect(Link::Absent);
                    self.next_contact = Some(Instant::now() + self.config.discovery_interval);
                    return;
                }
                Found::NotRunning => {
                    self.disconnect(Link::NotRunning);
                    self.next_contact = Some(Instant::now() + self.config.discovery_interval);
                    return;
                }
                Found::Endpoint(endpoint) => {
                    self.client = Some(Arc::new(DriveClient::new(&endpoint)));
                    self.asked = false;
                }
            }
        }
        self.refresh_status();
    }

    fn refresh_status(&mut self) {
        let Some(client) = self.client.clone() else {
            return;
        };
        let slot = Some(&self.shared.worker_slot);
        let mut status = match client.status(slot) {
            Ok(status) => status,
            Err(error) => return self.failed(error),
        };
        if status.wants_request() && !self.asked {
            match client.request_folder(slot) {
                Ok(state) => {
                    self.asked = true;
                    status.notes = state;
                }
                Err(error) => return self.failed(error),
            }
        }
        self.set_link(Link::Running(status));
        self.ensure_events(&client);
    }

    /// A request failed. Unproven or refused: Drive counts as not running until it proves itself
    /// again. Busy (also a proven `503 busy`) or cut off: the last state stays and the request is
    /// tried again.
    fn failed(&mut self, error: DriveError) {
        if self.stopped() {
            return;
        }
        let transient = error.is_transient();
        self.stop_events();
        self.client = None;
        if transient {
            self.retry_later();
            return;
        }
        if self.link != Link::NotRunning && !matches!(error, DriveError::NotRunning) {
            eprintln!("hangar-note: Hangar Drive: {error}");
        }
        self.disconnect(Link::NotRunning);
        if matches!(error, DriveError::NotRunning) {
            self.next_contact = Some(Instant::now() + self.config.discovery_interval);
        } else {
            self.retry_later();
        }
    }

    fn disconnect(&mut self, link: Link) {
        self.stop_events();
        self.client = None;
        self.asked = false;
        self.set_link(link);
    }

    fn set_link(&mut self, link: Link) {
        let was_active = self.active();
        self.link = link;
        if self.active() {
            // A long poll that starts now answers `reset` at once and so asks for every note;
            // only one already running needs the full round from here.
            if !was_active && self.events.is_some() {
                self.pending.all = true;
                self.pending.now(Instant::now());
            }
        } else {
            self.marks.clear_marks();
            self.pending = Pending::default();
        }
        self.publish();
    }

    fn publish(&self) {
        let view = DriveSyncView::of(phase_of(&self.link), &self.marks);
        let mut current = lock(&self.shared.view);
        if *current != view {
            *current = view.clone();
            drop(current);
            self.sink.changed(&view);
        }
    }

    fn ensure_events(&mut self, client: &Arc<DriveClient>) {
        if self.events.is_some() || self.stopped() {
            return;
        }
        self.generation += 1;
        let generation = self.generation;
        let slot = Arc::new(StreamSlot::default());
        *lock(&self.shared.events_slot) = Some(slot.clone());
        let client = client.clone();
        let sender = self.sender.clone();
        let shared = self.shared.clone();
        let wait_ms = self.config.wait_ms;
        let thread_slot = slot.clone();
        let started = thread::Builder::new()
            .name("drive-events".into())
            .spawn(move || {
                let mut cursor: Option<String> = None;
                let mut resets: u32 = 0;
                loop {
                    if shared.stop.load(Ordering::SeqCst) {
                        return;
                    }
                    let started = Instant::now();
                    let result = client.events(cursor.as_deref(), wait_ms, Some(&thread_slot));
                    let failed = match &result {
                        Ok(events) => {
                            cursor = events.cursor.clone();
                            resets = if events.reset {
                                resets.saturating_add(1)
                            } else {
                                0
                            };
                            false
                        }
                        Err(_) => true,
                    };
                    if sender.send(Msg::Events { generation, result }).is_err() || failed {
                        return;
                    }
                    let until = started + events_round(resets);
                    while Instant::now() < until {
                        if shared.stop.load(Ordering::SeqCst) || thread_slot.cancelled() {
                            return;
                        }
                        thread::sleep(
                            PAUSE_STEP.min(until.saturating_duration_since(Instant::now())),
                        );
                    }
                }
            });
        match started {
            Ok(handle) => {
                self.events = Some(EventsRun {
                    generation,
                    slot,
                    handle,
                });
            }
            Err(error) => {
                eprintln!("hangar-note: Hangar Drive events not started: {error}");
                self.retry_later();
            }
        }
    }

    fn stop_events(&mut self) {
        if let Some(run) = self.events.take() {
            run.slot.cancel();
            let _ = run.handle.join();
        }
    }

    /// The active notes of every scope or of one, by contract path; notes whose file name breaks
    /// the path rule or is no `.md` are left out.
    fn list(&self, scope: Option<&str>) -> BTreeMap<String, NoteRef> {
        self.source
            .note_files(scope)
            .into_iter()
            .filter(|note| is_markdown(&note.file))
            .filter_map(|note| {
                let path = paths::note_path(&note.scope, &note.file)?;
                Some((
                    path,
                    NoteRef {
                        scope: note.scope,
                        id: note.id,
                    },
                ))
            })
            .collect()
    }

    /// The version of the note at `path` (`notes::content_version`), read only when its file
    /// state changed; `None` for a missing, linked or too large file.
    fn version_of(&mut self, path: &str) -> Option<String> {
        let (scope, file) = path.split_once('/')?;
        let full = self.source.root().join(scope).join(file);
        let meta = std::fs::symlink_metadata(&full).ok()?;
        if !meta.is_file() {
            self.hashes.remove(path);
            return None;
        }
        let state = stat_version(&meta);
        if let Some((known, version)) = self.hashes.get(path) {
            if *known == state {
                return Some(version.clone());
            }
        }
        let bytes = read_capped(&full, MAX_NOTE_BYTES).ok()??;
        let version = content_version(&bytes);
        self.hashes
            .insert(path.to_owned(), (state, version.clone()));
        Some(version)
    }

    /// One `items/status` round over the collected work, in batches of at most [`MAX_ITEMS`].
    fn query(&mut self) {
        let pending = std::mem::take(&mut self.pending);
        let Some(client) = self.client.clone() else {
            return;
        };
        let mut targets: BTreeSet<String> = BTreeSet::new();
        if pending.all {
            let notes = self.list(None);
            targets.extend(notes.keys().cloned());
            self.marks.replace_all(notes);
        } else {
            let mut scopes = pending.scopes;
            for path in pending.paths {
                if self.marks.note(&path).is_some() {
                    targets.insert(path);
                } else if let Some(scope) = paths::scope_of(&path) {
                    // A note this side does not know yet: its scope is listed again.
                    scopes.insert(scope.to_owned());
                }
            }
            for scope in scopes {
                let notes = self.list(Some(&scope));
                targets.extend(notes.keys().cloned());
                self.marks.replace_scope(&scope, notes);
            }
        }
        let marks = &self.marks;
        self.hashes.retain(|path, _| marks.note(path).is_some());

        let mut items = Vec::new();
        for path in targets {
            if self.stopped() {
                return;
            }
            match self.version_of(&path) {
                Some(sha256) => items.push(ItemQuery { path, sha256 }),
                None => self.marks.set(&path, false),
            }
        }
        self.publish();
        for (index, chunk) in items.chunks(MAX_ITEMS).enumerate() {
            if self.stopped() {
                return;
            }
            match client.items_status(chunk, Some(&self.shared.worker_slot)) {
                Ok(answers) => {
                    let answers: HashMap<String, bool> = answers.into_iter().collect();
                    for item in chunk {
                        let synced = answers.get(&item.path).copied().unwrap_or(false);
                        self.marks.set(&item.path, synced);
                    }
                    self.publish();
                }
                Err(error) if error.is_not_active() => {
                    // The status changed under the request; the next activation asks for all.
                    self.refresh_status();
                    return;
                }
                Err(error) => {
                    if error.is_transient() {
                        // Keep what is left for the next round.
                        let rest = items[index * MAX_ITEMS..].iter().map(|i| i.path.clone());
                        self.pending.paths.extend(rest);
                        self.pending.first.get_or_insert(Instant::now());
                        self.pending.due = Some(Instant::now() + self.backoff);
                        self.backoff = (self.backoff * 2).min(self.config.backoff_max);
                    } else {
                        self.failed(error);
                    }
                    return;
                }
            }
        }
    }
}

enum OwnChange {
    Note(String),
    Scope(String),
}

fn is_markdown(file: &str) -> bool {
    Path::new(file)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_last_at_least_the_minimum_and_resets_in_a_row_slow_down() {
        assert_eq!(events_round(0), MIN_EVENTS_ROUND);
        assert_eq!(events_round(1), MIN_EVENTS_ROUND);
        assert_eq!(events_round(2), MIN_EVENTS_ROUND * 2);
        assert_eq!(events_round(3), MIN_EVENTS_ROUND * 4);
        assert_eq!(events_round(10), MAX_RESET_PAUSE);
        assert_eq!(events_round(u32::MAX), MAX_RESET_PAUSE);
    }
}
