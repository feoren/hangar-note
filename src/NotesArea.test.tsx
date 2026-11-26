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
  listNoteFolders: vi.fn(),
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
  setSidebarOpen: vi.fn(),
  setSidebarWidth: vi.fn(),
  setLastProject: vi.fn(),
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
  listNoteFolders: api.listNoteFolders,
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
  onNotesChanged: vi.fn((handler: () => void) => {
    api.handlers.set("notes-changed", handler);
    return Promise.resolve(() => undefined);
  }),
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
  setSidebarOpen: api.setSidebarOpen,
  setSidebarWidth: api.setSidebarWidth,
  setLastProject: api.setLastProject,
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
const { forgetSession } = await import("./useNotesArea");

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
/** Stored settings beyond the defaults for the next render (sidebar, last project). */
let stored: Partial<NonNullable<AppSettings["settings"]>> = {};
let root: Root;
let container: HTMLDivElement;

/** The app settings with another look, as the backend's settings-changed event brings them. */
function withLook(look: Look): AppSettings {
  return {
    ...calmApp,
    look,
    settings: calmApp.settings === null ? null : { ...calmApp.settings, ...stored, look },
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

/** An entry of the sidebar by its visible name (the count aside). */
function navItem(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll<HTMLButtonElement>(".nav button")).find(
    (element) => element.querySelector(".nav-label")?.textContent === label,
  );
  if (!found) throw new Error(`sidebar entry ${label} missing`);
  return found;
}

/** A color of the sidebar's filter by its name. */
function navColor(name: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll<HTMLButtonElement>(".nav-dot")).find(
    (element) => element.getAttribute("aria-label")?.startsWith(`${name} (`),
  );
  if (!found) throw new Error(`color ${name} missing`);
  return found;
}

/** The area heading of the notes (the shown area's name). */
function heading(): string {
  return container.querySelector(".area-heading h1")?.textContent ?? "";
}

/** A level tab by its level. */
function tab(level: "private" | "project" | "team"): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`#level-tab-${level}`);
  if (!found) throw new Error(`tab ${level} missing`);
  return found;
}

/** The levels whose tab is chosen. */
function chosenTabs(): string[] {
  return Array.from(container.querySelectorAll('[role="tab"][aria-selected="true"]')).map(
    (element) => element.id.replace("level-tab-", ""),
  );
}

