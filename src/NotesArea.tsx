// The notes area (ADR 0002, phase 1) in the look the settings name (ADR 0004). Its logic lives
// once in useNotesArea.tsx; this file picks the view (notes, trash, settings) and the layout of
// the look: calm (CalmLayout), paper (PaperLayout) or hangar (HangarLayout), which falls back to
// calm's narrow layout in a narrow window. Switching the look keeps the open note, its unsaved
// text and its pending save; only the editor's element changes, and the editor follows it.

import { useEffect, useState } from "react";

import type { AppSettings } from "./appSettings";
import { CalmLayout } from "./CalmLayout";
import { HangarLayout } from "./HangarLayout";
import { layoutFor } from "./looks";
import { NotesSettings } from "./NotesSettings";
import { PaperLayout } from "./PaperLayout";
import { Trash } from "./Trash";
import { useNotesArea } from "./useNotesArea";

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
  const layout = layoutFor(app.look, useWindowWidth());

  if (m.view === "settings") {
    return (
      <div className="notes-area single">
        <div className="single-main">
          <NotesSettings app={app} onBack={m.backToNotes} />
        </div>
        <footer className="area-foot">{m.noticeSlot}</footer>
      </div>
    );
  }

  if (m.view === "trash") {
    return (
      <div className="notes-area single">
        <div className="single-main">
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
        </div>
        <footer className="area-foot">{m.noticeSlot}</footer>
      </div>
    );
  }

  if (layout === "paper") return <PaperLayout m={m} />;
  if (layout === "hangar") return <HangarLayout m={m} />;
  return <CalmLayout m={m} />;
}
