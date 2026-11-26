// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenedNote, Status } from "./api";
import type { EditorOptions } from "./editor";
import { createTranslator, I18nContext } from "./i18n";

const ID = "1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5";
const LABEL = `note-general-${ID}`;
const GENERAL = { path: null };

const note: OpenedNote = {
  folderKey: "general",
  path: null,
  id: ID,
  title: "Einkaufen",
  text: "Einkaufen",
  color: "lemon",
  onDesktop: true,
  onTop: false,
  autoTitled: false,
};

const writable: Status = { access: { state: "writable" }, rootKind: "development", project: null };

const api = vi.hoisted(() => {
  const handlers = new Map<string, () => void>();
  const listener = (event: string) =>
    vi.fn((id: string, handler: () => void) => {
      handlers.set(`${event}:${id}`, handler);
      return Promise.resolve(() => undefined);
    });
  return {
    handlers,
    getSticky: vi.fn(),
    getStatus: vi.fn(),
    renameNote: vi.fn(),
    writeSticky: vi.fn(),
    deleteNote: vi.fn(),
    noteFlushed: vi.fn(),
    closeNote: vi.fn(),
    copyText: vi.fn(),
    onCloseRequested: listener("close"),
    onDeleteRequested: listener("delete"),
    onFlushRequested: listener("flush"),
    onLookChanged: vi.fn((label: string, handler: (look: { color: string }) => void) => {
      handlers.set(`look:${label}`, () => {
        handler({ color: "mint" });
      });
      return Promise.resolve(() => undefined);
    }),
  };
});

