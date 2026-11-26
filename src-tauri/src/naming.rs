//! The one naming rule for file names the app creates (security review L2): note files
//! (`notes.rs`) and exported files (`export.rs`) refuse or drop the same characters and names.
//! Names already on disk (written by Hangar or by hand) are never refused by it; they are read
//! as they are, and only a new name follows it.

/// Characters Windows refuses in a file name; `/` and `\` also separate paths.
pub const FORBIDDEN_CHARS: &str = "<>:\"/\\|?*";

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

/// Zero width non-joiner and joiner: kept between two characters that use them (see
/// [`without_invisible`]), and trimmed from the end of a name where a cut left one dangling.
pub const JOINERS: [char; 2] = ['\u{200C}', '\u{200D}'];

/// `text` without its [`is_invisible`] characters, except where one is part of what the text
/// shows: emoji sequences (`👨‍👩‍👧`, `❤️`, keycaps `1️⃣`) and Persian or Indic spelling would
/// otherwise fall apart into other characters. Kept are:
///
/// - a joiner ([`JOINERS`]) between two visible characters beyond Latin, Greek, Cyrillic and
///   Armenian (from U+0590: Hebrew, Arabic, Indic scripts, symbols, emoji) or after an emoji
///   variation selector. Between Latin letters it would only make two names look alike;
/// - a variation selector U+FE0E or U+FE0F right after a symbol (U+00A9, U+00AE or from U+2000),
///   or U+FE0F between `0`-`9`, `#` or `*` and the keycap mark U+20E3.
///
/// Everything else invisible is dropped wherever it stands: direction marks, embeddings,
/// overrides and isolates, zero width space, word joiner, the byte order mark, soft hyphen, tag
/// characters (which can carry hidden text after a flag) and the other variation selectors.
pub fn without_invisible(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut kept = String::with_capacity(text.len());
    let mut previous: Option<char> = None;
    for (index, &c) in chars.iter().enumerate() {
        let next = chars.get(index + 1).copied();
        let keep = !is_invisible(c)
            || match c {
                '\u{200C}' | '\u{200D}' => {
                    previous.is_some_and(|p| p == '\u{FE0F}' || uses_joiners(p))
                        && next.is_some_and(uses_joiners)
                }
                '\u{FE0E}' | '\u{FE0F}' => {
                    previous.is_some_and(takes_emoji_variation)
                        || (c == '\u{FE0F}'
                            && previous.is_some_and(|p| matches!(p, '0'..='9' | '#' | '*'))
                            && next == Some('\u{20E3}'))
                }
                _ => false,
            };
        if keep {
            kept.push(c);
            previous = Some(c);
        }
    }
    kept
}

/// A visible character of a script or symbol block in which a joiner changes what is shown.
fn uses_joiners(c: char) -> bool {
    u32::from(c) >= 0x0590 && !is_invisible(c) && !c.is_whitespace() && !c.is_control()
}

/// A visible symbol that may be followed by a text or emoji variation selector.
fn takes_emoji_variation(c: char) -> bool {
    (matches!(c, '\u{A9}' | '\u{AE}') || u32::from(c) >= 0x2000)
        && !is_invisible(c)
        && !c.is_whitespace()
        && !c.is_control()
}

