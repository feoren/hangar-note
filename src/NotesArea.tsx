// The notes area (ADR 0002, phase 1) in the look the settings name (ADR 0004). Its logic lives
// once in useNotesArea.tsx; this file lays out the one sidebar (Sidebar.tsx) beside the view
// (notes, trash, settings) in the layout of the look: calm (CalmLayout), paper (PaperLayout) or
// hangar (HangarLayout), which falls back to calm's narrow layout in a narrow window. A narrow
// window folds the sidebar away behind a button in the look's heading. Switching the look keeps
// the open note, its unsaved text and its pending save; only the editor's element changes, and
// the editor follows it.

import { useEffect, useRef, useState } from "react";

import type { AppSettings } from "./appSettings";
import { CalmLayout } from "./CalmLayout";
import { HangarLayout } from "./HangarLayout";
import { layoutFor, navFolded, type Look } from "./looks";
import { NotesSettings } from "./NotesSettings";
import { PaperLayout } from "./PaperLayout";
import { NavProvider, Sidebar, type NavState } from "./Sidebar";
import { Trash } from "./Trash";
import { useNotesArea, type NotesModel } from "./useNotesArea";

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

export function NotesArea({ app }: { app: AppSettings }) {
  const m = useNotesArea(app);
  const width = useWindowWidth();
  const layout = layoutFor(app.look, width);
  const folded = navFolded(width);
  const [overlay, setOverlay] = useState(false);
  const opener = useRef<HTMLElement | null>(null);

  const nav: NavState = {
    folded,
    open: (from) => {
      opener.current = from;
      setOverlay(true);
    },
  };
  const closeOverlay = () => {
    setOverlay(false);
  };
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
  /** The paper look's open note is a modal sheet: the sidebar waits behind it with the grid. */
  const behindSheet = layout === "paper" && m.view === "browse" && m.note !== null;

  return (
    <NavProvider value={nav}>
      <div className={`notes-shell look-${layout}`} data-nav={folded ? "folded" : "open"}>
        {!folded && (
          <div className="shell-side" inert={behindSheet}>
            <Sidebar m={m} />
          </div>
        )}
        <main className="shell-main" inert={shownOverlay}>
          <View m={m} app={app} layout={layout} />
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
    </NavProvider>
  );
}

/**
 * The notes in the look's layout, or the trash or the settings in their place. Those two keep
 * their "Back" in a narrow window, where the sidebar is folded away.
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
  if (layout === "paper") return <PaperLayout m={m} />;
  if (layout === "hangar") return <HangarLayout m={m} />;
  return <CalmLayout m={m} />;
}
