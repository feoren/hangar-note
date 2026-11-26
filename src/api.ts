// Typed wrappers around the backend commands (src-tauri/src/commands.rs). The frontend has no
// file system access: every note goes through these. Each window may only call the commands its
// capability grants (src-tauri/capabilities), and a sticky note only for its own note.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { NoteColor } from "./colors";
import type { Language } from "./i18n";

/** A scope: a working folder (absolute) or `null` for "General". */
export interface NoteFolder {
  path: string | null;
}

export interface FolderInfo {
  folderKey: string;
  path: string | null;
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
  | { state: "writable" }
  | { state: "readOnly"; reason: "notHandedOver" | "otherWriter" | "lockFailed" };

export interface Status {
  access: Access;
  rootKind: "hangar" | "development";
  /** The folder "This project" stands for. */
  project: string | null;
}

/** What the command line and Hangar ask of the notes area (`HubRequest` in requests.rs). */
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
}

export interface SettingsView extends Settings {
  /** Whether the app starts with the system (the OS state). */
  autostart: boolean;
  /**
   * Whether the notes area stays above other windows (`settings.json`). Optional: a backend
   * without the setting leaves it out, and the switch starts off.
   */
  hubOnTop?: boolean;
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

/** Fixed error codes of the backend (windows.rs, notes.rs). */
export const NOT_SAVED_ERROR = "not-saved";
export const READ_ONLY_ERROR = "read-only";
export const ON_DESKTOP_ERROR = "on-desktop";

export function isNotSaved(error: unknown): boolean {
  return error === NOT_SAVED_ERROR;
}

export function isReadOnly(error: unknown): boolean {
  return error === READ_ONLY_ERROR;
}

/** The backend's text of an error (always a string), for a message in the window. */
export function errorText(error: unknown): string {
  return typeof error === "string" ? error : error instanceof Error ? error.message : "";
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
export const writeNote = (folder: NoteFolder, id: string, text: string) =>
  invoke<null>("write_note", { folder, id, text });
/** A sticky note saves its own text; the backend knows the note by the window. */
export const writeSticky = (text: string) => invoke<null>("write_sticky", { text });
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
