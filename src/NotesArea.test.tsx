// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HubRequest, NoteRow, OpenedNote, Status } from "./api";
import type { AppSettings } from "./appSettings";
import type { EditorOptions } from "./editor";
import type { Look } from "./looks";
import { createTranslator, I18nContext } from "./i18n";

const A = "1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5";
const B = "0b7f6a0e-3c1d-4c5e-9a8b-1f2e3d4c5b6a";
const GENERAL = { path: null };

function row(id: string, title: string, color: NoteRow["color"], extra: Partial<NoteRow> = {}) {
  return {
    folderKey: "general",
    path: null,
    id,
    title,
    updatedAt: 1,
    order: 0,
    color,
    onDesktop: false,
    preview: `${title}\n- [x] eins\n- [ ] zwei`,
    ...extra,
  } satisfies NoteRow;
}

function opened(id: string, title: string, extra: Partial<OpenedNote> = {}): OpenedNote {
  return {
    folderKey: "general",
    path: null,
    id,
    title,
    text: `${title}\nText`,
    color: "lemon",
    onDesktop: false,
    onTop: false,
    autoTitled: false,
    version: `v-${id}`,
    ...extra,
  };
}

const writable: Status = { access: { state: "writable" }, rootKind: "development", project: null };

const api = vi.hoisted(() => ({
  handlers: new Map<string, () => void>(),
  getStatus: vi.fn(),
  takeHubRequests: vi.fn(),
  listNotes: vi.fn(),
  readNote: vi.fn(),
  writeNote: vi.fn(),
  createNote: vi.fn(),
  renameNote: vi.fn(),
  deleteNote: vi.fn(),
  fromDesktop: vi.fn(),
  toDesktop: vi.fn(),
  noteFlushed: vi.fn(),
  setHubOnTop: vi.fn(),
  copyText: vi.fn(),
  restoreNote: vi.fn(),
  setSettings: vi.fn(),
  setAutostart: vi.fn(),
}));

// The real error codes and their helpers (errors.ts reads them); the commands are mocked.
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  MAX_NOTE_BYTES: 1024 * 1024,
  utf8Bytes: (text: string) => new TextEncoder().encode(text).length,
  isNotSaved: (error: unknown) => error === "not-saved",
  isReadOnly: (error: unknown) => error === "read-only",
  getStatus: api.getStatus,
  takeHubRequests: api.takeHubRequests,
  listNoteFolders: vi.fn(() => Promise.resolve([])),
  listNotes: api.listNotes,
  searchNotes: vi.fn(() => Promise.resolve([])),
  readNote: api.readNote,
  writeNote: api.writeNote,
  createNote: api.createNote,
  renameNote: api.renameNote,
  deleteNote: api.deleteNote,
  restoreNote: api.restoreNote,
  listTrash: vi.fn(() => Promise.resolve([])),
  setNoteColor: vi.fn(),
  toDesktop: api.toDesktop,
  fromDesktop: api.fromDesktop,
  copyNote: vi.fn(),
  exportNote: vi.fn(),
  revealNote: vi.fn(),
  revealNotesFolder: vi.fn(),
  noteFlushed: api.noteFlushed,
  onNotesChanged: vi.fn(() => Promise.resolve(() => undefined)),
  onHubRequests: vi.fn((handler: () => void) => {
    api.handlers.set("hub-requests", handler);
    return Promise.resolve(() => undefined);
  }),
  onFlushRequested: vi.fn((label: string, handler: () => void) => {
    api.handlers.set(`flush:${label}`, handler);
    return Promise.resolve(() => undefined);
  }),
  windowReady: vi.fn(() => Promise.resolve(null)),
  setSettings: api.setSettings,
  setAutostart: api.setAutostart,
  setHubOnTop: api.setHubOnTop,
}));

vi.mock("./clipboard", () => ({ copyText: api.copyText }));

const editor = vi.hoisted((): { options: EditorOptions | null; text: string } => ({
  options: null,
  text: "",
}));

vi.mock("./editor", () => ({
  createNoteEditor: (parent: HTMLElement, options: EditorOptions) => {
    editor.options = options;
    const content = document.createElement("div");
    content.className = "cm-content";
    content.tabIndex = 0;
    parent.append(content);
    return {
      focus: () => {
        content.focus();
      },
      format: vi.fn(),
      load: (text: string) => {
        editor.text = text;
        content.textContent = text;
      },
      toggleTask: vi.fn(),
      setReadOnly: vi.fn(),
      destroy: () => {
        content.remove();
      },
    };
  },
}));

const { NotesArea } = await import("./NotesArea");

const t = createTranslator("de");
const calmApp: AppSettings = {
  settings: {
    language: "de",
    theme: "light",
    newNoteColor: "mint",
    colorNames: { sky: "Arbeit" },
    look: "calm",
    autostart: false,
  },
  theme: "light",
  look: "calm",
  language: "de",
  t,
  applySaved: () => undefined,
  applyAutostart: () => undefined,
};

let app: AppSettings = calmApp;
let root: Root;
let container: HTMLDivElement;

/** The app settings with another look, as the backend's settings-changed event brings them. */
function withLook(look: Look): AppSettings {
  return {
    ...calmApp,
    look,
    settings: calmApp.settings === null ? null : { ...calmApp.settings, look },
  };
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

async function render(look: Look = "calm") {
  app = withLook(look);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nContext.Provider value={t}>
        <NotesArea app={app} />
      </I18nContext.Provider>,
    );
    await Promise.resolve();
  });
  await settle();
}

/** The same window with another look: the hook keeps its state, the layout changes. */
async function rerender(look: Look) {
  app = withLook(look);
  await act(async () => {
    root.render(
      <I18nContext.Provider value={t}>
        <NotesArea app={app} />
      </I18nContext.Provider>,
    );
    await Promise.resolve();
  });
  await settle();
}

/** Waits for the frame callbacks (focus moves) to run. */
async function frames() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  await settle();
}

function titles(): string[] {
  return Array.from(container.querySelectorAll(".note-row-title")).map((e) => e.textContent);
}

/** A menu item by its visible label (counts and check marks aside). */
function menuItem(label: string): HTMLButtonElement {
  const found = Array.from(
    container.ownerDocument.querySelectorAll<HTMLButtonElement>(".popup-menu button"),
  ).find(
    (element) =>
      element.querySelector(".menu-label")?.textContent === label ||
      element.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`menu item ${label} missing`);
  return found;
}

