// The Markdown editor of a note (CodeMirror 6), modeled on Hangar's notes editor. Live styling:
// bold shows bold, headings large, struck text struck through; the marks themselves stay visible
// but quiet, so the content stays plain Markdown. Task boxes (`- [ ]`) show as checkboxes you can
// click. Tab indents list items only; elsewhere it leaves the editor like any input field.
//
// The note's shortcuts (Ctrl+B and friends) are not bound here: they live in shortcuts.ts and the
// windows call the formatting functions below. The same editor serves the sticky notes and the
// notes area; `load` puts another note in, `setReadOnly` locks it while Hangar keeps the notes.

import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  indentMore,
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { Compartment, EditorSelection, EditorState, type Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  placeholder,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";

import { editorText, taskMarkOffset, toggleLinePrefix, toggleWrap } from "./noteText";

export type Format = "bold" | "italic" | "strike" | "bullet" | "task";

export interface NoteEditor {
  focus: () => void;
  /** Applies a formatting toggle to the selection or the current lines. */
  format: (format: Format) => void;
  /** New content with an empty undo history (another note); cursor at the end. */
  load: (text: string) => void;
  /** Ticks or unticks the task on line `index` (0-based); from the preview. */
  toggleTask: (index: number) => void;
  /** Read only: the text can be read, selected and copied, but not changed. */
  setReadOnly: (readOnly: boolean) => void;
  destroy: () => void;
}

export interface EditorOptions {
  text: string;
  label: string;
  placeholder: string;
  /** Accessible name of a task checkbox. */
  taskLabel: string;
  onChange: (text: string) => void;
  onFocus: (focused: boolean) => void;
  readOnly?: boolean;
}

const MARKS: Record<"bold" | "italic" | "strike", string> = {
  bold: "**",
  italic: "*",
  strike: "~~",
};

// Colors only via tokens (styles.css and the note's tone), so the theme switches without a new
// editor.
const highlight = HighlightStyle.define([
  { tag: tags.heading1, fontWeight: "700", fontSize: "1.3em" },
  { tag: tags.heading2, fontWeight: "700", fontSize: "1.15em" },
  { tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6], fontWeight: "700" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.link, tags.url], color: "var(--note-accent)", textDecoration: "underline" },
  { tag: tags.monospace, fontFamily: "var(--mono)" },
  { tag: tags.quote, fontStyle: "italic" },
  {
    tag: [tags.processingInstruction, tags.contentSeparator, tags.meta],
    color: "var(--note-muted)",
  },
]);

const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--note-text)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.5", overflow: "auto" },
  ".cm-content": { padding: "8px 14px 16px", caretColor: "var(--note-text)" },
  ".cm-line": { padding: "0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--note-text)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--note-selection)",
  },
  ".cm-placeholder": { color: "var(--note-muted)" },
});

class TaskWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly label: string,
  ) {
    super();
  }

  override eq(other: TaskWidget): boolean {
    return other.checked === this.checked && other.label === this.label;
  }

  toDOM(): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-task";
    box.checked = this.checked;
    box.setAttribute("aria-label", this.label);
    // The text stays the single source: the box is drawn, the click changes "[ ]" in the text.
    box.tabIndex = -1;
    return box;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

function taskDecorations(view: EditorView, label: string): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "TaskMarker") return;
        const mark = view.state.sliceDoc(node.from, node.to);
        const checked = /\[[xX]\]/.test(mark);
        // A bullet before the box goes too ("- [ ]" reads as one checkbox); numbers stay.
        const line = view.state.doc.lineAt(node.from);
        const bullet = /^(\s*)[-*+]\s+\[/.exec(line.text);
        const start =
          bullet?.[1] !== undefined && line.from + bullet[0].length - 1 === node.from
            ? line.from + bullet[1].length
            : node.from;
        ranges.push(
          Decoration.replace({ widget: new TaskWidget(checked, label) }).range(start, node.to),
        );
        if (checked && node.to < line.to) {
          ranges.push(Decoration.mark({ class: "cm-task-done" }).range(node.to, line.to));
        }
      },
    });
  }
  return Decoration.set(ranges, true);
}

