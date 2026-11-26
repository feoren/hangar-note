// Notes per working folder: name scopes, compare them, titles for new notes, sorting and the color
// filter. Pure logic without the backend, taken from Hangar's src/notes.ts (MIT, same owner)
// without the shared notes, which come in a later phase.

import type { NoteFolder } from "./api";
import type { NoteColor } from "./colors";

export const GENERAL_FOLDER: NoteFolder = { path: null };

/** The backend's title limit (notes.rs `MAX_TITLE_CHARS`). */
export const MAX_TITLE_LENGTH = 200;

/** Comparison key of a scope: on Windows, paths are case insensitive, as in the backend. */
export function folderId(folder: NoteFolder): string {
  // No path is empty; that way "General" collides with no folder, not even with "/".
  if (folder.path === null) return "";
  const slashes = folder.path.replace(/[\\/]+/g, "/");
  const unified = slashes.length > 1 ? slashes.replace(/\/$/, "") : slashes;
  return /^[a-z]:/i.test(unified) || unified.startsWith("//") ? unified.toLowerCase() : unified;
}

export function sameFolder(a: NoteFolder, b: NoteFolder): boolean {
  return folderId(a) === folderId(b);
}

/** The last part of a path, for chips and rows. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part !== "");
  return parts[parts.length - 1] ?? path;
}

/** Valid title by the backend's rules, or `null`. */
export function cleanTitle(text: string): string | null {
  const title = text.trim();
  if (title.length === 0 || Array.from(title).length > MAX_TITLE_LENGTH) return null;
  // The backend rejects control characters (line breaks included).
  for (const char of title) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return null;
  }
  return title;
}

/** Longest title derived from the text itself; the list truncates anyway. */
export const AUTO_TITLE_LENGTH = 60;

/**
 * Title from the first line with content: without leading Markdown characters (heading, list,
 * quote, task) and without emphasis, truncated to AUTO_TITLE_LENGTH characters. `null` if the
 * text has no such line yet.
 */
export function titleFromText(text: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw
      .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)*/, "")
      .replace(/[*_`~]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (line === "" || /^[-=#>]+$/.test(line)) continue;
    const chars = Array.from(line);
    const short =
      chars.length > AUTO_TITLE_LENGTH
        ? `${chars
            .slice(0, AUTO_TITLE_LENGTH - 1)
            .join("")
            .trimEnd()}…`
        : line;
    return cleanTitle(short);
  }
  return null;
}

/**
 * Is the title still the one a new note got ("Note 3" in any language)? Then it may follow the
 * first line; a title the person chose stays.
 */
export function isUntitled(title: string, untitledBases: readonly string[]): boolean {
  const lower = title.trim().toLocaleLowerCase();
  return untitledBases.some((base) => {
    const prefix = `${base.toLocaleLowerCase()} `;
    return lower.startsWith(prefix) && /^\d+$/.test(lower.slice(prefix.length));
  });
}

/** What a note should be called after its text changed, or `null` to keep its title. */
export function nextAutoTitle(
  note: { title: string; autoTitled: boolean },
  text: string,
  untitledBases: readonly string[],
): string | null {
  if (!note.autoTitled && !isUntitled(note.title, untitledBases)) return null;
  const title = titleFromText(text);
  return title !== null && title !== note.title ? title : null;
}

/** A note together with its scope: "All" and the search mix scopes. */
export interface NoteRef {
  folder: NoteFolder;
  id: string;
}

/** Same note (same scope, same ID). */
export function sameNote(a: NoteRef, b: NoteRef): boolean {
  return a.id === b.id && sameFolder(a.folder, b.folder);
}

/** Key of a note for maps and React lists. */
export function noteKey(note: NoteRef): string {
  return `${folderId(note.folder)}\n${note.id}`;
}

/** Most recent change first; notes without a time last, then by title. */
export function byLastChange<T extends { updatedAt: number | null; title: string }>(
  notes: readonly T[],
): T[] {
  return [...notes].sort((a, b) => {
    const diff = (b.updatedAt ?? -1) - (a.updatedAt ?? -1);
    return diff !== 0 ? diff : a.title.localeCompare(b.title);
  });
}

/** The rows in the chosen colors; no color chosen shows all. */
export function filterByColors<T extends { color: NoteColor }>(
  rows: readonly T[],
  colors: ReadonlySet<NoteColor>,
): T[] {
  return colors.size === 0 ? [...rows] : rows.filter((row) => colors.has(row.color));
}

/** How many rows each color has, for the filter chips. */
export function colorCounts(rows: readonly { color: NoteColor }[]): Map<NoteColor, number> {
  const counts = new Map<NoteColor, number>();
  for (const row of rows) counts.set(row.color, (counts.get(row.color) ?? 0) + 1);
  return counts;
}
