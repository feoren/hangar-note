// The notes area (ADR 0002, phase 1) in the look the settings name (ADR 0004). Its logic lives
// once in useNotesArea.tsx; this file lays out the one sidebar (Sidebar.tsx: the app menu, the
// levels "Private", "Project", "Team", the places and the colors) beside the view (notes, team,
// trash, settings) in the layout of the look: hangar (HangarLayout, or HangarNarrowLayout where
// its two columns do not fit) or paper (PaperLayout). Each layout
// shows the look switch (LookSwitch.tsx) at the top right of the notes. Beside the
// sidebar there is no bar: the notes and the note, nothing else; notices float at the bottom. The
// sidebar can be folded away (a small button at the top left brings it back) and widened by
// dragging its edge; both are stored in settings.json. A narrow window folds it away always and
// opens it over the notes instead. Switching the look keeps the open note, its unsaved text and
// its pending save; only the editor's element changes, and the editor follows it. Paper is the one
// exception: its sheet opens only by choice, so the open note is saved and closed first
// (useNotesArea.tsx, `m.look`).

import { useEffect, useRef, useState, type ReactNode } from "react";

import { setListWidth, setSidebarOpen, setSidebarWidth } from "./api";
import type { AppSettings } from "./appSettings";
import { HangarLayout, LIST_ID } from "./HangarLayout";
import { HangarNarrowLayout } from "./HangarNarrowLayout";
import type { AppMenuGroup, AppMenuItem } from "./AppMenu";
import { appMenuGroups } from "./appMenuItems";
import { ColumnResize } from "./ColumnResize";
import {
  clampColumnWidth,
  LIST_COLUMN,
  SIDEBAR_COLUMN,
  SIDEBAR_WIDTH_DEFAULT,
} from "./columnWidth";
import { KeysDialog } from "./KeysDialog";
import { LEVEL_PANEL_ID, levelTabId, TeamLevel } from "./LevelBar";
import { layoutFor, narrowRoom, navFolded, type Layout } from "./looks";
import { LookSwitch } from "./LookSwitch";
import { NotesSettings } from "./NotesSettings";
import { PaperLayout } from "./PaperLayout";
import { matchSidebarShortcut, sidebarShortcutLabel } from "./shortcuts";
import { EdgeToggle, Sidebar } from "./Sidebar";
import { Trash } from "./Trash";
import { PLATFORM, useNotesArea, type NotesModel } from "./useNotesArea";

const SIDEBAR_ID = "notes-sidebar";

function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const follow = () => {
      setWidth(window.innerWidth);
    };
    window.addEventListener("resize", follow);
    return () => {
      window.removeEventListener("resize", follow);
    };
  }, []);
  return width;
}

/**
 * Whether the sidebar is shown: what this window set wins over what the settings brought. Each
 * change is stored at once; a backend that does not know the setting yet (before a restart)
 * answers an error, the change then holds while the app runs, and nothing needs saying.
 */
function useSidebarOpen(app: AppSettings) {
  const [openSet, setOpenSet] = useState<boolean | null>(null);
  const open = openSet ?? app.settings?.sidebarOpen ?? true;
  return {
    open,
    setOpen: (next: boolean) => {
      setOpenSet(next);
      void setSidebarOpen(next).catch(() => null);
    },
  };
}

/**
 * A column's chosen width (`null`: none, the column's natural width): what this window set wins
 * over what the settings brought, and a drag in progress over both. The wish is kept as chosen;
 * the shown width is brought into the window's range where it is used, so a smaller window
 * narrows the column without forgetting the wish. Stored only when a drag ends, a key moves the
 * edge or it is reset; an older backend's error is ignored as for the open state.
 */
function useColumnWish<T extends number | null>(stored: T, save: (width: T) => Promise<unknown>) {
  const [chosen, setChosen] = useState<{ width: T } | null>(null);
  const [dragged, setDragged] = useState<number | null>(null);
  return {
    wish: dragged ?? (chosen === null ? stored : chosen.width),
    /** While dragging: shown at once, not stored. */
    show: setDragged,
    store: (next: T) => {
      setDragged(null);
      setChosen({ width: next });
      void save(next).catch(() => null);
    },
    cancel: () => {
      setDragged(null);
    },
  };
}

