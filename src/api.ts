// Typed wrappers around the backend commands (src-tauri/src/commands.rs). The frontend has no
// file system access: every note goes through these. Each window may only call the commands its
// capability grants (src-tauri/capabilities), and a sticky note only for its own note.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { NoteColor } from "./colors";
import type { Language, MessageKey } from "./i18n";
import type { Look } from "./looks";

/** A scope: a working folder (absolute) or `null` for "General". */
export interface NoteFolder {
  path: string | null;
}

export interface FolderInfo {
  folderKey: string;
  path: string | null;
  /** The folder's name (the last part of its path), `null` for General. */
  name: string | null;
  noteCount: number;
  updatedAt: number | null;
}

/** One row of the notes list (`NoteRow` in service.rs). */
export interface NoteRow {
  folderKey: string;
  path: string | null;
  id: string;
  title: string;
  updatedAt: number | null;
  order: number;
  color: NoteColor;
  onDesktop: boolean;
  /** The start of the content (at most 16 KiB). */
  preview: string;
}

export interface SearchHit {
  folderKey: string;
  path: string | null;
  id: string;
  title: string;
  excerpt: string;
  updatedAt: number | null;
  color: NoteColor;
  onDesktop: boolean;
}

/** A note with everything an editor needs (`OpenedNote` in service.rs). */
export interface OpenedNote {
  folderKey: string;
  path: string | null;
  id: string;
  title: string;
  text: string;
  color: NoteColor;
  onDesktop: boolean;
  onTop: boolean;
  /** The title still follows the first line. */
  autoTitled: boolean;
  /**
   * The state of the file as it was read. A save sends it back as `expected`; the backend refuses
   * the save with `changed` when the file was changed outside since.
   */
  version: string;
}

export interface TrashRow {
  folderKey: string;
  path: string | null;
  id: string;
  title: string;
  deletedAt: number | null;
  color: NoteColor;
}

export type Access =
  { state: "writable" } | { state: "readOnly"; reason: "otherWriter" | "lockFailed" };

export interface Status {
  access: Access;
  rootKind: "hangar" | "development";
  /** The folder "This project" stands for. */
  project: string | null;
}

/**
 * What the command line and Hangar ask of the notes area (`HubRequest` in requests.rs). A capture
 * over the channel arrives as `openNote`: the backend has written its note already, the notes
 * area only shows it. `capture` is left only for a text the backend could not store (a capture
 * that started the app while the notes are read only); the notes area holds it to be copied.
 */
export type HubRequest =
  | { kind: "showProject" }
  | { kind: "openNote"; folder: string | null; id: string }
  | { kind: "quick" }
  | { kind: "capture"; folder: string; text: string }
  | { kind: "sharedUnavailable" };

export type ThemeSetting = "system" | "light" | "dark";

export interface Settings {
  /** `null` follows the system language. */
  language: Language | null;
  theme: ThemeSetting;
  newNoteColor: NoteColor;
  /** The person's own names of the colors. */
  colorNames: Partial<Record<NoteColor, string>>;
  /** The look of every window (ADR 0004); the backend reads an unknown one as `hangar`. */
  look: Look;
}

export interface SettingsView extends Settings {
  /** Whether the app starts with the system (the OS state). */
  autostart: boolean;
  /**
   * Whether the notes area stays above other windows (`settings.json`). Optional: a backend
   * without the setting leaves it out, and the switch starts off.
   */
  hubOnTop?: boolean;
  /**
   * Whether the notes area's sidebar is shown in a wide window (`settings.json`, open by default).
   * Optional for the same reason: a backend without it leaves it out, and the sidebar is open.
   */
  sidebarOpen?: boolean;
  /** The sidebar's width in px as dragged (`settings.json`); left out by an older backend. */
  sidebarWidth?: number;
  /**
   * The width of hangar's note list in px as dragged (`settings.json`); `null` while none is
   * chosen (the list grows with the window), left out by an older backend.
   */
  listWidth?: number | null;
  /** The project the "Project" level showed last, `null` or left out without one. */
  lastProject?: string | null;
}

export interface TrayLabels {
  allNotes: string;
  newNote: string;
  showAll: string;
  quit: string;
  tooltip: string;
  untitled: string;
}

/** Events the backend sends (src-tauri/src/windows.rs). */
export const NOTES_CHANGED_EVENT = "notes-changed";
export const SETTINGS_CHANGED_EVENT = "settings-changed";
export const HUB_REQUESTS_EVENT = "hub-requests";
export const CLOSE_REQUESTED_EVENT = "note-close-requested";
export const DELETE_REQUESTED_EVENT = "note-delete-requested";
export const FLUSH_REQUESTED_EVENT = "note-flush-requested";
export const LOOK_CHANGED_EVENT = "note-look-changed";
/** To one sticky note: its file was changed outside (Hangar, another program). */
export const CHANGED_OUTSIDE_EVENT = "note-changed-outside";

