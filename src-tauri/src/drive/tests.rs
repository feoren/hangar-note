//! The client against a fake Hangar Drive on 127.0.0.1 (a real `TcpStream`), with the HTTP subset
//! and proof of "drive-local 1": the whole flow, a wrong proof, unknown fields, invalid paths in
//! answers, `reset`, batches of 256, own changes and a quick stop.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::io::{BufReader, Write as _};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::client::DRIVE_KEY_LABEL;
use super::discovery::{ENDPOINT_FILE, INSTALL_FILE};
use super::state::Phase;
use super::{Config, DriveSync, DriveSyncView, NoteSource, ViewSink};
use crate::channel::http::{read_body, read_head, response, Status};
use crate::channel::proof;
use crate::notes::{content_version, NoteFile};
use crate::test_support::TempDir;

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER_TOKEN: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const KEY: &str = "3f2a9c0e5b7d41e8a6c4f0b2d9e1a7c3";

// ---- Fake Drive -------------------------------------------------------------------------------

struct FakeState {
    account: String,
    notes: String,
    /// The state `folders/request` moves to; it answers `requested` and queues a status event.
    after_request: String,
    /// The token the proofs are made with; another one makes every proof wrong.
    proof_token: String,
    synced: BTreeSet<String>,
    /// Appended to every `items/status` answer.
    extra_items: Vec<Value>,
    events: VecDeque<Value>,
    cursor: u64,
    /// Every `events` call answers `reset` at once with a cursor longer than the contract allows.
    always_reset: bool,
}

struct FakeDrive {
    port: u16,
    state: Arc<Mutex<FakeState>>,
    /// Every request after a proven hello: its path and body.
    log: Arc<Mutex<Vec<(String, Value)>>>,
    stop: Arc<AtomicBool>,
    accept: Option<JoinHandle<()>>,
}

impl FakeDrive {
    fn start(state: FakeState) -> Self {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = Arc::new(Mutex::new(state));
        let log = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (s, l, st) = (state.clone(), log.clone(), stop.clone());
        let accept = thread::spawn(move || {
            for stream in listener.incoming() {
                if st.load(Ordering::SeqCst) {
                    return;
                }
                let Ok(stream) = stream else { continue };
                let (s, l, st) = (s.clone(), l.clone(), st.clone());
                thread::spawn(move || serve(stream, port, &s, &l, &st));
            }
        });
        Self {
            port,
            state,
            log,
            stop,
            accept: Some(accept),
        }
    }

    fn requests(&self, path: &str) -> Vec<Value> {
        self.log
            .lock()
            .unwrap()
            .iter()
            .filter(|(p, _)| p == path)
            .map(|(_, body)| body.clone())
            .collect()
    }

    fn all_requests(&self) -> usize {
        self.log.lock().unwrap().len()
    }

    fn push_event(&self, event: Value) {
        self.state.lock().unwrap().events.push_back(event);
    }
}

impl Drop for FakeDrive {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect((Ipv4Addr::LOCALHOST, self.port));
        if let Some(accept) = self.accept.take() {
            let _ = accept.join();
        }
    }
}

fn state(notes: &str) -> FakeState {
    FakeState {
        account: "ready".into(),
        notes: notes.into(),
        after_request: "active".into(),
        proof_token: TOKEN.into(),
        synced: BTreeSet::new(),
        extra_items: Vec::new(),
        events: VecDeque::new(),
        cursor: 0,
        always_reset: false,
    }
}

fn answer(
    stream: &mut TcpStream,
    proof_token: &str,
    nonce: &str,
    path: &str,
    status: Status,
    body: &str,
    keep_alive: bool,
) {
    let key = proof::key_with_label(DRIVE_KEY_LABEL, proof_token);
    let proven = proof::proof(&key, nonce, path, status.code(), body.as_bytes());
    let _ = stream.write_all(&response(status, body, Some(&proven), keep_alive));
}

