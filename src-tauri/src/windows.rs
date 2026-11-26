//! The windows (ADR 0001, ADR 0002). The backend creates and owns all of them; the frontend asks
//! for them through commands and never holds a permission to create or close arbitrary windows.
//!
//! - `hub`: the notes area (scope chips, search, list, editor with preview). Closing it hides it
//!   while the tray icon exists.
//! - `note-<scope>-<id>`: a sticky note on the desktop, one frameless window per note. While it
//!   exists it is the note's only editor; the notes area shows "On the desktop" instead.
//!
//! Windows open hidden and show themselves once their view has rendered (`window_ready`), so no
//! empty white frame flashes up; a fallback shows them after a few seconds in any case.
//!
//! Whatever would end an editor (closing, deleting from the notes area, quitting, Hangar's
//! `flush`) first lets it save what was just typed: only its view has that text (`replies`).

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
use crate::export::ExportError;
use crate::fsio::StorageCode;
use crate::meta::{Bounds, MetaError, NoteLook};
use crate::notes::{
    check_id, is_folder_key, NoteFolder, NotesError, GENERAL_KEY, MAX_NOTE_BYTES, READ_ONLY_CODE,
};
use crate::replies::{self, Asked, DeleteStep, NoteReply, QuitMemory, QuitStep, Replies};
use crate::requests::{HubRequest, Requests};
use crate::service::{NoteKey, NotesService, OpenedNote, ServiceError};
use crate::settings::{SettingsError, SettingsStore, Theme};

pub const HUB_LABEL: &str = "hub";
pub const NOTE_PREFIX: &str = "note-";
/// The one app URL; `src/main.tsx` picks the view by the window's label.
const APP_URL: &str = "index.html";
const TITLE: &str = "Hangar Note";
const HUB_WIDTH: f64 = 980.0;
const HUB_HEIGHT: f64 = 660.0;
const HUB_MIN_WIDTH: f64 = 420.0;
const HUB_MIN_HEIGHT: f64 = 420.0;
/// Quiet time after the last move or resize before the place is written.
pub const BOUNDS_DELAY: Duration = Duration::from_millis(500);
/// A window whose view never reported ready is shown after this anyway.
const SHOW_FALLBACK: Duration = Duration::from_secs(4);
/// How long quitting waits for the remembered places to be written.
const FLUSH_TIMEOUT: Duration = Duration::from_secs(2);
/// How long deleting, quitting and `flush` wait for an editor to save before going ahead.
pub const NOTE_REPLY_TIMEOUT: Duration = FLUSH_TIMEOUT;

