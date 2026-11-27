// The app menu behind the three-line button at the top of the sidebar: File, Edit, View with
// submenus, as in Hangar (taken from Hangar's src/AppMenu.tsx, MIT, same owner). Operated following
// the WAI-ARIA menu pattern (menuNav.ts): on open the first entry has the focus and no submenu
// opens by itself; Up and Down move, Right, Enter or Space open a submenu, Left closes it, Home and
// End jump, a first letter jumps to its entry, Escape closes one level, Tab the whole menu. With
// the mouse a submenu opens on a click or once the pointer moves onto its entry. The panels are
// placed in the window (`position: fixed`), so the sidebar's edge never cuts them off; the focus
// goes back to the button when the menu closes without moving it somewhere on purpose.

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { CheckIcon, MenuIcon } from "./icons";
import { fitMenu, MENU_MARGIN } from "./menuPlacement";
import {
  firstIndex,
  INITIAL_SUBMENU,
  menuCommand,
  pointerMoved,
  submenuAfterFocus,
  type NavEntry,
  type PointerPoint,
} from "./menuNav";

export type AppMenuItem =
  | {
      type: "action";
      label: string;
      /** Shown on the right, e.g. "Strg+N". */
      shortcut?: string | undefined;
      disabled?: boolean | undefined;
      /** A state with a check mark: one of several (`radio`) or a switch. */
      checked?: boolean | undefined;
      radio?: boolean | undefined;
      run: () => void;
    }
  | { type: "submenu"; label: string; items: AppMenuItem[] }
  | { type: "separator"; key: string };

export interface AppMenuGroup {
  label: string;
  items: AppMenuItem[];
}

/** The keyboard navigation's view of the entries (menuNav.ts). */
function navEntries(items: readonly AppMenuItem[]): NavEntry[] {
  return items.map((item) =>
    item.type === "separator"
      ? null
      : {
          label: item.label,
          enabled: item.type === "submenu" ? item.items.length > 0 : item.disabled !== true,
          submenu: item.type === "submenu",
        },
  );
}

export function AppMenu({
  groups,
  label,
}: {
  /** Built while the menu is open, so its items always show the current state. */
  groups: () => AppMenuGroup[];
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  /** Closed: the focus goes back to the button unless an action put it somewhere on purpose. */
  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active === null || active === document.body) button.current?.focus();
    });
  };
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && root.current?.contains(event.target)) return;
      setOpen(false);
    };
    const onBlur = () => {
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("blur", onBlur);
    };
  }, [open]);

  const items = (): AppMenuItem[] =>
    groups().map((group) => ({ type: "submenu", label: group.label, items: group.items }));

  return (
    <div className="app-menu" ref={root}>
      <button
        ref={button}
        type="button"
        className="icon-button menu-button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onClick={() => {
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <MenuIcon size={16} />
      </button>
      {open && (
        <MenuPanel
          items={items()}
          label={label}
          anchor={() => button.current}
          root
          autoFocus
          onDone={() => {
            closeRef.current();
          }}
          onBack={() => undefined}
        />
      )}
    </div>
  );
}