/// One connection: the hello, then one request.
fn serve(
    mut stream: TcpStream,
    port: u16,
    state: &Mutex<FakeState>,
    log: &Mutex<Vec<(String, Value)>>,
    stop: &AtomicBool,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let Ok(hello) = read_head(&mut reader) else {
        return;
    };
    assert_eq!(hello.path, "/v1/hello");
    assert!(hello.token.is_none(), "the token went out with the hello");
    assert_eq!(
        hello.host.as_deref(),
        Some(format!("127.0.0.1:{port}").as_str())
    );
    assert!(hello.json);
    let nonce = hello.nonce.clone().unwrap_or_default();
    assert!(proof::is_hex64(&nonce));
    let _ = read_body(&mut reader, hello.content_length, 0);
    let proof_token = state.lock().unwrap().proof_token.clone();
    answer(
        &mut stream,
        &proof_token,
        &nonce,
        "/v1/hello",
        Status::Ok,
        r#"{"version":1,"future":"ignored"}"#,
        true,
    );

    let Ok(head) = read_head(&mut reader) else {
        return;
    };
    assert!(head.close, "the request must close the connection");
    let nonce = head.nonce.clone().unwrap_or_default();
    let Ok(body) = read_body(&mut reader, head.content_length, 512 * 1024) else {
        return;
    };
    if head.token.as_deref().map(String::as_str) != Some(TOKEN) {
        let error = r#"{"version":1,"error":"unauthorized"}"#;
        answer(
            &mut stream,
            &proof_token,
            &nonce,
            &head.path,
            Status::Unauthorized,
            error,
            false,
        );
        return;
    }
    let request: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(request["version"], 1);
    log.lock()
        .unwrap()
        .push((head.path.clone(), request.clone()));
    let (status, reply) = route(&head.path, &request, state, stop);
    answer(
        &mut stream,
        &proof_token,
        &nonce,
        &head.path,
        status,
        &reply,
        false,
    );
}

fn route(
    path: &str,
    request: &Value,
    state: &Mutex<FakeState>,
    stop: &AtomicBool,
) -> (Status, String) {
    match path {
        "/v1/status" => {
            let s = state.lock().unwrap();
            let mut notes = json!({ "state": s.notes, "unknownNoteField": [1, 2] });
            if s.notes == "active" {
                notes["folderName"] = json!("Hangar Note");
                notes["lastSyncMs"] = json!(1_764_240_000_000u64);
            }
            if s.notes == "waitingForFolder" {
                notes["reason"] = json!("somethingNew");
            }
            let body = json!({
                "version": 1,
                "appVersion": "0.1.0-412",
                "account": s.account,
                "connection": "online",
                "paused": false,
                "notes": notes,
                "future": { "nested": true },
            });
            (Status::Ok, body.to_string())
        }
        "/v1/folders/request" => {
            assert_eq!(request["profile"], "hangar-note-1");
            let mut s = state.lock().unwrap();
            s.notes = s.after_request.clone();
            s.events.push_back(json!({ "kind": "status" }));
            (
                Status::Ok,
                json!({ "version": 1, "state": "requested" }).to_string(),
            )
        }
        "/v1/items/status" => {
            let s = state.lock().unwrap();
            if s.notes != "active" {
                return (
                    Status::Conflict,
                    r#"{"version":1,"error":"not-active"}"#.into(),
                );
            }
            let items = request["items"].as_array().unwrap();
            assert!(items.len() <= 256, "{} items in one request", items.len());
            let mut out: Vec<Value> = items
                .iter()
                .map(|item| {
                    let path = item["path"].as_str().unwrap();
                    if s.synced.contains(path) {
                        json!({ "path": path, "state": "synced", "extra": "x" })
                    } else {
                        json!({ "path": path, "state": "pending", "direction": "up" })
                    }
                })
                .collect();
            out.extend(s.extra_items.iter().cloned());
            (
                Status::Ok,
                json!({ "version": 1, "items": out, "future": 1 }).to_string(),
            )
        }
        "/v1/events" => {
            let wait = request["waitMs"].as_u64().unwrap_or(0);
            if state.lock().unwrap().always_reset {
                let cursor = "c".repeat(65);
                return (
                    Status::Ok,
                    json!({ "version": 1, "cursor": cursor, "events": [{ "kind": "reset" }] })
                        .to_string(),
                );
            }
            if request["cursor"].is_null() {
                let mut s = state.lock().unwrap();
                s.cursor += 1;
                let cursor = format!("c-{}", s.cursor);
                return (
                    Status::Ok,
                    json!({ "version": 1, "cursor": cursor, "events": [{ "kind": "reset" }] })
                        .to_string(),
                );
            }
            let deadline = Instant::now() + Duration::from_millis(wait);
            loop {
                {
                    let mut s = state.lock().unwrap();
                    if let Some(event) = s.events.pop_front() {
                        s.cursor += 1;
                        let cursor = format!("c-{}", s.cursor);
                        let body = json!({
                            "version": 1,
                            "cursor": cursor,
                            "events": [event, { "kind": "fromTheFuture" }],
                        });
                        return (Status::Ok, body.to_string());
                    }
                }
                if Instant::now() >= deadline || stop.load(Ordering::SeqCst) {
                    let cursor = request["cursor"].as_str().unwrap_or("c-0").to_owned();
                    return (
                        Status::Ok,
                        json!({ "version": 1, "cursor": cursor, "events": [] }).to_string(),
                    );
                }
                thread::sleep(Duration::from_millis(10));
            }
        }
        _ => (
            Status::NotFound,
            r#"{"version":1,"error":"unknown-route"}"#.into(),
        ),
    }
}

