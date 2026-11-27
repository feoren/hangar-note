// The widths of the notes area's two columns that can be dragged on their right edge: the sidebar
// (Sidebar.tsx, NotesArea.tsx) and hangar's note list (HangarLayout.tsx). Each is kept between a
// minimum and a maximum that depends on the room it has, set with the arrow keys on its edge, and
// stored in settings.json (`sidebarWidth`, `listWidth`; the same numbers as SIDEBAR_WIDTH_* and
// LIST_WIDTH_* in src-tauri/src/settings.rs). One logic for both columns. Pure logic.

/** A column whose width can be dragged: its range in `room` px and its width without a choice. */
export interface ColumnSpec {
  readonly min: number;
  /** The widest the column may be in `room` px, never below `min`. */
  readonly max: (room: number) => number;
  /** The width the column has while the person did not choose one (or reset it). */
  readonly natural: (room: number) => number;
}

/** One arrow key press moves an edge this far; with Shift, `COLUMN_STEP_LARGE`. */
export const COLUMN_STEP = 8;
export const COLUMN_STEP_LARGE = 32;

export const SIDEBAR_WIDTH_DEFAULT = 248;
export const SIDEBAR_WIDTH_MIN = 180;
export const SIDEBAR_WIDTH_MAX = 400;
/** The sidebar never takes more than this share of the window, so the notes keep their room. */
export const SIDEBAR_WINDOW_SHARE = 0.4;

/** The sidebar; its room is the window. */
export const SIDEBAR_COLUMN: ColumnSpec = {
  min: SIDEBAR_WIDTH_MIN,
  max: (room) =>
    Math.max(
      SIDEBAR_WIDTH_MIN,
      Math.min(SIDEBAR_WIDTH_MAX, Math.floor(room * SIDEBAR_WINDOW_SHARE)),
    ),
  natural: () => SIDEBAR_WIDTH_DEFAULT,
};

/** Room for the search field and "+" in the list's top row, with the sidebar folded away too. */
export const LIST_WIDTH_MIN = 240;
/** Wider than this, a list of titles only gets emptier. */
export const LIST_WIDTH_MAX = 640;
/**
 * The note beside the list keeps at least this much: its slim header with the title, the tools and
 * the look switch. The list's natural minimum and this make HANGAR_MIN_ROOM (looks.ts, 608 px), the
 * room from which hangar shows both columns, so a dragged list never pushes the note below what it
 * had there.
 */
export const NOTE_MIN_WIDTH = 328;
/**
 * Without a chosen width the list grows with the room: 30 % of it, between 280 and 420 px
 * (styles.css, `.layout-hangar`, the same numbers).
 */
export const LIST_NATURAL_MIN = 280;
export const LIST_NATURAL_MAX = 420;
export const LIST_NATURAL_SHARE = 0.3;

/** Hangar's note list; its room is the space beside the sidebar. */
export const LIST_COLUMN: ColumnSpec = {
  min: LIST_WIDTH_MIN,
  max: (room) => Math.max(LIST_WIDTH_MIN, Math.min(LIST_WIDTH_MAX, room - NOTE_MIN_WIDTH)),
  natural: (room) =>
    Math.min(LIST_NATURAL_MAX, Math.max(LIST_NATURAL_MIN, Math.round(room * LIST_NATURAL_SHARE))),
};

/**
 * `width` rounded and brought into the range `room` px allow. A width that is no number, or
 * `null` (no choice), is the column's natural width, within the same range.
 */
export function clampColumnWidth(spec: ColumnSpec, width: number | null, room: number): number {
  const wanted = width !== null && Number.isFinite(width) ? Math.round(width) : spec.natural(room);
  return Math.min(spec.max(room), Math.max(spec.min, wanted));
}

/** What a key press on a column's edge asks for: a new width, or the natural one back. */
export type SeparatorChange = { kind: "width"; width: number } | { kind: "reset" };

/**
 * The change a key press on a column's edge (role "separator") asks for, or `null` for any other
 * key: Left and Right move it by a step (Shift: a larger one), Home and End go to the smallest and
 * the widest, Enter gives it its natural width back (as a double click does). In a right-to-left
 * page the arrows swap, as the edge does.
 */
export function separatorChange(
  spec: ColumnSpec,
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey">,
  width: number,
  room: number,
  rtl = false,
): SeparatorChange | null {
  if (event.ctrlKey || event.altKey || event.metaKey) return null;
  const step = event.shiftKey ? COLUMN_STEP_LARGE : COLUMN_STEP;
  const wider = rtl ? "ArrowLeft" : "ArrowRight";
  const narrower = rtl ? "ArrowRight" : "ArrowLeft";
  const to = (next: number): SeparatorChange => ({
    kind: "width",
    width: clampColumnWidth(spec, next, room),
  });
  switch (event.key) {
    case wider:
      return to(width + step);
    case narrower:
      return to(width - step);
    case "Home":
      return to(spec.min);
    case "End":
      return to(spec.max(room));
    case "Enter":
      return { kind: "reset" };
    default:
      return null;
  }
}