/** Opens the title menu ("All notes"), which holds the scopes and the former list menu. */
async function openAreaMenu() {
  const scope = container.querySelector<HTMLButtonElement>(".scope-button");
  if (!scope) throw new Error("title menu missing");
  await click(scope);
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(
    (element) => element.textContent === text || element.getAttribute("aria-label") === text,
  );
  if (!found) throw new Error(`button ${text} missing`);
  return found;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settle();
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  api.getStatus.mockResolvedValue(writable);
  api.takeHubRequests.mockResolvedValue([]);
  api.listNotes.mockResolvedValue([row(A, "Einkaufen", "mint"), row(B, "Projekt", "sky")]);
  api.readNote.mockImplementation((_folder: unknown, id: string) =>
    Promise.resolve(opened(id, id === A ? "Einkaufen" : "Projekt")),
  );
  api.writeNote.mockResolvedValue("v-saved");
  api.renameNote.mockResolvedValue(null);
  api.deleteNote.mockResolvedValue(null);
  api.fromDesktop.mockResolvedValue(null);
  api.toDesktop.mockResolvedValue(null);
  api.noteFlushed.mockResolvedValue(null);
  api.setHubOnTop.mockImplementation((onTop: boolean) => Promise.resolve(onTop));
  api.copyText.mockResolvedValue(true);
  api.createNote.mockResolvedValue(opened(A, "Notiz 1", { autoTitled: true, text: "" }));
  api.restoreNote.mockImplementation((_folder: unknown, id: string) => Promise.resolve(id));
  api.setSettings.mockImplementation((value: unknown) => Promise.resolve(value));
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  api.handlers.clear();
  vi.clearAllMocks();
});

describe("notes area", () => {
  it("lists the notes with their checklist progress", async () => {
    await render();
    expect(titles()).toEqual(["Einkaufen", "Projekt"]);
    expect(container.querySelector(".note-progress")?.textContent).toContain("1/2");
  });

  it("filters by one or more colors and names a color by its own name", async () => {
    await render();
    // Direction A: the filter sits behind one button; its menu stays open while choosing.
    await click(button(t("notes.colorFilter")));
    await click(menuItem("Arbeit"));
    expect(titles()).toEqual(["Projekt"]);
    expect(menuItem("Arbeit").getAttribute("aria-checked")).toBe("true");
    await click(menuItem(t("color.mint")));
    expect(titles()).toEqual(["Einkaufen", "Projekt"]);
    // The button names what is filtered, and "All colors" keeps its place in the menu.
    const filter = container.querySelector(".color-button");
    expect(filter?.getAttribute("aria-label")).toBe(
      t("notes.colorFilterActive", { colors: `${t("color.mint")}, Arbeit` }),
    );
    await click(menuItem(t("notes.colorFilterClear")));
    expect(titles()).toEqual(["Einkaufen", "Projekt"]);
    expect(container.querySelector(".color-button.on")).toBeNull();
  });

  it("shows the calm read-only hint and offers no new note while Hangar keeps the notes", async () => {
    api.getStatus.mockResolvedValue({
      ...writable,
      access: { state: "readOnly", reason: "notHandedOver" },
    });
    await render();
    expect(container.textContent).toContain(t("notes.readOnly"));
    expect(button(t("notes.new")).disabled).toBe(true);
    // The empty note pane does not suggest starting a note that cannot be written.
    expect(container.textContent).toContain(t("notes.pickReadOnly"));
    expect(container.textContent).not.toContain(t("notes.pick"));
  });

  it("shows a note that sits on the desktop instead of a second editor", async () => {
    api.listNotes.mockResolvedValue([row(A, "Einkaufen", "mint", { onDesktop: true })]);
    api.readNote.mockResolvedValue(opened(A, "Einkaufen", { onDesktop: true }));
    await render();
    const first = container.querySelector(".note-row");
    if (!(first instanceof HTMLButtonElement)) throw new Error("row missing");
    await click(first);
    expect(container.textContent).toContain(t("notes.onDesktop"));
    expect(container.querySelector<HTMLElement>(".note-body")?.hidden).toBe(true);
    api.readNote.mockResolvedValue(opened(A, "Einkaufen"));
    await click(button(t("notes.backFromDesktop")));
    expect(api.fromDesktop).toHaveBeenCalledWith(GENERAL, A);
    expect(container.querySelector<HTMLElement>(".note-body")?.hidden).toBe(false);
  });

  it("creates a quick note only once something is typed, with its first line as title", async () => {
    const quick: HubRequest[] = [{ kind: "quick" }];
    api.takeHubRequests.mockResolvedValue(quick);
    await render();
    expect(api.createNote).not.toHaveBeenCalled();
    await act(async () => {
      editor.options?.onChange("# Einkaufsliste\n- Milch");
      await Promise.resolve();
    });
    await settle();
    expect(api.createNote).toHaveBeenCalledWith(GENERAL, "Notiz");
    expect(api.writeNote).toHaveBeenCalledWith(GENERAL, A, "# Einkaufsliste\n- Milch", `v-${A}`);
    // Leaving the note gives it the first line as its title.
    await click(button(t("notes.backToList")));
    expect(api.renameNote).toHaveBeenCalledWith(GENERAL, A, "Einkaufsliste", false);
  });

  it("drops a new note left empty and answers a flush request with the save result", async () => {
    api.takeHubRequests.mockResolvedValue([{ kind: "quick" }]);
    await render();
    await act(async () => {
      editor.options?.onChange("x");
      await Promise.resolve();
    });
    await settle();
    await act(async () => {
      editor.options?.onChange("");
      await Promise.resolve();
    });
    const flush = api.handlers.get("flush:hub");
    expect(flush).toBeDefined();
    await act(async () => {
      flush?.();
      await Promise.resolve();
    });
    await settle();
    expect(api.noteFlushed).toHaveBeenCalledWith(true);
    await click(button(t("notes.backToList")));
    expect(api.deleteNote).toHaveBeenCalledWith(GENERAL, A);
  });
});

const readOnly: Status = { ...writable, access: { state: "readOnly", reason: "notHandedOver" } };
const capture: HubRequest = { kind: "capture", folder: "C:/p/Demo Projekt", text: "Ausgabe" };

function rowButton(title: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll<HTMLButtonElement>(".note-row")).find(
    (element) => element.querySelector(".note-row-title")?.textContent === title,
  );
  if (!found) throw new Error(`row ${title} missing`);
  return found;
}

async function type(text: string) {
  await act(async () => {
    editor.options?.onChange(text);
    await Promise.resolve();
  });
  await settle();
}