vi.mock("./api", () => ({
  MAX_NOTE_BYTES: 1024 * 1024,
  utf8Bytes: (text: string) => new TextEncoder().encode(text).length,
  getSticky: api.getSticky,
  getStatus: api.getStatus,
  renameNote: api.renameNote,
  writeSticky: api.writeSticky,
  deleteNote: api.deleteNote,
  noteFlushed: api.noteFlushed,
  closeNote: api.closeNote,
  onCloseRequested: api.onCloseRequested,
  onDeleteRequested: api.onDeleteRequested,
  onFlushRequested: api.onFlushRequested,
  onLookChanged: api.onLookChanged,
  newSticky: vi.fn(() => Promise.resolve()),
  openHub: vi.fn(() => Promise.resolve(null)),
  setNoteColor: vi.fn(),
  setNoteOnTop: vi.fn(),
  windowReady: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("./clipboard", () => ({ copyText: api.copyText }));

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
      load: vi.fn(),
      toggleTask: vi.fn(),
      setReadOnly: vi.fn(),
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
        <NoteWindow label={LABEL} theme="light" colorNames={{}} />
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

async function request(event: "delete" | "flush" | "close" | "look") {
  const handler = api.handlers.get(`${event}:${LABEL}`);
  expect(handler, event).toBeDefined();
  await act(async () => {
    handler?.();
    await Promise.resolve();
  });
  await settle();
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  api.getSticky.mockResolvedValue(note);
  api.getStatus.mockResolvedValue(writable);
  api.writeSticky.mockResolvedValue(null);
  api.renameNote.mockResolvedValue(null);
  api.deleteNote.mockResolvedValue(null);
  api.noteFlushed.mockResolvedValue(null);
  api.closeNote.mockResolvedValue(null);
  api.copyText.mockResolvedValue(true);
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
    expect(api.onCloseRequested).toHaveBeenCalledWith(LABEL, expect.any(Function));
    expect(api.onDeleteRequested).toHaveBeenCalledWith(LABEL, expect.any(Function));
    expect(api.onFlushRequested).toHaveBeenCalledWith(LABEL, expect.any(Function));
    expect(api.onLookChanged).toHaveBeenCalledWith(LABEL, expect.any(Function));
  });

  it("saves first and then deletes itself when the notes area asks", async () => {
    await render();
    await type("Einkaufen und Brot");
    await request("delete");
    expect(api.writeSticky).toHaveBeenCalledWith("Einkaufen und Brot");
    expect(api.deleteNote).toHaveBeenCalledWith(GENERAL, ID);
    const saved = api.writeSticky.mock.invocationCallOrder[0] ?? Infinity;
    const deleted = api.deleteNote.mock.invocationCallOrder[0] ?? -Infinity;
    expect(saved).toBeLessThan(deleted);
    expect(api.noteFlushed).not.toHaveBeenCalled();
  });

  it("keeps the note and its text when the save before a delete fails", async () => {
    api.writeSticky.mockRejectedValue(new Error("disk full"));
    await render();
    await type("Nur hier");
    await request("delete");
    expect(api.deleteNote).not.toHaveBeenCalled();
    expect(api.noteFlushed).toHaveBeenCalledWith(false);
    expect(container.textContent).toContain(t("note.saveFailed"));
  });

  it("offers the text to copy when closing fails and closes on a second try within 10 s", async () => {
    api.writeSticky.mockRejectedValue(new Error("disk full"));
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    await render();
    await type("Nur hier");
    await request("close");
    expect(api.closeNote).not.toHaveBeenCalled();
    const warning = get(".note-stuck", HTMLElement);
    expect(warning.getAttribute("role")).toBe("alert");
    expect(warning.textContent).toContain(t("note.closeUnsaved"));
    const copy = Array.from(warning.querySelectorAll("button")).find(
      (element) => element.textContent === t("notes.copyMarkdown"),
    );
    if (!copy) throw new Error("copy button missing");
    await act(async () => {
      copy.click();
      await Promise.resolve();
    });
    await settle();
    expect(api.copyText).toHaveBeenCalledWith("Nur hier");
    expect(warning.textContent).toContain(t("notes.copied"));
    // After 10 s it is a first try again; within 10 s of that it closes without the text.
    now.mockReturnValue(1_010_000);
    await request("close");
    expect(api.closeNote).not.toHaveBeenCalled();
    now.mockReturnValue(1_019_999);
    await request("close");
    expect(api.closeNote).toHaveBeenCalledTimes(1);
    expect(api.deleteNote).not.toHaveBeenCalled();
    expect(api.renameNote).not.toHaveBeenCalled();
    now.mockRestore();
  });

  it("does not close a note over the size limit on the first try", async () => {
    await render();
    await type("x".repeat(1024 * 1024 + 1));
    await request("close");
    expect(api.closeNote).not.toHaveBeenCalled();
    expect(container.querySelector(".note-stuck")).not.toBeNull();
  });

  it("answers a flush request before quitting with the save result", async () => {
    await render();
    await type("Letzte Zeile");
    await request("flush");
    expect(api.writeSticky).toHaveBeenCalledWith("Letzte Zeile");
    expect(api.noteFlushed).toHaveBeenCalledWith(true);

    api.writeSticky.mockRejectedValue(new Error("disk full"));
    await type("Noch eine Zeile");
    await request("flush");
    expect(api.noteFlushed).toHaveBeenLastCalledWith(false);
  });

  it("takes its title from the first line while it has a provisional one", async () => {
    api.getSticky.mockResolvedValue({ ...note, title: "Notiz 2", autoTitled: true, text: "" });
    await render();
    await type("# Einkaufsliste\n- Milch");
    await request("close");
    expect(api.renameNote).toHaveBeenCalledWith(GENERAL, ID, "Einkaufsliste", false);
    expect(api.closeNote).toHaveBeenCalled();
    expect(api.deleteNote).not.toHaveBeenCalled();
  });

  it("goes to the trash when a new note is closed empty", async () => {
    api.getSticky.mockResolvedValue({ ...note, title: "Notiz 2", autoTitled: true, text: "" });
    await render();
    await request("close");
    expect(api.deleteNote).toHaveBeenCalledWith(GENERAL, ID);
    expect(api.closeNote).not.toHaveBeenCalled();
  });

  it("keeps a note of its own title and stays read only while Hangar keeps the notes", async () => {
    api.getStatus.mockResolvedValue({
      ...writable,
      access: { state: "readOnly", reason: "notHandedOver" },
    });
    await render();
    expect(container.textContent).toContain(t("note.readOnly"));
    await focus(get(".cm-content", HTMLElement));
    expect(bar()).toBeNull();
    await request("close");
    expect(api.renameNote).not.toHaveBeenCalled();
    expect(api.deleteNote).not.toHaveBeenCalled();
    expect(api.closeNote).toHaveBeenCalled();
  });

  it("takes a color chosen in the notes area", async () => {
    await render();
    await request("look");
    const note = get(".note", HTMLElement);
    expect(note.style.getPropertyValue("--note-bg")).not.toBe("");
    expect(note.getAttribute("style")).toContain("#dcf5e5");
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
