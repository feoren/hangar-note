import { describe, expect, it } from "vitest";

import { fitMenu, MENU_MARGIN } from "./menuPlacement";

const view = { width: 440, height: 600 };
const menu = { width: 200, height: 80 };

describe("fitMenu", () => {
  it("keeps the requested point when the menu fits", () => {
    expect(fitMenu({ x: 40, y: 100 }, menu, view)).toEqual({ x: 40, y: 100 });
  });

  it("moves a menu that would leave the right edge back inside", () => {
    // The "more" button of a card sits at the right edge of "All notes".
    expect(fitMenu({ x: 390, y: 150 }, menu, view)).toEqual({
      x: view.width - menu.width - MENU_MARGIN,
      y: 150,
    });
  });

  it("opens above the point when there is no room below", () => {
    expect(fitMenu({ x: 40, y: 560 }, menu, view)).toEqual({ x: 40, y: 480 });
  });

  it("never goes past the top left margin, even in a tiny window", () => {
    expect(fitMenu({ x: 10, y: 20 }, menu, { width: 150, height: 90 })).toEqual({
      x: MENU_MARGIN,
      y: MENU_MARGIN,
    });
  });
});
