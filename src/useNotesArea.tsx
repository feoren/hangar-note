// The one logic of the notes area (ADR 0002 phase 1, ADR 0004): state, saving, leaving, notices,
// errors, menus and keyboard handling exist once here; each layout (HangarLayout,
// HangarNarrowLayout, PaperLayout) only lays out what this hook offers. The flow (quick note that
// exists only once you type, automatic title, saving 500 ms after the last keystroke and on leaving a note, trash
// with undo) follows Hangar's src/NotesPanel.tsx (MIT, same owner).
//
// One editor per note: a note on the desktop is edited in its sticky note; here it shows
// "On the desktop" with "Bring to front" and "Edit here".

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import {
  copyNote,
  createNote,
  deleteNote,
  exportNote,
  fromDesktop,
  getStatus,
  isChanged,
  isReadOnly,
  listNoteFolders,
  listNotes,
  MAX_NOTE_BYTES,
  noteFlushed,
  onFlushRequested,
  onHubRequests,
  onNotesChanged,
  readNote,
  renameNote,
  restoreNote,
  revealNote,
  revealNotesFolder,
  searchNotes,
  setHubOnTop,
  setLastProject,
  setNoteColor,
  setSettings,
  takeHubRequests,
  toDesktop,
  utf8Bytes,
  windowReady,
  writeNote,
  type FolderInfo,
  type HubRequest,
  type NoteFolder,
  type OpenedNote,
  type Status,
} from "./api";
import { settingsWith, toggledTheme, type AppSettings } from "./appSettings";
import { copyText } from "./clipboard";
import { colorName, NOTE_COLORS, swatchColor, withColorName, type NoteColor } from "./colors";
import { createCursorStore } from "./cursorStats";
import { createNoteEditor, type EditCommand, type NoteEditor } from "./editor";
import { errorActionLabel, errorMessage, type ErrorAction, type ErrorMessage } from "./errors";
import { captureStamp } from "./format";
import { DICTIONARIES, LANGUAGES, useT, type MessageKey } from "./i18n";
import { CheckIcon, DesktopIcon } from "./icons";
import { createLeaveAnyway } from "./leaveAnyway";
import {
  byLastChange,
  cleanTitle,
  colorCounts,
  filterByColors,
  folderName,
  GENERAL_FOLDER,
  isUntitled,
  nextAutoTitle,
  noteKey,
  sameFolder,
  sameNote,
  titleFromText,
  type NoteRef,
} from "./notes";
import {
  activeProject,
  isProject,
  levelOf,
  LEVELS,
  mixesScopes,
  newNoteFolder,
  scopeFolders,
  scopeForFolder,
  scopeOfLevel,
  startScope,
  type Level,
  type NotesScope,
} from "./notesScope";
import { clearNotice, noNotices, putNotice, shownNotice, type NoticeSlots } from "./notices";
import { NoticeSlot, type Notice } from "./NoticeSlot";
import {
  appendCapture,
  checklistProgress,
  noteExcerpt,
  toggleTaskAtLine,
  type ChecklistProgress,
} from "./noteText";
import type { Look } from "./looks";
import { lookToHold, opensOnlyByChoice } from "./paperSheet";
import { PopupMenu, type MenuItem } from "./PopupMenu";
import { forgetColorSection } from "./sidebarColors";
import {
  currentPlatform,
  hubShortcutLabel,
  levelShortcutLabel,
  matchHubShortcut,
  matchLevelShortcut,
  matchNoteShortcut,
  matchRowShortcut,
} from "./shortcuts";

const SAVE_DELAY_MS = 500;
/** Word count, progress and preview follow the text after a short pause. */
const STATS_DELAY_MS = 250;
const SEARCH_DELAY_MS = 200;
const HUB_LABEL = "hub";
export const PLATFORM = currentPlatform();

/** "Note" in every language: a title created in another language also counts as new. */
const UNTITLED_BASES = LANGUAGES.map((language) => DICTIONARIES[language]["notes.untitled"]);

// Remembered while the app runs, so closing and reopening the window finds things as they were.
// `null`: nothing chosen yet, the window starts where `startScope` says.
let lastScope: NotesScope | null = null;
/** The project chosen by hand (the project menu, the sidebar), until Hangar names another. */
let lastChosen: string | null = null;
let lastColors: ReadonlySet<NoteColor> = new Set();
/** Notes shown as preview. */
const previewNotes = new Set<string>();

/**
 * Forgets what this run remembered (the level, the chosen project, the colors, the previews), as
 * a new start does. For tests, which render many notes areas in one run.
 */
export function forgetSession(): void {
  lastScope = null;
  lastChosen = null;
  lastColors = new Set();
  previewNotes.clear();
  forgetColorSection();
}

/** The note in the editor. `id === null`: a new quick note that exists only once you type. */
export interface Current {
  folder: NoteFolder;
  id: string | null;
  title: string;
  autoTitled: boolean;
  onDesktop: boolean;
  color: NoteColor;
}

export interface Stats {
  progress: ChecklistProgress;
  /** Title the note gets on leaving (automatic title), `null` if it keeps its own. */
  autoTitle: string | null;
  /** The title the first line gives (`titleFromText`), `null` without such a line. */
  firstTitle: string | null;
}

export interface Row extends NoteRef {
  title: string;
  updatedAt: number | null;
  color: NoteColor;
  onDesktop: boolean;
  excerpt: string;
  progress: ChecklistProgress | null;
  /** The start of the content for a card; `null` for a search hit, which has only its excerpt. */
  preview: string | null;
}

export type View = "browse" | "trash" | "settings";

/**
 * The open menu: the project tab's project switch ("project"), the open note's "…" with or
 * without its colors ("note", "noteActions"), the open note's colors alone ("noteColor"),
 * a row's color tool, a row's context menu (right click, the menu key or Shift+F10), or the
 * context menu of a color in the sidebar ("navColor": rename it).
 */
export type MenuState =
  | {
      kind: "note" | "noteActions" | "noteColor" | "project";
      anchor: HTMLElement;
    }
  | { kind: "row" | "rowColor"; anchor: HTMLElement; row: Row; at?: { x: number; y: number } }
  | { kind: "navColor"; anchor: HTMLElement; color: NoteColor; at?: { x: number; y: number } };

export type MenuKind = MenuState["kind"];

/** Where the focus goes back to after the trash or the settings (`data-focus-id`). */
export type ReturnFocus = "trash" | "settings";

/** An entry of the sidebar: "All notes" or one project (which the "Project" level then shows). */
export interface ScopeEntry {
  key: string;
  scope: NotesScope;
  /** "main" for All, "project" for a working folder. */
  group: "main" | "project";
  /** The project's folder, `null` for All. */
  path: string | null;
  label: string;
  /** The tooltip: what the entry holds (a project's full path). */
  title: string;
  count: number | undefined;
}

/** One of the three level tabs above the notes. */
export interface LevelTab {
  level: Level;
  label: string;
  /** The tab's own short name ("Project" without its project, which the sidebar names below). */
  short: string;
  /** The tooltip: what the level holds (for "Project" its full path) and its shortcut. */
  title: string;
}

/**
 * What the team level can show. Team notes are opened and sealed through Hangar (ADR 0002), whose
 * team routes come in Hangar's phase 2; until then the level says that Hangar is needed. The
 * connected states (a list of the project's team notes) are added here when those routes exist.
 */
export type TeamState = { kind: "needsHangar" };

/** The sidebar entry shown as the current place besides the areas. */
export type Place = "trash" | "settings" | null;

function current(note: OpenedNote): Current {
  return {
    folder: { path: note.path },
    id: note.id,
    title: note.title,
    autoTitled: note.autoTitled,
    onDesktop: note.onDesktop,
    color: note.color,
  };
}

/** The color dot of a swatch or the filter as a custom property (styles.css draws the dot). */
export function dotStyle(color: NoteColor): Record<string, string> {
  return { "--dot": swatchColor(color) };
}

export function revealKey(): MessageKey {
  if (PLATFORM === "windows") return "notes.revealExplorer";
  if (PLATFORM === "mac") return "notes.revealFinder";
  return "notes.revealFileManager";
}

