import { describe, expect, it } from "vitest";

import {
  clampColumnWidth,
  COLUMN_STEP,
  COLUMN_STEP_LARGE,
  LIST_COLUMN,
  LIST_WIDTH_MAX,
  LIST_WIDTH_MIN,
  NOTE_MIN_WIDTH,
  separatorChange,
  SIDEBAR_COLUMN,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from "./columnWidth";

const key = (name: string, shift = false) => ({
  key: name,
  shiftKey: shift,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
});

const width = (next: number) => ({ kind: "width", width: next });

describe("the sidebar's width", () => {
  it("stays between the minimum and the maximum, and below 40 % of the window", () => {
    expect(clampColumnWidth(SIDEBAR_COLUMN, 100, 1400)).toBe(SIDEBAR_WIDTH_MIN);
    expect(clampColumnWidth(SIDEBAR_COLUMN, 900, 1400)).toBe(SIDEBAR_WIDTH_MAX);
    expect(clampColumnWidth(SIDEBAR_COLUMN, 260.4, 1400)).toBe(260);
    // 40 % of 800 px is 320 px.
    expect(SIDEBAR_COLUMN.max(800)).toBe(320);
    expect(clampColumnWidth(SIDEBAR_COLUMN, 380, 800)).toBe(320);
    // A narrow window never pushes the maximum below the minimum.
    expect(SIDEBAR_COLUMN.max(300)).toBe(SIDEBAR_WIDTH_MIN);
    expect(clampColumnWidth(SIDEBAR_COLUMN, Number.NaN, 1400)).toBe(SIDEBAR_WIDTH_DEFAULT);
    expect(clampColumnWidth(SIDEBAR_COLUMN, null, 1400)).toBe(SIDEBAR_WIDTH_DEFAULT);
  });

  it("moves with the arrow keys, further with Shift, to the ends with Home and End", () => {
    const at = (name: string, from: number, room: number, shift = false, rtl = false) =>
      separatorChange(SIDEBAR_COLUMN, key(name, shift), from, room, rtl);
    expect(at("ArrowRight", 232, 1400)).toEqual(width(232 + COLUMN_STEP));
    expect(at("ArrowLeft", 232, 1400)).toEqual(width(232 - COLUMN_STEP));
    expect(at("ArrowRight", 232, 1400, true)).toEqual(width(232 + COLUMN_STEP_LARGE));
    expect(at("ArrowLeft", SIDEBAR_WIDTH_MIN, 1400)).toEqual(width(SIDEBAR_WIDTH_MIN));
    expect(at("ArrowRight", 390, 1400, true)).toEqual(width(SIDEBAR_WIDTH_MAX));
    expect(at("Home", 300, 1400)).toEqual(width(SIDEBAR_WIDTH_MIN));
    expect(at("End", 200, 800)).toEqual(width(320));
    // Right to left: the edge is on the other side, so are the arrows.
    expect(at("ArrowLeft", 232, 1400, false, true)).toEqual(width(232 + COLUMN_STEP));
    expect(at("ArrowDown", 232, 1400)).toBeNull();
    expect(
      separatorChange(SIDEBAR_COLUMN, { ...key("ArrowRight"), ctrlKey: true }, 232, 1400),
    ).toBeNull();
  });

  it("asks for its natural width back with Enter", () => {
    expect(separatorChange(SIDEBAR_COLUMN, key("Enter"), 300, 1400)).toEqual({ kind: "reset" });
    expect(separatorChange(SIDEBAR_COLUMN, { ...key("Enter"), altKey: true }, 300, 1400)).toBe(
      null,
    );
  });
});

describe("the note list's width", () => {
  it("grows with the room without a choice, as styles.css does: 30 %, 280 to 420 px", () => {
    expect(clampColumnWidth(LIST_COLUMN, null, 700)).toBe(280);
    expect(clampColumnWidth(LIST_COLUMN, null, 1200)).toBe(360);
    expect(clampColumnWidth(LIST_COLUMN, null, 1672)).toBe(420);
    expect(clampColumnWidth(LIST_COLUMN, Number.POSITIVE_INFINITY, 1200)).toBe(360);
  });

  it("stays above the room for search and plus, and leaves the note its minimum", () => {
    expect(clampColumnWidth(LIST_COLUMN, 100, 1200)).toBe(LIST_WIDTH_MIN);
    expect(clampColumnWidth(LIST_COLUMN, 2000, 2000)).toBe(LIST_WIDTH_MAX);
    // 776 px beside the default sidebar in a 1024 px window: the note keeps 328 px.
    expect(LIST_COLUMN.max(776)).toBe(776 - NOTE_MIN_WIDTH);
    expect(clampColumnWidth(LIST_COLUMN, 600, 776)).toBe(448);
    // The smallest room hangar shows both columns in (looks.ts) still allows the natural width.
    expect(LIST_COLUMN.max(608)).toBe(280);
    expect(clampColumnWidth(LIST_COLUMN, null, 608)).toBe(280);
    // Less room never pushes the maximum below the minimum.
    expect(LIST_COLUMN.max(400)).toBe(LIST_WIDTH_MIN);
  });

  it("is narrowed by a smaller window and widens again for the same wish", () => {
    const wish = 500;
    expect(clampColumnWidth(LIST_COLUMN, wish, 1400)).toBe(500);
    expect(clampColumnWidth(LIST_COLUMN, wish, 700)).toBe(372);
    expect(clampColumnWidth(LIST_COLUMN, wish, 1400)).toBe(500);
  });

  it("moves with the keys within the room's range", () => {
    expect(separatorChange(LIST_COLUMN, key("ArrowRight"), 300, 776)).toEqual(width(308));
    expect(separatorChange(LIST_COLUMN, key("ArrowLeft", true), 300, 776)).toEqual(width(268));
    expect(separatorChange(LIST_COLUMN, key("End"), 300, 776)).toEqual(width(448));
    expect(separatorChange(LIST_COLUMN, key("Home"), 300, 776)).toEqual(width(LIST_WIDTH_MIN));
    expect(separatorChange(LIST_COLUMN, key("ArrowLeft"), 244, 776)).toEqual(width(LIST_WIDTH_MIN));
    expect(separatorChange(LIST_COLUMN, key("Enter"), 300, 776)).toEqual({ kind: "reset" });
  });
});