// ---- The app side -----------------------------------------------------------------------------

struct FakeSource {
    root: PathBuf,
    notes: Mutex<Vec<NoteFile>>,
}

impl NoteSource for FakeSource {
    fn root(&self) -> &Path {
        &self.root
    }

    fn note_files(&self, scope: Option<&str>) -> Vec<NoteFile> {
        self.notes
            .lock()
            .unwrap()
            .iter()
            .filter(|note| scope.is_none_or(|scope| note.scope == scope))
            .cloned()
            .collect()
    }
}

impl FakeSource {
    fn add(&self, scope: &str, id: &str, file: &str, text: &str) {
        let dir = self.root.join(scope);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(file), text).unwrap();
        self.notes.lock().unwrap().push(NoteFile {
            scope: scope.into(),
            id: id.into(),
            file: file.into(),
        });
    }
}

#[derive(Default)]
struct Recorder(Mutex<Vec<DriveSyncView>>);

impl ViewSink for Recorder {
    fn changed(&self, view: &DriveSyncView) {
        self.0.lock().unwrap().push(view.clone());
    }
}

struct Setup {
    _dir: TempDir,
    drive_dir: PathBuf,
    source: Arc<FakeSource>,
    recorder: Arc<Recorder>,
}

fn setup(name: &str) -> Setup {
    let dir = TempDir::new(name);
    let drive_dir = dir.path().join("drive");
    fs::create_dir_all(&drive_dir).unwrap();
    let source = Arc::new(FakeSource {
        root: dir.path().join("notes"),
        notes: Mutex::default(),
    });
    fs::create_dir_all(&source.root).unwrap();
    Setup {
        _dir: dir,
        drive_dir,
        source,
        recorder: Arc::default(),
    }
}

fn install(drive_dir: &Path) {
    fs::write(
        drive_dir.join(INSTALL_FILE),
        r#"{"version":1,"contracts":{"drive-local":[1]},"exe":"x","appVersion":"0.1.0-1"}"#,
    )
    .unwrap();
}

