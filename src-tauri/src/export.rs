//! Saving a note as a `.md` file the person chooses. Taken from Hangar's `export.rs` and
//! `text.rs` (MIT, same owner): the backend opens the save dialog itself, so the window never
//! chooses where a file goes; this module holds the parts without a dialog.

use std::path::Path;

use crate::fsio::write_atomic;
use crate::notes::MAX_NOTE_BYTES;

pub const NOTE_EXTENSION: &str = "md";
pub const NOTE_FILTER: &str = "Markdown";
/// File name without extension, in characters.
const MAX_STEM_CHARS: usize = 100;
const FALLBACK_STEM: &str = "note";

/// Characters that show nothing but can reorder or hide text (Hangar's `is_invisible`: Unicode
/// 16.0 `Default_Ignorable_Code_Point` and category Cf).
pub fn is_invisible(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{034F}'
            | '\u{0600}'..='\u{0605}'
            | '\u{061C}'
            | '\u{06DD}'
            | '\u{070F}'
            | '\u{0890}'..='\u{0891}'
            | '\u{08E2}'
            | '\u{115F}'..='\u{1160}'
            | '\u{17B4}'..='\u{17B5}'
            | '\u{180B}'..='\u{180F}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{206F}'
            | '\u{3164}'
            | '\u{FE00}'..='\u{FE0F}'
            | '\u{FEFF}'
            | '\u{FFA0}'
            | '\u{FFF0}'..='\u{FFFB}'
            | '\u{110BD}'
            | '\u{110CD}'
            | '\u{13430}'..='\u{1343F}'
            | '\u{1BCA0}'..='\u{1BCA3}'
            | '\u{1D173}'..='\u{1D17A}'
            | '\u{E0000}'..='\u{E0FFF}'
    )
}

/// Device names Windows reserves in every folder, with or without extension.
fn is_reserved_on_windows(stem: &str) -> bool {
    let upper = stem.to_ascii_uppercase();
    let base = upper.split('.').next().unwrap_or_default().trim_end();
    matches!(base, "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
        || ["COM", "LPT"].iter().any(|prefix| {
            base.strip_prefix(prefix).is_some_and(|rest| {
                matches!(
                    rest,
                    "1" | "2"
                        | "3"
                        | "4"
                        | "5"
                        | "6"
                        | "7"
                        | "8"
                        | "9"
                        | "\u{B9}"
                        | "\u{B2}"
                        | "\u{B3}"
                )
            })
        })
}

/// A file name for a note title that is valid on Windows, macOS and Linux: no path separators or
/// characters Windows forbids, no control or invisible characters, no leading or trailing dots
/// and spaces, no reserved device name, at most [`MAX_STEM_CHARS`], then `.md`.
pub fn note_file_name(title: &str) -> String {
    let mut stem: String = title
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => ' ',
            c => c,
        })
        .filter(|c| !is_invisible(*c))
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
    stem = stem.trim_end_matches(['.', ' ']).to_owned();
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
    #[error("File {path} cannot be written: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("The chosen location is not a file on this computer")]
    NotAPath,
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
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");
    }
}
