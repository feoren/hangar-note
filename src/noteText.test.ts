// Checklist, word count, excerpt and capture cases taken from Hangar's src/noteText.test.ts.
import { describe, expect, it } from "vitest";

import {
  appendCapture,
  checklistProgress,
  editorText,
  isListLine,
  isTaskLine,
  EXCERPT_ITEM_SEPARATOR,
  noteExcerpt,
  taskMarkOffset,
  toggleLinePrefix,
  toggleTaskAtLine,
  toggleWrap,
  wordCount,
} from "./noteText";

describe("checklists", () => {
  const text = "# Plan\n- [x] one\n- [ ] two\n  * [X] nested\n1. [ ] numbered\n- [] no\n";

  it("counts ticked and all tasks", () => {
    expect(checklistProgress(text)).toEqual({ done: 2, total: 4 });
    expect(checklistProgress("nothing")).toEqual({ done: 0, total: 0 });
  });

  it("ignores tasks inside code blocks", () => {
    expect(checklistProgress("```\n- [ ] code\n```\n- [ ] real\n~~~\n- [x] x\n~~~")).toEqual({
      done: 0,
      total: 1,
    });
  });

  it("toggles exactly the given line and keeps line endings", () => {
    expect(toggleTaskAtLine(text, 2)).toBe(text.replace("- [ ] two", "- [x] two"));
    expect(toggleTaskAtLine(text, 1)).toBe(text.replace("- [x] one", "- [ ] one"));
    expect(toggleTaskAtLine("a\r\n- [ ] b\r\n", 1)).toBe("a\r\n- [x] b\r\n");
    expect(toggleTaskAtLine(text, 0)).toBe(text);
    expect(toggleTaskAtLine(text, 99)).toBe(text);
    expect(toggleTaskAtLine("```\n- [ ] c\n```", 1)).toBe("```\n- [ ] c\n```");
  });

  it("finds task lines and the box position", () => {
    expect(isTaskLine(text, 3)).toBe(true);
    expect(isTaskLine(text, 5)).toBe(false);
    expect(taskMarkOffset("  - [ ] x")).toBe(5);
    expect(taskMarkOffset("- x")).toBeNull();
  });

  it("recognizes list items", () => {
    expect(isListLine("- a")).toBe(true);
    expect(isListLine("  12. a")).toBe(true);
    expect(isListLine("-a")).toBe(false);
    expect(isListLine("text")).toBe(false);
  });
});

describe("wordCount", () => {
  it("counts words, not symbols", () => {
    expect(wordCount("", "en")).toBe(0);
    expect(wordCount("  \n ", "en")).toBe(0);
    expect(wordCount("# Hello world\n- [ ] two words", "en")).toBe(4);
  });
});

describe("noteExcerpt", () => {
  it("skips the title line and Markdown characters", () => {
    expect(noteExcerpt("# Plan\n\n- [ ] write **tests**\n> quote", "Plan")).toBe(
      "write tests · quote",
    );
    expect(noteExcerpt("Plan", "Plan")).toBe("");
  });

  // A checklist reads as separate entries, not as one sentence without punctuation.
  it("sets list items and checklist entries apart, prose runs on", () => {
    expect(noteExcerpt("Todo\n- [ ] milk\n- [x] bread\n* eggs\n1. butter", "Todo")).toBe(
      ["milk", "bread", "eggs", "butter"].join(EXCERPT_ITEM_SEPARATOR),
    );
    expect(noteExcerpt("Log\nfirst line\nsecond line", "Log")).toBe("first line second line");
    expect(noteExcerpt("Mix\nintro text\n- one\n- two\nafter", "Mix")).toBe(
      "intro text · one · two · after",
    );
  });

  it("shortens long text", () => {
    const excerpt = noteExcerpt("x\n" + "word ".repeat(80), "x");
    expect(Array.from(excerpt)).toHaveLength(120);
    expect(excerpt.endsWith("…")).toBe(true);
  });
});

describe("appendCapture", () => {
  it("adds time, source and the output as a code block", () => {
    expect(appendCapture("# Log\n\n", "error: x\r\n", "14:32", "Claude Code")).toBe(
      "# Log\n\n_14:32 · Claude Code_\n\n```\nerror: x\n```\n",
    );
    expect(appendCapture("", "a", "9:01", "")).toBe("_9:01_\n\n```\na\n```\n");
  });

  it("lets the caller word the heading, with the source still escaped", () => {
    const from = (time: string, label: string) => `Aus ${label}, ${time}`;
    expect(appendCapture("", "a", "26. Nov.", "my_shop", from)).toBe(
      "_Aus my\\_shop, 26. Nov._\n\n```\na\n```\n",
    );
  });

  it("uses a longer fence when the output contains one", () => {
    expect(appendCapture("", "```js\nx\n```", "1", "")).toContain("````\n```js");
  });

  it("keeps the session title on one plain line in the heading", () => {
    // The program sets the title (OSC 0/2); it must not break out of the italic heading.
    expect(appendCapture("", "a", "9:01", "x_y *b* `c` [d](e)\n# Head\u0007")).toBe(
      "_9:01 · x\\_y \\*b\\* \\`c\\` \\[d\\](e) # Head_\n\n```\na\n```\n",
    );
    expect(appendCapture("", "a", "9:01", "\r\n\u001b\t")).toBe("_9:01_\n\n```\na\n```\n");
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

describe("editorText", () => {
  it("keeps only LF line ends, as the editor does, so the cursor fits the document", () => {
    const raw = "# Plan\r\n- [ ] eins\r\n- [x] zwei\rdrei\n";
    const text = editorText(raw);
    expect(text).toBe("# Plan\n- [ ] eins\n- [x] zwei\ndrei\n");
    expect(text.split("\n")).toHaveLength(raw.split(/\r\n?|\n/).length);
    expect(editorText("schon LF\n")).toBe("schon LF\n");
  });
});
