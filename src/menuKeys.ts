// Keyboard use of a popup menu (`role="menu"`) after the WAI-ARIA menu pattern: Arrow Down and
// Arrow Up move to the next and previous item and wrap around, Home and End go to the first and
// the last. Escape (closing and returning the focus to the button that opened the menu) is up to
// each menu, because only it knows that button.

const ITEMS = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';

/** The index the focus moves to for `key`, from `index` (-1: no item has the focus). */
export function menuStep(key: string, index: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowDown":
      return index < 0 ? 0 : (index + 1) % count;
    case "ArrowUp":
      return index < 0 ? count - 1 : (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** Moves the focus inside `menu` for `key`; `true` when the key was a menu key. */
export function moveMenuFocus(menu: HTMLElement, key: string): boolean {
  const items = Array.from(menu.querySelectorAll<HTMLElement>(ITEMS)).filter(
    (item) => !item.hasAttribute("disabled") && item.getAttribute("aria-disabled") !== "true",
  );
  const active = menu.ownerDocument.activeElement;
  const next = menuStep(
    key,
    items.findIndex((item) => item === active),
    items.length,
  );
  if (next === null) return false;
  items[next]?.focus();
  return true;
}

/** Focuses the first item, as a menu does when it opens. */
export function focusFirstItem(menu: HTMLElement): void {
  menu.querySelector<HTMLElement>(ITEMS)?.focus();
}
