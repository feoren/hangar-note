//! The note a captured text becomes (local channel `capture`, ADR 0002; security review B1). The
//! backend writes it before the channel answers, so a confirmed capture is on disk even when the
//! notes area never takes its request. Built exactly as the frontend built it before:
//! `appendCapture` (`src/noteText.ts`) for the block, `captureStamp` (`src/format.ts`, the
//! `Intl.DateTimeFormat` options `day: numeric, month: short, hour: 2-digit, minute: 2-digit`) for
//! the time, `notes.capturedFrom` (`src/i18n.ts`) for the heading and `titleFromText`
//! (`src/notes.ts`) for the title. The expected strings in the tests are what Node 26 (ICU 78)
//! gives for the same dates.
//!
//! The language is the one in `settings.json`, English without one; the time is the computer's
//! local time.

use std::path::Path;

/// The longest title taken from the first line (`AUTO_TITLE_LENGTH` in `src/notes.ts`).
const AUTO_TITLE_CHARS: usize = 60;
/// Without a language setting.
const FALLBACK_LANGUAGE: &str = "en";

/// A local date and time, as far as the stamp needs it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalTime {
    /// 1 to 12.
    pub month: u32,
    pub day: u32,
    /// 0 to 23.
    pub hour: u32,
    pub minute: u32,
}

/// The note of a capture: its title and its whole text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Captured {
    pub title: String,
    pub content: String,
}

/// The heading's wording per language: `notes.capturedFrom` of `src/i18n.ts`, `{source}` then
/// `{time}` filled in.
fn compose(language: &str, source: &str, time: &str) -> String {
    match language {
        "de" => format!("Aus {source}, {time}"),
        "el" => format!("Από {source}, {time}"),
        "es" | "fr" | "pt" => format!("De {source}, {time}"),
        "it" => format!("Da {source}, {time}"),
        "ja" => format!("{source} から（{time}）"),
        "pl" => format!("Z {source}, {time}"),
        "ru" => format!("Из {source}, {time}"),
        "tr" => format!("{source} klasöründen, {time}"),
        "zh" => format!("来自 {source}，{time}"),
        _ => format!("From {source}, {time}"),
    }
}

/// Short month names of `Intl.DateTimeFormat` with `month: "short"` next to a day.
fn month_name(language: &str, month: u32) -> &'static str {
    const DE: [&str; 12] = [
        "Jan.", "Feb.", "März", "Apr.", "Mai", "Juni", "Juli", "Aug.", "Sept.", "Okt.", "Nov.",
        "Dez.",
    ];
    const EN: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    const EL: [&str; 12] = [
        "Ιαν", "Φεβ", "Μαρ", "Απρ", "Μαΐ", "Ιουν", "Ιουλ", "Αυγ", "Σεπ", "Οκτ", "Νοε", "Δεκ",
    ];
    const ES: [&str; 12] = [
        "ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic",
    ];
    const FR: [&str; 12] = [
        "janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.",
        "déc.",
    ];
    const IT: [&str; 12] = [
        "gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic",
    ];
    const PL: [&str; 12] = [
        "sty", "lut", "mar", "kwi", "maj", "cze", "lip", "sie", "wrz", "paź", "lis", "gru",
    ];
    const PT: [&str; 12] = [
        "jan.", "fev.", "mar.", "abr.", "mai.", "jun.", "jul.", "ago.", "set.", "out.", "nov.",
        "dez.",
    ];
    const RU: [&str; 12] = [
        "янв.",
        "февр.",
        "мар.",
        "апр.",
        "мая",
        "июн.",
        "июл.",
        "авг.",
        "сент.",
        "окт.",
        "нояб.",
        "дек.",
    ];
    const TR: [&str; 12] = [
        "Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara",
    ];
    let names = match language {
        "de" => &DE,
        "el" => &EL,
        "es" => &ES,
        "fr" => &FR,
        "it" => &IT,
        "pl" => &PL,
        "pt" => &PT,
        "ru" => &RU,
        "tr" => &TR,
        _ => &EN,
    };
    let index = usize::try_from(month.clamp(1, 12) - 1).unwrap_or(0);
    names[index]
}