/** Fixed error codes of the backend (windows.rs, notes.rs). */
export const NOT_SAVED_ERROR = "not-saved";
export const READ_ONLY_ERROR = "read-only";
export const ON_DESKTOP_ERROR = "on-desktop";
/** The file was changed outside since it was read (`expected` no longer matches). */
export const CHANGED_ERROR = "changed";

/** Fixed codes of the other command failures (windows.rs); errors.ts gives each its sentence. */
export const COMMAND_ERRORS = [
  "autostart",
  "clipboard",
  "window",
  "task",
  "not-a-path",
  "invalid-title",
  "invalid-id",
  CHANGED_ERROR,
  "not-open",
  "not-allowed",
  "invalid",
] as const;
export type CommandError = (typeof COMMAND_ERRORS)[number];

/** The command failure an error stands for, `null` for any other error. */
export function commandError(error: unknown): CommandError | null {
  return COMMAND_ERRORS.find((code) => code === error) ?? null;
}

export function isChanged(error: unknown): boolean {
  return error === CHANGED_ERROR;
}

export function isNotSaved(error: unknown): boolean {
  return error === NOT_SAVED_ERROR;
}

export function isReadOnly(error: unknown): boolean {
  return error === READ_ONLY_ERROR;
}

/**
 * Fixed codes of storage failures (`StorageCode` in fsio.rs). The backend sends only the code,
 * never the operating system's text or a path; those go to its log.
 */
export const STORAGE_ERRORS = ["denied", "disk-full", "too-large", "not-found", "io"] as const;
export type StorageError = (typeof STORAGE_ERRORS)[number];

/** The storage failure an error of a command stands for, `null` for any other error. */
export function storageError(error: unknown): StorageError | null {
  return STORAGE_ERRORS.find((code) => code === error) ?? null;
}

/** The sentence for each storage failure, in `i18n.ts`. */
export const STORAGE_ERROR_TEXTS: Readonly<Record<StorageError, MessageKey>> = {
  denied: "storage.denied",
  "disk-full": "storage.diskFull",
  "too-large": "storage.tooLarge",
  "not-found": "storage.notFound",
  io: "storage.io",
};

/** The text key for a storage failure, `null` for any other error. */
export function storageErrorText(error: unknown): MessageKey | null {
  const code = storageError(error);
  return code === null ? null : STORAGE_ERROR_TEXTS[code];
}

/** The backend's limit per note (`MAX_NOTE_BYTES` in notes.rs). */
export const MAX_NOTE_BYTES = 1024 * 1024;

export const getStatus = () => invoke<Status>("get_status");
export const takeHubRequests = () => invoke<HubRequest[]>("take_hub_requests");
export const listNoteFolders = () => invoke<FolderInfo[]>("list_note_folders");
export const listNotes = (folder: NoteFolder) => invoke<NoteRow[]>("list_notes", { folder });
export const searchNotes = (query: string) => invoke<SearchHit[]>("search_notes", { query });
export const readNote = (folder: NoteFolder, id: string) =>
  invoke<OpenedNote>("read_note", { folder, id });
export const getSticky = () => invoke<OpenedNote>("get_sticky");
/**
 * Saves a note and answers its new `version`. With `expected` (the version it was read or last
 * saved with) the backend refuses with `changed` when the file was changed outside meanwhile.
 */
export const writeNote = (folder: NoteFolder, id: string, text: string, expected?: string) =>
  invoke<string>("write_note", { folder, id, text, expected });
/** A sticky note saves its own text; the backend knows the note by the window. */
export const writeSticky = (text: string, expected?: string) =>
  invoke<string>("write_sticky", { text, expected });
/** A new note titled "`base` N" (the smallest free N). */
export const createNote = (folder: NoteFolder, base: string) =>
  invoke<OpenedNote>("create_note", { folder, base });
export const newSticky = (base: string) => invoke<OpenedNote>("new_sticky", { base });
export const renameNote = (folder: NoteFolder, id: string, title: string, byPerson: boolean) =>
  invoke<null>("rename_note", { folder, id, title, byPerson });
export const deleteNote = (folder: NoteFolder, id: string) =>
  invoke<null>("delete_note", { folder, id });
export const listTrash = (folder: NoteFolder) => invoke<TrashRow[]>("list_trash", { folder });
export const restoreNote = (folder: NoteFolder, id: string) =>
  invoke<string>("restore_note", { folder, id });
export const setNoteColor = (folder: NoteFolder, id: string, color: NoteColor) =>
  invoke<NoteColor>("set_note_color", { folder, id, color });
