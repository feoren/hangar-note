//! The windows (ADR 0001). The backend creates and owns all of them; the frontend asks for them
//! through commands and never holds a permission to create or close arbitrary windows.
//!
//! - `hub`: "All notes", a normal window. Closing it hides it while the tray icon exists.
//! - `note-<id>`: one frameless window per open note. Closing it hides the note (it stays in the
//!   list); its place and size are remembered, debounced, and restored on the next start.
//!
//! Windows open hidden and show themselves once their view has rendered (`window_ready`), so no
//! empty white frame flashes up; a fallback shows them after a few seconds in any case.
//!
//! Whatever would end a note window (closing, deleting from "All notes", quitting) first lets the
//! note save what was just typed: only its view has that text (`replies`).

use std::collections::HashMap;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Serialize, Serializer};
use tauri::{
    AppHandle, Emitter as _, Manager as _, Runtime, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, Window, WindowEvent,
};

use crate::bounds::{self, Area};
use crate::replies::{self, DeleteStep, NoteReply, QuitMemory, QuitStep, Replies};
use crate::settings::{SettingsError, SettingsStore, Theme};
use crate::store::{normalize_id, Bounds, NoteMeta, Store, StoreError, TrashItem};

pub const HUB_LABEL: &str = "hub";
pub const NOTE_PREFIX: &str = "note-";
/// The one app URL; `src/main.tsx` picks the view by the window's label.
const APP_URL: &str = "index.html";
const TITLE: &str = "Hangar Note";
const HUB_WIDTH: f64 = 440.0;
const HUB_HEIGHT: f64 = 600.0;
const HUB_MIN_WIDTH: f64 = 340.0;
const HUB_MIN_HEIGHT: f64 = 400.0;
/// Quiet time after the last move or resize before the place is written.
pub const BOUNDS_DELAY: Duration = Duration::from_millis(500);
/// A window whose view never reported ready is shown after this anyway.
const SHOW_FALLBACK: Duration = Duration::from_secs(4);
/// How long quitting waits for the remembered places to be written.
const FLUSH_TIMEOUT: Duration = Duration::from_secs(2);
/// How long deleting and quitting wait for a note to save before going ahead without its answer.
pub const NOTE_REPLY_TIMEOUT: Duration = FLUSH_TIMEOUT;

/// To the hub, without payload: the list changed, reload it.
pub const NOTES_CHANGED_EVENT: &str = "notes-changed";
/// To every window, with the new settings.
pub const SETTINGS_CHANGED_EVENT: &str = "settings-changed";
/// To a note window: the system asked it to close (Alt+F4); it saves, then calls `close_note`.
pub const CLOSE_REQUESTED_EVENT: &str = "note-close-requested";
/// To a note window: "All notes" deletes it. It saves, then deletes itself (`delete_note`), or
/// reports the failed save (`note_flushed`).
pub const DELETE_REQUESTED_EVENT: &str = "note-delete-requested";
/// To every note window before quitting: save, then answer with `note_flushed`.
pub const FLUSH_REQUESTED_EVENT: &str = "note-flush-requested";
/// What the frontend receives for [`AppError::NotSaved`], so it can say what happened.
pub const NOT_SAVED_CODE: &str = "not-saved";

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("This window may not change that note")]
    NotAllowed,
    #[error("The open note could not save its text, so it was not deleted")]
    NotSaved,
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Settings(#[from] SettingsError),
    #[error("Start with the system: {0}")]
    Autostart(String),
    #[error("Window: {0}")]
    Tauri(#[from] tauri::Error),
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::NotSaved => serializer.serialize_str(NOT_SAVED_CODE),
            other => serializer.serialize_str(&other.to_string()),
        }
    }
}

/// The native theme of a window (title bar, scroll bars, the WebView's own menus) for the app's
/// theme setting; `None` follows the system.
pub fn native_theme(theme: Theme) -> Option<tauri::Theme> {
    match theme {
        Theme::System => None,
        Theme::Light => Some(tauri::Theme::Light),
        Theme::Dark => Some(tauri::Theme::Dark),
    }
}

fn current_theme<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::Theme> {
    app.try_state::<SettingsStore>()
        .and_then(|settings| native_theme(settings.get().theme))
}

