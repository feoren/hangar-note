//! `settings.json` in Hangar Note's data folder (ADR 0001): language, theme, the color of new
//! notes, the personal names of the colors (ADR 0002, "Color categories"), "Always on top" of
//! the notes area, the look of the windows (ADR 0004), and two things the notes area remembers
//! across restarts: whether its sidebar is open and the project its "Project" level showed last.
//! "Start with the system" is not stored here: it is the OS state itself (autostart plugin).

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::fsio::{lock, read_capped, write_atomic, StorageCode};
use crate::meta::NoteColor;

pub const SETTINGS_FILE: &str = "settings.json";
pub const SETTINGS_VERSION: u32 = 1;
/// The UI languages, the same twelve as `LANGUAGES` in `src/i18n.ts`.
pub const LANGUAGES: [&str; 12] = [
    "de", "en", "el", "es", "fr", "it", "ja", "pl", "pt", "ru", "tr", "zh",
];
const MAX_SETTINGS_BYTES: usize = 64 * 1024;
/// A color's own name is a short label for a chip, not a description.
pub const MAX_COLOR_NAME_CHARS: usize = 40;
/// The last project is a folder path the backend listed; longer ones are not real folders.
pub const MAX_PROJECT_PATH_CHARS: usize = 4096;
/// The sidebar's width in px: its default and the range a drag can give it (`src/sidebarWidth.ts`
/// holds the same numbers). A stored width outside the range is brought back into it.
pub const SIDEBAR_WIDTH_DEFAULT: u32 = 232;
pub const SIDEBAR_WIDTH_MIN: u32 = 180;
pub const SIDEBAR_WIDTH_MAX: u32 = 400;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

/// How the notes area and the sticky notes look (ADR 0004). A value this version does not know
/// (written by a newer one, or by hand) reads as [`Look::Calm`] instead of throwing away the whole
/// file, as an unknown theme would.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Look {
    #[default]
    Calm,
    Paper,
    Hangar,
}

impl<'de> Deserialize<'de> for Look {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        Ok(match value.as_str() {
            Some("paper") => Self::Paper,
            Some("hangar") => Self::Hangar,
            _ => Self::Calm,
        })
    }
}

/// What the windows read and change. `language: null` follows the system language.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub theme: Theme,
    #[serde(default)]
    pub new_note_color: NoteColor,
    /// The person's names of the colors ("Work", "Ideas"); a color without one shows its own name.
    #[serde(default)]
    pub color_names: BTreeMap<NoteColor, String>,
    /// The notes area stays above other windows ("Always on top"). Changed only through its own
    /// command (`set_hub_on_top`); [`SettingsStore::set`] keeps the stored value, so a window
    /// that sends its settings without this field never switches it off.
    #[serde(default)]
    pub hub_on_top: bool,
    /// The look of every window; switching it takes effect at once in all of them.
    #[serde(default)]
    pub look: Look,
    /// The notes area's sidebar is shown (wide windows). Open unless the person folded it away;
    /// a file without the field opens it. Changed only through `set_sidebar_open`, kept by
    /// [`SettingsStore::set`] like [`Settings::hub_on_top`].
    #[serde(default = "open_by_default")]
    pub sidebar_open: bool,
    /// The sidebar's width in px as the person dragged it; a file without the field, or with a
    /// value that is no width, gives the default. Changed only through `set_sidebar_width`.
    #[serde(default = "default_sidebar_width", deserialize_with = "tolerant_width")]
    pub sidebar_width: u32,
    /// The project the notes area's "Project" level showed last, for a start without a folder.
    /// Changed only through `set_last_project`, kept by [`SettingsStore::set`]; a stored value
    /// that is no valid project path reads as none.
    #[serde(default)]
    pub last_project: Option<PathBuf>,
}

fn open_by_default() -> bool {
    true
}

fn default_sidebar_width() -> u32 {
    SIDEBAR_WIDTH_DEFAULT
}

/// Any width brought into the range; anything that is no number is the default, so a hand-edited
/// file never loses its other settings over this field.
pub fn clamp_sidebar_width(width: u32) -> u32 {
    width.clamp(SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX)
}

fn tolerant_width<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(match value.as_f64() {
        Some(width) if width.is_finite() => {
            // Rounded and bounded before the cast, so it cannot overflow.
            clamp_sidebar_width(width.round().clamp(0.0, f64::from(u32::MAX)) as u32)
        }
        _ => SIDEBAR_WIDTH_DEFAULT,
    })
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            language: None,
            theme: Theme::default(),
            new_note_color: NoteColor::default(),
            color_names: BTreeMap::new(),
            hub_on_top: false,
            look: Look::default(),
            sidebar_open: true,
            sidebar_width: SIDEBAR_WIDTH_DEFAULT,
            last_project: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsFile {
    version: u32,
    #[serde(flatten)]
    settings: Settings,
}

