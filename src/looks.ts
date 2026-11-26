// The three looks of ADR 0004: "calm" (direction A, the default), "paper" (B) and "hangar" (C).
// One notes area with one logic (useNotesArea.tsx) and a layout per look; the sticky note follows
// the same setting. This module only names the looks and decides which layout a window shows.

import type { MessageKey } from "./i18n";

export type Look = "calm" | "paper" | "hangar";

export const LOOKS: readonly Look[] = ["calm", "paper", "hangar"];

/**
 * Below this width the sidebar folds away behind a button in every look (Sidebar.tsx); above it,
 * it is always there.
 */
export const NAV_MIN_WIDTH = 760;
/**
 * The room beside the sidebar from which the list and the note of "hangar" fit side by side (the
 * 600 px from which they share the room, styles.css, and a little air); with less, the window shows
 * calm's layout instead.
 */
export const HANGAR_MIN_ROOM = 608;
/** The window width "hangar" needs beside a sidebar of the default 232 px. */
export const HANGAR_MIN_WIDTH = 232 + HANGAR_MIN_ROOM;
/** Below this width "paper" lays its cards out in one column (styles.css, same number). */
export const PAPER_ONE_COLUMN_WIDTH = 560;

export function isLook(value: unknown): value is Look {
  return LOOKS.some((look) => look === value);
}

/** A stored value this version does not know is the calm look, as the backend reads it. */
export function lookOf(value: unknown): Look {
  return isLook(value) ? value : "calm";
}

/**
 * The layout a window of `width` px shows for `look`, with a sidebar of `sidebar` px beside the
 * notes (0 while it is folded away). A narrow window, whose sidebar folds behind a button, always
 * shows calm's layout for "hangar".
 */
export function layoutFor(look: Look, width: number, sidebar = 232): Look {
  if (look !== "hangar") return look;
  return navFolded(width) || width - sidebar < HANGAR_MIN_ROOM ? "calm" : "hangar";
}

/** Whether a window of `width` px folds its sidebar away. */
export function navFolded(width: number): boolean {
  return width < NAV_MIN_WIDTH;
}

export const LOOK_NAMES: Readonly<Record<Look, MessageKey>> = {
  calm: "look.calm",
  paper: "look.paper",
  hangar: "look.hangar",
};

export const LOOK_HINTS: Readonly<Record<Look, MessageKey>> = {
  calm: "look.calmHint",
  paper: "look.paperHint",
  hangar: "look.hangarHint",
};
