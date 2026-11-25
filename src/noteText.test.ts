import { describe, expect, it } from "vitest";

import {
  filterNotes,
  MAX_TITLE_CHARS,
  matchesQuery,
  noteExcerpt,
  noteTitle,
  taskMarkOffset,
  toggleLinePrefix,
  toggleWrap,
} from "./noteText";

describe("noteTitle", () => {
  it("is the first non-empty line without Markdown marks", () => {
    expect(noteTitle("Einkaufen\nMilch")).toBe("Einkaufen");
    expect(noteTitle("\n\n   \n  Später  \nmehr")).toBe("Später");
    expect(noteTitle("# Plan für **Montag**")).toBe("Plan für Montag");
    expect(noteTitle("- [ ] Anrufen")).toBe("Anrufen");
    expect(noteTitle("- [x] ~~Erledigt~~")).toBe("Erledigt");
    expect(noteTitle("1. Erster Punkt")).toBe("Erster Punkt");
    expect(noteTitle("> Zitat mit *Betonung*")).toBe("Zitat mit Betonung");
    expect(noteTitle("Code `npm run`")).toBe("Code npm run");
    expect(noteTitle("Zeile\r\nzwei")).toBe("Zeile");
  });

  it("keeps characters that only look like marks", () => {
    expect(noteTitle("2 * 3 = 6")).toBe("2 * 3 = 6");
    expect(noteTitle("snake_case_name")).toBe("snake_case_name");
  });

  it("is null for a note without visible text", () => {
    expect(noteTitle("")).toBeNull();
    expect(noteTitle("\n  \n")).toBeNull();
    expect(noteTitle("#\n- \n- [ ] ")).toBeNull();
  });

  it("is cut with an ellipsis, not in the middle of a character", () => {
    const title = noteTitle("😀".repeat(100));
    expect(title).not.toBeNull();
    expect(Array.from(title ?? "")).toHaveLength(MAX_TITLE_CHARS);
    expect(title?.endsWith("…")).toBe(true);
  });
});

describe("noteExcerpt", () => {
  it("joins the lines after the title", () => {
    expect(noteExcerpt("Titel\n\n- [ ] Milch\n- [x] Brot")).toBe("Milch · Brot");
    expect(noteExcerpt("Nur ein Titel")).toBe("");
    expect(noteExcerpt("")).toBe("");
  });
});

describe("search in All notes", () => {
  const notes = [
    { id: "a", preview: "Einkaufen\n- Milch\n- Brot" },
    { id: "b", preview: "Café am Montag" },
    { id: "c", preview: "Release notes\nVersion 0.1.0" },
  ];

  it("finds every term anywhere, case- and accent-insensitive", () => {
    expect(filterNotes(notes, "milch").map((n) => n.id)).toEqual(["a"]);
    expect(filterNotes(notes, "CAFE").map((n) => n.id)).toEqual(["b"]);
    expect(filterNotes(notes, "brot einkaufen").map((n) => n.id)).toEqual(["a"]);
    expect(filterNotes(notes, "brot montag")).toEqual([]);
    expect(filterNotes(notes, "0.1").map((n) => n.id)).toEqual(["c"]);
  });

  it("shows everything for an empty query and keeps the order", () => {
    expect(filterNotes(notes, "").map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(filterNotes(notes, "   ").map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(matchesQuery("anything", "")).toBe(true);
  });
});

describe("formatting toggles", () => {
  it("wraps the selection and unwraps it again", () => {
    const text = "ein Wort hier";
    const bold = toggleWrap(text, 4, 8, "**");
    expect(bold).toEqual({
      from: 4,
      to: 8,
      insert: "**Wort**",
      selection: { anchor: 6, head: 10 },
    });
    const applied = "ein **Wort** hier";
    expect(toggleWrap(applied, 6, 10, "**")).toEqual({
      from: 4,
      to: 12,
      insert: "Wort",
      selection: { anchor: 4, head: 8 },
    });
    // The whole marked word selected.
    expect(toggleWrap(applied, 4, 12, "**").insert).toBe("Wort");
    // Without a selection the cursor lands between the marks.
    expect(toggleWrap("", 0, 0, "~~")).toEqual({
      from: 0,
      to: 0,
      insert: "~~~~",
      selection: { anchor: 2, head: 2 },
    });
  });

  it("turns lines into bullets or tasks and back", () => {
    expect(toggleLinePrefix(["Milch", "  Brot"], "bullet")).toEqual(["- Milch", "  - Brot"]);
    expect(toggleLinePrefix(["- Milch", "- Brot"], "bullet")).toEqual(["Milch", "Brot"]);
    expect(toggleLinePrefix(["- Milch"], "task")).toEqual(["- [ ] Milch"]);
    expect(toggleLinePrefix(["- [x] Milch", "- [ ] Brot"], "task")).toEqual(["Milch", "Brot"]);
    expect(toggleLinePrefix(["- [ ] Milch"], "bullet")).toEqual(["- Milch"]);
    expect(toggleLinePrefix(["Milch", "- Brot"], "bullet")).toEqual(["- Milch", "- Brot"]);
  });

  it("finds the box of a task line", () => {
    expect(taskMarkOffset("- [ ] a")).toBe(3);
    expect(taskMarkOffset("  * [x] a")).toBe(5);
    expect(taskMarkOffset("1. [ ] a")).toBe(4);
    expect(taskMarkOffset("- a")).toBeNull();
  });
});
