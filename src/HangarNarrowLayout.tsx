// The narrow layout of the look "hangar" (ADR 0004), where its two columns do not fit beside the
// sidebar (looks.ts, `layoutFor`): the list with the search and "+" at its top, where each row
// shows its color as a thin edge and its tools on hover, on keyboard focus and in a context menu,
// and the open note under a bar that is always there: back, the project, the color, the preview,
// "On the desktop", the note's menu, and at its right end the look switch, which stays there
// without an open note too. Up to 600 px of room the window shows the list or the note one at a
// time; there, while the list fills the room, the look switch closes the list's top row instead.

import { colorName } from "./colors";
import { BackIcon, DesktopIcon, MoreIcon } from "./icons";
import { LookSwitch } from "./LookSwitch";
import {
  edgeStyle,
  HeldPanel,
  ListMessages,
  ListTop,
  NoteFooter,
  NotePage,
  NoteRowItem,
  OnDesktopPanel,
  PreviewToggle,
  UnsavedMark,
  Welcome,
} from "./NoteParts";
import { noteKey } from "./notes";
import { dotStyle, type NotesModel } from "./useNotesArea";

/**
 * `narrow`: the room beside the sidebar shows the list or the note one at a time (looks.ts,
 * `narrowRoom`).
 */
export function HangarNarrowLayout({ m, narrow }: { m: NotesModel; narrow: boolean }) {
  const { t, note, writable, emptyMode } = m;
  /** Where the look switch sits: in the list's top row while the list is all there is. */
  const switchInList = emptyMode || (narrow && m.pane !== "note");
  return (
    <div
      className={
        emptyMode ? "notes-area layout-hangar-narrow is-empty" : "notes-area layout-hangar-narrow"
      }
      data-pane={m.pane}
    >
      <section className="list-pane" aria-label={t("notes.list")}>
        <ListTop m={m} end={switchInList ? <LookSwitch m={m} /> : undefined} />
        {emptyMode ? (
          <Welcome m={m} mark={<div className="welcome-mark" aria-hidden="true" />} />
        ) : (
          <div className="list-wrap">
            <ListMessages m={m} />
            <ul className="note-list">
              {m.visible.map((row, index) => (
                <NoteRowItem key={noteKey(row)} m={m} row={row} index={index} tools />
              ))}
            </ul>
          </div>
        )}
      </section>

      <section
        className="note-pane"
        aria-label={m.shownTitle === "" ? t("notes.noteLabel") : m.shownTitle}
        style={note === null ? undefined : edgeStyle(note.color, m.theme)}
      >
        <div className="note-bar">
          {note !== null && (
            <>
              <button
                type="button"
                className="icon-button note-back"
                data-action="back"
                aria-label={t("notes.backToList")}
                title={t("notes.backToList")}
                onClick={() => void m.backToList()}
              >
                <BackIcon />
              </button>
              <span className="note-crumb" title={note.folder.path ?? t("notes.general")}>
                {m.projectLabel(note.folder)}
              </span>
              <UnsavedMark m={m} />
              {note.id !== null && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t("notes.color")}
                  title={`${t("notes.color")}: ${colorName(note.color, m.colorNames, t)}`}
                  aria-haspopup="menu"
                  aria-expanded={m.menuOpen("noteColor")}
                  onClick={(event) => {
                    m.toggleMenu("noteColor", event);
                  }}
                >
                  <span className="color-dot" style={dotStyle(note.color)} />
                </button>
              )}
              <PreviewToggle m={m} />
              {note.id !== null && !note.onDesktop && (
                <button
                  type="button"
                  className="ghost-button"
                  aria-label={t("notes.toDesktop")}
                  title={t("notes.toDesktopHint")}
                  onClick={() => void m.putOnDesktop()}
                >
                  <DesktopIcon />
                  <span className="ghost-label">{t("notes.toDesktop")}</span>
                </button>
              )}
              <button
                type="button"
                className="icon-button"
                aria-label={t("notes.more")}
                title={t("notes.more")}
                aria-haspopup="menu"
                aria-expanded={m.menuOpen("note")}
                disabled={note.id === null}
                onClick={(event) => {
                  m.toggleMenu("note", event);
                }}
              >
                <MoreIcon />
              </button>
            </>
          )}
          {!switchInList && (
            <>
              {note !== null && <span className="bar-divider" aria-hidden="true" />}
              <span className="bar-end">
                <LookSwitch m={m} />
              </span>
            </>
          )}
        </div>

        {note === null && (
          <div className="note-placeholder">
            <p>{t(writable ? "notes.pick" : "notes.pickReadOnly")}</p>
          </div>
        )}

        <HeldPanel m={m} />
        <OnDesktopPanel m={m} />

        <div className="note-body" hidden={note === null || note.onDesktop}>
          <NotePage m={m} />
        </div>
        <NoteFooter m={m} />
      </section>
    </div>
  );
}
