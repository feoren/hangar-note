// Typed wrappers around the backend commands (src-tauri/src/commands.rs). The frontend has no
// file system access: every note goes through these. Each window may only call the commands its
// capability grants (src-tauri/capabilities), and a note window only for its own note.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { NoteColor } from "./colors";
import type { Language } from "./i18n";

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NoteMeta {
  id: string;
  color: NoteColor;
  bounds: Bounds | null;
  open: boolean;
  onTop: boolean;
  /** Unix time in milliseconds. */
  createdAt: number;
  updatedAt: number;
}

export interface NoteSummary extends NoteMeta {
  /** The start of the content (at most 16 KiB). */
  preview: string;
}

export interface NoteContent extends NoteMeta {
  text: string;
}

export interface TrashItem {
  id: string;
  color: NoteColor;
  deletedAt: number;
  preview: string;
}

export type ThemeSetting = "system" | "light" | "dark";

export interface Settings {
  /** `null` follows the system language. */
  language: Language | null;
  theme: ThemeSetting;
  newNoteColor: NoteColor;
}

export interface SettingsView extends Settings {
  /** Whether the app starts with the system (the OS state). */
  autostart: boolean;
}

export interface TrayLabels {
  allNotes: string;
  newNote: string;
  showAll: string;
  quit: string;
  tooltip: string;
}

/** Events the backend sends (src-tauri/src/windows.rs). */
export const NOTES_CHANGED_EVENT = "notes-changed";
export const SETTINGS_CHANGED_EVENT = "settings-changed";
export const CLOSE_REQUESTED_EVENT = "note-close-requested";
export const DELETE_REQUESTED_EVENT = "note-delete-requested";
export const FLUSH_REQUESTED_EVENT = "note-flush-requested";

/** The error of `delete_note` when the open note could not save (`NOT_SAVED_CODE` in windows.rs). */
export const NOT_SAVED_ERROR = "not-saved";

export function isNotSaved(error: unknown): boolean {
  return error === NOT_SAVED_ERROR;
}

/** The backend's limit per note (`MAX_NOTE_BYTES` in store.rs). */
export const MAX_NOTE_BYTES = 1024 * 1024;

export const listNotes = () => invoke<NoteSummary[]>("list_notes");
export const readNote = (id: string) => invoke<NoteContent>("read_note", { id });
export const writeNote = (id: string, text: string) => invoke<NoteMeta>("write_note", { id, text });
export const createNote = () => invoke<NoteMeta>("create_note");
export const setNoteColor = (id: string, color: NoteColor) =>
  invoke<NoteMeta>("set_note_color", { id, color });
export const setNoteOnTop = (id: string, onTop: boolean) =>
  invoke<NoteMeta>("set_note_on_top", { id, onTop });
export const deleteNote = (id: string) => invoke<TrashItem>("delete_note", { id });
export const listTrash = () => invoke<TrashItem[]>("list_trash");
export const restoreNote = (id: string) => invoke<NoteMeta>("restore_note", { id });
export const openNote = (id: string) => invoke<null>("open_note", { id });
export const closeNote = (id: string) => invoke<null>("close_note", { id });
export const openHub = () => invoke<null>("open_hub");
export const getSettings = () => invoke<SettingsView>("get_settings");
export const setSettings = (value: Settings) => invoke<Settings>("set_settings", { value });
export const setAutostart = (enabled: boolean) => invoke<boolean>("set_autostart", { enabled });
export const setTrayLabels = (labels: TrayLabels) => invoke<null>("set_tray_labels", { labels });
export const windowReady = () => invoke<null>("window_ready");
/** A note window's answer to a delete or flush request: whether everything typed is on disk. */
export const noteFlushed = (saved: boolean) => invoke<null>("note_flushed", { saved });

export function onNotesChanged(handler: () => void): Promise<UnlistenFn> {
  return listen(NOTES_CHANGED_EVENT, () => {
    handler();
  });
}

export function onSettingsChanged(handler: (settings: Settings) => void): Promise<UnlistenFn> {
  return listen<Settings>(SETTINGS_CHANGED_EVENT, (event) => {
    handler(event.payload);
  });
}

/** The label of a note's window (`note_label` in windows.rs). */
export function noteLabel(id: string): string {
  return `note-${id}`;
}

// Requests to one note window are sent with `emit_to` its label. A plain `listen` hears events to
// every target, so each of these listens for its own window's label only: otherwise closing or
// deleting one note would reach every open note.
function listenToNote(event: string, id: string, handler: () => void): Promise<UnlistenFn> {
  return listen(
    event,
    () => {
      handler();
    },
    { target: noteLabel(id) },
  );
}

export const onCloseRequested = (id: string, handler: () => void) =>
  listenToNote(CLOSE_REQUESTED_EVENT, id, handler);
export const onDeleteRequested = (id: string, handler: () => void) =>
  listenToNote(DELETE_REQUESTED_EVENT, id, handler);
export const onFlushRequested = (id: string, handler: () => void) =>
  listenToNote(FLUSH_REQUESTED_EVENT, id, handler);

/** UTF-8 size of a text, as the backend counts it. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}
