//! `settings.json` in Hangar Note's data folder (ADR 0001): language, theme, the color of new
//! notes, the personal names of the colors (ADR 0002, "Color categories") and "Always on top" of
//! the notes area. "Start with the system" is not stored here: it is the OS state itself
//! (autostart plugin).

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize, Serializer};

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

/// What the windows read and change. `language: null` follows the system language.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
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
    #[error("File {path} cannot be written: {source}")]
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
            Self::UnknownLanguage | Self::InvalidColorName => None,
        }
    }
}

impl Serialize for SettingsError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self.storage_code() {
            Some(code) => serializer.serialize_str(code.as_str()),
            None => serializer.serialize_str(&self.to_string()),
        }
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
    Ok(())
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
            eprintln!("hangar-note: settings not read: {error}");
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

    /// Everything but [`Settings::hub_on_top`], which keeps its stored value.
    pub fn set(&self, settings: Settings) -> Result<Settings, SettingsError> {
        let mut settings = tidy(settings);
        let mut current = lock(&self.current);
        settings.hub_on_top = current.hub_on_top;
        save(&self.path, &settings)?;
        *current = settings.clone();
        Ok(settings)
    }

    /// Switches "Always on top" of the notes area and stores it.
    pub fn set_hub_on_top(&self, on_top: bool) -> Result<Settings, SettingsError> {
        let mut current = lock(&self.current);
        let settings = Settings {
            hub_on_top: on_top,
            ..current.clone()
        };
        save(&self.path, &settings)?;
        *current = settings.clone();
        Ok(settings)
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
        };
        store.set(changed.clone()).unwrap();
        assert_eq!(SettingsStore::open(dir.path()).get(), changed);
        let json: serde_json::Value =
            serde_json::from_slice(&fs::read(store.path()).unwrap()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "version": 1, "language": "pl", "theme": "dark", "newNoteColor": "mint",
                "colorNames": { "sky": "Arbeit" }, "hubOnTop": false
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
    fn a_corrupt_file_gives_the_defaults() {
        let dir = TempDir::new("settings-corrupt");
        let path = dir.path().join(SETTINGS_FILE);
        for text in ["{", r#"{"version":7}"#, r#"{"version":1,"theme":"neon"}"#] {
            fs::write(&path, text).unwrap();
            assert_eq!(load(&path), Settings::default(), "{text}");
        }
    }
}