/// Applies the theme setting to every open window. On Linux and macOS the theme is app-wide.
pub fn apply_theme<R: Runtime>(app: &AppHandle<R>, theme: Theme) {
    for window in app.webview_windows().values() {
        if let Err(error) = window.set_theme(native_theme(theme)) {
            eprintln!("hangar-note: window theme not changed: {error}");
        }
    }
}

pub fn note_label(id: &str) -> String {
    format!("{NOTE_PREFIX}{id}")
}

/// The note ID of a note window's label, `None` for any other window.
pub fn note_id_of(label: &str) -> Option<String> {
    let id = label.strip_prefix(NOTE_PREFIX)?;
    normalize_id(id).ok().filter(|normal| normal == id)
}

/// Whether the window `label` may act on note `id`: "All notes" on every note, a note window
/// only on its own note. A compromised note view thus cannot read or delete other notes.
pub fn may_touch(label: &str, id: &str) -> bool {
    if label == HUB_LABEL {
        return true;
    }
    match (note_id_of(label), normalize_id(id)) {
        (Some(own), Ok(id)) => own == id,
        _ => false,
    }
}

pub fn check_access(label: &str, id: &str) -> Result<(), AppError> {
    if may_touch(label, id) {
        Ok(())
    } else {
        Err(AppError::NotAllowed)
    }
}

/// Collects values per key and hands each out once it has been quiet for `delay`. Pure, so the
/// timing is testable with made-up instants.
#[derive(Debug)]
pub struct Debouncer<V> {
    delay: Duration,
    pending: HashMap<String, (V, Instant)>,
}

impl<V> Debouncer<V> {
    pub fn new(delay: Duration) -> Self {
        Self {
            delay,
            pending: HashMap::new(),
        }
    }

    /// Replaces the pending value of `key` and restarts its quiet time.
    pub fn push(&mut self, key: String, value: V, now: Instant) {
        self.pending.insert(key, (value, now));
    }

    /// The values quiet for at least `delay` at `now`, removed from the pending set.
    pub fn due(&mut self, now: Instant) -> Vec<(String, V)> {
        let ready: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, (_, at))| now.saturating_duration_since(*at) >= self.delay)
            .map(|(key, _)| key.clone())
            .collect();
        ready
            .into_iter()
            .filter_map(|key| self.pending.remove(&key).map(|(value, _)| (key, value)))
            .collect()
    }

    /// The pending value of `key` (or all, for `None`), whatever its quiet time.
    pub fn take(&mut self, key: Option<&str>) -> Vec<(String, V)> {
        match key {
            Some(key) => self
                .pending
                .remove_entry(key)
                .map(|(key, (value, _))| vec![(key, value)])
                .unwrap_or_default(),
            None => self
                .pending
                .drain()
                .map(|(key, (value, _))| (key, value))
                .collect(),
        }
    }

    /// When the next value becomes due.
    pub fn next_due(&self) -> Option<Instant> {
        self.pending.values().map(|(_, at)| *at + self.delay).min()
    }
}

enum BoundsMessage {
    Moved(String, Bounds),
    /// Write what is pending for one note (or all) now, then answer.
    Flush(Option<String>, mpsc::Sender<()>),
}

/// Writes the places of note windows on a thread of its own, [`BOUNDS_DELAY`] after the last
/// move: dragging a window sends dozens of events per second.
#[derive(Debug)]
pub struct BoundsSaver {
    sender: mpsc::Sender<BoundsMessage>,
}

