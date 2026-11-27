// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenedNote, Status } from "./api";
import type { EditorOptions } from "./editor";
import type { Look } from "./looks";
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
  version: "v1",
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
    onChangedOutside: listener("outside"),
    onLookChanged: vi.fn((label: string, handler: (look: { color: string }) => void) => {
      handlers.set(`look:${label}`, () => {
        handler({ color: "mint" });
      });
      return Promise.resolve(() => undefined);
    }),
  };
});

// The real error codes and their helpers (errors.ts reads them); the commands are mocked.
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
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
  onChangedOutside: api.onChangedOutside,
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
  const state: { options: EditorOptions | null; loads: string[] } = { options: null, loads: [] };
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
      load: (text: string) => {
        editor.loads.push(text);
      },
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

async function render(look: Look = "hangar") {
  container = document.createElement("div");
  outside = document.createElement("button");
  document.body.append(container, outside);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nContext.Provider value={t}>
        <NoteWindow label={LABEL} theme="light" colorNames={{}} look={look} />
      </I18nContext.Provider>,
    );
    await Promise.resolve();
  });
  await settle();
}

/** The same window in another look, as the settings-changed event brings it. */
async function rerender(look: Look) {
  await act(async () => {
    root.render(
      <I18nContext.Provider value={t}>
        <NoteWindow label={LABEL} theme="light" colorNames={{}} look={look} />
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

async function request(event: "delete" | "flush" | "close" | "look" | "outside") {
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
  api.writeSticky.mockResolvedValue("v2");
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
  editor.loads = [];
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

  it("leaves the line numbers out of the small sticky note", async () => {
    await render();
    expect(editor.options).not.toBeNull();
    expect(editor.options?.lineNumbers).not.toBe(true);
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
    expect(api.writeSticky).toHaveBeenCalledWith("Einkaufen und Brot", "v1");
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
    expect(api.writeSticky).toHaveBeenCalledWith("Letzte Zeile", "v1");
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

  it("keeps a note of its own title and stays read only while the notes are read only", async () => {
    api.getStatus.mockResolvedValue({
      ...writable,
      access: { state: "readOnly", reason: "otherWriter" },
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

  it("is always movable by its colored header, and shows its tools on hover", async () => {
    await render();
    const head = get(".note-head", HTMLElement);
    expect(head.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(head.title).toBe(t("note.drag"));
    // One region for both looks: no extra strip above the header.
    expect(container.querySelector(".note-strip")).toBeNull();
    expect(bar()).toBeNull();
    const note = get(".note", HTMLElement);
    await act(async () => {
      note.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: outside }));
      await Promise.resolve();
    });
    expect(bar()).not.toBeNull();
    // The bar's place is kept while it is hidden, so the text never jumps.
    expect(container.querySelector(".format-slot")).not.toBeNull();
  });

  it("says why a save failed in a plain sentence", async () => {
    api.writeSticky.mockRejectedValue("disk-full");
    await render();
    await type("Nur hier");
    await request("flush");
    expect(container.textContent).toContain(t("storage.diskFull"));
    expect(container.textContent).not.toContain("disk-full");
  });
});

const STICKY_LOOKS: readonly Look[] = ["hangar", "paper"];

describe.each(STICKY_LOOKS)("note window in the look %s", (look) => {
  it("can always be moved by its header, which is always there", async () => {
    await render(look);
    const region = container.querySelector(".note-head");
    expect(region?.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(region?.getAttribute("title")).toBe(t("note.drag"));
    expect(get(".note", HTMLElement).dataset["look"]).toBe(look);
  });

  it("shows the formatting bar while you write", async () => {
    await render(look);
    expect(bar()).toBeNull();
    await focus(get(".cm-content", HTMLElement));
    expect(bar()).not.toBeNull();
    expect(container.querySelector(".format-slot")).not.toBeNull();
  });

  it("saves before closing and closes an unsaved note only on the second try", async () => {
    api.writeSticky.mockRejectedValue(new Error("disk full"));
    const now = vi.spyOn(Date, "now").mockReturnValue(7_000_000);
    await render(look);
    await type("Nur hier");
    await request("close");
    expect(api.writeSticky).toHaveBeenCalledWith("Nur hier", "v1");
    expect(api.closeNote).not.toHaveBeenCalled();
    expect(get(".note-stuck", HTMLElement).getAttribute("role")).toBe("alert");
    now.mockReturnValue(7_005_000);
    await request("close");
    expect(api.closeNote).toHaveBeenCalledTimes(1);
    now.mockRestore();
  });
});

describe("note window: looks", () => {
  it("names the note and its progress in the hangar look, and says whether it is saved", async () => {
    api.getSticky.mockResolvedValue({ ...note, text: "Einkaufen\n- [x] Milch\n- [ ] Brot" });
    await render("hangar");
    expect(get(".note-head-title", HTMLElement).textContent).toBe("Einkaufen");
    expect(get(".note-head-progress", HTMLElement).textContent).toContain("1/2");
    await focus(get(".cm-content", HTMLElement));
    expect(get(".format-saved", HTMLElement).textContent).toBe(t("notes.saved"));
  });

  it("keeps its editor and what waits to be saved when the look changes", async () => {
    await render();
    const content = get(".cm-content", HTMLElement);
    await type("Noch nicht gespeichert");
    expect(api.writeSticky).not.toHaveBeenCalled();
    await rerender("paper");
    expect(get(".cm-content", HTMLElement)).toBe(content);
    expect(container.querySelector(".note-strip")).toBeNull();
    await rerender("hangar");
    expect(get(".cm-content", HTMLElement)).toBe(content);
    await request("flush");
    expect(api.writeSticky).toHaveBeenCalledWith("Noch nicht gespeichert", "v1");
    expect(api.noteFlushed).toHaveBeenCalledWith(true);
  });
});

function buttonNamed(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(
    (element) => element.textContent === text,
  );
  if (!found) throw new Error(`button ${text} missing`);
  return found;
}

async function press(element: HTMLElement) {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settle();
}

describe("note window: changed outside", () => {
  it("saves with the version it was read with and then with the one each save answers", async () => {
    await render();
    await type("Eins");
    await request("flush");
    await type("Zwei");
    await request("flush");
    expect(api.writeSticky.mock.calls).toEqual([
      ["Eins", "v1"],
      ["Zwei", "v2"],
    ]);
  });

  it("keeps the text, offers reload and copy, and reloads only after asking", async () => {
    api.writeSticky.mockRejectedValue("changed");
    await render();
    await type("Meine Fassung");
    await request("flush");
    expect(api.noteFlushed).toHaveBeenCalledWith(false);
    const alert = get(".note-stuck", HTMLElement);
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain(t("error.changed"));
    expect(container.textContent).not.toContain("changed");
    await press(buttonNamed(t("notes.copyMarkdown")));
    expect(api.copyText).toHaveBeenCalledWith("Meine Fassung");
    // Further saves are not sent: each would be refused the same way.
    await type("Meine Fassung, mehr");
    await request("flush");
    expect(api.writeSticky).toHaveBeenCalledTimes(1);
    // "Reload" asks first; going back keeps everything.
    await press(buttonNamed(t("notes.reloadNote")));
    expect(api.getSticky).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(t("notes.reloadDiscards"));
    await press(buttonNamed(t("notes.reloadCancel")));
    expect(container.textContent).toContain(t("error.changed"));
    expect(api.getSticky).toHaveBeenCalledTimes(1);
    // Confirmed: the note as it is now, and saving goes on with its version.
    api.getSticky.mockResolvedValue({ ...note, text: "Von außen", version: "v7" });
    api.writeSticky.mockResolvedValue("v8");
    await press(buttonNamed(t("notes.reloadNote")));
    await press(buttonNamed(t("notes.reloadConfirm")));
    expect(api.getSticky).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".note-stuck")).toBeNull();
    await request("flush");
    expect(api.writeSticky).toHaveBeenCalledTimes(1);
    await type("Von außen, weiter");
    await request("flush");
    expect(api.writeSticky).toHaveBeenLastCalledWith("Von außen, weiter", "v7");
    expect(api.noteFlushed).toHaveBeenLastCalledWith(true);
  });

  it("closes a note changed outside only on the second try, as after any failed save", async () => {
    api.writeSticky.mockRejectedValue("changed");
    const now = vi.spyOn(Date, "now").mockReturnValue(9_000_000);
    await render();
    await type("Meine Fassung");
    await request("close");
    expect(api.closeNote).not.toHaveBeenCalled();
    expect(container.textContent).toContain(t("note.closeUnsaved"));
    now.mockReturnValue(9_004_000);
    await request("close");
    expect(api.closeNote).toHaveBeenCalledTimes(1);
    now.mockRestore();
  });
});

describe("note window: a change outside without a click", () => {
  it("shows the note as its file is now while nothing waits for its save", async () => {
    await render();
    api.getSticky.mockResolvedValue({ ...note, text: "Von Hangar", version: "v9" });
    await request("outside");
    expect(editor.loads).toEqual(["Von Hangar"]);
    await type("Von Hangar, weiter");
    await request("flush");
    expect(api.writeSticky).toHaveBeenLastCalledWith("Von Hangar, weiter", "v9");
  });

  it("keeps typed text that waits for its save; that save then asks first", async () => {
    await render();
    await type("Meins");
    api.getSticky.mockResolvedValue({ ...note, text: "Von Hangar", version: "v9" });
    await request("outside");
    expect(editor.loads).toEqual([]);
  });

  it("ignores its own save (the version did not change)", async () => {
    await render();
    await request("outside");
    expect(editor.loads).toEqual([]);
  });

  it("says plainly that the note was deleted outside and keeps its text to copy", async () => {
    await render();
    await type("Nur hier");
    api.getSticky.mockRejectedValue("not-found");
    await request("outside");
    const notice = get(".note-stuck", HTMLElement);
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toContain(t("note.deletedOutside"));
    await press(buttonNamed(t("notes.copyMarkdown")));
    expect(api.copyText).toHaveBeenCalledWith("Nur hier");
    expect(editor.loads).toEqual([]);
  });
});
