// Cases taken from Hangar's src/notes.test.ts, plus the auto title and the color filter.
import { describe, expect, it } from "vitest";

import {
  byLastChange,
  cleanTitle,
  colorCounts,
  filterByColors,
  folderName,
  isUntitled,
  nextAutoTitle,
  noteKey,
  sameFolder,
  sameNote,
  titleFromText,
} from "./notes";

describe("scopes", () => {
  it("compare Windows paths ignoring case and separator differences", () => {
    expect(sameFolder({ path: "C:\\Repo\\Hangar\\" }, { path: "c:/repo/hangar" })).toBe(true);
    expect(sameFolder({ path: "/home/a/Repo" }, { path: "/home/a/repo" })).toBe(false);
    expect(sameFolder({ path: null }, { path: null })).toBe(true);
    expect(sameFolder({ path: null }, { path: "/" })).toBe(false);
  });

  it("name a folder by its last part", () => {
    expect(folderName("C:\\Projects\\Web Shop\\")).toBe("Web Shop");
    expect(folderName("/home/a/repo")).toBe("repo");
  });
});

describe("titles", () => {
  it("validate like the backend", () => {
    expect(cleanTitle("  Ideas ")).toBe("Ideas");
    expect(cleanTitle("   ")).toBeNull();
    expect(cleanTitle("a\nb")).toBeNull();
    expect(cleanTitle("x".repeat(201))).toBeNull();
    expect(cleanTitle("😀".repeat(200))).not.toBeNull();
  });
});

describe("titleFromText", () => {
  it("takes the first non-empty line without Markdown characters", () => {
    expect(titleFromText("# Shopping\n- Milk")).toBe("Shopping");
    expect(titleFromText("\n\n  ## **Plan** for `tomorrow`  \n")).toBe("Plan for tomorrow");
    expect(titleFromText("- [ ] Build release")).toBe("Build release");
    expect(titleFromText("> Quote")).toBe("Quote");
    expect(titleFromText("1. Step one")).toBe("Step one");
    expect(titleFromText("---\nText")).toBe("Text");
  });

  it("keeps escaped characters of a captured heading", () => {
    expect(titleFromText("_Aus my\\_project, 26. Nov._\n\n```\nx\n```")).toBe(
      "Aus my_project, 26. Nov.",
    );
  });

  it("returns null without content", () => {
    expect(titleFromText("")).toBeNull();
    expect(titleFromText("   \n#\n- \n")).toBeNull();
  });

  it("shortens long lines with an ellipsis", () => {
    const title = titleFromText("a".repeat(100));
    expect(title).toBe(`${"a".repeat(59)}…`);
    expect(Array.from(title ?? "")).toHaveLength(60);
  });
});

describe("isUntitled", () => {
  const bases = ["Notiz", "Note"];

  it("recognizes names of new notes in every language", () => {
    expect(isUntitled("Notiz 1", bases)).toBe(true);
    expect(isUntitled("note 12", bases)).toBe(true);
    expect(isUntitled("Notizen", bases)).toBe(false);
    expect(isUntitled("Notiz 1a", bases)).toBe(false);
    expect(isUntitled("Shopping", bases)).toBe(false);
  });

  it("decides when a title follows the first line", () => {
    const bases = ["Notiz"];
    expect(nextAutoTitle({ title: "Notiz 3", autoTitled: false }, "# Plan", bases)).toBe("Plan");
    expect(nextAutoTitle({ title: "Plan", autoTitled: true }, "Plan\nmore", bases)).toBeNull();
    expect(nextAutoTitle({ title: "Plan", autoTitled: true }, "Neu", bases)).toBe("Neu");
    expect(nextAutoTitle({ title: "Mine", autoTitled: false }, "Other", bases)).toBeNull();
    expect(nextAutoTitle({ title: "Notiz 1", autoTitled: true }, "  ", bases)).toBeNull();
  });
});

describe("lists", () => {
  it("sort by last change, notes without a time last", () => {
    const notes = [
      { title: "b", updatedAt: 1 },
      { title: "a", updatedAt: null },
      { title: "c", updatedAt: 9 },
      { title: "d", updatedAt: 1 },
    ];
    expect(byLastChange(notes).map((n) => n.title)).toEqual(["c", "b", "d", "a"]);
  });

  it("tell notes of different scopes apart", () => {
    const a = { folder: { path: "C:\\p" }, id: "1" };
    expect(sameNote(a, { folder: { path: "c:/p" }, id: "1" })).toBe(true);
    expect(sameNote(a, { folder: { path: null }, id: "1" })).toBe(false);
    expect(noteKey(a)).not.toBe(noteKey({ folder: { path: null }, id: "1" }));
  });
});

describe("color filter", () => {
  const rows = [
    { id: "a", color: "mint" as const },
    { id: "b", color: "sky" as const },
    { id: "c", color: "mint" as const },
  ];

  it("shows everything without a choice and the chosen colors otherwise", () => {
    expect(filterByColors(rows, new Set())).toHaveLength(3);
    expect(filterByColors(rows, new Set(["mint"] as const)).map((r) => r.id)).toEqual(["a", "c"]);
    expect(filterByColors(rows, new Set(["mint", "sky"] as const))).toHaveLength(3);
    expect(filterByColors(rows, new Set(["rose"] as const))).toEqual([]);
  });

  it("counts the rows per color", () => {
    const counts = colorCounts(rows);
    expect(counts.get("mint")).toBe(2);
    expect(counts.get("sky")).toBe(1);
    expect(counts.get("rose")).toBeUndefined();
  });
});