export function useNotesArea(app: AppSettings) {
  const t = useT();
  const { theme, language, settings } = app;
  const colorNames = settings?.colorNames ?? {};
  const [status, setStatus] = useState<Status | null>(null);
  const [folders, setFolders] = useState<FolderInfo[]>([]);
  const [scope, setScope] = useState<NotesScope | null>(lastScope);
  const [chosen, setChosen] = useState<string | null>(lastChosen);
  const [colors, setColors] = useState<ReadonlySet<NoteColor>>(lastColors);
  const [view, setView] = useState<View>("browse");
  const [pane, setPane] = useState<"list" | "note">("list");
  const [list, setList] = useState<Row[] | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ query: string; rows: Row[] } | null>(null);
  const [note, setNote] = useState<Current | null>(null);
  const [stats, setStats] = useState<Stats>({
    progress: { done: 0, total: 0 },
    autoTitle: null,
    firstTitle: null,
  });
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewTick, setPreviewTick] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  /** The sidebar color whose name is being edited in place. */
  const [renamingColor, setRenamingColor] = useState<NoteColor | null>(null);
  /**
   * The one notice place (notices.ts). "Not saved" there means leaving was refused because the
   * open note is not saved: it warns and offers to copy the text.
   */
  const [notices, setNotices] = useState<NoticeSlots<Notice>>(noNotices);
  const [listFailed, setListFailed] = useState(false);
  /** Typed text waits for its save (the footer says "Saving…" instead of "Saved"). */
  const [dirty, setDirty] = useState(false);
  /** The row that takes the Tab stop of the list (roving tab index); arrows move it. */
  const [focusKey, setFocusKey] = useState<string | null>(null);
  /** The open draft has text that could not become a note (read only): offer to copy it. */
  const [held, setHeld] = useState(false);
  /** The open note's last save failed; it stays open until a save works. */
  const [unsaved, setUnsaved] = useState(false);
  /** The switch as set in this window, until the settings bring the stored state. */
  const [onTopSet, setOnTopSet] = useState<boolean | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /**
   * The look as the settings name it, once they were read. A change to a look whose note opens
   * only by choice (paper, paperSheet.ts) keeps the old look drawn (`heldLook`) until the open
   * note is saved and closed, so its sheet never shows by itself, not even for a moment.
   */
  const knownLook = settings === null ? null : app.look;
  const [seenLook, setSeenLook] = useState(knownLook);
  const [heldLook, setHeldLook] = useState<Look | null>(null);
  if (seenLook !== knownLook) {
    setSeenLook(knownLook);
    setHeldLook(lookToHold(seenLook, knownLook, note !== null));
  }
  /** The look the notes area draws. */
  const look = heldLook ?? app.look;
  const lookRef = useRef(look);
  useEffect(() => {
    lookRef.current = look;
  });

  const noteRef = useRef<Current | null>(null);
  const textRef = useRef("");
  const pending = useRef<{ folder: NoteFolder; id: string; text: string } | null>(null);
  /** The version each note was last read or saved with (`noteKey`), sent as `expected`. */
  const versions = useRef(new Map<string, string>());
  /**
   * The note whose file was changed outside (`noteKey`): nothing more is written to it until the
   * person reloads it or leaves it, since every save would be refused the same way.
   */
  const conflict = useRef<string | null>(null);
  /** Saves run one after the other, so each sends the version the one before it brought back. */
  const saving = useRef<Promise<boolean>>(Promise.resolve(true));
  const saveTimer = useRef<number | null>(null);
  const statsTimer = useRef<number | null>(null);
  const creating = useRef<Promise<boolean> | null>(null);
  const generation = useRef(0);
  const editorHost = useRef<HTMLDivElement>(null);
  /** The cursor's numbers for the status line; only the status line renders when they change. */
  const [cursor] = useState(createCursorStore);
  const editor = useRef<NoteEditor | null>(null);
  /** The element the editor lives in, to notice when React replaced it. */
  const editorOn = useRef<HTMLElement | null>(null);
  /** The editor had the focus: a new one (another look, back from the trash) takes it over. */
  const editorFocused = useRef(false);
  /** A note was opened to be written in before its editor had an element (paper's sheet). */
  const focusWanted = useRef(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const shown = useRef(false);
  const rows = useRef(new Map<string, HTMLElement>());
  const leaveAnyway = useRef(createLeaveAnyway());
  /** Ticks on cards, one after the other, so two quick ticks never overwrite each other. */
  const taskQueue = useRef<Promise<void>>(Promise.resolve());
  const reloadRef = useRef<() => Promise<void>>(() => Promise.resolve());
  /** The control the trash or the settings were opened from, to give the focus back to. */
  const returnFocus = useRef<ReturnFocus>("trash");
  /** What the one button of an error does; filled once the actions below exist. */
  const errorActions = useRef<Record<ErrorAction, () => void>>({
    openFolder: () => undefined,
    reload: () => undefined,
    retry: () => undefined,
  });
  /** The notice for a note changed outside; filled once the actions below exist. */
  const changedNotice = useRef<() => Notice>(() => ({ message: "" }));

  const writable = status?.access.state === "writable";
  const writableRef = useRef(writable);
  useEffect(() => {
    writableRef.current = writable;
  });
  /** The folder Hangar Note was opened for (`--folder`), `null` without one. */
  const opened = status?.project ?? null;
  const project = activeProject({
    chosen,
    opened,
    last: settings?.lastProject ?? null,
    folders,
  });
  const privateCount =
    folders.length === 0 ? undefined : (folders.find((info) => info.path === null)?.noteCount ?? 0);
  const shownScope = scope ?? startScope(opened, privateCount, project);
  const listFolders = scopeFolders(shownScope, project, folders);
  // General and "no folder at all" (a level without notes here) must not share a key.
  const listKey = listFolders
    .map((folder) => (folder.path === null ? "general" : `path:${folder.path}`))
    .join("|");
  /** Where "New note" writes; `null` where nothing can be written (Team, or no project). */
  const newFolder = newNoteFolder(shownScope, project);
  const canCreate = writable && newFolder !== null;
  const mixed = mixesScopes(shownScope);
  const level = levelOf(shownScope);
  const team: TeamState = { kind: "needsHangar" };
  const general = t("notes.general");
  const preview =
    note?.id != null && !note.onDesktop && previewNotes.has(noteKey({ ...note, id: note.id }));

  useEffect(() => {
    lastScope = scope;
    lastChosen = chosen;
    lastColors = colors;
  }, [scope, chosen, colors]);

  /** The project last sent to `settings.json`, so the same one is not written again. */
  const rememberedProject = useRef<string | null | undefined>(undefined);
  /**
   * The project the "Project" level shows, remembered for the next start without a folder. A
   * backend that does not know the setting yet (before a restart) answers an error: the choice
   * still holds while the app runs, and nothing needs saying.
   */
  const rememberProject = useCallback(
    (path: string) => {
      const known = rememberedProject.current ?? settings?.lastProject ?? null;
      if (known === path) return;
      rememberedProject.current = path;
      void setLastProject(path).catch(() => null);
    },
    [settings?.lastProject],
  );
  const foldersRef = useRef(listFolders);
  useEffect(() => {
    foldersRef.current = listFolders;
  });

  /** A quiet info, e.g. "Deleted" with "Undo"; it goes after a few seconds. */
  const inform = useCallback((notice: Notice) => {
    setNotices((slots) => putNotice(slots, "info", notice));
  }, []);

  /** An error; it stays until it is fixed or dismissed. */
  const report = useCallback((notice: Notice) => {
    setNotices((slots) => putNotice(slots, "error", notice));
  }, []);

  /** The sentence of an error (errors.ts) with its one helpful button. */
  const toNotice = useCallback(
    (message: ErrorMessage, source?: "save"): Notice => {
      const action = message.action;
      return {
        message: t(message.key),
        source,
        action:
          action === null
            ? undefined
            : {
                label: t(errorActionLabel(action)),
                run: () => {
                  errorActions.current[action]();
                },
              },
      };
    },
    [t],
  );

  /** An error from the backend as a plain sentence; "read only" has its own quiet line already. */
  const fail = useCallback(
    (e: unknown) => {
      const message = errorMessage(e, "action");
      if (message === null) {
        void getStatus()
          .then(setStatus)
          .catch(() => null);
        return;
      }
      report(toNotice(message));
    },
    [report, toNotice],
  );

  /** The first answer about the folder (or its failure) has come: the start level is known. */
  const [statusAsked, setStatusAsked] = useState(false);
  const loadStatus = useCallback(() => {
    void getStatus()
      .then(setStatus)
      .catch(() => null)
      .finally(() => {
        setStatusAsked(true);
      });
  }, []);

  const reloadFolders = useCallback(() => {
    void listNoteFolders()
      .then(setFolders)
      .catch(() => null);
  }, []);

  const computeStats = useCallback((content: string, open: Current | null) => {
    setStats({
      progress: checklistProgress(content),
      autoTitle:
        open === null
          ? null
          : open.id === null
            ? nextAutoTitle({ title: "", autoTitled: true }, content, UNTITLED_BASES)
            : nextAutoTitle(open, content, UNTITLED_BASES),
      firstTitle: titleFromText(content),
    });
  }, []);

  // ---- Saving ----------------------------------------------------------------------------------

  const hasPending = () => pending.current !== null;

  /** Remembers the version a note was read with, for its next save. */
  const remember = useCallback((note: OpenedNote) => {
    versions.current.set(noteKey({ folder: { path: note.path }, id: note.id }), note.version);
  }, []);

  const flushNow = useCallback(async (): Promise<boolean> => {
    const job = pending.current;
    if (!job) return true;
    const key = noteKey(job);
    // Changed outside: the text stays pending, the notice already says what to do.
    if (conflict.current === key) return false;
    pending.current = null;
    if (utf8Bytes(job.text) > MAX_NOTE_BYTES) {
      pending.current = job;
      setUnsaved(true);
      report({ message: t("notes.tooLarge"), source: "save" });
      return false;
    }
    try {
      const version = await writeNote(job.folder, job.id, job.text, versions.current.get(key));
      versions.current.set(key, version);
      setUnsaved(false);
      setNotices((slots) => clearNotice(slots, "unsaved"));
      // Typed meanwhile: that text is still on its way. Read through a call, since the await above
      // may have changed it.
      if (!hasPending()) setDirty(false);
      // A save error is fixed once a save works again.
      setNotices((slots) => (slots.error?.source === "save" ? clearNotice(slots, "error") : slots));
      leaveAnyway.current.reset();
      // The row follows the saved text at once; reading every note again after each save would
      // cost more than it shows.
      setList((rows) =>
        rows === null
          ? rows
          : rows.map((row) =>
              sameNote(row, job)
                ? {
                    ...row,
                    excerpt: noteExcerpt(job.text, row.title),
                    progress: checklistProgress(job.text),
                    preview: job.text,
                    updatedAt: Date.now(),
                  }
                : row,
            ),
      );
      return true;
    } catch (e) {
      // Kept for the next attempt, unless newer text replaced it meanwhile.
      pending.current ??= job;
      setUnsaved(true);
      if (isChanged(e)) {
        conflict.current = key;
        report(changedNotice.current());
        // The row still shows the last save, which the change outside replaced on disk.
        void reloadRef.current();
        return false;
      }
      const message = errorMessage(e, "save");
      if (message === null) fail(e);
      else report(toNotice(message, "save"));
      return false;
    }
  }, [fail, report, toNotice, t]);

  const flush = useCallback((): Promise<boolean> => {
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const run = saving.current.then(flushNow, flushNow);
    saving.current = run;
    return run;
  }, [flushNow]);

  /**
   * Creates the quick note in the backend as soon as it has content. `true` when the open draft
   * is a note now (or needs none yet). The list shows the new note at once.
   */
  const ensureCreated = useCallback(async (): Promise<boolean> => {
    if (creating.current) return creating.current;
    const draft = noteRef.current;
    if (!draft || draft.id !== null || textRef.current.trim() === "") return true;
    const work = (async () => {
      try {
        const made = await createNote(draft.folder, t("notes.untitled"));
        remember(made);
        const created: Current = current(made);
        // The window may already show another note; then the new one is only saved.
        if (noteRef.current === draft) {
          noteRef.current = created;
          setNote(created);
          setHeld(false);
        }
        pending.current = { folder: created.folder, id: made.id, text: textRef.current };
        const saved = await flush();
        // Creating a note is not announced by the backend (the notes area made it itself).
        reloadFolders();
        void reloadRef.current();
        return saved;
      } catch (e) {
        if (isReadOnly(e)) writableRef.current = false;
        if (noteRef.current === draft) setHeld(true);
        fail(e);
        return false;
      }
    })();
    creating.current = work;
    const made = await work;
    creating.current = null;
    return made;
  }, [fail, flush, reloadFolders, remember, t]);

  /**
   * Leaving the open note: save, give a new note its title from the first line, and drop a new
   * note that ended up empty. `false` when the text could not be saved.
   */
  const leave = useCallback(async (): Promise<boolean> => {
    await (creating.current ?? Promise.resolve(true));
    const saved = await flush();
    const open = noteRef.current;
    if (!saved || !open || open.id === null || open.onDesktop || !writableRef.current) {
      return saved;
    }
    const content = textRef.current;
    try {
      if (content.trim() === "" && open.autoTitled) {
        await deleteNote(open.folder, open.id);
        return true;
      }
      const title = nextAutoTitle(open, content, UNTITLED_BASES);
      if (title !== null) {
        await renameNote(open.folder, open.id, title, false);
        const renamed = { ...open, title };
        if (noteRef.current === open) {
          noteRef.current = renamed;
          setNote(renamed);
        }
      }
    } catch {
      // The note keeps its title; the next leave tries again.
    }
    return true;
  }, [flush]);

  /**
   * Leaving because the person asked to (another note, the list, the trash, the settings, a new
   * note). A note that cannot save stays open with a warning and "Copy as Markdown"; a second
   * try within 10 s leaves it without the unsaved text (leaveAnyway.ts). Requests from the
   * command line or Hangar use `leave` and never drop text.
   */
  const leaveByPerson = useCallback(async (): Promise<boolean> => {
    if (await leave()) {
      leaveAnyway.current.reset();
      setNotices((slots) => clearNotice(slots, "unsaved"));
      return true;
    }
    if (!leaveAnyway.current.refused()) {
      const warning: Notice = {
        message: t("notes.leaveUnsaved"),
        action: {
          label: t("notes.copyMarkdown"),
          run: () => {
            // The result shows inside the warning itself; an info would wait behind it.
            void copyText(textRef.current).then((copied) => {
              setNotices((slots) =>
                slots.unsaved === null
                  ? slots
                  : {
                      ...slots,
                      unsaved: {
                        ...slots.unsaved,
                        detail: t(copied ? "notes.copied" : "notes.copyFailed"),
                      },
                    },
              );
            });
          },
        },
      };
      setNotices((slots) => putNotice(slots, "unsaved", warning));
      return false;
    }
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    pending.current = null;
    // Left without the text after a change outside: the row shows the note as its file is now.
    if (conflict.current !== null) void reloadRef.current();
    conflict.current = null;
    setUnsaved(false);
    setDirty(false);
    setNotices((slots) => clearNotice(clearNotice(slots, "unsaved"), "error"));
    return true;
  }, [leave, t]);

  // ---- The editor ------------------------------------------------------------------------------

  const onEditorChange = useCallback(
    (next: string) => {
      const open = noteRef.current;
      if (!open || open.onDesktop) return;
      textRef.current = next;
      if (statsTimer.current !== null) window.clearTimeout(statsTimer.current);
      statsTimer.current = window.setTimeout(() => {
        statsTimer.current = null;
        computeStats(textRef.current, noteRef.current);
        setPreviewTick((tick) => tick + 1);
      }, STATS_DELAY_MS);
      if (open.id === null) {
        void ensureCreated();
        return;
      }
      pending.current = { folder: open.folder, id: open.id, text: next };
      setDirty(true);
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => void flush(), SAVE_DELAY_MS);
    },
    [computeStats, ensureCreated, flush],
  );
  const onEditorChangeRef = useRef(onEditorChange);
  useEffect(() => {
    onEditorChangeRef.current = onEditorChange;
  });

  /**
   * The editor, created on first use and kept for every note after that. The trash, the settings
   * and a change of the look replace the element it lives in; then it is made again in the new
   * one, with the open text (nothing typed is lost: the text and its pending save live here).
   */
  const ensureEditor = useCallback((): NoteEditor | null => {
    const host = editorHost.current;
    if (editor.current && editorOn.current === host) return editor.current;
    if (!host) return null;
    editor.current?.destroy();
    editorOn.current = host;
    editor.current = createNoteEditor(host, {
      text: "",
      label: t("note.editorLabel"),
      placeholder: t("notes.placeholder"),
      taskLabel: t("notes.task"),
      lineNumbers: true,
      onCursor: cursor.set,
      onChange: (text) => {
        onEditorChangeRef.current(text);
      },
      onFocus: (has) => {
        editorFocused.current = has;
        if (!has) void flush();
      },
    });
    return editor.current;
  }, [flush, t, cursor]);

  useEffect(
    () => () => {
      editor.current?.destroy();
      editor.current = null;
    },
    [],
  );

  /** Puts `content` into the editor for `open`. */
  const show = useCallback(
    (open: Current | null, content: string, focus: boolean) => {
      noteRef.current = open;
      textRef.current = content;
      // A new text in the editor: whatever was refused for the old one is over.
      conflict.current = null;
      setNote(open);
      setRenaming(false);
      setHeld(false);
      setUnsaved(false);
      setDirty(false);
      setPreviewHtml(null);
      computeStats(content, open);
      focusWanted.current = false;
      if (open !== null && !open.onDesktop) {
        const view = ensureEditor();
        view?.load(content);
        view?.setReadOnly(!writableRef.current);
        if (focus && view) {
          requestAnimationFrame(() => {
            view.focus();
          });
        } else if (focus) {
          focusWanted.current = true;
        }
      }
    },
    [computeStats, ensureEditor],
  );

  useEffect(() => {
    editor.current?.setReadOnly(!writable);
  }, [writable]);

  // A new element for the editor (back from the trash or the settings, another look, the sheet of
  // the paper look): it gets its editor again, with the open text and, if it had it, the focus.
  useEffect(() => {
    if (view !== "browse") return;
    const open = noteRef.current;
    if (open === null || open.onDesktop) return;
    if (editor.current && editorOn.current === editorHost.current) return;
    const focused = editorFocused.current || focusWanted.current;
    focusWanted.current = false;
    const fresh = ensureEditor();
    fresh?.load(textRef.current);
    fresh?.setReadOnly(!writableRef.current);
    if (focused) fresh?.focus();
  });

  // ---- Loading ---------------------------------------------------------------------------------

  const reloadList = useCallback(async () => {
    try {
      const lists = await Promise.all(foldersRef.current.map((folder) => listNotes(folder)));
      const next = byLastChange(
        lists.flat().map((row): Row => ({
          folder: { path: row.path },
          id: row.id,
          title: row.title,
          updatedAt: row.updatedAt,
          color: row.color,
          onDesktop: row.onDesktop,
          excerpt: noteExcerpt(row.preview, row.title),
          progress: checklistProgress(row.preview),
          preview: row.preview,
        })),
      );
      setList(next);
      setListFailed(false);
      // The open note's sticky note was closed elsewhere: edit it here again, fresh from disk.
      const open = noteRef.current;
      if (open?.id != null) {
        const row = next.find((r) => sameNote(r, { folder: open.folder, id: open.id ?? "" }));
        if (row && row.onDesktop !== open.onDesktop) {
          const fresh = await readNote(open.folder, open.id);
          if (noteRef.current === open) {
            remember(fresh);
            show(current(fresh), fresh.text, false);
          }
        }
      }
    } catch (e) {
      // An empty list here would read as "no notes yet"; the list says it could not load instead.
      if (isReadOnly(e)) fail(e);
      else setListFailed(true);
      setList((old) => old ?? []);
    } finally {
      if (!shown.current) {
        shown.current = true;
        void windowReady().catch(() => null);
      }
    }
    // `listKey` names the folders; the array itself is rebuilt on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listKey, fail, remember, show]);

  useEffect(() => {
    reloadRef.current = reloadList;
  });

  /**
   * The open note again as its file is now, after a change outside (Hangar, a sync), without a
   * click: only while nothing typed here waits for its save and no save is on its way. With
   * unsaved text the next save is refused as `changed`, and that notice asks first.
   */
  const refreshOpen = useCallback(async () => {
    /** Typed text waits for its save, or a save was refused: the text here wins. */
    const busy = () => pending.current !== null || conflict.current !== null;
    const run = saving.current;
    await run;
    const open = noteRef.current;
    if (open?.id == null || open.onDesktop || creating.current !== null || busy()) return;
    const key = noteKey({ folder: open.folder, id: open.id });
    let fresh: OpenedNote;
    try {
      fresh = await readNote(open.folder, open.id);
    } catch {
      // Deleted or unreadable: the list shows what is left, the next save says why.
      return;
    }
    // A save that started while the note was read has taken its text out of `pending`; the text
    // in the editor is newer than the file read here.
    if (noteRef.current !== open || busy() || saving.current !== run) return;
    if (versions.current.get(key) === fresh.version) return;
    remember(fresh);
    show(current(fresh), fresh.text, editorFocused.current);
  }, [remember, show]);
  const refreshRef = useRef(refreshOpen);
  useEffect(() => {
    refreshRef.current = refreshOpen;
  });

  // The first list waits for the status: before it, the start level could still change from
  // "Private" to Hangar's project, and the window, shown once its first list is there, would
  // show the wrong level for a moment.
  useEffect(() => {
    if (!statusAsked) return;
    void Promise.resolve().then(reloadList);
  }, [reloadList, statusAsked]);

  useEffect(() => {
    loadStatus();
    reloadFolders();
    const onFocus = () => {
      loadStatus();
    };
    window.addEventListener("focus", onFocus);
    const unlisten = onNotesChanged(() => {
      reloadFolders();
      void reloadRef.current();
      void refreshRef.current();
    }).catch(() => null);
    const tick = window.setInterval(() => {
      setNow(Date.now());
    }, 30_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(tick);
      void unlisten.then((stop) => stop?.());
    };
  }, [loadStatus, reloadFolders]);

  // Search across all notes, shortly after the last keystroke.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === "") return;
    let live = true;
    const timer = window.setTimeout(() => {
      searchNotes(trimmed)
        .then((found) => {
          if (!live) return;
          setHits({
            query: trimmed,
            rows: found.map((hit) => ({
              folder: { path: hit.path },
              id: hit.id,
              title: hit.title,
              updatedAt: hit.updatedAt,
              color: hit.color,
              onDesktop: hit.onDesktop,
              excerpt: hit.excerpt,
              progress: null,
              preview: null,
            })),
          });
        })
        .catch((e: unknown) => {
          if (live) fail(e);
        });
    }, SEARCH_DELAY_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query, fail, list]);

  // ---- Opening and creating --------------------------------------------------------------------

  const openNote = useCallback(
    async (ref: NoteRef, focus: boolean, byPerson = true) => {
      generation.current += 1;
      const mine = generation.current;
      const open = noteRef.current;
      if (open?.id != null && sameNote({ folder: open.folder, id: open.id }, ref)) {
        await flush();
      } else if (!(await (byPerson ? leaveByPerson() : leave()))) {
        // Not saved: switching would lose the text. The note stays open and says so.
        return;
      }
      // A tick on a card may still be on its way to this note: read the text with it.
      await taskQueue.current;
      if (mine !== generation.current) return;
      try {
        const opened = await readNote(ref.folder, ref.id);
        if (mine !== generation.current) return;
        remember(opened);
        show(current(opened), opened.text, focus);
        setPane("note");
        setView("browse");
      } catch (e) {
        if (mine === generation.current) fail(e);
      }
    },
    [fail, flush, leave, leaveByPerson, remember, show],
  );

  /**
   * A new quick note in `folder`; it is created once it has content. "stayed": the open note
   * could not be saved, so nothing changed. With `held`, a text the backend could not store waits
   * in the draft to be copied.
   */
  const startDraft = useCallback(
    async (
      folder: NoteFolder,
      focus: boolean,
      byPerson = false,
      held = "",
    ): Promise<"draft" | "stayed"> => {
      generation.current += 1;
      const mine = generation.current;
      const left = await (byPerson ? leaveByPerson() : leave());
      if (!left || mine !== generation.current) return "stayed";
      setView("browse");
      setPane("note");
      show(
        {
          folder,
          id: null,
          title: "",
          autoTitled: true,
          onDesktop: false,
          color: settings?.newNoteColor ?? "lemon",
        },
        held,
        focus,
      );
      if (held !== "") setHeld(true);
      return "draft";
    },
    [leave, leaveByPerson, settings?.newNoteColor, show],
  );

  /** The focus onto a row, else onto the search, else onto "New note". */
  const focusRow = (key: string | null) => {
    const row = key === null ? undefined : rows.current.get(key);
    if (row?.isConnected) {
      row.focus();
      return;
    }
    const search = searchInput.current;
    if (search?.isConnected) {
      search.focus();
      return;
    }
    document.querySelector<HTMLElement>('[data-focus-id="new"]')?.focus();
  };

  const backToList = useCallback(async () => {
    const open = noteRef.current;
    generation.current += 1;
    // Not saved: the note stays open and says so, instead of losing the text.
    if (!(await leaveByPerson())) return;
    show(null, "", false);
    setPane("list");
    await reloadRef.current();
    requestAnimationFrame(() => {
      focusRow(open?.id != null ? noteKey({ ...open, id: open.id }) : null);
    });
  }, [leaveByPerson, show]);

  /**
   * Saves and closes the open note where the look opens notes only by choice (paperSheet.ts), so
   * the list shows; `false` when it could not be saved and stays open. `byPerson`: the person
   * asked for the step (see `leaveByPerson`); otherwise no text is ever dropped. `still`: whether
   * the step is still wanted once the note is saved.
   */
  const closeForList = useCallback(
    async (byPerson: boolean, still: () => boolean = () => true): Promise<boolean> => {
      const open = noteRef.current;
      if (open === null) return true;
      generation.current += 1;
      const mine = generation.current;
      if (!(await (byPerson ? leaveByPerson() : leave()))) return false;
      // Another note opened meanwhile, or the step is no longer wanted.
      if (mine !== generation.current || !still()) return true;
      show(null, "", false);
      setPane("list");
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active === null || active === document.body) {
          focusRow(open.id != null ? noteKey({ ...open, id: open.id }) : null);
        }
      });
      return true;
    },
    [leave, leaveByPerson, show],
  );

  // The look turned to paper with a note open: saved and closed first, then paper shows its
  // cards. A note that cannot be saved stays open in its sheet, its notice says why.
  useEffect(() => {
    if (heldLook === null) return;
    let live = true;
    void Promise.resolve()
      .then(() => closeForList(false, () => live))
      .then(() => {
        if (live) setHeldLook(null);
      });
    return () => {
      live = false;
    };
  }, [heldLook, closeForList]);

  const newNote = () => {
    if (!writable || newFolder === null) return;
    setQuery("");
    void startDraft(newFolder, true, true);
  };

  // Requests from the command line and from Hangar: quick note, open a note, and a captured text
  // the backend could not store. A capture over the channel arrives as "open a note": the backend
  // has written it already, so nothing is created here.
  const handleRequests = useCallback(
    async (requests: HubRequest[], fresh: Status) => {
      /** Hangar named its working folder: the "Project" level shows it from now on. */
      const followHangar = (path: string) => {
        setChosen(path);
        rememberProject(path);
        setScope({ kind: "project" });
      };
      for (const request of requests) {
        switch (request.kind) {
          case "showProject":
            // Hangar shows its project, not a note: paper shows the project's cards.
            if (opensOnlyByChoice(lookRef.current)) await closeForList(false);
            if (fresh.project !== null) followHangar(fresh.project);
            setQuery("");
            break;
          case "openNote": {
            const folder = { path: request.folder };
            if (request.folder === null) setScope(scopeForFolder(folder));
            else followHangar(request.folder);
            setQuery("");
            await openNote({ folder, id: request.id }, true, false);
            // A captured note is new: the list and the counts show it, even if it could not open.
            reloadFolders();
            void reloadRef.current();
            break;
          }
          case "quick": {
            setQuery("");
            // Into Hangar's project, else into the level shown; the team level has no notes to
            // write here, so the quick note goes to the private ones.
            let folder: NoteFolder = GENERAL_FOLDER;
            if (fresh.project !== null) {
              followHangar(fresh.project);
              folder = { path: fresh.project };
            } else if (newFolder !== null) {
              folder = newFolder;
            } else {
              setScope({ kind: "general" });
            }
            // Read only: no draft that could never be saved; the "Read only" chip says why.
            if (writableRef.current) await startDraft(folder, true);
            break;
          }
          case "capture": {
            // A text the backend could not store (read only): never created here, only held in
            // a draft with "Copy as Markdown", so it is not lost.
            const content = appendCapture(
              "",
              request.text,
              captureStamp(new Date(), language),
              folderName(request.folder),
              (time, source) => t("notes.capturedFrom", { source, time }),
            );
            const result = await startDraft({ path: request.folder }, false, false, content);
            if (result === "stayed") {
              report({
                message: t("notes.heldHint"),
                action: {
                  label: t("notes.copyMarkdown"),
                  run: () => {
                    void copyText(content).then((copied) => {
                      if (copied) setNotices((slots) => clearNotice(slots, "error"));
                    });
                  },
                },
              });
            }
            break;
          }
          case "sharedUnavailable":
            inform({ message: t("notes.sharedUnavailable") });
            break;
        }
      }
    },
    // `newFolder` is rebuilt every render; its path says when it changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      newFolder?.path,
      closeForList,
      language,
      openNote,
      inform,
      rememberProject,
      reloadFolders,
      report,
      startDraft,
      t,
    ],
  );
  const requestsRef = useRef(handleRequests);
  useEffect(() => {
    requestsRef.current = handleRequests;
  });

  useEffect(() => {
    const take = () => {
      void getStatus()
        .then((next) => {
          setStatus(next);
          // The requests run before the next render, so they read the fresh state here.
          writableRef.current = next.access.state === "writable";
          return takeHubRequests().then((requests) => requestsRef.current(requests, next));
        })
        .catch(() => null);
    };
    take();
    const unlisten = onHubRequests(take).catch(() => null);
    return () => {
      void unlisten.then((stop) => stop?.());
    };
  }, []);

  // Quitting and Hangar's `flush`: everything typed goes to disk first.
  useEffect(() => {
    const unlisten = onFlushRequested(HUB_LABEL, () => {
      void (async () => {
        await (creating.current ?? Promise.resolve(true));
        const saved = await flush();
        await noteFlushed(saved).catch(() => null);
      })();
    }).catch(() => null);
    return () => {
      void unlisten.then((stop) => stop?.());
    };
  }, [flush]);

  useEffect(
    () => () => {
      void flush();
      for (const timer of [saveTimer, statsTimer]) {
        if (timer.current !== null) window.clearTimeout(timer.current);
      }
    },
    [flush],
  );

  // Preview: rendered from the text, again after each pause while typing.
  useEffect(() => {
    if (!preview) return;
    let live = true;
    import("./markdownPreview")
      .then(({ renderMarkdown }) => {
        if (live) setPreviewHtml(renderMarkdown(textRef.current, !writable));
      })
      .catch(() => {
        if (live) report({ message: t("notes.editorFailed") });
      });
    return () => {
      live = false;
    };
  }, [preview, previewTick, note, writable, report, t]);

  // ---- Actions on the open note ----------------------------------------------------------------

  const commitRename = async (value: string) => {
    setRenaming(false);
    const open = noteRef.current;
    if (open?.id == null || value.trim() === open.title) return;
    const title = cleanTitle(value);
    if (title === null) {
      report({ message: t("notes.invalidTitle") });
      return;
    }
    try {
      await renameNote(open.folder, open.id, title, true);
      const renamed = { ...open, title, autoTitled: false };
      noteRef.current = renamed;
      setNote(renamed);
      computeStats(textRef.current, renamed);
      void reloadRef.current();
    } catch (e) {
      fail(e);
    }
  };

  const restore = async (folder: NoteFolder, id: string, title: string) => {
    try {
      const restored = await restoreNote(folder, id);
      inform({ message: t("notes.restored", { title }) });
      void reloadRef.current();
      reloadFolders();
      return restored;
    } catch (e) {
      fail(e);
      return undefined;
    }
  };

  const deleteRef = async (ref: NoteRef, title: string) => {
    try {
      if (
        noteRef.current?.id != null &&
        sameNote(ref, { ...noteRef.current, id: noteRef.current.id })
      ) {
        await flush();
        show(null, "", false);
        setPane("list");
      }
      // The focus goes to the row that takes the deleted one's place, else to the search.
      const keys = [...rows.current.entries()]
        .filter(([, element]) => element.isConnected)
        .sort(([, a], [, b]) =>
          a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
        )
        .map(([key]) => key);
      const index = keys.indexOf(noteKey(ref));
      const nextKey = index < 0 ? null : (keys[index + 1] ?? keys[index - 1] ?? null);
      // A tick on its card lands before the note goes to the trash, not after it.
      await taskQueue.current;
      await deleteNote(ref.folder, ref.id);
      await reloadRef.current();
      reloadFolders();
      const notice: Notice = {
        message: t("notes.deleted", { title }),
        action: {
          label: t("notes.undo"),
          run: () => {
            setNotices((slots) => clearNotice(slots, "info", notice));
            void restore(ref.folder, ref.id, title).then((restored) => {
              if (restored === undefined) return;
              // Paper opens a note only by choice: its card is back, with the focus on it.
              if (!opensOnlyByChoice(lookRef.current)) {
                void openNote({ folder: ref.folder, id: restored }, true);
                return;
              }
              void reloadRef.current().then(() => {
                requestAnimationFrame(() => {
                  focusRow(noteKey({ folder: ref.folder, id: restored }));
                });
              });
            });
          },
        },
      };
      inform(notice);
      requestAnimationFrame(() => {
        focusRow(nextKey);
      });
    } catch (e) {
      fail(e);
    }
  };

  const deleteCurrent = () => {
    const open = noteRef.current;
    if (!open) return;
    if (open.id === null) {
      show(null, "", false);
      setPane("list");
      return;
    }
    void deleteRef({ folder: open.folder, id: open.id }, open.title);
  };

  const putOnDesktop = async () => {
    const open = noteRef.current;
    if (open?.id == null) return;
    const id = open.id;
    try {
      // Saved and titled first: the sticky note reads the note from disk.
      if (!(await leave())) return;
      await toDesktop(open.folder, id);
      const placed = { ...(noteRef.current ?? open), onDesktop: true };
      show(placed, "", false);
      void reloadRef.current();
    } catch (e) {
      fail(e);
    }
  };

  const bringToFront = () => {
    const open = noteRef.current;
    if (open?.id == null) return;
    void toDesktop(open.folder, open.id).catch(fail);
  };

  const backFromDesktop = async () => {
    const open = noteRef.current;
    if (open?.id == null) return;
    try {
      await fromDesktop(open.folder, open.id);
      await openNote({ folder: open.folder, id: open.id }, true);
      void reloadRef.current();
    } catch (e) {
      fail(e);
    }
  };

  /** Is `ref` the note in the editor? */
  const isOpen = (ref: NoteRef) => {
    const open = noteRef.current;
    return open?.id != null && sameNote({ folder: open.folder, id: open.id }, ref);
  };

  /** A color for any note: the open one from its menu, others from their row. */
  const pickColor = (ref: NoteRef, color: NoteColor) => {
    void setNoteColor(ref.folder, ref.id, color)
      .then((saved) => {
        const open = noteRef.current;
        if (open?.id != null && sameNote({ folder: open.folder, id: open.id }, ref)) {
          const next = { ...open, color: saved };
          noteRef.current = next;
          setNote(next);
        }
        void reloadRef.current();
      })
      .catch(fail);
  };

  /** The open note's color, from wherever the look offers it. */
  const pickOpenColor = (color: NoteColor) => {
    const open = noteRef.current;
    if (open?.id != null) pickColor({ folder: open.folder, id: open.id }, color);
  };

  /** An action on a note's file; the open note is saved first, so the file has every word. */
  const withSaved = (ref: NoteRef, action: (folder: NoteFolder, id: string) => Promise<void>) => {
    void (isOpen(ref) ? flush() : taskQueue.current)
      .then(() => action(ref.folder, ref.id))
      .catch(fail);
  };

  /** The open text to the clipboard (a held draft), so it survives. */
  const copyOpenText = async () => {
    if (await copyText(textRef.current)) inform({ message: t("notes.copied") });
    else report({ message: t("notes.copyFailed") });
  };

  const togglePreview = () => {
    const open = noteRef.current;
    if (open?.id == null) return;
    const key = noteKey({ folder: open.folder, id: open.id });
    if (previewNotes.has(key)) previewNotes.delete(key);
    else previewNotes.add(key);
    setPreviewTick((tick) => tick + 1);
  };

  /** A click on a checkbox in the preview ticks the task in the text, through the editor. */
  const onPreviewClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.classList.contains("md-task")) return;
    const line = Number(target.dataset["line"]);
    if (!Number.isInteger(line) || !writable) {
      event.preventDefault();
      return;
    }
    if (toggleTaskAtLine(textRef.current, line) === textRef.current) return;
    editor.current?.toggleTask(line);
    computeStats(textRef.current, noteRef.current);
    setPreviewTick((tick) => tick + 1);
  };

  /**
   * A tick on a card (paper look). The open note ticks through its editor, like the preview, and
   * saves on its usual way. Any other note is read whole from disk (a card holds only its start),
   * and written only if the line still reads as the card showed it; a note on the desktop belongs
   * to its sticky note and is never written from here. Failures say why, as a failed save does.
   */
  const toggleRowTask = (row: Row, line: number, source: string) => {
    if (!writableRef.current || row.onDesktop) return;
    if (isOpen(row)) {
      editor.current?.toggleTask(line);
      computeStats(textRef.current, noteRef.current);
      return;
    }
    taskQueue.current = taskQueue.current.then(async () => {
      try {
        const fresh = await readNote(row.folder, row.id);
        const lines = fresh.text.split(/\r?\n/);
        if (fresh.onDesktop || lines[line] !== source) {
          await reloadRef.current();
          return;
        }
        const next = toggleTaskAtLine(fresh.text, line);
        if (next === fresh.text) return;
        setList((old) =>
          old === null
            ? old
            : old.map((item) =>
                sameNote(item, row)
                  ? {
                      ...item,
                      preview: next,
                      progress: checklistProgress(next),
                      excerpt: noteExcerpt(next, item.title),
                      updatedAt: Date.now(),
                    }
                  : item,
              ),
        );
        // Sent with the version it was read with: changed outside since, it is refused, the list
        // shows the note as it is now, and the tick is not set.
        await writeNote(row.folder, row.id, next, fresh.version);
        setNotices((slots) =>
          slots.error?.source === "save" ? clearNotice(slots, "error") : slots,
        );
      } catch (e) {
        const message = errorMessage(e, "save");
        if (message === null) fail(e);
        else report(toNotice(message, "save"));
        await reloadRef.current();
      }
    });
  };

  // Shortcuts: Ctrl+Shift+N quick note, F2 rename, and the formatting keys inside the editor.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const hub = matchHubShortcut(event, PLATFORM);
      if (hub === "quickNote") {
        event.preventDefault();
        // The team level has nowhere to write a note here yet.
        if (writableRef.current && newFolder !== null) {
          setQuery("");
          void startDraft(newFolder, true, true);
        }
        return;
      }
      if (hub === "rename") {
        const open = noteRef.current;
        if (view === "browse" && open?.id != null && !open.onDesktop && writableRef.current) {
          event.preventDefault();
          setRenaming(true);
        }
        return;
      }
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.closest(".note-editor")) return;
      const action = matchNoteShortcut(event, PLATFORM);
      if (action === null || action === "leave" || action === "newNote") return;
      event.preventDefault();
      event.stopPropagation();
      editor.current?.format(action);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
    };
  }, [newFolder, startDraft, view]);

  /**
   * The open note again as its file is now, after the person confirmed in the notice that their
   * change goes. Never without that confirmation.
   */
  const reloadChanged = async () => {
    const open = noteRef.current;
    if (open?.id == null) return;
    try {
      const fresh = await readNote(open.folder, open.id);
      if (noteRef.current !== open) return;
      if (saveTimer.current !== null) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      pending.current = null;
      remember(fresh);
      leaveAnyway.current.reset();
      setNotices((slots) => clearNotice(clearNotice(slots, "unsaved"), "error"));
      show(current(fresh), fresh.text, true);
      void reloadRef.current();
    } catch (e) {
      fail(e);
    }
  };

  /** "Changed outside" with "Reload" (asks first) and "Copy as Markdown". */
  const conflictNotice = (): Notice => ({
    message: t("error.changed"),
    source: "save",
    action: {
      label: t("notes.reloadNote"),
      run: () => {
        report({
          message: t("notes.reloadDiscards"),
          source: "save",
          action: {
            label: t("notes.reloadConfirm"),
            run: () => {
              void reloadChanged();
            },
          },
          secondAction: {
            label: t("notes.reloadCancel"),
            run: () => {
              report(conflictNotice());
            },
          },
        });
      },
    },
    secondAction: {
      label: t("notes.copyMarkdown"),
      run: () => {
        // The result shows inside the notice itself, as in the warning on leaving.
        void copyText(textRef.current).then((copied) => {
          setNotices((slots) =>
            slots.error === null
              ? slots
              : {
                  ...slots,
                  error: {
                    ...slots.error,
                    detail: t(copied ? "notes.copied" : "notes.copyFailed"),
                  },
                },
          );
        });
      },
    },
  });

  // The one helpful button of an error (errors.ts) does what its label says.
  useEffect(() => {
    changedNotice.current = conflictNotice;
    errorActions.current = {
      openFolder: () => {
        void revealNotesFolder(noteRef.current?.folder ?? newFolder ?? GENERAL_FOLDER).catch(fail);
      },
      reload: () => {
        setNotices((slots) => clearNotice(slots, "error"));
        reloadFolders();
        void reloadRef.current();
      },
      retry: () => {
        void flush();
      },
    };
  });

  // ---- What the list shows ---------------------------------------------------------------------

  const searching = query.trim() !== "";
  const shownHits = searching && hits?.query === query.trim() ? hits.rows : null;
  const allRows = shownHits ?? (searching ? [] : (list ?? []));
  const visible = filterByColors(allRows, colors);
  const counts = colorCounts(allRows);
  /** Rows name their project only where notes of several projects meet: All, and the search. */
  const showProject = shownScope.kind === "all" || searching;

  /** How many notes a scope holds, once the folders are known. */
  const knownCount = (folder: NoteFolder): number | undefined =>
    folders.length === 0
      ? undefined
      : (folders.find((info) => sameFolder({ path: info.path }, folder))?.noteCount ?? 0);
  const allCount =
    folders.length === 0 ? undefined : folders.reduce((sum, info) => sum + info.noteCount, 0);

  /**
   * Nothing written anywhere yet: the window shows one invitation to write and nothing else (no
   * search, no filter, no second "New note"). An empty area while other areas hold notes is not
   * this; its list says so and offers "New note" there.
   */
  const emptyMode =
    view === "browse" &&
    !searching &&
    colors.size === 0 &&
    !listFailed &&
    list !== null &&
    list.length === 0 &&
    note === null &&
    (allCount === undefined || allCount === 0);

  /**
   * The projects of the sidebar and of the project menu: every working folder with notes, the one
   * Hangar Note was opened for and the one the "Project" level shows (even while they have none,
   * so their empty level can be reached), by name.
   */
  const projectFolders = folders
    .flatMap((info): { path: string; name: string | null; count: number | undefined }[] =>
      info.path === null || info.noteCount === 0
        ? []
        : [{ path: info.path, name: info.name, count: info.noteCount }],
    )
    .concat(
      [opened, project?.path ?? null].flatMap((path) =>
        path === null ||
        folders.some(
          (info) =>
            info.path !== null && info.noteCount > 0 && sameFolder({ path: info.path }, { path }),
        )
          ? []
          : [{ path, name: null, count: knownCount({ path }) }],
      ),
    )
    .filter(
      (entry, index, all) =>
        all.findIndex((other) => sameFolder({ path: other.path }, { path: entry.path })) === index,
    )
    .map((entry) => ({ ...entry, label: entry.name ?? folderName(entry.path) }))
    .sort((a, b) => a.label.localeCompare(b.label, language));

  /** The sidebar's entries in its order: "All notes", then the projects. */
  const scopeEntries: ScopeEntry[] = [
    {
      key: "all",
      scope: { kind: "all" },
      group: "main",
      path: null,
      label: t("note.allNotes"),
      title: t("notes.scopeAllTip"),
      count: allCount,
    },
    ...projectFolders.map((entry) => ({
      key: `folder:${entry.path}`,
      scope: { kind: "project" } as const,
      group: "project" as const,
      path: entry.path,
      label: entry.label,
      title: entry.path,
      count: entry.count,
    })),
  ];
  const projectName =
    project === null
      ? null
      : (projectFolders.find((entry) => sameFolder({ path: entry.path }, project))?.label ??
        folderName(project.path ?? ""));
  const shownScopeLabel =
    shownScope.kind === "all"
      ? t("note.allNotes")
      : shownScope.kind === "general"
        ? t("level.privateTitle")
        : shownScope.kind === "team"
          ? t("team.title")
          : (projectName ?? t("level.project"));
  /** Is `entry` what the notes show now? A project only while the "Project" level shows it. */
  const isShownScope = (entry: ScopeEntry) =>
    entry.path === null
      ? shownScope.kind === "all"
      : shownScope.kind === "project" && isProject({ path: entry.path }, project);

  /** The three level tabs, the project one named after its project. */
  const levelTabs: LevelTab[] = LEVELS.map((each, index) => {
    const keys = levelShortcutLabel(index + 1, PLATFORM, t);
    switch (each) {
      case "private":
        return {
          level: each,
          label: t("level.private"),
          short: t("level.private"),
          title: `${t("notes.scopeGeneralTip")}\n${keys}`,
        };
      case "project":
        return {
          level: each,
          label:
            projectName === null
              ? t("level.project")
              : t("level.projectNamed", { name: projectName }),
          short: t("level.project"),
          title: `${project?.path ?? t("level.projectTip")}\n${keys}`,
        };
      case "team":
        return {
          level: each,
          label: t("level.team"),
          short: t("level.team"),
          title: `${t("level.teamTip")}\n${keys}`,
        };
    }
  });

  const projectLabel = (folder: NoteFolder) =>
    folder.path === null ? general : folderName(folder.path);
  const progressText = (progress: ChecklistProgress) =>
    t("notes.progress", { done: progress.done, total: progress.total });
  const shownTitle =
    note === null
      ? ""
      : note.id === null
        ? (stats.autoTitle ?? t("notes.quickNote"))
        : (stats.autoTitle ?? note.title);
  /**
   * The large title is left out where it would only repeat the first line: a note whose title
   * follows its first line (a new one, "Note 3", a title taken from the text) or whose first line
   * reads as its title. F2 and "Rename" still show the title field.
   */
  const titleShown =
    note !== null &&
    (renaming ||
      !(
        note.id === null ||
        note.autoTitled ||
        isUntitled(note.title, UNTITLED_BASES) ||
        stats.autoTitle !== null ||
        stats.firstTitle === note.title
      ));
  const quickKeys = hubShortcutLabel("quickNote", PLATFORM, t);

  const visibleKeys = visible.map((row) => noteKey(row));
  const activeKey = note?.id != null ? noteKey({ folder: note.folder, id: note.id }) : null;
  /** The row that is reached with Tab; the others are reached with the arrow keys. */
  const rovingKey =
    focusKey !== null && visibleKeys.includes(focusKey)
      ? focusKey
      : activeKey !== null && visibleKeys.includes(activeKey)
        ? activeKey
        : (visibleKeys[0] ?? null);

  /** The rows as they stand on the page, in reading order. */
  const orderedRows = () =>
    [...rows.current.values()]
      .filter((row) => row.isConnected)
      .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));

  const moveRowFocus = (index: number, step: number) => {
    const ordered = orderedRows();
    const next = ordered[index + step];
    if (next) next.focus();
    else if (index + step < 0) searchInput.current?.focus();
    else if (step > 1 && Math.floor(index / step) < Math.floor((ordered.length - 1) / step)) {
      // Down from a full row onto a shorter last one: its last card is the nearest.
      ordered[ordered.length - 1]?.focus();
    }
  };

  /** The element of a row that opens it, for the roving focus and the menus' anchor. */
  const registerRow = (key: string) => (element: HTMLElement | null) => {
    if (element) rows.current.set(key, element);
    else rows.current.delete(key);
  };

  /**
   * Arrow keys, Delete and the menu key on a row (or a card's title), in every look. `columns`:
   * the rows stand in a grid of that many columns (the paper look's cards); up and down then move
   * by a whole row, Home and End go to the first and the last card.
   */
  const onRowKeyDown = (
    row: Row,
    index: number,
    event: React.KeyboardEvent<HTMLElement>,
    columns?: number,
  ) => {
    const across = Math.max(1, columns ?? 1);
    const step =
      event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowLeft"
          ? -1
          : event.key === "ArrowDown"
            ? across
            : event.key === "ArrowUp"
              ? -across
              : 0;
    if (step !== 0) {
      event.preventDefault();
      moveRowFocus(index, step);
      return;
    }
    if (columns !== undefined && (event.key === "Home" || event.key === "End")) {
      event.preventDefault();
      const ordered = orderedRows();
      (event.key === "Home" ? ordered[0] : ordered[ordered.length - 1])?.focus();
      return;
    }
    const action = matchRowShortcut(event);
    if (action === "delete" && writable) {
      event.preventDefault();
      void deleteRef(row, row.title);
    } else if (action === "menu") {
      event.preventDefault();
      setMenu({ kind: "row", anchor: event.currentTarget, row });
    }
  };

  /** A right click anywhere on a row opens its menu at the pointer. */
  const onRowContextMenu = (row: Row, event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    const anchor = rows.current.get(noteKey(row));
    if (!anchor) return;
    anchor.focus();
    setMenu({ kind: "row", anchor, row, at: { x: event.clientX, y: event.clientY } });
  };

  /** Opens a menu at its button, or closes it when that one is open already. */
  const toggleMenu = (
    kind: Exclude<MenuKind, "row" | "rowColor" | "navColor">,
    event: React.MouseEvent<HTMLElement>,
  ) => {
    const anchor = event.currentTarget;
    setMenu((open) => (open?.kind === kind ? null : { kind, anchor }));
  };

  /** Opens a menu at `anchor` from the keyboard (the project tab's Down and Enter). */
  const openMenu = (
    kind: Exclude<MenuKind, "row" | "rowColor" | "navColor">,
    anchor: HTMLElement,
  ) => {
    setMenu({ kind, anchor });
  };

  /** A sidebar color's menu: at the pointer for a right click, else below its row. */
  const openColorMenu = (color: NoteColor, anchor: HTMLElement, at?: { x: number; y: number }) => {
    setMenu({ kind: "navColor", anchor, color, ...(at === undefined ? {} : { at }) });
  };

  const openRowColors = (row: Row, anchor: HTMLElement) => {
    setMenu({ kind: "rowColor", anchor, row });
  };

  /** A row's whole menu at its "…" button (a card of the paper look). */
  const openRowMenu = (row: Row, anchor: HTMLElement) => {
    setMenu({ kind: "row", anchor, row });
  };

  const menuOpen = (kind: MenuKind, row?: Row) =>
    menu?.kind === kind && (row === undefined || ("row" in menu && menu.row === row));

  /**
   * The focus after something that held it went away (a notice and its buttons): the editor of
   * the open note, else its row, else the search or "New note".
   */
  const restoreFocus = () => {
    const open = noteRef.current;
    if (open !== null && !open.onDesktop && editor.current && editorHost.current?.isConnected) {
      editor.current.focus();
      return;
    }
    focusRow(activeKey ?? rovingKey);
  };

  const closeMenu = (reason: "done" | "dismiss") => {
    const open = menu;
    setMenu(null);
    if (open === null) return;
    if (reason === "dismiss") {
      open.anchor.focus();
      return;
    }
    // After a choice the focus goes back to where the menu came from, unless the choice moved it
    // somewhere on purpose (the rename field, the trash).
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active !== null && active !== document.body) return;
      if (open.anchor.isConnected) open.anchor.focus();
      else restoreFocus();
    });
  };

  /** The eight colors as one row of 32 px targets, the chosen one with a ring and a check mark. */
  const swatchGroup = (chosen: NoteColor, onPick: (color: NoteColor) => void) => (
    <div className="menu-colors">
      <p className="menu-heading" aria-hidden="true">
        {t("notes.color")}
      </p>
      <div className="menu-swatches" role="group" aria-label={t("notes.color")}>
        {NOTE_COLORS.map((color) => {
          const name = colorName(color, colorNames, t);
          const on = color === chosen;
          return (
            <button
              key={color}
              type="button"
              role="menuitemradio"
              aria-checked={on}
              className={on ? "menu-swatch on" : "menu-swatch"}
              title={name}
              aria-label={name}
              onClick={() => {
                closeMenu("done");
                onPick(color);
              }}
            >
              <span className="swatch-dot" style={dotStyle(color)}>
                {on && <CheckIcon size={12} />}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );

  const rowToDesktop = (row: Row) => {
    if (isOpen(row) && !row.onDesktop) {
      void putOnDesktop();
      return;
    }
    // A tick on its card is written first; the sticky note then reads the note with it.
    void taskQueue.current
      .then(() => toDesktop(row.folder, row.id))
      .then(() => reloadRef.current())
      .catch(fail);
  };

  const renameRow = (row: Row) => {
    void (isOpen(row) ? Promise.resolve() : openNote(row, false)).then(() => {
      if (isOpen(row) && writableRef.current) setRenaming(true);
    });
  };

  /** What can be done with a note's file, the open one from its "…", any one from its row. */
  const fileItems = (ref: NoteRef): MenuItem[] => [
    {
      type: "action",
      key: "copy",
      label: t("notes.copyMarkdown"),
      run: () => {
        withSaved(ref, async (folder, id) => {
          await copyNote(folder, id);
          inform({ message: t("notes.copied") });
        });
      },
    },
    {
      type: "action",
      key: "export",
      label: t("notes.export"),
      run: () => {
        withSaved(ref, async (folder, id) => {
          const path = await exportNote(folder, id);
          if (path !== null) inform({ message: t("notes.exported", { path }) });
        });
      },
    },
    {
      type: "action",
      key: "reveal",
      label: t(revealKey()),
      run: () => {
        withSaved(ref, (folder, id) => revealNote(folder, id).then(() => undefined));
      },
    },
  ];

  const deleteItem = (run: () => void): MenuItem[] =>
    writable
      ? [
          { type: "separator", key: "sep-delete" },
          {
            type: "action",
            key: "delete",
            label: t("notes.delete"),
            shortcut: t("key.delete"),
            danger: true,
            run,
          },
        ]
      : [];

  const openColorItems = (): MenuItem[] =>
    note?.id == null
      ? []
      : [{ type: "custom", key: "colors", content: swatchGroup(note.color, pickOpenColor) }];

  const noteMenu = (withColors: boolean): MenuItem[] =>
    note?.id == null
      ? []
      : [
          ...(withColors
            ? [...openColorItems(), { type: "separator" as const, key: "sep-colors" }]
            : []),
          ...(writable && !note.onDesktop
            ? [
                {
                  type: "action" as const,
                  key: "rename",
                  label: t("notes.rename"),
                  shortcut: "F2",
                  run: () => {
                    setRenaming(true);
                  },
                },
              ]
            : []),
          ...fileItems({ folder: note.folder, id: note.id }),
          ...deleteItem(deleteCurrent),
        ];

  const rowMenu = (row: Row): MenuItem[] => [
    {
      type: "custom",
      key: "colors",
      content: swatchGroup(row.color, (color) => {
        pickColor(row, color);
      }),
    },
    { type: "separator", key: "sep-colors" },
    {
      type: "action",
      key: "desktop",
      label: t(row.onDesktop ? "notes.bringToFront" : "notes.toDesktop"),
      icon: <DesktopIcon size={14} />,
      run: () => {
        rowToDesktop(row);
      },
    },
    ...(writable && !row.onDesktop
      ? [
          {
            type: "action" as const,
            key: "rename",
            label: t("notes.rename"),
            shortcut: "F2",
            run: () => {
              renameRow(row);
            },
          },
        ]
      : []),
    ...fileItems(row),
    ...deleteItem(() => {
      void deleteRef(row, row.title);
    }),
  ];

  const onTop = onTopSet ?? settings?.hubOnTop ?? false;
  const toggleOnTop = () => {
    const next = !onTop;
    setOnTopSet(next);
    setHubOnTop(next)
      .then(setOnTopSet)
      .catch((e: unknown) => {
        setOnTopSet(!next);
        fail(e);
      });
  };

  /**
   * The trash and the settings replace the notes; an unsaved note keeps the window where it is.
   * `from` names the control the focus returns to on the way back.
   */
  const leaveFor = (next: Exclude<View, "browse">, from: ReturnFocus) => {
    returnFocus.current = from;
    void leaveByPerson().then((left) => {
      if (!left) return;
      // Paper opens a note only by choice: on the way back it shows the cards.
      if (opensOnlyByChoice(lookRef.current) && noteRef.current !== null) {
        generation.current += 1;
        show(null, "", false);
        setPane("list");
      }
      setView(next);
    });
  };

  /**
   * Where the layouts put the search field and the editor's element: a part announces its
   * element when it appears and takes it back when it goes (`EditorHost`, `SearchField`).
   */
  const attachSearch = useCallback((element: HTMLInputElement | null, gone?: HTMLElement) => {
    if (element !== null || searchInput.current === gone) searchInput.current = element;
  }, []);
  const attachEditorHost = useCallback((element: HTMLDivElement | null, gone?: HTMLElement) => {
    if (element !== null || editorHost.current === gone) editorHost.current = element;
  }, []);
  const focusSearch = () => {
    searchInput.current?.focus();
  };
  const focusEditor = () => {
    editor.current?.focus();
  };

  /** The list and the scopes' counts again, from disk ("Try again" after a failed load). */
  const reloadAll = () => {
    reloadFolders();
    void reloadRef.current();
  };

  /** Back from the trash or the settings: the focus goes where they were opened from. */
  const backToNotes = () => {
    setView("browse");
    void reloadRef.current();
    requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(
        `[data-focus-id="${returnFocus.current}"]`,
      );
      target?.focus();
      // Hidden (a narrow window showing the note) or behind the paper look's sheet: the focus
      // goes to the open note or its row instead.
      if (target === null || document.activeElement !== target) restoreFocus();
    });
  };

  /**
   * An area of the sidebar: its notes in the list, from the trash or the settings too. A search
   * ends (it spans all notes, the area would not show), and a narrow window shows the list.
   */
  const goTo = (next: NotesScope) => {
    // Paper opens a note only by choice: another area shows its cards, the open note is saved and
    // closed first, and stays open if it cannot be saved.
    if (opensOnlyByChoice(lookRef.current) && noteRef.current !== null) {
      void closeForList(true).then((closed) => {
        if (closed && noteRef.current === null) goToRef.current(next);
      });
      return;
    }
    setScope(next);
    setQuery("");
    setPane("list");
    if (view !== "browse") {
      setView("browse");
      void reloadRef.current();
    }
  };
  /** A level tab: its notes in the list. */
  const chooseLevel = (next: Level) => {
    goTo(scopeOfLevel(next));
  };
  /** A project from the project menu or the sidebar: the "Project" level shows it from now on. */
  const chooseProject = (path: string) => {
    setChosen(path);
    rememberProject(path);
    goTo({ kind: "project" });
  };
  /** A sidebar entry: "All notes", or a project in the "Project" level. */
  const goToEntry = (entry: ScopeEntry) => {
    if (entry.path === null) goTo(entry.scope);
    else chooseProject(entry.path);
  };
  const goToRef = useRef(goTo);
  useEffect(() => {
    goToRef.current = goTo;
  });

  // Ctrl+1 to Ctrl+3 (Cmd on macOS): the levels in the order of their tabs, from anywhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const position = matchLevelShortcut(event, PLATFORM);
      const next = position === null ? undefined : LEVELS[position - 1];
      if (next === undefined) return;
      event.preventDefault();
      goToRef.current(scopeOfLevel(next));
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  /** The trash or the settings, from the sidebar; the focus comes back to that entry. */
  const openPlace = (next: Exclude<View, "browse">) => {
    if (view !== next) leaveFor(next, next);
  };
  const place: Place = view === "browse" ? null : view;

  /** "Open notes folder" from the app menu: the folder new notes go to. */
  const revealFolder = () => {
    void revealNotesFolder(newFolder ?? GENERAL_FOLDER).catch(fail);
  };
  const toggleColor = (color: NoteColor) => {
    setColors((old) => {
      const next = new Set(old);
      if (next.has(color)) next.delete(color);
      else next.add(color);
      return next;
    });
  };
  const clearColors = () => {
    setColors(new Set());
  };

  /**
   * Saves a color's own name, as the settings page does; a blank name gives the color its own name
   * in the UI language back. Every window follows (`settings-changed`).
   */
  const renameColor = (color: NoteColor, name: string) => {
    if (!settings) return;
    const names = withColorName(colorNames, color, name);
    if (names[color] === colorNames[color]) return;
    setSettings(settingsWith(settings, app.look, { colorNames: names }))
      .then(app.applySaved)
      .catch(fail);
  };

  const colorMenu = (color: NoteColor): MenuItem[] => [
    {
      type: "action",
      key: "rename",
      label: t("notes.rename"),
      shortcut: "F2",
      run: () => {
        setRenamingColor(color);
      },
    },
    ...(colorNames[color] === undefined
      ? []
      : [
          {
            type: "action" as const,
            key: "resetName",
            label: t("nav.colorResetName"),
            run: () => {
              renameColor(color, "");
            },
          },
        ]),
  ];

  /** The look of every window, from the app menu (the settings page has the same choice). */
  const chooseLook = (look: Look) => {
    if (!settings || look === app.look) return;
    setSettings(settingsWith(settings, look, {}))
      .then(app.applySaved)
      .catch(fail);
  };

  /** Light or dark for every window, from the sidebar's switch: the opposite of the shown theme. */
  const toggleTheme = () => {
    if (!settings) return;
    setSettings(settingsWith(settings, app.look, { theme: toggledTheme(theme) }))
      .then(app.applySaved)
      .catch(fail);
  };

  /** Undo, redo or select all in the open note, from the app menu. */
  const canEdit = writable && note !== null && !note.onDesktop && view === "browse";
  const editNote = (command: EditCommand) => {
    if (canEdit) editor.current?.edit(command);
  };

  /** "Export …" of the open note, from the app menu; `null` while no saved note is open. */
  const exportOpen =
    note?.id == null || note.onDesktop
      ? null
      : () => {
          const item = fileItems({ folder: note.folder, id: note.id ?? "" }).find(
            (each) => each.type === "action" && each.key === "export",
          );
          if (item?.type === "action") item.run();
        };

  const menuItems = (open: MenuState): MenuItem[] => {
    switch (open.kind) {
      case "project":
        return scopeEntries
          .filter((entry) => entry.path !== null)
          .map((entry) => ({
            type: "action" as const,
            key: entry.key,
            label: entry.label,
            title: entry.title,
            count: entry.count,
            radio: true,
            checked: entry.path !== null && isProject({ path: entry.path }, project),
            run: () => {
              if (entry.path !== null) chooseProject(entry.path);
            },
          }));
      case "note":
        return noteMenu(true);
      case "noteActions":
        return noteMenu(false);
      case "noteColor":
        return openColorItems();
      case "rowColor":
        return [
          {
            type: "custom",
            key: "colors",
            content: swatchGroup(open.row.color, (color) => {
              pickColor(open.row, color);
            }),
          },
        ];
      case "row":
        return rowMenu(open.row);
      case "navColor":
        return colorMenu(open.color);
    }
  };

  const menuLabel = (open: MenuState): string => {
    switch (open.kind) {
      case "note":
      case "noteActions":
        return t("notes.more");
      case "project":
        return t("level.switchProject");
      case "noteColor":
      case "rowColor":
        return t("notes.color");
      case "row":
        return t("notes.actionsFor", { title: open.row.title });
      case "navColor":
        return colorName(open.color, colorNames, t);
    }
  };

  const popup: ReactNode =
    menu !== null ? (
      <PopupMenu
        // Built while the menu renders, so the items always show the current state.
        items={() => menuItems(menu)}
        label={menuLabel(menu)}
        anchor={menu.anchor}
        align={
          menu.kind === "row" || menu.kind === "project" || menu.kind === "navColor"
            ? "start"
            : "end"
        }
        at={menu.kind === "row" || menu.kind === "navColor" ? menu.at : undefined}
        onClose={closeMenu}
      />
    ) : null;

  /**
   * Why the notes are read only, as one sentence for the small "Read only" chip, `null` while
   * they can be written. A reason this version does not know reads as another writer.
   */
  const readOnlyReason: MessageKey | null =
    status?.access.state !== "readOnly"
      ? null
      : status.access.reason === "lockFailed"
        ? "notes.lockFailed"
        : "notes.otherWriter";

  const slotNotice = shownNotice(notices);
  const noticeSlot: ReactNode = (
    <NoticeSlot
      shown={slotNotice}
      onDismiss={(kind, notice) => {
        setNotices((slots) => clearNotice(slots, kind, notice));
      }}
      onFocusLost={restoreFocus}
    />
  );

  /** The open note while it is edited here (not on the desktop): its save state and preview. */
  const openText = note !== null && !note.onDesktop ? note : null;

  return {
    t,
    theme,
    language,
    colorNames,
    now,
    writable,
    view,
    pane,
    list,
    listFailed,
    emptyMode,
    readOnlyReason,
    popup,
    noticeSlot,
    // Levels, scopes and colors
    level,
    levelTabs,
    chooseLevel,
    project,
    projectName,
    projectEntries: scopeEntries.filter((entry) => entry.group === "project"),
    chooseProject,
    team,
    canCreate,
    scopeEntries,
    shownScope,
    shownScopeLabel,
    isShownScope,
    goTo,
    goToEntry,
    place,
    openPlace,
    mixed,
    listFolders,
    showProject,
    projectLabel,
    colors,
    counts,
    toggleColor,
    clearColors,
    renamingColor,
    setRenamingColor,
    renameColor,
    openColorMenu,
    // The look and the app menu
    look,
    chooseLook,
    toggleTheme,
    canEdit,
    editNote,
    exportOpen,
    revealFolder,
    onTop,
    toggleOnTop,
    // Search and rows
    query,
    setQuery,
    searching,
    shownHits,
    attachSearch,
    focusSearch,
    allRows,
    visible,
    activeKey,
    rovingKey,
    setFocusKey,
    registerRow,
    moveRowFocus,
    reloadAll,
    onRowKeyDown,
    onRowContextMenu,
    openRowColors,
    openRowMenu,
    rowToDesktop,
    deleteRef,
    toggleRowTask,
    // The open note
    note,
    stats,
    shownTitle,
    titleShown,
    renaming,
    setRenaming,
    commitRename,
    preview,
    previewHtml,
    onPreviewClick,
    togglePreview,
    attachEditorHost,
    focusEditor,
    cursor,
    held,
    copyOpenText,
    unsaved,
    dirty,
    openText,
    progressText,
    quickKeys,
    // Actions
    openNote,
    newNote,
    backToList,
    putOnDesktop,
    bringToFront,
    backFromDesktop,
    pickOpenColor,
    restore,
    // Menus and views
    menu,
    menuOpen,
    toggleMenu,
    openMenu,
    leaveFor,
    backToNotes,
  };
}

export type NotesModel = ReturnType<typeof useNotesArea>;