/// Whether Windows reserves `stem` for a device in every folder: `CON`, `PRN`, `AUX`, `NUL`,
/// `CONIN$`, `CONOUT$`, `COM` and `LPT` with a digit or a superscript `¹²³`, in any case, also
/// with an extension and with trailing dots or spaces (`con .txt`, `COM¹..`), which Windows strips
/// before it compares. `COM0` and `LPT0` count as well: newer versions of Microsoft's naming
/// documentation list them, and a `_` in front of such a name costs nothing.
pub fn is_reserved_on_windows(stem: &str) -> bool {
    let upper = stem.to_ascii_uppercase();
    let base = upper
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches([' ', '.']);
    matches!(base, "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
        || ["COM", "LPT"].iter().any(|prefix| {
            base.strip_prefix(prefix).is_some_and(|rest| {
                let mut chars = rest.chars();
                matches!(
                    (chars.next(), chars.next()),
                    (Some('0'..='9' | '\u{B9}' | '\u{B2}' | '\u{B3}'), None)
                )
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_names_are_reserved_in_every_spelling() {
        for reserved in [
            "CON",
            "con",
            "Prn.md",
            "aux.tar.gz",
            "NUL ",
            "nul . txt",
            "CONIN$",
            "conin$.md",
            "CONOUT$",
            "ConOut$ ..",
            "COM1",
            "com9.md",
            "COM0",
            "lpt0",
            "COM\u{B9}",
            "com\u{B2}.txt",
            "LPT\u{B3}",
            "lpt\u{B9}. .",
        ] {
            assert!(is_reserved_on_windows(reserved), "{reserved:?}");
        }
        for free in [
            "CONSOLE",
            "COM10",
            "LPT\u{B9}0",
            "CONOUT",
            "CONIN$x",
            "_CON",
            "xCON",
            "COM",
            "COM\u{2074}",
            "",
        ] {
            assert!(!is_reserved_on_windows(free), "{free:?}");
        }
    }

    #[test]
    fn invisible_characters_are_dropped() {
        assert_eq!(without_invisible("a\u{202E}b\u{200B}c\u{FEFF}"), "abc");
        assert_eq!(without_invisible("Größe 😀"), "Größe 😀");
        assert!(is_invisible('\u{2066}'));
        assert!(!is_invisible(' '));
    }

    /// Emoji sequences and Persian or Indic spelling keep their joiners and variation selectors;
    /// the characters that hide or reorder text are dropped all the same, also right next to an
    /// emoji, and a joiner between Latin letters never survives.
    #[test]
    fn joiners_stay_where_they_form_what_is_shown() {
        for kept in [
            "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}",
            "\u{2764}\u{FE0F}",
            "\u{2764}\u{FE0F}\u{200D}\u{1F525}",
            "\u{1F441}\u{FE0F}\u{200D}\u{1F5E8}\u{FE0F}",
            "\u{1F469}\u{1F3FD}\u{200D}\u{1F4BB}",
            "1\u{FE0F}\u{20E3}",
            "#\u{FE0F}\u{20E3}",
            "\u{A9}\u{FE0F}",
            "\u{2603}\u{FE0E}",
            "\u{0645}\u{06CC}\u{200C}\u{062E}\u{0648}\u{0627}\u{0647}\u{0645}",
            "\u{0915}\u{094D}\u{200D}\u{0937}",
            "Plan \u{1F468}\u{200D}\u{1F4BB} Q3",
        ] {
            assert_eq!(without_invisible(kept), kept, "{kept:?}");
        }
        for (spoofed, visible) in [
            ("ad\u{200D}min", "admin"),
            ("ad\u{200C}min", "admin"),
            ("a\u{FE0F}", "a"),
            ("1\u{FE0F}", "1"),
            ("\u{200D}\u{1F600}", "\u{1F600}"),
            ("\u{1F600}\u{200D}", "\u{1F600}"),
            ("\u{1F600}\u{200D} \u{1F600}", "\u{1F600} \u{1F600}"),
            (
                "\u{1F600}\u{200D}\u{200D}\u{1F600}",
                "\u{1F600}\u{200D}\u{1F600}",
            ),
            ("\u{2764}\u{FE0F}\u{FE0F}", "\u{2764}\u{FE0F}"),
            // The override goes; the joiner it stood next to still joins two emoji.
            (
                "\u{1F600}\u{202E}\u{200D}\u{1F600}",
                "\u{1F600}\u{200D}\u{1F600}",
            ),
            ("\u{1F600}\u{200D}\u{202E}\u{1F600}", "\u{1F600}\u{1F600}"),
            ("\u{1F600}\u{200B}\u{FE0F}", "\u{1F600}\u{FE0F}"),
            ("\u{1F3F4}\u{E0067}\u{E0062}\u{E007F}", "\u{1F3F4}"),
            ("\u{1F600}\u{FE00}", "\u{1F600}"),
            ("\u{200D}\u{FE0F}", ""),
        ] {
            assert_eq!(without_invisible(spoofed), visible, "{spoofed:?}");
        }
    }
}
