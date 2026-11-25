import { describe, expect, it } from "vitest";

import { menuStep } from "./menuKeys";

describe("menuStep", () => {
  it("moves down and up and wraps around at both ends", () => {
    expect(menuStep("ArrowDown", 0, 3)).toBe(1);
    expect(menuStep("ArrowDown", 2, 3)).toBe(0);
    expect(menuStep("ArrowUp", 1, 3)).toBe(0);
    expect(menuStep("ArrowUp", 0, 3)).toBe(2);
  });

  it("goes to the first and the last item with Home and End", () => {
    expect(menuStep("Home", 2, 4)).toBe(0);
    expect(menuStep("End", 0, 4)).toBe(3);
  });

  it("starts at the matching end when no item has the focus", () => {
    expect(menuStep("ArrowDown", -1, 3)).toBe(0);
    expect(menuStep("ArrowUp", -1, 3)).toBe(2);
  });

  it("ignores other keys and empty menus", () => {
    expect(menuStep("Enter", 0, 3)).toBeNull();
    expect(menuStep("ArrowLeft", 0, 3)).toBeNull();
    expect(menuStep("ArrowDown", -1, 0)).toBeNull();
  });
});