fn endpoint(drive_dir: &Path, port: u16) {
    fs::write(
        drive_dir.join(ENDPOINT_FILE),
        format!(r#"{{"version":1,"port":{port},"pid":1,"token":"{TOKEN}","later":1}}"#),
    )
    .unwrap();
}

fn config(drive_dir: &Path) -> Config {
    Config {
        drive_dir: drive_dir.to_path_buf(),
        discovery_interval: Duration::from_millis(50),
        debounce: Duration::from_millis(20),
        max_debounce: Duration::from_millis(100),
        backoff_min: Duration::from_millis(20),
        backoff_max: Duration::from_millis(200),
        wait_ms: 200,
    }
}

fn start(setup: &Setup) -> DriveSync {
    DriveSync::start(
        config(&setup.drive_dir),
        setup.source.clone(),
        setup.recorder.clone(),
    )
}

fn wait_for(what: &str, condition: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        thread::sleep(Duration::from_millis(10));
    }
}

fn synced(pairs: &[(&str, &[&str])]) -> BTreeMap<String, Vec<String>> {
    pairs
        .iter()
        .map(|(scope, ids)| {
            (
                (*scope).to_owned(),
                ids.iter().map(|id| (*id).to_owned()).collect(),
            )
        })
        .collect()
}

/// The items of every `items/status` request, flattened: path to sha256.
fn asked_items(drive: &FakeDrive) -> Vec<(String, String)> {
    drive
        .requests("/v1/items/status")
        .iter()
        .flat_map(|body| body["items"].as_array().cloned().unwrap_or_default())
        .map(|item| {
            (
                item["path"].as_str().unwrap().to_owned(),
                item["sha256"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

// ---- Tests ------------------------------------------------------------------------------------

#[test]
fn a_running_drive_is_asked_once_and_synced_notes_are_marked() {
    let s = setup("drive-flow");
    s.source.add("general", "id-a", "A.md", "marker-a-1");
    s.source.add("general", "id-b", "B.md", "marker-b-1");
    s.source.add(KEY, "id-c", "C.md", "marker-c-1");
    let mut fake = state("none");
    fake.synced = BTreeSet::from(["general/A.md".to_owned(), format!("{KEY}/C.md")]);
    // Entries Hangar Note never asked for, or that break the path rule, are dropped.
    fake.extra_items = vec![
        json!({ "path": "general/B.md/../B.md", "state": "synced" }),
        json!({ "path": "general\\B.md", "state": "synced" }),
        json!({ "path": "/general/B.md", "state": "synced" }),
        json!({ "path": "general/Unknown.md", "state": "synced" }),
        json!({ "state": "synced" }),
    ];
    let drive = FakeDrive::start(fake);
    install(&s.drive_dir);
    endpoint(&s.drive_dir, drive.port);

    let sync = start(&s);
    wait_for("the marks", || sync.view().synced.len() == 2);
    let view = sync.view();
    assert_eq!(view.phase, Phase::Active);
    assert_eq!(view.folder_name.as_deref(), Some("Hangar Note"));
    assert_eq!(view.last_sync_ms, Some(1_764_240_000_000));
    assert_eq!(
        view.synced,
        synced(&[("general", &["id-a"]), (KEY, &["id-c"])])
    );

    // Asked exactly once, with the profile.
    let requests = drive.requests("/v1/folders/request");
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0],
        json!({ "version": 1, "profile": "hangar-note-1" })
    );
    // Every active note with its version, the SHA-256 of its bytes.
    let asked: BTreeMap<String, String> = asked_items(&drive).into_iter().collect();
    assert_eq!(
        asked,
        BTreeMap::from([
            ("general/A.md".to_owned(), content_version(b"marker-a-1")),
            ("general/B.md".to_owned(), content_version(b"marker-b-1")),
            (format!("{KEY}/C.md"), content_version(b"marker-c-1")),
        ])
    );
    // The first events call starts from `null`.
    let events = drive.requests("/v1/events");
    assert!(events[0]["cursor"].is_null());
    assert_eq!(events[0]["waitMs"], 200);

    // The windows heard about every change, and the last one is the view.
    let heard = s.recorder.0.lock().unwrap().clone();
    assert_eq!(heard.last(), Some(&view));
    assert!(heard.iter().any(|v| v.phase == Phase::Asked));
    for pair in heard.windows(2) {
        assert_ne!(pair[0], pair[1], "a view was sent twice");
    }
    sync.stop();
}

#[test]
fn a_wrong_proof_means_drive_is_not_running_and_gets_no_token() {
    let s = setup("drive-wrong-proof");
    s.source.add("general", "id-a", "A.md", "marker-a-2");
    let mut fake = state("active");
    fake.proof_token = OTHER_TOKEN.into();
    let drive = FakeDrive::start(fake);
    install(&s.drive_dir);
    endpoint(&s.drive_dir, drive.port);

    let sync = start(&s);
    wait_for("notRunning", || sync.view().phase == Phase::NotRunning);
    thread::sleep(Duration::from_millis(200));
    assert_eq!(sync.view().phase, Phase::NotRunning);
    // Only hellos went out: no request with the token ever reached the program.
    assert_eq!(drive.all_requests(), 0);
    sync.stop();
}

#[test]
fn installed_without_endpoint_is_not_running_and_without_install_absent() {
    let s = setup("drive-discovery-flow");
    let sync = start(&s);
    thread::sleep(Duration::from_millis(150));
    assert_eq!(sync.view().phase, Phase::Absent);
    install(&s.drive_dir);
    wait_for("notRunning", || sync.view().phase == Phase::NotRunning);
    // A port nobody listens on: still not running.
    let unused = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = unused.local_addr().unwrap().port();
    drop(unused);
    endpoint(&s.drive_dir, port);
    thread::sleep(Duration::from_millis(200));
    assert_eq!(sync.view().phase, Phase::NotRunning);
    // Drive starts: the next look finds it.
    let drive = FakeDrive::start(state("declined"));
    endpoint(&s.drive_dir, drive.port);
    wait_for("declined", || sync.view().phase == Phase::Declined);
    assert!(drive.requests("/v1/folders/request").is_empty());
    assert!(drive.requests("/v1/items/status").is_empty());
    sync.stop();
}

#[test]
fn unknown_reasons_show_like_none() {
    let s = setup("drive-unknown-reason");
    let drive = FakeDrive::start(state("waitingForFolder"));
    install(&s.drive_dir);
    endpoint(&s.drive_dir, drive.port);
    let sync = start(&s);
    wait_for("waiting", || sync.view().phase == Phase::Waiting);
    assert_eq!(sync.view().reason, None);
    sync.stop();
}

#[test]
fn a_reset_asks_for_every_note_and_items_for_those_paths() {
    let s = setup("drive-reset");
    s.source.add("general", "id-a", "A.md", "marker-a-3");
    s.source.add("general", "id-b", "B.md", "marker-b-3");
    let drive = FakeDrive::start(state("active"));
    install(&s.drive_dir);
    endpoint(&s.drive_dir, drive.port);
    let sync = start(&s);
    wait_for("the first round", || asked_items(&drive).len() == 2);

    // `items` with one path, plus an invalid one that is dropped.
    drive
        .state
        .lock()
        .unwrap()
        .synced
        .insert("general/B.md".into());
    drive.push_event(json!({ "kind": "items", "paths": ["general/B.md", "../B.md"] }));
    wait_for("the items round", || asked_items(&drive).len() == 3);
    assert_eq!(asked_items(&drive)[2].0, "general/B.md");
    wait_for("the mark of B", || {
        sync.view().synced == synced(&[("general", &["id-b"])])
    });

    // `reset`: every note again.
    drive
        .state
        .lock()
        .unwrap()
        .synced
        .insert("general/A.md".into());
    drive.push_event(json!({ "kind": "reset" }));
    wait_for("the full round", || asked_items(&drive).len() == 5);
    let last: BTreeSet<String> = asked_items(&drive)[3..]
        .iter()
        .map(|(path, _)| path.clone())
        .collect();
    assert_eq!(
        last,
        BTreeSet::from(["general/A.md".to_owned(), "general/B.md".to_owned()])
    );
    wait_for("both marks", || {
        sync.view().synced == synced(&[("general", &["id-a", "id-b"])])
    });
    sync.stop();
}

#[test]
fn many_notes_are_asked_for_in_batches_of_256() {
    let s = setup("drive-batches");
    for i in 0..600 {
        s.source.add(
            "general",
            &format!("id-{i:03}"),
            &format!("N{i:03}.md"),
            &format!("marker-{i}"),
        );
    }
    let drive = FakeDrive::start(state("active"));
    install(&s.drive_dir);
    endpoint(&s.drive_dir, drive.port);
    let sync = start(&s);
    wait_for("three batches", || {
        drive.requests("/v1/items/status").len() >= 3
    });
    let sizes: Vec<usize> = drive
        .requests("/v1/items/status")
        .iter()
        .map(|body| body["items"].as_array().unwrap().len())
        .collect();
    assert_eq!(&sizes[..3], &[256, 256, 88]);
    let paths: BTreeSet<String> = asked_items(&drive).into_iter().map(|(p, _)| p).collect();
    assert_eq!(paths.len(), 600);
    sync.stop();
}

#[test]
fn an_own_save_asks_for_that_note_with_its_new_version() {
    let s = setup("drive-own-save");
    s.source.add("general", "id-a", "A.md", "marker-a-4");
    s.source.add("general", "id-b", "B.md", "marker-b-4");
    let drive = FakeDrive::start(state("active"));
    install(&s.drive_dir);
    endpoint(&s.drive_dir, drive.port);
    let sync = start(&s);
    wait_for("the first round", || asked_items(&drive).len() == 2);

    let observer = sync.own_writes_observer().unwrap();
    let file = s.source.root.join("general").join("A.md");
    fs::write(&file, "marker-a-4 changed").unwrap();
    observer(&file);
    // A file outside the notes layout changes nothing.
    observer(&s.source.root.join(".hangar-drive").join("x"));
    wait_for("the save round", || asked_items(&drive).len() == 3);
    assert_eq!(
        asked_items(&drive)[2],
        (
            "general/A.md".to_owned(),
            content_version(b"marker-a-4 changed")
        )
    );

    // A new note: the index changed, the scope is listed again and the new note is asked for.
    s.source.add("general", "id-n", "New.md", "marker-new");
    observer(&s.source.root.join("general").join("folder.json"));
    wait_for("the scope round", || {
        asked_items(&drive)
            .iter()
            .any(|(path, _)| path == "general/New.md")
    });
    sync.stop();
}

#[test]
fn stopping_cuts_the_long_poll_short() {
    let s = setup("drive-stop");
    let drive = FakeDrive::start(state("declined"));
    install(&s.drive_dir);
    endpoint(&s.drive_dir, drive.port);
    let mut cfg = config(&s.drive_dir);
    cfg.wait_ms = 25_000;
    let sync = DriveSync::start(cfg, s.source.clone(), s.recorder.clone());
    wait_for("declined", || sync.view().phase == Phase::Declined);
    wait_for("a waiting poll", || drive.requests("/v1/events").len() >= 2);
    let started = Instant::now();
    sync.stop();
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "stop took {:?}",
        started.elapsed()
    );
}

#[test]
fn a_disabled_sync_stays_absent() {
    let sync = DriveSync::disabled();
    assert_eq!(sync.view(), DriveSyncView::absent());
    assert!(sync.own_writes_observer().is_none());
    sync.scopes_changed(&BTreeSet::from(["general".to_owned()]));
    sync.stop();
}

/// Drive's marker folder `.hangar-drive` at the notes root is no scope (ADR 0005, amendment of
/// 2026-11-28): the store's listing skips it, and only active notes, never the trash, reach the
/// per note status.
#[test]
fn the_store_lists_active_notes_and_skips_drives_marker_folder() {
    use crate::notes::{scope_keys, NoteFolder, NotesStore};
    use std::sync::atomic::AtomicBool;

    let dir = TempDir::new("drive-store-source");
    let root = dir.path().join("notes");
    fs::create_dir_all(root.join(".hangar-drive")).unwrap();
    fs::write(root.join(".hangar-drive").join("root.json"), "{}").unwrap();
    let store = NotesStore::new(&root, Arc::new(AtomicBool::new(true)));
    let kept = store.create_note(&NoteFolder::general(), "Kept").unwrap();
    let gone = store.create_note(&NoteFolder::general(), "Gone").unwrap();
    store.delete_note(&NoteFolder::general(), &gone).unwrap();

    assert_eq!(scope_keys(&root).unwrap(), vec!["general".to_owned()]);
    let source: &dyn NoteSource = &store;
    let files = source.note_files(None);
    assert_eq!(files.len(), 1, "{files:?}");
    assert_eq!(files[0].scope, "general");
    assert_eq!(files[0].id, kept);
    assert_eq!(files[0].file, "Kept.md");
    assert_eq!(source.note_files(Some("general")), files);
    assert!(source.note_files(Some(".hangar-drive")).is_empty());
    assert!(source.note_files(Some(KEY)).is_empty());
}

/// Security review N1: a Drive that answers every `events` call at once with `reset` and a cursor
/// that never validates (so every next call starts from `null` again) does not make the long poll
/// or the full rounds spin.
#[test]
fn a_drive_that_always_resets_is_slowed_down() {
    let s = setup("drive-reset-storm");
    s.source.add("general", "id-a", "A.md", "marker-a-5");
    let mut fake = state("active");
    fake.always_reset = true;
    let drive = FakeDrive::start(fake);
    install(&s.drive_dir);
    endpoint(&s.drive_dir, drive.port);
    let sync = start(&s);
    wait_for("the first round", || !asked_items(&drive).is_empty());
    thread::sleep(Duration::from_millis(1600));
    let polls = drive.requests("/v1/events").len();
    let rounds = drive.requests("/v1/items/status").len();
    sync.stop();
    // 250 ms, then 500 ms, then 1 s between the calls: three or four in this time, never hundreds.
    assert!((2..=5).contains(&polls), "{polls} events calls");
    assert!(rounds <= polls, "{rounds} rounds for {polls} polls");
}

// ---- One scripted exchange --------------------------------------------------------------------

/// A server for one connection: it answers the hello correctly, reads the real request, and lets
/// `respond` write whatever it likes as the answer.
fn scripted(
    respond: impl FnOnce(&mut TcpStream, &str, &str) + Send + 'static,
) -> (u16, JoinHandle<()>) {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let hello = read_head(&mut reader).unwrap();
        let nonce = hello.nonce.clone().unwrap();
        answer(
            &mut stream,
            TOKEN,
            &nonce,
            "/v1/hello",
            Status::Ok,
            r#"{"version":1}"#,
            true,
        );
        let Ok(head) = read_head(&mut reader) else {
            return;
        };
        let _ = read_body(&mut reader, head.content_length, 1 << 20);
        let nonce = head.nonce.clone().unwrap();
        respond(&mut stream, &nonce, &head.path);
    });
    (port, handle)
}