impl BoundsSaver {
    pub fn start(store: Arc<Store>) -> Self {
        let (sender, receiver) = mpsc::channel::<BoundsMessage>();
        std::thread::spawn(move || {
            let mut pending = Debouncer::new(BOUNDS_DELAY);
            let save = |items: Vec<(String, Bounds)>| {
                for (id, bounds) in items {
                    // A note deleted meanwhile has no entry any more; nothing to keep.
                    match store.set_bounds(&id, bounds) {
                        Ok(_) | Err(StoreError::UnknownNote) => {}
                        Err(error) => eprintln!("hangar-note: window place not saved: {error}"),
                    }
                }
            };
            loop {
                let message = match pending.next_due() {
                    Some(due) => {
                        receiver.recv_timeout(due.saturating_duration_since(Instant::now()))
                    }
                    None => receiver.recv().map_err(|_| RecvTimeoutError::Disconnected),
                };
                match message {
                    Ok(BoundsMessage::Moved(id, bounds)) => {
                        pending.push(id, bounds, Instant::now())
                    }
                    Ok(BoundsMessage::Flush(id, done)) => {
                        save(pending.take(id.as_deref()));
                        let _ = done.send(());
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => {
                        save(pending.take(None));
                        return;
                    }
                }
                save(pending.due(Instant::now()));
            }
        });
        Self { sender }
    }

    pub fn moved(&self, id: String, bounds: Bounds) {
        let _ = self.sender.send(BoundsMessage::Moved(id, bounds));
    }

    /// Writes what is pending for `id` (or every note) and waits for it, at most
    /// [`FLUSH_TIMEOUT`].
    pub fn flush(&self, id: Option<&str>) {
        let (done, wait) = mpsc::channel();
        if self
            .sender
            .send(BoundsMessage::Flush(id.map(str::to_owned), done))
            .is_ok()
        {
            let _ = wait.recv_timeout(FLUSH_TIMEOUT);
        }
    }
}

fn area_of(monitor: &tauri::Monitor) -> Area {
    let scale = monitor.scale_factor().max(0.1);
    let work = monitor.work_area();
    Area {
        x: f64::from(work.position.x) / scale,
        y: f64::from(work.position.y) / scale,
        width: f64::from(work.size.width) / scale,
        height: f64::from(work.size.height) / scale,
    }
}

/// Work areas of all monitors and of the primary one, in logical pixels. With monitors of
/// different scaling the logical coordinates are an approximation ([UNVERIFIED] how far off they
/// are on mixed-DPI setups).
fn monitors<R: Runtime>(app: &AppHandle<R>) -> (Vec<Area>, Option<Area>) {
    let all = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(area_of)
        .collect();
    let primary = app.primary_monitor().ok().flatten().as_ref().map(area_of);
    (all, primary)
}

/// The current place of a window in logical pixels; `None` while minimized or maximized, whose
/// coordinates are no place to remember (Windows moves minimized windows to -32000).
fn window_bounds<R: Runtime>(window: &Window<R>) -> Option<Bounds> {
    if window.is_minimized().unwrap_or(true) || window.is_maximized().unwrap_or(false) {
        return None;
    }
    let scale = window.scale_factor().ok()?;
    let position = window.outer_position().ok()?.to_logical::<f64>(scale);
    let size = window.inner_size().ok()?.to_logical::<f64>(scale);
    let bounds = Bounds {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    };
    bounds.plausible().then_some(bounds)
}

pub fn show_and_focus<R: Runtime>(window: &WebviewWindow<R>) {
    // Each step may fail harmlessly (already visible, not minimized).
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// Shows a hidden window after [`SHOW_FALLBACK`] in case its view never reported ready.
fn show_later<R: Runtime>(window: WebviewWindow<R>) {
    std::thread::spawn(move || {
        std::thread::sleep(SHOW_FALLBACK);
        if !window.is_visible().unwrap_or(true) {
            let _ = window.show();
        }
    });
}

fn notify_hub<R: Runtime>(app: &AppHandle<R>) {
    if app.get_webview_window(HUB_LABEL).is_some() {
        let _ = app.emit_to(HUB_LABEL, NOTES_CHANGED_EVENT, ());
    }
}

/// Opens a note's window or brings it to the front, and marks the note open.
pub fn open_note<R: Runtime>(app: &AppHandle<R>, store: &Store, id: &str) -> Result<(), AppError> {
    let meta = store.get(id)?;
    let label = note_label(&meta.id);
    if let Some(window) = app.get_webview_window(&label) {
        show_and_focus(&window);
    } else {
        build_note_window(app, &meta, &label)?;
    }
    if !meta.open {
        store.set_open(&meta.id, true)?;
        // "All notes" keeps whether a note is open, so "Undo" after a delete reopens it.
        notify_hub(app);
    }
    Ok(())
}

fn build_note_window<R: Runtime>(
    app: &AppHandle<R>,
    meta: &NoteMeta,
    label: &str,
) -> Result<(), AppError> {
    let (all, primary) = monitors(app);
    let placement = bounds::place(meta.bounds, &all, primary);
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(APP_URL.into()))
        .title(TITLE)
        .decorations(false)
        .resizable(true)
        .maximizable(false)
        .inner_size(placement.width, placement.height)
        .min_inner_size(bounds::MIN_WIDTH, bounds::MIN_HEIGHT)
        .always_on_top(meta.on_top)
        .theme(current_theme(app))
        .visible(false);
    if let Some((x, y)) = placement.position {
        builder = builder.position(x, y);
    }
    match builder.build() {
        Ok(window) => {
            show_later(window);
            Ok(())
        }
        // Two quick clicks: the other call created it meanwhile.
        Err(error) => match app.get_webview_window(label) {
            Some(window) => {
                show_and_focus(&window);
                Ok(())
            }
            None => Err(error.into()),
        },
    }
}

/// A new note in the color of new notes. Created from a note window, it opens one step below
/// and to the right of that note.
pub fn create_note<R: Runtime>(
    app: &AppHandle<R>,
    store: &Store,
    settings: &SettingsStore,
    from_label: Option<&str>,
) -> Result<NoteMeta, AppError> {
    let from = from_label
        .filter(|label| note_id_of(label).is_some())
        .and_then(|label| app.get_webview_window(label))
        .and_then(|window| window_bounds(&window.as_ref().window()));
    let (all, _) = monitors(app);
    let bounds = from.map(|b| bounds::cascade(b, &all));
    let meta = store.create(settings.get().new_note_color, bounds)?;
    build_note_window(app, &meta, &note_label(&meta.id))?;
    notify_hub(app);
    Ok(meta)
}

/// Hides a note: its window goes, the note stays in the list.
pub fn close_note<R: Runtime>(
    app: &AppHandle<R>,
    store: &Store,
    saver: &BoundsSaver,
    id: &str,
) -> Result<(), AppError> {
    let meta = store.get(id)?;
    saver.flush(Some(&meta.id));
    store.set_open(&meta.id, false)?;
    if let Some(window) = app.get_webview_window(&note_label(&meta.id)) {
        window.destroy()?;
    }
    notify_hub(app);
    Ok(())
}

/// Moves a note into the trash and removes its window. Asked by any window but the note's own
/// while the note is open, the note saves first and deletes itself; if it cannot save, nothing is
/// deleted ([`AppError::NotSaved`]) and its window keeps the text. Blocks up to
/// [`NOTE_REPLY_TIMEOUT`], so it must not run on the main thread, through which the answer comes.
pub fn delete_note<R: Runtime>(
    app: &AppHandle<R>,
    store: &Store,
    saver: &BoundsSaver,
    replies: &Replies,
    caller: &str,
    id: &str,
) -> Result<TrashItem, AppError> {
    let meta = store.get(id)?;
    let label = note_label(&meta.id);
    if caller != label {
        let asked = replies.ask(
            &meta.id,
            |_| {
                app.get_webview_window(&label).is_some()
                    && app.emit_to(&label, DELETE_REQUESTED_EVENT, ()).is_ok()
            },
            NOTE_REPLY_TIMEOUT,
        );
        match replies::delete_step(asked) {
            DeleteStep::Done(item) => return Ok(item),
            DeleteStep::Refuse => return Err(AppError::NotSaved),
            DeleteStep::DeleteHere => {}
        }
    }
    saver.flush(Some(&meta.id));
    let item = match store.delete(&meta.id) {
        Ok(item) => item,
        // The note deleted itself right after the wait gave up.
        Err(StoreError::UnknownNote) => store
            .list_trash()?
            .into_iter()
            .find(|item| item.id == meta.id)
            .ok_or(StoreError::UnknownNote)?,
        Err(error) => return Err(error.into()),
    };
    replies.answer(&meta.id, NoteReply::Deleted(item.clone()));
    if let Some(window) = app.get_webview_window(&label) {
        window.destroy()?;
    }
    notify_hub(app);
    Ok(item)
}

/// "Quit": every open note saves first. A note that could not save keeps the app open and comes
/// to the front with its "Not saved" notice; "Quit" again within
/// [`replies::QUIT_ANYWAY_WITHIN`] ends the app anyway. A note that does not answer in time does
/// not block.
pub fn quit<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    let chosen_at = Instant::now();
    // Off the main thread: the notes' answers arrive through it.
    std::thread::spawn(move || {
        let ids: Vec<String> = app
            .webview_windows()
            .keys()
            .filter_map(|label| note_id_of(label))
            .collect();
        let results = app.state::<Replies>().ask_all(
            &ids,
            |id| {
                app.emit_to(note_label(id), FLUSH_REQUESTED_EVENT, ())
                    .is_ok()
            },
            NOTE_REPLY_TIMEOUT,
        );
        let memory = app.state::<QuitMemory>();
        match replies::quit_step(results, memory.refused_at(), chosen_at) {
            QuitStep::Quit => {
                app.state::<BoundsSaver>().flush(None);
                app.exit(0);
            }
            QuitStep::Stay(unsaved) => {
                memory.refused(Instant::now());
                for id in unsaved {
                    if let Some(window) = app.get_webview_window(&note_label(&id)) {
                        show_and_focus(&window);
                    }
                }
            }
        }
    });
}

