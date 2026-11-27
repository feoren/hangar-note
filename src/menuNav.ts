// Keyboard control of the app menu following the WAI-ARIA menu pattern. Taken from Hangar's
// src/menuNav.ts (MIT, same owner), the parts the app menu uses. Pure logic: key and entries yield
// a command that the component carries out.

/** Entry as seen by navigation; `null` is a separator. */
export type NavEntry = { label: string; enabled: boolean; submenu: boolean } | null;

export type MenuCommand =
  | { kind: "focus"; index: number }
  /** Enter or Space on an action. */
  | { kind: "activate" }
  /** Open the submenu and focus its first entry. */
  | { kind: "openSubmenu" }
  /** Close the submenu, focus back on the entry that opened it. */
  | { kind: "closeSubmenu" }
  /** Close the whole menu (Escape at the top level, Tab). */
  | { kind: "closeAll" }
  | { kind: "none" };

function usable(entry: NavEntry | undefined): boolean {
  return entry !== null && entry !== undefined && entry.enabled;
}

/** Next operable entry in direction `step`; past the end it wraps around. */
export function stepIndex(entries: readonly NavEntry[], current: number, step: 1 | -1): number {
  const count = entries.length;
  if (count === 0) return -1;
  let index = current < 0 ? (step === 1 ? -1 : count) : current;
  for (let tries = 0; tries < count; tries += 1) {
    index = (((index + step) % count) + count) % count;
    if (usable(entries[index])) return index;
  }
  return current < count && usable(entries[current]) ? current : -1;
}

export function firstIndex(entries: readonly NavEntry[]): number {
  return stepIndex(entries, -1, 1);
}

export function lastIndex(entries: readonly NavEntry[]): number {
  return stepIndex(entries, -1, -1);
}

/** Next entry after `current` whose name starts with `char` (case insensitive), otherwise -1. */
export function typeaheadIndex(
  entries: readonly NavEntry[],
  current: number,
  char: string,
): number {
  const wanted = char.toLocaleLowerCase();
  const count = entries.length;
  for (let offset = 1; offset <= count; offset += 1) {
    const index = (((current + offset) % count) + count) % count;
    const entry = entries[index];
    if (usable(entry) && entry?.label.trim().toLocaleLowerCase().startsWith(wanted) === true) {
      return index;
    }
  }
  return -1;
}

/** A single printable character without Ctrl, Alt or Meta (first letter). */
function printable(key: string): boolean {
  return Array.from(key).length === 1 && key.trim() !== "";
}

export interface KeyInput {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

/**
 * Command for a key. `nested`: the menu is a submenu (Left arrow and Escape then close only
 * this one).
 */
export function menuCommand(
  input: KeyInput,
  entries: readonly NavEntry[],
  current: number,
  nested: boolean,
): MenuCommand {
  const entry = entries[current];
  const focus = (index: number): MenuCommand =>
    index < 0 ? { kind: "none" } : { kind: "focus", index };
  switch (input.key) {
    case "ArrowDown":
      return focus(stepIndex(entries, current, 1));
    case "ArrowUp":
      return focus(stepIndex(entries, current, -1));
    case "Home":
    case "PageUp":
      return focus(firstIndex(entries));
    case "End":
    case "PageDown":
      return focus(lastIndex(entries));
    case "ArrowRight":
      return usable(entry) && entry?.submenu === true ? { kind: "openSubmenu" } : { kind: "none" };
    case "ArrowLeft":
      return nested ? { kind: "closeSubmenu" } : { kind: "none" };
    case "Escape":
      return nested ? { kind: "closeSubmenu" } : { kind: "closeAll" };
    case "Tab":
      return { kind: "closeAll" };
    case "Enter":
    case " ":
      if (!usable(entry)) return { kind: "none" };
      return entry?.submenu === true ? { kind: "openSubmenu" } : { kind: "activate" };
    default:
      if (input.ctrlKey === true || input.altKey === true || input.metaKey === true) {
        return { kind: "none" };
      }
      return printable(input.key)
        ? focus(typeaheadIndex(entries, current, input.key))
        : { kind: "none" };
  }
}

/**
 * Submenu open when a menu appears: none. Opening the menu is not a request for a submenu; only
 * a click, Right arrow, Enter or Space, or a pointer moved onto an entry opens one.
 */
export const INITIAL_SUBMENU: number | null = null;

/**
 * Submenu after the keyboard moved focus to `index`: one already open there stays, any other
 * closes. Arrow keys never open a submenu by themselves.
 */
export function submenuAfterFocus(openIndex: number | null, index: number): number | null {
  return openIndex === index ? index : null;
}

export interface PointerPoint {
  x: number;
  y: number;
}

/**
 * Whether the pointer really moved since the last event (`last`; `null`: none seen yet in this
 * menu). A pointer resting where the menu appeared, or a move the browser sends after layout
 * without any movement, is no hover.
 */
export function pointerMoved(last: PointerPoint | null, next: PointerPoint): boolean {
  return last !== null && (last.x !== next.x || last.y !== next.y);
}
