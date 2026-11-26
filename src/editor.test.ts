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

  it("tells screen readers when the note is read only", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const editor = createNoteEditor(parent, { ...options, text: "Text", readOnly: true });
    const content = () => parent.querySelector(".cm-content");
    expect(content()?.getAttribute("aria-readonly")).toBe("true");
    editor.setReadOnly(false);
    expect(content()?.hasAttribute("aria-readonly")).toBe(false);
    editor.setReadOnly(true);
    expect(content()?.getAttribute("aria-readonly")).toBe("true");
    editor.destroy();
    parent.remove();
  });
});