#[derive(Debug, thiserror::Error)]
pub enum SettingsError {
    #[error("Unknown language")]
    UnknownLanguage,
    #[error("Invalid color name: at most {MAX_COLOR_NAME_CHARS} characters, no line breaks")]
    InvalidColorName,
    #[error("Invalid project: an absolute path of at most {MAX_PROJECT_PATH_CHARS} characters")]
    InvalidProject,
    /// Shown and logged without the path (security review B3).
    #[error("{}", crate::fsio::storage_log_io(path, source))]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

impl SettingsError {
    /// The fixed code of a failed write; the path stays in the log (`NotesError::storage_code`).
    pub fn storage_code(&self) -> Option<StorageCode> {
        match self {
            Self::Io { source, .. } => Some(StorageCode::of(source)),
            Self::UnknownLanguage | Self::InvalidColorName | Self::InvalidProject => None,
        }
    }

    /// The fixed code of every variant (security review B4).
    pub fn code(&self) -> &'static str {
        match self.storage_code() {
            Some(code) => code.as_str(),
            None => crate::notes::INVALID_CODE,
        }
    }
}

impl Serialize for SettingsError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.code())
    }
}

pub fn validate(settings: &Settings) -> Result<(), SettingsError> {
    if let Some(code) = &settings.language {
        if !LANGUAGES.contains(&code.as_str()) {
            return Err(SettingsError::UnknownLanguage);
        }
    }
    let bad_name = settings.color_names.values().any(|name| {
        name.trim() != name
            || name.is_empty()
            || name.chars().count() > MAX_COLOR_NAME_CHARS
            || name.chars().any(char::is_control)
    });
    if bad_name {
        return Err(SettingsError::InvalidColorName);
    }
    if let Some(project) = &settings.last_project {
        if !valid_project(project) {
            return Err(SettingsError::InvalidProject);
        }
    }
    Ok(())
}

/// A project folder as the backend lists it: absolute, of a sane length, without control
/// characters (the path is shown as a tooltip and written into `settings.json`).
pub fn valid_project(path: &Path) -> bool {
    let text = path.to_string_lossy();
    path.is_absolute()
        && text.chars().count() <= MAX_PROJECT_PATH_CHARS
        && !text.chars().any(char::is_control)
}

/// Color names as the window typed them: trimmed, empty ones removed (the color's own name shows).
pub fn tidy(mut settings: Settings) -> Settings {
    settings.color_names = settings
        .color_names
        .into_iter()
        .map(|(color, name)| (color, name.trim().to_owned()))
        .filter(|(_, name)| !name.is_empty())
        .collect();
    settings
}

/// The stored settings; a missing, unreadable or invalid file gives the defaults, so a broken
/// file never keeps the app from starting.
pub fn load(path: &Path) -> Settings {
    let bytes = match read_capped(path, MAX_SETTINGS_BYTES) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Settings::default(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Settings::default(),
        Err(error) => {
            eprintln!(
                "hangar-note: not read: {}",
                crate::fsio::storage_log_io(path, &error)
            );
            return Settings::default();
        }
    };
    match serde_json::from_slice::<SettingsFile>(&bytes) {
        Ok(file) if file.version == SETTINGS_VERSION => {
            let mut settings = tidy(file.settings);
            if let Some(code) = &settings.language {
                if !LANGUAGES.contains(&code.as_str()) {
                    settings.language = None;
                }
            }
            if settings
                .last_project
                .as_deref()
                .is_some_and(|project| !valid_project(project))
            {
                settings.last_project = None;
            }
            if validate(&settings).is_err() {
                settings.color_names.clear();
            }
            settings
        }
        _ => Settings::default(),
    }
}

pub fn save(path: &Path, settings: &Settings) -> Result<(), SettingsError> {
    validate(settings)?;
    let file = SettingsFile {
        version: SETTINGS_VERSION,
        settings: settings.clone(),
    };
    let io_error = |source| SettingsError::Io {
        path: path.to_path_buf(),
        source,
    };
    let bytes = serde_json::to_vec_pretty(&file).map_err(|e| io_error(io::Error::other(e)))?;
    write_atomic(path, &bytes).map_err(io_error)
}

