// The one navigation of the notes area, the same in every look (ADR 0004). At the top, as in
// Hangar, the app menu (the three lines), the logo, the name with the version, and at the right
// edge the button that folds the sidebar away (Ctrl+Shift+S); a line across the whole sidebar
// below. Under it the three levels ("Private", "Project", "Team", LevelBar.tsx), then "All notes",
// the projects by their folder name (choosing one shows it in the "Project" level), the colors as
// a category list (sidebarColors.ts), and at the bottom "Recently deleted" and "Settings". The
// current place is marked (`aria-current`). The arrow keys, Home and End move between the entries
// (one Tab stop for all of them). Below NAV_MIN_WIDTH the sidebar opens over the notes instead,
// and choosing a place closes it.

import { useEffect, useRef, useState, type ReactNode } from "react";

import { AppMenu, type AppMenuGroup } from "./AppMenu";
import {
  colorLabelKey,
  colorName,
  MAX_COLOR_NAME_LENGTH,
  noteTone,
  swatchColor,
  type NoteColor,
} from "./colors";
import {
  AppLogo,
  ChevronDownIcon,
  FolderIcon,
  GearIcon,
  NotesIcon,
  SidebarIcon,
  TrashIcon,
} from "./icons";
import { LevelBar } from "./LevelBar";
import { matchColorRowShortcut, sidebarShortcutLabel, sidebarTarget } from "./shortcuts";
import {
  colorRows,
  hasHiddenColors,
  rememberColorSection,
  rememberedColorSection,
  type ColorSection,
} from "./sidebarColors";
import { PLATFORM, type NotesModel, type ScopeEntry } from "./useNotesArea";
import { APP_VERSION, versionParts } from "./version";

/**
 * The sidebar. `overlay`: shown over the notes in a narrow window, as a modal dialog that
 * `onClose` closes (Escape, its fold button, a click beside it, or a choice). `onFold` folds the
 * sidebar away in a wide window.
 */
