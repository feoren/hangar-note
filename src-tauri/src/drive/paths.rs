//! The path rule of "drive-local 1" (Hangar Drive repository, ADR 0003, section 3): every path in
//! a request and an answer is relative to the notes folder, `/` as separator, UTF-8, at most
//! [`MAX_PATH_BYTES`] bytes and [`MAX_COMPONENTS`] components; no empty component, no `.` or `..`,
//! no `\`, no NUL or other control character, no leading `/`, no drive or UNC prefix. Hangar Note
//! builds its own paths by this rule and drops every path of an answer that breaks it.

use crate::notes::is_folder_key;

pub const MAX_PATH_BYTES: usize = 1024;
pub const MAX_COMPONENTS: usize = 16;

/// Whether `path` follows the rule.
pub fn is_valid(path: &str) -> bool {
    if path.is_empty() || path.len() > MAX_PATH_BYTES {
        return false;
    }
    // A leading `/` covers rooted paths and `//server/share`; `\` covers every Windows spelling
    // (`\\server\share`, `\\?\`, `C:\`).
    if path.starts_with('/') || path.contains('\\') || path.chars().any(char::is_control) {
        return false;
    }
    let mut count = 0;
    for (index, part) in path.split('/').enumerate() {
        count += 1;
        if count > MAX_COMPONENTS || part.is_empty() || part == "." || part == ".." {
            return false;
        }
        if index == 0 && has_drive_prefix(part) {
            return false;
        }
    }
    true
}

/// `C:` or `C:name`: a drive letter, which would make the path absolute or drive relative on
/// Windows.
fn has_drive_prefix(part: &str) -> bool {
    let bytes = part.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

/// The contract path of a note: `<scope>/<file>`, or `None` when the scope is no folder key, the
/// file name is not one plain component, or the result breaks the rule. `file` comes from a
/// scope's `folder.json`, which another device may have written (remote input).
pub fn note_path(scope: &str, file: &str) -> Option<String> {
    if !is_folder_key(scope) || file.contains(['/', '\\']) {
        return None;
    }
    let path = format!("{scope}/{file}");
    is_valid(&path).then_some(path)
}

/// The scope of a contract path: its first component, if that is a folder key.
pub fn scope_of(path: &str) -> Option<&str> {
    path.split_once('/')
        .map(|(scope, _)| scope)
        .filter(|scope| is_folder_key(scope))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_note_paths_pass() {
        for path in [
            "general/Shopping.md",
            "3f2a9c0e5b7d41e8a6c4f0b2d9e1a7c3/Plan.md",
            "general/.trash/trash.json",
            "general/Café notes.md",
            "a",
        ] {
            assert!(is_valid(path), "{path}");
        }
    }

    #[test]
    fn the_byte_limit_is_exact() {
        let at_limit = format!("general/{}", "a".repeat(MAX_PATH_BYTES - "general/".len()));
        assert_eq!(at_limit.len(), MAX_PATH_BYTES);
        assert!(is_valid(&at_limit));
        let over = format!("{at_limit}a");
        assert!(!is_valid(&over));
        // Counted in bytes, not characters: 'ü' is two bytes in UTF-8.
        let wide = format!("general/{}", "ü".repeat((MAX_PATH_BYTES - 8) / 2 + 1));
        assert!(wide.chars().count() <= MAX_PATH_BYTES);
        assert!(!is_valid(&wide));
    }

    #[test]
    fn the_component_limit_is_exact() {
        let sixteen = vec!["a"; MAX_COMPONENTS].join("/");
        assert!(is_valid(&sixteen));
        let seventeen = vec!["a"; MAX_COMPONENTS + 1].join("/");
        assert!(!is_valid(&seventeen));
    }

    #[test]
    fn dots_separators_and_empty_parts_fail() {
        for path in [
            "",
            "..",
            ".",
            "general/../x.md",
            "general/./x.md",
            "../general/x.md",
            "general/..",
            "general//x.md",
            "general/x.md/",
            "/general/x.md",
            "//server/share/x.md",
            "general\\x.md",
            "\\\\server\\share\\x.md",
            "\\\\?\\C:\\x.md",
            "C:/x.md",
            "C:x.md",
            "c:",
        ] {
            assert!(!is_valid(path), "{path:?}");
        }
    }

    #[test]
    fn control_characters_fail() {
        for path in [
            "general/a\0.md",
            "general/a\n.md",
            "general/a\r.md",
            "general/a\t.md",
            "general/a\u{7f}.md",
            "general/a\u{85}.md",
            "general/a\u{1b}[31m.md",
        ] {
            assert!(!is_valid(path), "{path:?}");
        }
    }

    #[test]
    fn note_paths_are_built_by_the_rule() {
        assert_eq!(
            note_path("general", "Shopping.md").as_deref(),
            Some("general/Shopping.md")
        );
        let key = "3f2a9c0e5b7d41e8a6c4f0b2d9e1a7c3";
        assert_eq!(note_path(key, "Plan.md"), Some(format!("{key}/Plan.md")));
        for (scope, file) in [
            (".hangar-drive", "x.md"),
            ("allgemein", "x.md"),
            ("general", "a/b.md"),
            ("general", "a\\b.md"),
            ("general", ".."),
            ("general", ""),
            ("general", "a\u{0}.md"),
        ] {
            assert_eq!(note_path(scope, file), None, "{scope} {file:?}");
        }
        assert_eq!(scope_of("general/x.md"), Some("general"));
        assert_eq!(scope_of(&format!("{key}/x.md")), Some(key));
        assert_eq!(scope_of(".hangar-drive/x"), None);
        assert_eq!(scope_of("general"), None);
    }
}
