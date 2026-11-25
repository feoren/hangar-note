// What the WebView does on its own but an app must not: its default context menu ("Reload",
// "Print", "Inspect") outside text fields, and in release builds the keys that reload, print or
// search the page (shortcuts.ts). Text fields and the note editor keep their context menu with
// cut, copy, paste and the spelling suggestions.
//
// Tauri 2.12 cannot turn WebView2's browser keys off from Rust: wry has
// `with_browser_accelerator_keys`, but tauri-runtime-wry never calls it. Doing it by hand through
// `with_webview` would mean unsafe COM calls, two new dependencies and Windows only, while this
// works the same on every platform.

import { currentPlatform, isBrowserKey, type Platform } from "./shortcuts";

/** Input fields and the note editor (contenteditable) keep their context menu. */
export function editable(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])') !== null
  );
}

export interface GuardOptions {
  /** Catch reloading and printing; off in development, where reloading helps. */
  blockBrowserKeys: boolean;
  platform?: Platform;
}

/** Installs the guard on `target`; the returned function removes it again. */
export function installBrowserGuard(target: Window, options: GuardOptions): () => void {
  const platform = options.platform ?? currentPlatform();
  const onContextMenu = (event: MouseEvent) => {
    if (!editable(event.target)) event.preventDefault();
  };
  // Capture phase: before the editor or any element can stop the key on its way.
  const onKey = (event: KeyboardEvent) => {
    if (options.blockBrowserKeys && isBrowserKey(event, platform)) event.preventDefault();
  };
  target.addEventListener("contextmenu", onContextMenu);
  target.addEventListener("keydown", onKey, true);
  return () => {
    target.removeEventListener("contextmenu", onContextMenu);
    target.removeEventListener("keydown", onKey, true);
  };
}
