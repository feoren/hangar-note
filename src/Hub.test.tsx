// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NoteSummary } from "./api";
import type { AppSettings } from "./appSettings";
import { createTranslator, I18nContext } from "./i18n";

const notes: NoteSummary[] = [
  {
    id: "1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5",
    color: "lemon",
    bounds: null,
    open: true,
    onTop: false,
    createdAt: 1,
    updatedAt: 2,
    preview: "Einkaufen\n- [ ] Milch\n- [ ] Brot",
  },
  {
    id: "0b7f6a0e-3c1d-4c5e-9a8b-1f2e3d4c5b6a",
    color: "sky",
    bounds: null,
    open: false,
    onTop: false,
    createdAt: 1,
    updatedAt: 1,
    preview: "Ideen für das Wochenende",
  },
];

const api = vi.hoisted(() => ({
  listNotes: vi.fn(),
  deleteNote: vi.fn(),
  restoreNote: vi.fn(),
  openNote: vi.fn(),
}));

vi.mock("./api", () => ({
  listNotes: api.listNotes,
  deleteNote: api.deleteNote,
  restoreNote: api.restoreNote,
  openNote: api.openNote,
  isNotSaved: (error: unknown) => error === "not-saved",
  createNote: vi.fn(() => Promise.resolve()),
  listTrash: vi.fn(() => Promise.resolve([])),
  onNotesChanged: vi.fn(() => Promise.resolve(() => undefined)),
  setAutostart: vi.fn(),
  setSettings: vi.fn(),
  windowReady: vi.fn(() => Promise.resolve(null)),
}));

const { Hub } = await import("./Hub");

const t = createTranslator("de");
const app: AppSettings = {
  settings: { language: "de", theme: "light", newNoteColor: "lemon", autostart: false },
  theme: "light",
  language: "de",
  t,
  applySaved: () => undefined,
  applyAutostart: () => undefined,
};

let root: Root;
let container: HTMLDivElement;

async function render() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nContext.Provider value={t}>
        <Hub app={app} />
      </I18nContext.Provider>,
    );
    await Promise.resolve();
  });
}

function titles(): string[] {
  return Array.from(container.querySelectorAll(".card-title"), (el) => el.textContent);
}

/** Types like a person: through the prototype's setter, which React's change tracking sees. */
function type(input: HTMLInputElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  api.listNotes.mockResolvedValue(notes);
  api.deleteNote.mockResolvedValue({});
  api.restoreNote.mockResolvedValue({});
  api.openNote.mockResolvedValue(null);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.clearAllMocks();
});

describe("All notes", () => {
  it("shows every note as a card titled by its first line", async () => {
    await render();
    expect(titles()).toEqual(["Einkaufen", "Ideen für das Wochenende"]);
    expect(container.textContent).toContain("Milch · Brot");
  });

  it("filters the cards by the search field", async () => {
    await render();
    const search = container.querySelector<HTMLInputElement>("input[type=search]");
    expect(search).not.toBeNull();
    if (!search) return;
    await act(async () => {
      type(search, "brot");
      await Promise.resolve();
    });
    expect(titles()).toEqual(["Einkaufen"]);
    await act(async () => {
      type(search, "urlaub");
      await Promise.resolve();
    });
    expect(titles()).toEqual([]);
    expect(container.textContent).toContain("Keine Notiz enthält „urlaub“.");
  });

  it("deletes with Undo, which restores and reopens an open note", async () => {
    await render();
    const card = container.querySelector<HTMLButtonElement>(".card-open");
    await act(async () => {
      card?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
      await Promise.resolve();
    });
    expect(api.deleteNote).toHaveBeenCalledWith(notes[0]?.id);
    const undo = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Rückgängig",
    );
    expect(undo).toBeDefined();
    await act(async () => {
      undo?.click();
      await Promise.resolve();
    });
    expect(api.restoreNote).toHaveBeenCalledWith(notes[0]?.id);
    expect(api.openNote).toHaveBeenCalledWith(notes[0]?.id);
  });

  it("says why an open note that could not save was not deleted", async () => {
    api.deleteNote.mockRejectedValue("not-saved");
    await render();
    const card = container.querySelector<HTMLButtonElement>(".card-open");
    await act(async () => {
      card?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
      await Promise.resolve();
    });
    expect(container.querySelector("[role=alert]")?.textContent).toBe(t("hub.notSaved"));
    expect(container.textContent).not.toContain("Rückgängig");
  });

  it("works the card menu with the keyboard and gives the focus back on Escape", async () => {
    await render();
    const more = container.querySelector<HTMLButtonElement>(".card-more");
    await act(async () => {
      more?.click();
      await Promise.resolve();
    });
    const menu = container.querySelector<HTMLElement>("[role=menu]");
    expect(menu).not.toBeNull();
    if (!menu || !more) return;
    const items = Array.from(menu.querySelectorAll("[role=menuitem]"));
    const focused = () => items.indexOf(document.activeElement ?? document.body);
    const press = async (key: string) => {
      await act(async () => {
        (document.activeElement ?? menu).dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
        );
        await Promise.resolve();
      });
    };
    expect(focused()).toBe(0);
    await press("ArrowDown");
    expect(focused()).toBe(1);
    await press("ArrowDown");
    expect(focused()).toBe(0);
    await press("ArrowUp");
    expect(focused()).toBe(1);
    await press("Home");
    expect(focused()).toBe(0);
    await press("End");
    expect(focused()).toBe(1);
    await press("Escape");
    expect(container.querySelector("[role=menu]")).toBeNull();
    expect(document.activeElement).toBe(more);
  });
});