/** The sidebar entries marked as the current place. */
function currentPlaces(): string[] {
  return Array.from(container.querySelectorAll('.nav [aria-current="page"]')).map(
    (element) => element.querySelector(".nav-label")?.textContent ?? "",
  );
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
  api.listNoteFolders.mockResolvedValue([]);
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
  api.setSidebarOpen.mockImplementation((open: boolean) => Promise.resolve(open));
  api.setSidebarWidth.mockImplementation((width: number) => Promise.resolve(width));
  api.setLastProject.mockImplementation((folder: string | null) => Promise.resolve(folder));
  stored = {};
  forgetSession();
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
    // The sidebar's colors: each dot names its color (the own name) and how many notes have it.
    expect(navColor("Arbeit").getAttribute("aria-label")).toBe("Arbeit (1)");
    await click(navColor("Arbeit"));
    expect(titles()).toEqual(["Projekt"]);
    expect(navColor("Arbeit").getAttribute("aria-pressed")).toBe("true");
    await click(navColor(t("color.mint")));
    expect(titles()).toEqual(["Einkaufen", "Projekt"]);
    // "All colors" keeps its place and shows once a color is chosen.
    const clear = button(t("notes.colorFilterClear"));
    expect(clear.hidden).toBe(false);
    await click(clear);
    expect(titles()).toEqual(["Einkaufen", "Projekt"]);
    expect(container.querySelector('.nav-dot[aria-pressed="true"]')).toBeNull();
    expect(button(t("notes.colorFilterClear")).hidden).toBe(true);
  });

  it("shows a small read-only chip with its reason and offers no new note", async () => {
    api.getStatus.mockResolvedValue({
      ...writable,
      access: { state: "readOnly", reason: "otherWriter" },
    });
    await render();
    expect(container.querySelector(".ro-chip")?.textContent).toBe(t("notes.readOnlyChip"));
    expect(container.textContent).toContain(t("notes.otherWriter"));
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

const readOnly: Status = { ...writable, access: { state: "readOnly", reason: "otherWriter" } };
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

  it("opens a captured note read only, without a draft, while the notes are read only", async () => {
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
    await click(navItem(t("notes.trash")));
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
  it("starts on Private without a project, and new notes go there", async () => {
    await render();
    expect(heading()).toBe(t("level.privateTitle"));
    expect(chosenTabs()).toEqual(["private"]);
    expect(currentPlaces()).toEqual([]);
    await click(button(t("notes.new")));
    await type("Neu");
    expect(api.createNote).toHaveBeenCalledWith(GENERAL, "Notiz");
  });

  it("switches the window on top from the sidebar's menu", async () => {
    await render();
    const more = () => {
      const found = container.querySelector<HTMLButtonElement>(".nav-head .icon-button");
      if (!found) throw new Error("sidebar menu missing");
      return found;
    };
    await click(more());
    const item = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]'),
    ).find((element) => element.textContent.includes(t("note.keepOnTop")));
    expect(item?.getAttribute("aria-checked")).toBe("false");
    if (!item) throw new Error("on-top switch missing");
    await click(item);
    expect(api.setHubOnTop).toHaveBeenCalledWith(true);
    await click(more());
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
    expect(container.textContent).not.toContain(t("notes.emptyLead"));
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
    expect(container.querySelector(".nav-dot")).toBeNull();
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

  it("gives the focus back to the sidebar's entry after the trash and the settings", async () => {
    await render();
    await click(navItem(t("notes.trash")));
    await click(button(t("notes.back")));
    await frames();
    expect(document.activeElement).toBe(navItem(t("notes.trash")));
    await click(navItem(t("notes.settings")));
    await click(button(t("notes.back")));
    await frames();
    expect(document.activeElement).toBe(navItem(t("notes.settings")));
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
    expect(container.querySelector(".note-row-project")).toBeNull();
    await click(navItem(t("note.allNotes")));
    expect(heading()).toBe(t("note.allNotes"));
    expect(chosenTabs()).toEqual([]);
    expect(
      Array.from(container.querySelectorAll(".note-row-project")).map((e) => e.textContent),
    ).toEqual([t("notes.general"), t("notes.general")]);
    await click(tab("private"));
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
    expect(container.querySelector(".ro-chip")?.textContent).toBe(t("notes.readOnlyChip"));
    expect(container.textContent).toContain(t("notes.otherWriter"));
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

/** Opens the trash from the sidebar, the same in every look; returns that entry. */
async function openTrash(): Promise<HTMLElement> {
  const entry = navItem(t("notes.trash"));
  await click(entry);
  return entry;
}

describe.each(ALL_LOOKS)("notes area, the trash in the look %s", (look) => {
  it("leaves the trash with Escape and gives the focus back to where it was opened", async () => {
    await render(look);
    const opener = await openTrash();
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
    await click(navItem(t("notes.settings")));
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
    await openTrash();
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
  it("filters by the colors of the sidebar and says notices in the status bar", async () => {
    await render("hangar");
    const sky = navColor("Arbeit");
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

  it("shows the trash beside the sidebar, and a color there leads back to the notes", async () => {
    await render("hangar");
    // The chosen colors outlive a window; start without one.
    if (navColor("Arbeit").getAttribute("aria-pressed") === "true") await click(navColor("Arbeit"));
    const area = currentPlaces();
    await openTrash();
    expect(container.querySelector(".notes-shell .shell-main .trash-list")).not.toBeNull();
    expect(container.querySelector(".hangar-list")).toBeNull();
    expect(currentPlaces()).toEqual([t("notes.trash")]);
    await click(navColor("Arbeit"));
    expect(container.querySelector(".trash-list")).toBeNull();
    expect(titles()).toEqual(["Projekt"]);
    expect(currentPlaces()).toEqual(area);
    await click(navColor("Arbeit"));
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

describe.each(ALL_LOOKS)("notes area, a row after a change outside in the look %s", (look) => {
  /** The text of a note's row, or its card in the paper look. */
  const rowText = (title: string) =>
    rowButton(title).closest("li, .card")?.textContent ?? rowButton(title).textContent;

  /** Saves one version of Einkaufen, then has the next save refused as changed outside. */
  async function changeOutside() {
    await render(look);
    await click(rowButton("Einkaufen"));
    await type("Einkaufen\nmeine Fassung eins");
    await flushHub();
    api.listNotes.mockResolvedValue([
      row(A, "Einkaufen", "mint", { preview: "Einkaufen\nVon der Platte" }),
      row(B, "Projekt", "sky"),
    ]);
    api.writeNote.mockRejectedValue("changed");
    await type("Einkaufen\nmeine Fassung zwei");
    await flushHub();
    expect(alertText()).toContain(t("error.changed"));
  }

  it("shows the text on disk once the save is refused and after the second switch", async () => {
    await changeOutside();
    expect(rowText("Einkaufen")).toContain("Von der Platte");
    const now = vi.spyOn(Date, "now").mockReturnValue(9_000_000);
    await leaveNote(look);
    now.mockReturnValue(9_004_000);
    await leaveNote(look);
    now.mockRestore();
    expect(container.querySelector(".notes-stuck")).toBeNull();
    expect(rowText("Einkaufen")).toContain("Von der Platte");
    expect(rowText("Einkaufen")).not.toContain("meine Fassung");
  });

  it("shows the text on disk after Reload", async () => {
    await changeOutside();
    api.listNotes.mockResolvedValue([
      row(A, "Einkaufen", "mint", { preview: "Einkaufen\nNeu geladen" }),
      row(B, "Projekt", "sky"),
    ]);
    api.readNote.mockResolvedValue(opened(A, "Einkaufen", { text: "Einkaufen\nNeu geladen" }));
    await click(button(t("notes.reloadNote")));
    await click(button(t("notes.reloadConfirm")));
    expect(editor.text).toBe("Einkaufen\nNeu geladen");
    expect(rowText("Einkaufen")).toContain("Neu geladen");
  });
});

describe("notes area: small fixes", () => {
  it("says why start with the system could not be changed, in its own sentence", async () => {
    api.setAutostart.mockRejectedValue("autostart");
    await render();
    await click(navItem(t("notes.settings")));
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

const SHOP = "C:\\Projekte\\shop";
const WEB = "C:\\Projekte\\hangar.feoren.com";
const IDEAS = "c3d4e5f6-0000-4000-8000-000000000001";

/** General with two notes and the project "shop" with one; empty projects are not listed. */
function withProjects() {
  api.listNoteFolders.mockResolvedValue([
    { folderKey: "general", path: null, name: null, noteCount: 2, updatedAt: 3 },
    { folderKey: "s", path: SHOP, name: "shop", noteCount: 1, updatedAt: 2 },
  ]);
  api.listNotes.mockImplementation((folder: { path: string | null }) =>
    Promise.resolve(
      folder.path === null
        ? [row(A, "Einkaufen", "mint"), row(IDEAS, "Ideen", "sky")]
        : folder.path === SHOP
          ? [row(B, "Kunden", "rose", { path: SHOP, folderKey: "s" })]
          : [],
    ),
  );
}

/** Presses a key on the window, as a person does from anywhere in it. */
async function pressWindow(key: string, init: KeyboardEventInit = {}) {
  await press(document.body, key, init);
}

describe.each(ALL_LOOKS)("notes area, the sidebar in the look %s", (look) => {
  it("lists All and every project by its name, with counts, and marks the place", async () => {
    withProjects();
    await render(look);
    const nav = container.querySelector("nav.nav");
    expect(nav?.getAttribute("aria-label")).toBe(t("notes.scopes"));
    expect(
      Array.from(container.querySelectorAll(".nav-list .nav-item")).map((item) => [
        item.querySelector(".nav-label")?.textContent,
        item.querySelector(".nav-count")?.textContent ?? null,
      ]),
    ).toEqual([
      [t("note.allNotes"), "3"],
      ["shop", "1"],
      [t("notes.trash"), null],
      [t("notes.settings"), null],
    ]);
    // The tooltip names the full path.
    expect(navItem("shop").title).toBe(SHOP);
    await click(navItem(t("note.allNotes")));
    expect(currentPlaces()).toEqual([t("note.allNotes")]);
    expect(heading()).toBe(t("note.allNotes"));
    // A project from the sidebar shows in the Project level.
    await click(navItem("shop"));
    expect(currentPlaces()).toEqual(["shop"]);
    expect(chosenTabs()).toEqual(["project"]);
    expect(heading()).toBe("shop");
    expect(titles()).toEqual(["Kunden"]);
    expect(api.listNotes).toHaveBeenLastCalledWith({ path: SHOP });
  });

  it("moves through the entries with the arrow keys, one Tab stop for all of them", async () => {
    withProjects();
    await render(look);
    await click(navItem(t("note.allNotes")));
    const stops = Array.from(container.querySelectorAll<HTMLElement>(".nav [data-nav]")).filter(
      (element) => element.tabIndex === 0,
    );
    expect(stops).toEqual([navItem(t("note.allNotes"))]);
    await press(navItem(t("note.allNotes")), "ArrowDown");
    expect(document.activeElement).toBe(navItem("shop"));
    await press(navItem("shop"), "End");
    expect(document.activeElement).toBe(navItem(t("notes.settings")));
    await press(navItem(t("notes.settings")), "ArrowDown");
    expect(document.activeElement).toBe(navItem(t("note.allNotes")));
  });

  it("chooses a level with Ctrl+1 to Ctrl+3, from the trash too", async () => {
    withProjects();
    await render(look);
    await pressWindow("2", { code: "Digit2", ctrlKey: true });
    expect(chosenTabs()).toEqual(["project"]);
    expect(heading()).toBe("shop");
    await click(navItem(t("notes.trash")));
    await pressWindow("1", { code: "Digit1", ctrlKey: true });
    expect(container.querySelector(".trash-list")).toBeNull();
    expect(heading()).toBe(t("level.privateTitle"));
    await pressWindow("3", { code: "Digit3", ctrlKey: true });
    expect(chosenTabs()).toEqual(["team"]);
    // Ctrl+Shift+9 stays the editor's checklist; Ctrl+4 and up choose nothing.
    await pressWindow("(", { code: "Digit9", ctrlKey: true, shiftKey: true });
    await pressWindow("4", { code: "Digit4", ctrlKey: true });
    expect(chosenTabs()).toEqual(["team"]);
  });
});

describe("notes area: start and empty areas", () => {
  it("starts on the project Hangar Note was opened for, listed even without notes", async () => {
    withProjects();
    api.getStatus.mockResolvedValue({ ...writable, project: WEB });
    api.takeHubRequests.mockResolvedValue([{ kind: "showProject" }]);
    await render();
    expect(heading()).toBe("hangar.feoren.com");
    expect(navItem("hangar.feoren.com").getAttribute("aria-current")).toBe("page");
    expect(navItem("hangar.feoren.com").querySelector(".nav-count")?.textContent).toBe("0");
    // An empty area with notes elsewhere: one sentence and "New note", which writes here.
    expect(container.textContent).toContain(
      t("notes.emptyProject", { folder: "hangar.feoren.com" }),
    );
    expect(container.querySelector('input[type="search"]')).not.toBeNull();
    const create = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".notes-empty button"),
    ).find((element) => element.textContent === t("notes.new"));
    if (!create) throw new Error("new note in the empty area missing");
    await click(create);
    await type("Neu");
    expect(api.createNote).toHaveBeenCalledWith({ path: WEB }, "Notiz");
  });
});

describe("notes area: the read-only chip", () => {
  it("names its reason as description and opens it on a click, Escape closes it", async () => {
    api.getStatus.mockResolvedValue({
      ...writable,
      access: { state: "readOnly", reason: "lockFailed" },
    });
    await render();
    const chip = container.querySelector<HTMLButtonElement>(".ro-chip");
    if (!chip) throw new Error("chip missing");
    const reason = document.getElementById(chip.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toBe(t("notes.lockFailed"));
    expect(chip.title).toBe(t("notes.lockFailed"));
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    await click(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(reason?.classList.contains("open")).toBe(true);
    await press(chip, "Escape");
    expect(chip.getAttribute("aria-expanded")).toBe("false");
  });

  it("is not there while the notes can be written", async () => {
    await render();
    expect(container.querySelector(".ro-chip")).toBeNull();
  });
});

describe("notes area: a narrow window", () => {
  it("folds the sidebar behind a button and closes it after a choice", async () => {
    const width = vi.spyOn(window, "innerWidth", "get").mockReturnValue(500);
    try {
      withProjects();
      await render();
      expect(container.querySelector(".nav")).toBeNull();
      const opener = container.querySelector<HTMLButtonElement>(".side-toggle");
      if (!opener) throw new Error("sidebar button missing");
      expect(opener.getAttribute("aria-label")).toBe(t("nav.toggle"));
      expect(opener.getAttribute("aria-expanded")).toBe("false");
      expect(opener.getAttribute("aria-haspopup")).toBe("dialog");
      await click(opener);
      const dialog = container.querySelector('[role="dialog"]');
      expect(dialog?.getAttribute("aria-modal")).toBe("true");
      expect(container.querySelector(".shell-main")?.hasAttribute("inert")).toBe(true);
      await click(navItem("shop"));
      expect(container.querySelector(".nav")).toBeNull();
      expect(heading()).toBe("shop");
      expect(document.activeElement).toBe(container.querySelector(".side-toggle"));
      // Escape closes it as well, and so does Ctrl+Shift+S.
      await click(opener);
      const nav = container.querySelector(".nav");
      if (!nav) throw new Error("sidebar missing");
      await press(nav, "Escape");
      expect(container.querySelector(".nav")).toBeNull();
      await pressWindow("S", { code: "KeyS", ctrlKey: true, shiftKey: true });
      expect(container.querySelector(".nav")).not.toBeNull();
      // A narrow window never stores the folded state: it is the window's, not the person's.
      expect(api.setSidebarOpen).not.toHaveBeenCalled();
    } finally {
      width.mockRestore();
    }
  });
});

async function notesChanged() {
  await act(async () => {
    api.handlers.get("notes-changed")?.();
    await Promise.resolve();
  });
  await settle();
}

describe("notes area: a change outside", () => {
  it("shows the open note's new text without a click while nothing waits for its save", async () => {
    await render();
    await click(rowButton("Einkaufen"));
    api.readNote.mockResolvedValue(
      opened(A, "Einkaufen", { text: "Einkaufen\nvon Hangar", version: "v-outside" }),
    );
    await notesChanged();
    expect(editor.text).toBe("Einkaufen\nvon Hangar");
    // The next save sends the version it now shows.
    await type("Einkaufen\nvon Hangar\nund hier");
    await flushHub();
    expect(api.writeNote).toHaveBeenLastCalledWith(
      GENERAL,
      A,
      "Einkaufen\nvon Hangar\nund hier",
      "v-outside",
    );
  });

  it("keeps typed text that waits for its save", async () => {
    await render();
    await click(rowButton("Einkaufen"));
    const shown = editor.text;
    await type("Einkaufen\nmeins");
    api.readNote.mockResolvedValue(
      opened(A, "Einkaufen", { text: "Einkaufen\nvon Hangar", version: "v-outside" }),
    );
    await notesChanged();
    expect(editor.text).toBe(shown);
  });

  it("keeps typed text whose save is still on its way", async () => {
    await render();
    await click(rowButton("Einkaufen"));
    const shown = editor.text;
    let refuse: (reason: unknown) => void = () => undefined;
    api.writeNote.mockReturnValueOnce(
      new Promise<string>((_, reject) => {
        refuse = reject;
      }),
    );
    await type("Einkaufen\nmeins");
    // The save starts and waits for the disk; meanwhile Hangar's change arrives.
    await act(async () => {
      api.handlers.get("flush:hub")?.();
      await Promise.resolve();
    });
    await settle();
    expect(api.writeNote).toHaveBeenCalledTimes(1);
    api.readNote.mockResolvedValue(
      opened(A, "Einkaufen", { text: "Einkaufen\nvon Hangar", version: "v-outside" }),
    );
    await notesChanged();
    expect(editor.text).toBe(shown);
    await act(async () => {
      refuse("changed");
      await Promise.resolve();
    });
    await settle();
    expect(editor.text).toBe(shown);
  });

  it("does nothing when the version did not change (its own save)", async () => {
    await render();
    await click(rowButton("Einkaufen"));
    const shown = editor.text;
    api.readNote.mockResolvedValue(opened(A, "Einkaufen", { text: "anders", version: `v-${A}` }));
    await notesChanged();
    expect(editor.text).toBe(shown);
  });
});

/** General, "shop" and "hangar.feoren.com", whose note is the newest. */
function withTwoProjects() {
  api.listNoteFolders.mockResolvedValue([
    { folderKey: "general", path: null, name: null, noteCount: 2, updatedAt: 3 },
    { folderKey: "s", path: SHOP, name: "shop", noteCount: 1, updatedAt: 2 },
    { folderKey: "w", path: WEB, name: "hangar.feoren.com", noteCount: 1, updatedAt: 5 },
  ]);
  api.listNotes.mockImplementation((folder: { path: string | null }) =>
    Promise.resolve(
      folder.path === null
        ? [row(A, "Einkaufen", "mint"), row(IDEAS, "Ideen", "sky")]
        : folder.path === SHOP
          ? [row(B, "Kunden", "rose", { path: SHOP, folderKey: "s" })]
          : [row(C, "Release", "lemon", { path: WEB, folderKey: "w" })],
    ),
  );
}

const C = "d4e5f6a7-0000-4000-8000-000000000002";

/** The name the project tab shows. */
function projectTabLabel(): string {
  return tab("project").querySelector(".level-label")?.textContent ?? "";
}

function sideToggle(): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(".side-toggle");
  if (!found) throw new Error("sidebar button missing");
  return found;
}

function separator(): HTMLElement {
  const found = container.querySelector<HTMLElement>('[role="separator"]');
  if (!found) throw new Error("sidebar edge missing");
  return found;
}

describe("notes area: folding the sidebar away", () => {
  it("folds and shows it with its button and Ctrl+Shift+S, and stores the choice", async () => {
    await render();
    const toggle = sideToggle();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const side = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(side?.tagName).toBe("NAV");
    expect(toggle.title).toBe(`${t("nav.hide")} (Strg+Umschalt+S)`);
    await click(toggle);
    expect(container.querySelector(".notes-shell")?.getAttribute("data-side")).toBe("closed");
    expect(container.querySelector(".shell-side")?.hasAttribute("inert")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.title).toBe(`${t("nav.show")} (Strg+Umschalt+S)`);
    expect(api.setSidebarOpen).toHaveBeenLastCalledWith(false);
    // From the editor too: the key is none of the editor's.
    await click(button(t("notes.new")));
    await pressWindow("S", { code: "KeyS", ctrlKey: true, shiftKey: true });
    expect(container.querySelector(".notes-shell")?.getAttribute("data-side")).toBe("open");
    expect(api.setSidebarOpen).toHaveBeenLastCalledWith(true);
    // Folded from inside the sidebar: the focus goes to the button, not to the page.
    const entry = container.querySelector<HTMLElement>(".shell-side nav button");
    entry?.focus();
    expect(document.activeElement).toBe(entry);
    await pressWindow("S", { code: "KeyS", ctrlKey: true, shiftKey: true });
    expect(container.querySelector(".notes-shell")?.getAttribute("data-side")).toBe("closed");
    expect(document.activeElement).toBe(sideToggle());
  });

  it("starts folded when the settings say so, and keeps working without the stored setting", async () => {
    stored = { sidebarOpen: false };
    api.setSidebarOpen.mockRejectedValue("Command set_sidebar_open not found");
    await render();
    expect(sideToggle().getAttribute("aria-expanded")).toBe("false");
    await click(sideToggle());
    expect(sideToggle().getAttribute("aria-expanded")).toBe("true");
    // An older backend (before a restart) refuses to store it: nothing alarming is said.
    expect(container.querySelector(".notice")).toBeNull();
  });
});

describe("notes area: the sidebar's width", () => {
  it("is a separator with its range, moved with the arrow keys and reset with a double click", async () => {
    await render();
    const edge = separator();
    expect(edge.getAttribute("aria-valuenow")).toBe("232");
    expect(edge.getAttribute("aria-valuemin")).toBe("180");
    // 40 % of the 1024 px test window is wider than the maximum.
    expect(edge.getAttribute("aria-valuemax")).toBe("400");
    expect(edge.tabIndex).toBe(0);
    await press(edge, "ArrowRight");
    expect(api.setSidebarWidth).toHaveBeenLastCalledWith(240);
    expect(separator().getAttribute("aria-valuenow")).toBe("240");
    await press(separator(), "ArrowRight", { shiftKey: true });
    expect(api.setSidebarWidth).toHaveBeenLastCalledWith(272);
    await press(separator(), "Home");
    expect(api.setSidebarWidth).toHaveBeenLastCalledWith(180);
    await press(separator(), "ArrowLeft");
    // Already at the minimum: nothing new to store.
    expect(api.setSidebarWidth).toHaveBeenCalledTimes(3);
    await act(async () => {
      separator().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      await Promise.resolve();
    });
    expect(api.setSidebarWidth).toHaveBeenLastCalledWith(232);
    const shell = container.querySelector<HTMLElement>(".notes-shell");
    expect(shell?.style.getPropertyValue("--side-width")).toBe("232px");
  });

  it("follows a drag within its range and stores it when the drag ends", async () => {
    await render();
    const edge = separator();
    const pointer = (type: string, clientX: number) =>
      act(async () => {
        edge.dispatchEvent(
          new PointerEvent(type, { bubbles: true, clientX, pointerId: 1, button: 0 }),
        );
        await Promise.resolve();
      });
    await pointer("pointerdown", 232);
    await pointer("pointermove", 300);
    expect(separator().getAttribute("aria-valuenow")).toBe("300");
    expect(api.setSidebarWidth).not.toHaveBeenCalled();
    await pointer("pointermove", 900);
    expect(separator().getAttribute("aria-valuenow")).toBe("400");
    await pointer("pointerup", 900);
    expect(api.setSidebarWidth).toHaveBeenCalledTimes(1);
    expect(api.setSidebarWidth).toHaveBeenLastCalledWith(400);
  });

  it("starts at the stored width, brought into the window's range", async () => {
    stored = { sidebarWidth: 300 };
    await render();
    expect(separator().getAttribute("aria-valuenow")).toBe("300");
    act(() => {
      root.unmount();
    });
    container.remove();
    stored = { sidebarWidth: 5000 };
    await render();
    expect(separator().getAttribute("aria-valuenow")).toBe("400");
  });
});

describe.each(ALL_LOOKS)("notes area, the level tabs in the look %s", (look) => {
  it("are one Tab stop, and the arrow keys, Home and End choose", async () => {
    withProjects();
    await render(look);
    const list = container.querySelector('[role="tablist"]');
    expect(list?.getAttribute("aria-label")).toBe(t("level.tabs"));
    const stops = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]')).filter(
      (element) => element.tabIndex === 0,
    );
    expect(stops).toEqual([tab("private")]);
    expect(tab("private").getAttribute("aria-controls")).toBe("level-panel");
    expect(container.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby")).toBe(
      "level-tab-private",
    );
    tab("private").focus();
    await press(tab("private"), "ArrowRight");
    expect(document.activeElement).toBe(tab("project"));
    expect(chosenTabs()).toEqual(["project"]);
    expect(heading()).toBe("shop");
    await press(tab("project"), "End");
    expect(document.activeElement).toBe(tab("team"));
    expect(chosenTabs()).toEqual(["team"]);
    await press(tab("team"), "ArrowRight");
    expect(document.activeElement).toBe(tab("private"));
    await press(tab("private"), "ArrowLeft");
    expect(chosenTabs()).toEqual(["team"]);
    await press(tab("team"), "Home");
    expect(chosenTabs()).toEqual(["private"]);
    expect(tab("private").title).toBe(`${t("notes.scopeGeneralTip")}\nStrg+1`);
  });

  it("show the Team level as one calm sentence, nothing read only and no new note", async () => {
    withProjects();
    await render(look);
    await click(tab("team"));
    expect(container.querySelector(".team-level")?.textContent).toContain(t("team.needsHangar"));
    expect(container.querySelector(".ro-chip")).toBeNull();
    expect(container.querySelector('input[type="search"]')).toBeNull();
    expect(container.querySelector('[data-focus-id="new"]')).toBeNull();
    expect(container.textContent).not.toContain(t("notes.readOnlyChip"));
    // Ctrl+Shift+N has nowhere to write in Team: no draft opens.
    await pressWindow("N", { code: "KeyN", ctrlKey: true, shiftKey: true });
    expect(container.querySelector(".cm-content")).toBeNull();
    expect(chosenTabs()).toEqual(["team"]);
  });

  it("write a new note into the level shown, with the cursor in the text", async () => {
    withProjects();
    await render(look);
    expect(container.querySelector(".ro-chip")).toBeNull();
    const create = container.querySelector<HTMLButtonElement>('[data-focus-id="new"]');
    expect(create?.disabled).toBe(false);
    await click(button(t("notes.new")));
    await frames();
    expect(document.activeElement?.classList.contains("cm-content")).toBe(true);
    await type("Privat notiert");
    expect(api.createNote).toHaveBeenLastCalledWith(GENERAL, "Notiz");
    // The tab is reachable with the note open; the next new note saves this one first.
    await click(tab("project"));
    await click(button(t("notes.new")));
    await frames();
    expect(document.activeElement?.classList.contains("cm-content")).toBe(true);
    await type("Im Projekt");
    expect(api.createNote).toHaveBeenLastCalledWith({ path: SHOP }, "Notiz");
    expect(api.writeNote).toHaveBeenCalled();
  });

  it("start a quick note with Ctrl+Shift+N in the level shown", async () => {
    withProjects();
    await render(look);
    await click(tab("project"));
    await pressWindow("N", { code: "KeyN", ctrlKey: true, shiftKey: true });
    await type("Schnell");
    expect(api.createNote).toHaveBeenLastCalledWith({ path: SHOP }, "Notiz");
  });
});

describe("notes area: the project of the Project level", () => {
  it("is the folder Hangar opened it for, before the last one shown", async () => {
    withTwoProjects();
    stored = { lastProject: SHOP };
    api.getStatus.mockResolvedValue({ ...writable, project: WEB });
    api.takeHubRequests.mockResolvedValue([{ kind: "showProject" }]);
    await render();
    expect(chosenTabs()).toEqual(["project"]);
    expect(projectTabLabel()).toBe(t("level.projectNamed", { name: "hangar.feoren.com" }));
    expect(tab("project").title).toBe(`${WEB}\nStrg+2`);
    expect(api.setLastProject).toHaveBeenLastCalledWith(WEB);
  });

  it("is the last one shown without a folder, before the newest", async () => {
    withTwoProjects();
    stored = { lastProject: SHOP };
    await render();
    expect(projectTabLabel()).toBe(t("level.projectNamed", { name: "shop" }));
  });

  it("is the project with the newest note without either", async () => {
    withTwoProjects();
    await render();
    expect(projectTabLabel()).toBe(t("level.projectNamed", { name: "hangar.feoren.com" }));
  });

  it("says how to get one while there is no project at all, without a new note", async () => {
    api.listNoteFolders.mockResolvedValue([
      { folderKey: "general", path: null, name: null, noteCount: 2, updatedAt: 3 },
    ]);
    await render();
    await click(tab("project"));
    expect(projectTabLabel()).toBe(t("level.project"));
    expect(tab("project").getAttribute("aria-haspopup")).toBeNull();
    expect(container.textContent).toContain(t("level.noProject"));
    expect(container.querySelector<HTMLButtonElement>('[data-focus-id="new"]')?.disabled).toBe(
      true,
    );
  });

  it("switches from the tab's menu, by mouse and keyboard, and remembers the choice", async () => {
    withTwoProjects();
    await render();
    await click(tab("project"));
    expect(heading()).toBe("hangar.feoren.com");
    expect(tab("project").getAttribute("aria-haspopup")).toBe("menu");
    expect(tab("project").getAttribute("aria-expanded")).toBe("false");
    // A click on the chosen tab opens the menu; the project shown is checked.
    await click(tab("project"));
    expect(tab("project").getAttribute("aria-expanded")).toBe("true");
    const radios = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.popup-menu [role="menuitemradio"]'),
    );
    expect(radios.map((item) => item.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    await click(menuItem("shop"));
    expect(heading()).toBe("shop");
    expect(projectTabLabel()).toBe(t("level.projectNamed", { name: "shop" }));
    expect(titles()).toEqual(["Kunden"]);
    expect(api.setLastProject).toHaveBeenLastCalledWith(SHOP);
    // Down on the tab opens it as well.
    await press(tab("project"), "ArrowDown");
    expect(tab("project").getAttribute("aria-expanded")).toBe("true");
    await click(menuItem("hangar.feoren.com"));
    expect(heading()).toBe("hangar.feoren.com");
  });

  it("follows a folder Hangar forwards while the app runs", async () => {
    withTwoProjects();
    await render();
    await click(tab("project"));
    await click(tab("project"));
    await click(menuItem("shop"));
    expect(heading()).toBe("shop");
    api.getStatus.mockResolvedValue({ ...writable, project: WEB });
    api.takeHubRequests.mockResolvedValue([{ kind: "showProject" }]);
    await act(async () => {
      api.handlers.get("hub-requests")?.();
      await Promise.resolve();
    });
    await settle();
    expect(chosenTabs()).toEqual(["project"]);
    expect(heading()).toBe("hangar.feoren.com");
    expect(api.setLastProject).toHaveBeenLastCalledWith(WEB);
  });
});
