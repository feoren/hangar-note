// Look "hangar" (direction C, ADR 0004): Hangar's own window. Beside the sidebar (Sidebar.tsx) two
// columns: the dense list with the search and "+" at its top; on the right the note in its color,
// its title and tools in a slim header. No status bar: notices float at the bottom (NotesArea.tsx)
// and the keys live in the app menu's Help. Below 840 px the window shows calm's narrow layout
// instead (looks.ts, NotesArea.tsx).

import { colorName, noteTone, toneVariables } from "./colors";
import { DesktopIcon, MoreIcon, PlusIcon, TaskIcon } from "./icons";
import { KeysList } from "./KeysDialog";
import {
  emptyAreaText,
  HeldPanel,
  ListMessages,
  ListTop,
  NotePage,
  NoteRowItem,
  OnDesktopPanel,
  PreviewToggle,
  Progress,
  RenameField,
  UnsavedMark,
} from "./NoteParts";
import { noteKey } from "./notes";
import type { NotesModel } from "./useNotesArea";

export function HangarLayout({ m }: { m: NotesModel }) {
  const { t, note, writable, emptyMode, stats } = m;
  const noteColorName = note === null ? "" : colorName(note.color, m.colorNames, t);
  return (
    <div className={emptyMode ? "notes-area layout-hangar is-empty" : "notes-area layout-hangar"}>
      <section className="list-pane hangar-list" aria-label={t("notes.list")}>
        <ListTop m={m} className="hangar-list-top" />
        {emptyMode ? (
          <div className="hangar-empty">
            <p className="hangar-empty-title">{t("notes.emptyTitle")}</p>
            {(writable || m.shownScope.kind !== "all") && <p>{emptyAreaText(m)}</p>}
            {m.canCreate && (
              <button
                type="button"
                className="primary-button"
                data-focus-id="new"
                onClick={m.newNote}
              >
                <PlusIcon />
                {t("notes.new")}
              </button>
            )}
          </div>
        ) : (
          <div className="list-wrap">
            <ListMessages m={m} />
            <ul className="note-list">
              {m.visible.map((row, index) => (
                <NoteRowItem key={noteKey(row)} m={m} row={row} index={index} tools={false} />
              ))}
            </ul>
          </div>
        )}
      </section>

      <section
        className="note-pane hangar-editor"
        aria-label={m.shownTitle === "" ? t("notes.noteLabel") : m.shownTitle}
        style={note === null ? undefined : toneVariables(noteTone(note.color, m.theme))}
      >
        {note === null &&
          (emptyMode && writable ? (
            <div className="hangar-keys">
              <h2>{t("menu.keys")}</h2>
              <KeysList m={m} />
            </div>
          ) : (
            <div className="note-placeholder">
              <p>{t(writable ? "notes.pick" : "notes.pickReadOnly")}</p>
            </div>
          ))}
        {note !== null && (
          <div className="hangar-head">
            {m.renaming ? (
              <RenameField m={m} className="hangar-rename" />
            ) : (
              <h2 className="hangar-title">
                <button
                  type="button"
                  className="note-title"
                  disabled={note.id === null || note.onDesktop || !writable}
                  title={note.id === null ? undefined : `${m.shownTitle}\n${t("notes.renameHint")}`}
                  onClick={() => {
                    m.setRenaming(true);
                  }}
                >
                  <span>{m.shownTitle}</span>
                </button>
              </h2>
            )}
            {stats.progress.total > 0 && !note.onDesktop && (
              <span className="hangar-progress">
                <TaskIcon size={14} />
                <Progress m={m} done={stats.progress.done} total={stats.progress.total} />
              </span>
            )}
            {note.id !== null && (
              <button
                type="button"
                className="icon-button"
                aria-label={t("notes.color")}
                title={noteColorName}
                aria-haspopup="menu"
                aria-expanded={m.menuOpen("noteColor")}
                onClick={(event) => {
                  m.toggleMenu("noteColor", event);
                }}
              >
                {/* The edge tone: the swatch tone would vanish on the header, which is its own tone. */}
                <span className="color-dot" style={edgeDot(noteTone(note.color, m.theme).edge)} />
              </button>
            )}
            <UnsavedMark m={m} />
            <PreviewToggle m={m} />
            {note.id !== null && !note.onDesktop && (
              <button
                type="button"
                className="secondary-button hangar-desktop"
                aria-label={t("notes.toDesktop")}
                title={t("notes.toDesktopHint")}
                onClick={() => void m.putOnDesktop()}
              >
                <DesktopIcon size={14} />
                <span className="ghost-label">{t("notes.toDesktop")}</span>
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              aria-label={t("notes.more")}
              title={t("notes.more")}
              aria-haspopup="menu"
              aria-expanded={m.menuOpen("noteActions")}
              disabled={note.id === null}
              onClick={(event) => {
                m.toggleMenu("noteActions", event);
              }}
            >
              <MoreIcon />
            </button>
          </div>
        )}
        <HeldPanel m={m} />
        <OnDesktopPanel m={m} />
        <div className="note-body" hidden={note === null || note.onDesktop}>
          <NotePage m={m} heading={false} />
        </div>
      </section>
    </div>
  );
}

/** The color dot of the open note, in the note's edge tone (styles.css draws the dot). */
function edgeDot(edge: string): Record<string, string> {
  return { "--dot": edge };
}
