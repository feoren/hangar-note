// The notes area (ADR 0002, phase 1) in the look the settings name (ADR 0004). Its logic lives
// once in useNotesArea.tsx; this file lays out the one sidebar (Sidebar.tsx) beside the level bar
// (LevelBar.tsx: the sidebar button and the tabs "Private", "Project", "Team") and the view below
// it (notes, team, trash, settings) in the layout of the look: calm (CalmLayout), paper
// (PaperLayout) or hangar (HangarLayout), which falls back to calm's layout where its columns do
// not fit. The sidebar can be folded away and widened by dragging its edge; both are stored in
// settings.json. A narrow window folds it away always and opens it over the notes instead.
// Switching the look keeps the open note, its unsaved text and its pending save; only the
// editor's element changes, and the editor follows it.

import { useEffect, useRef, useState } from "react";

import { setSidebarOpen, setSidebarWidth } from "./api";
import type { AppSettings } from "./appSettings";
import { CalmLayout } from "./CalmLayout";
import { HangarLayout } from "./HangarLayout";
import { LEVEL_PANEL_ID, LevelBar, levelTabId, TeamLevel, type SideToggle } from "./LevelBar";
import { layoutFor, navFolded, type Look } from "./looks";
import { NotesSettings } from "./NotesSettings";
import { PaperLayout } from "./PaperLayout";
import { matchSidebarShortcut } from "./shortcuts";
import { Sidebar } from "./Sidebar";
import {
  clampSidebarWidth,
  separatorWidth,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MIN,
  maxSidebarWidth,
} from "./sidebarWidth";
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
 * The sidebar's stored state (shown, width): what this window set wins over what the settings
 * brought. Each change is stored at once; a backend that does not know these settings yet (before
 * a restart) answers an error, the change then holds while the app runs, and nothing needs saying.
 */
function useSidebarState(app: AppSettings) {
  const [openSet, setOpenSet] = useState<boolean | null>(null);
  const [widthSet, setWidthSet] = useState<number | null>(null);
  const open = openSet ?? app.settings?.sidebarOpen ?? true;
  const width = widthSet ?? app.settings?.sidebarWidth ?? SIDEBAR_WIDTH_DEFAULT;
  return {
    open,
    width,
    setOpen: (next: boolean) => {
      setOpenSet(next);
      void setSidebarOpen(next).catch(() => null);
    },
    /** While dragging: shown at once, stored only with `storeWidth` when the drag ends. */
    showWidth: setWidthSet,
    storeWidth: (next: number) => {
      setWidthSet(next);
      void setSidebarWidth(next).catch(() => null);
    },
  };
}

export function NotesArea({ app }: { app: AppSettings }) {
  const m = useNotesArea(app);
  const windowWidth = useWindowWidth();
  const folded = navFolded(windowWidth);
  const side = useSidebarState(app);
  const sideShown = !folded && side.open;
  const sideWidth = clampSidebarWidth(side.width, windowWidth);
  const layout = layoutFor(app.look, windowWidth, sideShown ? sideWidth : 0);
  const [overlay, setOverlay] = useState(false);
  const opener = useRef<HTMLElement | null>(null);

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
    // Folding it away makes the sidebar inert: a focus inside it (Ctrl+Shift+S from a sidebar
    // entry) would fall to the page, so it moves to the button that brings the sidebar back.
    if (side.open && sideRef.current?.contains(document.activeElement)) from?.focus();
    side.setOpen(!side.open);
  };
  const toggleRef = useRef(toggle);
  useEffect(() => {
    toggleRef.current = toggle;
  });

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
  /** The paper look's open note is a modal sheet: the sidebar and the tabs wait behind it. */
  const behindSheet = layout === "paper" && m.view === "browse" && m.note !== null;

  /** The sidebar's width for styles.css (`--side-width`). */
  const shellStyle: Record<string, string> = { "--side-width": `${String(sideWidth)}px` };
  const toggleState: SideToggle = {
    expanded: folded ? shownOverlay : side.open,
    folded,
    controls: folded ? undefined : SIDEBAR_ID,
    onToggle: toggle,
  };

  return (
    <div
      className={`notes-shell look-${layout}`}
      data-nav={folded ? "folded" : "open"}
      data-side={sideShown ? "open" : "closed"}
      style={shellStyle}
    >
      {!folded && (
        <div className="shell-side" ref={sideRef} inert={behindSheet || !side.open}>
          <Sidebar m={m} id={SIDEBAR_ID} />
          <ResizeHandle
            label={m.t("nav.resize")}
            hint={m.t("nav.resizeHint")}
            width={sideWidth}
            windowWidth={windowWidth}
            onShow={side.showWidth}
            onStore={side.storeWidth}
          />
        </div>
      )}
      <main className="shell-main" inert={shownOverlay}>
        <div className="level-row" inert={behindSheet}>
          <LevelBar m={m} side={toggleState} />
        </div>
        <div
          className="level-panel"
          id={LEVEL_PANEL_ID}
          role={m.level === null || m.view !== "browse" ? undefined : "tabpanel"}
          aria-labelledby={m.level === null ? undefined : levelTabId(m.level)}
        >
          <View m={m} app={app} layout={layout} />
        </div>
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
            <Sidebar m={m} overlay onClose={closeOverlay} />
          </div>
        </div>
      )}
      {m.popup}
    </div>
  );
}