describe("notes area: requests and quick note", () => {
  it("opens the note a capture made in the backend without creating one", async () => {
    const folder = "C:/p/Demo Projekt";
    api.takeHubRequests.mockResolvedValue([{ kind: "openNote", folder, id: B }]);
    api.readNote.mockResolvedValue(
      opened(B, "Ausgabe", {
        path: folder,
        folderKey: "demo",
        text: "_Aus Demo Projekt_\nAusgabe",
      }),
    );
    await render();
    expect(api.readNote).toHaveBeenCalledWith({ path: folder }, B);
    expect(api.createNote).not.toHaveBeenCalled();
    expect(api.writeNote).not.toHaveBeenCalled();
    expect(container.querySelector(".note-pane")?.getAttribute("aria-label")).toBe("Ausgabe");
    expect(editor.text).toBe("_Aus Demo Projekt_\nAusgabe");
    // The list is read again, so the new note shows there too.
    expect(api.listNotes.mock.calls.length).toBeGreaterThan(1);
  });

  it("opens a captured note read only, without a draft, while Hangar keeps the notes", async () => {
    api.getStatus.mockResolvedValue(readOnly);
    api.takeHubRequests.mockResolvedValue([{ kind: "openNote", folder: null, id: A }]);
    await render();
    expect(api.createNote).not.toHaveBeenCalled();
    expect(container.querySelector(".note-pane")?.getAttribute("aria-label")).toBe("Einkaufen");
    expect(container.textContent).not.toContain(t("notes.heldHint"));
  });

  it("keeps an unsaved open note when a captured note asks to be shown", async () => {
    await render();
    await click(rowButton("Einkaufen"));
    await type("Einkaufen\nneu");
    api.writeNote.mockRejectedValue("disk full");
    api.takeHubRequests.mockResolvedValue([{ kind: "openNote", folder: null, id: B }]);
    await act(async () => {
      api.handlers.get("hub-requests")?.();
      await Promise.resolve();
    });
    await settle();
    expect(api.createNote).not.toHaveBeenCalled();
    expect(api.readNote).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".note-pane")?.getAttribute("aria-label")).toBe("Einkaufen");
    expect(editor.text).toBe("Einkaufen\nText");
  });

  it("keeps a capture in a draft to copy while the notes are read only", async () => {
    api.getStatus.mockResolvedValue(readOnly);
    api.takeHubRequests.mockResolvedValue([capture]);
    await render();
    expect(api.createNote).not.toHaveBeenCalled();
    expect(container.textContent).toContain(t("notes.heldHint"));
    expect(editor.text).toContain("Ausgabe");
    expect(editor.text).toMatch(/^_Aus Demo Projekt, /);
    await click(button(t("notes.copyMarkdown")));
    expect(api.copyText).toHaveBeenCalledWith(editor.text);
    expect(container.textContent).toContain(t("notes.copied"));
  });

  it("never creates a note for a capture the backend could not store", async () => {
    api.takeHubRequests.mockResolvedValue([capture]);
    await render();
    expect(api.createNote).not.toHaveBeenCalled();
    expect(api.writeNote).not.toHaveBeenCalled();
    expect(container.textContent).toContain(t("notes.heldHint"));
  });

  it("opens no draft for a quick note while the notes are read only", async () => {
    api.getStatus.mockResolvedValue(readOnly);
    api.takeHubRequests.mockResolvedValue([{ kind: "quick" }]);
    await render();
    expect(container.querySelector(".note-bar")).toBeNull();
    expect(container.textContent).toContain(t("notes.pickReadOnly"));
  });
});

describe("notes area: leaving an unsaved note", () => {
  it("keeps the note open and says it is not saved instead of switching", async () => {
    await render();
    await click(rowButton("Einkaufen"));
    await type("Einkaufen\nneu");
    api.writeNote.mockRejectedValue("disk full");
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    await click(rowButton("Projekt"));
    expect(api.readNote).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".note-pane")?.getAttribute("aria-label")).toBe("Einkaufen");
    expect(container.querySelector(".note-unsaved")?.textContent).toBe(t("notes.unsaved"));
    expect(container.querySelector(".notes-stuck")?.textContent).toContain(t("notes.leaveUnsaved"));
    // After 10 s a try counts as a first one again.
    now.mockReturnValue(1_010_000);
    await click(button(t("notes.backToList")));
    expect(container.querySelector(".note-bar")).not.toBeNull();
    // Once a save works again, leaving works and the warning is gone.
    api.writeNote.mockResolvedValue("v-saved");
    await click(button(t("notes.backToList")));
    expect(container.querySelector(".note-bar")).toBeNull();
    expect(container.querySelector(".notes-stuck")).toBeNull();
    now.mockRestore();
  });

  it("offers the text to copy and leaves without it on a second try within 10 s", async () => {
    await render();
    await click(rowButton("Einkaufen"));
    await type("Einkaufen\nneu");
    api.writeNote.mockRejectedValue("disk full");
    const now = vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    await click(rowButton("Projekt"));
    expect(api.readNote).toHaveBeenCalledTimes(1);
    const warning = container.querySelector<HTMLElement>(".notes-stuck");
    expect(warning?.getAttribute("role")).toBe("alert");
    const copy = Array.from(warning?.querySelectorAll("button") ?? []).find(
      (element) => element.textContent === t("notes.copyMarkdown"),
    );
    if (!copy) throw new Error("copy button missing");
    await click(copy);
    expect(api.copyText).toHaveBeenCalledWith("Einkaufen\nneu");
    now.mockReturnValue(2_009_999);
    await click(rowButton("Projekt"));
    // The second try saved once more, failed again and left.
    const writes = api.writeNote.mock.calls.length;
    expect(api.readNote).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".note-pane")?.getAttribute("aria-label")).toBe("Projekt");
    expect(container.querySelector(".notes-stuck")).toBeNull();
    expect(container.querySelector(".note-unsaved")).toBeNull();
    // The dropped text is never written later, not even by the flush before quitting.
    api.writeNote.mockResolvedValue("v-saved");
    await act(async () => {
      api.handlers.get("flush:hub")?.();
      await Promise.resolve();
    });
    await settle();
    expect(api.writeNote.mock.calls.slice(writes)).toEqual([]);
    expect(api.noteFlushed).toHaveBeenLastCalledWith(true);
    now.mockRestore();
  });

  it("never drops unsaved text for a request from the command line or Hangar", async () => {
    await render();
    await click(rowButton("Einkaufen"));
    await type("Einkaufen\nneu");
    api.writeNote.mockRejectedValue("disk full");
    const now = vi.spyOn(Date, "now").mockReturnValue(3_000_000);
    await click(rowButton("Projekt"));
    api.takeHubRequests.mockResolvedValue([{ kind: "quick" }]);
    await act(async () => {
      api.handlers.get("hub-requests")?.();
      await Promise.resolve();
    });
    await settle();
    expect(api.readNote).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".note-pane")?.getAttribute("aria-label")).toBe("Einkaufen");
    now.mockRestore();
  });
});

describe("notes area: trash and back", () => {
  it("gives the open note its editor and text again after the trash", async () => {
    await render();
    await click(rowButton("Einkaufen"));
    await type("Einkaufen\nneu");
    await openAreaMenu();
    await click(menuItem(t("notes.trash")));
    expect(container.querySelector(".note-editor")).toBeNull();
    await click(button(t("notes.back")));
    const content = container.querySelector(".note-editor .cm-content");
    expect(content?.textContent).toBe("Einkaufen\nneu");
    // Typing goes on in the new editor and is saved for the same note.
    await type("Einkaufen\nneu\nmehr");
    await act(async () => {
      api.handlers.get("flush:hub")?.();
      await Promise.resolve();
    });
    await settle();
    expect(api.writeNote).toHaveBeenLastCalledWith(GENERAL, A, "Einkaufen\nneu\nmehr", "v-saved");
  });
});

