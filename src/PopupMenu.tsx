// A small popup menu after the WAI-ARIA menu pattern (menuKeys.ts): it opens below its button,
// is moved back inside the window before the first paint (menuPlacement.ts), takes the focus,
// and closes on Escape (focus back to the button), on a click outside or when the window blurs.

import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

import { CheckIcon } from "./icons";
import { focusFirstItem, moveMenuFocus } from "./menuKeys";
import { fitMenu } from "./menuPlacement";

export type MenuItem =
  | {
      type: "action";
      key: string;
      label: string;
      /** Shown on the right, e.g. "F2". */
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      run: () => void;
    }
  | { type: "separator"; key: string }
  | { type: "custom"; key: string; content: ReactNode };

interface Props {
  items: readonly MenuItem[];
  label: string;
  anchor: HTMLElement;
  onClose: (reason: "done" | "dismiss") => void;
}

export function PopupMenu({ items, label, anchor, onClose }: Props) {
  const menu = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const rect = anchor.getBoundingClientRect();
    const { width, height } = element.getBoundingClientRect();
    const place = fitMenu(
      { x: rect.right - width, y: rect.bottom + 4 },
      { width, height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    element.style.left = `${String(place.x)}px`;
    element.style.top = `${String(place.y)}px`;
    focusFirstItem(element);
  }, [anchor]);

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
        if (event.key === "Escape") {
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
        return (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            className={item.danger === true ? "menu-item danger" : "menu-item"}
            disabled={item.disabled}
            onClick={() => {
              close.current("done");
              item.run();
            }}
          >
            <span className="menu-label">{item.label}</span>
            {item.shortcut !== undefined && <kbd className="menu-shortcut">{item.shortcut}</kbd>}
          </button>
        );
      })}
    </div>
  );
}

/** A check mark slot for menu rows that show a state. */
export function MenuCheck({ on }: { on: boolean }) {
  return <span className="menu-check">{on && <CheckIcon size={14} />}</span>;
}
