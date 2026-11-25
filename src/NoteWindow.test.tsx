// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NoteContent } from "./api";
import type { EditorOptions } from "./editor";
import { createTranslator, I18nContext } from "./i18n";

const ID = "1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5";

const note: NoteContent = {
  id: ID,
  color: "lemon",
  bounds: null,
  open: true,
  onTop: false,
  createdAt: 1,
  updatedAt: 2,
  text: "Einkaufen",
};

const api = vi.hoisted(() => {
  const handlers = new Map<string, () => void>();
  const listener = (event: string) =>
    vi.fn((id: string, handler: () => void) => {
      handlers.set(`${event}:${id}`, handler);
      return Promise.resolve(() => undefined);
    });
  return {
    handlers,
    readNote: vi.fn(),
    writeNote: vi.fn(),
    deleteNote: vi.fn(),
    noteFlushed: vi.fn(),
    closeNote: vi.fn(),
    onCloseRequested: listener("close"),
    onDeleteRequested: listener("delete"),
    onFlushRequested: listener("flush"),
  };
});

vi.mock("./api", () => ({
  MAX_NOTE_BYTES: 1024 * 1024,
  utf8Bytes: (text: string) => new TextEncoder().encode(text).length,
  readNote: api.readNote,
  writeNote: api.writeNote,
  deleteNote: api.deleteNote,
  noteFlushed: api.noteFlushed,
  closeNote: api.closeNote,
  onCloseRequested: api.onCloseRequested,
  onDeleteRequested: api.onDeleteRequested,
  onFlushRequested: api.onFlushRequested,
  createNote: vi.fn(() => Promise.resolve()),
  openHub: vi.fn(() => Promise.resolve(null)),
  setNoteColor: vi.fn(),
  setNoteOnTop: vi.fn(),
  windowReady: vi.fn(() => Promise.resolve(null)),
}));

// The real editor needs layout; a contenteditable stands in for it and reports its changes.
const editor = vi.hoisted(() => {
  const state: { options: EditorOptions | null } = { options: null };
  return state;
});

vi.mock("./editor", () => ({
  createNoteEditor: (parent: HTMLElement, options: EditorOptions) => {
    editor.options = options;
    const content = document.createElement("div");
    content.className = "cm-content";
    content.contentEditable = "true";
    content.tabIndex = 0;
    parent.append(content);
    return {
      focus: () => {
        content.focus();
      },
      format: vi.fn(),
      destroy: () => {
        content.remove();
      },
    };
  },
}));

const { NoteWindow } = await import("./NoteWindow");

const t = createTranslator("de");
let root: Root;
let container: HTMLDivElement;
let outside: HTMLButtonElement;

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

async function render() {
  container = document.createElement("div");
  outside = document.createElement("button");
  document.body.append(container, outside);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nContext.Provider value={t}>
        <NoteWindow id={ID} theme="light" />
      </I18nContext.Provider>,
    );
    await Promise.resolve();
  });
  await settle();
}

function get<T extends Element>(selector: string, type: new () => T): T {
  const element = container.querySelector(selector);
  if (!(element instanceof type)) throw new Error(`${selector} missing`);
  return element;
}

async function focus(element: HTMLElement) {
  await act(async () => {
    element.focus();
    await Promise.resolve();
  });
}

function bar(): Element | null {
  return container.querySelector("[role=toolbar]");
}

async function type(text: string) {
  await act(async () => {
    editor.options?.onChange(text);
    await Promise.resolve();
  });
}

async function request(event: "delete" | "flush") {
  const handler = api.handlers.get(`${event}:${ID}`);
  expect(handler, event).toBeDefined();
  await act(async () => {
    handler?.();
    await Promise.resolve();
  });
  await settle();
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  api.readNote.mockResolvedValue(note);
  api.writeNote.mockResolvedValue(note);
  api.deleteNote.mockResolvedValue({});
  api.noteFlushed.mockResolvedValue(null);
  api.closeNote.mockResolvedValue(null);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  outside.remove();
  api.handlers.clear();
  vi.clearAllMocks();
});

