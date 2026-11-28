// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  forgetUnsavedLineNumbers,
  parseLineNumbers,
  readStickyLineNumbers,
  STICKY_LINE_NUMBERS_DEFAULT,
  STICKY_LINE_NUMBERS_KEY,
  writeStickyLineNumbers,
} from "./stickyLineNumbers";

afterEach(() => {
  vi.restoreAllMocks();
  forgetUnsavedLineNumbers();
  localStorage.clear();
});

describe("sticky note line numbers", () => {
  it("are off unless stored otherwise", () => {
    expect(STICKY_LINE_NUMBERS_DEFAULT).toBe(false);
    expect(readStickyLineNumbers()).toBe(false);
    expect(parseLineNumbers("1")).toBe(true);
    expect(parseLineNumbers("0")).toBe(false);
    for (const other of [null, "", "true", "yes"]) {
      expect(parseLineNumbers(other)).toBe(STICKY_LINE_NUMBERS_DEFAULT);
    }
  });

  it("are kept in storage under their own key", () => {
    writeStickyLineNumbers(true);
    expect(localStorage.getItem(STICKY_LINE_NUMBERS_KEY)).toBe("1");
    expect(readStickyLineNumbers()).toBe(true);
    writeStickyLineNumbers(false);
    expect(readStickyLineNumbers()).toBe(false);
  });

  it("fall back to the default when storage refuses to be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readStickyLineNumbers()).toBe(STICKY_LINE_NUMBERS_DEFAULT);
  });

  it("hold for this window when storage refuses to keep them", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    writeStickyLineNumbers(true);
    expect(readStickyLineNumbers()).toBe(true);
  });
});
