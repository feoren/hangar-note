import { describe, expect, it } from "vitest";

import type { NoteColor } from "./colors";
import {
  colorRows,
  forgetColorSection,
  hasHiddenColors,
  rememberColorSection,
  rememberedColorSection,
} from "./sidebarColors";

const counts = new Map<NoteColor, number>([
  ["sky", 3],
  ["lemon", 1],
]);

describe("colorRows", () => {
  it("lists the used colors in the colors' own order, with their counts", () => {
    expect(colorRows(counts, new Set(), false)).toEqual([
      { color: "lemon", count: 1 },
      { color: "sky", count: 3 },
    ]);
  });

  it("keeps a chosen color that no shown note uses, so its filter can be switched off", () => {
    expect(colorRows(counts, new Set<NoteColor>(["rose"]), false).map((row) => row.color)).toEqual([
      "lemon",
      "sky",
      "rose",
    ]);
  });

  it("lists all eight on request, the unused with 0", () => {
    const rows = colorRows(counts, new Set(), true);
    expect(rows).toHaveLength(8);
    expect(rows.find((row) => row.color === "slate")?.count).toBe(0);
  });

  it("says whether Show all has something to add", () => {
    expect(hasHiddenColors(counts, new Set())).toBe(true);
    const all = new Map<NoteColor, number>(
      (["lemon", "peach", "mint", "sky", "lilac", "rose", "sand", "slate"] as const).map(
        (color) => [color, 1],
      ),
    );
    expect(hasHiddenColors(all, new Set())).toBe(false);
  });
});

describe("the color section's memory", () => {
  it("starts open with the used colors and keeps what was set until a new start", () => {
    forgetColorSection();
    expect(rememberedColorSection()).toEqual({ open: true, all: false });
    rememberColorSection({ open: false, all: true });
    expect(rememberedColorSection()).toEqual({ open: false, all: true });
    forgetColorSection();
    expect(rememberedColorSection()).toEqual({ open: true, all: false });
  });
});
