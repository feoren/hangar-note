//! What Hangar Note knows about Hangar Drive, as explicit types, and the view the windows get
//! (`drive_sync_status`, event `drive-sync-changed`).
//!
//! [`Link`] is the connection: absent, installed but not running, or running with the last
//! proven [`DriveStatus`]. [`phase_of`] maps it to the one [`Phase`] the windows show. Pure, so
//! every transition is testable without a socket.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

/// The phase the windows show.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    /// Drive is not installed, or the notes folder is not the one Drive syncs (a development
    /// root): nothing to show.
    Absent,
    /// Installed, but its server does not run or did not prove itself.
    NotRunning,
    /// Drive's account is not set up yet.
    Setup,
    /// Hangar Note asked; Drive waits for the notes folder before it shows its card.
    Waiting,
    /// Hangar Note asked; Drive shows its card and waits for the person.
    Asked,
    /// The notes sync.
    Active,
    /// Consent was given, but the folder is missing or refused.
    Unavailable,
    /// The person said no (or ended the sync in Drive).
    Declined,
    /// Drive's account needs the person (device removed, app too old, recovery pending).
    Attention,
}

/// Why the notes folder cannot be synced, with [`Phase::Waiting`] and [`Phase::Unavailable`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Reason {
    Missing,
    Refused,
    HangarTooOld,
}

impl Reason {
    /// A `reason` of the contract; an unknown one is shown like none (section 9).
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "missing" => Some(Self::Missing),
            "refused" => Some(Self::Refused),
            "hangarTooOld" => Some(Self::HangarTooOld),
            _ => None,
        }
    }
}

/// `account` of `/v1/status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Account {
    NotSetUp,
    Ready,
    NeedsAttention,
    /// A value this build does not know. A new value would be a breaking change of the contract,
    /// so it is shown as needing the person rather than guessed.
    Unknown,
}

impl Account {
    pub fn parse(text: &str) -> Self {
        match text {
            "notSetUp" => Self::NotSetUp,
            "ready" => Self::Ready,
            "needsAttention" => Self::NeedsAttention,
            _ => Self::Unknown,
        }
    }
}

/// `notes.state` of `/v1/status` and `state` of `/v1/folders/request`, with their fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotesState {
    None,
    WaitingForFolder(Option<Reason>),
    Requested,
    Active {
        folder_name: Option<String>,
        last_sync_ms: Option<u64>,
    },
    Unavailable(Option<Reason>),
    Declined,
    /// A state this build does not know (a breaking change of the contract): shown as
    /// unavailable, and never treated as active.
    Unknown,
}

impl NotesState {
    /// The state named `state`, with `reason` where the contract has one.
    pub fn parse(
        state: &str,
        reason: Option<&str>,
        folder_name: Option<String>,
        last_sync_ms: Option<u64>,
    ) -> Self {
        let reason = reason.and_then(Reason::parse);
        match state {
            "none" => Self::None,
            "waitingForFolder" => Self::WaitingForFolder(reason),
            "requested" => Self::Requested,
            "active" => Self::Active {
                folder_name,
                last_sync_ms,
            },
            "unavailable" => Self::Unavailable(reason),
            "declined" => Self::Declined,
            _ => Self::Unknown,
        }
    }
}

/// The parts of `/v1/status` Hangar Note uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriveStatus {
    pub account: Account,
    pub notes: NotesState,
}

impl DriveStatus {
    /// Only an active notes folder answers `items/status`.
    pub fn notes_active(&self) -> bool {
        matches!(self.notes, NotesState::Active { .. })
    }

    /// Hangar Note sends `folders/request` once, when Drive has no consent state yet. Drive
    /// takes it also before setup (the card follows after setup).
    pub fn wants_request(&self) -> bool {
        self.notes == NotesState::None
    }
}

/// The connection to Drive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Link {
    Absent,
    NotRunning,
    Running(DriveStatus),
}

/// What the windows show, without the per note marks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shown {
    pub phase: Phase,
    pub reason: Option<Reason>,
    pub folder_name: Option<String>,
    pub last_sync_ms: Option<u64>,
}

impl Shown {
    fn phase(phase: Phase) -> Self {
        Self {
            phase,
            reason: None,
            folder_name: None,
            last_sync_ms: None,
        }
    }

