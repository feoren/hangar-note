// A small popup menu after the WAI-ARIA menu pattern (menuKeys.ts): it opens at its button (below
// it, aligned to the button's start or end) or at a point (a right click), is moved back inside
// the window before the first paint (menuPlacement.ts), takes the focus, and closes on Escape
// (focus back to the button), on a click outside or when the window blurs. It grows from the side
// it opened from (styles.css, `--menu-origin`).

import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

import { CheckIcon } from "./icons";
import { focusFirstItem, moveMenuFocus } from "./menuKeys";
import { fitMenu, type Point } from "./menuPlacement";

export type MenuItem =
  | {
      type: "action";
      key: string;
      label: string;
      /** Shown on the right, e.g. "F2". */
      shortcut?: string | undefined;
      /** A number on the right, e.g. how many notes a scope holds. */
      count?: number | undefined;
      /** An icon in the check mark slot, for items that never show a check mark. */
      icon?: ReactNode | undefined;
      /** Shown before the label, e.g. a color dot. */
      leading?: ReactNode | undefined;
      title?: string | undefined;
      danger?: boolean | undefined;
      disabled?: boolean | undefined;
      /**
       * A state: shown with a check mark and announced as checked or not. `radio` makes it one
       * choice of several (`menuitemradio`), otherwise it is a switch (`menuitemcheckbox`).
       */
      checked?: boolean | undefined;
      radio?: boolean | undefined;
      /** Stays open after the click, for choosing several (the color filter). */
      keepOpen?: boolean | undefined;
      run: () => void;
    }
  | { type: "separator"; key: string }
  | { type: "custom"; key: string; content: ReactNode };

interface Props {
  /** The items, or a function that builds them while the menu renders. */
  items: readonly MenuItem[] | (() => readonly MenuItem[]);
  label: string;
  anchor: HTMLElement;
  /** Which edge of the button the menu lines up with; `end` by default. */
  align?: "start" | "end" | undefined;
  /** Opens at this point instead of below the button (a right click). */
  at?: Point | undefined;
  onClose: (reason: "done" | "dismiss") => void;
}

export function PopupMenu({ items: given, label, anchor, align = "end", at, onClose }: Props) {
  const items = typeof given === "function" ? given() : given;
  const menu = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  const atX = at?.x;
  const atY = at?.y;

  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const rect = anchor.getBoundingClientRect();
    const { width, height } = element.getBoundingClientRect();
    const wanted =
      atX !== undefined && atY !== undefined
        ? { x: atX, y: atY }
        : { x: align === "start" ? rect.left : rect.right - width, y: rect.bottom + 4 };
    const place = fitMenu(
      wanted,
      { width, height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    element.style.left = `${String(place.x)}px`;
    element.style.top = `${String(place.y)}px`;
    const vertical = place.y < wanted.y ? "bottom" : "top";
    const horizontal = atX !== undefined || align === "start" ? "left" : "right";
    element.style.setProperty("--menu-origin", `${vertical} ${horizontal}`);
    focusFirstItem(element);
  }, [anchor, align, atX, atY]);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && (menu.current?.contains(target) || anchor.contains(target))) {
        return;
      }
      close.current("dismiss");
    };
    const onBlur = () => {
      close.current("dismiss");
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("blur", onBlur);
    };
  }, [anchor]);

  return (
    <div
      ref={menu}
      className="popup-menu"
      role="menu"
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key === "Escape" || event.key === "Tab") {
          // Tab leaves a menu as Escape does (WAI-ARIA menu pattern), back on its button.
          event.preventDefault();
          event.stopPropagation();
          close.current("dismiss");
          anchor.focus();
          return;
        }
        if (moveMenuFocus(event.currentTarget, event.key)) event.preventDefault();
      }}
    >
      {items.map((item) => {
        if (item.type === "separator") {
          return <div key={item.key} className="menu-separator" role="separator" />;
        }
        if (item.type === "custom") return <div key={item.key}>{item.content}</div>;
        const role =
          item.checked === undefined
            ? "menuitem"
            : item.radio === true
              ? "menuitemradio"
              : "menuitemcheckbox";
        return (
          <button
            key={item.key}
            type="button"
            role={role}
            aria-checked={item.checked}
            className={item.danger === true ? "menu-item danger" : "menu-item"}
            disabled={item.disabled}
            title={item.title}
            onClick={() => {
              if (item.keepOpen !== true) close.current("done");
              item.run();
            }}
          >
            <span className="menu-check" aria-hidden="true">
              {item.checked === true ? <CheckIcon size={14} /> : item.icon}
            </span>
            {item.leading}
            <span className="menu-label">{item.label}</span>
            {item.count !== undefined && <span className="menu-count">{item.count}</span>}
            {item.shortcut !== undefined && <kbd className="menu-shortcut">{item.shortcut}</kbd>}
          </button>
        );
      })}
    </div>
  );
}