/// To the notes area, without payload: notes changed, reload the list.
pub const NOTES_CHANGED_EVENT: &str = "notes-changed";
/// To every window, with the new settings.
pub const SETTINGS_CHANGED_EVENT: &str = "settings-changed";
/// To the notes area: requests wait (`take_hub_requests`), or "This project" changed.
pub const HUB_REQUESTS_EVENT: &str = "hub-requests";
/// To a sticky note: the system asked it to close (Alt+F4); it saves, then calls `close_note`.
pub const CLOSE_REQUESTED_EVENT: &str = "note-close-requested";
/// To a sticky note: the notes area deletes it. It saves, then deletes itself, or reports the
/// failed save (`note_flushed`).
pub const DELETE_REQUESTED_EVENT: &str = "note-delete-requested";
/// To every editor (sticky notes and the notes area) before quitting or on Hangar's `flush`:
/// save, then answer with `note_flushed`.
pub const FLUSH_REQUESTED_EVENT: &str = "note-flush-requested";
/// To a sticky note, with its new color: the notes area changed it.
pub const LOOK_CHANGED_EVENT: &str = "note-look-changed";
/// What the frontend receives for [`AppError::NotSaved`].
pub const NOT_SAVED_CODE: &str = "not-saved";
/// What the notes area receives when it tries to write a note that sits on the desktop.
pub const ON_DESKTOP_CODE: &str = "on-desktop";

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("This window may not change that note")]
    NotAllowed,
    #[error("The open note could not save its text")]
    NotSaved,
    #[error("The note sits on the desktop; its sticky note is its editor")]
    OnDesktop,
    #[error(transparent)]
    Service(#[from] ServiceError),
    #[error(transparent)]
    Settings(#[from] SettingsError),
    #[error(transparent)]
    Export(#[from] ExportError),
    #[error("Start with the system: {0}")]
    Autostart(String),
    #[error("Clipboard: {0}")]
    Clipboard(String),
    #[error("Background task aborted: {0}")]
    Task(String),
    #[error("Window: {0}")]
    Tauri(#[from] tauri::Error),
}

impl From<NotesError> for AppError {
    fn from(error: NotesError) -> Self {
        Self::Service(error.into())
    }
}

impl From<MetaError> for AppError {
    fn from(error: MetaError) -> Self {
        Self::Service(error.into())
    }
}

impl AppError {
    /// The fixed code of a storage failure (`denied`, `disk-full`, `too-large`, `not-found`,
    /// `io`), from every store the commands reach.
    pub fn storage_code(&self) -> Option<StorageCode> {
        match self {
            Self::Service(ServiceError::Notes(error)) => error.storage_code(),
            Self::Service(ServiceError::Meta(error)) => error.storage_code(),
            Self::Settings(error) => error.storage_code(),
            Self::Export(error) => error.storage_code(),
            _ => None,
        }
    }

    /// The fixed code the window acts on, `None` for the errors that keep their text.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            Self::NotSaved => Some(NOT_SAVED_CODE),
            Self::OnDesktop => Some(ON_DESKTOP_CODE),
            Self::Service(ServiceError::Notes(NotesError::ReadOnly)) => Some(READ_ONLY_CODE),
            other => other.storage_code().map(StorageCode::as_str),
        }
    }
}

/// Every command error reaches the window through here, once. A storage failure arrives as its
/// code only; its full text (the path and the OS error, never a note's content) goes to the log
/// at this one place, so no command can forget it.
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self.code() {
            Some(code) => {
                if self.storage_code().is_some() {
                    eprintln!("hangar-note: {code}: {self}");
                }
                serializer.serialize_str(code)
            }
            None => serializer.serialize_str(&self.to_string()),
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

/// Whether a WebView may go to `url` (security review H5): only the app's own pages, and in a
/// debug build the dev server's. Tauri serves the app as `tauri://localhost` on macOS and Linux
/// and as `http://tauri.localhost` (or `https://` with `useHttpsScheme`) on Windows. A link in a
/// note, a script or a redirect never turns a window with the app's commands into a web page.
pub fn navigation_allowed(url: &tauri::Url, windows: bool, dev: Option<&tauri::Url>) -> bool {
    let own = match url.scheme() {
        "tauri" => url.host_str() == Some("localhost") && url.port().is_none(),
        "http" | "https" if windows => {
            url.host_str() == Some("tauri.localhost") && url.port().is_none()
        }
        _ => false,
    };
    own || dev.is_some_and(|dev| url.origin() == dev.origin())
}

/// Every window this app builds gets the filter; the dev server only in debug builds.
fn with_navigation_filter<'a, R: Runtime, M: tauri::Manager<R>>(
    app: &AppHandle<R>,
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    let dev = if cfg!(debug_assertions) {
        app.config().build.dev_url.clone()
    } else {
        None
    };
    builder.on_navigation(move |url| {
        let allowed = navigation_allowed(url, cfg!(windows), dev.as_ref());
        if !allowed {
            // The scheme only: a URL can carry a note's text.
            eprintln!("hangar-note: navigation to a {} URL refused", url.scheme());
        }
        allowed
    })
}

fn hub_on_top<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<SettingsStore>()
        .is_some_and(|settings| settings.get().hub_on_top)
}

/// Applies the theme setting to every open window. On Linux and macOS the theme is app-wide.
pub fn apply_theme<R: Runtime>(app: &AppHandle<R>, theme: Theme) {
    for window in app.webview_windows().values() {
        if let Err(error) = window.set_theme(native_theme(theme)) {
            eprintln!("hangar-note: window theme not changed: {error}");
        }
    }
}

pub fn sticky_label(key: &NoteKey) -> String {
    format!("{NOTE_PREFIX}{}-{}", key.scope, key.id)
}