/// Opens "All notes" or brings it to the front.
pub fn open_hub<R: Runtime>(app: &AppHandle<R>) -> Result<(), AppError> {
    if let Some(window) = app.get_webview_window(HUB_LABEL) {
        show_and_focus(&window);
        return Ok(());
    }
    let built = WebviewWindowBuilder::new(app, HUB_LABEL, WebviewUrl::App(APP_URL.into()))
        .title(TITLE)
        .inner_size(HUB_WIDTH, HUB_HEIGHT)
        .min_inner_size(HUB_MIN_WIDTH, HUB_MIN_HEIGHT)
        .theme(current_theme(app))
        .visible(false)
        .build();
    match built {
        Ok(window) => {
            show_later(window);
            Ok(())
        }
        Err(error) => match app.get_webview_window(HUB_LABEL) {
            Some(window) => {
                show_and_focus(&window);
                Ok(())
            }
            None => Err(error.into()),
        },
    }
}

/// Opens every note in the list.
pub fn show_all_notes<R: Runtime>(app: &AppHandle<R>, store: &Store) {
    for summary in store.list() {
        if let Err(error) = open_note(app, store, &summary.meta.id) {
            eprintln!("hangar-note: note not opened: {error}");
        }
    }
}

/// On startup: every note that was open reopens; without any, "All notes" opens instead.
pub fn restore<R: Runtime>(app: &AppHandle<R>, store: &Store) -> Result<(), AppError> {
    let mut opened = 0usize;
    for meta in store.open_notes() {
        match build_note_window(app, &meta, &note_label(&meta.id)) {
            Ok(()) => opened += 1,
            Err(error) => eprintln!("hangar-note: note not reopened: {error}"),
        }
    }
    if opened == 0 {
        open_hub(app)?;
    }
    Ok(())
}

