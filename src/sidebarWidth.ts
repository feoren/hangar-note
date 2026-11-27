// The sidebar's width (Sidebar.tsx, NotesArea.tsx): dragged on its right edge or set with the
// arrow keys on that edge, kept between a minimum and a maximum, and stored in settings.json
// (`sidebarWidth`, the same numbers as SIDEBAR_WIDTH_* in src-tauri/src/settings.rs). Pure logic.

export const SIDEBAR_WIDTH_DEFAULT = 248;
export const SIDEBAR_WIDTH_MIN = 180;
export const SIDEBAR_WIDTH_MAX = 400;
/** The sidebar never takes more than this share of the window, so the notes keep their room. */
export const SIDEBAR_WINDOW_SHARE = 0.4;
/** One arrow key press moves the edge this far; with Shift, `SIDEBAR_STEP_LARGE`. */
export const SIDEBAR_STEP = 8;
export const SIDEBAR_STEP_LARGE = 32;

/** The widest the sidebar may be in a window `windowWidth` px wide, never below the minimum. */
export function maxSidebarWidth(windowWidth: number): number {
  return Math.max(
    SIDEBAR_WIDTH_MIN,
    Math.min(SIDEBAR_WIDTH_MAX, Math.floor(windowWidth * SIDEBAR_WINDOW_SHARE)),
  );
}

/** `width` rounded and brought into the range a window `windowWidth` px wide allows. */
export function clampSidebarWidth(width: number, windowWidth: number): number {
  if (!Number.isFinite(width)) return Math.min(SIDEBAR_WIDTH_DEFAULT, maxSidebarWidth(windowWidth));
  return Math.min(maxSidebarWidth(windowWidth), Math.max(SIDEBAR_WIDTH_MIN, Math.round(width)));
}

/**
 * The new width after a key press on the sidebar's edge (role "separator"), or `null` for any
 * other key: Left and Right move it by a step (Shift: a larger one), Home and End go to the
 * smallest and the widest. In a right-to-left page the arrows swap, as the edge does.
 */
export function separatorWidth(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey">,
  width: number,
  windowWidth: number,
  rtl = false,
): number | null {
  if (event.ctrlKey || event.altKey || event.metaKey) return null;
  const step = event.shiftKey ? SIDEBAR_STEP_LARGE : SIDEBAR_STEP;
  const wider = rtl ? "ArrowLeft" : "ArrowRight";
  const narrower = rtl ? "ArrowRight" : "ArrowLeft";
  switch (event.key) {
    case wider:
      return clampSidebarWidth(width + step, windowWidth);
    case narrower:
      return clampSidebarWidth(width - step, windowWidth);
    case "Home":
      return SIDEBAR_WIDTH_MIN;
    case "End":
      return maxSidebarWidth(windowWidth);
    default:
      return null;
  }
}
