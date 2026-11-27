// The sidebar's color section as a category list: one row per color the shown notes use, with
// how many notes carry it; the colors nobody uses come in only on request ("Show all colors"),
// dimmed. Whether the section is open and whether it shows all colors is remembered while the app
// runs. Pure logic; Sidebar.tsx draws it.

import { NOTE_COLORS, type NoteColor } from "./colors";

export interface ColorRow {
  color: NoteColor;
  /** Notes of the shown list with this color; 0 for a color no shown note uses. */
  count: number;
}

/**
 * The rows in the colors' own order (stable, so a row never jumps): every color the shown notes
 * use and every chosen filter color (so a chosen filter can always be switched off), or all eight
 * when `all`.
 */
export function colorRows(
  counts: ReadonlyMap<NoteColor, number>,
  chosen: ReadonlySet<NoteColor>,
  all: boolean,
): ColorRow[] {
  return NOTE_COLORS.flatMap((color) => {
    const count = counts.get(color) ?? 0;
    return all || count > 0 || chosen.has(color) ? [{ color, count }] : [];
  });
}

/** Colors the short list leaves out, so "Show all colors" has something to show. */
export function hasHiddenColors(
  counts: ReadonlyMap<NoteColor, number>,
  chosen: ReadonlySet<NoteColor>,
): boolean {
  return colorRows(counts, chosen, false).length < NOTE_COLORS.length;
}

export interface ColorSection {
  /** The rows are shown (the heading's chevron folds them away). */
  open: boolean;
  /** All eight colors, the unused ones dimmed. */
  all: boolean;
}

const INITIAL: ColorSection = { open: true, all: false };
let remembered: ColorSection = INITIAL;

/** The section as last left in this run of the app. */
export function rememberedColorSection(): ColorSection {
  return remembered;
}

export function rememberColorSection(section: ColorSection): void {
  remembered = section;
}

/** A new start (tests render many windows in one run). */
export function forgetColorSection(): void {
  remembered = INITIAL;
}
