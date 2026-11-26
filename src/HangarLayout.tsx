// Look "hangar" (direction C, ADR 0004): Hangar's own window. Three columns: on the left the scopes
// and the colors as fixed rows with their counts, "Recently deleted" and "Settings"; in the middle
// the dense list; on the right the note in its color, its title and tools in a header. A status
// bar at the bottom is the one place for notices and names the shortcuts. The trash takes the
// place of the list and the note; the sidebar and the status bar stay. Below 760 px the window
// shows calm's narrow layout instead (looks.ts, NotesArea.tsx).

import { useLayoutEffect, useState, type ReactNode } from "react";

import { colorName, NOTE_COLORS, noteTone, toneVariables } from "./colors";
import { DesktopIcon, GearIcon, MoreIcon, PlusIcon, TaskIcon, TrashIcon, CheckIcon } from "./icons";
import {
  FootStatus,
  HeldPanel,
  ListMessages,
  NotePage,
  NoteRowItem,
  OnDesktopPanel,
  PreviewToggle,
  Progress,
  RenameField,
  SearchField,
  UnsavedMark,
} from "./NoteParts";
import { noteKey } from "./notes";
import { shortcutLabel } from "./shortcuts";
import { dotStyle, PLATFORM, type NotesModel } from "./useNotesArea";

/**
 * A note column at most this wide (760 to about 820 px wide windows) has no room for the progress
 * in its header; the status bar shows it instead, so it is always shown once.
 */
const NARROW_NOTE = 320;

/** Whether the note column is narrow, followed as the window is resized. */
function useNarrowNote(pane: HTMLElement | null): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    if (pane === null) return;
    const measure = () => {
      // 0: not laid out (yet); the header keeps the progress.
      const width = pane.clientWidth;
      setNarrow(width > 0 && width <= NARROW_NOTE);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    return () => {
      observer.disconnect();
    };
  }, [pane]);
  return narrow;
}

