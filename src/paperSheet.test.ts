import { describe, expect, it } from "vitest";

import { lookToHold, opensOnlyByChoice } from "./paperSheet";

describe("paper sheet", () => {
  it("opens a note only by choice in the paper look", () => {
    expect(opensOnlyByChoice("paper")).toBe(true);
    expect(opensOnlyByChoice("hangar")).toBe(false);
  });

  it("holds the old look while an open note closes for paper", () => {
    expect(lookToHold("hangar", "paper", true)).toBe("hangar");
    // Nothing open, nothing to close.
    expect(lookToHold("hangar", "paper", false)).toBeNull();
    // Away from paper, the note may stay open.
    expect(lookToHold("paper", "hangar", true)).toBeNull();
    expect(lookToHold("paper", "paper", true)).toBeNull();
    // The first look of a window, once the settings are read, is no change: a note a request
    // opened at the start stays open.
    expect(lookToHold(null, "paper", true)).toBeNull();
    expect(lookToHold("hangar", null, true)).toBeNull();
  });
});
