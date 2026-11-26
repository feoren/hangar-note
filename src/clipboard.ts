// Copying text that is not a saved note: a captured text the backend could not store, or a note
// whose save keeps failing. A saved note is copied by the backend from disk (`copyNote`); this
// text exists only in the window, so the window hands it to the backend (`copy_text`). The web
// clipboard is not used: Hangar saw `navigator.clipboard` fail in WebView2 outside a native
// clipboard event, and the copy command is deprecated.

import { copyTextToClipboard, MAX_NOTE_BYTES, utf8Bytes } from "./api";

/** `true` when the text reached the clipboard. */
export async function copyText(text: string): Promise<boolean> {
  // The backend refuses more anyway; asking would only send a large text for nothing.
  if (utf8Bytes(text) > MAX_NOTE_BYTES) return false;
  try {
    await copyTextToClipboard(text);
    return true;
  } catch {
    return false;
  }
}
