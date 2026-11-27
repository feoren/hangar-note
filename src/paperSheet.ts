// The paper look opens a note only by choice (ADR 0004, amendment 2026-11-27): its open note is a
// modal sheet over the cards, and a sheet that opens by itself hides the cards the person came
// for. The choices that open it: a click or Enter on a card (also "Rename" in a card's menu), "+"
// and the quick note key, and a request from Hangar or the command line that names a note or
// brings a text (`open --note`, quick note, capture). Everything else shows the cards: switching
// to paper with a note open, the way back from the trash or the settings, another level or area,
// Hangar showing its project, and undoing a delete. A note open at such a step is saved and closed
// first; one that cannot be saved stays open, so no text is lost. Pure rules, no state.

import type { Look } from "./looks";

/** Whether `look` opens a note only by an explicit choice, so every other way shows the list. */
export function opensOnlyByChoice(look: Look): boolean {
  return look === "paper";
}

/**
 * The look the notes area keeps drawing while its open note is saved and closed, after the look
 * changed from `before` to `after` with a note open (`noteOpen`); `null` when nothing waits.
 * `before` is `null` until the settings were read: the first look of a window is no change, so a
 * note a request opened at the start stays open.
 */
export function lookToHold(
  before: Look | null,
  after: Look | null,
  noteOpen: boolean,
): Look | null {
  if (before === null || after === null || before === after || !noteOpen) return null;
  return opensOnlyByChoice(after) && !opensOnlyByChoice(before) ? before : null;
}
