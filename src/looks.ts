// The three looks of ADR 0004: "calm" (direction A, the default), "paper" (B) and "hangar" (C).
// One notes area with one logic (useNotesArea.tsx) and a layout per look; the sticky note follows
// the same setting. This module only names the looks and decides which layout a window shows.

import type { MessageKey } from "./i18n";

export type Look = "calm" | "paper" | "hangar";

export const LOOKS: readonly Look[] = ["calm", "paper", "hangar"];

/** Below this width the three columns of "hangar" do not fit; it shows calm's narrow layout. */
export const HANGAR_MIN_WIDTH = 760;
/** Below this width "paper" lays its cards out in one column (styles.css, same number). */
export const PAPER_ONE_COLUMN_WIDTH = 560;

export function isLook(value: unknown): value is Look {
  return LOOKS.some((look) => look === value);
}

/** A stored value this version does not know is the calm look, as the backend reads it. */
export function lookOf(value: unknown): Look {
  return isLook(value) ? value : "calm";
}

/** The layout a window of `width` px shows for `look`. */
export function layoutFor(look: Look, width: number): Look {
  return look === "hangar" && width < HANGAR_MIN_WIDTH ? "calm" : look;
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
