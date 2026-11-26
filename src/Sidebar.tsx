// The one navigation of the notes area, the same in every look (ADR 0004): "All notes" and
// "General", the projects by their folder name, the color filter, and at the bottom "Recently
// deleted" and "Settings". The current place is marked (`aria-current`). The arrow keys, Home and
// End move between the entries (one Tab stop for all of them); Ctrl+1 to Ctrl+9 choose an area from
// anywhere (useNotesArea.tsx). Below NAV_MIN_WIDTH the sidebar is folded away: a button in the
// heading of each look opens it over the notes, and choosing a place closes it again.

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { colorName, NOTE_COLORS } from "./colors";
import {
  CheckIcon,
  CloseIcon,
  FolderIcon,
  GearIcon,
  MoreIcon,
  NoteIcon,
  NotesIcon,
  SidebarIcon,
  TrashIcon,
} from "./icons";
import { sidebarTarget } from "./shortcuts";
import { dotStyle, type NotesModel, type ScopeEntry } from "./useNotesArea";

/** The sidebar as a narrow window offers it: folded away behind a button, or always there. */
export interface NavState {
  /** Folded away: the looks show the button that opens it. */
  folded: boolean;
  /** Opens the folded sidebar over the notes; the focus returns to the button on closing. */
  open: (from: HTMLElement) => void;
}

const NavContext = createContext<NavState>({ folded: false, open: () => undefined });

export const NavProvider = NavContext.Provider;

/** The button that opens the folded sidebar; nothing while the sidebar is shown anyway. */
export function NavButton({ m }: { m: NotesModel }) {
  const nav = useContext(NavContext);
  if (!nav.folded) return null;
  const label = m.t("nav.open");
  return (
    <button
      type="button"
      className="icon-button nav-button"
      data-focus-id="nav"
      aria-label={label}
      title={label}
      aria-haspopup="dialog"
      onClick={(event) => {
        nav.open(event.currentTarget);
      }}
    >
      <SidebarIcon size={18} />
    </button>
  );
}

/**
 * The sidebar. `overlay`: shown over the notes in a narrow window, as a modal dialog that
 * `onClose` closes (Escape, the close button, a click beside it, or a choice).
 */