    fn with_reason(phase: Phase, reason: Option<Reason>) -> Self {
        Self {
            reason,
            ..Self::phase(phase)
        }
    }
}

/// The phase of a link. The account comes first: before setup or while it needs the person,
/// nothing about the notes folder can move.
pub fn phase_of(link: &Link) -> Shown {
    let status = match link {
        Link::Absent => return Shown::phase(Phase::Absent),
        Link::NotRunning => return Shown::phase(Phase::NotRunning),
        Link::Running(status) => status,
    };
    match status.account {
        Account::NotSetUp => return Shown::phase(Phase::Setup),
        Account::NeedsAttention | Account::Unknown => return Shown::phase(Phase::Attention),
        Account::Ready => {}
    }
    match &status.notes {
        // Hangar Note asks by itself as soon as it sees `none`, so `none` lasts only until its
        // request lands (a failed one is retried with backoff).
        NotesState::None | NotesState::Requested => Shown::phase(Phase::Asked),
        NotesState::WaitingForFolder(reason) => Shown::with_reason(Phase::Waiting, *reason),
        NotesState::Active {
            folder_name,
            last_sync_ms,
        } => Shown {
            folder_name: folder_name.clone(),
            last_sync_ms: *last_sync_ms,
            ..Shown::phase(Phase::Active)
        },
        NotesState::Unavailable(reason) => Shown::with_reason(Phase::Unavailable, *reason),
        NotesState::Unknown => Shown::phase(Phase::Unavailable),
        NotesState::Declined => Shown::phase(Phase::Declined),
    }
}

/// The view of `drive_sync_status` and the payload of `drive-sync-changed`. Fields without a
/// value are left out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveSyncView {
    pub phase: Phase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<Reason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_sync_ms: Option<u64>,
    /// Per folder key (as in `FolderInfo` and `NoteInfo`), the IDs of the notes Drive answered
    /// `synced` for, sorted.
    pub synced: BTreeMap<String, Vec<String>>,
}

impl DriveSyncView {
    pub fn absent() -> Self {
        Self::of(phase_of(&Link::Absent), &Marks::default())
    }

    /// The view of what is shown plus the marks; marks count only while the notes are active.
    pub fn of(shown: Shown, marks: &Marks) -> Self {
        let synced = if shown.phase == Phase::Active {
            marks.by_scope()
        } else {
            BTreeMap::new()
        };
        Self {
            phase: shown.phase,
            reason: shown.reason,
            folder_name: shown.folder_name,
            last_sync_ms: shown.last_sync_ms,
            synced,
        }
    }
}

/// A note as the marks know it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteRef {
    pub scope: String,
    pub id: String,
}

/// The per note state: every active note by its contract path, and the paths Drive answered
/// `synced` for.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Marks {
    notes: BTreeMap<String, NoteRef>,
    synced: BTreeSet<String>,
}

impl Marks {
    pub fn note(&self, path: &str) -> Option<&NoteRef> {
        self.notes.get(path)
    }

    pub fn paths(&self) -> impl Iterator<Item = &String> {
        self.notes.keys()
    }

    pub fn paths_in(&self, scope: &str) -> Vec<String> {
        self.notes
            .iter()
            .filter(|(_, note)| note.scope == scope)
            .map(|(path, _)| path.clone())
            .collect()
    }

    /// Replaces every note with `notes`; marks of paths that stay are kept.
    pub fn replace_all(&mut self, notes: BTreeMap<String, NoteRef>) {
        self.synced.retain(|path| notes.contains_key(path));
        self.notes = notes;
    }

    /// Replaces the notes of `scope` with `notes`; marks of paths that stay are kept.
    pub fn replace_scope(&mut self, scope: &str, notes: BTreeMap<String, NoteRef>) {
        self.notes.retain(|_, note| note.scope != scope);
        self.notes.extend(notes);
        let known = &self.notes;
        self.synced.retain(|path| known.contains_key(path));
    }

    /// Records Drive's answer for `path`; a path that is no known note is ignored.
    pub fn set(&mut self, path: &str, synced: bool) {
        if !self.notes.contains_key(path) {
            return;
        }
        if synced {
            self.synced.insert(path.to_owned());
        } else {
            self.synced.remove(path);
        }
    }