fn scripted_client(port: u16) -> super::client::DriveClient {
    super::client::DriveClient::new(&super::discovery::Endpoint {
        port,
        token: zeroize::Zeroizing::new(TOKEN.to_owned()),
    })
}

fn one_item() -> Vec<super::client::ItemQuery> {
    vec![super::client::ItemQuery {
        path: "general/A.md".into(),
        sha256: content_version(b"x"),
    }]
}

/// An error answer counts only with a valid proof: `409 not-active` without a proof, or with one
/// made from another token, is not confirmed, never a refusal the worker would act on.
#[test]
fn an_unproven_error_answer_is_unconfirmed_not_refused() {
    use super::client::DriveError;
    let body = r#"{"version":1,"error":"not-active"}"#;
    let (port, server) = scripted(move |stream, _, _| {
        let _ = stream.write_all(&response(Status::Conflict, body, None, false));
    });
    let error = scripted_client(port)
        .items_status(&one_item(), None)
        .unwrap_err();
    assert!(matches!(error, DriveError::Unconfirmed), "{error:?}");
    server.join().unwrap();

    let (port, server) = scripted(move |stream, nonce, path| {
        answer(
            stream,
            OTHER_TOKEN,
            nonce,
            path,
            Status::Conflict,
            body,
            false,
        );
    });
    let error = scripted_client(port)
        .items_status(&one_item(), None)
        .unwrap_err();
    assert!(matches!(error, DriveError::Unconfirmed), "{error:?}");
    server.join().unwrap();

    // Proven, the same answer is the refusal it says.
    let (port, server) = scripted(move |stream, nonce, path| {
        answer(stream, TOKEN, nonce, path, Status::Conflict, body, false);
    });
    let error = scripted_client(port)
        .items_status(&one_item(), None)
        .unwrap_err();
    assert!(error.is_not_active(), "{error:?}");
    server.join().unwrap();
}