describe("notes area: list", () => {
  it("shows All on a start without a project, and new notes still go to General", async () => {
    await render();
    expect(container.querySelector(".scope-button")?.textContent).toBe(t("note.allNotes"));
    await openAreaMenu();
    const on = container.querySelector('.popup-menu [role="menuitemradio"][aria-checked="true"]');
    expect(on?.querySelector(".menu-label")?.textContent).toBe(t("note.allNotes"));
    await openAreaMenu();
    await click(button(t("notes.new")));
    await type("Neu");
    expect(api.createNote).toHaveBeenCalledWith(GENERAL, "Notiz");
  });

  it("switches the window on top from the title menu", async () => {
    await render();
    await openAreaMenu();
    const item = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]'),
    ).find((element) => element.textContent.includes(t("note.keepOnTop")));
    expect(item?.getAttribute("aria-checked")).toBe("false");
    if (!item) throw new Error("on-top switch missing");
    await click(item);
    expect(api.setHubOnTop).toHaveBeenCalledWith(true);
    await openAreaMenu();
    const again = container.querySelector('[role="menuitemcheckbox"]');
    expect(again?.getAttribute("aria-checked")).toBe("true");
  });

  it("offers On the desktop once in the open note, at its top", async () => {
    await render();
    await click(rowButton("Einkaufen"));
    expect(container.querySelector(".note-bar")?.textContent).toContain(t("notes.toDesktop"));
    await click(button(t("notes.more")));
    expect(container.querySelector(".popup-menu")?.textContent).not.toContain(t("notes.toDesktop"));
  });

  it("offers a way out of an empty search", async () => {
    await render();
    const search = container.querySelector<HTMLInputElement>('input[type="search"]');
    if (!search) throw new Error("search missing");
    await act(async () => {
      // The prototype's setter, so React's value tracking sees a change (as typing would).
      Reflect.set(HTMLInputElement.prototype, "value", "zzz", search);
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    await settle();
    expect(container.textContent).toContain(t("notes.noHits", { query: "zzz" }));
    await click(button(t("notes.searchClear")));
    expect(search.value).toBe("");
  });

  it("says the list could not load and loads it again on request", async () => {
    api.listNotes.mockRejectedValueOnce("broken");
    await render();
    expect(container.textContent).toContain(t("notes.loadFailed"));
    expect(container.textContent).not.toContain(t("notes.empty"));
    await click(button(t("notes.retry")));
    expect(titles()).toEqual(["Einkaufen", "Projekt"]);
  });
});