export function Sidebar({
  m,
  overlay = false,
  onClose,
}: {
  m: NotesModel;
  overlay?: boolean;
  onClose?: () => void;
}) {
  const { t } = m;
  const list = useRef<HTMLDivElement>(null);
  const currentKey = m.place ?? m.scopeEntries.find((entry) => m.isShownScope(entry))?.key ?? "all";
  /** The entry that takes the sidebar's one Tab stop: the last focused, else the current one. */
  const [tabKey, setTabKey] = useState<string | null>(null);
  const keys = [
    ...m.scopeEntries.map((entry) => entry.key),
    ...(m.emptyMode ? [] : NOTE_COLORS.map((color) => `color:${color}`)),
    "trash",
    "settings",
  ];
  const stop = tabKey !== null && keys.includes(tabKey) ? tabKey : currentKey;

  // Opened over the notes, the focus goes onto the current place.
  useEffect(() => {
    if (!overlay) return;
    list.current?.querySelector<HTMLElement>('[tabindex="0"][data-nav]')?.focus();
  }, [overlay]);

  const close = () => {
    onClose?.();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (overlay && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.hasAttribute("data-nav")) return;
    const entries = Array.from(
      list.current?.querySelectorAll<HTMLElement>("[data-nav]") ?? [],
    ).filter((element) => !element.closest("[hidden]"));
    const next = sidebarTarget(event, entries.indexOf(target), entries.length);
    if (next === null) return;
    event.preventDefault();
    entries[next]?.focus();
  };

  /** One entry's focus and Tab stop (roving tab index). */
  const entryProps = (key: string) => ({
    "data-nav": key,
    tabIndex: key === stop ? 0 : -1,
    onFocus: () => {
      setTabKey(key);
    },
  });

  const area = (entry: ScopeEntry, icon: ReactNode) => {
    const current = m.place === null && m.isShownScope(entry);
    return (
      <li key={entry.key}>
        <button
          type="button"
          className="nav-item"
          aria-current={current ? "page" : undefined}
          title={entry.title}
          {...entryProps(entry.key)}
          onClick={() => {
            m.goTo(entry.scope);
            close();
          }}
        >
          {icon}
          <span className="nav-label">{entry.label}</span>
          {entry.count !== undefined && <span className="nav-count">{entry.count}</span>}
        </button>
      </li>
    );
  };

  const main = m.scopeEntries.filter((entry) => entry.group === "main");
  const projects = m.scopeEntries.filter((entry) => entry.group === "project");

  return (
    <nav
      className={overlay ? "nav nav-overlay" : "nav"}
      aria-label={t("notes.scopes")}
      onKeyDown={onKeyDown}
    >
      <div className="nav-head">
        <span className="nav-name">{t("app.name")}</span>
        <button
          type="button"
          className="icon-button"
          aria-label={t("notes.more")}
          title={t("notes.more")}
          aria-haspopup="menu"
          aria-expanded={m.menuOpen("side")}
          onClick={(event) => {
            m.toggleMenu("side", event);
          }}
        >
          <MoreIcon />
        </button>
        {overlay && (
          <button
            type="button"
            className="icon-button"
            aria-label={t("nav.close")}
            title={t("nav.close")}
            onClick={close}
          >
            <CloseIcon />
          </button>
        )}
      </div>

      <div className="nav-scroll" ref={list}>
        <ul className="nav-list">
          {main.map((entry) =>
            area(entry, entry.key === "all" ? <NotesIcon size={15} /> : <NoteIcon size={15} />),
          )}
        </ul>

        {projects.length > 0 && (
          <>
            <p className="nav-section" id="nav-projects">
              {t("nav.projects")}
            </p>
            <ul className="nav-list" aria-labelledby="nav-projects">
              {projects.map((entry) => area(entry, <FolderIcon size={15} />))}
            </ul>
          </>
        )}

        {!m.emptyMode && (
          <>
            <div className="nav-section-row">
              <p className="nav-section" id="nav-colors">
                {t("notes.colors")}
              </p>
              {/* Kept in place while nothing is chosen, so choosing moves nothing. */}
              <button
                type="button"
                className="link-button nav-clear"
                hidden={m.colors.size === 0}
                onClick={m.clearColors}
              >
                {t("notes.colorFilterClear")}
              </button>
            </div>
            <ul className="nav-colors" aria-labelledby="nav-colors">
              {NOTE_COLORS.map((color) => {
                const name = colorName(color, m.colorNames, t);
                const on = m.colors.has(color);
                const count = m.counts.get(color) ?? 0;
                return (
                  <li key={color}>
                    <button
                      type="button"
                      className="nav-dot"
                      aria-pressed={on}
                      aria-label={`${name} (${String(count)})`}
                      title={`${name} (${String(count)})`}
                      {...entryProps(`color:${color}`)}
                      onClick={() => {
                        m.toggleColor(color);
                        // A color filters the notes: from the trash or the settings, it leads back.
                        if (m.place !== null) m.goTo(m.shownScope);
                      }}
                    >
                      <span className="swatch-dot" style={dotStyle(color)}>
                        {on && <CheckIcon size={12} />}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        <span className="nav-fill" />

        <ul className="nav-list nav-foot">
          <li>
            <button
              type="button"
              className="nav-item"
              data-focus-id="trash"
              aria-current={m.place === "trash" ? "page" : undefined}
              {...entryProps("trash")}
              onClick={() => {
                m.openPlace("trash");
                close();
              }}
            >
              <TrashIcon size={15} />
              <span className="nav-label">{t("notes.trash")}</span>
            </button>
          </li>
          <li>
            <button
              type="button"
              className="nav-item"
              data-focus-id="settings"
              aria-current={m.place === "settings" ? "page" : undefined}
              {...entryProps("settings")}
              onClick={() => {
                m.openPlace("settings");
                close();
              }}
            >
              <GearIcon size={15} />
              <span className="nav-label">{t("notes.settings")}</span>
            </button>
          </li>
        </ul>
      </div>
    </nav>
  );
}