/// A proof made for `/v1/status` never passes as the answer of `/v1/items/status`, even with the
/// right nonce, status and body.
#[test]
fn a_proof_for_another_route_fails() {
    use super::client::DriveError;
    let (port, server) = scripted(move |stream, nonce, path| {
        assert_eq!(path, "/v1/items/status");
        let body = r#"{"version":1,"items":[{"path":"general/A.md","state":"synced"}]}"#;
        answer(stream, TOKEN, nonce, "/v1/status", Status::Ok, body, false);
    });
    let error = scripted_client(port)
        .items_status(&one_item(), None)
        .unwrap_err();
    assert!(matches!(error, DriveError::Unconfirmed), "{error:?}");
    server.join().unwrap();
}

/// Security review N2: an answer that trickles in, one byte every 100 ms, ends after the total
/// time of the request, not after the time of one read.
#[test]
fn a_trickling_answer_ends_after_the_total_time() {
    use crate::channel::{exchange, ExchangeError, Peer, StreamSlot};
    let stop = Arc::new(AtomicBool::new(false));
    let trickle_stop = stop.clone();
    let (port, server) = scripted(move |stream, nonce, path| {
        let body = format!(r#"{{"version":1}}{}"#, " ".repeat(200));
        let key = proof::key_with_label(DRIVE_KEY_LABEL, TOKEN);
        let proven = proof::proof(&key, nonce, path, 200, body.as_bytes());
        for byte in response(Status::Ok, &body, Some(&proven), false) {
            if trickle_stop.load(Ordering::SeqCst) || stream.write_all(&[byte]).is_err() {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
    });
    let key = proof::key_with_label(DRIVE_KEY_LABEL, TOKEN);
    let peer = Peer {
        port,
        token: TOKEN,
        key: &key,
    };
    let slot = StreamSlot::default();
    let started = Instant::now();
    let result = exchange(
        &peer,
        "/v1/status",
        b"{}",
        Duration::from_secs(1),
        Some(&slot),
    );
    let took = started.elapsed();
    stop.store(true, Ordering::SeqCst);
    assert!(
        matches!(result, Err(ExchangeError::Unconfirmed)),
        "{:?}",
        result.err()
    );
    assert!(took < Duration::from_secs(3), "took {took:?}");
    server.join().unwrap();
}

/// Quitting never waits for a program on Drive's port that takes the connection and never answers
/// the hello: the hello is cancellable like the answer.
#[test]
fn stopping_does_not_wait_for_a_silent_port_holder() {
    let s = setup("drive-silent-port");
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let accepted = Arc::new(AtomicBool::new(false));
    let seen = accepted.clone();
    let holder = thread::spawn(move || {
        // Holds the connection open and reads nothing back.
        let (stream, _) = listener.accept().unwrap();
        seen.store(true, Ordering::SeqCst);
        thread::sleep(Duration::from_secs(3));
        drop(stream);
    });
    install(&s.drive_dir);
    endpoint(&s.drive_dir, port);
    let sync = start(&s);
    wait_for("the connection", || accepted.load(Ordering::SeqCst));
    thread::sleep(Duration::from_millis(150));
    let started = Instant::now();
    sync.stop();
    let took = started.elapsed();
    assert!(took < Duration::from_secs(1), "stop took {took:?}");
    holder.join().unwrap();
}
