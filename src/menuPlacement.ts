// Where a popup menu goes so it stays inside the window: at the requested point when it fits,
// otherwise moved left or shown above the point. Pure, so the edge cases are testable.

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Distance kept from the window's edges. */
export const MENU_MARGIN = 8;

export function fitMenu(at: Point, menu: Size, view: Size, margin = MENU_MARGIN): Point {
  const maxX = view.width - menu.width - margin;
  const x = Math.max(margin, Math.min(at.x, maxX));
  const below = at.y + menu.height + margin <= view.height;
  const y = below
    ? at.y
    : Math.max(margin, Math.min(at.y - menu.height, view.height - menu.height - margin));
  return { x, y };
}