/// The settings in memory, written through on every change.
#[derive(Debug)]
pub struct SettingsStore {
    path: PathBuf,
    current: Mutex<Settings>,
}

impl SettingsStore {
    pub fn open(dir: &Path) -> Self {
        let path = dir.join(SETTINGS_FILE);
        let current = Mutex::new(load(&path));
        Self { path, current }
    }

    pub fn get(&self) -> Settings {
        lock(&self.current).clone()
    }

    /// Everything but what the notes area changes through its own commands
    /// ([`Settings::hub_on_top`], [`Settings::sidebar_open`], [`Settings::sidebar_width`],
    /// [`Settings::last_project`]): those
    /// keep their stored values, since the settings page sends its settings without them.
    pub fn set(&self, settings: Settings) -> Result<Settings, SettingsError> {
        let mut settings = tidy(settings);
        let mut current = lock(&self.current);
        settings.hub_on_top = current.hub_on_top;
        settings.sidebar_open = current.sidebar_open;
        settings.sidebar_width = current.sidebar_width;
        settings.last_project = current.last_project.clone();
        save(&self.path, &settings)?;
        *current = settings.clone();
        Ok(settings)
    }

    /// One change to the stored settings, written through; nothing changes when the write fails.
    fn update(&self, change: impl FnOnce(&mut Settings)) -> Result<Settings, SettingsError> {
        let mut current = lock(&self.current);
        let mut settings = current.clone();
        change(&mut settings);
        save(&self.path, &settings)?;
        *current = settings.clone();
        Ok(settings)
    }

    /// Switches "Always on top" of the notes area and stores it.
    pub fn set_hub_on_top(&self, on_top: bool) -> Result<Settings, SettingsError> {
        self.update(|settings| settings.hub_on_top = on_top)
    }

    /// Shows or folds away the notes area's sidebar and stores it.
    pub fn set_sidebar_open(&self, open: bool) -> Result<Settings, SettingsError> {
        self.update(|settings| settings.sidebar_open = open)
    }

    /// Stores the sidebar's width, brought into its range first.
    pub fn set_sidebar_width(&self, width: u32) -> Result<Settings, SettingsError> {
        self.update(|settings| settings.sidebar_width = clamp_sidebar_width(width))
    }

