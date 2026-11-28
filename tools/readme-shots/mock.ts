// In-memory stand-in for the Tauri backend, used only for the README screenshots. It answers the
// IPC calls the frontend makes (src/api.ts and the window label main.tsx reads) with a fictional
// set of notes: private notes, the notes of three project folders and, in the scenes that show
// it, Hangar Drive syncing most of them. The driver (run.mjs) picks what each screenshot shows by
// clicking through the real frontend. Nothing here talks to a real process, file or network, and
// every name in it is made up.

import type {
  DriveSyncView,
  FolderInfo,
  NoteRow,
  OpenedNote,
  Settings,
  SettingsView,
  Status,
} from "../../src/api";
import type { NoteColor } from "../../src/colors";

interface ReadmeShotsControl {
  /** Set by the driver right before the screenshot: the clock stands still. */
  freeze: boolean;
}

declare global {
  interface Window {
    __readmeShots: ReadmeShotsControl;
    __TAURI_INTERNALS__: unknown;
  }
}

type Args = Record<string, unknown>;

const control: ReadmeShotsControl = { freeze: false };
window.__readmeShots = control;

/** What run.mjs stored for the scene before the app starts. */
function stored(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

const SCENE = ((): string => {
  const value = stored("readmeShots.scene");
  return typeof value === "string" ? value : "overview";
})();
const LOOK = stored("readmeShots.look") === "paper" ? "paper" : "hangar";
/** The scenes that show Hangar Drive at work; in the others there is no Hangar Drive. */
const DRIVE = SCENE === "drive" || SCENE === "settings";
/** The sticky note's frame (sticky.html) loads the app with `?window=<label>`. */
const LABEL = new URLSearchParams(location.search).get("window") ?? "hub";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// A fixed clock, so every time the app shows ("5 min ago") is the same in each run: it starts at
// FIXED_START and stands at SHOT_TIME once the driver freezes the scene. `new Date()` without
// arguments reads the same clock; every other form and every static method stay real.
const FIXED_START = Date.UTC(2026, 10, 27, 14, 30, 0);
const SHOT_TIME = FIXED_START + 30_000;
const realNow = Date.now.bind(Date);
const clockOffset = FIXED_START - realNow();
Date.now = () => (control.freeze ? SHOT_TIME : Math.min(realNow() + clockOffset, SHOT_TIME));
window.Date = new Proxy(Date, {
  construct(target, args: unknown[], newTarget) {
    return Reflect.construct(target, args.length === 0 ? [Date.now()] : args, newTarget);
  },
});

/** A moment `ms` before the screenshot. */
const ago = (ms: number) => SHOT_TIME - ms;

// ---- The notes ---------------------------------------------------------------------------------

const GENERAL_KEY = "general";
const ATLAS_WEB = "C:\\src\\atlas-web";
const ATLAS_API = "C:\\src\\atlas-api";
const ORBIT_DOCS = "C:\\src\\orbit-docs";
/** Folder keys as the backend names them: 32 hex digits per working folder. */
const FOLDER_KEYS: Readonly<Record<string, string>> = {
  [ATLAS_WEB]: "3f2a9c1e7b4d4e0f8a6c5b2d1e9f7a30",
  [ATLAS_API]: "8c1d2e3f4a5b4c6d9e7f0a1b2c3d4e51",
  [ORBIT_DOCS]: "b7e6d5c4a3f24e1d8c0b9a8f7e6d5c42",
};

interface MockNote {
  id: string;
  title: string;
  color: NoteColor;
  updatedAt: number;
  text: string;
  onDesktop?: boolean;
}

const lines = (...rows: string[]) => rows.join("\n");

const RELEASE_CHECKLIST = lines(
  "# Release checklist",
  "",
  "Version **2.4.0** of atlas-web, planned for Friday morning.",
  "",
  "## Before the release",
  "",
  "- [x] Freeze the main branch",
  "- [x] Update the changelog",
  "- [x] Run the full test suite",
  "- [ ] Check the staging deploy",
  "- [ ] Tag the release",
  "",
  "## After the release",
  "",
  "- Announce it in the team channel",
  "- Watch the error rate for an hour",
  "- Close the milestone",
  "",
  "> Roll back with `deploy --previous` if the error rate doubles.",
);

const PRIVATE: MockNote[] = [
  {
    id: "a1b2c3d4e5f6",
    title: "Release checklist",
    color: "lemon",
    updatedAt: ago(4 * MINUTE),
    text: RELEASE_CHECKLIST,
  },
  {
    id: "b2c3d4e5f6a1",
    title: "API ideas",
    color: "sky",
    updatedAt: ago(48 * MINUTE),
    text: lines(
      "# API ideas",
      "",
      "- Cursor based paging for `/v2/orders`",
      "- A `dryRun` flag on every write",
      "- Webhooks with signed payloads",
      "- Rate limits per token, not per address",
    ),
  },
  {
    id: "c3d4e5f6a1b2",
    title: "Weekly sync",
    color: "mint",
    updatedAt: ago(3 * HOUR),
    text: lines(
      "# Weekly sync",
      "",
      "Search is twice as fast since the new index.",
      "",
      "- [x] Share the load test results",
      "- [ ] Plan the onboarding flow",
    ),
  },
  {
    id: "d4e5f6a1b2c3",
    title: "Reading list",
    color: "lilac",
    updatedAt: ago(DAY + 2 * HOUR),
    text: lines(
      "# Reading list",
      "",
      "- Designing Data-Intensive Applications",
      "- The Art of Unix Programming",
      "- Refactoring, second edition",
    ),
  },
  {
    id: "e5f6a1b2c3d4",
    title: "Trip to the coast",
    color: "peach",
    updatedAt: ago(2 * DAY),
    text: lines(
      "# Trip to the coast",
      "",
      "- [x] Book the train",
      "- [ ] Pack the rain jacket",
      "- [ ] Find a place for dinner",
    ),
    onDesktop: true,
  },
  {
    id: "f6a1b2c3d4e5",
    title: "Shell snippets",
    color: "slate",
    updatedAt: ago(5 * DAY),
    text: lines(
      "# Shell snippets",
      "",
      "Find large files: `du -ah . | sort -rh | head -20`",
      "",
      "Clean merged branches: `git branch --merged | grep -v main`",
    ),
  },
  {
    id: "a6b5c4d3e2f1",
    title: "Gift ideas",
    color: "rose",
    updatedAt: ago(9 * DAY),
    text: lines("# Gift ideas", "", "- A good notebook", "- Concert tickets", "- A plant"),
  },
];

const PROJECT_NOTES: Readonly<Record<string, MockNote[]>> = {
  [ATLAS_WEB]: [
    {
      id: "aa11bb22cc33",
      title: "Deploy steps",
      color: "mint",
      updatedAt: ago(12 * MINUTE),
      text: lines(
        "# Deploy steps",
        "",
        "1. `pnpm build` on a clean checkout",
        "2. Upload the bundle to staging",
        "3. Smoke test the checkout flow",
        "4. Promote staging to production",
        "",
        "## Checks",
        "",
        "- [x] Cache headers on the assets",
        "- [x] Source maps stay private",
        "- [ ] Error tracking gets the release",
        "",
        "Keep the previous bundle for a quick rollback.",
      ),
    },
    {
      id: "bb22cc33dd44",
      title: "Bug triage",
      color: "rose",
      updatedAt: ago(2 * HOUR),
      text: lines(
        "# Bug triage",
        "",
        "- [ ] Date picker jumps a month",
        "- [ ] Avatar upload fails over 5 MB",
        "- [x] Footer overlaps on small phones",
      ),
    },
    {
      id: "cc33dd44ee55",
      title: "Design review",
      color: "sky",
      updatedAt: ago(DAY + 5 * HOUR),
      text: lines(
        "# Design review",
        "",
        "Fewer colors in the dashboard, one accent only.",
        "Larger touch targets in the settings.",
      ),
    },
    {
      id: "dd44ee55ff66",
      title: "Performance budget",
      color: "sand",
      updatedAt: ago(3 * DAY),
      text: lines(
        "# Performance budget",
        "",
        "- Script under 170 KB compressed",
        "- First paint under 1.2 s on a mid phone",
      ),
    },
  ],
  [ATLAS_API]: [
    {
      id: "ee55ff66aa77",
      title: "Schema changes",
      color: "lilac",
      updatedAt: ago(6 * HOUR),
      text: lines(
        "# Schema changes",
        "",
        "- Add an `archived` flag to orders",
        "- Index on `email`",
      ),
    },
    {
      id: "ff66aa77bb88",
      title: "Load test notes",
      color: "slate",
      updatedAt: ago(4 * DAY),
      text: lines("# Load test notes", "", "2,000 requests per second hold at p99 under 80 ms."),
    },
  ],
  [ORBIT_DOCS]: [
    {
      id: "a7b8c9d0e1f2",
      title: "Outline",
      color: "peach",
      updatedAt: ago(7 * DAY),
      text: lines("# Outline", "", "1. Getting started", "2. Guides", "3. Reference"),
    },
  ],
};

/** The sticky note on the desktop: the trip with its checklist. */
const STICKY_NOTE = PRIVATE.find((note) => note.onDesktop === true);

function folderKeyOf(path: string | null): string {
  return path === null ? GENERAL_KEY : (FOLDER_KEYS[path] ?? GENERAL_KEY);
}

function notesOf(path: string | null): MockNote[] {
  return path === null ? PRIVATE : (PROJECT_NOTES[path] ?? []);
}

/** The folder a call names (`{ folder: { path } }`). */
function folderPath(args: Args): string | null {
  const folder = args.folder;
  if (typeof folder !== "object" || folder === null || !("path" in folder)) return null;
  return typeof folder.path === "string" ? folder.path : null;
}

function row(path: string | null, note: MockNote, order: number): NoteRow {
  return {
    folderKey: folderKeyOf(path),
    path,
    id: note.id,
    title: note.title,
    updatedAt: note.updatedAt,
    order,
    color: note.color,
    onDesktop: note.onDesktop === true,
    preview: note.text,
  };
}

function opened(path: string | null, note: MockNote): OpenedNote {
  return {
    folderKey: folderKeyOf(path),
    path,
    id: note.id,
    title: note.title,
    text: note.text,
    color: note.color,
    onDesktop: note.onDesktop === true,
    onTop: false,
    autoTitled: false,
    version: "v1",
  };
}

function folderInfo(path: string | null): FolderInfo {
  const notes = notesOf(path);
  return {
    folderKey: folderKeyOf(path),
    path,
    name: path === null ? null : (path.split("\\").pop() ?? path),
    noteCount: notes.length,
    updatedAt: Math.max(...notes.map((note) => note.updatedAt)),
  };
}

// ---- Settings and status -----------------------------------------------------------------------

const settings: SettingsView = {
  language: "en",
  theme: "system",
  newNoteColor: "lemon",
  colorNames: {},
  look: LOOK,
  autostart: false,
  hubOnTop: false,
  sidebarOpen: true,
  // A little wider than the default, so "Project folders" and the version stand whole.
  sidebarWidth: 248,
  listWidth: null,
  lastProject: null,
};

const status: Status = { access: { state: "writable" }, rootKind: "hangar", project: null };

/** Every note synced except the one on the desktop and the gift ideas, two minutes ago. */
function driveView(): DriveSyncView {
  const synced: Record<string, string[]> = {
    [GENERAL_KEY]: PRIVATE.filter((note) => note.onDesktop !== true && note.color !== "rose").map(
      (note) => note.id,
    ),
  };
  for (const [path, notes] of Object.entries(PROJECT_NOTES)) {
    synced[folderKeyOf(path)] = notes.map((note) => note.id);
  }
  return { phase: "active", folderName: "Notes", lastSyncMs: ago(2 * MINUTE), synced };
}

// ---- Commands ----------------------------------------------------------------------------------

const handlers: Record<string, (args: Args) => unknown> = {
  get_status: () => status,
  take_hub_requests: () => [],
  list_note_folders: () => [null, ATLAS_WEB, ATLAS_API, ORBIT_DOCS].map(folderInfo),
  list_notes: (args) => {
    const path = folderPath(args);
    return notesOf(path).map((note, index) => row(path, note, index));
  },
  search_notes: () => [],
  read_note: (args) => {
    const path = folderPath(args);
    const note = notesOf(path).find((each) => each.id === args.id);
    if (!note) throw new Error("not-found");
    return opened(path, note);
  },
  get_sticky: () => {
    if (!STICKY_NOTE) throw new Error("not-found");
    return opened(null, STICKY_NOTE);
  },
  // Nothing is ever written: a save answers a new version and changes nothing.
  write_note: () => "v2",
  write_sticky: () => "v2",
  list_trash: () => [],
  get_settings: () => settings,
  set_settings: (args) => {
    const value = args.value;
    if (typeof value === "object" && value !== null) Object.assign(settings, value);
    const saved: Settings = {
      language: settings.language,
      theme: settings.theme,
      newNoteColor: settings.newNoteColor,
      colorNames: settings.colorNames,
      look: settings.look,
    };
    return saved;
  },
  set_hub_on_top: (args) => args.onTop === true,
  set_sidebar_open: (args) => args.open !== false,
  set_sidebar_width: (args) => (typeof args.width === "number" ? args.width : 248),
  set_list_width: (args) => (typeof args.width === "number" ? args.width : null),
  set_last_project: (args) => (typeof args.folder === "string" ? args.folder : null),
  set_autostart: (args) => args.enabled === true,
  set_tray_labels: () => null,
  set_note_on_top: (args) => args.onTop === true,
  window_ready: () => null,
  note_flushed: () => null,
  drive_sync_status: () => {
    // Without Hangar Drive, as an older backend answers: the frontend shows nothing of it.
    if (!DRIVE) throw new Error("unknown command");
    return driveView();
  },
};

const callbacks = new Map<number, (value: unknown) => void>();
let nextCallback = 1;

function asArgs(value: unknown): Args {
  return typeof value === "object" && value !== null ? { ...value } : {};
}

window.__TAURI_INTERNALS__ = {
  metadata: {
    currentWindow: { label: LABEL },
    currentWebview: { label: LABEL, windowLabel: LABEL },
  },
  transformCallback(fn: (value: unknown) => void): number {
    const id = nextCallback++;
    callbacks.set(id, fn);
    return id;
  },
  unregisterCallback(id: number): void {
    callbacks.delete(id);
  },
  convertFileSrc: (path: string) => path,
  invoke(cmd: string, args: unknown): Promise<unknown> {
    // No scene sends an event: a listener only needs its id.
    if (cmd === "plugin:event|listen") return Promise.resolve(nextCallback++);
    if (cmd.startsWith("plugin:")) return Promise.resolve(null);
    const handler = handlers[cmd];
    if (!handler) {
      console.warn(`readme-shots: unmocked command ${cmd}`);
      return Promise.resolve(null);
    }
    try {
      return Promise.resolve(handler(asArgs(args)));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error.message : String(error));
    }
  },
};
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };

export {};