/**
 * The sidebar's right edge: dragged with the mouse or a pen, moved with the arrow keys (Shift: a
 * larger step), Home and End; a double click gives it its default width back. The width is shown
 * while dragging and stored when the drag ends.
 */
function ResizeHandle({
  label,
  hint,
  width,
  windowWidth,
  onShow,
  onStore,
}: {
  label: string;
  hint: string;
  width: number;
  windowWidth: number;
  onShow: (width: number) => void;
  onStore: (width: number) => void;
}) {
  const drag = useRef<{ startX: number; startWidth: number; last: number } | null>(null);
  const rtl = () => document.documentElement.dir === "rtl";

  const widthAt = (clientX: number) => {
    const start = drag.current;
    if (start === null) return width;
    const moved = rtl() ? start.startX - clientX : clientX - start.startX;
    return clampSidebarWidth(start.startWidth + moved, windowWidth);
  };

  return (
    <div
      className="side-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={SIDEBAR_ID}
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_WIDTH_MIN}
      aria-valuemax={maxSidebarWidth(windowWidth)}
      tabIndex={0}
      title={hint}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { startX: event.clientX, startWidth: width, last: width };
        event.currentTarget.classList.add("dragging");
      }}
      onPointerMove={(event) => {
        if (drag.current === null) return;
        const next = widthAt(event.clientX);
        if (next === drag.current.last) return;
        drag.current.last = next;
        onShow(next);
      }}
      onPointerUp={(event) => {
        const start = drag.current;
        if (start === null) return;
        drag.current = null;
        event.currentTarget.classList.remove("dragging");
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        if (start.last !== start.startWidth) onStore(start.last);
      }}
      onPointerCancel={(event) => {
        const start = drag.current;
        drag.current = null;
        event.currentTarget.classList.remove("dragging");
        if (start !== null) onShow(start.startWidth);
      }}
      onDoubleClick={() => {
        onStore(clampSidebarWidth(SIDEBAR_WIDTH_DEFAULT, windowWidth));
      }}
      onKeyDown={(event) => {
        const next = separatorWidth(event, width, windowWidth, rtl());
        if (next === null) return;
        event.preventDefault();
        if (next !== width) onStore(next);
      }}
    />
  );
}

/**
 * The notes in the look's layout, the team level, or the trash or the settings in their place.
 * Those two keep their "Back" in a narrow window, where the sidebar is folded away.
 */
function View({ m, app, layout }: { m: NotesModel; app: AppSettings; layout: Look }) {
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
        <footer className="area-foot">{m.noticeSlot}</footer>
      </div>
    );
  }
  // The team level in place of the notes. An open note waits with its text and its pending save,
  // as behind the trash, and is there again on the way back.
  if (m.shownScope.kind === "team") {
    return (
      <div className={layout === "paper" ? "notes-area single on-table" : "notes-area single"}>
        <div className="single-main">
          <TeamLevel m={m} />
        </div>
        <footer className="area-foot">{m.noticeSlot}</footer>
      </div>
    );
  }
  if (layout === "paper") return <PaperLayout m={m} />;
  if (layout === "hangar") return <HangarLayout m={m} />;
  return <CalmLayout m={m} />;
}
