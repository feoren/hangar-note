// Parts every look of the notes area shares (ADR 0004): the search, the messages above the list, a
// list row with its menu, the open note as a page, the note on the desktop, the held draft and
// the footer's save state. They render what useNotesArea.tsx offers and hold no logic of their own.

import { useId, useLayoutEffect, useRef, useState } from "react";

import { noteTone, type NoteColor, type Theme } from "./colors";
import { relativeTime } from "./format";
import {
  CloseIcon,
  DesktopIcon,
  EyeIcon,
  LockIcon,
  PaletteIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
} from "./icons";
import { noteKey } from "./notes";
import { PLATFORM, type NotesModel, type Row } from "./useNotesArea";

/** The note's color as a thin edge (a row, the top of the open note, a card's strip). */
export function edgeStyle(color: NoteColor, theme: Theme): Record<string, string> {
  return { "--note-edge": noteTone(color, theme).edge };
}

export function SearchField({ m, placeholder }: { m: NotesModel; placeholder?: string }) {
  const { t, query } = m;
  return (
    <label className="search">
      <SearchIcon />
      <SearchInput
        attach={m.attachSearch}
        type="search"
        value={query}
        placeholder={placeholder ?? t("notes.searchShort")}
        aria-label={t("notes.search")}
        onChange={(event) => {
          m.setQuery(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && query !== "") {
            event.preventDefault();
            m.setQuery("");
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            m.moveRowFocus(-1, 1);
          }
        }}
      />
      {query !== "" && (
        <button
          type="button"
          className="icon-button search-clear"
          aria-label={t("notes.searchClear")}
          title={t("notes.searchClear")}
          onClick={() => {
            m.setQuery("");
            m.focusSearch();
          }}
        >
          <CloseIcon size={12} />
        </button>
      )}
    </label>
  );
}

/** What the list says instead of rows: a failed load, no hits, nothing here, no color matches. */
export function ListMessages({ m }: { m: NotesModel }) {
  const { t, searching, shownHits, allRows, visible, list, listFailed } = m;
  return (
    <>
      {listFailed && !searching && (
        <div className="notes-empty" role="alert">
          <p>{t("notes.loadFailed")}</p>
          <button type="button" className="secondary-button" onClick={m.reloadAll}>
            {t("notes.retry")}
          </button>
        </div>
      )}
      {searching && shownHits !== null && allRows.length === 0 && (
        <div className="notes-empty">
          <p>{t("notes.noHits", { query: m.query.trim() })}</p>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              m.setQuery("");
              m.focusSearch();
            }}
          >
            {t("notes.searchClear")}
          </button>
        </div>
      )}
      {/* An empty area while others hold notes: one sentence and the way to start one here. */}
      {!searching && !listFailed && list !== null && allRows.length === 0 && (
        <div className="notes-empty">
          <p>{emptyAreaText(m)}</p>
          {m.canCreate && (
            <button type="button" className="secondary-button" onClick={m.newNote}>
              <PlusIcon size={14} />
              {t("notes.new")}
            </button>
          )}
        </div>
      )}
      {allRows.length > 0 && visible.length === 0 && (
        <div className="notes-empty">
          <p>{t("notes.noColorMatches")}</p>
          <button type="button" className="secondary-button" onClick={m.clearColors}>
            {t("notes.colorFilterClear")}
          </button>
        </div>
      )}
    </>
  );
}

/**
 * The one sentence of an empty level: "No private notes yet.", "No notes in shop yet.", or, in
 * the "Project" level while there is no project at all, how one gets there.
 */
export function emptyAreaText(m: NotesModel): string {
  switch (m.shownScope.kind) {
    case "all":
      return m.t("notes.emptyLead");
    case "general":
      return m.t("level.emptyPrivate");
    case "project":
      return m.project === null
        ? m.t("level.noProject")
        : m.t("notes.emptyProject", { folder: m.shownScopeLabel });
    case "team":
      return m.t("team.needsHangar");
  }
}