describe("note window", () => {
  it("keeps the formatting bar while the focus is anywhere in the note", async () => {
    await render();
    expect(bar()).toBeNull();
    await focus(get(".cm-content", HTMLElement));
    expect(bar()).not.toBeNull();
    // Tab from the editor into the bar: the bar stays, so it can be used by keyboard.
    await focus(get(".format-bullet", HTMLButtonElement));
    expect(bar()).not.toBeNull();
    await focus(get("[aria-haspopup=menu]", HTMLButtonElement));
    expect(bar()).not.toBeNull();
    await focus(outside);
    expect(bar()).toBeNull();
  });

  it("names the list shortcuts in the formatting bar", async () => {
    await render();
    await focus(get(".cm-content", HTMLElement));
    expect(get(".format-bullet", HTMLButtonElement).title).toBe("Aufzählung (Strg+Umschalt+8)");
    expect(get(".format-task", HTMLButtonElement).title).toBe("Checkliste (Strg+Umschalt+9)");
  });

  it("listens only to requests for its own window", async () => {
    await render();
    expect(api.onCloseRequested).toHaveBeenCalledWith(ID, expect.any(Function));
    expect(api.onDeleteRequested).toHaveBeenCalledWith(ID, expect.any(Function));
    expect(api.onFlushRequested).toHaveBeenCalledWith(ID, expect.any(Function));
  });

  it("saves first and then deletes itself when All notes asks", async () => {
    await render();
    await type("Einkaufen und Brot");
    await request("delete");
    expect(api.writeNote).toHaveBeenCalledWith(ID, "Einkaufen und Brot");
    expect(api.deleteNote).toHaveBeenCalledWith(ID);
    const saved = api.writeNote.mock.invocationCallOrder[0] ?? Infinity;
    const deleted = api.deleteNote.mock.invocationCallOrder[0] ?? -Infinity;
    expect(saved).toBeLessThan(deleted);
    expect(api.noteFlushed).not.toHaveBeenCalled();
  });

  it("keeps the note and its text when the save before a delete fails", async () => {
    api.writeNote.mockRejectedValue(new Error("disk full"));
    await render();
    await type("Nur hier");
    await request("delete");
    expect(api.deleteNote).not.toHaveBeenCalled();
    expect(api.noteFlushed).toHaveBeenCalledWith(false);
    expect(container.textContent).toContain(t("note.saveFailed"));
  });

  it("answers a flush request before quitting with the save result", async () => {
    await render();
    await type("Letzte Zeile");
    await request("flush");
    expect(api.writeNote).toHaveBeenCalledWith(ID, "Letzte Zeile");
    expect(api.noteFlushed).toHaveBeenCalledWith(true);

    api.writeNote.mockRejectedValue(new Error("disk full"));
    await type("Noch eine Zeile");
    await request("flush");
    expect(api.noteFlushed).toHaveBeenLastCalledWith(false);
  });

  it("works its menu with the keyboard and gives the focus back on Escape", async () => {
    await render();
    const button = get("[aria-haspopup=menu]", HTMLButtonElement);
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    const menu = get("[role=menu]", HTMLElement);
    const items = Array.from(
      menu.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]'),
    );
    const focused = () => items.indexOf(document.activeElement ?? document.body);
    const press = async (key: string) => {
      await act(async () => {
        (document.activeElement ?? menu).dispatchEvent(
          new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true }),
        );
        await Promise.resolve();
      });
    };
    expect(focused()).toBe(0);
    await press("ArrowDown");
    expect(focused()).toBe(1);
    await press("End");
    expect(focused()).toBe(items.length - 1);
    await press("ArrowDown");
    expect(focused()).toBe(0);
    await press("ArrowUp");
    expect(focused()).toBe(items.length - 1);
    await press("Home");
    expect(focused()).toBe(0);
    await press("Escape");
    expect(container.querySelector("[role=menu]")).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});