    /// Remembers the project the "Project" level shows; `None` forgets it.
    pub fn set_last_project(&self, project: Option<PathBuf>) -> Result<Settings, SettingsError> {
        self.update(|settings| settings.last_project = project)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use std::fs;

    #[test]
    fn defaults_without_a_file_and_a_round_trip() {
        let dir = TempDir::new("settings-roundtrip");
        let store = SettingsStore::open(dir.path());
        assert_eq!(store.get(), Settings::default());
        let changed = Settings {
            language: Some("pl".into()),
            theme: Theme::Dark,
            new_note_color: NoteColor::Mint,
            color_names: BTreeMap::from([(NoteColor::Sky, "Arbeit".to_owned())]),
            hub_on_top: false,
            look: Look::Paper,
            sidebar_open: true,
            sidebar_width: SIDEBAR_WIDTH_DEFAULT,
            last_project: None,
        };
        store.set(changed.clone()).unwrap();
        assert_eq!(SettingsStore::open(dir.path()).get(), changed);
        let json: serde_json::Value =
            serde_json::from_slice(&fs::read(store.path()).unwrap()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "version": 1, "language": "pl", "theme": "dark", "newNoteColor": "mint",
                "colorNames": { "sky": "Arbeit" }, "hubOnTop": false, "look": "paper",
                "sidebarOpen": true, "sidebarWidth": 232, "lastProject": null
            })
        );
    }

    #[test]
    fn always_on_top_of_the_notes_area_has_its_own_switch() {
        let dir = TempDir::new("settings-on-top");
        let store = SettingsStore::open(dir.path());
        assert!(!store.get().hub_on_top);
        let saved = store.set_hub_on_top(true).unwrap();
        assert!(saved.hub_on_top);
        assert!(SettingsStore::open(dir.path()).get().hub_on_top);
        // The other settings, sent without it or with another value, keep it.
        let other = Settings {
            theme: Theme::Light,
            hub_on_top: false,
            ..Settings::default()
        };
        let saved = store.set(other).unwrap();
        assert!(saved.hub_on_top);
        assert_eq!(saved.theme, Theme::Light);
        let sent: Settings = serde_json::from_str(r#"{"theme":"dark"}"#).unwrap();
        assert!(store.set(sent).unwrap().hub_on_top);
        assert!(!store.set_hub_on_top(false).unwrap().hub_on_top);
        assert_eq!(load(store.path()).theme, Theme::Dark);
    }

    #[test]
    fn unknown_languages_are_refused_and_dropped_on_load() {
        let dir = TempDir::new("settings-language");
        let store = SettingsStore::open(dir.path());
        let bad = Settings {
            language: Some("../x".into()),
            ..Settings::default()
        };
        assert!(matches!(
            store.set(bad),
            Err(SettingsError::UnknownLanguage)
        ));
        assert_eq!(store.get(), Settings::default());
        fs::write(
            store.path(),
            r#"{"version":1,"language":"xx","theme":"light","newNoteColor":"sky"}"#,
        )
        .unwrap();
        let loaded = load(store.path());
        assert_eq!(loaded.language, None);
        assert_eq!(loaded.theme, Theme::Light);
        assert_eq!(loaded.new_note_color, NoteColor::Sky);
    }

    #[test]
    fn color_names_are_short_single_lines() {
        let dir = TempDir::new("settings-names");
        let store = SettingsStore::open(dir.path());
        let named = |name: &str| Settings {
            color_names: BTreeMap::from([(NoteColor::Mint, name.to_owned())]),
            ..Settings::default()
        };
        assert!(matches!(
            store.set(named(
                "a
b"
            )),
            Err(SettingsError::InvalidColorName)
        ));
        assert!(matches!(
            store.set(named(&"x".repeat(MAX_COLOR_NAME_CHARS + 1))),
            Err(SettingsError::InvalidColorName)
        ));
        // Blank means "no own name"; outer spaces go.
        assert!(store.set(named("  ")).unwrap().color_names.is_empty());
        let saved = store.set(named(" Ideen ")).unwrap();
        assert_eq!(saved.color_names[&NoteColor::Mint], "Ideen");
        // Files from v1 without names still load.
        fs::write(store.path(), r#"{"version":1,"theme":"dark"}"#).unwrap();
        assert!(load(store.path()).color_names.is_empty());
    }

    #[test]
    fn the_look_is_read_written_and_falls_back_to_calm() {
        let dir = TempDir::new("settings-look");
        let store = SettingsStore::open(dir.path());
        assert_eq!(store.get().look, Look::Calm);
        for look in [Look::Hangar, Look::Paper, Look::Calm] {
            let saved = store
                .set(Settings {
                    look,
                    ..Settings::default()
                })
                .unwrap();
            assert_eq!(saved.look, look);
            assert_eq!(load(store.path()).look, look);
        }
        let sent: Settings = serde_json::from_str(r#"{"look":"hangar"}"#).unwrap();
        assert_eq!(sent.look, Look::Hangar);
        // A look this version does not know, or no look at all, is the calm one; the rest of the
        // file stays.
        for text in [
            r#"{"version":1,"theme":"dark","look":"neon"}"#,
            r#"{"version":1,"theme":"dark","look":7}"#,
            r#"{"version":1,"theme":"dark","look":null}"#,
            r#"{"version":1,"theme":"dark"}"#,
        ] {
            fs::write(store.path(), text).unwrap();
            let loaded = load(store.path());
            assert_eq!(loaded.look, Look::Calm, "{text}");
            assert_eq!(loaded.theme, Theme::Dark, "{text}");
        }
        // The other settings and "Always on top" keep the look.
        store
            .set(Settings {
                look: Look::Hangar,
                ..Settings::default()
            })
            .unwrap();
        assert_eq!(store.set_hub_on_top(true).unwrap().look, Look::Hangar);
    }

    fn project() -> PathBuf {
        PathBuf::from(if cfg!(windows) {
            r"C:\Projects\website"
        } else {
            "/projects/website"
        })
    }

    #[test]
    fn the_sidebar_is_open_by_default_and_remembers_being_folded() {
        let dir = TempDir::new("settings-sidebar");
        let store = SettingsStore::open(dir.path());
        assert!(store.get().sidebar_open);
        assert!(!store.set_sidebar_open(false).unwrap().sidebar_open);
        assert!(!SettingsStore::open(dir.path()).get().sidebar_open);
        // The settings page sends its settings without the field; the folded sidebar stays.
        let sent: Settings = serde_json::from_str(r#"{"theme":"dark"}"#).unwrap();
        assert!(sent.sidebar_open);
        assert!(!store.set(sent).unwrap().sidebar_open);
        assert!(store.set_sidebar_open(true).unwrap().sidebar_open);
        // Files written before the field existed open it.
        fs::write(store.path(), r#"{"version":1,"theme":"dark"}"#).unwrap();
        assert!(load(store.path()).sidebar_open);
        fs::write(store.path(), r#"{"version":1,"sidebarOpen":false}"#).unwrap();
        assert!(!load(store.path()).sidebar_open);
    }

    #[test]
    fn the_sidebar_width_is_kept_within_its_range() {
        let dir = TempDir::new("settings-width");
        let store = SettingsStore::open(dir.path());
        assert_eq!(store.get().sidebar_width, SIDEBAR_WIDTH_DEFAULT);
        assert_eq!(store.set_sidebar_width(300).unwrap().sidebar_width, 300);
        assert_eq!(SettingsStore::open(dir.path()).get().sidebar_width, 300);
        assert_eq!(
            store.set_sidebar_width(20).unwrap().sidebar_width,
            SIDEBAR_WIDTH_MIN
        );
        assert_eq!(
            store.set_sidebar_width(5000).unwrap().sidebar_width,
            SIDEBAR_WIDTH_MAX
        );
        // The settings page and the open state keep it.
        store.set_sidebar_width(260).unwrap();
        let sent: Settings = serde_json::from_str(r#"{"theme":"dark"}"#).unwrap();
        assert_eq!(store.set(sent).unwrap().sidebar_width, 260);
        assert_eq!(store.set_sidebar_open(false).unwrap().sidebar_width, 260);
        // Stored by hand: out of range, a fraction, no number, or missing; the rest stays.
        for (text, width) in [
            (
                r#"{"version":1,"theme":"dark","sidebarWidth":9999}"#,
                SIDEBAR_WIDTH_MAX,
            ),
            (
                r#"{"version":1,"theme":"dark","sidebarWidth":-3}"#,
                SIDEBAR_WIDTH_MIN,
            ),
            (r#"{"version":1,"theme":"dark","sidebarWidth":250.6}"#, 251),
            (
                r#"{"version":1,"theme":"dark","sidebarWidth":"wide"}"#,
                SIDEBAR_WIDTH_DEFAULT,
            ),
            (
                r#"{"version":1,"theme":"dark","sidebarWidth":null}"#,
                SIDEBAR_WIDTH_DEFAULT,
            ),
            (r#"{"version":1,"theme":"dark"}"#, SIDEBAR_WIDTH_DEFAULT),
        ] {
            fs::write(store.path(), text).unwrap();
            let loaded = load(store.path());
            assert_eq!(loaded.sidebar_width, width, "{text}");
            assert_eq!(loaded.theme, Theme::Dark, "{text}");
        }
    }

    #[test]
    fn the_last_project_is_kept_and_only_as_a_valid_path() {
        let dir = TempDir::new("settings-project");
        let store = SettingsStore::open(dir.path());
        assert_eq!(store.get().last_project, None);
        let saved = store.set_last_project(Some(project())).unwrap();
        assert_eq!(saved.last_project, Some(project()));
        assert_eq!(
            SettingsStore::open(dir.path()).get().last_project,
            Some(project())
        );
        // The settings page and the other switches keep it.
        let sent: Settings = serde_json::from_str(r#"{"look":"paper"}"#).unwrap();
        assert_eq!(store.set(sent).unwrap().last_project, Some(project()));
        assert_eq!(
            store.set_sidebar_open(false).unwrap().last_project,
            Some(project())
        );
        // A relative path, a control character or an endless path is refused; nothing changes.
        for bad in [
            PathBuf::from("relative"),
            project().join("a\nb"),
            project().join("x".repeat(MAX_PROJECT_PATH_CHARS)),
        ] {
            assert!(matches!(
                store.set_last_project(Some(bad)),
                Err(SettingsError::InvalidProject)
            ));
        }
        assert_eq!(store.get().last_project, Some(project()));
        assert_eq!(store.set_last_project(None).unwrap().last_project, None);
        // A stored value that is no absolute path reads as none; the rest of the file stays.
        fs::write(
            store.path(),
            r#"{"version":1,"theme":"dark","lastProject":"relative"}"#,
        )
        .unwrap();
        let loaded = load(store.path());
        assert_eq!(loaded.last_project, None);
        assert_eq!(loaded.theme, Theme::Dark);
    }

    #[test]
    fn a_corrupt_file_gives_the_defaults() {
        let dir = TempDir::new("settings-corrupt");
        let path = dir.path().join(SETTINGS_FILE);
        for text in ["{", r#"{"version":7}"#, r#"{"version":1,"theme":"neon"}"#] {
            fs::write(&path, text).unwrap();
            assert_eq!(load(&path), Settings::default(), "{text}");
        }
    }
}