export function NotesArea({ app }: { app: AppSettings }) {
  const m = useNotesArea(app);
  const windowWidth = useWindowWidth();
  const folded = navFolded(windowWidth);
  const side = useSidebarOpen(app);
  const sideWish = useColumnWish(
    app.settings?.sidebarWidth ?? SIDEBAR_WIDTH_DEFAULT,
    setSidebarWidth,
  );
  const listWish = useColumnWish(app.settings?.listWidth ?? null, setListWidth);
  const sideShown = !folded && side.open;
  const sideWidth = clampColumnWidth(SIDEBAR_COLUMN, sideWish.wish, windowWidth);
  const layout = layoutFor(m.look, windowWidth, sideShown ? sideWidth : 0);
  const narrow = narrowRoom(windowWidth, sideShown ? sideWidth : 0);
  /** The room beside the sidebar, where hangar's list and note share the width. */
  const listRoom = windowWidth - (sideShown ? sideWidth : 0);
  const listWidth = clampColumnWidth(LIST_COLUMN, listWish.wish, listRoom);
  const [overlay, setOverlay] = useState(false);
  const opener = useRef<HTMLElement | null>(null);

  const [keysShown, setKeysShown] = useState(false);
  /**
   * Whether the round edge button takes the focus once the sidebar opened or folded away: a focus
   * inside the folded sidebar would otherwise fall to the page.
   */
  const refocus = useRef(false);

  const closeOverlay = () => {
    setOverlay(false);
  };
  const sideRef = useRef<HTMLDivElement>(null);
  const toggle = (from: HTMLElement | null) => {
    if (folded) {
      opener.current = from;
      setOverlay((shown) => !shown);
      return;
    }
    // The edge button stays where it is in both states and keeps its focus; a focus inside the
    // sidebar moves onto it.
    const active = document.activeElement;
    refocus.current =
      active instanceof HTMLElement &&
      (sideRef.current?.contains(active) === true || active.dataset.focusId === "nav");
    side.setOpen(!side.open);
  };
  const toggleRef = useRef(toggle);
  useEffect(() => {
    toggleRef.current = toggle;
  });

  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    document.querySelector<HTMLElement>('[data-focus-id="nav"]')?.focus();
  }, [side.open]);

  // Ctrl+Shift+S from anywhere in the window, the editor too (it has no use for it).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!matchSidebarShortcut(event, PLATFORM)) return;
      event.preventDefault();
      toggleRef.current(document.querySelector<HTMLElement>('[data-focus-id="nav"]'));
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // Closed: the focus goes back to the button that opened it, once the notes are no longer inert,
  // unless the choice put it somewhere on purpose (the trash's "Back").
  useEffect(() => {
    if (overlay) return;
    const from = opener.current;
    opener.current = null;
    const active = document.activeElement;
    if (from?.isConnected && (active === null || active === document.body)) from.focus();
  }, [overlay]);
  const shownOverlay = folded && overlay;
  /** The paper look's open note is a modal sheet: the sidebar waits behind it. */
  const behindSheet = layout === "paper" && m.view === "browse" && m.note !== null;

  /**
   * The sidebar's width for styles.css (`--side-width`), and the list's once one is chosen
   * (`--list-width`); without a choice styles.css lets the list grow with the room.
   */
  const shellStyle: Record<string, string> = { "--side-width": `${String(sideWidth)}px` };
  if (listWish.wish !== null) shellStyle["--list-width"] = `${String(listWidth)}px`;
  const listResize = (
    <ColumnResize
      spec={LIST_COLUMN}
      className="list-resize"
      label={m.t("notes.listResize")}
      hint={m.t("nav.resizeHint")}
      controls={LIST_ID}
      width={listWidth}
      room={listRoom}
      onShow={listWish.show}
      onStore={listWish.store}
      onCancel={listWish.cancel}
      onReset={() => {
        listWish.store(null);
      }}
    />
  );
  const toggleSide = () => {
    toggle(document.querySelector<HTMLElement>('[data-focus-id="nav"]'));
  };
  /**
   * An app menu choice made in the sidebar over the notes closes it first: what it does (a new
   * note, the search) happens in the notes, which are inert while it is open. The choice runs once
   * the notes are back, after the focus returned to the opener. The sidebar's own toggle is left
   * as it is, it closes the sidebar itself.
   */
  const fromOverlay = (groups: AppMenuGroup[]): AppMenuGroup[] => {
    if (!shownOverlay) return groups;
    const wrap = (item: AppMenuItem): AppMenuItem => {
      if (item.type === "submenu") return { ...item, items: item.items.map(wrap) };
      if (item.type !== "action" || item.run === toggleSide) return item;
      const run = item.run;
      return {
        ...item,
        run: () => {
          closeOverlay();
          requestAnimationFrame(run);
        },
      };
    };
    return groups.map((group) => ({ ...group, items: group.items.map(wrap) }));
  };
  /** Built when the menu opens, so it always shows the current state. */
  const menu = () => fromOverlay(menuGroups());
  const menuGroups = (): AppMenuGroup[] =>
    appMenuGroups(
      m,
      { shown: folded ? shownOverlay : side.open, toggle: toggleSide },
      m.look,
      () => {
        setKeysShown(true);
      },
    );
  /** Whether the sidebar is shown beside the notes, where the edge button folds it away. */
  const besideShown = !folded && side.open;

  return (
    <div
      className={`notes-shell look-${layout}`}
      data-nav={folded ? "folded" : "open"}
      data-side={sideShown ? "open" : "closed"}
      style={shellStyle}
    >
      {!folded && (
        <div className="shell-side" ref={sideRef} inert={behindSheet || !side.open}>
          <Sidebar m={m} id={SIDEBAR_ID} menu={menu} />
          <ColumnResize
            spec={SIDEBAR_COLUMN}
            className="side-resize"
            label={m.t("nav.resize")}
            hint={m.t("nav.resizeHint")}
            controls={SIDEBAR_ID}
            width={sideWidth}
            room={windowWidth}
            onShow={sideWish.show}
            onStore={sideWish.store}
            onCancel={sideWish.cancel}
            onReset={() => {
              sideWish.store(SIDEBAR_WIDTH_DEFAULT);
            }}
          />
        </div>
      )}
      {/* One button in one place: on the sidebar's edge, at the window's edge while it is away. */}
      <EdgeToggle
        open={besideShown}
        label={m.t(besideShown ? "nav.hide" : "nav.show")}
        keys={sidebarShortcutLabel(PLATFORM, m.t)}
        controls={folded ? undefined : SIDEBAR_ID}
        dialog={folded}
        expanded={folded ? shownOverlay : side.open}
        focusId="nav"
        inert={behindSheet || shownOverlay}
        onToggle={toggle}
      />
      <main className="shell-main" inert={shownOverlay}>
        <div
          className="level-panel"
          id={LEVEL_PANEL_ID}
          role={m.level === null || m.view !== "browse" || !sideShown ? undefined : "tabpanel"}
          aria-labelledby={m.level === null || !sideShown ? undefined : levelTabId(m.level)}
        >
          <View m={m} app={app} layout={layout} narrow={narrow} listResize={listResize} />
        </div>
        {/* The one notice place, floating at the bottom; the paper look's sheet holds its own. */}
        {!behindSheet && <div className="notice-float">{m.noticeSlot}</div>}
      </main>
      {shownOverlay && (
        <div className="nav-layer">
          <div className="nav-scrim" aria-hidden="true" onClick={closeOverlay} />
          <div
            className="nav-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={m.t("notes.scopes")}
          >
            <Sidebar m={m} menu={menu} overlay onClose={closeOverlay} />
          </div>
        </div>
      )}
      {keysShown && (
        <KeysDialog
          m={m}
          onClose={() => {
            setKeysShown(false);
          }}
        />
      )}
      {m.popup}
    </div>
  );
}