export function Sidebar({
  m,
  id,
  menu,
  overlay = false,
  onClose,
  onFold,
}: {
  m: NotesModel;
  /** The element id the fold buttons name in `aria-controls`. */
  id?: string;
  /** The app menu's groups, built when it opens. */
  menu: () => AppMenuGroup[];
  overlay?: boolean;
  onClose?: () => void;
  onFold?: () => void;
}) {
  const { t } = m;
  const list = useRef<HTMLDivElement>(null);
  const currentKey = m.place ?? m.scopeEntries.find((entry) => m.isShownScope(entry))?.key ?? "all";
  /** The entry that takes the sidebar's one Tab stop: the last focused, else the current one. */
  const [tabKey, setTabKey] = useState<string | null>(null);
  const colors = useColorSection(m);
  const keys = [...m.scopeEntries.map((entry) => entry.key), ...colors.keys, "trash", "settings"];
  const stop = tabKey !== null && keys.includes(tabKey) ? tabKey : currentKey;
  const { number, beta } = versionParts(APP_VERSION);
  const foldLabel = `${t("nav.hide")} (${sidebarShortcutLabel(PLATFORM, t)})`;

  // Opened over the notes, the focus goes onto the current place.
  useEffect(() => {
    if (!overlay) return;
    list.current?.querySelector<HTMLElement>('[tabindex="0"][data-nav]')?.focus();
  }, [overlay]);

  const close = () => {
    onClose?.();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (overlay && event.key === "Escape" && !event.defaultPrevented) {
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
            m.goToEntry(entry);
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
      id={id}
      className={overlay ? "nav nav-overlay" : "nav"}
      aria-label={t("notes.scopes")}
      onKeyDown={onKeyDown}
    >
      <div className="nav-head">
        <AppMenu groups={menu} label={t("menu.label")} />
        <span className="brand" title={`${t("app.name")} ${number}`}>
          <AppLogo />
          <span className="brand-name">{t("app.name")}</span>
          <span className="brand-version">
            {number}
            {beta && <span className="beta-badge">{t("version.beta")}</span>}
          </span>
        </span>
        <button
          type="button"
          className="icon-button side-fold"
          data-focus-id={overlay ? undefined : "nav-fold"}
          aria-label={t(overlay ? "nav.close" : "nav.hide")}
          aria-expanded="true"
          aria-controls={id}
          title={overlay ? t("nav.close") : foldLabel}
          onClick={overlay ? close : onFold}
        >
          <SidebarIcon size={16} />
        </button>
      </div>

      <div className="nav-levels">
        <LevelBar m={m} onChosen={close} />
      </div>

      <div className="nav-scroll" ref={list}>
        <ul className="nav-list">{main.map((entry) => area(entry, <NotesIcon size={15} />))}</ul>

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

        {colors.shown && <ColorList m={m} colors={colors} entryProps={entryProps} list={list} />}

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

interface ColorSectionState {
  /** Whether the section is there at all: only while the shown notes have colors to filter. */
  shown: boolean;
  section: ColorSection;
  setSection: (next: ColorSection) => void;
  rows: ReturnType<typeof colorRows>;
  /** Whether "Show all colors" has something to add. */
  more: boolean;
  /** The section's entries in the roving focus, in their order. */
  keys: string[];
}

/**
 * The color section's state. The counts are those of the shown list (what the filter filters);
 * while a list or a search is still on its way, the last known counts stay, so rows never flicker
 * away and back.
 */
function useColorSection(m: NotesModel): ColorSectionState {
  const [section, setSectionState] = useState(rememberedColorSection);
  const known = m.list !== null && (!m.searching || m.shownHits !== null);
  const countsKey = known ? JSON.stringify(Array.from(m.counts)) : null;
  const [last, setLast] = useState<{ key: string | null; counts: ReadonlyMap<NoteColor, number> }>(
    () => ({ key: countsKey, counts: known ? m.counts : new Map() }),
  );
  // Taken over while rendering (React's pattern for state that follows a prop), not in an effect.
  if (countsKey !== null && countsKey !== last.key) setLast({ key: countsKey, counts: m.counts });
  const counts = countsKey !== null ? m.counts : last.counts;

  const setSection = (next: ColorSection) => {
    setSectionState(next);
    rememberColorSection(next);
  };
  const short = colorRows(counts, m.colors, false);
  const shown = !m.emptyMode && short.length > 0;
  const more = hasHiddenColors(counts, m.colors);
  const rows = colorRows(counts, m.colors, section.all && more);
  const keys = !shown
    ? []
    : [
        "colors",
        ...(section.open
          ? [...rows.map((row) => `color:${row.color}`), ...(more ? ["colors-all"] : [])]
          : []),
      ];
  return { shown, section, setSection, rows, more, keys };
}

/** The color as a small rounded square: its note tone inside, its stronger edge tone around. */
function swatchStyle(color: NoteColor, m: NotesModel): Record<string, string> {
  return { "--dot": swatchColor(color), "--edge": noteTone(color, m.theme).edge };
}

function ColorList({
  m,
  colors,
  entryProps,
  list,
}: {
  m: NotesModel;
  colors: ColorSectionState;
  entryProps: (key: string) => {
    "data-nav": string;
    tabIndex: number;
    onFocus: () => void;
  };
  list: React.RefObject<HTMLDivElement | null>;
}) {
  const { t } = m;
  const { section, setSection, rows, more } = colors;
  const chosen = rows.filter((row) => m.colors.has(row.color));

  /** Back onto the color's row after renaming it with the keyboard. */
  const focusRow = (color: NoteColor) => {
    requestAnimationFrame(() => {
      list.current?.querySelector<HTMLElement>(`[data-nav="color:${color}"]`)?.focus();
    });
  };

  return (
    <>
      <div className="nav-section-row">
        <button
          type="button"
          className="nav-section nav-section-toggle"
          aria-expanded={section.open}
          aria-controls="nav-color-list"
          {...entryProps("colors")}
          onClick={() => {
            setSection({ ...section, open: !section.open });
          }}
        >
          <span id="nav-colors">{t("notes.colors")}</span>
          <ChevronDownIcon size={12} />
          {/* Folded with a filter on: the chosen colors stay in sight. */}
          {!section.open &&
            chosen.map((row) => (
              <span
                key={row.color}
                className="nav-swatch"
                style={swatchStyle(row.color, m)}
                aria-hidden="true"
              />
            ))}
        </button>
        {/* Kept in place while nothing is chosen, so choosing moves nothing. */}
        <button
          type="button"
          className="link-button nav-clear"
          hidden={m.colors.size === 0}
          onClick={m.clearColors}
        >
          {t("nav.colorsClear")}
        </button>
      </div>
      {section.open && (
        <ul className="nav-colors" id="nav-color-list" aria-labelledby="nav-colors">
          {rows.map(({ color, count }) => {
            const name = colorName(color, m.colorNames, t);
            const on = m.colors.has(color);
            if (m.renamingColor === color) {
              return (
                <li key={color}>
                  <ColorRename
                    m={m}
                    color={color}
                    name={name}
                    swatch={swatchStyle(color, m)}
                    onDone={(refocus) => {
                      m.setRenamingColor(null);
                      if (refocus) focusRow(color);
                    }}
                  />
                </li>
              );
            }
            const label = [
              t("nav.colorNotes", { name, count }),
              ...(on ? [t("nav.colorFilterOn")] : []),
            ].join(", ");
            return (
              <li key={color}>
                <button
                  type="button"
                  className={count === 0 ? "nav-item nav-color unused" : "nav-item nav-color"}
                  aria-pressed={on}
                  aria-label={label}
                  title={`${name}\n${t("nav.colorRenameHint")}`}
                  {...entryProps(`color:${color}`)}
                  onClick={() => {
                    m.toggleColor(color);
                    // A color filters the notes: from the trash or the settings, it leads back.
                    if (m.place !== null) m.goTo(m.shownScope);
                  }}
                  onDoubleClick={() => {
                    m.setRenamingColor(color);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    m.openColorMenu(color, event.currentTarget, {
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                  onKeyDown={(event) => {
                    const action = matchColorRowShortcut(event);
                    if (action === null) return;
                    event.preventDefault();
                    if (action === "rename") m.setRenamingColor(color);
                    else m.openColorMenu(color, event.currentTarget);
                  }}
                >
                  <span className="nav-swatch" style={swatchStyle(color, m)} aria-hidden="true" />
                  <span className="nav-label">{name}</span>
                  {count > 0 && <span className="nav-count">{count}</span>}
                </button>
              </li>
            );
          })}
          {more && (
            <li>
              <button
                type="button"
                className="nav-item nav-more"
                aria-expanded={section.all}
                {...entryProps("colors-all")}
                onClick={() => {
                  setSection({ ...section, all: !section.all });
                }}
              >
                {t(section.all ? "nav.colorsShowFewer" : "nav.colorsShowAll")}
              </button>
            </li>
          )}
        </ul>
      )}
    </>
  );
}

/**
 * A color's name edited in place: Enter saves, Escape keeps the old name, leaving the field saves
 * as well. A blank name, or the color's own name in the UI language, gives that name back.
 */
function ColorRename({
  m,
  color,
  name,
  swatch,
  onDone,
}: {
  m: NotesModel;
  color: NoteColor;
  name: string;
  swatch: Record<string, string>;
  /** `refocus`: finished with the keyboard, the row takes the focus back. */
  onDone: (refocus: boolean) => void;
}) {
  const { t } = m;
  const done = useRef(false);
  const defaultName = t(colorLabelKey(color));

  const finish = (value: string | null, refocus: boolean) => {
    if (done.current) return;
    done.current = true;
    if (value !== null) m.renameColor(color, value.trim() === defaultName ? "" : value);
    onDone(refocus);
  };

  return (
    <div className="nav-item nav-color renaming">
      <span className="nav-swatch" style={swatch} aria-hidden="true" />
      <input
        className="nav-rename"
        type="text"
        defaultValue={name}
        placeholder={defaultName}
        aria-label={t("settings.colorNameOf", { color: defaultName })}
        maxLength={MAX_COLOR_NAME_LENGTH}
        autoComplete="off"
        spellCheck={false}
        // The field replaces the row the person just chose to rename.
        autoFocus
        onFocus={(event) => {
          event.currentTarget.select();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            finish(event.currentTarget.value, true);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            finish(null, true);
          }
        }}
        onBlur={(event) => {
          finish(event.currentTarget.value, false);
        }}
      />
    </div>
  );
}
