// The notes area (ADR 0002, phase 1): Hangar's notes panel as its own window. Scope chips, a
// search across all notes, a color filter, the list, and one note in the Markdown editor or its
// preview. Wide windows show list and note side by side, narrow ones one at a time, as Hangar's
// panel does. The flow (quick note that exists only once you type, automatic title, saving 500 ms
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
  errorText,
  exportNote,
  fromDesktop,
  getStatus,
  isNotSaved,
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
  toneVariables,
  type NoteColor,
} from "./colors";
import { createNoteEditor, type NoteEditor } from "./editor";
import { captureStamp, relativeTime } from "./format";
import { DICTIONARIES, LANGUAGES, useT, type MessageKey } from "./i18n";
import {
  BackIcon,
  CheckIcon,
  CloseIcon,
  DesktopIcon,
  EyeIcon,
  MoreIcon,
  PlusIcon,
  SearchIcon,
  TaskIcon,
} from "./icons";
import {
  byLastChange,
  cleanTitle,
  colorCounts,
  filterByColors,
  folderName,
  nextAutoTitle,
  noteKey,
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
} from "./shortcuts";
import { Trash } from "./Trash";

const SAVE_DELAY_MS = 500;
/** Word count, progress and preview follow the text after a short pause. */
const STATS_DELAY_MS = 250;
const SEARCH_DELAY_MS = 200;
const TOAST_MS = 6000;
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

interface Toast {
  message: string;
  action?: { label: string; run: () => void };
}

