// One plain sentence for every error a command can answer, never the backend's text, a path or a
// code. The backend sends fixed codes (api.ts); the sentences live in i18n.ts. Pure, so every code
// is tested. "read-only" has no sentence here: the calm read-only hint already says it.

import { isNotSaved, isReadOnly, ON_DESKTOP_ERROR, storageError, storageErrorText } from "./api";
import type { MessageKey } from "./i18n";

/** What the person was doing: saving typed text, or any other action (rename, color, export). */
export type ErrorContext = "save" | "action";

/** The one button that helps with an error, if any. */
export type ErrorAction = "openFolder" | "reload" | "retry";

export interface ErrorMessage {
  key: MessageKey;
  action: ErrorAction | null;
}

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
