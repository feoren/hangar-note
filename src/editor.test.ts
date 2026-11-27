// @vitest-environment happy-dom
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";

import { cursorStats, type CursorStats } from "./cursorStats";
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

  it("shows line numbers only when asked, hidden from screen readers and outside the text", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const text = ["eins", "zwei"].join("\n");
    const plain = createNoteEditor(parent, { ...options, text });
    expect(parent.querySelector(".cm-lineNumbers")).toBeNull();
    plain.destroy();
    const numbered = createNoteEditor(parent, {
      ...options,
      text,
      lineNumbers: true,
    });
    const gutter = parent.querySelector(".cm-lineNumbers");
    expect(gutter).not.toBeNull();
    expect(gutter?.closest(".cm-gutters")?.getAttribute("aria-hidden")).toBe("true");
    // The numbers live beside the editable text, so they are neither edited nor copied with it.
    expect(parent.querySelector(".cm-content")?.contains(gutter ?? null)).toBe(false);
    expect(parent.querySelector(".cm-content")?.textContent).toBe("einszwei");
    numbered.destroy();
    parent.remove();
  });

  it("reports the cursor, the selection and the length as they change", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const seen: CursorStats[] = [];
    const editor = createNoteEditor(parent, {
      ...options,
      text: "eins\r\nzwei",
      onCursor: (stats) => seen.push(stats),
    });
    // Right away, with the cursor at the end of the loaded text.
    expect(seen.at(-1)).toEqual({ line: 2, column: 5, selected: 0, length: 9 });
    const content = parent.querySelector(".cm-content");
    if (!(content instanceof HTMLElement)) throw new Error("no editor");
    const view = EditorView.findFromDOM(content);
    if (view === null) throw new Error("no view");
    view.dispatch({ selection: EditorSelection.cursor(2) });
    expect(seen.at(-1)).toEqual({ line: 1, column: 3, selected: 0, length: 9 });
    view.dispatch({ selection: EditorSelection.single(1, 7) });
    expect(seen.at(-1)).toEqual(cursorStats(view.state.doc.toString(), 1, 7));
    expect(seen.at(-1)).toMatchObject({ line: 2, column: 3, selected: 6 });
    // Selected backwards (Shift+Up): the same characters, the cursor at the start.
    view.dispatch({ selection: EditorSelection.single(7, 1) });
    expect(seen.at(-1)).toEqual(cursorStats(view.state.doc.toString(), 7, 1));
    expect(seen.at(-1)).toMatchObject({ line: 1, column: 2, selected: 6 });
    const thumbs = String.fromCodePoint(0x1f44d);
    view.dispatch({
      changes: { from: 0, insert: thumbs },
      selection: EditorSelection.cursor(thumbs.length),
    });
    expect(seen.at(-1)).toEqual({ line: 1, column: 2, selected: 0, length: 10 });
    // Another note: its numbers, not the last ones.
    editor.load("neu");
    expect(seen.at(-1)).toEqual({ line: 1, column: 4, selected: 0, length: 3 });
    // One update that changes text and selection together is reported once.
    const before = seen.length;
    view.dispatch({ changes: { from: 3, insert: "!" } });
    expect(seen.length).toBe(before + 1);
    editor.destroy();
    parent.remove();
  });

  it("recounts a long text after typing pauses, with the cursor current at once", () => {
    vi.useFakeTimers();
    try {
      const parent = document.createElement("div");
      document.body.append(parent);
      const onCursor = vi.fn<(stats: CursorStats) => void>();
      const long = "x".repeat(60_000);
      const editor = createNoteEditor(parent, { ...options, text: long, onCursor });
      expect(onCursor).toHaveBeenLastCalledWith({
        line: 1,
        column: 60_001,
        selected: 0,
        length: 60_000,
      });
      const content = parent.querySelector(".cm-content");
      if (!(content instanceof HTMLElement)) throw new Error("no editor");
      const view = EditorView.findFromDOM(content);
      if (view === null) throw new Error("no view");
      view.dispatch({ changes: { from: 60_000, insert: "\nab" }, selection: { anchor: 60_003 } });
      expect(onCursor).toHaveBeenLastCalledWith({
        line: 2,
        column: 3,
        selected: 0,
        length: 60_000,
      });
      vi.advanceTimersByTime(250);
      expect(onCursor).toHaveBeenLastCalledWith({
        line: 2,
        column: 3,
        selected: 0,
        length: 60_003,
      });
      editor.destroy();
      parent.remove();
    } finally {
      vi.useRealTimers();
    }
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
