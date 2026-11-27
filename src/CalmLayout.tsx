// Look "calm" (direction A, ADR 0004): beside the sidebar (Sidebar.tsx) the list with the search
// and "+" at its top, where each row shows its color as a thin edge and its tools on hover, on
// keyboard focus and in a context menu. The open note reads like a page: just the text, its small
// toolbar comes in on hover and focus (always shown where there is no hover, and while one note
// fills a narrow window). Wide windows show list and note side by side, narrow ones one at a time.

import { BackIcon, DesktopIcon, MoreIcon } from "./icons";
import {
  edgeStyle,
  HeldPanel,
  ListMessages,
  ListTop,
  NotePage,
  NoteRowItem,
  OnDesktopPanel,
  PreviewToggle,
  UnsavedMark,
  Welcome,
} from "./NoteParts";
import { noteKey } from "./notes";
import type { NotesModel } from "./useNotesArea";

export function CalmLayout({ m }: { m: NotesModel }) {
  const { t, note, writable, emptyMode } = m;
  return (
    <div
      className={emptyMode ? "notes-area layout-calm is-empty" : "notes-area layout-calm"}
      data-pane={m.pane}
    >
      <section className="list-pane" aria-label={t("notes.list")}>
        <ListTop m={m} />
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
        {note === null && (
          <div className="note-placeholder">
            <p>{t(writable ? "notes.pick" : "notes.pickReadOnly")}</p>
          </div>
        )}

        {note !== null && (
          <div className="note-bar">
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
          </div>
        )}

        <HeldPanel m={m} />
        <OnDesktopPanel m={m} />

        <div className="note-body" hidden={note === null || note.onDesktop}>
          <NotePage m={m} />
        </div>
      </section>
    </div>
  );
}
