// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { createNoteEditor, styleNonce } from "./editor";

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

  it("gives CodeMirror's style elements the nonce Tauri put into the page", () => {
    const meta = document.createElement("meta");
    meta.name = "hangar-style-nonce";
    meta.content = "__TAURI_STYLE_NONCE__";
    document.head.append(meta);
    // The dev server leaves the placeholder: no nonce, and no policy to satisfy.
    expect(styleNonce()).toBeNull();
    meta.content = "12345678901234567890";
    expect(styleNonce()).toBe("12345678901234567890");
    const parent = document.createElement("div");
    document.body.append(parent);
    const editor = createNoteEditor(parent, options);
    const styles = Array.from(document.querySelectorAll("style"));
    expect(styles.length).toBeGreaterThan(0);
    expect(styles.map((style) => style.getAttribute("nonce"))).toEqual(
      styles.map(() => "12345678901234567890"),
    );
    editor.destroy();
    parent.remove();
    meta.remove();
  });
});