/**
 * The notes in the look's layout, the team level, or the trash or the settings in their place.
 * Those two keep their "Back" in a narrow window, where the sidebar is folded away.
 */
function View({
  m,
  app,
  layout,
  narrow,
  listResize,
}: {
  m: NotesModel;
  app: AppSettings;
  layout: Layout;
  narrow: boolean;
  /** The list's edge in hangar's two columns; the other layouts have no such edge. */
  listResize: ReactNode;
}) {
  if (m.view === "settings" || m.view === "trash") {
    return (
      <div className={layout === "paper" ? "notes-area single on-table" : "notes-area single"}>
        <div className="single-main">
          {m.view === "settings" ? (
            <NotesSettings app={app} onBack={m.backToNotes} />
          ) : (
            <Trash
              folders={m.listFolders}
              mixed={m.mixed}
              language={m.language}
              now={m.now}
              theme={m.theme}
              writable={m.writable}
              projectLabel={m.projectLabel}
              onRestore={m.restore}
              onBack={m.backToNotes}
            />
          )}
        </div>
      </div>
    );
  }
  // The team level in place of the notes. An open note waits with its text and its pending save,
  // as behind the trash, and is there again on the way back.
  if (m.shownScope.kind === "team") {
    return (
      <div className={layout === "paper" ? "notes-area single on-table" : "notes-area single"}>
        <div className="single-main">
          <div className="pane-tools">
            <LookSwitch m={m} />
          </div>
          <TeamLevel m={m} />
        </div>
      </div>
    );
  }
  if (layout === "paper") return <PaperLayout m={m} />;
  if (layout === "hangar") return <HangarLayout m={m} listResize={listResize} />;
  return <HangarNarrowLayout m={m} narrow={narrow} />;
}