/// The note of a sticky window's label, `None` for any other window. The ID must be in its
/// normal (lowercase) form, so one note never has two labels.
pub fn sticky_of(label: &str) -> Option<NoteKey> {
    let rest = label.strip_prefix(NOTE_PREFIX)?;
    let (scope, id) = if let Some(id) = rest.strip_prefix(&format!("{GENERAL_KEY}-")) {
        (GENERAL_KEY, id)
    } else {
        let scope = rest.get(..32)?;
        let id = rest.get(32..)?.strip_prefix('-')?;
        (scope, id)
    };
    if !is_folder_key(scope) || scope != scope.to_ascii_lowercase() {
        return None;
    }
    let normal = check_id(id).ok()?;
    (normal == id).then(|| NoteKey {
        scope: scope.to_owned(),
        id: normal,
    })
}

/// Whether the window `label` may act on `key`: the notes area on every note, a sticky note only
/// on its own. A compromised sticky view thus cannot read or delete other notes.
pub fn may_touch(label: &str, key: &NoteKey) -> bool {
    label == HUB_LABEL || sticky_of(label).as_ref() == Some(key)
}

/// The key of `folder` and `id`, if the window `label` may act on that note.
pub fn checked_key(label: &str, folder: &NoteFolder, id: &str) -> Result<NoteKey, AppError> {
    let key = NotesService::key(folder, id)?;
    if may_touch(label, &key) {
        Ok(key)
    } else {
        Err(AppError::NotAllowed)
    }
}

/// Whether the window `label` may put `text` on the clipboard (`copy_text`): the notes area and a
/// sticky note, each for text of at most one note ([`MAX_NOTE_BYTES`]). Only the length is looked
/// at; the text itself never reaches an error or a log.
pub fn check_copy(label: &str, text: &str) -> Result<(), AppError> {
    if label != HUB_LABEL && sticky_of(label).is_none() {
        return Err(AppError::NotAllowed);
    }
    if text.len() > MAX_NOTE_BYTES {
        return Err(NotesError::TooLarge {
            size: text.len(),
            max: MAX_NOTE_BYTES,
        }
        .into());
    }
    Ok(())
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
    /// Write what is pending for one window (or all) now, then answer.
    Flush(Option<String>, mpsc::Sender<()>),
}

/// Writes the places of sticky notes on a thread of its own, [`BOUNDS_DELAY`] after the last
/// move: dragging a window sends dozens of events per second.
#[derive(Debug)]
pub struct BoundsSaver {
    sender: mpsc::Sender<BoundsMessage>,
}

