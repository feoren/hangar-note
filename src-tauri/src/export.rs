//! Saving a note as a `.md` file the person chooses. Taken from Hangar's `export.rs` and
//! `text.rs` (MIT, same owner): the backend opens the save dialog itself, so the window never
//! chooses where a file goes; this module holds the parts without a dialog.

use std::path::Path;

use crate::fsio::{write_atomic, StorageCode};
use crate::naming::{is_reserved_on_windows, without_invisible, FORBIDDEN_CHARS, JOINERS};
use crate::notes::MAX_NOTE_BYTES;

pub const NOTE_EXTENSION: &str = "md";
pub const NOTE_FILTER: &str = "Markdown";
/// File name without extension, in characters.
const MAX_STEM_CHARS: usize = 100;
const FALLBACK_STEM: &str = "note";

/// A file name for a note title that is valid on Windows, macOS and Linux, by the shared naming
/// rule (`naming.rs`): no path separators or characters Windows forbids, no control or invisible
/// characters, no leading or trailing dots and spaces, no reserved device name, at most
/// [`MAX_STEM_CHARS`], then `.md`.
pub fn note_file_name(title: &str) -> String {
    let mut stem: String = without_invisible(title)
        .chars()
        .map(|c| match c {
            c if FORBIDDEN_CHARS.contains(c) => '_',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let suffix = format!(".{NOTE_EXTENSION}");
    if stem.to_ascii_lowercase().ends_with(&suffix) {
        stem.truncate(stem.len() - suffix.len());
    }
    let mut stem: String = stem
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|c: char| c == '.' || c.is_whitespace())
        .chars()
        .take(MAX_STEM_CHARS)
        .collect();
    // A joiner the length limit cut off from its second character would end the name unseen.
    stem = stem
        .trim_end_matches(|c: char| c == '.' || c == ' ' || JOINERS.contains(&c))
        .to_owned();
    if stem.is_empty() {
        stem = FALLBACK_STEM.to_owned();
    }
    if is_reserved_on_windows(&stem) {
        stem.insert(0, '_');
    }
    format!("{stem}{suffix}")
}

#[derive(Debug, thiserror::Error)]
pub enum ExportError {
    #[error("Too large to export: {size} bytes, at most {max} allowed")]
    TooLarge { size: usize, max: usize },
    /// The chosen path stays out of the text and the log (security review B3).
    #[error("Export not written ({})", crate::fsio::log_cause(source))]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("The chosen location is not a file on this computer")]
    NotAPath,
}

impl ExportError {
    /// The fixed code the window gets; the path stays in the log (`NotesError::storage_code`).
    pub fn storage_code(&self) -> Option<StorageCode> {
        match self {
            Self::TooLarge { .. } => Some(StorageCode::TooLarge),
            Self::Io { source, .. } => Some(StorageCode::of(source)),
            Self::NotAPath => None,
        }
    }
}

/// Writes the content to the chosen file: temporary file next to it, then rename, so an existing
/// file is either replaced completely or left as it was.
pub fn write(path: &Path, content: &str) -> Result<(), ExportError> {
    if content.len() > MAX_NOTE_BYTES {
        return Err(ExportError::TooLarge {
            size: content.len(),
            max: MAX_NOTE_BYTES,
        });
    }
    write_atomic(path, content.as_bytes()).map_err(|source| ExportError::Io {
        path: path.display().to_string(),
        source,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn titles_become_safe_file_names() {
        assert_eq!(note_file_name("Plan: Q4/2026"), "Plan_ Q4_2026.md");
        assert_eq!(note_file_name("notes.MD"), "notes.md");
        assert_eq!(
            note_file_name("..\\..\\Windows\\evil"),
            "_.._Windows_evil.md"
        );
        assert_eq!(note_file_name("  ..hidden.. "), "hidden.md");
        assert_eq!(note_file_name("line\r\nbreak"), "line break.md");
        assert_eq!(note_file_name("a\u{202E}dm.exe"), "adm.exe.md");
        assert_eq!(note_file_name(""), "note.md");
        assert_eq!(note_file_name("Größe 😀"), "Größe 😀.md");
        // Emoji sequences keep their joiners and selectors, Latin letters never get one.
        assert_eq!(
            note_file_name("\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467} \u{2764}\u{FE0F}"),
            "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467} \u{2764}\u{FE0F}.md"
        );
        assert_eq!(note_file_name("ad\u{200D}min\u{200B}"), "admin.md");
        let start = "x".repeat(MAX_STEM_CHARS - 2);
        assert_eq!(
            note_file_name(&format!("{start}\u{1F468}\u{200D}\u{1F4BB}")),
            format!("{start}\u{1F468}.md")
        );
        for reserved in ["CON", "nul", "Com1", "LPT9", "aux.tar"] {
            assert!(note_file_name(reserved).starts_with('_'), "{reserved}");
        }
        assert_eq!(note_file_name("COM10"), "COM10.md");
        assert_eq!(
            note_file_name(&"x".repeat(500)).chars().count(),
            MAX_STEM_CHARS + 3
        );
    }

    #[test]
    fn content_is_written_whole() {
        let tmp = TempDir::new("export");
        let path = tmp.path().join("out file.md");
        write(&path, "# äöü").unwrap();
        write(&path, "second").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");
        let error = write(&path, &"x".repeat(MAX_NOTE_BYTES + 1)).unwrap_err();
        assert!(matches!(error, ExportError::TooLarge { .. }));
        assert_eq!(error.storage_code(), Some(StorageCode::TooLarge));
        // A folder where the file should go: the write fails with a code, not a path.
        let blocked = tmp.path().join("blocked.md");
        std::fs::create_dir(&blocked).unwrap();
        let error = write(&blocked, "x").unwrap_err();
        assert!(matches!(error, ExportError::Io { .. }));
        assert!(error.storage_code().is_some());
        assert_eq!(ExportError::NotAPath.storage_code(), None);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");
    }
}
