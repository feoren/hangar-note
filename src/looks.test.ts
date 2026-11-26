import { describe, expect, it } from "vitest";

import { DICTIONARIES } from "./i18n";
import {
  HANGAR_MIN_WIDTH,
  isLook,
  layoutFor,
  LOOK_HINTS,
  LOOK_NAMES,
  LOOKS,
  lookOf,
  NAV_MIN_WIDTH,
  navFolded,
} from "./looks";

describe("looks", () => {
  it("are calm, paper and hangar, calm first as the default", () => {
    expect(LOOKS).toEqual(["calm", "paper", "hangar"]);
    expect(isLook("paper")).toBe(true);
    expect(isLook("neon")).toBe(false);
  });

  it("read an unknown value as calm, as the backend does", () => {
    expect(lookOf("hangar")).toBe("hangar");
    expect(lookOf("neon")).toBe("calm");
    expect(lookOf(undefined)).toBe("calm");
    expect(lookOf(7)).toBe("calm");
  });

  it("fall back from hangar's columns to calm's layout below 840 px", () => {
    expect(layoutFor("hangar", HANGAR_MIN_WIDTH)).toBe("hangar");
    expect(layoutFor("hangar", HANGAR_MIN_WIDTH - 1)).toBe("calm");
    expect(layoutFor("paper", 320)).toBe("paper");
    expect(layoutFor("calm", 1200)).toBe("calm");
    // A sidebar folded away or narrowed leaves the room; a wider one takes it.
    expect(layoutFor("hangar", 780, 0)).toBe("hangar");
    expect(layoutFor("hangar", 780, 180)).toBe("calm");
    expect(layoutFor("hangar", 1000, 400)).toBe("calm");
    expect(layoutFor("hangar", 1010, 400)).toBe("hangar");
    // Below the folding width the hangar look is always calm's, even without a sidebar.
    expect(layoutFor("hangar", 700, 0)).toBe("calm");
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
