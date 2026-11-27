// The eight note colors (ADR 0001), each with a light and a dark variant. Text, the muted icons in
// the header and links keep at least 4.5 : 1 against their background in both themes
// (colors.test.ts measures it). The app chrome around the notes uses Hangar's tokens instead
// (styles.css).

import type { MessageKey, Translate } from "./i18n";

export type NoteColor = "lemon" | "peach" | "mint" | "sky" | "lilac" | "rose" | "sand" | "slate";
export type Theme = "light" | "dark";

export const NOTE_COLORS: readonly NoteColor[] = [
  "lemon",
  "peach",
  "mint",
  "sky",
  "lilac",
  "rose",
  "sand",
  "slate",
];

export interface NoteTone {
  /** The note's body. */
  background: string;
  /** The header row and the formatting bar, a step stronger. */
  header: string;
  text: string;
  /** Icons and placeholder text. */
  muted: string;
  /** Links and ticked checkboxes. */
  accent: string;
  /**
   * The color as a thin edge on the app's own surfaces (a list row, the top of the open note): a
   * stronger tone that keeps 3 : 1 against the background, the panel and the hover surface of its
   * theme (colors.test.ts reads them from styles.css).
   */
  edge: string;
}

const LIGHT_TEXT = "#1f2328";
const LIGHT_MUTED = "#4b525a";
const LIGHT_ACCENT = "#0a5bc4";
const DARK_TEXT = "#e6edf3";
const DARK_MUTED = "#b3bcc6";
const DARK_ACCENT = "#6cb6ff";

function light(background: string, header: string, edge: string): NoteTone {
  return { background, header, text: LIGHT_TEXT, muted: LIGHT_MUTED, accent: LIGHT_ACCENT, edge };
}

function dark(background: string, header: string, edge: string): NoteTone {
  return { background, header, text: DARK_TEXT, muted: DARK_MUTED, accent: DARK_ACCENT, edge };
}

export const NOTE_TONES: Record<Theme, Record<NoteColor, NoteTone>> = {
  light: {
    lemon: light("#fff7c2", "#fbec9a", "#8f7600"),
    peach: light("#ffe6d1", "#fdd3b0", "#c25a16"),
    mint: light("#dcf5e5", "#c3ecd2", "#2f8a5e"),
    sky: light("#dcedfd", "#c5e0fa", "#3b82d6"),
    lilac: light("#ede5ff", "#ddd0fb", "#8a63d2"),
    rose: light("#ffe2eb", "#fbcbda", "#c94473"),
    sand: light("#f4ecdc", "#e9dcc4", "#96764a"),
    slate: light("#e5e9ef", "#d3dae3", "#6e7781"),
  },
  dark: {
    lemon: dark("#3a3415", "#47401a", "#e3c84a"),
    peach: dark("#3e2a1c", "#4b3322", "#f0955a"),
    mint: dark("#1d382a", "#244433", "#5cc08b"),
    sky: dark("#1b2f46", "#223a55", "#5aa9ff"),
    lilac: dark("#2e2645", "#382e54", "#a98bf0"),
    rose: dark("#40232f", "#4d2a39", "#ee77a0"),
    sand: dark("#383127", "#443c30", "#cbb08a"),
    slate: dark("#262d36", "#303843", "#8592a3"),
  },
};

export function isNoteColor(value: unknown): value is NoteColor {
  return NOTE_COLORS.some((color) => color === value);
}

export function colorLabelKey(color: NoteColor): MessageKey {
  return `color.${color}`;
}

/** The person's own name of a color, else the color's name in the UI language. */
export function colorName(
  color: NoteColor,
  names: Partial<Record<NoteColor, string>>,
  t: Translate,
): string {
  const own = names[color]?.trim();
  return own !== undefined && own !== "" ? own : t(colorLabelKey(color));
}

/** The backend's limit (`MAX_COLOR_NAME_CHARS` in settings.rs). */
export const MAX_COLOR_NAME_LENGTH = 40;

/** The names with `color` set to `name`; a blank name removes the color's own name. */
export function withColorName(
  names: Partial<Record<NoteColor, string>>,
  color: NoteColor,
  name: string,
): Partial<Record<NoteColor, string>> {
  const clean = Array.from(name.replace(/\s+/g, " ").trim())
    .slice(0, MAX_COLOR_NAME_LENGTH)
    .join("");
  const next: Partial<Record<NoteColor, string>> = {};
  for (const other of NOTE_COLORS) {
    const value = other === color ? clean : names[other];
    if (value !== undefined && value !== "") next[other] = value;
  }
  return next;
}

export function noteTone(color: NoteColor, theme: Theme): NoteTone {
  return NOTE_TONES[theme][color];
}

/**
 * The color of a swatch or a filter dot: the light header tone in both themes. The dark tones are
 * too quiet for a small dot, and the color menu, the filter and the settings show the same tone.
 */
export function swatchColor(color: NoteColor): string {
  return NOTE_TONES.light[color].header;
}

/** The tone as CSS custom properties for the note window's root. */
export function toneVariables(tone: NoteTone): Record<string, string> {
  return {
    "--note-bg": tone.background,
    "--note-head": tone.header,
    "--note-text": tone.text,
    "--note-muted": tone.muted,
    "--note-accent": tone.accent,
    "--note-edge": tone.edge,
  };
}

/**
 * The tone as CSS custom properties for a row of the notes list: the edge always, the rest tints
 * the row while it is the chosen one (styles.css). Text, meta and the checklist count keep 4.5 : 1
 * on the row, the tools' hover surface is the header tone (colors.test.ts).
 */
export function rowToneVariables(tone: NoteTone): Record<string, string> {
  return {
    "--note-edge": tone.edge,
    "--row-bg": tone.background,
    "--row-head": tone.header,
    "--row-text": tone.text,
    "--row-muted": tone.muted,
    "--row-accent": tone.accent,
  };
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2 relative luminance of `#rrggbb`. */
export function luminance(hex: string): number {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) throw new Error(`not a #rrggbb color: ${hex}`);
  const [r, g, b] = [match[1], match[2], match[3]].map((part) =>
    channel(parseInt(part ?? "0", 16)),
  );
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/** WCAG 2 contrast ratio, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
}