export const setNoteOnTop = (onTop: boolean) => invoke<boolean>("set_note_on_top", { onTop });
export const toDesktop = (folder: NoteFolder, id: string) =>
  invoke<null>("to_desktop", { folder, id });
export const fromDesktop = (folder: NoteFolder, id: string) =>
  invoke<null>("from_desktop", { folder, id });
export const closeNote = () => invoke<null>("close_note");
/** The path written, or `null` when the save dialog was cancelled. */
export const exportNote = (folder: NoteFolder, id: string) =>
  invoke<string | null>("export_note", { folder, id });
export const revealNote = (folder: NoteFolder, id: string) =>
  invoke<null>("reveal_note", { folder, id });
export const revealNotesFolder = (folder: NoteFolder) =>
  invoke<null>("reveal_notes_folder", { folder });
export const copyNote = (folder: NoteFolder, id: string) =>
  invoke<null>("copy_note", { folder, id });
/** Text that exists only in this window onto the clipboard (at most one note, `MAX_NOTE_BYTES`). */
export const copyTextToClipboard = (text: string) => invoke<null>("copy_text", { text });
export const openHub = () => invoke<null>("open_hub");
export const getSettings = () => invoke<SettingsView>("get_settings");
export const setSettings = (value: Settings) => invoke<Settings>("set_settings", { value });
/**
 * Keeps the notes area (window `hub`) above other windows; the backend stores the choice in
 * `settings.json` and answers the state it applied.
 */
export const setHubOnTop = (onTop: boolean) => invoke<boolean>("set_hub_on_top", { onTop });
/** Shows or folds away the notes area's sidebar for the next start too; answers the stored state. */
export const setSidebarOpen = (open: boolean) => invoke<boolean>("set_sidebar_open", { open });
/** Stores the sidebar's width in px; the backend keeps it within its range and answers it. */
export const setSidebarWidth = (width: number) => invoke<number>("set_sidebar_width", { width });
/**
 * Stores the width of hangar's note list in px, `null` for none (it grows with the window again);
 * the backend keeps it within its range and answers it.
 */
export const setListWidth = (width: number | null) =>
  invoke<number | null>("set_list_width", { width });
/** Remembers the project the "Project" level shows (`null` forgets it); answers the stored one. */
export const setLastProject = (folder: string | null) =>
  invoke<string | null>("set_last_project", { folder });
export const setAutostart = (enabled: boolean) => invoke<boolean>("set_autostart", { enabled });
export const setTrayLabels = (labels: TrayLabels) => invoke<null>("set_tray_labels", { labels });
export const windowReady = () => invoke<null>("window_ready");
/** An editor's answer to a delete or flush request: whether everything typed is on disk. */
export const noteFlushed = (saved: boolean) => invoke<null>("note_flushed", { saved });

function onSignal(event: string, handler: () => void): Promise<UnlistenFn> {
  return listen(event, () => {
    handler();
  });
}

export const onNotesChanged = (handler: () => void) => onSignal(NOTES_CHANGED_EVENT, handler);
export const onHubRequests = (handler: () => void) => onSignal(HUB_REQUESTS_EVENT, handler);

export function onSettingsChanged(handler: (settings: Settings) => void): Promise<UnlistenFn> {
  return listen<Settings>(SETTINGS_CHANGED_EVENT, (event) => {
    handler(event.payload);
  });
}

// Requests to one window are sent with `emit_to` its label. A plain `listen` hears events to
// every target, so each of these listens for its own window's label only: otherwise closing or
// deleting one note would reach every open note.
function listenTo(event: string, label: string, handler: () => void): Promise<UnlistenFn> {
  return listen(
    event,
    () => {
      handler();
    },
    { target: label },
  );
}

export const onCloseRequested = (label: string, handler: () => void) =>
  listenTo(CLOSE_REQUESTED_EVENT, label, handler);
export const onDeleteRequested = (label: string, handler: () => void) =>
  listenTo(DELETE_REQUESTED_EVENT, label, handler);
export const onFlushRequested = (label: string, handler: () => void) =>
  listenTo(FLUSH_REQUESTED_EVENT, label, handler);
export const onChangedOutside = (label: string, handler: () => void) =>
  listenTo(CHANGED_OUTSIDE_EVENT, label, handler);

export function onLookChanged(
  label: string,
  handler: (look: { color: NoteColor }) => void,
): Promise<UnlistenFn> {
  return listen<{ color: NoteColor }>(
    LOOK_CHANGED_EVENT,
    (event) => {
      handler(event.payload);
    },
    { target: label },
  );
}

/** UTF-8 size of a text, as the backend counts it. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}
