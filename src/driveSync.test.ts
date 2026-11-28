// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import {
  DRIVE_SYNC_PHASES,
  DRIVE_SYNC_REASONS,
  NO_DRIVE_SYNC,
  parseDriveSyncView,
  type DriveSyncView,
} from "./api";
import { driveSyncText, driveSyncTone, isNoteSynced, useDriveSync } from "./driveSync";
import { DICTIONARIES, LANGUAGES, translate } from "./i18n";

/** The fake backend: the pending first answer, the event handler, how often it was let go. */
interface FakeBackend {
  answer: ((view: unknown) => void) | null;
  fail: (() => void) | null;
  handler: ((view: DriveSyncView) => void) | null;
  unlistened: number;
}

const backend = vi.hoisted((): FakeBackend => ({
  answer: null,
  fail: null,
  handler: null,
  unlistened: 0,
}));

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  getDriveSyncStatus: vi.fn(
    () =>
      new Promise((resolve, reject) => {
        backend.answer = resolve;
        backend.fail = () => {
          reject(new Error("no backend"));
        };
      }),
  ),
  onDriveSyncChanged: vi.fn((handler: (view: DriveSyncView) => void) => {
    backend.handler = handler;
    return Promise.resolve(() => {
      backend.unlistened += 1;
    });
  }),
}));

const NOTE = "1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5";
const PROJECT = "0123456789abcdef0123456789abcdef";

describe("parseDriveSyncView", () => {
  it("takes a well-formed view as it is", () => {
    expect(
      parseDriveSyncView({
        phase: "active",
        folderName: "Hangar Note",
        lastSyncMs: 1_764_240_000_000,
        synced: { general: [NOTE], [PROJECT]: ["b"] },
      }),
    ).toEqual({
      phase: "active",
      folderName: "Hangar Note",
      lastSyncMs: 1_764_240_000_000,
      synced: { general: [NOTE], [PROJECT]: ["b"] },
    });
    expect(parseDriveSyncView({ phase: "waiting", reason: "hangarTooOld", synced: {} })).toEqual({
      phase: "waiting",
      reason: "hangarTooOld",
      synced: {},
    });
  });

  it("knows every phase and reason of the backend", () => {
    for (const phase of DRIVE_SYNC_PHASES) {
      expect(parseDriveSyncView({ phase, synced: {} }).phase).toBe(phase);
    }
    for (const reason of DRIVE_SYNC_REASONS) {
      expect(parseDriveSyncView({ phase: "unavailable", reason, synced: {} }).reason).toBe(reason);
    }
  });

  it("reads an unknown phase as absent and leaves an unknown reason out", () => {
    expect(parseDriveSyncView({ phase: "syncing", synced: { general: [NOTE] } }).phase).toBe(
      "absent",
    );
    const view = parseDriveSyncView({ phase: "unavailable", reason: "tooBig", synced: {} });
    expect(view.phase).toBe("unavailable");
    expect("reason" in view).toBe(false);
  });

  it("gives no Hangar Drive for anything that is not a view", () => {
    for (const value of [null, undefined, "active", 3, [], true]) {
      expect(parseDriveSyncView(value)).toEqual(NO_DRIVE_SYNC);
    }
  });

  it("drops malformed fields and ids instead of failing", () => {
    const view = parseDriveSyncView({
      phase: "active",
      folderName: "   ",
      lastSyncMs: Number.NaN,
      synced: { general: [NOTE, 5, "", null], [PROJECT]: "b", other: [], list: [{}] },
    });
    expect(view).toEqual({ phase: "active", synced: { general: [NOTE] } });
    expect(parseDriveSyncView({ phase: "active", synced: [NOTE] }).synced).toEqual({});
    expect(parseDriveSyncView({ phase: "active" }).synced).toEqual({});
    expect(parseDriveSyncView({ phase: "active", lastSyncMs: -1, synced: {} }).lastSyncMs).toBe(
      undefined,
    );
    expect(parseDriveSyncView({ phase: "active", lastSyncMs: "1", synced: {} }).lastSyncMs).toBe(
      undefined,
    );
  });
});

describe("isNoteSynced", () => {
  const active: DriveSyncView = parseDriveSyncView({
    phase: "active",
    synced: { general: [NOTE], [PROJECT]: ["b"] },
  });

  it("finds a note only under its own folder key", () => {
    expect(isNoteSynced(active, "general", NOTE)).toBe(true);
    expect(isNoteSynced(active, PROJECT, "b")).toBe(true);
    expect(isNoteSynced(active, PROJECT, NOTE)).toBe(false);
    expect(isNoteSynced(active, "general", "b")).toBe(false);
  });

  it("finds nothing for a new note, an inherited key or an inactive sync", () => {
    expect(isNoteSynced(active, null, NOTE)).toBe(false);
    expect(isNoteSynced(active, "general", null)).toBe(false);
    expect(isNoteSynced(active, "constructor", "length")).toBe(false);
    expect(isNoteSynced(active, "__proto__", NOTE)).toBe(false);
    for (const phase of DRIVE_SYNC_PHASES.filter((p) => p !== "active")) {
      expect(isNoteSynced({ ...active, phase }, "general", NOTE), phase).toBe(false);
    }
  });
});

