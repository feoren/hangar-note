// The thin status line under a note, in the note's color: the cursor's line and column, the
// selection and the length of the text. It renders what cursorStats.ts measures and formats. The
// numbers are information only: no live region that would read every keystroke aloud; the full
// words are its tooltip and, for screen readers, its text. Its one control is the sticky note's
// line numbers switch at the line's start; a note that Hangar Drive keeps on your server says so
// beside it, away from the numbers.

import { useSyncExternalStore } from "react";

import { footerText, type CursorStore } from "./cursorStats";
import { useT, type Language } from "./i18n";
import { CloudCheckIcon, LineNumbersIcon } from "./icons";

/** The sticky note's switch for its line numbers. */
export interface LineNumbersSwitch {
  on: boolean;
  onToggle: () => void;
}

export function CursorFooter({
  store,
  language,
  position = true,
  synced = false,
  lineNumbers,
  style,
}: {
  store: CursorStore;
  language: Language;
  /** `false` leaves out the cursor and the selection (the preview shows no cursor). */
  position?: boolean;
  /** The note is synced to your server through Hangar Drive. */
  synced?: boolean;
  /** A switch for the line numbers at the line's start (the sticky note only). */
  lineNumbers?: LineNumbersSwitch;
  style?: React.CSSProperties;
}) {
  const t = useT();
  const stats = useSyncExternalStore(store.subscribe, store.get);
  const syncedMark = synced && (
    <span className="cursor-synced" title={t("drive.synced")}>
      <CloudCheckIcon size={13} />
      <span className="cursor-synced-text">{t("drive.synced")}</span>
    </span>
  );
  const numbersSwitch = lineNumbers !== undefined && (
    <button
      type="button"
      role="switch"
      className="footer-switch"
      aria-checked={lineNumbers.on}
      aria-label={t("footer.lineNumbers")}
      title={t("footer.lineNumbers")}
      // Keeps the focus (and the selection) in the editor on a click; the keys still reach it.
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={lineNumbers.onToggle}
    >
      <LineNumbersIcon size={14} />
    </button>
  );
  if (stats === null) {
    const empty = !synced && lineNumbers === undefined;
    return (
      <div className="cursor-footer" style={style} aria-hidden={empty ? "true" : undefined}>
        {numbersSwitch}
        {syncedMark}
      </div>
    );
  }
  const text = footerText(stats, t, language, position);
  return (
    <div
      className="cursor-footer"
      role="group"
      aria-label={t("footer.label")}
      title={text.full}
      style={style}
    >
      {numbersSwitch}
      {syncedMark}
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