impl BoundsSaver {
    pub fn start(service: Arc<NotesService>) -> Self {
        let (sender, receiver) = mpsc::channel::<BoundsMessage>();
        std::thread::spawn(move || {
            let mut pending = Debouncer::new(BOUNDS_DELAY);
            let save = |items: Vec<(String, Bounds)>| {
                for (label, bounds) in items {
                    let Some(key) = sticky_of(&label) else {
                        continue;
                    };
                    let result = service
                        .meta()
                        .update(&key.scope, &key.id, |look| look.bounds = Some(bounds));
                    if let Err(error) = result {
                        eprintln!("hangar-note: window place not saved: {error}");
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
                    Ok(BoundsMessage::Moved(label, bounds)) => {
                        pending.push(label, bounds, Instant::now())
                    }
                    Ok(BoundsMessage::Flush(label, done)) => {
                        save(pending.take(label.as_deref()));
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

    pub fn moved(&self, label: String, bounds: Bounds) {
        let _ = self.sender.send(BoundsMessage::Moved(label, bounds));
    }

    /// Writes what is pending for `label` (or every window) and waits for it, at most
    /// [`FLUSH_TIMEOUT`].
    pub fn flush(&self, label: Option<&str>) {
        let (done, wait) = mpsc::channel();
        if self
            .sender
            .send(BoundsMessage::Flush(label.map(str::to_owned), done))
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

pub fn notify_hub<R: Runtime>(app: &AppHandle<R>) {
    if app.get_webview_window(HUB_LABEL).is_some() {
        let _ = app.emit_to(HUB_LABEL, NOTES_CHANGED_EVENT, ());
    }
}

/// Tells a sticky note its new look (the notes area changed its color).
pub fn notify_sticky<R: Runtime>(app: &AppHandle<R>, key: &NoteKey, look: &NoteLook) {
    let label = sticky_label(key);
    if app.get_webview_window(&label).is_some() {
        let _ = app.emit_to(&label, LOOK_CHANGED_EVENT, look);
    }
}

/// The folder of a sticky note's scope.
fn folder_of(service: &NotesService, key: &NoteKey) -> Result<NoteFolder, AppError> {
    service
        .store()
        .folder_for_key(&key.scope)
        .ok_or_else(|| NotesError::UnknownNote.into())
}

/// The note shown in a sticky window, for the window itself.
pub fn sticky_note(service: &NotesService, label: &str) -> Result<OpenedNote, AppError> {
    let key = sticky_of(label).ok_or(AppError::NotAllowed)?;
    let folder = folder_of(service, &key)?;
    Ok(service.open_note(&folder, &key.id)?)
}

fn build_sticky<R: Runtime>(
    app: &AppHandle<R>,
    look: &NoteLook,
    label: &str,
) -> Result<(), AppError> {
    let (all, primary) = monitors(app);
    let placement = bounds::place(look.bounds, &all, primary);
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(APP_URL.into()));
    let mut builder = with_navigation_filter(app, builder)
        .title(TITLE)
        .decorations(false)
        .resizable(true)
        .maximizable(false)
        .inner_size(placement.width, placement.height)
        .min_inner_size(bounds::MIN_WIDTH, bounds::MIN_HEIGHT)
        .always_on_top(look.on_top)
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

/// Puts a note on the desktop or brings its sticky note to the front.
pub fn open_sticky<R: Runtime>(
    app: &AppHandle<R>,
    service: &NotesService,
    folder: &NoteFolder,
    id: &str,
) -> Result<(), AppError> {
    let key = NotesService::key(folder, id)?;
    // Only a note that exists goes onto the desktop.
    service.store().title(folder, &key.id)?;
    let label = sticky_label(&key);
    let look = service.meta().get(&key.scope, &key.id);
    if let Some(window) = app.get_webview_window(&label) {
        show_and_focus(&window);
    } else {
        build_sticky(app, &look, &label)?;
    }
    if !look.open {
        service
            .meta()
            .update(&key.scope, &key.id, |look| look.open = true)?;
        notify_hub(app);
    }
    Ok(())
}

/// A new note on the desktop, in the scope of the sticky note `from` (General from the tray),
/// one step below and to the right of it.
pub fn create_sticky<R: Runtime>(
    app: &AppHandle<R>,
    service: &NotesService,
    settings: &SettingsStore,
    from: Option<&str>,
    base: &str,
) -> Result<OpenedNote, AppError> {
    let source = from.and_then(sticky_of);
    let folder = match &source {
        Some(key) => folder_of(service, key)?,
        None => NoteFolder::general(),
    };
    let near = from
        .filter(|_| source.is_some())
        .and_then(|label| app.get_webview_window(label))
        .and_then(|window| window_bounds(&window.as_ref().window()));
    let (all, _) = monitors(app);
    let note = service.create_untitled(&folder, base, settings.get().new_note_color)?;
    let key = NotesService::key(&folder, &note.id)?;
    let look = service.meta().update(&key.scope, &key.id, |look| {
        look.open = true;
        look.bounds = near.map(|b| bounds::cascade(b, &all));
    })?;
    build_sticky(app, &look, &sticky_label(&key))?;
    notify_hub(app);
    Ok(note)
}

/// Takes a note off the desktop: its window goes, the notes area edits it again.
pub fn close_sticky<R: Runtime>(
    app: &AppHandle<R>,
    service: &NotesService,
    saver: &BoundsSaver,
    key: &NoteKey,
) -> Result<(), AppError> {
    let label = sticky_label(key);
    saver.flush(Some(&label));
    service
        .meta()
        .update(&key.scope, &key.id, |look| look.open = false)?;
    if let Some(window) = app.get_webview_window(&label) {
        window.destroy()?;
    }
    notify_hub(app);
    Ok(())
}

/// "Back into the list" from the notes area: the sticky note saves first; if it cannot, it stays
/// ([`AppError::NotSaved`]). Blocks up to [`NOTE_REPLY_TIMEOUT`], so not on the main thread.
pub fn return_sticky<R: Runtime>(
    app: &AppHandle<R>,
    service: &NotesService,
    saver: &BoundsSaver,
    replies: &Replies,
    key: &NoteKey,
) -> Result<(), AppError> {
    let label = sticky_label(key);
    let asked = replies.ask(
        &label,
        |_| {
            app.get_webview_window(&label).is_some()
                && app.emit_to(&label, FLUSH_REQUESTED_EVENT, ()).is_ok()
        },
        NOTE_REPLY_TIMEOUT,
    );
    if asked == Asked::Answered(NoteReply::NotSaved) {
        return Err(AppError::NotSaved);
    }
    close_sticky(app, service, saver, key)
}

/// Moves a note into the trash and removes its sticky window. Asked by any window but the note's
/// own while it is on the desktop, the sticky note saves first and deletes itself; if it cannot
/// save, nothing is deleted ([`AppError::NotSaved`]). Blocks up to [`NOTE_REPLY_TIMEOUT`].
pub fn delete_note<R: Runtime>(
    app: &AppHandle<R>,
    service: &NotesService,
    saver: &BoundsSaver,
    replies: &Replies,
    caller: &str,
    folder: &NoteFolder,
    id: &str,
) -> Result<(), AppError> {
    let key = NotesService::key(folder, id)?;
    let label = sticky_label(&key);
    if caller != label {
        let asked = replies.ask(
            &label,
            |_| {
                app.get_webview_window(&label).is_some()
                    && app.emit_to(&label, DELETE_REQUESTED_EVENT, ()).is_ok()
            },
            NOTE_REPLY_TIMEOUT,
        );
        match replies::delete_step(asked) {
            DeleteStep::Done => return Ok(()),
            DeleteStep::Refuse => return Err(AppError::NotSaved),
            DeleteStep::DeleteHere => {}
        }
    }
    saver.flush(Some(&label));
    match service.delete(folder, &key.id) {
        Ok(()) => {}
        // The sticky note deleted itself right after the wait gave up.
        Err(ServiceError::Notes(NotesError::UnknownNote)) if caller != label => {}
        Err(error) => return Err(error.into()),
    }
    replies.answer(&label, NoteReply::Deleted);
    if let Some(window) = app.get_webview_window(&label) {
        window.destroy()?;
    }
    notify_hub(app);
    Ok(())
}

/// Every editor that may hold unsaved text: the sticky notes and the notes area.
fn editors<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    app.webview_windows()
        .keys()
        .filter(|label| *label == HUB_LABEL || sticky_of(label).is_some())
        .cloned()
        .collect()
}

fn ask_editors<R: Runtime>(app: &AppHandle<R>) -> Vec<(String, Asked)> {
    let labels = editors(app);
    app.state::<Replies>().ask_all(
        &labels,
        |label| app.emit_to(label, FLUSH_REQUESTED_EVENT, ()).is_ok(),
        NOTE_REPLY_TIMEOUT,
    )
}

/// Hangar's `flush`: every editor saves. `true` once all answered that everything is on disk.
pub fn flush_all<R: Runtime>(app: &AppHandle<R>) -> bool {
    let results = ask_editors(app);
    app.state::<BoundsSaver>().flush(None);
    results.iter().all(|(_, asked)| {
        matches!(
            asked,
            Asked::NoWindow | Asked::Answered(NoteReply::Saved | NoteReply::Deleted)
        )
    })
}

/// "Quit": every editor saves first. One that could not save keeps the app open and comes to the
/// front; "Quit" again within [`replies::QUIT_ANYWAY_WITHIN`] ends the app anyway. An editor that
/// does not answer in time does not block.
pub fn quit<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    let chosen_at = Instant::now();
    // Off the main thread: the answers arrive through it.
    std::thread::spawn(move || {
        let results = ask_editors(&app);
        let memory = app.state::<QuitMemory>();
        match replies::quit_step(results, memory.refused_at(), chosen_at) {
            QuitStep::Quit => {
                app.state::<BoundsSaver>().flush(None);
                app.exit(0);
            }
            QuitStep::Stay(unsaved) => {
                memory.refused(Instant::now());
                for label in unsaved {
                    if let Some(window) = app.get_webview_window(&label) {
                        show_and_focus(&window);
                    }
                }
            }
        }
    });
}

/// Opens the notes area or brings it to the front.
pub fn open_hub<R: Runtime>(app: &AppHandle<R>) -> Result<(), AppError> {
    if let Some(window) = app.get_webview_window(HUB_LABEL) {
        show_and_focus(&window);
        return Ok(());
    }
    let builder = WebviewWindowBuilder::new(app, HUB_LABEL, WebviewUrl::App(APP_URL.into()));
    let built = with_navigation_filter(app, builder)
        .title(TITLE)
        .inner_size(HUB_WIDTH, HUB_HEIGHT)
        .min_inner_size(HUB_MIN_WIDTH, HUB_MIN_HEIGHT)
        .always_on_top(hub_on_top(app))
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

/// Brings every sticky note to the front.
pub fn show_all_stickies<R: Runtime>(app: &AppHandle<R>) {
    for (label, window) in app.webview_windows() {
        if sticky_of(&label).is_some() {
            show_and_focus(&window);
        }
    }
}

/// Hands requests to the notes area: opens it and tells it to take them.
pub fn deliver<R: Runtime>(
    app: &AppHandle<R>,
    requests: &Requests,
    project: Option<std::path::PathBuf>,
    list: Vec<HubRequest>,
) {
    if let Some(folder) = project {
        requests.set_project(folder);
    }
    for request in list {
        requests.push(request);
    }
    if let Err(error) = open_hub(app) {
        eprintln!("hangar-note: notes area not opened: {error}");
    }
    let _ = app.emit_to(HUB_LABEL, HUB_REQUESTS_EVENT, ());
}

/// On startup: every note that was on the desktop comes back; the notes area opens when none did
/// or when `show_hub` (a start with a command).
pub fn restore<R: Runtime>(
    app: &AppHandle<R>,
    service: &NotesService,
    show_hub: bool,
) -> Result<(), AppError> {
    let mut opened = 0usize;
    for (scope, id, look) in service.meta().open_notes() {
        let key = NoteKey { scope, id };
        let exists = service
            .store()
            .folder_for_key(&key.scope)
            .is_some_and(|folder| service.store().title(&folder, &key.id).is_ok());
        if !exists {
            // Deleted or moved from outside meanwhile: it is no longer on the desktop.
            let _ = service
                .meta()
                .update(&key.scope, &key.id, |look| look.open = false);
            continue;
        }
        match build_sticky(app, &look, &sticky_label(&key)) {
            Ok(()) => opened += 1,
            Err(error) => eprintln!("hangar-note: sticky note not reopened: {error}"),
        }
    }
    if opened == 0 || show_hub {
        open_hub(app)?;
    }
    Ok(())
}

/// Close requests and moves of every window. Registered once on the builder.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    let label = window.label();
    match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            if let (Some(_), Some(bounds)) = (sticky_of(label), window_bounds(window)) {
                window
                    .state::<BoundsSaver>()
                    .moved(label.to_owned(), bounds);
            }
        }
        WindowEvent::CloseRequested { api, .. } => {
            if label == HUB_LABEL {
                // Without a tray icon there would be no way back to a hidden notes area: then it
                // closes, and closing the last window quits.
                if crate::tray::present(window.app_handle()) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            } else if sticky_of(label).is_some() {
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
    const SCOPE: &str = "0123456789abcdef0123456789abcdef";

    fn key(scope: &str, id: &str) -> NoteKey {
        NoteKey {
            scope: scope.into(),
            id: id.into(),
        }
    }

    #[test]
    fn labels_name_exactly_one_note() {
        for k in [key(GENERAL_KEY, ID), key(SCOPE, ID)] {
            assert_eq!(sticky_of(&sticky_label(&k)), Some(k));
        }
        assert_eq!(
            sticky_label(&key(GENERAL_KEY, ID)),
            format!("note-general-{ID}")
        );
        assert_eq!(sticky_of(HUB_LABEL), None);
        assert_eq!(sticky_of("note-"), None);
        assert_eq!(sticky_of(&format!("note-{ID}")), None);
        assert_eq!(sticky_of("note-general-../x"), None);
        assert_eq!(
            sticky_of(&format!("note-{}-{ID}", SCOPE.to_uppercase())),
            None
        );
        // Uppercase would be a second label for the same note.
        assert_eq!(
            sticky_of(&format!("note-general-{}", ID.to_uppercase())),
            None
        );
    }

    #[test]
    fn sticky_notes_may_only_touch_their_own_note() {
        let own = sticky_label(&key(GENERAL_KEY, ID));
        assert!(may_touch(HUB_LABEL, &key(SCOPE, OTHER)));
        assert!(may_touch(&own, &key(GENERAL_KEY, ID)));
        assert!(!may_touch(&own, &key(GENERAL_KEY, OTHER)));
        assert!(!may_touch(&own, &key(SCOPE, ID)));
        assert!(!may_touch("main", &key(GENERAL_KEY, ID)));
        assert!(checked_key(&own, &NoteFolder::general(), &ID.to_uppercase()).is_ok());
        assert!(matches!(
            checked_key(&own, &NoteFolder::general(), OTHER),
            Err(AppError::NotAllowed)
        ));
    }

    #[test]
    fn only_the_notes_area_and_sticky_notes_copy_text_of_at_most_one_note() {
        let own = sticky_label(&key(GENERAL_KEY, ID));
        assert!(check_copy(HUB_LABEL, "Text").is_ok());
        assert!(check_copy(&own, "").is_ok());
        assert!(check_copy(HUB_LABEL, &"x".repeat(MAX_NOTE_BYTES)).is_ok());
        for label in ["main", "note-", "note-general-x", ""] {
            assert!(matches!(
                check_copy(label, "Text"),
                Err(AppError::NotAllowed)
            ));
        }
        let large = "x".repeat(MAX_NOTE_BYTES + 1);
        let error = check_copy(&own, &large).unwrap_err();
        assert!(matches!(
            error,
            AppError::Service(ServiceError::Notes(NotesError::TooLarge { .. }))
        ));
        // The message names the size, never the text.
        assert!(!error.to_string().contains("xxxx"));
    }

    #[test]
    fn windows_go_nowhere_but_the_apps_own_pages() {
        let url = |text: &str| tauri::Url::parse(text).unwrap();
        let dev = url("http://localhost:1430");
        for (text, windows, allowed) in [
            ("tauri://localhost/index.html", false, true),
            ("tauri://localhost/", true, true),
            ("http://tauri.localhost/index.html", true, true),
            ("https://tauri.localhost/index.html", true, true),
            // Served by Tauri only on Windows; elsewhere a name that may reach any local server.
            ("http://tauri.localhost/index.html", false, false),
            ("http://tauri.localhost:8080/", true, false),
            ("tauri://elsewhere/", false, false),
            ("https://example.invalid/", true, false),
            ("http://localhost:1430/index.html", true, false),
            ("file:///C:/x.html", true, false),
            ("data:text/html,x", true, false),
            ("javascript:void(0)", true, false),
            ("about:blank", true, false),
        ] {
            assert_eq!(
                navigation_allowed(&url(text), windows, None),
                allowed,
                "{text} windows={windows}"
            );
        }
        // The dev server, in debug builds only, and only its own origin.
        assert!(navigation_allowed(
            &url("http://localhost:1430/src/main.tsx"),
            true,
            Some(&dev)
        ));
        assert!(!navigation_allowed(
            &url("http://localhost:1431/"),
            true,
            Some(&dev)
        ));
        assert!(!navigation_allowed(
            &url("https://localhost:1430/"),
            true,
            Some(&dev)
        ));
    }

    #[test]
    fn the_theme_setting_picks_the_native_theme() {
        assert_eq!(native_theme(Theme::System), None);
        assert_eq!(native_theme(Theme::Light), Some(tauri::Theme::Light));
        assert_eq!(native_theme(Theme::Dark), Some(tauri::Theme::Dark));
    }

    #[test]
    fn errors_the_window_acts_on_arrive_as_stable_codes() {
        let code = |error: AppError| serde_json::to_value(error).unwrap();
        assert_eq!(code(AppError::NotSaved), serde_json::json!(NOT_SAVED_CODE));
        assert_eq!(
            code(AppError::OnDesktop),
            serde_json::json!(ON_DESKTOP_CODE)
        );
        assert_eq!(
            code(NotesError::ReadOnly.into()),
            serde_json::json!("read-only")
        );
        assert_eq!(
            code(AppError::NotAllowed),
            serde_json::json!("This window may not change that note")
        );
    }

    #[test]
    fn storage_failures_reach_the_window_as_codes_without_path_or_os_text() {
        let code = |error: AppError| serde_json::to_value(error).unwrap();
        let path = std::path::PathBuf::from(if cfg!(windows) {
            r"C:\Users\someone\notes\general\Secret plan.md"
        } else {
            "/home/someone/notes/general/Secret plan.md"
        });
        let notes = |kind: std::io::ErrorKind| -> AppError {
            NotesError::Io {
                path: path.clone(),
                source: kind.into(),
            }
            .into()
        };
        for (error, expected) in [
            (notes(std::io::ErrorKind::PermissionDenied), "denied"),
            (notes(std::io::ErrorKind::ReadOnlyFilesystem), "denied"),
            (notes(std::io::ErrorKind::StorageFull), "disk-full"),
            (notes(std::io::ErrorKind::NotFound), "not-found"),
            (notes(std::io::ErrorKind::InvalidData), "io"),
            (
                NotesError::TooLarge {
                    size: MAX_NOTE_BYTES + 1,
                    max: MAX_NOTE_BYTES,
                }
                .into(),
                "too-large",
            ),
            (NotesError::UnknownNote.into(), "not-found"),
            (
                MetaError::Io {
                    path: path.clone(),
                    source: std::io::Error::from_raw_os_error(if cfg!(windows) { 112 } else { 28 }),
                }
                .into(),
                "disk-full",
            ),
            (
                AppError::Settings(SettingsError::Io {
                    path: path.clone(),
                    source: std::io::ErrorKind::PermissionDenied.into(),
                }),
                "denied",
            ),
            (
                AppError::Export(ExportError::Io {
                    path: path.display().to_string(),
                    source: std::io::Error::from_raw_os_error(if cfg!(windows) { 5 } else { 13 }),
                }),
                "denied",
            ),
        ] {
            let text = error.to_string();
            let sent = code(error);
            assert_eq!(sent, serde_json::json!(expected), "{text}");
            assert!(!sent.as_str().unwrap().contains("Secret plan"));
        }
        // The errors meant for the person keep their text.
        assert_eq!(
            code(NotesError::InvalidTitle("must not be empty").into()),
            serde_json::json!("Invalid title: must not be empty")
        );
        assert_eq!(
            code(AppError::Export(ExportError::NotAPath)),
            serde_json::json!("The chosen location is not a file on this computer")
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
        use std::sync::atomic::AtomicBool;
        let dir = crate::test_support::TempDir::new("windows-saver");
        let store = crate::notes::NotesStore::new(
            &dir.path().join("notes"),
            Arc::new(AtomicBool::new(true)),
        );
        let meta = crate::meta::MetaStore::open(&dir.path().join("meta.json"));
        let service = Arc::new(NotesService::new(store, meta));
        let k = key(GENERAL_KEY, ID);
        let label = sticky_label(&k);
        let saver = BoundsSaver::start(service.clone());
        let first = Bounds {
            x: 10.0,
            y: 20.0,
            width: 300.0,
            height: 280.0,
        };
        let last = Bounds { x: 50.0, ..first };
        saver.moved(label.clone(), first);
        saver.moved(label.clone(), last);
        saver.flush(Some(&label));
        assert_eq!(service.meta().get(&k.scope, &k.id).bounds, Some(last));
        let later = Bounds { y: 99.0, ..last };
        saver.moved(label.clone(), later);
        std::thread::sleep(BOUNDS_DELAY + Duration::from_millis(400));
        assert_eq!(service.meta().get(&k.scope, &k.id).bounds, Some(later));
    }
}