/// `captureStamp`: day, short month and time in the language's own order, as `Intl` writes them.
/// English and Greek use a 12-hour clock with two digits, the others 24 hours.
pub fn capture_stamp(time: LocalTime, language: &str) -> String {
    let LocalTime {
        month,
        day,
        hour,
        minute,
    } = time;
    let h24 = format!("{hour:02}:{minute:02}");
    let h12 = || {
        let twelve = match hour % 12 {
            0 => 12,
            other => other,
        };
        format!("{twelve:02}:{minute:02}")
    };
    let month_short = month_name(language, month);
    match language {
        "de" => format!("{day}. {month_short}, {h24}"),
        "el" => {
            let period = if hour < 12 { "π.μ." } else { "μ.μ." };
            format!("{day} {month_short}, {} {period}", h12())
        }
        "es" | "fr" | "it" | "pl" | "ru" => format!("{day} {month_short}, {h24}"),
        "ja" | "zh" => format!("{month}月{day}日 {h24}"),
        "pt" => format!("{day} de {month_short}, {h24}"),
        "tr" => format!("{day} {month_short} {h24}"),
        _ => {
            let period = if hour < 12 { "AM" } else { "PM" };
            format!("{month_short} {day}, {} {period}", h12())
        }
    }
}

/// JavaScript's `\s`: Unicode white space plus the byte order mark.
fn is_js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{FEFF}'
}

/// `\s+` to one space, then trimmed, as the frontend's regular expressions do it.
fn collapse(text: &str) -> String {
    text.split(is_js_space)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// `headingText`: the source as plain text inside the italic heading. Control characters and
/// line breaks become spaces, white space runs one space, Markdown characters are escaped.
fn heading_text(source: &str) -> String {
    let plain: String = source
        .chars()
        .map(|c| {
            let breaks =
                matches!(c, '\u{0}'..='\u{1F}' | '\u{7F}'..='\u{9F}' | '\u{2028}' | '\u{2029}');
            if breaks {
                ' '
            } else {
                c
            }
        })
        .collect();
    let mut escaped = String::with_capacity(plain.len());
    for c in collapse(&plain).chars() {
        if matches!(c, '\\' | '_' | '*' | '`' | '[' | ']') {
            escaped.push('\\');
        }
        escaped.push(c);
    }
    escaped
}

/// `fenceFor`: a code fence the text does not contain.
fn fence_for(text: &str) -> String {
    let mut fence = "```".to_owned();
    while text.contains(&fence) {
        fence.push('`');
    }
    fence
}

/// `appendCapture`: the captured text at the end of `existing` as a heading with time and source,
/// then a code block. `compose` words the heading from the stamp and the escaped source.
pub fn append_capture(
    existing: &str,
    captured: &str,
    stamp: &str,
    source: &str,
    compose: impl Fn(&str, &str) -> String,
) -> String {
    let body = captured.replace("\r\n", "\n").replace('\r', "\n");
    let body = body.trim_end_matches(is_js_space);
    let fence = fence_for(body);
    let label = heading_text(source);
    let heading = if label.is_empty() {
        format!("_{stamp}_")
    } else {
        format!("_{}_", compose(stamp, &label))
    };
    let block = format!("{heading}\n\n{fence}\n{body}\n{fence}\n");
    let trimmed = existing.trim_end_matches(is_js_space);
    if trimmed.is_empty() {
        block
    } else {
        format!("{trimmed}\n\n{block}")
    }
}

/// `titleFromText` for the first line of a capture (its heading): escaped characters as typed,
/// Markdown marks gone, white space collapsed, at most [`AUTO_TITLE_CHARS`] characters with an
/// ellipsis. `None` where nothing is left, or no valid title would be.
fn title_from_heading(line: &str) -> Option<String> {
    let mut plain = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' if chars
                .peek()
                .is_some_and(|next| matches!(next, '\\' | '`' | '*' | '_' | '~' | '[' | ']')) =>
            {
                plain.extend(chars.next());
            }
            '*' | '_' | '`' | '~' => {}
            other => plain.push(other),
        }
    }
    let line = collapse(&plain);
    if line.is_empty() {
        return None;
    }
    let title = if line.chars().count() > AUTO_TITLE_CHARS {
        let cut: String = line.chars().take(AUTO_TITLE_CHARS - 1).collect();
        format!("{}…", cut.trim_end())
    } else {
        line
    };
    crate::notes::validate_title(&title).ok()
}

