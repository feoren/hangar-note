import { describe, expect, it } from "vitest";

import { DICTIONARIES } from "./i18n";
import {
  DEFAULT_LOOK,
  HANGAR_MIN_ROOM,
  HANGAR_MIN_WIDTH,
  isLook,
  layoutFor,
  LOOK_HINTS,
  LOOK_NAMES,
  LOOKS,
  lookOf,
  NARROW_ROOM,
  NAV_MIN_WIDTH,
  narrowRoom,
  navFolded,
} from "./looks";
import { LIST_NATURAL_MIN, NOTE_MIN_WIDTH, SIDEBAR_WIDTH_DEFAULT } from "./columnWidth";

describe("looks", () => {
  it("are hangar and paper, hangar first as the default", () => {
    expect(LOOKS).toEqual(["hangar", "paper"]);
    expect(DEFAULT_LOOK).toBe("hangar");
    expect(isLook("paper")).toBe(true);
    expect(isLook("neon")).toBe(false);
    // The dropped look of earlier builds is no look any more.
    expect(isLook("calm")).toBe(false);
  });

  it("read a stored calm or an unknown value as hangar, as the backend does", () => {
    expect(lookOf("paper")).toBe("paper");
    expect(lookOf("hangar")).toBe("hangar");
    expect(lookOf("calm")).toBe("hangar");
    expect(lookOf("neon")).toBe("hangar");
    expect(lookOf(undefined)).toBe("hangar");
    expect(lookOf(7)).toBe("hangar");
  });

  it("give hangar its narrow layout where its columns do not fit beside the sidebar", () => {
    expect(SIDEBAR_WIDTH_DEFAULT).toBe(248);
    expect(HANGAR_MIN_WIDTH).toBe(856);
    // A dragged list leaves the note at least what it has where both columns first fit.
    expect(LIST_NATURAL_MIN + NOTE_MIN_WIDTH).toBe(HANGAR_MIN_ROOM);
    expect(layoutFor("hangar", 856)).toBe("hangar");
    expect(layoutFor("hangar", 855)).toBe("hangarNarrow");
    expect(layoutFor("hangar", HANGAR_MIN_WIDTH)).toBe("hangar");
    expect(layoutFor("hangar", HANGAR_MIN_WIDTH - 1)).toBe("hangarNarrow");
    expect(layoutFor("hangar", 2000)).toBe("hangar");
    // Paper's cards fit every width.
    expect(layoutFor("paper", 320)).toBe("paper");
    expect(layoutFor("paper", 2000)).toBe("paper");
    // A sidebar folded away or narrowed leaves the room; a wider one takes it.
    expect(layoutFor("hangar", 780, 0)).toBe("hangar");
    expect(layoutFor("hangar", 780, 180)).toBe("hangarNarrow");
    expect(layoutFor("hangar", 1000, 400)).toBe("hangarNarrow");
    expect(layoutFor("hangar", 1010, 400)).toBe("hangar");
    // Below the folding width hangar is always narrow, even without a sidebar.
    expect(layoutFor("hangar", 700, 0)).toBe("hangarNarrow");
    expect(layoutFor("hangar", 320, 0)).toBe("hangarNarrow");
  });

  it("show the list or the note one at a time up to 600 px of room beside the sidebar", () => {
    expect(NARROW_ROOM).toBe(600);
    expect(narrowRoom(848, 248)).toBe(true);
    expect(narrowRoom(849, 248)).toBe(false);
    expect(narrowRoom(600, 0)).toBe(true);
    expect(narrowRoom(1280, 0)).toBe(false);
  });

  it("fold the sidebar away below 760 px, in every look", () => {
    expect(NAV_MIN_WIDTH).toBe(760);
    expect(navFolded(759)).toBe(true);
    expect(navFolded(760)).toBe(false);
    expect(navFolded(320)).toBe(true);
  });

  it("have a name and a hint in every language", () => {
    for (const look of LOOKS) {
      for (const dictionary of Object.values(DICTIONARIES)) {
        expect(dictionary[LOOK_NAMES[look]]).toBeTruthy();
        expect(dictionary[LOOK_HINTS[look]]).toBeTruthy();
      }
    }
  });
});
