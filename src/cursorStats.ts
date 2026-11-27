// The numbers of the status line under a note: where the cursor stands, how much is selected and
// how long the text is. Pure functions, a small store and the line's texts; the editor measures,
// the status line (CursorFooter.tsx) only renders.
//
// Characters are counted as a person sees them: grapheme clusters (Intl.Segmenter). An emoji such
// as a thumbs up, a flag or a family made of several code points counts once, a letter with a
// combining accent counts once, and a line break counts once, `\r\n` included. Code points alone
// would count a flag twice and a family emoji up to seven times.

import { pluralKey, type Language, type PluralKey, type Translate } from "./i18n";

export interface CursorStats {
  /** Line of the cursor, 1-based. */
  line: number;
  /** Column of the cursor in characters, 1-based. */
  column: number;
  /** Characters in the selection, 0 without one. */
  selected: number;
  /** Characters in the whole text. */
  length: number;
}

/**
 * Below U+0300 every UTF-16 unit is a character of its own: no combining marks, joiners,
 * variation selectors or surrogates live there. Only `\r\n` forms one cluster of two units.
 */
const FIRST_JOINING = 0x300;
const CRLF = String.fromCharCode(13, 10);

function isSimple(text: string): boolean {
  for (let at = 0; at < text.length; at++) {
    if (text.charCodeAt(at) >= FIRST_JOINING) return false;
  }
  return true;
}

// Every engine the app runs on has it (WebView2, WebKit 14.1 and later).
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Characters in `text` as a person counts them (grapheme clusters). */
export function countChars(text: string): number {
  if (isSimple(text)) {
    let pairs = 0;
    for (let at = text.indexOf(CRLF); at !== -1; at = text.indexOf(CRLF, at + 2)) pairs += 1;
    return text.length - pairs;
  }
  const segments = segmenter.segment(text)[Symbol.iterator]();
  let count = 0;
  while (segments.next().done !== true) count += 1;
  return count;
}

/**
 * Characters of a text given as its lines (without their breaks), each break counting once. The
 * editor hands its lines over one by one, so a long note is never joined into one string.
 */
export function countLines(lines: Iterable<string>): number {
  let count = -1;
  for (const line of lines) count += countChars(line) + 1;
  return Math.max(0, count);
}

/** Where a line ends a text: `\r\n`, `\r` or `\n`, as CodeMirror splits it. */
const BREAK = /\r\n?|\n/g;

/**
 * The status line's numbers for `text` with the selection from `anchor` to `head` (UTF-16
 * offsets, as the editor gives them; `anchor === head` is a plain cursor).
 */
export function cursorStats(text: string, anchor: number, head: number): CursorStats {
  const before = text.slice(0, head);
  let line = 1;
  let lineStart = 0;
  for (const match of before.matchAll(BREAK)) {
    line += 1;
    lineStart = match.index + match[0].length;
  }
  return {
    line,
    column: countChars(before.slice(lineStart)) + 1,
    selected: countChars(text.slice(Math.min(anchor, head), Math.max(anchor, head))),
    length: countChars(text),
  };
}

export function sameStats(a: CursorStats | null, b: CursorStats | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.line === b.line &&
      a.column === b.column &&
      a.selected === b.selected &&
      a.length === b.length)
  );
}

export interface CursorStore {
  get: () => CursorStats | null;
  /** New numbers; listeners hear of them only when something changed. */
  set: (stats: CursorStats | null) => void;
  subscribe: (listener: () => void) => () => void;
}

/**
 * The numbers outside React's state: the editor writes them on every cursor move, and only the
 * status line, which subscribes, renders again; the window around it does not.
 */
export function createCursorStore(): CursorStore {
  let current: CursorStats | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (stats) => {
      if (sameStats(current, stats)) return;
      current = stats;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export interface FooterText {
  /** "Ln 3, Col 811", `null` where the cursor is not shown (the preview). */
  position: string | null;
  /** "(12 selected)", `null` without a selection. */
  selected: string | null;
  /** "851 chars". */
  chars: string;
  /** Everything in full words, for the tooltip and screen readers. */
  full: string;
}

const numberFormats = new Map<Language, Intl.NumberFormat>();

/** `value` in the UI language's digits and grouping ("1.234" in German, "1,234" in English). */
export function formatCount(value: number, language: Language): string {
  let format = numberFormats.get(language);
  if (format === undefined) {
    format = new Intl.NumberFormat(language);
    numberFormats.set(language, format);
  }
  return format.format(value);
}

/** The status line's texts; `position: false` leaves out the cursor and the selection. */
export function footerText(
  stats: CursorStats,
  t: Translate,
  language: Language,
  position = true,
): FooterText {
  const line = formatCount(stats.line, language);
  const column = formatCount(stats.column, language);
  const chars = formatCount(stats.length, language);
  const selected = formatCount(stats.selected, language);
  const hasSelection = position && stats.selected > 0;
  // The noun follows the length ("1 of 1 character", "1 of 5 characters"); "selected" alone
  // follows the selection ("1 seleccionado").
  const byLength = (base: PluralKey) => pluralKey(language, base, stats.length);
  let full = t(byLength("footer.charsFull"), { count: chars });
  if (position) {
    full = hasSelection
      ? t(byLength("footer.fullSelected"), { line, column, selected, chars })
      : t(byLength("footer.full"), { line, column, chars });
  }
  return {
    position: position ? t("footer.position", { line, column }) : null,
    selected: hasSelection
      ? t(pluralKey(language, "footer.selected", stats.selected), { count: selected })
      : null,
    chars: t(byLength("footer.chars"), { count: chars }),
    full,
  };
}