type MenuKind = "note" | "list";

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
  const [menu, setMenu] = useState<{ kind: MenuKind; anchor: HTMLElement } | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listFailed, setListFailed] = useState(false);
  /** The open draft has text that could not become a note (read only): offer to copy it. */
  const [held, setHeld] = useState(false);
  /** The open note's last save failed; it stays open until a save works. */
  const [unsaved, setUnsaved] = useState(false);
  /** Leaving was refused because the open note is not saved: warn and offer to copy. */
  const [stuck, setStuck] = useState(false);
  /** The switch as set in this window, until the settings bring the stored state. */
  const [onTopSet, setOnTopSet] = useState<boolean | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const noteRef = useRef<Current | null>(null);
  const textRef = useRef("");
  const pending = useRef<{ folder: NoteFolder; id: string; text: string } | null>(null);
  const saveTimer = useRef<number | null>(null);
  const statsTimer = useRef<number | null>(null);
  const toastTimer = useRef<number | null>(null);
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

  const showToast = useCallback((next: Toast) => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    setToast(next);
    toastTimer.current = window.setTimeout(() => {
      toastTimer.current = null;
      setToast(null);
    }, TOAST_MS);
  }, []);

  /** An error from the backend as a message; "read only" has its own calm line already. */
  const fail = useCallback(
    (e: unknown) => {
      if (isReadOnly(e)) {
        void getStatus()
          .then(setStatus)
          .catch(() => null);
        return;
      }
      setError(
        isNotSaved(e) ? t("notes.notSaved") : t("notes.actionFailed", { error: errorText(e) }),
      );
    },
    [t],
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
      setError(t("notes.tooLarge"));
      return false;
    }
    try {
      await writeNote(job.folder, job.id, job.text);
      setUnsaved(false);
      setStuck(false);
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
      if (isReadOnly(e)) fail(e);
      else setError(t("notes.saveFailed", { error: errorText(e) }));
      return false;
    }
  }, [fail, t]);

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
      setStuck(false);
      return true;
    }
    if (!leaveAnyway.current.refused()) {
      setStuck(true);
      return false;
    }
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    pending.current = null;
    setUnsaved(false);
    setStuck(false);
    setError(null);
    return true;
  }, [leave]);

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
        setError(t("notes.heldHint"));
        return;
      }
      try {
        const made = await createNote(folder, t("notes.untitled"));
        await writeNote(folder, made.id, content);
        const title = nextAutoTitle(current(made), content, UNTITLED_BASES);
        if (title !== null) await renameNote(folder, made.id, title, false);
        void reloadRef.current();
        showToast({ message: t("notes.capturedNew") });
      } catch (e) {
        fail(e);
      }
    },
    [fail, showToast, t],
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
            if (result === "created") showToast({ message: t("notes.capturedNew") });
            else if (result === "stayed") await keepCapture(folder, content);
            break;
          }
          case "sharedUnavailable":
            showToast({ message: t("notes.sharedUnavailable") });
            break;
        }
      }
    },
    // `project` is rebuilt every render; its path says when it changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, language, keepCapture, openNote, showToast, startDraft, t],
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
      for (const timer of [saveTimer, statsTimer, toastTimer]) {
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
        if (live) setError(t("notes.editorFailed"));
      });
    return () => {
      live = false;
    };
  }, [preview, previewTick, note, writable, t]);

  // ---- Actions on the open note ----------------------------------------------------------------

  const commitRename = async (value: string) => {
    setRenaming(false);
    const open = noteRef.current;
    if (open?.id == null || value.trim() === open.title) return;
    const title = cleanTitle(value);
    if (title === null) {
      setError(t("notes.invalidTitle"));
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
      showToast({ message: t("notes.restored", { title }) });
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
      await deleteNote(ref.folder, ref.id);
      await reloadRef.current();
      reloadFolders();
      showToast({
        message: t("notes.deleted", { title }),
        action: {
          label: t("notes.undo"),
          run: () => {
            setToast(null);
            void restore(ref.folder, ref.id, title).then((restored) => {
              if (restored !== undefined) void openNote({ folder: ref.folder, id: restored }, true);
            });
          },
        },
      });
      requestAnimationFrame(() => searchInput.current?.focus());
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

  const pickColor = (color: NoteColor) => {
    const open = noteRef.current;
    if (open?.id == null) return;
    void setNoteColor(open.folder, open.id, color)
      .then((saved) => {
        const next = { ...open, color: saved };
        if (noteRef.current === open) {
          noteRef.current = next;
          setNote(next);
        }
        void reloadRef.current();
      })
      .catch(fail);
  };

  const withSaved = (action: (folder: NoteFolder, id: string) => Promise<void>) => {
    const open = noteRef.current;
    if (open?.id == null) return;
    const id = open.id;
    void flush()
      .then(() => action(open.folder, id))
      .catch(fail);
  };

  /** The open text to the clipboard (a held draft, a note that cannot save), so it survives. */
  const copyOpenText = async () => {
    if (await copyText(textRef.current)) showToast({ message: t("notes.copied") });
    else setError(t("notes.copyFailed"));
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

  const scopeChips: { scope: NotesScope; label: string; title: string }[] = [
    ...(project?.path != null
      ? [
          {
            scope: { kind: "project" } as const,
            label: t("notes.scopeProject"),
            title: t("notes.scopeProjectTip", {
              folder: folderName(project.path),
              path: project.path,
            }),
          },
        ]
      : []),
    { scope: { kind: "all" }, label: t("notes.scopeAll"), title: t("notes.scopeAllTip") },
    { scope: { kind: "general" }, label: general, title: t("notes.scopeGeneralTip") },
  ];
  if (shownScope.kind === "folder" && shownScope.folder.path !== null) {
    scopeChips.push({
      scope: shownScope,
      label: folderName(shownScope.folder.path),
      title: shownScope.folder.path,
    });
  }

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

  const moveRowFocus = (index: number, step: 1 | -1) => {
    const ordered = [...rows.current.values()]
      .filter((row) => row.isConnected)
      .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    const next = ordered[index + step];
    if (next) next.focus();
    else if (index + step < 0) searchInput.current?.focus();
  };

  const noteMenu: MenuItem[] =
    note?.id == null
      ? []
      : [
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
          {
            type: "custom",
            key: "colors",
            content: (
              <div className="swatches" role="group" aria-label={t("notes.color")}>
                {NOTE_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    role="menuitemradio"
                    aria-checked={color === note.color}
                    className="swatch"
                    title={colorName(color, colorNames, t)}
                    aria-label={colorName(color, colorNames, t)}
                    style={{ background: swatchColor(color) }}
                    onClick={() => {
                      setMenu(null);
                      pickColor(color);
                    }}
                  >
                    {color === note.color && <CheckIcon size={14} />}
                  </button>
                ))}
              </div>
            ),
          },
          {
            type: "action",
            key: "copy",
            label: t("notes.copyMarkdown"),
            run: () => {
              withSaved(async (folder, id) => {
                await copyNote(folder, id);
                showToast({ message: t("notes.copied") });
              });
            },
          },
          {
            type: "action",
            key: "export",
            label: t("notes.export"),
            run: () => {
              withSaved(async (folder, id) => {
                const path = await exportNote(folder, id);
                if (path !== null) showToast({ message: t("notes.exported", { path }) });
              });
            },
          },
          {
            type: "action",
            key: "reveal",
            label: t(revealKey()),
            run: () => {
              withSaved((folder, id) => revealNote(folder, id).then(() => undefined));
            },
          },
          ...(writable
            ? [
                { type: "separator" as const, key: "sep" },
                {
                  type: "action" as const,
                  key: "delete",
                  label: t("notes.delete"),
                  danger: true,
                  run: deleteCurrent,
                },
              ]
            : []),
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

  const listMenu: MenuItem[] = [
    {
      type: "action",
      key: "trash",
      label: t("notes.trash"),
      run: () => {
        leaveFor("trash");
      },
    },
    {
      type: "action",
      key: "folder",
      label: t("notes.openFolder"),
      run: () => {
        void revealNotesFolder(newFolder).catch(fail);
      },
    },
    { type: "separator", key: "sep" },
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
      run: () => {
        leaveFor("settings");
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

  const closeMenu = (reason: "done" | "dismiss") => {
    const open = menu;
    setMenu(null);
    if (reason === "dismiss") open?.anchor.focus();
  };

  // ---- Views -----------------------------------------------------------------------------------

  if (view === "settings") {
    return (
      <div className="notes-area single">
        <NotesSettings
          app={app}
          onBack={() => {
            setView("browse");
          }}
        />
      </div>
    );
  }

  if (view === "trash") {
    return (
      <div className="notes-area single">
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
    );
  }

  return (
    <div className="notes-area" data-pane={pane}>
      <section className="list-pane" aria-label={t("notes.list")}>
        <header className="pane-head">
          <h1>{t("hub.title")}</h1>
          <button
            type="button"
            className="icon-button"
            aria-label={t("notes.new")}
            title={`${t("notes.new")} (${quickKeys})`}
            disabled={!writable}
            onClick={newNote}
          >
            <PlusIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t("notes.more")}
            title={t("notes.more")}
            aria-haspopup="menu"
            aria-expanded={menu?.kind === "list"}
            onClick={(event) => {
              const anchor = event.currentTarget;
              setMenu((open) => (open?.kind === "list" ? null : { kind: "list", anchor }));
            }}
          >
            <MoreIcon />
          </button>
        </header>
        {banner}
        <label className="search">
          <SearchIcon size={14} />
          <input
            ref={searchInput}
            type="search"
            value={query}
            placeholder={t("notes.search")}
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
        {!searching && (
          <div className="chips" role="group" aria-label={t("notes.scopeLabel")}>
            {scopeChips.map((chip) => {
              const on = sameScope(chip.scope, shownScope);
              return (
                <button
                  key={chip.scope.kind === "folder" ? `folder:${chip.label}` : chip.scope.kind}
                  type="button"
                  className={on ? "chip on" : "chip"}
                  aria-pressed={on}
                  title={chip.title}
                  onClick={() => {
                    setScope(chip.scope);
                  }}
                >
                  {chip.label}
                </button>
              );
            })}
          </div>
        )}
        <div className="color-filter" role="group" aria-label={t("notes.colorFilter")}>
          <span className="color-filter-label" aria-hidden="true">
            {t("notes.color")}
          </span>
          {NOTE_COLORS.map((color) => {
            const on = colors.has(color);
            const name = colorName(color, colorNames, t);
            const count = counts.get(color) ?? 0;
            return (
              <button
                key={color}
                type="button"
                className={on ? "color-chip on" : "color-chip"}
                aria-pressed={on}
                title={`${name} (${String(count)})`}
                aria-label={name}
                style={dotStyle(color)}
                onClick={() => {
                  const next = new Set(colors);
                  if (on) next.delete(color);
                  else next.add(color);
                  setColors(next);
                }}
              >
                <span className="color-dot" aria-hidden="true" />
                {(on || colorNames[color] !== undefined) && (
                  <span className="color-chip-name">{name}</span>
                )}
              </button>
            );
          })}
          {/* Without a match the empty state below offers it; one button is enough. */}
          {colors.size > 0 && visible.length > 0 && (
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setColors(new Set());
              }}
            >
              {t("notes.colorFilterClear")}
            </button>
          )}
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
              {writable && (
                <>
                  <button type="button" className="primary-button" onClick={newNote}>
                    <PlusIcon />
                    {t("notes.new")}
                  </button>
                  <p className="notes-empty-hint">{t("notes.emptyHint", { keys: quickKeys })}</p>
                </>
              )}
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
              const active = note?.id != null && sameNote(row, { ...note, id: note.id });
              const progress =
                row.progress !== null && row.progress.total > 0 ? row.progress : null;
              const time = row.updatedAt === null ? "" : relativeTime(row.updatedAt, now, language);
              const showProject = mixed || searching;
              return (
                <li key={key}>
                  <button
                    type="button"
                    className={active ? "note-row active" : "note-row"}
                    style={toneVariables(noteTone(row.color, theme))}
                    aria-current={active ? "true" : undefined}
                    ref={(element) => {
                      if (element) rows.current.set(key, element);
                      else rows.current.delete(key);
                    }}
                    title={row.folder.path ?? general}
                    onClick={() => void openNote(row, !row.onDesktop)}
                    onKeyDown={(event) => {
                      const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
                      if (step !== 0) {
                        event.preventDefault();
                        moveRowFocus(index, step);
                      } else if (event.key === "Delete" && writable) {
                        event.preventDefault();
                        void deleteRef(row, row.title);
                      }
                    }}
                  >
                    <span className="note-row-head">
                      <span className="note-row-title">{row.title}</span>
                      {row.onDesktop && (
                        <span className="note-row-mark" title={t("notes.onDesktop")}>
                          <DesktopIcon size={13} />
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
                          <TaskIcon size={12} />
                          <span aria-hidden="true">
                            {progress.done}/{progress.total}
                          </span>
                          <span className="sr-only">{progressText(progress)}</span>
                        </span>
                      )}
                    </span>
                    {row.excerpt !== "" && <span className="note-row-excerpt">{row.excerpt}</span>}
                    <span className="note-row-meta">
                      {showProject && <span>{projectLabel(row.folder)}</span>}
                      {showProject && time !== "" && <span aria-hidden="true"> · </span>}
                      {time !== "" && <span>{time}</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <section
        className="note-pane"
        aria-label={shownTitle === "" ? t("notes.noteLabel") : shownTitle}
        style={note === null ? undefined : toneVariables(noteTone(note.color, theme))}
      >
        {note === null && (
          <div className="note-placeholder">
            <p>{t(writable ? "notes.pick" : "notes.pickReadOnly")}</p>
            {writable && (
              <button type="button" className="secondary-button" onClick={newNote}>
                <PlusIcon />
                {t("notes.new")}
              </button>
            )}
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
            {renaming ? (
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
            )}
            {!note.onDesktop && stats.progress.total > 0 && (
              <span
                className={
                  stats.progress.done === stats.progress.total
                    ? "note-progress complete"
                    : "note-progress"
                }
                title={progressText(stats.progress)}
              >
                <TaskIcon size={12} />
                <span aria-hidden="true">
                  {stats.progress.done}/{stats.progress.total}
                </span>
                <span className="sr-only">{progressText(stats.progress)}</span>
              </span>
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

        {note !== null && !note.onDesktop && (
          <footer className="note-footer">
            <span className="note-words">{t("notes.words", { count: stats.words })}</span>
            {unsaved && <span className="note-unsaved">{t("notes.unsaved")}</span>}
            <button
              type="button"
              className={preview ? "icon-button toggle on" : "icon-button toggle"}
              aria-pressed={preview}
              aria-label={t("notes.preview")}
              title={t("notes.preview")}
              disabled={note.id === null}
              onClick={togglePreview}
            >
              <EyeIcon />
            </button>
            {note.id !== null && (
              <button
                type="button"
                className="secondary-button"
                title={t("notes.toDesktopHint")}
                onClick={() => void putOnDesktop()}
              >
                <DesktopIcon size={14} />
                {t("notes.toDesktop")}
              </button>
            )}
          </footer>
        )}
      </section>

      <div className="notices">
        {stuck && (
          <div className="notes-error notes-stuck" role="alert">
            <p>{t("notes.leaveUnsaved")}</p>
            <button type="button" className="secondary-button" onClick={() => void copyOpenText()}>
              {t("notes.copyMarkdown")}
            </button>
          </div>
        )}
        {error && (
          <div className="notes-error" role="alert">
            <span>{error}</span>
            <button
              type="button"
              className="icon-button"
              aria-label={t("notes.dismiss")}
              title={t("notes.dismiss")}
              onClick={() => {
                setError(null);
              }}
            >
              <CloseIcon size={12} />
            </button>
          </div>
        )}
        {toast && (
          <div className="toast" role="status">
            <span>{toast.message}</span>
            {toast.action && (
              <button type="button" className="link-button" onClick={toast.action.run}>
                {toast.action.label}
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              aria-label={t("notes.dismiss")}
              onClick={() => {
                setToast(null);
              }}
            >
              <CloseIcon size={12} />
            </button>
          </div>
        )}
      </div>

      {menu && (
        <PopupMenu
          items={menu.kind === "note" ? noteMenu : listMenu}
          label={t("notes.more")}
          anchor={menu.anchor}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}

/** The filter dot's color as a custom property (styles.css draws the dot). */
function dotStyle(color: NoteColor): Record<string, string> {
  return { "--dot": swatchColor(color) };
}

function revealKey(): MessageKey {
  if (PLATFORM === "windows") return "notes.revealExplorer";
  if (PLATFORM === "mac") return "notes.revealFinder";
  return "notes.revealFileManager";
}
