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
  setHubOnTop: vi.fn(),
  copyText: vi.fn(),
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
  onHubRequests: vi.fn((handler: () => void) => {
    api.handlers.set("hub-requests", handler);
    return Promise.resolve(() => undefined);
  }),
  onFlushRequested: vi.fn((label: string, handler: () => void) => {
    api.handlers.set(`flush:${label}`, handler);
    return Promise.resolve(() => undefined);
  }),
  windowReady: vi.fn(() => Promise.resolve(null)),
  setSettings: vi.fn(),
  setAutostart: vi.fn(),
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
  api.setHubOnTop.mockImplementation((onTop: boolean) => Promise.resolve(onTop));
  api.copyText.mockResolvedValue(true);
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

describe("notes area: capture and quick note", () => {
  it("says a capture was saved only once its note exists, titled after its source", async () => {
    api.takeHubRequests.mockResolvedValue([capture]);
    await render();
    expect(api.createNote).toHaveBeenCalledTimes(1);
    const written = String(api.writeNote.mock.calls[0]?.[2]);
    expect(written).toMatch(/^_Aus Demo Projekt, /);
    expect(container.textContent).toContain(t("notes.capturedNew"));
  });

  it("does not claim a capture was saved when creating its note failed", async () => {
    api.takeHubRequests.mockResolvedValue([capture]);
    api.createNote.mockRejectedValue("disk full");
    await render();
    expect(container.textContent).not.toContain(t("notes.capturedNew"));
    expect(container.textContent).toContain(t("notes.heldHint"));
  });

  it("keeps a capture in a draft to copy while the notes are read only", async () => {
    api.getStatus.mockResolvedValue(readOnly);
    api.takeHubRequests.mockResolvedValue([capture]);
    await render();
    expect(api.createNote).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain(t("notes.capturedNew"));
    expect(container.textContent).toContain(t("notes.heldHint"));
    expect(editor.text).toContain("Ausgabe");
    await click(button(t("notes.copyMarkdown")));
    expect(api.copyText).toHaveBeenCalledWith(editor.text);
    expect(container.textContent).toContain(t("notes.copied"));
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
    api.writeNote.mockResolvedValue(null);
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
    api.writeNote.mockResolvedValue(null);
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
    await click(button(t("notes.more")));
    const trash = Array.from(container.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (element) => element.textContent.includes(t("notes.trash")),
    );
    if (!trash) throw new Error("trash item missing");
    await click(trash);
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
    expect(api.writeNote).toHaveBeenLastCalledWith(GENERAL, A, "Einkaufen\nneu\nmehr");
  });
});

describe("notes area: list", () => {
  it("shows All on a start without a project, and new notes still go to General", async () => {
    await render();
    const on = container.querySelector('.chip[aria-pressed="true"]');
    expect(on?.textContent).toBe(t("notes.scopeAll"));
    await click(button(t("notes.new")));
    await type("Neu");
    expect(api.createNote).toHaveBeenCalledWith(GENERAL, "Notiz");
  });

  it("switches the window on top from the list menu", async () => {
    await render();
    await click(button(t("notes.more")));
    const item = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]'),
    ).find((element) => element.textContent.includes(t("note.keepOnTop")));
    expect(item?.getAttribute("aria-checked")).toBe("false");
    if (!item) throw new Error("on-top switch missing");
    await click(item);
    expect(api.setHubOnTop).toHaveBeenCalledWith(true);
    await click(button(t("notes.more")));
    const again = container.querySelector('[role="menuitemcheckbox"]');
    expect(again?.getAttribute("aria-checked")).toBe("true");
  });

  it("offers On the desktop once, in the note's footer", async () => {
    await render();
    await click(rowButton("Einkaufen"));
    expect(container.querySelector(".note-footer")?.textContent).toContain(t("notes.toDesktop"));
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