function MenuPanel({
  items,
  label,
  anchor,
  root = false,
  autoFocus,
  onDone,
  onBack,
}: {
  items: AppMenuItem[];
  label: string;
  /** The button the root panel opens from; a submenu opens beside its own entry. */
  anchor?: () => HTMLElement | null;
  root?: boolean;
  /** Focus the first entry on mount (the menu opened, or a submenu opened by keyboard). */
  autoFocus: boolean;
  onDone: () => void;
  /** Close this submenu (Left or Escape); the entry that opened it takes the focus. */
  onBack: () => void;
}) {
  const entries = navEntries(items);
  const [current, setCurrent] = useState(() => firstIndex(entries));
  const [openIndex, setOpenIndex] = useState<number | null>(INITIAL_SUBMENU);
  const [childFocus, setChildFocus] = useState(false);
  const [place, setPlace] = useState<{ x: number; y: number } | null>(null);
  const panel = useRef<HTMLUListElement>(null);
  const buttons = useRef(new Map<number, HTMLButtonElement>());
  /** Last pointer position over this level, to tell real movement from a resting pointer. */
  const lastPointer = useRef<PointerPoint | null>(null);
  const checks = items.some((item) => item.type === "action" && item.checked !== undefined);

  // Placed before it shows: below the button, or beside its entry (left of it where the window
  // ends on the right), always inside the window.
  useLayoutEffect(() => {
    // A submenu sits in the DOM inside the entry that opened it.
    const from = (root ? anchor?.() : panel.current?.parentElement)?.getBoundingClientRect();
    const own = panel.current?.getBoundingClientRect();
    if (!from || !own) return;
    const view = { width: window.innerWidth, height: window.innerHeight };
    const size = { width: own.width, height: own.height };
    if (root) {
      setPlace(fitMenu({ x: from.left, y: from.bottom + 4 }, size, view));
      return;
    }
    const right = from.right + 2;
    const fitsRight = right + own.width + MENU_MARGIN <= view.width;
    const x = fitsRight ? right : from.left - own.width - 2;
    setPlace(fitMenu({ x, y: from.top - 5 }, size, view));
    // Once, when the panel appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    if (autoFocus && place !== null) buttons.current.get(current)?.focus();
    // Once placed: focusing a panel that still waits for its place would scroll the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place === null]);

  const focusAt = (index: number) => {
    setCurrent(index);
    buttons.current.get(index)?.focus();
    const next = submenuAfterFocus(openIndex, index);
    if (next !== openIndex) {
      setChildFocus(false);
      setOpenIndex(next);
    }
  };

  /** The pointer moved onto an entry: it takes the focus, a submenu entry opens its submenu. */
  const hover = (event: React.PointerEvent<HTMLLIElement>, index: number) => {
    // Moves inside an open submenu bubble up through this entry; that level handles them.
    if (
      event.target instanceof Element &&
      event.target.closest(".menu-entry") !== event.currentTarget
    ) {
      return;
    }
    const point = { x: event.clientX, y: event.clientY };
    const moved = pointerMoved(lastPointer.current, point);
    lastPointer.current = point;
    const item = items[index];
    if (!moved || item === undefined || item.type === "separator") return;
    if (item.type === "action" && item.disabled === true) return;
    const wanted = item.type === "submenu" ? index : null;
    if (index === current && openIndex === wanted) return;
    setCurrent(index);
    buttons.current.get(index)?.focus();
    setChildFocus(false);
    setOpenIndex(wanted);
  };

  const openSubmenu = (index: number, focusChild: boolean) => {
    setCurrent(index);
    setChildFocus(focusChild);
    setOpenIndex(index);
  };

  const activate = (index: number) => {
    const item = items[index];
    if (item?.type !== "action" || item.disabled === true) return;
    onDone();
    item.run();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    // Submenus sit in the DOM inside their parent entry: each level handles only its own keys.
    event.stopPropagation();
    const command = menuCommand(event, entries, current, !root);
    switch (command.kind) {
      case "none":
        return;
      case "focus":
        focusAt(command.index);
        break;
      case "activate":
        activate(current);
        break;
      case "openSubmenu":
        openSubmenu(current, true);
        break;
      case "closeSubmenu":
        onBack();
        break;
      case "closeAll":
        onDone();
        break;
    }
    event.preventDefault();
  };

  const style: React.CSSProperties =
    place === null
      ? { left: 0, top: 0, visibility: "hidden" }
      : { left: `${String(place.x)}px`, top: `${String(place.y)}px` };

  return (
    <ul
      ref={panel}
      className={root ? "menu-panel menu-root" : "menu-panel"}
      role="menu"
      aria-label={label}
      style={style}
      onKeyDown={onKeyDown}
    >
      {items.map((item, index) => {
        if (item.type === "separator") {
          return <li key={item.key} role="separator" className="menu-separator" />;
        }
        const isOpen = item.type === "submenu" && openIndex === index;
        const checked = item.type === "action" ? item.checked : undefined;
        const role =
          checked === undefined
            ? "menuitem"
            : item.type === "action" && item.radio === true
              ? "menuitemradio"
              : "menuitemcheckbox";
        return (
          <li
            key={item.label}
            className="menu-entry"
            role="none"
            onPointerMove={(event) => {
              hover(event, index);
            }}
          >
            <button
              type="button"
              role={role}
              ref={(element) => {
                if (element) buttons.current.set(index, element);
                else buttons.current.delete(index);
              }}
              tabIndex={index === current ? 0 : -1}
              className={isOpen ? "menu-item open" : "menu-item"}
              disabled={item.type === "action" ? item.disabled : item.items.length === 0}
              aria-checked={checked}
              aria-haspopup={item.type === "submenu" ? "menu" : undefined}
              aria-expanded={item.type === "submenu" ? isOpen : undefined}
              onClick={(event) => {
                if (item.type === "submenu") {
                  // From the keyboard (detail 0): straight into the submenu.
                  openSubmenu(index, event.detail === 0);
                  return;
                }
                activate(index);
              }}
            >
              {checks && (
                <span className="menu-check" aria-hidden="true">
                  {checked === true && <CheckIcon size={13} />}
                </span>
              )}
              <span className="menu-label">{item.label}</span>
              <span className="menu-hint" aria-hidden={item.type === "submenu" ? true : undefined}>
                {item.type === "submenu" ? "›" : (item.shortcut ?? "")}
              </span>
            </button>
            {isOpen && item.items.length > 0 && (
              <MenuPanel
                // Remount when the preview turns into an open with focus.
                key={childFocus ? "focus" : "preview"}
                items={item.items}
                label={item.label}
                autoFocus={childFocus}
                onDone={onDone}
                onBack={() => {
                  setOpenIndex(null);
                  setChildFocus(false);
                  buttons.current.get(index)?.focus();
                }}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
