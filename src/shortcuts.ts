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
//
// The three levels above the notes have Ctrl+1 to Ctrl+3 (Cmd on macOS): 1 "Private", 2
// "Project", 3 "Team". No editor command uses Ctrl+digit; with Shift the digits stay the editor's
// (Ctrl+Shift+8 and 9). Ctrl+Shift+S shows or folds away the sidebar: Ctrl+B, the usual key for
// that, is bold in the editor, and neither CodeMirror's keymaps nor the note use Ctrl+Shift+S.
//
// A row of the notes list has two more: Delete puts the note into the trash, and the context menu
// key or Shift+F10 opens the row's menu, the keyboard's way to what a right click shows. A color
// of the sidebar has the same menu keys, and F2 renames it in place, as F2 renames a note.
//
// The app menu only names the editor's own keys (Ctrl+Z, Ctrl+Y, Ctrl+A; CodeMirror binds them),
// it binds nothing itself.

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

/** How many levels Ctrl+digit chooses ("Private", "Project", "Team"). */
export const LEVEL_KEYS = 3;

/** The level (1 to 3, in the order the tabs show them) a key press chooses, or `null`. */
export function matchLevelShortcut(event: KeyInfo, platform: Platform): number | null {
  if (!commandKey(event, platform) || event.shiftKey) return null;
  const digit = Number(digitOf(event));
  return digit >= 1 && digit <= LEVEL_KEYS ? digit : null;
}

/** "Strg+3" or "⌘3", for the level tabs' tooltips. */
export function levelShortcutLabel(position: number, platform: Platform, t: Translate): string {
  if (platform === "mac") return `⌘${String(position)}`;
  return `${t("key.ctrl")}+${String(position)}`;
}

/** Ctrl+Shift+S (Shift+Cmd+S on macOS): show or fold away the sidebar. */
export function matchSidebarShortcut(event: KeyInfo, platform: Platform): boolean {
  return commandKey(event, platform) && event.shiftKey && letterOf(event) === "s";
}

/** "Strg+Umschalt+S" or "⇧⌘S", for the sidebar button's tooltip. */
export function sidebarShortcutLabel(platform: Platform, t: Translate): string {
  if (platform === "mac") return "⇧⌘S";
  return [t("key.ctrl"), t("key.shift"), "S"].join("+");
}

/**
 * Where the arrow keys, Home and End move the focus among the level tabs: the index of the tab to
 * focus among `count`, or `null` for any other key. Left goes back, Right goes on, the ends wrap.
 * The tabs lie in a row, so Up and Down are left alone (Down opens the project tab's menu).
 */
export function tabTarget(
  event: Pick<KeyInfo, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">,
  index: number,
  count: number,
): number | null {
  if (count === 0 || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return null;
  switch (event.key) {
    case "ArrowRight":
      return (index + 1) % count;
    case "ArrowLeft":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * Where the arrow keys, Home and End move the focus inside the sidebar: the index of the entry to
 * focus among `count` entries, or `null` for any other key. Up and Left go back, Down and Right go
 * on; the ends wrap, as in a menu. The list runs top to bottom and ends in a row of icon buttons
 * left to right, so both pairs move the way they point there too. None of the UI languages is
 * written right to left, so the row never flips.
 */
export function sidebarTarget(
  event: Pick<KeyInfo, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">,
  index: number,
  count: number,
): number | null {
  if (count === 0 || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return null;
  switch (event.key) {
    case "ArrowDown":
    case "ArrowRight":
      return index < 0 ? 0 : (index + 1) % count;
    case "ArrowUp":
    case "ArrowLeft":
      return index < 0 ? count - 1 : (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * Where the arrow keys, Home and End move the choice in a small radio group (the look switch): the
 * index of the radio to focus and choose among `count`, or `null` for any other key. Left and Up go
 * back, Right and Down go on, the ends wrap, as a radio group does. In a right-to-left page Left
 * and Right swap, as the row does.
 */
export function radioTarget(
  event: Pick<KeyInfo, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">,
  index: number,
  count: number,
  rtl = false,
): number | null {
  if (count === 0 || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return null;
  const forward = rtl ? "ArrowLeft" : "ArrowRight";
  const backward = rtl ? "ArrowRight" : "ArrowLeft";
  switch (event.key) {
    case forward:
    case "ArrowDown":
      return (index + 1) % count;
    case backward:
    case "ArrowUp":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

export type RowAction = "delete" | "menu";

/** The action for a key press on a row of the notes list, or `null`. */
export function matchRowShortcut(event: KeyInfo): RowAction | null {
  const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
  if (event.key === "Delete" && plain) return "delete";
  if (event.key === "ContextMenu" && plain) return "menu";
  const onlyShift = event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
  if (event.key === "F10" && onlyShift) return "menu";
  return null;
}

export type ColorRowAction = "rename" | "menu";

/** The action for a key press on a color of the sidebar, or `null`. */
export function matchColorRowShortcut(event: KeyInfo): ColorRowAction | null {
  const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
  if (event.key === "F2" && plain) return "rename";
  return matchRowShortcut(event) === "menu" ? "menu" : null;
}

/** The editor's undo, redo and select all, as the app menu names them. */
export function editShortcutLabel(
  command: "undo" | "redo" | "selectAll",
  platform: Platform,
  t: Translate,
): string {
  if (platform === "mac") return { undo: "⌘Z", redo: "⇧⌘Z", selectAll: "⌘A" }[command];
  return `${t("key.ctrl")}+${{ undo: "Z", redo: "Y", selectAll: "A" }[command]}`;
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
