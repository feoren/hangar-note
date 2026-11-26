// Shortcuts of a note window (ADR 0001), defined only here. Ctrl on Windows and Linux, Cmd on
// macOS. Ctrl+N, Ctrl+B and Ctrl+I are what every text editor uses for a new document, bold and
// italic, so the note claims them on purpose; everything else needs Shift, so no Ctrl+letter the
// editor uses is taken: Ctrl+Shift+X strikethrough (as in Google Docs and Word Online),
// Ctrl+Shift+8 bullet list and Ctrl+Shift+9 checklist (as in Google Docs). Escape leaves the
// editor, which hides the formatting bar.
//
// Letters match by `event.key` when it is a Latin letter, so Ctrl+B is bold on Dvorak too, where
// the B is elsewhere; layouts without Latin letters (Cyrillic, Greek) fall back to the key's
// position (`event.code`). Digits always match by position: with Shift held, `event.key` is the
// symbol above the digit, and that differs per layout.
//
// The notes area (Hangar's notes panel) has two of its own: Ctrl+Shift+N starts a quick note and
// F2 renames the open note, as in Hangar.

import type { Translate } from "./i18n";

export type Platform = "windows" | "mac" | "linux";

export type NoteAction = "newNote" | "bold" | "italic" | "strike" | "bullet" | "task" | "leave";

type KeyInfo = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">;

export function platformOf(userAgent: string): Platform {
  if (/Windows/i.test(userAgent)) return "windows";
  if (/Mac/i.test(userAgent)) return "mac";
  return "linux";
}

export function currentPlatform(): Platform {
  return platformOf(typeof navigator === "undefined" ? "" : navigator.userAgent);
}

/** The Latin letter of a key press in lowercase, or `null` for any other key. */
export function letterOf(event: Pick<KeyboardEvent, "key" | "code">): string | null {
  if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase();
  return /^Key([A-Z])$/.exec(event.code)?.[1]?.toLowerCase() ?? null;
}

function digitOf(event: Pick<KeyboardEvent, "code">): string | null {
  return /^Digit([0-9])$/.exec(event.code)?.[1] ?? null;
}

/** Ctrl (Cmd on macOS) without the other platform's modifier and without Alt. */
function commandKey(event: KeyInfo, platform: Platform): boolean {
  // AltGr arrives as Ctrl+Alt on Windows: it types characters, never a shortcut.
  if (event.altKey) return false;
  return platform === "mac" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** The action for a key press in a note, or `null` when the key belongs to the editor. */
export function matchNoteShortcut(event: KeyInfo, platform: Platform): NoteAction | null {
  const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
  if (event.key === "Escape" && plain) return "leave";
  if (!commandKey(event, platform)) return null;
  if (event.shiftKey) {
    if (letterOf(event) === "x") return "strike";
    switch (digitOf(event)) {
      case "8":
        return "bullet";
      case "9":
        return "task";
      default:
        return null;
    }
  }
  switch (letterOf(event)) {
    case "n":
      return "newNote";
    case "b":
      return "bold";
    case "i":
      return "italic";
    default:
      return null;
  }
}

export type HubAction = "quickNote" | "rename";

/** The action for a key press in the notes area, or `null`. */
export function matchHubShortcut(event: KeyInfo, platform: Platform): HubAction | null {
  const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
  if (event.key === "F2" && plain) return "rename";
  if (commandKey(event, platform) && event.shiftKey && letterOf(event) === "n") return "quickNote";
  return null;
}

/** "Strg+Umschalt+N" or "⇧⌘N", for tooltips and hints. */
export function hubShortcutLabel(action: HubAction, platform: Platform, t: Translate): string {
  if (action === "rename") return "F2";
  if (platform === "mac") return "⇧⌘N";
  return [t("key.ctrl"), t("key.shift"), "N"].join("+");
}

/**
 * Keys with which the WebView would reload, print or search the page (F5, Ctrl+R, Ctrl+P, Ctrl+F
 * and F3, also with Shift or Ctrl). A reload throws away what a note has not saved yet; printing
 * and the browser's find bar do not belong in the app. The editor has no search of its own.
 */
export function isBrowserKey(event: KeyInfo, platform: Platform): boolean {
  if (event.key === "F5" || event.key === "F3") return !event.altKey && !event.metaKey;
  if (!commandKey(event, platform)) return false;
  const letter = letterOf(event);
  return letter === "r" || letter === "p" || letter === "f";
}

const KEYS: Record<Exclude<NoteAction, "leave">, { shift: boolean; key: string }> = {
  newNote: { shift: false, key: "N" },
  bold: { shift: false, key: "B" },
  italic: { shift: false, key: "I" },
  strike: { shift: true, key: "X" },
  bullet: { shift: true, key: "8" },
  task: { shift: true, key: "9" },
};

/** "Strg+Umschalt+X" or "⇧⌘X", for tooltips. */
export function shortcutLabel(
  action: Exclude<NoteAction, "leave">,
  platform: Platform,
  t: Translate,
): string {
  const { shift, key } = KEYS[action];
  if (platform === "mac") return `${shift ? "⇧" : ""}⌘${key}`;
  return [t("key.ctrl"), ...(shift ? [t("key.shift")] : []), key].join("+");
}