    pub fn clear_marks(&mut self) {
        self.synced.clear();
    }

    pub fn clear(&mut self) {
        self.notes.clear();
        self.synced.clear();
    }

    pub fn by_scope(&self) -> BTreeMap<String, Vec<String>> {
        let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for path in &self.synced {
            if let Some(note) = self.notes.get(path) {
                out.entry(note.scope.clone())
                    .or_default()
                    .push(note.id.clone());
            }
        }
        for ids in out.values_mut() {
            ids.sort();
            ids.dedup();
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn running(account: Account, notes: NotesState) -> Link {
        Link::Running(DriveStatus { account, notes })
    }

    #[test]
    fn every_link_maps_to_one_phase() {
        let active = NotesState::Active {
            folder_name: Some("Hangar Note".into()),
            last_sync_ms: Some(1_764_240_000_000),
        };
        let cases = [
            (Link::Absent, Phase::Absent, None),
            (Link::NotRunning, Phase::NotRunning, None),
            (
                running(Account::NotSetUp, active.clone()),
                Phase::Setup,
                None,
            ),
            (
                running(Account::NotSetUp, NotesState::None),
                Phase::Setup,
                None,
            ),
            (
                running(Account::NeedsAttention, active.clone()),
                Phase::Attention,
                None,
            ),
            (
                running(Account::Unknown, active.clone()),
                Phase::Attention,
                None,
            ),
            (
                running(Account::Ready, NotesState::None),
                Phase::Asked,
                None,
            ),
            (
                running(Account::Ready, NotesState::Requested),
                Phase::Asked,
                None,
            ),
            (
                running(
                    Account::Ready,
                    NotesState::WaitingForFolder(Some(Reason::Missing)),
                ),
                Phase::Waiting,
                Some(Reason::Missing),
            ),
            (
                running(
                    Account::Ready,
                    NotesState::Unavailable(Some(Reason::HangarTooOld)),
                ),
                Phase::Unavailable,
                Some(Reason::HangarTooOld),
            ),
            (
                running(Account::Ready, NotesState::Unavailable(None)),
                Phase::Unavailable,
                None,
            ),
            (
                running(Account::Ready, NotesState::Unknown),
                Phase::Unavailable,
                None,
            ),
            (
                running(Account::Ready, NotesState::Declined),
                Phase::Declined,
                None,
            ),
            (running(Account::Ready, active), Phase::Active, None),
        ];
        for (link, phase, reason) in cases {
            let shown = phase_of(&link);
            assert_eq!(shown.phase, phase, "{link:?}");
            assert_eq!(shown.reason, reason, "{link:?}");
            if phase == Phase::Active {
                assert_eq!(shown.folder_name.as_deref(), Some("Hangar Note"));
                assert_eq!(shown.last_sync_ms, Some(1_764_240_000_000));
            } else {
                assert_eq!(shown.folder_name, None, "{link:?}");
            }
        }
    }

    #[test]
    fn contract_values_parse_and_unknown_ones_degrade() {
        assert_eq!(Reason::parse("refused"), Some(Reason::Refused));
        assert_eq!(Reason::parse("somethingNew"), None);
        assert_eq!(Account::parse("ready"), Account::Ready);
        assert_eq!(Account::parse("Ready"), Account::Unknown);
        assert_eq!(
            NotesState::parse("waitingForFolder", Some("future"), None, None),
            NotesState::WaitingForFolder(None)
        );
        assert_eq!(
            NotesState::parse("unavailable", Some("missing"), None, None),
            NotesState::Unavailable(Some(Reason::Missing))
        );
        assert_eq!(
            NotesState::parse("paused", None, None, None),
            NotesState::Unknown
        );
        assert_eq!(
            NotesState::parse("active", None, Some("N".into()), Some(5)),
            NotesState::Active {
                folder_name: Some("N".into()),
                last_sync_ms: Some(5)
            }
        );
    }

    #[test]
    fn only_none_asks_and_only_active_is_queried() {
        let status = |notes| DriveStatus {
            account: Account::Ready,
            notes,
        };
        assert!(status(NotesState::None).wants_request());
        for notes in [
            NotesState::Requested,
            NotesState::Declined,
            NotesState::WaitingForFolder(None),
            NotesState::Unavailable(None),
            NotesState::Unknown,
        ] {
            assert!(!status(notes.clone()).wants_request(), "{notes:?}");
            assert!(!status(notes.clone()).notes_active(), "{notes:?}");
        }
        assert!(status(NotesState::Active {
            folder_name: None,
            last_sync_ms: None
        })
        .notes_active());
    }

    fn note(scope: &str, id: &str) -> NoteRef {
        NoteRef {
            scope: scope.into(),
            id: id.into(),
        }
    }

    #[test]
    fn marks_follow_the_notes_and_show_only_while_active() {
        let mut marks = Marks::default();
        marks.replace_all(BTreeMap::from([
            ("general/A.md".to_owned(), note("general", "id-a")),
            ("general/B.md".to_owned(), note("general", "id-b")),
            ("k/C.md".to_owned(), note("k", "id-c")),
        ]));
        marks.set("general/A.md", true);
        marks.set("k/C.md", true);
        marks.set("general/unknown.md", true);
        let active = Shown {
            phase: Phase::Active,
            reason: None,
            folder_name: None,
            last_sync_ms: None,
        };
        let view = DriveSyncView::of(active.clone(), &marks);
        assert_eq!(
            view.synced,
            BTreeMap::from([
                ("general".to_owned(), vec!["id-a".to_owned()]),
                ("k".to_owned(), vec!["id-c".to_owned()]),
            ])
        );
        // A rename in one scope drops the old path's mark and keeps the others.
        marks.replace_scope(
            "general",
            BTreeMap::from([("general/A2.md".to_owned(), note("general", "id-a"))]),
        );
        assert_eq!(
            DriveSyncView::of(active.clone(), &marks).synced,
            BTreeMap::from([("k".to_owned(), vec!["id-c".to_owned()])])
        );
        marks.set("k/C.md", false);
        assert!(DriveSyncView::of(active, &marks).synced.is_empty());
        marks.set("general/A2.md", true);
        let declined = phase_of(&running(Account::Ready, NotesState::Declined));
        assert!(DriveSyncView::of(declined, &marks).synced.is_empty());
    }

    #[test]
    fn the_view_has_the_documented_shape() {
        let mut marks = Marks::default();
        marks.replace_all(BTreeMap::from([(
            "general/A.md".to_owned(),
            note("general", "id-a"),
        )]));
        marks.set("general/A.md", true);
        let active = phase_of(&running(
            Account::Ready,
            NotesState::Active {
                folder_name: Some("Hangar Note".into()),
                last_sync_ms: Some(42),
            },
        ));
        assert_eq!(
            serde_json::to_value(DriveSyncView::of(active, &marks)).unwrap(),
            serde_json::json!({
                "phase": "active",
                "folderName": "Hangar Note",
                "lastSyncMs": 42,
                "synced": { "general": ["id-a"] }
            })
        );
        let waiting = phase_of(&running(
            Account::Ready,
            NotesState::WaitingForFolder(Some(Reason::HangarTooOld)),
        ));
        assert_eq!(
            serde_json::to_value(DriveSyncView::of(waiting, &marks)).unwrap(),
            serde_json::json!({ "phase": "waiting", "reason": "hangarTooOld", "synced": {} })
        );
        assert_eq!(
            serde_json::to_value(DriveSyncView::absent()).unwrap(),
            serde_json::json!({ "phase": "absent", "synced": {} })
        );
        for (link, name) in [
            (Link::NotRunning, "notRunning"),
            (running(Account::NotSetUp, NotesState::None), "setup"),
            (
                running(Account::NeedsAttention, NotesState::None),
                "attention",
            ),
            (running(Account::Ready, NotesState::Requested), "asked"),
            (running(Account::Ready, NotesState::Declined), "declined"),
            (
                running(Account::Ready, NotesState::Unavailable(None)),
                "unavailable",
            ),
        ] {
            let value = serde_json::to_value(DriveSyncView::of(phase_of(&link), &marks)).unwrap();
            assert_eq!(value["phase"], name);
        }
    }
}
