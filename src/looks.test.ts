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

  it("fall back from hangar's three columns to calm's narrow layout below 760 px", () => {
    expect(layoutFor("hangar", HANGAR_MIN_WIDTH)).toBe("hangar");
    expect(layoutFor("hangar", HANGAR_MIN_WIDTH - 1)).toBe("calm");
    expect(layoutFor("paper", 320)).toBe("paper");
    expect(layoutFor("calm", 1200)).toBe("calm");
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
