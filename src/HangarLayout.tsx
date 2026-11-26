// Look "hangar" (direction C, ADR 0004): Hangar's own window. Three columns: on the left the scopes
// and the colors as fixed rows with their counts, "Recently deleted" and "Settings"; in the middle
// the dense list; on the right the note in its color, its title and tools in a header. A status
// bar at the bottom is the one place for notices and names the shortcuts. Below 760 px the window
// shows calm's narrow layout instead (looks.ts, NotesArea.tsx).

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

export function HangarLayout({ m }: { m: NotesModel }) {
  const { t, note, writable, emptyMode, stats } = m;
  const noteColorName = note === null ? "" : colorName(note.color, m.colorNames, t);
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
              onClick={() => {
                m.leaveFor("trash", "trash");
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

      <section
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

      {/* The status bar: the one place for notices, the save state and the shortcuts. */}
      <footer className="area-foot hangar-status">
        <div className="foot-main">
          {m.openText === null ? (
            <div className={m.noticeShown ? "foot-status away" : "foot-status"}>
              <span>{m.shownScopeLabel}</span>
            </div>
          ) : (
            <FootStatus m={m} scope />
          )}
          {m.noticeSlot}
        </div>
        <UnsavedMark m={m} />
        <span className="status-keys">
          {m.openText !== null && m.openText.id !== null && writable ? (
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