/** `trash`: the trash, shown in the place of the list and the note. */
export function HangarLayout({ m, trash }: { m: NotesModel; trash?: ReactNode }) {
  const { t, note, writable, emptyMode, stats } = m;
  const noteColorName = note === null ? "" : colorName(note.color, m.colorNames, t);
  const [notePane, setNotePane] = useState<HTMLElement | null>(null);
  const narrow = useNarrowNote(notePane);
  const inTrash = trash !== undefined;
  /** The sidebar is the way out of the trash: a scope or a color shows the notes again. */
  const leaveTrash = () => {
    if (inTrash) m.showNotes();
  };
  return (
    <div className={emptyMode ? "notes-area layout-hangar is-empty" : "notes-area layout-hangar"}>
      <nav className="hangar-side" aria-label={t("notes.areaMenu")}>
        <div className="side-head">
          <span className="side-name">{t("app.name")}</span>
          <button
            type="button"
            className="icon-button"
            aria-label={t("notes.more")}
            title={t("notes.more")}
            aria-haspopup="menu"
            aria-expanded={m.menuOpen("side")}
            onClick={(event) => {
              m.toggleMenu("side", event);
            }}
          >
            <MoreIcon />
          </button>
        </div>
        <button
          type="button"
          className="primary-button side-new"
          data-focus-id="new"
          title={`${t("notes.new")} (${m.quickKeys})`}
          disabled={!writable}
          onClick={m.newNote}
        >
          <PlusIcon />
          <span className="side-new-label">{t("notes.new")}</span>
        </button>
        {!emptyMode && (
          <div className="side-scroll">
            <p className="side-label" id="side-scopes">
              {t("notes.scopes")}
            </p>
            <ul className="side-list" aria-labelledby="side-scopes">
              {m.scopeEntries.map((entry) => (
                <li key={entry.key}>
                  <button
                    type="button"
                    className="side-item"
                    aria-pressed={m.isShownScope(entry)}
                    title={entry.title}
                    onClick={() => {
                      m.setScope(entry.scope);
                      leaveTrash();
                    }}
                  >
                    <span className="side-item-label">{entry.label}</span>
                    {entry.count !== undefined && <span className="side-count">{entry.count}</span>}
                  </button>
                </li>
              ))}
            </ul>
            <div className="side-label-row">
              <p className="side-label" id="side-colors">
                {t("notes.colors")}
              </p>
              {/* Kept in place while nothing is chosen, so choosing moves nothing. */}
              <button
                type="button"
                className="link-button side-clear"
                hidden={m.colors.size === 0}
                onClick={m.clearColors}
              >
                {t("notes.colorFilterClear")}
              </button>
            </div>
            <ul className="side-list" aria-labelledby="side-colors">
              {NOTE_COLORS.map((color) => {
                const on = m.colors.has(color);
                return (
                  <li key={color}>
                    <button
                      type="button"
                      className="side-item"
                      aria-pressed={on}
                      onClick={() => {
                        m.toggleColor(color);
                        leaveTrash();
                      }}
                    >
                      <span className="color-dot" aria-hidden="true" style={dotStyle(color)} />
                      <span className="side-item-label">{colorName(color, m.colorNames, t)}</span>
                      <span className="side-count">{m.counts.get(color) ?? 0}</span>
                      <span className="side-tick" aria-hidden="true">
                        {on && <CheckIcon size={14} />}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <span className="side-fill" />
        <ul className="side-list side-foot">
          <li>
            <button
              type="button"
              className="side-item"
              data-focus-id="trash"
              aria-current={inTrash ? "page" : undefined}
              onClick={() => {
                if (!inTrash) m.leaveFor("trash", "trash");
              }}
            >
              <TrashIcon size={14} />
              <span className="side-item-label">{t("notes.trash")}</span>
            </button>
          </li>
          <li>
            <button
              type="button"
              className="side-item"
              data-focus-id="settings"
              onClick={() => {
                m.leaveFor("settings", "settings");
              }}
            >
              <GearIcon size={14} />
              <span className="side-item-label">{t("notes.settings")}</span>
            </button>
          </li>
        </ul>
      </nav>

      {inTrash && <section className="hangar-trash">{trash}</section>}

      {!inTrash && (
        <section className="list-pane hangar-list" aria-label={t("notes.list")}>
          {m.banner}
          {emptyMode ? (
            <div className="hangar-empty">
              <p className="hangar-empty-title">{t("notes.emptyTitle")}</p>
              <p>
                {m.scopeName !== null
                  ? t("notes.emptyProject", { folder: m.scopeName })
                  : writable
                    ? t("notes.emptyLead")
                    : t("notes.empty")}
              </p>
            </div>
          ) : (
            <>
              <div className="find">
                <SearchField m={m} placeholder={t("notes.search")} />
              </div>
              <div className="hangar-list-head">
                <span>{m.shownScopeLabel}</span>
                <span>{t("notes.lastChanged")}</span>
              </div>
              <div className="list-wrap">
                <ListMessages m={m} />
                <ul className="note-list">
                  {m.visible.map((row, index) => (
                    <NoteRowItem key={noteKey(row)} m={m} row={row} index={index} tools={false} />
                  ))}
                </ul>
              </div>
            </>
          )}
        </section>
      )}

      {!inTrash && (
        <section
          ref={setNotePane}
          className="note-pane hangar-editor"
          aria-label={m.shownTitle === "" ? t("notes.noteLabel") : m.shownTitle}
          style={note === null ? undefined : toneVariables(noteTone(note.color, m.theme))}
        >
          {note === null &&
            (emptyMode && writable ? (
              <KeysPanel m={m} />
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
                    title={
                      note.id === null ? undefined : `${m.shownTitle}\n${t("notes.renameHint")}`
                    }
                    onClick={() => {
                      m.setRenaming(true);
                    }}
                  >
                    <span>{m.shownTitle}</span>
                  </button>
                </h2>
              )}
              {stats.progress.total > 0 && !note.onDesktop && !narrow && (
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
      )}

      {/* The status bar: the one place for notices, the save state and the shortcuts. */}
      <footer className="area-foot hangar-status">
        <div className="foot-main">
          {m.openText === null || inTrash ? (
            <div className={m.noticeShown ? "foot-status away" : "foot-status"}>
              <span>{inTrash ? t("notes.trash") : m.shownScopeLabel}</span>
            </div>
          ) : (
            <FootStatus m={m} scope progress={narrow} />
          )}
          {m.noticeSlot}
        </div>
        <UnsavedMark m={m} />
        <span className="status-keys">
          {inTrash ? null : m.openText !== null && m.openText.id !== null && writable ? (
            <>
              <span>
                <kbd>F2</kbd> {t("notes.rename")}
              </span>
              <span>
                <kbd>{t("key.delete")}</kbd> {t("notes.delete")}
              </span>
            </>
          ) : (
            writable && (
              <span>
                <kbd>{m.quickKeys}</kbd> {t("notes.new")}
              </span>
            )
          )}
        </span>
      </footer>

      {m.popup}
    </div>
  );
}

/** With no notes yet, the note column lists the keys that matter. */
function KeysPanel({ m }: { m: NotesModel }) {
  const { t } = m;
  const keys: [string, string][] = [
    [m.quickKeys, t("notes.new")],
    ["F2", t("notes.rename")],
    [t("key.delete"), t("notes.delete")],
    [shortcutLabel("bold", PLATFORM, t), t("format.bold")],
    [shortcutLabel("task", PLATFORM, t), t("format.task")],
  ];
  return (
    <div className="hangar-keys">
      <h2>{t("notes.keys")}</h2>
      <dl>
        {keys.map(([key, label]) => (
          <div key={key}>
            <dt>
              <kbd>{key}</kbd>
            </dt>
            <dd>{label}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** The color dot of the open note, in the note's edge tone (styles.css draws the dot). */
function edgeDot(edge: string): Record<string, string> {
  return { "--dot": edge };
}
