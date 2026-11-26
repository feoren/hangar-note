// The notes area (ADR 0002, phase 1): Hangar's notes panel as its own window, in the calm look of
// direction A. A title menu ("All notes") holds the scopes with their counts and the rest of the
// list menu; below it a search, a color filter behind one button and the list, where each row
// shows its color as a thin edge and its tools (color, desktop, delete) on hover, on keyboard
// focus and in a context menu. The open note reads like a page with its title large. One notice
// place sits in the footer (notices.ts). Wide windows show list and note side by side, narrow ones
// one at a time, as Hangar's panel does. The flow (quick note that exists only once you type, automatic title, saving 500 ms
// after the last keystroke and on leaving a note, trash with undo) follows Hangar's
// src/NotesPanel.tsx (MIT, same owner).
//
// One editor per note: a note on the desktop is edited in its sticky note; here it shows
// "On the desktop" with "Bring to front" and "Back to the list".

import { useCallback, useEffect, useRef, useState } from "react";

import {
  copyNote,
  createNote,
  deleteNote,
  exportNote,
  fromDesktop,
  getStatus,
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
  setNoteColor,
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
import type { AppSettings } from "./appSettings";
import { copyText } from "./clipboard";
import { createLeaveAnyway } from "./leaveAnyway";
import {
  colorName,
  NOTE_COLORS,
  noteTone,
  swatchColor,
  type NoteColor,
  type Theme,
} from "./colors";
import { createNoteEditor, type NoteEditor } from "./editor";
import { errorActionLabel, errorMessage, type ErrorAction, type ErrorMessage } from "./errors";
import { captureStamp, relativeTime } from "./format";
import { DICTIONARIES, LANGUAGES, useT, type MessageKey } from "./i18n";
import {
  BackIcon,
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  DesktopIcon,
  EyeIcon,
  FolderIcon,
  GearIcon,
  MoreIcon,
  PaletteIcon,
  PlusIcon,
  SearchIcon,
  TaskIcon,
  TrashIcon,
} from "./icons";
import {
  byLastChange,
  cleanTitle,
  colorCounts,
  filterByColors,
  folderName,
  nextAutoTitle,
  noteKey,
  sameFolder,
  sameNote,
  type NoteRef,
} from "./notes";
import {
  DEFAULT_SCOPE,
  effectiveScope,
  mixesScopes,
  newNoteFolder,
  sameScope,
  scopeFolders,
  scopeForFolder,
  type NotesScope,
} from "./notesScope";
import { clearNotice, noNotices, putNotice, shownNotice, type NoticeSlots } from "./notices";
import { NoticeSlot, type Notice } from "./NoticeSlot";
import { NotesSettings } from "./NotesSettings";
import {
  appendCapture,
  checklistProgress,
  noteExcerpt,
  toggleTaskAtLine,
  wordCount,
  type ChecklistProgress,
} from "./noteText";
import { PopupMenu, type MenuItem } from "./PopupMenu";
import {
  currentPlatform,
  hubShortcutLabel,
  matchHubShortcut,
  matchNoteShortcut,
  matchRowShortcut,
} from "./shortcuts";
import { Trash } from "./Trash";

const SAVE_DELAY_MS = 500;
/** Word count, progress and preview follow the text after a short pause. */
const STATS_DELAY_MS = 250;
const SEARCH_DELAY_MS = 200;
const HUB_LABEL = "hub";
const PLATFORM = currentPlatform();

/** "Note" in every language: a title created in another language also counts as new. */
const UNTITLED_BASES = LANGUAGES.map((language) => DICTIONARIES[language]["notes.untitled"]);

// Remembered while the app runs, so closing and reopening the window finds things as they were.
let lastScope: NotesScope = DEFAULT_SCOPE;
let lastColors: ReadonlySet<NoteColor> = new Set();
/** Notes shown as preview. */
const previewNotes = new Set<string>();

/** The note in the editor. `id === null`: a new quick note that exists only once you type. */
interface Current {
  folder: NoteFolder;
  id: string | null;
  title: string;
  autoTitled: boolean;
  onDesktop: boolean;
  color: NoteColor;
}

interface Stats {
  words: number;
  progress: ChecklistProgress;
  /** Title the note gets on leaving (automatic title), `null` if it keeps its own. */
  autoTitle: string | null;
}

interface Row extends NoteRef {
  title: string;
  updatedAt: number | null;
  color: NoteColor;
  onDesktop: boolean;
  excerpt: string;
  progress: ChecklistProgress | null;
}

type View = "browse" | "trash" | "settings";

/**
 * The open menu: the title menu, the color filter, the open note's "…", a row's color tool, or a
 * row's context menu (right click, the menu key or Shift+F10).
 */
type MenuState =
  | { kind: "area" | "filter" | "note"; anchor: HTMLElement }
  | { kind: "row" | "rowColor"; anchor: HTMLElement; row: Row; at?: { x: number; y: number } };

/** Dots the color filter's button shows for the chosen colors; more would not fit its width. */
const PICKED_DOTS = 3;

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

export function NotesArea({ app }: { app: AppSettings }) {
  const t = useT();
  const { theme, language, settings } = app;
  const colorNames = settings?.colorNames ?? {};
  const [status, setStatus] = useState<Status | null>(null);
  const [folders, setFolders] = useState<FolderInfo[]>([]);
  const [scope, setScopeState] = useState<NotesScope>(lastScope);
  const [colors, setColorsState] = useState<ReadonlySet<NoteColor>>(lastColors);
  const [view, setView] = useState<View>("browse");
  const [pane, setPane] = useState<"list" | "note">("list");
  const [list, setList] = useState<Row[] | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ query: string; rows: Row[] } | null>(null);
  const [note, setNote] = useState<Current | null>(null);
  const [stats, setStats] = useState<Stats>({
    words: 0,
    progress: { done: 0, total: 0 },
    autoTitle: null,
  });
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewTick, setPreviewTick] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  /**
   * The one notice place in the footer (notices.ts). "Not saved" there means leaving was refused
   * because the open note is not saved: it warns and offers to copy the text.
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

  const noteRef = useRef<Current | null>(null);
  const textRef = useRef("");
  const pending = useRef<{ folder: NoteFolder; id: string; text: string } | null>(null);
  const saveTimer = useRef<number | null>(null);
  const statsTimer = useRef<number | null>(null);
  const creating = useRef<Promise<boolean> | null>(null);
  const generation = useRef(0);
  const editorHost = useRef<HTMLDivElement>(null);
  const editor = useRef<NoteEditor | null>(null);
  /** The element the editor lives in, to notice when React replaced it. */
  const editorOn = useRef<HTMLElement | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const shown = useRef(false);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const leaveAnyway = useRef(createLeaveAnyway());
  /** What the one button of an error does; filled once the actions below exist. */
  const errorActions = useRef<Record<ErrorAction, () => void>>({
    openFolder: () => undefined,
    reload: () => undefined,
    retry: () => undefined,
  });

  const writable = status?.access.state === "writable";
  const writableRef = useRef(writable);
  useEffect(() => {
    writableRef.current = writable;
  });
  const project: NoteFolder | null = status?.project != null ? { path: status.project } : null;
  const projectId = project?.path ?? null;
  const shownScope = effectiveScope(scope, project);
  const listFolders = scopeFolders(scope, project, folders);
  const listKey = listFolders.map((folder) => folder.path ?? "").join("|");
  const newFolder = newNoteFolder(scope, project);
  const mixed = mixesScopes(scope, project);
  const general = t("notes.general");
  const preview =
    note?.id != null && !note.onDesktop && previewNotes.has(noteKey({ ...note, id: note.id }));

  const setScope = setScopeState;
  const setColors = setColorsState;
  useEffect(() => {
    lastScope = scope;
    lastColors = colors;
  }, [scope, colors]);
  const foldersRef = useRef(listFolders);
  useEffect(() => {
    foldersRef.current = listFolders;
  });

  /** A calm info in the footer, e.g. "Deleted" with "Undo"; it goes after a few seconds. */
  const inform = useCallback((notice: Notice) => {
    setNotices((slots) => putNotice(slots, "info", notice));
  }, []);

  /** An error in the footer; it stays until it is fixed or dismissed. */
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

  /** An error from the backend as a plain sentence; "read only" has its own calm line already. */
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

  const loadStatus = useCallback(() => {
    void getStatus()
      .then(setStatus)
      .catch(() => null);
  }, []);

  const computeStats = useCallback(
    (content: string, open: Current | null) => {
      setStats({
        words: wordCount(content, language),
        progress: checklistProgress(content),
        autoTitle:
          open === null
            ? null
            : open.id === null
              ? nextAutoTitle({ title: "", autoTitled: true }, content, UNTITLED_BASES)
              : nextAutoTitle(open, content, UNTITLED_BASES),
      });
    },
    [language],
  );

  // ---- Saving ----------------------------------------------------------------------------------

  const hasPending = () => pending.current !== null;

  const flush = useCallback(async (): Promise<boolean> => {
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const job = pending.current;
    if (!job) return true;
    pending.current = null;
    if (utf8Bytes(job.text) > MAX_NOTE_BYTES) {
      pending.current = job;
      setUnsaved(true);
      report({ message: t("notes.tooLarge"), source: "save" });
      return false;
    }
    try {
      await writeNote(job.folder, job.id, job.text);
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
      const message = errorMessage(e, "save");
      if (message === null) fail(e);
      else report(toNotice(message, "save"));
      return false;
    }
  }, [fail, report, toNotice, t]);

  /**
   * Creates the quick note in the backend as soon as it has content. `true` when the open draft
   * is a note now (or needs none yet).
   */
  const ensureCreated = useCallback(async (): Promise<boolean> => {
    if (creating.current) return creating.current;
    const draft = noteRef.current;
    if (!draft || draft.id !== null || textRef.current.trim() === "") return true;
    const work = (async () => {
      try {
        const made = await createNote(draft.folder, t("notes.untitled"));
        const created: Current = current(made);
        // The window may already show another note; then the new one is only saved.
        if (noteRef.current === draft) {
          noteRef.current = created;
          setNote(created);
          setHeld(false);
        }
        pending.current = { folder: created.folder, id: made.id, text: textRef.current };
        return await flush();
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
  }, [fail, flush, t]);

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
   * The editor, created on first use and kept for every note after that. The trash and the
   * settings replace the notes view and with it the editor's host element; back in the notes
   * view, the editor is made again in the new host.
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
      onChange: (text) => {
        onEditorChangeRef.current(text);
      },
      onFocus: (has) => {
        if (!has) void flush();
      },
    });
    return editor.current;
  }, [flush, t]);

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
      setNote(open);
      setRenaming(false);
      setHeld(false);
      setUnsaved(false);
      setDirty(false);
      setPreviewHtml(null);
      computeStats(content, open);
      if (open !== null && !open.onDesktop) {
        const view = ensureEditor();
        view?.load(content);
        view?.setReadOnly(!writableRef.current);
        if (focus) requestAnimationFrame(() => view?.focus());
      }
    },
    [computeStats, ensureEditor],
  );

  useEffect(() => {
    editor.current?.setReadOnly(!writable);
  }, [writable]);

  // Back from the trash or the settings with a note still open: it gets its editor again.
  useEffect(() => {
    if (view !== "browse") return;
    const open = noteRef.current;
    if (open === null || open.onDesktop) return;
    if (editor.current && editorOn.current === editorHost.current) return;
    const fresh = ensureEditor();
    fresh?.load(textRef.current);
    fresh?.setReadOnly(!writableRef.current);
  }, [view, ensureEditor]);

  // ---- Loading ---------------------------------------------------------------------------------

  const reloadFolders = useCallback(() => {
    void listNoteFolders()
      .then(setFolders)
      .catch(() => null);
  }, []);

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
          if (noteRef.current === open) show(current(fresh), fresh.text, false);
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
  }, [listKey, fail, show]);

  const reloadRef = useRef(reloadList);
  useEffect(() => {
    reloadRef.current = reloadList;
  });

  useEffect(() => {
    void Promise.resolve().then(reloadList);
  }, [reloadList]);

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
      if (mine !== generation.current) return;
      try {
        const opened = await readNote(ref.folder, ref.id);
        if (mine !== generation.current) return;
        show(current(opened), opened.text, focus);
        setPane("note");
        setView("browse");
      } catch (e) {
        if (mine === generation.current) fail(e);
      }
    },
    [fail, flush, leave, leaveByPerson, show],
  );

  /**
   * A new quick note in `folder`; it is created once it has content. "stayed": the open note
   * could not be saved, so nothing changed. "held": the content could not become a note and waits
   * in the draft to be copied.
   */
  const startDraft = useCallback(
    async (
      folder: NoteFolder,
      focus: boolean,
      content = "",
      byPerson = false,
    ): Promise<"created" | "draft" | "held" | "stayed"> => {
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
        content,
        focus,
      );
      if (content === "") return "draft";
      if (!writableRef.current) {
        setHeld(true);
        return "held";
      }
      const made = await ensureCreated();
      void reloadRef.current();
      return made ? "created" : "held";
    },
    [ensureCreated, leave, leaveByPerson, settings?.newNoteColor, show],
  );

  const backToList = useCallback(async () => {
    const open = noteRef.current;
    generation.current += 1;
    // Not saved: the note stays open and says so, instead of losing the text.
    if (!(await leaveByPerson())) return;
    show(null, "", false);
    setPane("list");
    await reloadRef.current();
    requestAnimationFrame(() => {
      const row = open?.id != null ? rows.current.get(noteKey({ ...open, id: open.id })) : null;
      if (row) row.focus();
      else searchInput.current?.focus();
    });
  }, [leaveByPerson, show]);

  const newNote = () => {
    if (!writable) return;
    setQuery("");
    void startDraft(newFolder, true, "", true);
  };

  /**
   * A capture while the open note cannot be left (its text is not saved): the capture becomes a
   * note of its own in the background, so neither text is lost.
   */
  const keepCapture = useCallback(
    async (folder: NoteFolder, content: string) => {
      if (!writableRef.current) {
        report({ message: t("notes.heldHint") });
        return;
      }
      try {
        const made = await createNote(folder, t("notes.untitled"));
        await writeNote(folder, made.id, content);
        const title = nextAutoTitle(current(made), content, UNTITLED_BASES);
        if (title !== null) await renameNote(folder, made.id, title, false);
        void reloadRef.current();
        inform({ message: t("notes.capturedNew") });
      } catch (e) {
        fail(e);
      }
    },
    [fail, inform, report, t],
  );

  // Requests from the command line and from Hangar: quick note, capture, open a note.
  const handleRequests = useCallback(
    async (requests: HubRequest[]) => {
      for (const request of requests) {
        switch (request.kind) {
          case "showProject":
            setScope(DEFAULT_SCOPE);
            setQuery("");
            break;
          case "openNote": {
            const folder = { path: request.folder };
            setScope(scopeForFolder(folder, project));
            setQuery("");
            await openNote({ folder, id: request.id }, true, false);
            break;
          }
          case "quick":
            setScope(DEFAULT_SCOPE);
            setQuery("");
            // Read only: no draft that could never be saved; the banner says why.
            if (writableRef.current) await startDraft(newNoteFolder(DEFAULT_SCOPE, project), true);
            break;
          case "capture": {
            const folder = { path: request.folder };
            const content = appendCapture(
              "",
              request.text,
              captureStamp(new Date(), language),
              folderName(request.folder),
              (time, source) => t("notes.capturedFrom", { source, time }),
            );
            const result = await startDraft(folder, false, content);
            if (result === "created") inform({ message: t("notes.capturedNew") });
            else if (result === "stayed") await keepCapture(folder, content);
            break;
          }
          case "sharedUnavailable":
            inform({ message: t("notes.sharedUnavailable") });
            break;
        }
      }
    },
    // `project` is rebuilt every render; its path says when it changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, language, keepCapture, openNote, inform, startDraft, t],
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
          return takeHubRequests();
        })
        .then((requests) => requestsRef.current(requests))
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
      const nextKey = index < 0 ? undefined : (keys[index + 1] ?? keys[index - 1]);
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
              if (restored !== undefined) void openNote({ folder: ref.folder, id: restored }, true);
            });
          },
        },
      };
      inform(notice);
      requestAnimationFrame(() => {
        const next = nextKey === undefined ? undefined : rows.current.get(nextKey);
        if (next) next.focus();
        else searchInput.current?.focus();
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

  /** An action on a note's file; the open note is saved first, so the file has every word. */
  const withSaved = (ref: NoteRef, action: (folder: NoteFolder, id: string) => Promise<void>) => {
    void (isOpen(ref) ? flush() : Promise.resolve(true))
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

  // Shortcuts: Ctrl+Shift+N quick note, F2 rename, and the formatting keys inside the editor.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const hub = matchHubShortcut(event, PLATFORM);
      if (hub === "quickNote") {
        event.preventDefault();
        if (writableRef.current) {
          setQuery("");
          void startDraft(newFolder, true, "", true);
        }
        return;
      }
      if (hub === "rename") {
        const open = noteRef.current;
        if (view === "browse" && open?.id != null && writableRef.current) {
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

  // ---- What the list shows ---------------------------------------------------------------------

  // The one helpful button of an error (errors.ts) does what its label says.
  useEffect(() => {
    errorActions.current = {
      openFolder: () => {
        void revealNotesFolder(noteRef.current?.folder ?? newFolder).catch(fail);
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

  const searching = query.trim() !== "";
  const shownHits = searching && hits?.query === query.trim() ? hits.rows : null;
  const allRows = shownHits ?? (searching ? [] : (list ?? []));
  const visible = filterByColors(allRows, colors);
  const counts = colorCounts(allRows);
  const scopeName =
    shownScope.kind === "project" && project?.path != null
      ? folderName(project.path)
      : shownScope.kind === "folder" && shownScope.folder.path !== null
        ? folderName(shownScope.folder.path)
        : null;
  /**
   * Nothing to find yet: the window shows one invitation to write and nothing else (no search, no
   * filter, no second "New note").
   */
  const emptyMode =
    view === "browse" &&
    !searching &&
    colors.size === 0 &&
    !listFailed &&
    list !== null &&
    list.length === 0 &&
    note === null;

  /** How many notes a scope holds, once the folders are known. */
  const knownCount = (folder: NoteFolder): number | undefined =>
    folders.length === 0
      ? undefined
      : (folders.find((info) => sameFolder({ path: info.path }, folder))?.noteCount ?? 0);
  const allCount =
    folders.length === 0 ? undefined : folders.reduce((sum, info) => sum + info.noteCount, 0);

  const scopeEntries: {
    key: string;
    scope: NotesScope;
    label: string;
    title: string;
    count: number | undefined;
  }[] = [
    {
      key: "all",
      scope: { kind: "all" },
      label: t("note.allNotes"),
      title: t("notes.scopeAllTip"),
      count: allCount,
    },
    ...(project?.path != null
      ? [
          {
            key: "project",
            scope: { kind: "project" } as const,
            label: folderName(project.path),
            title: t("notes.scopeProjectTip", {
              folder: folderName(project.path),
              path: project.path,
            }),
            count: knownCount(project),
          },
        ]
      : []),
    {
      key: "general",
      scope: { kind: "general" },
      label: general,
      title: t("notes.scopeGeneralTip"),
      count: knownCount({ path: null }),
    },
    ...folders
      .flatMap((info) =>
        info.path === null ||
        info.noteCount === 0 ||
        (project !== null && sameFolder({ path: info.path }, project))
          ? []
          : [{ path: info.path, count: info.noteCount }],
      )
      .concat(
        // A scope opened from a search hit that the folders do not list (yet).
        shownScope.kind === "folder" &&
          shownScope.folder.path !== null &&
          !folders.some((info) => sameFolder({ path: info.path }, shownScope.folder))
          ? [{ path: shownScope.folder.path, count: 0 }]
          : [],
      )
      .sort((a, b) => folderName(a.path).localeCompare(folderName(b.path), language))
      .map((entry) => ({
        key: `folder:${entry.path}`,
        scope: { kind: "folder", folder: { path: entry.path } } as const,
        label: folderName(entry.path),
        title: entry.path,
        count: entry.count,
      })),
  ];
  const shownScopeLabel =
    scopeEntries.find((entry) => sameScope(entry.scope, shownScope))?.label ?? t("note.allNotes");

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

  const moveRowFocus = (index: number, step: 1 | -1) => {
    const ordered = [...rows.current.values()]
      .filter((row) => row.isConnected)
      .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    const next = ordered[index + step];
    if (next) next.focus();
    else if (index + step < 0) searchInput.current?.focus();
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
      if (active === null || active === document.body) open.anchor.focus();
    });
  };

  /** The eight colors as one row of 32 px targets, the chosen one with a ring and a check mark. */
  const swatchGroup = (current: NoteColor, onPick: (color: NoteColor) => void) => (
    <div className="menu-colors">
      <p className="menu-heading" aria-hidden="true">
        {t("notes.color")}
      </p>
      <div className="menu-swatches" role="group" aria-label={t("notes.color")}>
        {NOTE_COLORS.map((color) => {
          const name = colorName(color, colorNames, t);
          const on = color === current;
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
    void toDesktop(row.folder, row.id)
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
          { type: "action", key: "delete", label: t("notes.delete"), danger: true, run },
        ]
      : [];

  const noteMenu = (): MenuItem[] =>
    note?.id == null
      ? []
      : [
          {
            type: "custom",
            key: "colors",
            content: swatchGroup(note.color, (color) => {
              if (note.id !== null) pickColor({ folder: note.folder, id: note.id }, color);
            }),
          },
          { type: "separator", key: "sep-colors" },
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

  /** Trash and settings replace the list; an unsaved note keeps the window where it is. */
  const leaveFor = (next: View) => {
    void leaveByPerson().then((left) => {
      if (left) setView(next);
    });
  };

  const areaMenu = (): MenuItem[] => [
    ...scopeEntries.map((entry): MenuItem => ({
      type: "action",
      key: entry.key,
      label: entry.label,
      title: entry.title,
      count: entry.count,
      checked: sameScope(entry.scope, shownScope),
      radio: true,
      run: () => {
        setScope(entry.scope);
      },
    })),
    { type: "separator", key: "sep" },
    {
      type: "action",
      key: "trash",
      label: t("notes.trash"),
      icon: <TrashIcon size={14} />,
      run: () => {
        leaveFor("trash");
      },
    },
    {
      type: "action",
      key: "folder",
      label: t("notes.openFolder"),
      icon: <FolderIcon size={14} />,
      run: () => {
        void revealNotesFolder(newFolder).catch(fail);
      },
    },
    {
      type: "action",
      key: "onTop",
      label: t("note.keepOnTop"),
      checked: onTop,
      run: toggleOnTop,
    },
    {
      type: "action",
      key: "settings",
      label: t("notes.settings"),
      icon: <GearIcon size={14} />,
      run: () => {
        leaveFor("settings");
      },
    },
  ];

  const pickedColors = NOTE_COLORS.filter((color) => colors.has(color));
  const filterLabel =
    pickedColors.length === 0
      ? t("notes.colorFilter")
      : t("notes.colorFilterActive", {
          colors: pickedColors.map((color) => colorName(color, colorNames, t)).join(", "),
        });

  const filterMenu = (): MenuItem[] => [
    ...NOTE_COLORS.map((color): MenuItem => {
      const name = colorName(color, colorNames, t);
      return {
        type: "action",
        key: color,
        label: name,
        title: name,
        count: counts.get(color) ?? 0,
        checked: colors.has(color),
        keepOpen: true,
        leading: <span className="color-dot" aria-hidden="true" style={dotStyle(color)} />,
        run: () => {
          setColors((old) => {
            const next = new Set(old);
            if (next.has(color)) next.delete(color);
            else next.add(color);
            return next;
          });
        },
      };
    }),
    { type: "separator", key: "sep" },
    {
      // Always in the same place; it only waits until a color is chosen.
      type: "action",
      key: "clear",
      label: t("notes.colorFilterClear"),
      disabled: colors.size === 0,
      run: () => {
        setColors(new Set());
      },
    },
  ];

  const banner =
    status?.access.state === "readOnly" ? (
      <div className="notes-banner" role="status">
        {status.access.reason === "notHandedOver" ? (
          <>
            <p className="notes-banner-title">{t("notes.readOnlyTitle")}</p>
            <p>{t("notes.readOnly")}</p>
          </>
        ) : (
          <p>{t("notes.otherWriter")}</p>
        )}
      </div>
    ) : null;

  const slotNotice = shownNotice(notices);
  const noticeSlot = (
    <NoticeSlot
      shown={slotNotice}
      onDismiss={(kind, notice) => {
        setNotices((slots) => clearNotice(slots, kind, notice));
      }}
    />
  );

  const menuView = (open: MenuState): { items: MenuItem[]; label: string } => {
    switch (open.kind) {
      case "area":
        return { items: areaMenu(), label: t("notes.areaMenu") };
      case "filter":
        return { items: filterMenu(), label: t("notes.colorFilter") };
      case "note":
        return { items: noteMenu(), label: t("notes.more") };
      case "rowColor":
        return {
          items: [
            {
              type: "custom",
              key: "colors",
              content: swatchGroup(open.row.color, (color) => {
                pickColor(open.row, color);
              }),
            },
          ],
          label: t("notes.color"),
        };
      case "row":
        return {
          items: rowMenu(open.row),
          label: t("notes.actionsFor", { title: open.row.title }),
        };
    }
  };

  const menuLabel = (open: MenuState): string => {
    switch (open.kind) {
      case "area":
        return t("notes.areaMenu");
      case "filter":
        return t("notes.colorFilter");
      case "note":
        return t("notes.more");
      case "rowColor":
        return t("notes.color");
      case "row":
        return t("notes.actionsFor", { title: open.row.title });
    }
  };

  const popup =
    menu !== null ? (
      <PopupMenu
        // Built while the menu renders, so the items always show the current state.
        items={() => menuView(menu).items}
        label={menuLabel(menu)}
        anchor={menu.anchor}
        align={menu.kind === "area" || menu.kind === "row" ? "start" : "end"}
        at={menu.kind === "row" ? menu.at : undefined}
        onClose={closeMenu}
      />
    ) : null;

  // ---- Views -----------------------------------------------------------------------------------

  if (view === "settings") {
    return (
      <div className="notes-area single">
        <div className="single-main">
          <NotesSettings
            app={app}
            onBack={() => {
              setView("browse");
            }}
          />
        </div>
        <footer className="area-foot">{noticeSlot}</footer>
      </div>
    );
  }

  if (view === "trash") {
    return (
      <div className="notes-area single">
        <div className="single-main">
          <Trash
            folders={listFolders}
            mixed={mixed}
            language={language}
            now={now}
            theme={theme}
            writable={writable}
            projectLabel={projectLabel}
            onRestore={restore}
            onBack={() => {
              setView("browse");
              void reloadRef.current();
            }}
          />
        </div>
        <footer className="area-foot">{noticeSlot}</footer>
      </div>
    );
  }

  const [hintBefore = "", hintAfter = ""] = t("notes.emptyHint").split("{keys}");
  const keyParts = PLATFORM === "mac" ? [quickKeys] : quickKeys.split("+");
  const quickHint = (
    <p className="notes-empty-hint">
      {hintBefore}
      {keyParts.map((part, index) => (
        <span key={part}>
          {index > 0 && "+"}
          <kbd>{part}</kbd>
        </span>
      ))}
      {hintAfter}
    </p>
  );

  /** The note whose words, progress and save state the footer shows. */
  const openText = note !== null && !note.onDesktop ? note : null;
  const noticeShown = slotNotice !== null;

  return (
    <div
      className={emptyMode ? "notes-area is-empty" : "notes-area"}
      data-pane={pane}
      data-idle={note === null && !noticeShown ? "true" : undefined}
    >
      <section className="list-pane" aria-label={t("notes.list")}>
        <header className="pane-head">
          <h1 className="scope-heading">
            <button
              type="button"
              className="scope-button"
              title={t("notes.areaMenu")}
              aria-haspopup="menu"
              aria-expanded={menu?.kind === "area"}
              onClick={(event) => {
                const anchor = event.currentTarget;
                setMenu((open) => (open?.kind === "area" ? null : { kind: "area", anchor }));
              }}
            >
              <span className="scope-name">{shownScopeLabel}</span>
              <ChevronDownIcon />
            </button>
          </h1>
          {!emptyMode && (
            <button
              type="button"
              className="primary-button new-button"
              title={`${t("notes.new")} (${quickKeys})`}
              disabled={!writable}
              onClick={newNote}
            >
              <PlusIcon />
              {t("notes.new")}
            </button>
          )}
        </header>
        {banner}
        {emptyMode ? (
          <div className="notes-welcome">
            <div className="welcome-mark" aria-hidden="true" />
            <h2>{t("notes.emptyTitle")}</h2>
            {scopeName !== null ? (
              <p>{t("notes.emptyProject", { folder: scopeName })}</p>
            ) : shownScope.kind === "general" ? (
              <p>{t("notes.empty")}</p>
            ) : (
              writable && <p>{t("notes.emptyLead")}</p>
            )}
            {writable && (
              <>
                <button type="button" className="primary-button" onClick={newNote}>
                  <PlusIcon />
                  {t("notes.new")}
                </button>
                {quickHint}
              </>
            )}
          </div>
        ) : (
          <>
            <div className="find">
              <label className="search">
                <SearchIcon />
                <input
                  ref={searchInput}
                  type="search"
                  value={query}
                  placeholder={t("notes.searchShort")}
                  aria-label={t("notes.search")}
                  onChange={(event) => {
                    setQuery(event.currentTarget.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && query !== "") {
                      event.preventDefault();
                      setQuery("");
                    } else if (event.key === "ArrowDown") {
                      event.preventDefault();
                      moveRowFocus(-1, 1);
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
                      setQuery("");
                      searchInput.current?.focus();
                    }}
                  >
                    <CloseIcon size={12} />
                  </button>
                )}
              </label>
              <button
                type="button"
                className={pickedColors.length > 0 ? "color-button on" : "color-button"}
                aria-label={filterLabel}
                title={filterLabel}
                aria-haspopup="menu"
                aria-expanded={menu?.kind === "filter"}
                onClick={(event) => {
                  const anchor = event.currentTarget;
                  setMenu((open) => (open?.kind === "filter" ? null : { kind: "filter", anchor }));
                }}
              >
                {pickedColors.length === 0 ? (
                  <PaletteIcon />
                ) : (
                  <span className="picked" aria-hidden="true">
                    {pickedColors.slice(0, PICKED_DOTS).map((color) => (
                      <i key={color} style={dotStyle(color)} />
                    ))}
                    {pickedColors.length > PICKED_DOTS && (
                      <span className="picked-more">+{pickedColors.length - PICKED_DOTS}</span>
                    )}
                  </span>
                )}
              </button>
            </div>
            <div className="list-wrap">
              {listFailed && !searching && (
                <div className="notes-empty" role="alert">
                  <p>{t("notes.loadFailed")}</p>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      reloadFolders();
                      void reloadRef.current();
                    }}
                  >
                    {t("notes.retry")}
                  </button>
                </div>
              )}
              {searching && shownHits !== null && allRows.length === 0 && (
                <div className="notes-empty">
                  <p>{t("notes.noHits", { query: query.trim() })}</p>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      setQuery("");
                      searchInput.current?.focus();
                    }}
                  >
                    {t("notes.searchClear")}
                  </button>
                </div>
              )}
              {!searching && !listFailed && list !== null && allRows.length === 0 && (
                <div className="notes-empty">
                  <p>
                    {scopeName !== null
                      ? t("notes.emptyProject", { folder: scopeName })
                      : t("notes.empty")}
                  </p>
                </div>
              )}
              {allRows.length > 0 && visible.length === 0 && (
                <div className="notes-empty">
                  <p>{t("notes.noColorMatches")}</p>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      setColors(new Set());
                    }}
                  >
                    {t("notes.colorFilterClear")}
                  </button>
                </div>
              )}
              <ul className="note-list">
                {visible.map((row, index) => {
                  const key = noteKey(row);
                  const active = key === activeKey;
                  const tabStop = key === rovingKey ? 0 : -1;
                  const progress =
                    row.progress !== null && row.progress.total > 0 ? row.progress : null;
                  const time =
                    row.updatedAt === null ? "" : relativeTime(row.updatedAt, now, language);
                  return (
                    <li
                      key={key}
                      className={active ? "note-item active" : "note-item"}
                      style={edgeStyle(row.color, theme)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        const anchor = rows.current.get(key);
                        if (!anchor) return;
                        anchor.focus();
                        setMenu({
                          kind: "row",
                          anchor,
                          row,
                          at: { x: event.clientX, y: event.clientY },
                        });
                      }}
                    >
                      <button
                        type="button"
                        className={active ? "note-row active" : "note-row"}
                        aria-current={active ? "true" : undefined}
                        tabIndex={tabStop}
                        ref={(element) => {
                          if (element) rows.current.set(key, element);
                          else rows.current.delete(key);
                        }}
                        title={row.folder.path ?? general}
                        onFocus={() => {
                          setFocusKey(key);
                        }}
                        onClick={() => void openNote(row, !row.onDesktop)}
                        onKeyDown={(event) => {
                          const step =
                            event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
                          if (step !== 0) {
                            event.preventDefault();
                            moveRowFocus(index, step);
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
                        }}
                      >
                        <span className="note-row-head">
                          <span className="note-row-title">{row.title}</span>
                          <span className="note-row-meta">
                            {row.onDesktop && (
                              <span className="note-row-mark" title={t("notes.onDesktop")}>
                                <DesktopIcon size={14} />
                                <span className="sr-only">{t("notes.onDesktop")}</span>
                              </span>
                            )}
                            {progress !== null && (
                              <span
                                className={
                                  progress.done === progress.total
                                    ? "note-progress complete"
                                    : "note-progress"
                                }
                                title={progressText(progress)}
                              >
                                <span aria-hidden="true">
                                  {progress.done}/{progress.total}
                                </span>
                                <span className="sr-only">{progressText(progress)}</span>
                              </span>
                            )}
                            {time !== "" && <span>{time}</span>}
                          </span>
                        </span>
                        {row.excerpt !== "" && (
                          <span className="note-row-excerpt">{row.excerpt}</span>
                        )}
                      </button>
                      <div className="row-tools">
                        <button
                          type="button"
                          className="icon-button"
                          tabIndex={tabStop}
                          aria-label={t("notes.color")}
                          title={t("notes.color")}
                          aria-haspopup="menu"
                          aria-expanded={menu?.kind === "rowColor" && menu.row === row}
                          onClick={(event) => {
                            setMenu({ kind: "rowColor", anchor: event.currentTarget, row });
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
                            rowToDesktop(row);
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
                            onClick={() => void deleteRef(row, row.title)}
                          >
                            <TrashIcon />
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </>
        )}
      </section>

      <section
        className="note-pane"
        aria-label={shownTitle === "" ? t("notes.noteLabel") : shownTitle}
        style={note === null ? undefined : edgeStyle(note.color, theme)}
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
              aria-label={t("notes.backToList")}
              title={t("notes.backToList")}
              onClick={() => void backToList()}
            >
              <BackIcon />
            </button>
            <span className="note-crumb" title={note.folder.path ?? general}>
              {projectLabel(note.folder)}
            </span>
            {note.id !== null && !note.onDesktop && (
              <button
                type="button"
                className="ghost-button"
                aria-label={t("notes.toDesktop")}
                title={t("notes.toDesktopHint")}
                onClick={() => void putOnDesktop()}
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
              aria-expanded={menu?.kind === "note"}
              disabled={note.id === null}
              onClick={(event) => {
                const anchor = event.currentTarget;
                setMenu((open) => (open?.kind === "note" ? null : { kind: "note", anchor }));
              }}
            >
              <MoreIcon />
            </button>
          </div>
        )}

        {held && note?.id === null && (
          <div className="note-held" role="status">
            <p>{t("notes.heldHint")}</p>
            <button type="button" className="secondary-button" onClick={() => void copyOpenText()}>
              {t("notes.copyMarkdown")}
            </button>
          </div>
        )}

        {note?.onDesktop === true && (
          <div className="on-desktop">
            <DesktopIcon size={28} />
            <p className="on-desktop-title">{t("notes.onDesktop")}</p>
            <p className="muted">{t("notes.onDesktopHint")}</p>
            <div className="on-desktop-actions">
              <button type="button" className="primary-button" onClick={bringToFront}>
                {t("notes.bringToFront")}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void backFromDesktop()}
              >
                {t("notes.backFromDesktop")}
              </button>
            </div>
          </div>
        )}

        <div className="note-body" hidden={note === null || note.onDesktop}>
          <div className="note-page">
            {note !== null && renaming ? (
              <input
                className="note-rename"
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
                    void commitRename(event.currentTarget.value).then(() =>
                      editor.current?.focus(),
                    );
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setRenaming(false);
                    editor.current?.focus();
                  }
                }}
                onBlur={(event) => {
                  void commitRename(event.currentTarget.value);
                }}
              />
            ) : (
              note !== null && (
                <h2 className="note-heading">
                  <button
                    type="button"
                    className="note-title"
                    disabled={note.id === null || note.onDesktop || !writable}
                    title={note.id === null ? undefined : `${shownTitle}\n${t("notes.renameHint")}`}
                    onClick={() => {
                      setRenaming(true);
                    }}
                  >
                    <span className={note.id === null && stats.autoTitle === null ? "muted" : ""}>
                      {shownTitle}
                    </span>
                  </button>
                </h2>
              )
            )}
            {preview && (
              <div
                className="note-preview"
                role="region"
                tabIndex={0}
                aria-label={t("notes.previewOf", { title: shownTitle })}
                onClick={onPreviewClick}
                // Safe: markdownPreview.ts renders with html: false, without links or images; the
                // only elements it adds are the task checkboxes.
                dangerouslySetInnerHTML={{ __html: previewHtml ?? "" }}
              />
            )}
            <div className="note-editor" ref={editorHost} hidden={preview} />
          </div>
        </div>
      </section>

      {/* The footer: words, progress and "Saved" of the open note, crossfading with the one
          notice place, so a notice never covers text or buttons. */}
      <footer className="area-foot note-footer">
        <div className="foot-main">
          {openText !== null && (
            <div className={noticeShown ? "foot-status away" : "foot-status"}>
              <span className="note-words">{t("notes.words", { count: stats.words })}</span>
              {stats.progress.total > 0 && (
                <span
                  className={
                    stats.progress.done === stats.progress.total
                      ? "note-progress complete"
                      : "note-progress"
                  }
                  title={progressText(stats.progress)}
                >
                  <TaskIcon size={14} />
                  <span aria-hidden="true">
                    {stats.progress.done}/{stats.progress.total}
                  </span>
                  <span className="sr-only">{progressText(stats.progress)}</span>
                </span>
              )}
              {openText.id !== null && !unsaved && (
                <span className="note-saved">
                  {dirty ? (
                    t("notes.saving")
                  ) : (
                    <>
                      <CheckIcon size={14} />
                      {t("notes.saved")}
                    </>
                  )}
                </span>
              )}
            </div>
          )}
          {noticeSlot}
        </div>
        {openText !== null && unsaved && <span className="note-unsaved">{t("notes.unsaved")}</span>}
        {openText !== null && (
          <button
            type="button"
            className={preview ? "icon-button toggle on" : "icon-button toggle"}
            aria-pressed={preview}
            aria-label={t("notes.preview")}
            title={t("notes.preview")}
            disabled={openText.id === null}
            onClick={togglePreview}
          >
            <EyeIcon />
          </button>
        )}
      </footer>

      {popup}
    </div>
  );
}

/** The color dot of a swatch or the filter as a custom property (styles.css draws the dot). */
function dotStyle(color: NoteColor): Record<string, string> {
  return { "--dot": swatchColor(color) };
}

/** The note's color as the thin edge of its row and of the open note. */
function edgeStyle(color: NoteColor, theme: Theme): Record<string, string> {
  return { "--note-edge": noteTone(color, theme).edge };
}

function revealKey(): MessageKey {
  if (PLATFORM === "windows") return "notes.revealExplorer";
  if (PLATFORM === "mac") return "notes.revealFinder";
  return "notes.revealFileManager";
}