describe("notes area: direction A", () => {
  it("shows one invitation and nothing else while there are no notes", async () => {
    api.listNotes.mockResolvedValue([]);
    await render();
    const news = Array.from(container.querySelectorAll("button")).filter(
      (element) => element.textContent === t("notes.new"),
    );
    expect(news).toHaveLength(1);
    expect(container.querySelector('input[type="search"]')).toBeNull();
    expect(container.querySelector(".color-button")).toBeNull();
    expect(container.textContent).toContain(t("notes.emptyTitle"));
  });

  it("opens a row's menu with Shift+F10 and puts the note on the desktop from it", async () => {
    await render();
    const row = rowButton("Projekt");
    await act(async () => {
      row.dispatchEvent(
        new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }),
      );
      await Promise.resolve();
    });
    const menu = container.querySelector(".popup-menu");
    expect(menu?.getAttribute("aria-label")).toBe(t("notes.actionsFor", { title: "Projekt" }));
    await click(menuItem(t("notes.toDesktop")));
    expect(api.toDesktop).toHaveBeenCalledWith(GENERAL, B);
    expect(container.querySelector(".popup-menu")).toBeNull();
  });

  it("opens the same menu on a right click and deletes from the row's tools", async () => {
    await render();
    const item = rowButton("Projekt").closest("li");
    if (!item) throw new Error("row item missing");
    await act(async () => {
      item.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(container.querySelector(".popup-menu")).not.toBeNull();
    const tools = Array.from(item.querySelectorAll<HTMLButtonElement>(".row-tools button"));
    expect(tools.map((tool) => tool.getAttribute("aria-label"))).toEqual([
      t("notes.color"),
      t("notes.toDesktop"),
      t("notes.delete"),
    ]);
    await click(tools[2] ?? item);
    expect(api.deleteNote).toHaveBeenCalledWith(GENERAL, B);
    expect(container.querySelector(".area-foot")?.textContent).toContain(
      t("notes.deleted", { title: "Projekt" }),
    );
  });

  it("gives only the current row a Tab stop and moves it with the arrow keys", async () => {
    await render();
    expect(rowButton("Einkaufen").tabIndex).toBe(0);
    expect(rowButton("Projekt").tabIndex).toBe(-1);
    await act(async () => {
      rowButton("Einkaufen").focus();
      rowButton("Einkaufen").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(rowButton("Projekt"));
    expect(rowButton("Projekt").tabIndex).toBe(0);
    expect(rowButton("Einkaufen").tabIndex).toBe(-1);
  });

  it("says a failed save in one plain sentence in the footer, never the backend's text", async () => {
    await render();
    await click(rowButton("Einkaufen"));
    api.writeNote.mockRejectedValue("C:/Users/x/notes/Einkaufen.md: Access denied");
    await type("Einkaufen\nneu");
    await act(async () => {
      api.handlers.get("flush:hub")?.();
      await Promise.resolve();
    });
    await settle();
    const foot = container.querySelector(".area-foot");
    expect(foot?.querySelector('[role="alert"]')?.textContent).toContain(t("note.saveFailed"));
    expect(container.textContent).not.toContain("Access denied");
    // A storage code gets its own sentence and replaces the first notice: never two at once.
    api.writeNote.mockRejectedValue("disk-full");
    await click(button(t("notes.retry")));
    expect(foot?.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(foot?.textContent).toContain(t("storage.diskFull"));
    // Once a save works, the error is fixed and goes.
    api.writeNote.mockResolvedValue("v-saved");
    await type("Einkaufen\nneu\nmehr");
    await act(async () => {
      api.handlers.get("flush:hub")?.();
      await Promise.resolve();
    });
    await settle();
    expect(foot?.querySelector('[role="alert"]')).toBeNull();
  });
});

function noteHeading(): Element | null {
  return container.querySelector(".note-heading");
}

async function press(element: Element, key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
    await Promise.resolve();
  });
  await settle();
}

describe("notes area: rework of the calm look", () => {
  it("no second title when the first line is the title", async () => {
    // "Einkaufen" starts with the line "Einkaufen": the page shows the text only.
    await render();
    await click(rowButton("Einkaufen"));
    expect(noteHeading()).toBeNull();
    // A note named on its own, with another first line, keeps its large title.
    api.readNote.mockResolvedValueOnce(opened(B, "Projekt", { text: "Erste Zeile\nmehr" }));
    await click(rowButton("Projekt"));
    expect(noteHeading()?.textContent).toBe("Projekt");
    // A note that is still named after its first line shows no title either.
    api.readNote.mockResolvedValueOnce(
      opened(B, "Projekt", { text: "Ganz anders\nmehr", autoTitled: true }),
    );
    await click(rowButton("Einkaufen"));
    await click(rowButton("Projekt"));
    expect(noteHeading()).toBeNull();
    // F2 and "Rename" still show the title field.
    await press(document.body, "F2");
    expect(container.querySelector<HTMLInputElement>(".note-rename")?.value).toBe("Projekt");
  });

  it("gives the focus back to the title menu after the trash and the settings", async () => {
    await render();
    await openAreaMenu();
    await click(menuItem(t("notes.trash")));
    await click(button(t("notes.back")));
    await frames();
    expect(document.activeElement).toBe(container.querySelector(".scope-button"));
    await openAreaMenu();
    await click(menuItem(t("notes.settings")));
    await click(button(t("notes.back")));
    await frames();
    expect(document.activeElement).toBe(container.querySelector(".scope-button"));
  });

  it("moves the focus to the editor when a notice goes while its button has it", async () => {
    await render();
    await click(rowButton("Einkaufen"));
    api.writeNote.mockRejectedValue("disk-full");
    await type("Einkaufen\nneu");
    await act(async () => {
      api.handlers.get("flush:hub")?.();
      await Promise.resolve();
    });
    await settle();
    const dismiss = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".area-foot button"),
    ).find((element) => element.getAttribute("aria-label") === t("notes.dismiss"));
    if (!dismiss) throw new Error("dismiss button missing");
    await act(async () => {
      dismiss.focus();
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(dismiss);
    await click(dismiss);
    expect(container.querySelector(".area-foot [role='alert']")).toBeNull();
    expect(document.activeElement).toBe(container.querySelector(".note-editor .cm-content"));
  });

  it("names a note on the desktop and folds the footer away", async () => {
    api.listNotes.mockResolvedValue([row(A, "Einkaufen", "mint", { onDesktop: true })]);
    api.readNote.mockResolvedValue(opened(A, "Einkaufen", { onDesktop: true }));
    await render();
    await click(rowButton("Einkaufen"));
    expect(container.querySelector(".on-desktop-heading")?.textContent).toBe("Einkaufen");
    expect(container.querySelector(".notes-area")?.getAttribute("data-idle")).toBe("true");
  });

  it("lists a new note as soon as it exists", async () => {
    await render();
    await click(button(t("notes.new")));
    api.listNotes.mockResolvedValue([
      row(A, "Notiz 1", "lemon", { updatedAt: 9 }),
      row(B, "Projekt", "sky"),
    ]);
    const loads = api.listNotes.mock.calls.length;
    await type("Neu");
    expect(api.createNote).toHaveBeenCalledTimes(1);
    expect(api.listNotes.mock.calls.length).toBeGreaterThan(loads);
    expect(titles()).toContain("Notiz 1");
  });

  it("names each row's project only in All notes", async () => {
    await render();
    expect(
      Array.from(container.querySelectorAll(".note-row-project")).map((e) => e.textContent),
    ).toEqual([t("notes.general"), t("notes.general")]);
    await openAreaMenu();
    await click(menuItem(t("notes.general")));
    expect(container.querySelector(".scope-button")?.textContent).toBe(t("notes.general"));
    expect(container.querySelector(".note-row-project")).toBeNull();
  });
});

/** How a person leaves the open note in each look: back to the list, close the sheet, next row. */
async function leaveNote(look: Look) {
  if (look === "calm") {
    await click(button(t("notes.backToList")));
  } else if (look === "paper") {
    const sheet = container.querySelector(".paper-sheet");
    if (!sheet) throw new Error("sheet missing");
    await press(sheet, "Escape");
  } else {
    await click(rowButton("Projekt"));
  }
}

const ALL_LOOKS: readonly Look[] = ["calm", "paper", "hangar"];

describe.each(ALL_LOOKS)("notes area, shared behaviour in the look %s", (look) => {
  it("saves the open note before it switches to another", async () => {
    await render(look);
    await click(rowButton("Einkaufen"));
    await type("Einkaufen\nneu");
    expect(api.writeNote).not.toHaveBeenCalled();
    await leaveNote(look);
    expect(api.writeNote).toHaveBeenCalledWith(GENERAL, A, "Einkaufen\nneu", `v-${A}`);
    if (look === "hangar") {
      const written = api.writeNote.mock.invocationCallOrder[0] ?? Infinity;
      const read = api.readNote.mock.invocationCallOrder[1] ?? -Infinity;
      expect(written).toBeLessThan(read);
    }
  });

  it("leaves an unsaved note only on the second try, after a warning", async () => {
    await render(look);
    await click(rowButton("Einkaufen"));
    await type("Einkaufen\nneu");
    api.writeNote.mockRejectedValue("disk full");
    const now = vi.spyOn(Date, "now").mockReturnValue(5_000_000);
    await leaveNote(look);
    expect(container.querySelector(".note-pane")?.getAttribute("aria-label")).toBe("Einkaufen");
    expect(container.querySelector(".note-unsaved")?.textContent).toBe(t("notes.unsaved"));
    expect(container.querySelector(".notes-stuck")?.textContent).toContain(t("notes.leaveUnsaved"));
    now.mockReturnValue(5_005_000);
    await leaveNote(look);
    expect(container.querySelector(".notes-stuck")).toBeNull();
    expect(container.querySelector(".note-unsaved")).toBeNull();
    expect(container.querySelector(".note-pane")?.getAttribute("aria-label")).not.toBe("Einkaufen");
    now.mockRestore();
  });

  it("offers no new note and says why while the notes are read only", async () => {
    api.getStatus.mockResolvedValue(readOnly);
    await render(look);
    expect(container.textContent).toContain(t("notes.readOnly"));
    const create = container.querySelector<HTMLButtonElement>('[data-focus-id="new"]');
    expect(create?.disabled).toBe(true);
  });

  it("keeps one editor per note: a note on the desktop is not edited here", async () => {
    api.listNotes.mockResolvedValue([row(A, "Einkaufen", "mint", { onDesktop: true })]);
    api.readNote.mockResolvedValue(opened(A, "Einkaufen", { onDesktop: true }));
    await render(look);
    await click(rowButton("Einkaufen"));
    expect(container.textContent).toContain(t("notes.onDesktopHint"));
    expect(container.querySelector<HTMLElement>(".note-body")?.hidden).toBe(true);
    expect(container.querySelector(".cm-content")).toBeNull();
  });

  it("deletes from the row's menu and brings the note back with Undo", async () => {
    await render(look);
    const item = rowButton("Projekt").closest("li");
    if (!item) throw new Error("row item missing");
    await act(async () => {
      item.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await click(menuItem(t("notes.delete")));
    expect(api.deleteNote).toHaveBeenCalledWith(GENERAL, B);
    expect(container.textContent).toContain(t("notes.deleted", { title: "Projekt" }));
    await click(button(t("notes.undo")));
    expect(api.restoreNote).toHaveBeenCalledWith(GENERAL, B);
  });
});

/** Opens the trash the way each look offers it; returns the control it was opened from. */
async function openTrash(look: Look): Promise<HTMLElement> {
  if (look === "hangar") {
    const entry = container.querySelector<HTMLElement>('[data-focus-id="trash"]');
    if (!entry) throw new Error("trash entry missing");
    await click(entry);
    return entry;
  }
  const opener = container.querySelector<HTMLElement>('[data-focus-id="area"]');
  if (!opener) throw new Error("area menu missing");
  await click(opener);
  await click(menuItem(t("notes.trash")));
  return opener;
}

describe.each(ALL_LOOKS)("notes area, the trash in the look %s", (look) => {
  it("leaves the trash with Escape and gives the focus back to where it was opened", async () => {
    await render(look);
    const opener = await openTrash(look);
    expect(container.querySelector(".trash-list")).not.toBeNull();
    const active = document.activeElement ?? document.body;
    await press(active, "Escape");
    await frames();
    expect(container.querySelector(".trash-list")).toBeNull();
    expect(titles()).toEqual(["Einkaufen", "Projekt"]);
    expect(document.activeElement).toBe(
      container.querySelector(`[data-focus-id="${opener.dataset.focusId ?? ""}"]`),
    );
  });
});

describe("notes area: switching the look", () => {
  it("keeps the open note and its unsaved text when the look changes", async () => {
    await render("calm");
    await click(rowButton("Einkaufen"));
    await type("Einkaufen\nnoch nicht gespeichert");
    expect(api.writeNote).not.toHaveBeenCalled();
    await rerender("paper");
    expect(container.querySelector(".paper-sheet")?.getAttribute("aria-label")).toBe("Einkaufen");
    expect(container.querySelector(".note-editor .cm-content")?.textContent).toBe(
      "Einkaufen\nnoch nicht gespeichert",
    );
    await rerender("hangar");
    expect(container.querySelector(".hangar-editor")?.getAttribute("aria-label")).toBe("Einkaufen");
    expect(container.querySelector(".note-editor .cm-content")?.textContent).toBe(
      "Einkaufen\nnoch nicht gespeichert",
    );
    // Typing goes on in the new editor, and everything reaches the same note.
    await type("Einkaufen\nnoch nicht gespeichert\nmehr");
    await act(async () => {
      api.handlers.get("flush:hub")?.();
      await Promise.resolve();
    });
    await settle();
    expect(api.writeNote).toHaveBeenCalledTimes(1);
    expect(api.writeNote).toHaveBeenCalledWith(
      GENERAL,
      A,
      "Einkaufen\nnoch nicht gespeichert\nmehr",
      `v-${A}`,
    );
  });

  it("offers the three looks as a radio group and saves the choice at once", async () => {
    await render();
    await openAreaMenu();
    await click(menuItem(t("notes.settings")));
    const radios = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="radio"][name="look"]'),
    );
    expect(radios.map((radio) => radio.getAttribute("aria-label"))).toEqual([
      t("look.calm"),
      t("look.paper"),
      t("look.hangar"),
    ]);
    expect(radios[0]?.checked).toBe(true);
    await click(radios[1] ?? container);
    expect(api.setSettings).toHaveBeenCalledWith(expect.objectContaining({ look: "paper" }));
  });
});

describe("notes area: paper look", () => {
  it("ticks a checklist on its card through the note's whole text", async () => {
    api.readNote.mockResolvedValue(
      opened(A, "Einkaufen", { text: "Einkaufen\n- [x] eins\n- [ ] zwei\nRest" }),
    );
    await render("paper");
    const card = rowButton("Einkaufen").closest(".card");
    const boxes = Array.from(card?.querySelectorAll<HTMLInputElement>(".card-task input") ?? []);
    expect(boxes.map((box) => box.checked)).toEqual([true, false]);
    await click(boxes[1] ?? container);
    expect(api.writeNote).toHaveBeenCalledWith(
      GENERAL,
      A,
      "Einkaufen\n- [x] eins\n- [x] zwei\nRest",
      `v-${A}`,
    );
  });

  it("does not write a tick when the line changed meanwhile", async () => {
    api.readNote.mockResolvedValue(
      opened(A, "Einkaufen", { text: "Einkaufen\n- [x] eins\n- [ ] anders" }),
    );
    await render("paper");
    const card = rowButton("Einkaufen").closest(".card");
    const boxes = Array.from(card?.querySelectorAll<HTMLInputElement>(".card-task input") ?? []);
    await click(boxes[1] ?? container);
    expect(api.writeNote).not.toHaveBeenCalled();
  });

  it("opens a note only after a tick on its card is written, so the sheet shows the tick", async () => {
    api.readNote.mockResolvedValue(
      opened(A, "Einkaufen", { text: "Einkaufen\n- [x] eins\n- [ ] zwei" }),
    );
    let release: () => void = () => undefined;
    api.writeNote.mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          release = () => {
            resolve(null);
          };
        }),
    );
    await render("paper");
    const card = rowButton("Einkaufen").closest(".card");
    const boxes = Array.from(card?.querySelectorAll<HTMLInputElement>(".card-task input") ?? []);
    await click(boxes[1] ?? container);
    expect(api.writeNote).toHaveBeenCalledTimes(1);
    const reads = api.readNote.mock.calls.length;
    await click(rowButton("Einkaufen"));
    // The tick is still on its way: opening waits for it instead of reading the old text.
    expect(api.readNote.mock.calls.length).toBe(reads);
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await settle();
    expect(api.readNote.mock.calls.length).toBe(reads + 1);
    expect(container.querySelector(".paper-sheet")).not.toBeNull();
  });

  it("fades a card out only when its lines overflow, and leaves the cut lines out of Tab", async () => {
    const tasks = (count: number) =>
      Array.from({ length: count }, (_, at) => `- [ ] Punkt ${String(at + 1)}`).join("\n");
    api.listNotes.mockResolvedValue([
      row(B, "Projekt", "sky", { preview: `Projekt\n${tasks(8)}` }),
      row(A, "Einkaufen", "mint", { preview: `Einkaufen\n${tasks(6)}` }),
    ]);
    // Layout as the stylesheet makes it: 32 px per checklist line, a body of at most 200 px.
    const LINE = 32;
    const linesOf = (element: Element) =>
      element.classList.contains("card-body") ? element.children.length * LINE : 0;
    const scroll = vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (
      this: Element,
    ) {
      return linesOf(this);
    });
    const client = vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockImplementation(function (this: Element) {
        return Math.min(linesOf(this), 200);
      });
    const top = vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      const parent = this.parentElement;
      return parent?.classList.contains("card-body") === true
        ? Array.from(parent.children).indexOf(this) * LINE
        : 0;
    });
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(LINE);
    try {
      await render("paper");
      const body = (title: string) =>
        rowButton(title).closest(".card")?.querySelector(".card-body");
      // Six lines fit: every one is shown in full, nothing fades.
      expect(body("Einkaufen")?.classList.contains("is-cut")).toBe(false);
      // Eight do not: the body fades out, and the lines in the fade or below it are no Tab stops.
      expect(body("Projekt")?.classList.contains("is-cut")).toBe(true);
      await act(async () => {
        rowButton("Projekt").focus();
        await Promise.resolve();
      });
      expect(rowButton("Projekt").tabIndex).toBe(0);
      const stops = Array.from(
        body("Projekt")?.querySelectorAll<HTMLInputElement>(".card-task input") ?? [],
      ).map((box) => box.tabIndex);
      expect(stops).toEqual([0, 0, 0, 0, 0, -1, -1, -1]);
    } finally {
      scroll.mockRestore();
      client.mockRestore();
      top.mockRestore();
      height.mockRestore();
    }
  });

  it("moves through the grid by its columns, and to the ends with Home and End", async () => {
    const ids = Array.from(
      { length: 7 },
      (_, at) => `00000000-0000-4000-8000-00000000000${String(at + 1)}`,
    );
    api.listNotes.mockResolvedValue(
      ids.map((id, at) => row(id, `Karte ${String(at + 1)}`, "mint")),
    );
    await render("paper");
    const grid = container.querySelector<HTMLElement>(".paper-grid");
    if (!grid) throw new Error("grid missing");
    grid.style.gridTemplateColumns = "240px 240px 240px";
    const card = (n: number) => rowButton(`Karte ${String(n)}`);
    const step = async (key: string) => {
      await press(document.activeElement ?? document.body, key);
    };
    card(1).focus();
    await step("ArrowDown");
    expect(document.activeElement).toBe(card(4));
    await step("ArrowDown");
    expect(document.activeElement).toBe(card(7));
    await step("ArrowUp");
    expect(document.activeElement).toBe(card(4));
    await step("ArrowRight");
    expect(document.activeElement).toBe(card(5));
    // Down onto the shorter last row: its last card.
    await step("ArrowDown");
    expect(document.activeElement).toBe(card(7));
    await step("ArrowLeft");
    expect(document.activeElement).toBe(card(6));
    await step("Home");
    expect(document.activeElement).toBe(card(1));
    await step("End");
    expect(document.activeElement).toBe(card(7));
  });

  it("lays the trash on the table", async () => {
    await render("paper");
    await openTrash("paper");
    expect(container.querySelector(".notes-area.single.on-table .trash-list")).not.toBeNull();
  });

  it("closes the sheet with Escape and gives the focus back to the card", async () => {
    await render("paper");
    await click(rowButton("Projekt"));
    const sheet = container.querySelector(".paper-sheet");
    expect(sheet?.getAttribute("role")).toBe("dialog");
    expect(sheet?.getAttribute("aria-modal")).toBe("true");
    if (!sheet) throw new Error("sheet missing");
    await press(sheet, "Escape");
    await frames();
    expect(container.querySelector(".paper-sheet")).toBeNull();
    expect(document.activeElement).toBe(rowButton("Projekt"));
  });
});

