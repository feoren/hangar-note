//! `settings.json` next to the notes (ADR 0001): language, theme and the color of new notes.
//! "Start with the system" is not stored here: it is the OS state itself (autostart plugin).

use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use serde::{Deserialize, Serialize, Serializer};

use crate::store::{read_capped, write_atomic, NoteColor};

pub const SETTINGS_FILE: &str = "settings.json";
pub const SETTINGS_VERSION: u32 = 1;
/// The UI languages, the same twelve as `LANGUAGES` in `src/i18n.ts`.
pub const LANGUAGES: [&str; 12] = [
    "de", "en", "el", "es", "fr", "it", "ja", "pl", "pt", "ru", "tr", "zh",
];
const MAX_SETTINGS_BYTES: usize = 64 * 1024;

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
    #[error("File {path} cannot be written: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

impl Serialize for SettingsError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub fn validate(settings: &Settings) -> Result<(), SettingsError> {
    match &settings.language {
        Some(code) if !LANGUAGES.contains(&code.as_str()) => Err(SettingsError::UnknownLanguage),
        _ => Ok(()),
    }
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
            let mut settings = file.settings;
            if validate(&settings).is_err() {
                settings.language = None;
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
        self.current
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    pub fn set(&self, settings: Settings) -> Result<Settings, SettingsError> {
        let mut current = self.current.lock().unwrap_or_else(PoisonError::into_inner);
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
        };
        store.set(changed.clone()).unwrap();
        assert_eq!(SettingsStore::open(dir.path()).get(), changed);
        let json: serde_json::Value =
            serde_json::from_slice(&fs::read(store.path()).unwrap()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "version": 1, "language": "pl", "theme": "dark", "newNoteColor": "mint"
            })
        );
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
    fn a_corrupt_file_gives_the_defaults() {
        let dir = TempDir::new("settings-corrupt");
        let path = dir.path().join(SETTINGS_FILE);
        for text in ["{", r#"{"version":7}"#, r#"{"version":1,"theme":"neon"}"#] {
            fs::write(&path, text).unwrap();
            assert_eq!(load(&path), Settings::default(), "{text}");
        }
    }
}
