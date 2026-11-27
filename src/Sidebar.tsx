// The one navigation of the notes area, the same in every look (ADR 0004). At the top, as in
// Hangar, the app menu (the three lines), the logo and the name with the version; a line across the
// whole sidebar below. Where that line meets the sidebar's right edge sits Hangar's round button
// that folds the sidebar away and back (Ctrl+Shift+S, EdgeToggle below; NotesArea.tsx places it). Under it the three levels ("Private", "Project", "Team", LevelBar.tsx), then "All notes",
// the project folders by their name (choosing one shows it in the "Project" level; the section is
// called "Project folders" so it never reads as a second "Project"), the colors as
// a category list (sidebarColors.ts), and fixed at the bottom, behind a line, one row of icon buttons
// without text (the name is their label and tooltip): "Recently deleted", "Settings" and the switch
// between light and dark (on is dark; it saves the opposite of the shown theme outright, the
// settings page keeps "Same as system"). The current place is marked (`aria-current`). The arrow
// keys, Home and End move between the entries, the row's buttons included (one Tab stop for all of
// them; Up and Left go back, Down and Right go on, so in the bottom row the arrows point where they
// move, shortcuts.ts). Below NAV_MIN_WIDTH the sidebar opens over the notes instead,
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
  MoonIcon,
  NotesIcon,
  SunIcon,
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
 * The round button on the sidebar's edge, as in Hangar: a small circle with a chevron on the
 * crossing of the sidebar's right edge and the line below its head (styles.css). `open`: the
 * sidebar beside it is shown, the chevron points left (fold away); otherwise it points right.
 */
export function EdgeToggle({
  open,
  label,
  keys,
  controls,
  dialog = false,
  expanded = open,
  focusId,
  inert,
  onToggle,
}: {
  open: boolean;
  label: string;
  /** The shortcut for the tooltip ("Strg+Umschalt+S"). */
  keys?: string;
  /** The sidebar's element id, while it is in the page. */
  controls?: string | undefined;
  /** Whether it opens the sidebar as a dialog over the notes (a narrow window). */
  dialog?: boolean;
  expanded?: boolean;
  focusId?: string;
  inert?: boolean;
  onToggle: (button: HTMLButtonElement) => void;
}) {
  return (
    <button
      type="button"
      className={open ? "edge-toggle" : "edge-toggle collapsed"}
      data-focus-id={focusId}
      aria-label={label}
      aria-expanded={expanded}
      aria-controls={controls}
      aria-haspopup={dialog ? "dialog" : undefined}
      title={keys === undefined ? label : `${label} (${keys})`}
      inert={inert}
      onClick={(event) => {
        onToggle(event.currentTarget);
      }}
    >
      <ChevronDownIcon size={12} />
    </button>
  );
}

/**
 * The sidebar. `overlay`: shown over the notes in a narrow window, as a modal dialog that
 * `onClose` closes (Escape, its round edge button, a click beside it, or a choice).
 */
export function Sidebar({
  m,
  id,
  menu,
  overlay = false,
  onClose,
}: {
  m: NotesModel;
  /** The element id the fold buttons name in `aria-controls`. */
  id?: string;
  /** The app menu's groups, built when it opens. */
  menu: () => AppMenuGroup[];
  overlay?: boolean;
  onClose?: () => void;
}) {
  const { t } = m;
  /** The whole sidebar: the entries of the roving focus lie in the list and in the bottom row. */
  const list = useRef<HTMLElement>(null);
  const currentKey = m.place ?? m.scopeEntries.find((entry) => m.isShownScope(entry))?.key ?? "all";
  /** The entry that takes the sidebar's one Tab stop: the last focused, else the current one. */
  const [tabKey, setTabKey] = useState<string | null>(null);
  const colors = useColorSection(m);
  const keys = [
    ...m.scopeEntries.map((entry) => entry.key),
    ...colors.keys,
    "trash",
    "settings",
    "theme",
  ];
  const stop = tabKey !== null && keys.includes(tabKey) ? tabKey : currentKey;
  const { number, beta } = versionParts(APP_VERSION);

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
      ref={list}
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
      </div>

      <div className="nav-levels">
        <LevelBar m={m} onChosen={close} />
      </div>

      <div className="nav-scroll">
        <ul className="nav-list">{main.map((entry) => area(entry, <NotesIcon size={16} />))}</ul>

        {projects.length > 0 && (
          <>
            <p className="nav-section" id="nav-projects">
              <span className="nav-section-label">{t("nav.projects")}</span>
            </p>
            <ul className="nav-list" aria-labelledby="nav-projects">
              {projects.map((entry) => area(entry, <FolderIcon size={16} />))}
            </ul>
          </>
        )}

        {colors.shown && <ColorList m={m} colors={colors} entryProps={entryProps} list={list} />}
      </div>

      {/* Outside the scrolling list: it stays at the bottom and its line runs edge to edge. */}
      <ul className="nav-foot">
        <li>
          <button
            type="button"
            className="icon-button nav-foot-button"
            data-focus-id="trash"
            aria-current={m.place === "trash" ? "page" : undefined}
            aria-label={t("notes.trash")}
            title={t("notes.trash")}
            {...entryProps("trash")}
            onClick={() => {
              m.openPlace("trash");
              close();
            }}
          >
            <TrashIcon size={16} />
          </button>
        </li>
        <li>
          <button
            type="button"
            className="icon-button nav-foot-button"
            data-focus-id="settings"
            aria-current={m.place === "settings" ? "page" : undefined}
            aria-label={t("notes.settings")}
            title={t("notes.settings")}
            {...entryProps("settings")}
            onClick={() => {
              m.openPlace("settings");
              close();
            }}
          >
            <GearIcon size={16} />
          </button>
        </li>
        <li>
          {/* Stays open over the notes: the change shows at once, nothing to close for. */}
          <button
            type="button"
            className="icon-button nav-foot-button"
            role="switch"
            aria-checked={m.theme === "dark"}
            aria-label={t("nav.darkTheme")}
            title={t("nav.darkTheme")}
            {...entryProps("theme")}
            onClick={m.toggleTheme}
          >
            {m.theme === "dark" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
          </button>
        </li>
      </ul>
      {/* Over the notes the sidebar brings its own: the one beside the notes waits behind it. */}
      {overlay && (
        <EdgeToggle
          open
          label={t("nav.close")}
          keys={sidebarShortcutLabel(PLATFORM, t)}
          onToggle={close}
        />
      )}
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
  list: React.RefObject<HTMLElement | null>;
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
          <span className="nav-section-label" id="nav-colors">
            {t("notes.colors")}
          </span>
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
                <ChevronDownIcon size={16} />
                <span className="nav-label">
                  {t(section.all ? "nav.colorsShowFewer" : "nav.colorsShowAll")}
                </span>
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