describe("notes area: hangar look", () => {
  it("filters by the color rows of the sidebar and says notices in the status bar", async () => {
    await render("hangar");
    const sky = Array.from(container.querySelectorAll<HTMLButtonElement>(".side-item")).find(
      (element) => element.textContent.includes("Arbeit"),
    );
    if (!sky) throw new Error("color row missing");
    await click(sky);
    expect(sky.getAttribute("aria-pressed")).toBe("true");
    expect(titles()).toEqual(["Projekt"]);
    await press(rowButton("Projekt"), "Delete");
    expect(api.deleteNote).toHaveBeenCalledWith(GENERAL, B);
    expect(container.querySelector(".hangar-status")?.textContent).toContain(
      t("notes.deleted", { title: "Projekt" }),
    );
  });

  it.each([
    [500, "the note's header"],
    [300, "the status bar"],
  ])("shows the progress once, at a note column of %i px in %s", async (width) => {
    api.readNote.mockResolvedValue(
      opened(B, "Projekt", { text: "Projekt\n- [x] eins\n- [ ] zwei" }),
    );
    const client = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockImplementation(function (this: Element) {
        return this.classList.contains("hangar-editor") ? width : 0;
      });
    try {
      // "Projekt" is shown with or without the color the tests before may have left chosen.
      await render("hangar");
      await click(rowButton("Projekt"));
      const inHead = container.querySelectorAll(".hangar-head .note-progress").length;
      const inStatus = container.querySelectorAll(".hangar-status .note-progress").length;
      expect(inHead + inStatus).toBe(1);
      expect(inHead).toBe(width > 320 ? 1 : 0);
    } finally {
      client.mockRestore();
    }
  });

  it("shows the trash in the place of the list and the note, beside the sidebar", async () => {
    await render("hangar");
    const sky = Array.from(container.querySelectorAll<HTMLButtonElement>(".side-item")).find(
      (element) => element.textContent.includes("Arbeit"),
    );
    if (!sky) throw new Error("color row missing");
    // The chosen colors outlive a window; start without one.
    if (sky.getAttribute("aria-pressed") === "true") await click(sky);
    await openTrash("hangar");
    expect(container.querySelector(".layout-hangar .hangar-trash .trash-list")).not.toBeNull();
    expect(container.querySelector(".hangar-list")).toBeNull();
    expect(container.querySelector(".hangar-editor")).toBeNull();
    expect(container.querySelector(".hangar-status")).not.toBeNull();
    const entry = container.querySelector('[data-focus-id="trash"]');
    expect(entry?.getAttribute("aria-current")).toBe("page");
    // A color in the sidebar leads back to the notes, filtered by it.
    await click(sky);
    expect(container.querySelector(".trash-list")).toBeNull();
    expect(titles()).toEqual(["Projekt"]);
    expect(container.querySelector('[data-focus-id="trash"]')?.getAttribute("aria-current")).toBe(
      null,
    );
    await click(sky);
  });

  it("gives the focus back to the sidebar's entry after the trash", async () => {
    await render("hangar");
    const trash = container.querySelector<HTMLButtonElement>('[data-focus-id="trash"]');
    if (!trash) throw new Error("trash entry missing");
    await click(trash);
    await click(button(t("notes.back")));
    await frames();
    expect(document.activeElement).toBe(container.querySelector('[data-focus-id="trash"]'));
  });
});

