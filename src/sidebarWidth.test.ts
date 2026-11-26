import { describe, expect, it } from "vitest";

import {
  clampSidebarWidth,
  maxSidebarWidth,
  separatorWidth,
  SIDEBAR_STEP,
  SIDEBAR_STEP_LARGE,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from "./sidebarWidth";

const key = (name: string, shift = false) => ({
  key: name,
  shiftKey: shift,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
});

describe("the sidebar's width", () => {
  it("stays between the minimum and the maximum, and below 40 % of the window", () => {
    expect(clampSidebarWidth(100, 1400)).toBe(SIDEBAR_WIDTH_MIN);
    expect(clampSidebarWidth(900, 1400)).toBe(SIDEBAR_WIDTH_MAX);
    expect(clampSidebarWidth(260.4, 1400)).toBe(260);
    // 40 % of 800 px is 320 px.
    expect(maxSidebarWidth(800)).toBe(320);
    expect(clampSidebarWidth(380, 800)).toBe(320);
    // A narrow window never pushes the maximum below the minimum.
    expect(maxSidebarWidth(300)).toBe(SIDEBAR_WIDTH_MIN);
    expect(clampSidebarWidth(Number.NaN, 1400)).toBe(SIDEBAR_WIDTH_DEFAULT);
  });

  it("moves with the arrow keys, further with Shift, to the ends with Home and End", () => {
    expect(separatorWidth(key("ArrowRight"), 232, 1400)).toBe(232 + SIDEBAR_STEP);
    expect(separatorWidth(key("ArrowLeft"), 232, 1400)).toBe(232 - SIDEBAR_STEP);
    expect(separatorWidth(key("ArrowRight", true), 232, 1400)).toBe(232 + SIDEBAR_STEP_LARGE);
    expect(separatorWidth(key("ArrowLeft"), SIDEBAR_WIDTH_MIN, 1400)).toBe(SIDEBAR_WIDTH_MIN);
    expect(separatorWidth(key("ArrowRight", true), 390, 1400)).toBe(SIDEBAR_WIDTH_MAX);
    expect(separatorWidth(key("Home"), 300, 1400)).toBe(SIDEBAR_WIDTH_MIN);
    expect(separatorWidth(key("End"), 200, 800)).toBe(320);
    // Right to left: the edge is on the other side, so are the arrows.
    expect(separatorWidth(key("ArrowLeft"), 232, 1400, true)).toBe(232 + SIDEBAR_STEP);
    expect(separatorWidth(key("ArrowDown"), 232, 1400)).toBeNull();
    expect(separatorWidth({ ...key("ArrowRight"), ctrlKey: true }, 232, 1400)).toBeNull();
  });
});
