// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HubRequest, NoteRow, OpenedNote, Status } from "./api";
import type { AppSettings } from "./appSettings";
import type { EditorOptions } from "./editor";
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
}));

vi.mock("./api", () => ({
  MAX_NOTE_BYTES: 1024 * 1024,
  utf8Bytes: (text: string) => new TextEncoder().encode(text).length,
  errorText: (error: unknown) => String(error),
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
  restoreNote: vi.fn(),
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
  onHubRequests: vi.fn(() => Promise.resolve(() => undefined)),
  onFlushRequested: vi.fn((label: string, handler: () => void) => {
    api.handlers.set(`flush:${label}`, handler);
    return Promise.resolve(() => undefined);
  }),
  windowReady: vi.fn(() => Promise.resolve(null)),
  setSettings: vi.fn(),
  setAutostart: vi.fn(),
}));

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
const app: AppSettings = {
  settings: {
    language: "de",
    theme: "light",
    newNoteColor: "mint",
    colorNames: { sky: "Arbeit" },
    autostart: false,
  },
  theme: "light",
  language: "de",
  t,
  applySaved: () => undefined,
  applyAutostart: () => undefined,
};

let root: Root;
let container: HTMLDivElement;

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

async function render() {
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

function titles(): string[] {
  return Array.from(container.querySelectorAll(".note-row-title")).map((e) => e.textContent);
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
  api.writeNote.mockResolvedValue(null);
  api.renameNote.mockResolvedValue(null);
  api.deleteNote.mockResolvedValue(null);
  api.fromDesktop.mockResolvedValue(null);
  api.toDesktop.mockResolvedValue(null);
  api.noteFlushed.mockResolvedValue(null);
  api.createNote.mockResolvedValue(opened(A, "Notiz 1", { autoTitled: true, text: "" }));
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
    const sky = button("Arbeit");
    await click(sky);
    expect(titles()).toEqual(["Projekt"]);
    await click(button(t("color.mint")));
    expect(titles()).toEqual(["Einkaufen", "Projekt"]);
    await click(button(t("notes.colorFilterClear")));
    expect(titles()).toEqual(["Einkaufen", "Projekt"]);
    expect(container.querySelectorAll(".color-chip.on")).toHaveLength(0);
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
    expect(api.writeNote).toHaveBeenCalledWith(GENERAL, A, "# Einkaufsliste\n- Milch");
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
