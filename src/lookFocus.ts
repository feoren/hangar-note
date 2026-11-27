// Which look switch takes the focus once it is drawn (LookSwitch.tsx). Choosing a look replaces the
// whole layout, and with it the switch the focus was on; the new layout's switch is another
// element and picks the focus up from here. Pure state, no DOM.

import type { Look } from "./looks";

let pending: Look | null = null;

/** The switch of `look` takes the focus once it is drawn. */
export function focusLookOnDraw(look: Look): void {
  pending = look;
}

/** Whether a switch now showing `look` as chosen takes the focus; asking clears it. */
export function takeLookFocus(look: Look): boolean {
  if (pending !== look) return false;
  pending = null;
  return true;
}
