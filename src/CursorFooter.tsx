// The thin status line under a note, in the note's color: the cursor's line and column, the
// selection and the length of the text. It renders what cursorStats.ts measures and formats. It
// is information only: no Tab stop, and no live region that would read every keystroke aloud; the
// full words are its tooltip and, for screen readers, its text.

import { useSyncExternalStore } from "react";

import { footerText, type CursorStore } from "./cursorStats";
import { useT, type Language } from "./i18n";

export function CursorFooter({
  store,
  language,
  position = true,
  style,
}: {
  store: CursorStore;
  language: Language;
  /** `false` leaves out the cursor and the selection (the preview shows no cursor). */
  position?: boolean;
  style?: React.CSSProperties;
}) {
  const t = useT();
  const stats = useSyncExternalStore(store.subscribe, store.get);
  if (stats === null) return <div className="cursor-footer" style={style} aria-hidden="true" />;
  const text = footerText(stats, t, language, position);
  return (
    <div
      className="cursor-footer"
      role="group"
      aria-label={t("footer.label")}
      title={text.full}
      style={style}
    >
      <span className="cursor-footer-text" aria-hidden="true">
        {(text.position !== null || text.selected !== null) && (
          <>
            <span className="cursor-where">
              {text.position !== null && <span className="cursor-position">{text.position}</span>}
              {text.selected !== null && (
                <>
                  {" "}
                  <span className="cursor-selected">{text.selected}</span>
                </>
              )}
            </span>
            <span className="cursor-sep" />
          </>
        )}
        <span className="cursor-chars">{text.chars}</span>
      </span>
      <span className="sr-only">{text.full}</span>
    </div>
  );
}