/**
 * The top of the notes, inside the list itself (no bar across the window): the search, the small
 * "Read only" chip while the notes cannot be written, and "New note" as a "+". The area's name is
 * the page's heading for screen readers; on screen the sidebar marks it.
 */
export function ListTop({ m, className }: { m: NotesModel; className?: string }) {
  const { t, emptyMode } = m;
  return (
    <div
      className={
        className === undefined ? "list-top area-heading" : `list-top area-heading ${className}`
      }
    >
      <h1 className="sr-only">{m.shownScopeLabel}</h1>
      {!emptyMode && <SearchField m={m} placeholder={t("notes.search")} />}
      <ReadOnlyChip m={m} />
      {!emptyMode && (
        <button
          type="button"
          className="primary-button list-new"
          data-focus-id="new"
          aria-label={t("notes.new")}
          title={`${t("notes.new")} (${m.quickKeys})`}
          disabled={!m.canCreate}
          onClick={m.newNote}
        >
          <PlusIcon size={16} />
        </button>
      )}
    </div>
  );
}

/**
 * "Read only", small and calm, beside the heading. Its sentence says why: as the tooltip, as its
 * description for screen readers, and on a click or Enter in a small bubble below it (touch and
 * keyboard have no tooltip). Escape or leaving it closes the bubble.
 */
export function ReadOnlyChip({ m }: { m: NotesModel }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (m.readOnlyReason === null) return null;
  const reason = m.t(m.readOnlyReason);
  return (
    <span className="ro-chip-wrap">
      <button
        type="button"
        className="ro-chip"
        title={reason}
        aria-expanded={open}
        aria-describedby={id}
        onClick={() => {
          setOpen((shown) => !shown);
        }}
        onBlur={() => {
          setOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }
        }}
      >
        <LockIcon size={12} />
        {m.t("notes.readOnlyChip")}
      </button>
      <span id={id} className={open ? "ro-reason open" : "ro-reason"} role="note">
        {reason}
      </span>
    </span>
  );
}

/** Progress of a checklist ("2/5"), named in full for screen readers. */
export function Progress({ m, done, total }: { m: NotesModel; done: number; total: number }) {
  const text = m.progressText({ done, total });
  return (
    <span className={done === total ? "note-progress complete" : "note-progress"} title={text}>
      <span aria-hidden="true">
        {done}/{total}
      </span>
      <span className="sr-only">{text}</span>
    </span>
  );
}

/**
 * The marks of a row or a card: on the desktop, the project (in All, unless the row names it in
 * its second line), progress, time.
 */
export function RowMeta({
  m,
  row,
  project = true,
}: {
  m: NotesModel;
  row: Row;
  project?: boolean;
}) {
  const { t } = m;
  const progress = row.progress !== null && row.progress.total > 0 ? row.progress : null;
  const time = row.updatedAt === null ? "" : relativeTime(row.updatedAt, m.now, m.language);
  return (
    <>
      {row.onDesktop && (
        <span className="note-row-mark" title={t("notes.onDesktop")}>
          <DesktopIcon size={14} />
          <span className="sr-only">{t("notes.onDesktop")}</span>
        </span>
      )}
      {project && m.showProject && (
        <span className="note-row-project" title={row.folder.path ?? undefined}>
          {m.projectLabel(row.folder)}
        </span>
      )}
      {progress !== null && <Progress m={m} done={progress.done} total={progress.total} />}
      {time !== "" && <span className="note-row-time">{time}</span>}
    </>
  );
}

/**
 * One row of the list. Only the current row is a Tab stop (roving tab index); arrows move it.
 * `tools`: color, on the desktop and delete on hover and keyboard focus (calm); the dense list of
 * the hangar look leaves them to the context menu and the keys.
 */
