// Text logic of notes: the title from the first line, the excerpt of a card, the search in "All
// notes" and the formatting toggles. Pure functions; the editor and the hub use them alike.

/** At most this many characters of a title on a card. */
export const MAX_TITLE_CHARS = 80;
/** At most this many characters below the title on a card. */
export const MAX_EXCERPT_CHARS = 240;

const LEADING_MARKS =
  /^\s*(?:#{1,6}(?:\s+|$)|>\s*|(?:[-*+]|\d+[.)])(?:\s+|$)(?:\[[ xX]\](?:\s+|$))?)*/;

/** A line without its Markdown block marks and inline emphasis, whitespace collapsed. */
function plainLine(line: string): string {
  return line
    .replace(LEADING_MARKS, "")
    .replace(/(\*\*|__|~~|`)(.*?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_](\S(?:.*?\S)?)[*_](?![\w*])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

function cut(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max
    ? text
    : `${chars
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`;
}

/** The first non-empty line as plain text, or `null` for a note without visible text. */
export function noteTitle(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const plain = plainLine(line);
    if (plain !== "") return cut(plain, MAX_TITLE_CHARS);
  }
  return null;
}

/** The lines after the title as plain text, joined, for the card below the title. */
export function noteExcerpt(text: string): string {
  const lines = text.split(/\r?\n/).map(plainLine);
  const first = lines.findIndex((line) => line !== "");
  if (first < 0) return "";
  return cut(
    lines
      .slice(first + 1)
      .filter((line) => line !== "")
      .join(" · "),
    MAX_EXCERPT_CHARS,
  );
}

/** Search terms: whitespace separated, case- and accent-insensitive. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

export function searchTerms(query: string): string[] {
  return fold(query)
    .split(/\s+/)
    .filter((term) => term !== "");
}

/** Whether every term of `query` occurs in `text`; an empty query matches everything. */
export function matchesQuery(text: string, query: string): boolean {
  const terms = searchTerms(query);
  if (terms.length === 0) return true;
  const haystack = fold(text);
  return terms.every((term) => haystack.includes(term));
}

/** The notes whose text matches `query`, in their given order. */
export function filterNotes<T extends { preview: string }>(
  notes: readonly T[],
  query: string,
): T[] {
  return notes.filter((note) => matchesQuery(note.preview, query));
}

export interface TextEdit {
  from: number;
  to: number;
  insert: string;
  /** The selection afterwards. */
  selection: { anchor: number; head: number };
}

/**
 * Wraps the selection in `mark` (`**`, `*`, `~~`) or removes the mark when it already surrounds
 * it. Without a selection the marks are inserted with the cursor between them.
 */
export function toggleWrap(text: string, from: number, to: number, mark: string): TextEdit {
  const before = text.slice(Math.max(0, from - mark.length), from);
  const after = text.slice(to, to + mark.length);
  const inner = text.slice(from, to);
  if (before === mark && after === mark) {
    return {
      from: from - mark.length,
      to: to + mark.length,
      insert: inner,
      selection: { anchor: from - mark.length, head: to - mark.length },
    };
  }
  if (inner.length >= 2 * mark.length && inner.startsWith(mark) && inner.endsWith(mark)) {
    const stripped = inner.slice(mark.length, inner.length - mark.length);
    return {
      from,
      to,
      insert: stripped,
      selection: { anchor: from, head: from + stripped.length },
    };
  }
  return {
    from,
    to,
    insert: `${mark}${inner}${mark}`,
    selection: { anchor: from + mark.length, head: to + mark.length },
  };
}

const LIST_PREFIX = /^(\s*)(?:[-*+]\s+(?:\[[ xX]\]\s+)?)?/;

/**
 * Turns the lines into bullets (`- `) or checklist items (`- [ ] `), or removes that prefix when
 * every line already has it. Returns the new lines.
 */
export function toggleLinePrefix(lines: readonly string[], kind: "bullet" | "task"): string[] {
  const has = (line: string) =>
    kind === "task"
      ? /^\s*[-*+]\s+\[[ xX]\]\s/.test(line)
      : /^\s*[-*+]\s+(?!\[[ xX]\]\s)/.test(line);
  const prefix = kind === "task" ? "- [ ] " : "- ";
  const remove = lines.every(has);
  return lines.map((line) => {
    const match = LIST_PREFIX.exec(line);
    const indent = match?.[1] ?? "";
    const rest = line.slice(match?.[0].length ?? 0);
    return remove ? `${indent}${rest}` : `${indent}${prefix}${rest}`;
  });
}

/** Offset in `line` of the character inside `[ ]`, or `null` if it is no task line. */
export function taskMarkOffset(line: string): number | null {
  const match = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\](?=\s|$)/.exec(line);
  return match?.[1] === undefined ? null : match[1].length + 1;
}