async function flushHub() {
  await act(async () => {
    api.handlers.get("flush:hub")?.();
    await Promise.resolve();
  });
  await settle();
}

function alertText(): string {
  return container.querySelector("[role='alert']")?.textContent ?? "";
}

describe("notes area: a note changed outside", () => {
  it("saves with the version it was read with, then with the one each save answers", async () => {
    await render();
    await click(rowButton("Einkaufen"));
    api.writeNote.mockResolvedValueOnce("v-1").mockResolvedValueOnce("v-2");
    await type("Einkaufen\neins");
    await flushHub();
    await type("Einkaufen\nzwei");
    await flushHub();
    expect(api.writeNote.mock.calls).toEqual([
      [GENERAL, A, "Einkaufen\neins", `v-${A}`],
      [GENERAL, A, "Einkaufen\nzwei", "v-1"],
    ]);
  });

  it("keeps the text, offers reload and copy, and reloads only after asking", async () => {
    await render();
    await click(rowButton("Einkaufen"));
    api.writeNote.mockRejectedValue("changed");
    await type("Einkaufen\nmeine Fassung");
    await flushHub();
    expect(alertText()).toContain(t("error.changed"));
    expect(alertText()).not.toContain("changed");
    expect(container.querySelector(".note-unsaved")?.textContent).toBe(t("notes.unsaved"));
    expect(api.noteFlushed).toHaveBeenLastCalledWith(false);
    await click(button(t("notes.copyMarkdown")));
    expect(api.copyText).toHaveBeenCalledWith("Einkaufen\nmeine Fassung");
    expect(alertText()).toContain(t("notes.copied"));
    // Nothing more is sent: every save would be refused the same way.
    await type("Einkaufen\nmeine Fassung, mehr");
    await flushHub();
    expect(api.writeNote).toHaveBeenCalledTimes(1);
    // "Reload" asks in the notice first; going back changes nothing.
    await click(button(t("notes.reloadNote")));
    expect(alertText()).toContain(t("notes.reloadDiscards"));
    expect(api.readNote).toHaveBeenCalledTimes(1);
    await click(button(t("notes.reloadCancel")));
    expect(alertText()).toContain(t("error.changed"));
    expect(api.readNote).toHaveBeenCalledTimes(1);
    // Confirmed: the note as its file is now, and saving goes on with that version.
    api.readNote.mockResolvedValue(opened(A, "Einkaufen", { text: "Von außen", version: "v-9" }));
    api.writeNote.mockResolvedValue("v-10");
    await click(button(t("notes.reloadNote")));
    await click(button(t("notes.reloadConfirm")));
    expect(api.readNote).toHaveBeenCalledTimes(2);
    expect(editor.text).toBe("Von außen");
    expect(container.querySelector(".area-foot [role='alert']")).toBeNull();
    expect(container.querySelector(".note-unsaved")).toBeNull();
    await type("Von außen\nweiter");
    await flushHub();
    expect(api.writeNote).toHaveBeenLastCalledWith(GENERAL, A, "Von außen\nweiter", "v-9");
    expect(api.noteFlushed).toHaveBeenLastCalledWith(true);
  });

  it("leaves a note changed outside only on the second try, as after any failed save", async () => {
    await render();
    await click(rowButton("Einkaufen"));
    api.writeNote.mockRejectedValue("changed");
    await type("Einkaufen\nmeine Fassung");
    const now = vi.spyOn(Date, "now").mockReturnValue(8_000_000);
    await click(rowButton("Projekt"));
    expect(container.querySelector(".note-pane")?.getAttribute("aria-label")).toBe("Einkaufen");
    expect(container.querySelector(".notes-stuck")?.textContent).toContain(t("notes.leaveUnsaved"));
    now.mockReturnValue(8_004_000);
    await click(rowButton("Projekt"));
    expect(container.querySelector(".note-pane")?.getAttribute("aria-label")).toBe("Projekt");
    expect(container.querySelector(".notes-stuck")).toBeNull();
    now.mockRestore();
    // Back on the note, it saves again with the version it is read with now.
    api.writeNote.mockResolvedValue("v-saved");
    await click(rowButton("Einkaufen"));
    await type("Einkaufen\nneu");
    await flushHub();
    expect(api.writeNote).toHaveBeenLastCalledWith(GENERAL, A, "Einkaufen\nneu", `v-${A}`);
  });

  it("does not set a tick on a card whose note changed outside, and shows it as it is now", async () => {
    api.readNote.mockResolvedValue(
      opened(A, "Einkaufen", { text: "Einkaufen\n- [x] eins\n- [ ] zwei", version: "v-3" }),
    );
    api.writeNote.mockRejectedValue("changed");
    await render("paper");
    const loads = api.listNotes.mock.calls.length;
    const boxes = () =>
      Array.from(
        rowButton("Einkaufen")
          .closest(".card")
          ?.querySelectorAll<HTMLInputElement>(".card-task input") ?? [],
      );
    await click(boxes()[1] ?? container);
    expect(api.writeNote).toHaveBeenCalledWith(
      GENERAL,
      A,
      "Einkaufen\n- [x] eins\n- [x] zwei",
      "v-3",
    );
    expect(api.listNotes.mock.calls.length).toBeGreaterThan(loads);
    expect(boxes().map((box) => box.checked)).toEqual([true, false]);
    expect(alertText()).toContain(t("error.changed"));
  });
});

describe("notes area: small fixes", () => {
  it("marks only the trash in the hangar sidebar while the trash is shown", async () => {
    await render("hangar");
    const pressed = () =>
      Array.from(container.querySelectorAll<HTMLButtonElement>(".side-list button")).filter(
        (element) =>
          element.getAttribute("aria-pressed") === "true" && !element.querySelector(".color-dot"),
      );
    // One scope is the place shown while the notes are.
    expect(pressed()).toHaveLength(1);
    await openTrash("hangar");
    expect(pressed()).toEqual([]);
    expect(container.querySelector('[data-focus-id="trash"]')?.getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("says why start with the system could not be changed, in its own sentence", async () => {
    api.setAutostart.mockRejectedValue("autostart");
    await render();
    await openAreaMenu();
    await click(menuItem(t("notes.settings")));
    const box = Array.from(container.querySelectorAll<HTMLLabelElement>("label")).find((label) =>
      label.textContent.includes(t("settings.autostart")),
    );
    const input = box?.querySelector("input");
    if (!input) throw new Error("autostart switch missing");
    await click(input);
    expect(container.textContent).toContain(t("error.autostart"));
    expect(container.textContent).not.toContain(t("settings.failed"));
  });
});