export function NoteRowItem({
  m,
  row,
  index,
  tools,
}: {
  m: NotesModel;
  row: Row;
  index: number;
  tools: boolean;
}) {
  const { t, writable } = m;
  const key = noteKey(row);
  const active = key === m.activeKey;
  const tabStop = key === m.rovingKey ? 0 : -1;
  return (
    <li
      className={active ? "note-item active" : "note-item"}
      style={edgeStyle(row.color, m.theme)}
      onContextMenu={(event) => {
        m.onRowContextMenu(row, event);
      }}
    >
      <button
        type="button"
        className={active ? "note-row active" : "note-row"}
        aria-current={active ? "true" : undefined}
        tabIndex={tabStop}
        ref={m.registerRow(key)}
        title={row.folder.path ?? t("notes.general")}
        onFocus={() => {
          m.setFocusKey(key);
        }}
        onClick={() => void m.openNote(row, !row.onDesktop)}
        onKeyDown={(event) => {
          m.onRowKeyDown(row, index, event);
        }}
      >
        <span className="note-row-head">
          <span className="note-row-title">{row.title}</span>
          <span className="note-row-meta">
            <RowMeta m={m} row={row} project={false} />
          </span>
        </span>
        {/* In All, the second line starts with the project, small, so the title keeps its room. */}
        {(row.excerpt !== "" || m.showProject) && (
          <span className="note-row-excerpt">
            {m.showProject && (
              <>
                <span className="note-row-project" title={row.folder.path ?? undefined}>
                  {m.projectLabel(row.folder)}
                </span>
                {row.excerpt !== "" && <span aria-hidden="true"> · </span>}
              </>
            )}
            {row.excerpt}
          </span>
        )}
      </button>
      {tools && (
        <div className="row-tools">
          <button
            type="button"
            className="icon-button"
            tabIndex={tabStop}
            aria-label={t("notes.color")}
            title={t("notes.color")}
            aria-haspopup="menu"
            aria-expanded={m.menuOpen("rowColor", row)}
            onClick={(event) => {
              m.openRowColors(row, event.currentTarget);
            }}
          >
            <PaletteIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            tabIndex={tabStop}
            aria-label={t(row.onDesktop ? "notes.bringToFront" : "notes.toDesktop")}
            title={t(row.onDesktop ? "notes.bringToFront" : "notes.toDesktopHint")}
            onClick={() => {
              m.rowToDesktop(row);
            }}
          >
            <DesktopIcon />
          </button>
          {writable && (
            <button
              type="button"
              className="icon-button"
              tabIndex={tabStop}
              aria-label={t("notes.delete")}
              title={`${t("notes.delete")} (${t("key.delete")})`}
              onClick={() => void m.deleteRef(row, row.title)}
            >
              <TrashIcon />
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/** The field that renames the open note (F2, "Rename", a click on the title). */
export function RenameField({ m, className }: { m: NotesModel; className: string }) {
  const { t, note } = m;
  if (note === null) return null;
  return (
    <input
      className={className}
      aria-label={t("notes.newTitle")}
      defaultValue={note.title}
      maxLength={200}
      autoFocus
      onFocus={(event) => {
        event.currentTarget.select();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void m.commitRename(event.currentTarget.value).then(m.focusEditor);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          m.setRenaming(false);
          m.focusEditor();
        }
      }}
      onBlur={(event) => {
        void m.commitRename(event.currentTarget.value);
      }}
    />
  );
}

/**
 * The open note as a page: its title (left out where it would repeat the first line), then the
 * preview or the editor. `heading: false` for a look that names the note in its header instead.
 */
export function NotePage({ m, heading = true }: { m: NotesModel; heading?: boolean }) {
  const { t, note, writable } = m;
  return (
    <div className="note-page">
      {note !== null && heading && m.renaming && <RenameField m={m} className="note-rename" />}
      {note !== null && heading && !m.renaming && m.titleShown && (
        <h2 className="note-heading">
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
      {m.preview && (
        <div
          className="note-preview"
          role="region"
          tabIndex={0}
          aria-label={t("notes.previewOf", { title: m.shownTitle })}
          onClick={m.onPreviewClick}
          // Safe: markdownPreview.ts renders with html: false, without links or images; the
          // only elements it adds are the task checkboxes.
          dangerouslySetInnerHTML={{ __html: m.previewHtml ?? "" }}
        />
      )}
      <EditorHost attach={m.attachEditorHost} hidden={m.preview} />
    </div>
  );
}

/** A note on the desktop is edited in its sticky note; here it says so, under its title. */
export function OnDesktopPanel({ m }: { m: NotesModel }) {
  const { t, note } = m;
  if (note?.onDesktop !== true) return null;
  return (
    <div className="on-desktop">
      <h2 className="on-desktop-heading">{m.shownTitle}</h2>
      <DesktopIcon size={28} />
      <p className="on-desktop-title">{t("notes.onDesktop")}</p>
      <p className="muted">{t("notes.onDesktopHint")}</p>
      <div className="on-desktop-actions">
        <button type="button" className="primary-button" onClick={m.bringToFront}>
          {t("notes.bringToFront")}
        </button>
        <button type="button" className="secondary-button" onClick={() => void m.backFromDesktop()}>
          {t("notes.backFromDesktop")}
        </button>
      </div>
    </div>
  );
}

/** A captured text that could not become a note waits in the draft, with a way to copy it. */
export function HeldPanel({ m }: { m: NotesModel }) {
  const { t } = m;
  if (!m.held || m.note?.id !== null) return null;
  return (
    <div className="note-held" role="status">
      <p>{t("notes.heldHint")}</p>
      <button type="button" className="secondary-button" onClick={() => void m.copyOpenText()}>
        {t("notes.copyMarkdown")}
      </button>
    </div>
  );
}

export function UnsavedMark({ m }: { m: NotesModel }) {
  if (m.openText === null || !m.unsaved) return null;
  return <span className="note-unsaved">{m.t("notes.unsaved")}</span>;
}

export function PreviewToggle({ m }: { m: NotesModel }) {
  const { t, openText } = m;
  if (openText === null) return null;
  return (
    <button
      type="button"
      className={m.preview ? "icon-button toggle on" : "icon-button toggle"}
      aria-pressed={m.preview}
      aria-label={t("notes.preview")}
      title={t("notes.preview")}
      disabled={openText.id === null}
      onClick={m.togglePreview}
    >
      <EyeIcon />
    </button>
  );
}

/** "Ctrl+Shift+N starts a quick note", with the keys as keys. */
export function QuickHint({ m }: { m: NotesModel }) {
  const [before = "", after = ""] = m.t("notes.emptyHint").split("{keys}");
  const parts = PLATFORM === "mac" ? [m.quickKeys] : m.quickKeys.split("+");
  return (
    <p className="notes-empty-hint">
      {before}
      {parts.map((part, index) => (
        <span key={part}>
          {index > 0 && "+"}
          <kbd>{part}</kbd>
        </span>
      ))}
      {after}
    </p>
  );
}

/** Nothing written yet: one invitation to write, nothing else. `mark` draws the look's picture. */
export function Welcome({ m, mark }: { m: NotesModel; mark: React.ReactNode }) {
  const { t, writable } = m;
  return (
    <div className="notes-welcome">
      {mark}
      <h2>{t("notes.emptyTitle")}</h2>
      {(writable || m.shownScope.kind !== "all") && <p>{emptyAreaText(m)}</p>}
      {m.canCreate && (
        <>
          <button type="button" className="primary-button" data-focus-id="new" onClick={m.newNote}>
            <PlusIcon />
            {t("notes.new")}
          </button>
          <QuickHint m={m} />
        </>
      )}
    </div>
  );
}

/** The element the editor lives in; it tells the notes area when it appears and goes. */
function EditorHost({
  attach,
  hidden,
}: {
  attach: (element: HTMLDivElement | null, gone?: HTMLElement) => void;
  hidden: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = host.current;
    attach(element);
    return () => {
      if (element) attach(null, element);
    };
  }, [attach]);
  return <div className="note-editor" ref={host} hidden={hidden} />;
}

/** The search's input; it tells the notes area where it is, for the keys that focus it. */
function SearchInput({
  attach,
  ...props
}: {
  attach: (element: HTMLInputElement | null, gone?: HTMLElement) => void;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const element = input.current;
    attach(element);
    return () => {
      if (element) attach(null, element);
    };
  }, [attach]);
  return <input ref={input} {...props} />;
}