/// `folderName`: the last part of a path.
fn folder_name(path: &Path) -> String {
    let text = path.to_string_lossy();
    text.split(['\\', '/'])
        .rfind(|part| !part.is_empty())
        .map_or_else(|| text.clone().into_owned(), str::to_owned)
}

/// The note of a text captured from `folder` at `time`, worded in `language` (English without
/// one, or for one this module does not know).
pub fn captured_note(
    folder: &Path,
    text: &str,
    time: LocalTime,
    language: Option<&str>,
) -> Captured {
    let language = language
        .filter(|code| crate::settings::LANGUAGES.contains(code))
        .unwrap_or(FALLBACK_LANGUAGE);
    let stamp = capture_stamp(time, language);
    let content = append_capture("", text, &stamp, &folder_name(folder), |time, source| {
        compose(language, source, time)
    });
    let title = content
        .lines()
        .next()
        .and_then(title_from_heading)
        .unwrap_or_else(|| stamp.clone());
    Captured { title, content }
}

/// The computer's local time now.
pub fn local_now() -> LocalTime {
    platform::local_now()
}

#[cfg(windows)]
mod platform {
    use super::LocalTime;
    use windows_sys::Win32::Foundation::SYSTEMTIME;
    use windows_sys::Win32::System::SystemInformation::GetLocalTime;

    pub fn local_now() -> LocalTime {
        let mut now = SYSTEMTIME {
            wYear: 0,
            wMonth: 1,
            wDayOfWeek: 0,
            wDay: 1,
            wHour: 0,
            wMinute: 0,
            wSecond: 0,
            wMilliseconds: 0,
        };
        // SAFETY: `GetLocalTime` only writes the `SYSTEMTIME` it is given, which lives on this
        // stack frame for the whole call; it cannot fail.
        unsafe { GetLocalTime(&mut now) };
        LocalTime {
            month: u32::from(now.wMonth),
            day: u32::from(now.wDay),
            hour: u32::from(now.wHour),
            minute: u32::from(now.wMinute),
        }
    }
}

#[cfg(unix)]
mod platform {
    //! POSIX `localtime_r`, declared here instead of adding `libc` for one call. `time_t` is a
    //! `long` on the 64-bit Linux and macOS targets this app builds for, and the first nine fields
    //! of `struct tm` are `int` in POSIX; glibc, musl and macOS add `tm_gmtoff` and `tm_zone`
    //! after them, for which `_rest` leaves more than enough room. Checked at compile time against
    //! `libc` 0.2.191 for `x86_64-unknown-linux-gnu` and `aarch64-apple-darwin` (2026-11-26): the
    //! offsets of the fields read here match `libc::tm`, `Tm` is at least as large and as aligned,
    //! and `libc::time_t` is `c_long`; this module compiles for both with clippy clean. It has not
    //! run on either yet; the Unix CI has to confirm that.
    use super::LocalTime;
    use std::os::raw::{c_int, c_long};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[repr(C)]
    struct Tm {
        tm_sec: c_int,
        tm_min: c_int,
        tm_hour: c_int,
        tm_mday: c_int,
        tm_mon: c_int,
        tm_year: c_int,
        tm_wday: c_int,
        tm_yday: c_int,
        tm_isdst: c_int,
        _rest: [usize; 8],
    }

