// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { createNoteEditor } from "./editor";

const options = {
  text: "",
  label: "Note",
  placeholder: "Write",
  taskLabel: "Task",
  onChange: () => undefined,
  onFocus: () => undefined,
};

describe("createNoteEditor", () => {
  it("shows a note saved with CRLF line ends instead of an empty editor", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const editor = createNoteEditor(parent, { ...options, text: "Start\r\nzwei" });
    expect(parent.querySelector(".cm-content")?.textContent).toContain("zwei");
    editor.load("# Einkauf\r\n\r\n- [ ] Milch\r\n- [x] Brot");
    expect(parent.querySelector(".cm-content")?.textContent).toContain("Milch");
    expect(parent.querySelector(".cm-content")?.textContent).toContain("Brot");
    editor.destroy();
    parent.remove();
  });
});
