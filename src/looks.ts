// The two looks of ADR 0004: "hangar" (direction C, the default) and "paper" (B). One notes area
// with one logic (useNotesArea.tsx) and a layout per look; the sticky note follows the same
// setting. This module only names the looks and decides which layout a window shows: "hangar"
// has a narrow layout of its own (HangarNarrowLayout.tsx) where its two columns do not fit.

import type { MessageKey } from "./i18n";
import { SIDEBAR_WIDTH_DEFAULT } from "./columnWidth";

export type Look = "hangar" | "paper";

export const LOOKS: readonly Look[] = ["hangar", "paper"];

/** The look of a window without a stored choice. */
export const DEFAULT_LOOK: Look = "hangar";

/**
 * What a window draws: paper's cards, hangar's two columns, or hangar's narrow layout (the list or
 * the note, one at a time, with "Back").
 */
export type Layout = "paper" | "hangar" | "hangarNarrow";

/**
 * Below this width the sidebar folds away behind a button in every look (Sidebar.tsx); above it,
 * it is always there.
 */
export const NAV_MIN_WIDTH = 760;
/**
 * The room beside the sidebar from which the list and the note of "hangar" fit side by side (the
 * 600 px from which they share the room, styles.css, and a little air); with less, the window shows
 * hangar's narrow layout instead.
 */
export const HANGAR_MIN_ROOM = 608;
/** The window width "hangar" needs beside a sidebar of the default width. */
export const HANGAR_MIN_WIDTH = SIDEBAR_WIDTH_DEFAULT + HANGAR_MIN_ROOM;
/**
 * Up to this room beside the sidebar the notes show the list or the note, one at a time
 * (styles.css, `@container main (max-width: 600px)`, same number).
 */
export const NARROW_ROOM = 600;
/** Below this width "paper" lays its cards out in one column (styles.css, same number). */
export const PAPER_ONE_COLUMN_WIDTH = 560;

export function isLook(value: unknown): value is Look {
  return LOOKS.some((look) => look === value);
}

/**
 * A stored value this version does not know is the default look, as the backend reads it. That
 * includes "calm", a look of earlier builds the owner dropped (ADR 0004, amendment 2026-11-27):
 * it is not migrated on disk, the next save writes the look shown.
 */
export function lookOf(value: unknown): Look {
  return isLook(value) ? value : DEFAULT_LOOK;
}

/**
 * The layout a window of `width` px shows for `look`, with a sidebar of `sidebar` px beside the
 * notes (0 while it is folded away). A narrow window, whose sidebar folds behind a button, always
 * shows hangar's narrow layout for "hangar".
 */
export function layoutFor(look: Look, width: number, sidebar = SIDEBAR_WIDTH_DEFAULT): Layout {
  if (look === "paper") return "paper";
  return navFolded(width) || width - sidebar < HANGAR_MIN_ROOM ? "hangarNarrow" : "hangar";
}

/**
 * Whether the room beside a sidebar of `sidebar` px (0 while folded away) in a window of `width`
 * px shows the list or the note one at a time, as styles.css does from the same number.
 */
export function narrowRoom(width: number, sidebar: number): boolean {
  return width - sidebar <= NARROW_ROOM;
}

/** Whether a window of `width` px folds its sidebar away. */
export function navFolded(width: number): boolean {
  return width < NAV_MIN_WIDTH;
}

export const LOOK_NAMES: Readonly<Record<Look, MessageKey>> = {
  paper: "look.paper",
  hangar: "look.hangar",
};

export const LOOK_HINTS: Readonly<Record<Look, MessageKey>> = {
  paper: "look.paperHint",
  hangar: "look.hangarHint",
};