    extern "C" {
        fn tzset();
        fn localtime_r(time: *const c_long, out: *mut Tm) -> *mut Tm;
    }

    pub fn local_now() -> LocalTime {
        let seconds = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| c_long::try_from(since.as_secs()).unwrap_or(0));
        let mut tm = Tm {
            tm_sec: 0,
            tm_min: 0,
            tm_hour: 0,
            tm_mday: 1,
            tm_mon: 0,
            tm_year: 0,
            tm_wday: 0,
            tm_yday: 0,
            tm_isdst: 0,
            _rest: [0; 8],
        };
        // SAFETY: `tzset` reads the time zone setting; `localtime_r` writes only the `Tm` it is
        // given (larger than every `struct tm` it may fill, see above) and reads `seconds`, both
        // alive on this stack frame for the whole call. A null result means it failed and left
        // `tm` as initialized.
        let filled = unsafe {
            tzset();
            !localtime_r(&seconds, &mut tm).is_null()
        };
        if !filled {
            return LocalTime {
                month: 1,
                day: 1,
                hour: 0,
                minute: 0,
            };
        }
        let part = |value: c_int| u32::try_from(value).unwrap_or(0);
        LocalTime {
            month: part(tm.tm_mon) + 1,
            day: part(tm.tm_mday),
            hour: part(tm.tm_hour),
            minute: part(tm.tm_min),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(month: u32, day: u32, hour: u32, minute: u32) -> LocalTime {
        LocalTime {
            month,
            day,
            hour,
            minute,
        }
    }

    /// The cases of `src/noteText.test.ts` (`appendCapture`), unchanged.
    #[test]
    fn the_block_is_the_frontends() {
        let dot = |time: &str, label: &str| format!("{time} · {label}");
        assert_eq!(
            append_capture("# Log\n\n", "error: x\r\n", "14:32", "Claude Code", dot),
            "# Log\n\n_14:32 · Claude Code_\n\n```\nerror: x\n```\n"
        );
        assert_eq!(
            append_capture("", "a", "9:01", "", dot),
            "_9:01_\n\n```\na\n```\n"
        );
        let from = |time: &str, label: &str| format!("Aus {label}, {time}");
        assert_eq!(
            append_capture("", "a", "26. Nov.", "my_shop", from),
            "_Aus my\\_shop, 26. Nov._\n\n```\na\n```\n"
        );
        assert!(append_capture("", "```js\nx\n```", "1", "", dot).contains("````\n```js"));
        assert_eq!(
            append_capture("", "a", "9:01", "x_y *b* `c` [d](e)\n# Head\u{7}", dot),
            "_9:01 · x\\_y \\*b\\* \\`c\\` \\[d\\](e) # Head_\n\n```\na\n```\n"
        );
        assert_eq!(
            append_capture("", "a", "9:01", "\r\n\u{1b}\t", dot),
            "_9:01_\n\n```\na\n```\n"
        );
    }

    /// What `Intl.DateTimeFormat(language, { day: "numeric", month: "short", hour: "2-digit",
    /// minute: "2-digit" })` gives in Node 26.13.1 (ICU 78.3).
    #[test]
    fn the_stamp_is_intls_in_every_language() {
        let afternoon = at(11, 26, 14, 32);
        for (language, expected) in [
            ("de", "26. Nov., 14:32"),
            ("en", "Nov 26, 02:32 PM"),
            ("el", "26 Νοε, 02:32 μ.μ."),
            ("es", "26 nov, 14:32"),
            ("fr", "26 nov., 14:32"),
            ("it", "26 nov, 14:32"),
            ("ja", "11月26日 14:32"),
            ("pl", "26 lis, 14:32"),
            ("pt", "26 de nov., 14:32"),
            ("ru", "26 нояб., 14:32"),
            ("tr", "26 Kas 14:32"),
            ("zh", "11月26日 14:32"),
        ] {
            assert_eq!(capture_stamp(afternoon, language), expected, "{language}");
        }
        // Midnight and noon on the 12-hour clock.
        assert_eq!(capture_stamp(at(11, 26, 0, 7), "en"), "Nov 26, 12:07 AM");
        assert_eq!(capture_stamp(at(11, 26, 12, 0), "en"), "Nov 26, 12:00 PM");
        assert_eq!(capture_stamp(at(11, 26, 0, 7), "el"), "26 Νοε, 12:07 π.μ.");
        assert_eq!(capture_stamp(at(11, 26, 23, 59), "de"), "26. Nov., 23:59");
        // Every month on the 5th at 09:05.
        let months = |language: &str| -> Vec<String> {
            (1..=12)
                .map(|month| capture_stamp(at(month, 5, 9, 5), language))
                .collect()
        };
        assert_eq!(
            months("de"),
            [
                "5. Jan., 09:05",
                "5. Feb., 09:05",
                "5. März, 09:05",
                "5. Apr., 09:05",
                "5. Mai, 09:05",
                "5. Juni, 09:05",
                "5. Juli, 09:05",
                "5. Aug., 09:05",
                "5. Sept., 09:05",
                "5. Okt., 09:05",
                "5. Nov., 09:05",
                "5. Dez., 09:05"
            ]
        );
        assert_eq!(months("en")[4], "May 5, 09:05 AM");
        assert_eq!(months("el")[4], "5 Μαΐ, 09:05 π.μ.");
        assert_eq!(months("fr")[7], "5 août, 09:05");
        assert_eq!(months("pl")[9], "5 paź, 09:05");
        assert_eq!(months("ru")[4], "5 мая, 09:05");
        assert_eq!(months("tr")[1], "5 Şub 09:05");
        assert_eq!(months("ja")[11], "12月5日 09:05");
    }

    #[test]
    fn a_capture_becomes_the_note_the_frontend_made() {
        let folder = Path::new(if cfg!(windows) {
            r"C:\p\Demo Projekt"
        } else {
            "/p/Demo Projekt"
        });
        let note = captured_note(folder, "Ausgabe\r\n", at(11, 26, 9, 5), Some("de"));
        assert_eq!(
            note.content,
            "_Aus Demo Projekt, 26. Nov., 09:05_\n\n```\nAusgabe\n```\n"
        );
        assert_eq!(note.title, "Aus Demo Projekt, 26. Nov., 09:05");
        // No language set, or one not known: English.
        let english = captured_note(folder, "x", at(11, 26, 14, 32), None);
        assert_eq!(english.title, "From Demo Projekt, Nov 26, 02:32 PM");
        assert_eq!(
            captured_note(folder, "x", at(11, 26, 14, 32), Some("xx")).title,
            english.title
        );
        // Escaped characters come back as typed in the title; a long title is cut.
        let marked = Path::new(if cfg!(windows) {
            r"C:\p\my_shop"
        } else {
            "/p/my_shop"
        });
        assert_eq!(
            captured_note(marked, "x", at(1, 5, 9, 5), Some("en")).title,
            "From my_shop, Jan 5, 09:05 AM"
        );
        let long = "a".repeat(80);
        let deep = Path::new(if cfg!(windows) { r"C:\" } else { "/" }).join(&long);
        let title = captured_note(&deep, "x", at(1, 5, 9, 5), Some("en")).title;
        assert_eq!(title.chars().count(), AUTO_TITLE_CHARS);
        assert!(title.ends_with('…'));
    }

    #[test]
    fn the_local_time_is_a_valid_time() {
        let now = local_now();
        assert!((1..=12).contains(&now.month), "{now:?}");
        assert!((1..=31).contains(&now.day), "{now:?}");
        assert!(now.hour < 24 && now.minute < 60, "{now:?}");
    }
}