/// Close requests and moves of every window. Registered once on the builder.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    let label = window.label();
    match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            if let (Some(id), Some(bounds)) = (note_id_of(label), window_bounds(window)) {
                window.state::<BoundsSaver>().moved(id, bounds);
            }
        }
        WindowEvent::CloseRequested { api, .. } => {
            if label == HUB_LABEL {
                // Without a tray icon there would be no way back to a hidden hub: then it closes,
                // and closing the last window quits.
                if crate::tray::present(window.app_handle()) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            } else if note_id_of(label).is_some() {
                // The note saves its last keystrokes first, then closes itself (`close_note`).
                api.prevent_close();
                let _ = window.emit_to(label, CLOSE_REQUESTED_EVENT, ());
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5";
    const OTHER: &str = "0b7f6a0e-3c1d-4c5e-9a8b-1f2e3d4c5b6a";

    #[test]
    fn labels_name_exactly_one_note() {
        assert_eq!(note_label(ID), format!("note-{ID}"));
        assert_eq!(note_id_of(&note_label(ID)).as_deref(), Some(ID));
        assert_eq!(note_id_of(HUB_LABEL), None);
        assert_eq!(note_id_of("note-"), None);
        assert_eq!(note_id_of("note-../x"), None);
        // Uppercase would be a second label for the same note.
        assert_eq!(note_id_of(&note_label(&ID.to_uppercase())), None);
    }

    #[test]
    fn note_windows_may_only_touch_their_own_note() {
        assert!(may_touch(HUB_LABEL, ID));
        assert!(may_touch(HUB_LABEL, OTHER));
        let own = note_label(ID);
        assert!(may_touch(&own, ID));
        assert!(may_touch(&own, &ID.to_uppercase()));
        assert!(!may_touch(&own, OTHER));
        assert!(!may_touch(&own, "not-an-id"));
        assert!(!may_touch("main", ID));
        assert!(matches!(
            check_access(&own, OTHER),
            Err(AppError::NotAllowed)
        ));
    }

    #[test]
    fn the_theme_setting_picks_the_native_theme() {
        assert_eq!(native_theme(Theme::System), None);
        assert_eq!(native_theme(Theme::Light), Some(tauri::Theme::Light));
        assert_eq!(native_theme(Theme::Dark), Some(tauri::Theme::Dark));
    }

    #[test]
    fn a_failed_save_reaches_the_frontend_as_a_stable_code() {
        assert_eq!(
            serde_json::to_value(AppError::NotSaved).unwrap(),
            serde_json::json!(NOT_SAVED_CODE)
        );
        assert_eq!(
            serde_json::to_value(AppError::NotAllowed).unwrap(),
            serde_json::json!("This window may not change that note")
        );
    }

    #[test]
    fn the_debouncer_waits_for_quiet_and_keeps_the_last_value() {
        let start = Instant::now();
        let mut debouncer = Debouncer::new(Duration::from_millis(500));
        debouncer.push("a".into(), 1, start);
        debouncer.push("a".into(), 2, start + Duration::from_millis(300));
        debouncer.push("b".into(), 9, start + Duration::from_millis(100));
        assert_eq!(
            debouncer.next_due(),
            Some(start + Duration::from_millis(600))
        );
        assert!(debouncer.due(start + Duration::from_millis(500)).is_empty());
        assert_eq!(
            debouncer.due(start + Duration::from_millis(600)),
            vec![("b".to_owned(), 9)]
        );
        assert!(debouncer.due(start + Duration::from_millis(700)).is_empty());
        assert_eq!(
            debouncer.due(start + Duration::from_millis(800)),
            vec![("a".to_owned(), 2)]
        );
        assert_eq!(debouncer.next_due(), None);
    }

    #[test]
    fn flushing_takes_one_or_all_values_at_once() {
        let now = Instant::now();
        let mut debouncer = Debouncer::new(Duration::from_secs(60));
        debouncer.push("a".into(), 1, now);
        debouncer.push("b".into(), 2, now);
        assert_eq!(debouncer.take(Some("a")), vec![("a".to_owned(), 1)]);
        assert!(debouncer.take(Some("a")).is_empty());
        assert_eq!(debouncer.take(None), vec![("b".to_owned(), 2)]);
        assert_eq!(debouncer.next_due(), None);
    }

    #[test]
    fn the_saver_writes_places_after_the_quiet_time_and_on_flush() {
        let dir = crate::test_support::TempDir::new("windows-saver");
        let store = Arc::new(Store::open(dir.path()).unwrap());
        let meta = store.create(crate::store::NoteColor::Lemon, None).unwrap();
        let saver = BoundsSaver::start(store.clone());
        let first = Bounds {
            x: 10.0,
            y: 20.0,
            width: 300.0,
            height: 280.0,
        };
        let last = Bounds { x: 50.0, ..first };
        saver.moved(meta.id.clone(), first);
        saver.moved(meta.id.clone(), last);
        saver.flush(Some(&meta.id));
        assert_eq!(store.get(&meta.id).unwrap().bounds, Some(last));
        let later = Bounds { y: 99.0, ..last };
        saver.moved(meta.id.clone(), later);
        std::thread::sleep(BOUNDS_DELAY + Duration::from_millis(400));
        assert_eq!(store.get(&meta.id).unwrap().bounds, Some(later));
    }
}
