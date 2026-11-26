// One plain sentence for every error a command can answer, never the backend's text, a path or a
// code. The backend sends fixed codes (api.ts); the sentences live in i18n.ts. Pure, so every code
// is tested. "read-only" has no sentence here: the calm read-only hint already says it.

import {
  commandError,
  isNotSaved,
  isReadOnly,
  ON_DESKTOP_ERROR,
  storageError,
  storageErrorText,
  type CommandError,
} from "./api";
import type { MessageKey } from "./i18n";

/** What the person was doing: saving typed text, or any other action (rename, color, export). */
export type ErrorContext = "save" | "action";

/** The one button that helps with an error, if any. */
export type ErrorAction = "openFolder" | "reload" | "retry";

export interface ErrorMessage {
  key: MessageKey;
  action: ErrorAction | null;
}

/** The sentence for each command failure, in `i18n.ts`. */
export const COMMAND_ERROR_TEXTS: Readonly<Record<CommandError, MessageKey>> = {
  autostart: "error.autostart",
  clipboard: "error.clipboard",
  window: "error.window",
  task: "error.task",
  "not-a-path": "error.notAPath",
  "invalid-title": "notes.invalidTitle",
  "invalid-id": "error.invalidId",
  changed: "error.changed",
  "not-open": "error.notOpen",
  "not-allowed": "error.notAllowed",
  invalid: "error.invalid",
};

/** The sentence (and the helpful button) for `error`; `null` for "read-only". */
export function errorMessage(error: unknown, context: ErrorContext): ErrorMessage | null {
  if (isReadOnly(error)) return null;
  if (isNotSaved(error)) return { key: "notes.notSaved", action: null };
  if (error === ON_DESKTOP_ERROR) return { key: "error.onDesktop", action: null };
  const storage = storageErrorText(error);
  if (storage !== null) {
    switch (storageError(error)) {
      case "denied":
        return { key: storage, action: "openFolder" };
      case "not-found":
        return { key: storage, action: "reload" };
      case "io":
        return { key: storage, action: context === "save" ? "retry" : null };
      default:
        return { key: storage, action: null };
    }
  }
  const command = commandError(error);
  if (command !== null) {
    const key = COMMAND_ERROR_TEXTS[command];
    switch (command) {
      case "invalid-id":
        return { key, action: "reload" };
      case "task":
        return { key, action: context === "save" ? "retry" : null };
      default:
        // "changed" gets its two buttons where the text is (the notes area, the sticky note).
        return { key, action: null };
    }
  }
  return context === "save"
    ? { key: "note.saveFailed", action: "retry" }
    : { key: "error.failed", action: null };
}

/** The label of the helpful button. */
export function errorActionLabel(action: ErrorAction): MessageKey {
  switch (action) {
    case "openFolder":
      return "notes.openFolder";
    case "reload":
      return "notes.reloadList";
    case "retry":
      return "notes.retry";
  }
}