/** Flips "[ ]" and "[x]" at `from` (start of a task marker). */
function flipTask(view: EditorView, from: number): boolean {
  // A dispatch is not stopped by `readOnly`, so a read-only note keeps its boxes as they are.
  if (view.state.readOnly) return false;
  const mark = view.state.sliceDoc(from, from + 3);
  if (!/^\[[ xX]\]$/.test(mark)) return false;
  view.dispatch({
    changes: { from: from + 1, to: from + 2, insert: mark[1] === " " ? "x" : " " },
    userEvent: "input.toggle",
  });
  return true;
}

function taskPlugin(label: string) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = taskDecorations(view, label);
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state)
        ) {
          this.decorations = taskDecorations(update.view, label);
        }
      }
    },
    {
      decorations: (plugin) => plugin.decorations,
      eventHandlers: {
        mousedown: (event, view) => {
          const target = event.target;
          if (!(target instanceof HTMLElement) || !target.classList.contains("cm-task")) {
            return false;
          }
          event.preventDefault();
          // The widget may start at the bullet; the box itself is the "[" on that line.
          const line = view.state.doc.lineAt(view.posAtDOM(target));
          const offset = taskMarkOffset(line.text);
          return offset !== null && flipTask(view, line.from + offset - 1);
        },
      },
    },
  );
}

function isListLine(line: string): boolean {
  return /^\s*(?:[-*+]|\d+[.)])(?:\s|$)/.test(line);
}

/** Tab and Shift+Tab indent list items; elsewhere `false`, so Tab moves the focus on. */
function indentList(more: boolean) {
  return (view: EditorView): boolean => {
    const { state } = view;
    const lines = state.selection.ranges.flatMap((range) => {
      const first = state.doc.lineAt(range.from).number;
      const last = state.doc.lineAt(range.to).number;
      return Array.from({ length: last - first + 1 }, (_, i) => state.doc.line(first + i).text);
    });
    if (!lines.every(isListLine)) return false;
    return more ? indentMore(view) : indentLess(view);
  };
}

function applyFormat(view: EditorView, format: Format): void {
  const { state } = view;
  if (state.readOnly) return;
  const range = state.selection.main;
  if (format === "bullet" || format === "task") {
    const first = state.doc.lineAt(range.from);
    const last = state.doc.lineAt(range.to);
    const lines: string[] = [];
    for (let n = first.number; n <= last.number; n++) lines.push(state.doc.line(n).text);
    const next = toggleLinePrefix(lines, format).join(state.lineBreak);
    const end = first.from + next.length;
    view.dispatch({
      changes: { from: first.from, to: last.to, insert: next },
      selection: EditorSelection.cursor(end),
      userEvent: "input.format",
    });
    return;
  }
  const edit = toggleWrap(state.doc.toString(), range.from, range.to, MARKS[format]);
  view.dispatch({
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    selection: EditorSelection.single(edit.selection.anchor, edit.selection.head),
    userEvent: "input.format",
  });
}

export function createNoteEditor(parent: HTMLElement, options: EditorOptions): NoteEditor {
  let readOnly = options.readOnly === true;
  const lock = new Compartment();
  const state = (raw: string) => {
    const text = editorText(raw);
    return EditorState.create({
      doc: text,
      selection: EditorSelection.cursor(text.length),
      extensions: [
        lock.of(EditorState.readOnly.of(readOnly)),
        history(),
        keymap.of([
          { key: "Tab", run: indentList(true), shift: indentList(false) },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(highlight),
        taskPlugin(options.taskLabel),
        EditorView.lineWrapping,
        placeholder(options.placeholder),
        EditorView.contentAttributes.of({ "aria-label": options.label, spellcheck: "true" }),
        theme,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) options.onChange(update.state.doc.toString());
          if (update.focusChanged) options.onFocus(update.view.hasFocus);
        }),
      ],
    });
  };
  const view = new EditorView({ parent, state: state(options.text) });
  return {
    focus: () => {
      view.focus();
    },
    format: (format) => {
      applyFormat(view, format);
      view.focus();
    },
    load: (text) => {
      view.setState(state(text));
    },
    toggleTask: (index) => {
      const number = index + 1;
      if (number < 1 || number > view.state.doc.lines) return;
      const line = view.state.doc.line(number);
      const offset = taskMarkOffset(line.text);
      if (offset !== null) flipTask(view, line.from + offset - 1);
    },
    setReadOnly: (next) => {
      if (next === readOnly) return;
      readOnly = next;
      view.dispatch({ effects: lock.reconfigure(EditorState.readOnly.of(next)) });
    },
    destroy: () => {
      view.destroy();
    },
  };
}
