// Whether the sticky notes show line numbers: one choice for every sticky note, kept across
// restarts. It lives in the webview's localStorage (all windows share the app's origin), so no
// backend setting is needed; the other open sticky notes follow through the `storage` event.
// Storage can be missing or refuse access; then the default applies and a change holds for this
// window only.

import { useCallback, useSyncExternalStore } from "react";

export const STICKY_LINE_NUMBERS_KEY = "hangar-note.sticky.lineNumbers";

/** Off, as the sticky notes have always been: a small note has little width to spare. */
export const STICKY_LINE_NUMBERS_DEFAULT = false;

/** The choice as stored ("1" or "0"); anything else is the default. */
export function parseLineNumbers(value: string | null): boolean {
  if (value === "1") return true;
  if (value === "0") return false;
  return STICKY_LINE_NUMBERS_DEFAULT;
}

/** What this window chose while storage refused to keep it. */
let unsaved: boolean | null = null;
const listeners = new Set<() => void>();

export function readStickyLineNumbers(): boolean {
  if (unsaved !== null) return unsaved;
  try {
    return parseLineNumbers(window.localStorage.getItem(STICKY_LINE_NUMBERS_KEY));
  } catch {
    return STICKY_LINE_NUMBERS_DEFAULT;
  }
}

export function writeStickyLineNumbers(on: boolean): void {
  try {
    window.localStorage.setItem(STICKY_LINE_NUMBERS_KEY, on ? "1" : "0");
    unsaved = null;
  } catch {
    unsaved = on;
  }
  // The `storage` event reaches only the other windows; this one is told here.
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const fromOtherWindow = (event: StorageEvent) => {
    // `key === null`: the storage was cleared.
    if (event.key === STICKY_LINE_NUMBERS_KEY || event.key === null) listener();
  };
  window.addEventListener("storage", fromOtherWindow);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", fromOtherWindow);
  };
}

/** The choice, kept up to date across windows, and how to change it. */
export function useStickyLineNumbers(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, readStickyLineNumbers, readStickyLineNumbers);
  const set = useCallback((next: boolean) => {
    writeStickyLineNumbers(next);
  }, []);
  return [on, set];
}

/** Forgets a choice storage refused, for tests. */
export function forgetUnsavedLineNumbers(): void {
  unsaved = null;
}