describe("driveSyncText", () => {
  const view = (phase: DriveSyncView["phase"], reason?: DriveSyncView["reason"]): DriveSyncView =>
    reason === undefined ? { phase, synced: {} } : { phase, reason, synced: {} };

  it("gives no sentence without Hangar Drive, so the section stays away", () => {
    expect(driveSyncText(view("absent"))).toBeNull();
  });

  it("gives each phase its sentence", () => {
    expect(driveSyncText(view("notRunning"))).toBe("drive.notRunning");
    expect(driveSyncText(view("setup"))).toBe("drive.setup");
    expect(driveSyncText(view("asked"))).toBe("drive.asked");
    expect(driveSyncText(view("active"))).toBe("drive.active");
    expect(driveSyncText(view("declined"))).toBe("drive.declined");
    expect(driveSyncText(view("attention"))).toBe("drive.attention");
    expect(driveSyncText(view("waiting"))).toBe("drive.waiting");
    expect(driveSyncText(view("unavailable"))).toBe("drive.unavailable");
  });

  it("tells waiting and unavailable by their reason", () => {
    expect(driveSyncText(view("waiting", "missing"))).toBe("drive.waitingForFolder");
    expect(driveSyncText(view("unavailable", "missing"))).toBe("drive.folderMissing");
    for (const phase of ["waiting", "unavailable"] as const) {
      expect(driveSyncText(view(phase, "refused"))).toBe("drive.refused");
      expect(driveSyncText(view(phase, "hangarTooOld"))).toBe("drive.hangarTooOld");
    }
  });

  it("has a short sentence for every state in every language", () => {
    const states = DRIVE_SYNC_PHASES.flatMap((phase) => [
      view(phase),
      ...DRIVE_SYNC_REASONS.map((reason) => view(phase, reason)),
    ]);
    for (const state of states) {
      const key = driveSyncText(state);
      if (key === null) continue;
      for (const language of LANGUAGES) {
        const text = DICTIONARIES[language][key];
        expect(text.trim(), `${language} ${key}`).not.toBe("");
        expect(text.length, `${language} ${key}`).toBeLessThanOrEqual(160);
      }
    }
  });

  it("reads as agreed in German", () => {
    expect(translate("de", "drive.synced")).toBe("Auf deinem Server");
    expect(translate("de", "drive.active")).toBe(
      "Deine Notizen werden mit Hangar Drive synchronisiert.",
    );
    expect(translate("de", "drive.asked")).toBe(
      "Bestätige in Hangar Drive, dass deine Notizen synchronisiert werden sollen.",
    );
    expect(translate("de", "drive.hangarTooOld")).toBe(
      "Aktualisiere Hangar, damit deine Notizen synchronisiert werden können.",
    );
    expect(translate("de", "drive.lastSync", { time: "vor 5 Minuten" })).toBe(
      "Zuletzt synchronisiert: vor 5 Minuten",
    );
  });
});

describe("driveSyncTone", () => {
  it("marks the active sync as done and the two dead ends as problems", () => {
    expect(driveSyncTone({ phase: "active", synced: {} })).toBe("synced");
    expect(driveSyncTone({ phase: "attention", synced: {} })).toBe("problem");
    expect(driveSyncTone({ phase: "unavailable", synced: {} })).toBe("problem");
    for (const phase of ["notRunning", "setup", "waiting", "asked", "declined"] as const) {
      expect(driveSyncTone({ phase, synced: {} }), phase).toBe("info");
    }
  });
});

describe("useDriveSync", () => {
  /** Renders a component that shows the phase it gets; answers how to read and end it. */
  async function mount() {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    const root = createRoot(host);
    function Phase() {
      return createElement("span", null, useDriveSync().phase);
    }
    await act(async () => {
      root.render(createElement(Phase));
      await Promise.resolve();
    });
    return {
      phase: () => host.textContent,
      unmount: () => {
        act(() => {
          root.unmount();
        });
      },
    };
  }

  async function flush() {
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
  }

  it("shows the backend's answer, then follows its events", async () => {
    const shown = await mount();
    expect(shown.phase()).toBe("absent");
    backend.answer?.({ phase: "asked", synced: {} });
    await flush();
    expect(shown.phase()).toBe("asked");
    await act(async () => {
      backend.handler?.({ phase: "active", synced: {} });
      await Promise.resolve();
    });
    expect(shown.phase()).toBe("active");
    shown.unmount();
    await flush();
    expect(backend.unlistened).toBeGreaterThan(0);
  });

  it("keeps an event that came before the first answer", async () => {
    const shown = await mount();
    await act(async () => {
      backend.handler?.({ phase: "active", synced: {} });
      await Promise.resolve();
    });
    backend.answer?.({ phase: "setup", synced: {} });
    await flush();
    expect(shown.phase()).toBe("active");
    shown.unmount();
  });

  it("stays absent without a backend", async () => {
    const shown = await mount();
    backend.fail?.();
    await flush();
    expect(shown.phase()).toBe("absent");
    shown.unmount();
  });
});
