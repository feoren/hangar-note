// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TrashRow } from "./api";
import { createTranslator, I18nContext } from "./i18n";

const api = vi.hoisted(() => ({ listTrash: vi.fn() }));
vi.mock("./api", () => ({ listTrash: api.listTrash }));

const { Trash } = await import("./Trash");

const t = createTranslator("de");
const deleted: TrashRow = {
  folderKey: "general",
  path: null,
  id: "1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5",
  title: "Einkaufen",
  deletedAt: 1,
  color: "mint",
};

let root: Root;
let container: HTMLDivElement;
const onBack = vi.fn();
const onRestore = vi.fn();

async function render(writable: boolean) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nContext.Provider value={t}>
        <Trash
          folders={[{ path: null }]}
          mixed={false}
          language="de"
          now={2}
          theme="light"
          writable={writable}
          projectLabel={() => "Allgemein"}
          onRestore={onRestore}
          onBack={onBack}
        />
      </I18nContext.Provider>,
    );
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

function button(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find(
    (element) => element.textContent === text,
  );
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  api.listTrash.mockResolvedValue([deleted]);
  onRestore.mockResolvedValue("restored-id");
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.clearAllMocks();
});

describe("trash", () => {
  it("restores a note and takes it off the list", async () => {
    await render(true);
    const restore = button(t("notes.restore"));
    expect(restore).toBeDefined();
    await act(async () => {
      restore?.click();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(onRestore).toHaveBeenCalledWith({ path: null }, deleted.id, "Einkaufen");
    expect(container.textContent).toContain(t("notes.trashEmpty"));
  });

  it("explains in read-only mode why nothing can be restored", async () => {
    await render(false);
    expect(container.textContent).toContain("Einkaufen");
    expect(container.textContent).toContain(t("notes.trashReadOnly"));
    expect(button(t("notes.restore"))).toBeUndefined();
  });

  it("offers to try again after a failed load", async () => {
    api.listTrash.mockRejectedValueOnce("broken");
    await render(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      t("notes.trashLoadFailed"),
    );
    await act(async () => {
      button(t("notes.retry"))?.click();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(api.listTrash).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Einkaufen");
    expect(container.textContent).not.toContain(t("notes.trashLoadFailed"));
  });

  it("says what an empty trash is for and leads back to the notes", async () => {
    api.listTrash.mockResolvedValue([]);
    await render(true);
    expect(container.textContent).toContain(t("notes.trashEmpty"));
    button(t("notes.backToNotes"))?.click();
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe("trash rows", () => {
  it("show the note's color as the list's 3 px edge and the time as the list says it", async () => {
    await render(true);
    const row = container.querySelector<HTMLElement>(".trash-row");
    expect(row?.style.getPropertyValue("--note-edge")).toBe("#2f8a5e");
    // The time reads like the list's ("jetzt"), not "Gelöscht: jetzt"; the full sentence stays for
    // screen readers and the tooltip.
    const time = row?.querySelector<HTMLElement>(".note-row-meta [aria-hidden='true']");
    expect(time?.textContent).toBe("jetzt");
    expect(row?.querySelector(".sr-only")?.textContent).toBe(
      t("notes.deletedAgo", { time: "jetzt" }),
    );
  });
});
