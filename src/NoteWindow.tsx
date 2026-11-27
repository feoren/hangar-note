// One sticky note in its own frameless window (ADR 0001), in the look the settings name
// (ADR 0004). In both looks a header in the note's color is always there and moves the window:
// - hangar: the header names the note and its checklist progress; the formatting bar at the
//   bottom says whether the text is saved and keeps its place while hidden, so the text never
//   moves.
// - paper: the header holds only the buttons; the formatting bar floats over the text's bottom
//   edge while you write or point at the note.
// The editor's element is the same in every look, so switching keeps the text, the cursor and
// what waits to be saved. Typing is saved 500 ms after the last keystroke, at once on blur and
// close, and before the backend deletes the note from the notes area, quits or flushes.
//
// Any note can sit on the desktop (ADR 0002); while it does, this window is its only editor. Its
// title follows the first line as in the notes area, and a new note closed empty goes to the trash.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  closeNote,
  deleteNote,
  getStatus,
  getSticky,
  isChanged,
  MAX_NOTE_BYTES,
  newSticky,
  noteFlushed,
  onChangedOutside,
  onCloseRequested,
  onDeleteRequested,
  onFlushRequested,
  onLookChanged,
  openHub,
  renameNote,
  setNoteColor,
  setNoteOnTop,
  storageError,
  utf8Bytes,
  windowReady,
  writeSticky,
  type NoteFolder,
  type OpenedNote,
} from "./api";
import {
  colorName,
  NOTE_COLORS,
  noteTone,
  swatchColor,
  toneVariables,
  type NoteColor,
  type Theme,
} from "./colors";
import { copyText } from "./clipboard";
import { CursorFooter } from "./CursorFooter";
import { createCursorStore } from "./cursorStats";
import { createNoteEditor, type Format, type NoteEditor } from "./editor";
import { errorMessage } from "./errors";
import { DICTIONARIES, LANGUAGES, useT, type Language, type MessageKey } from "./i18n";
import { BulletIcon, CheckIcon, CloseIcon, MoreIcon, PlusIcon, TaskIcon } from "./icons";
import { createLeaveAnyway } from "./leaveAnyway";
import type { Look } from "./looks";
import { focusFirstItem, moveMenuFocus } from "./menuKeys";
import { nextAutoTitle } from "./notes";
import { checklistProgress, type ChecklistProgress } from "./noteText";
import { createSaver, type SaveState } from "./saver";
import { currentPlatform, matchNoteShortcut, shortcutLabel, type NoteAction } from "./shortcuts";

interface Props {
  /** The window's label (`note-<scope>-<id>`); requests to this window carry it. */
  label: string;
  theme: Theme;
  colorNames: Partial<Record<NoteColor, string>>;
  look: Look;
  /** The UI language, for the numbers of the status line. */
  language: Language;
}

const PLATFORM = currentPlatform();
const UNTITLED_BASES = LANGUAGES.map((language) => DICTIONARIES[language]["notes.untitled"]);

type KeyedAction = Exclude<NoteAction, "leave">;

const FORMATS: readonly (Format & KeyedAction)[] = ["bold", "italic", "strike", "bullet", "task"];
/** The checklist progress in the hangar look's header follows the text after a short pause. */
const PROGRESS_DELAY_MS = 250;

/**
 * The version of the note's file as this window last read or wrote it, and whether a save was
 * refused because the file was changed outside since. Reading a version ends that refusal.
 */
function createFileState() {
  let version: string | undefined;
  let conflicted = false;
  return {
    version: () => version,
    conflicted: () => conflicted,
    read: (next: string) => {
      version = next;
      conflicted = false;
    },
    refused: () => {
      conflicted = true;
    },
  };
}

export function NoteWindow({ label, theme, colorNames, look, language }: Props) {
  const t = useT();
  const [note, setNote] = useState<OpenedNote | null>(null);
  const [writable, setWritable] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  /** The sentence for the last failed save (errors.ts), never the backend's own text. */
  const [saveError, setSaveError] = useState<MessageKey>("note.saveFailed");
  const [tooLarge, setTooLarge] = useState(false);
  const [focused, setFocused] = useState(false);
  /** The pointer is over the note: its tools show, as they do with the focus. */
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  /** Closing was refused because the text is not saved: offer to copy it. */
  const [stuck, setStuck] = useState(false);
  const [copyResult, setCopyResult] = useState<"copied" | "failed" | null>(null);
  /**
   * The file was changed outside: "changed" offers to reload or copy, "confirm" asks before the
   * reload drops the typed text.
   */
  const [conflict, setConflict] = useState<"changed" | "confirm" | null>(null);
  /** The note's file was deleted outside (in Hangar); its text is still here to be copied. */
  const [gone, setGone] = useState(false);
  /**
   * What the saver needs to know about the file, kept outside React's state (the saver reads it
   * while it writes): `version`, the version the note was read or last saved with, sent as
   * `expected`; `conflicted`, set once a save was refused as changed, so nothing more is sent
   * until the note is reloaded.
   */
  const [file] = useState(createFileState);
  const [progress, setProgress] = useState<ChecklistProgress>({ done: 0, total: 0 });
  /** The cursor's numbers for the status line; only the status line renders when they change. */
  const [cursor] = useState(createCursorStore);
  const progressTimer = useRef<number | null>(null);
  const [leaveAnyway] = useState(() => createLeaveAnyway());
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<NoteEditor | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const closing = useRef(false);
  const noteRef = useRef<OpenedNote | null>(null);
  const textRef = useRef("");
  /** The save state as a ref, for the change outside, which arrives between renders. */
  const [saveNow] = useState<{ state: SaveState }>(() => ({ state: "saved" }));
  const [saver] = useState(() =>
    createSaver({
      save: async (text) => {
        // Every save would be refused the same way; the text stays pending, the note says why.
        if (file.conflicted()) throw new Error("The note was changed outside; reload it first");
        file.read(await writeSticky(text, file.version()));
      },
      onState: (state, error) => {
        saveNow.state = state;
        setSaveState(state);
        if (state === "failed" && isChanged(error)) {
          file.refused();
          setConflict((open) => open ?? "changed");
        }
        if (state === "failed") setSaveError(errorMessage(error, "save")?.key ?? "note.saveFailed");
        if (state === "saved") {
          leaveAnyway.reset();
          setStuck(false);
          setCopyResult(null);
        }
      },
    }),
  );
  // The editor gets its callbacks once; they read the current values through this.
  const latest = useRef({ t });
  useEffect(() => {
    latest.current = { t };
  });

  const folder = (open: OpenedNote): NoteFolder => ({ path: open.path });

  /** The title follows the first line while the note has a provisional one. */
  const retitle = useCallback(async () => {
    const open = noteRef.current;
    if (!open) return;
    const title = nextAutoTitle(open, textRef.current, UNTITLED_BASES);
    if (title === null) return;
    try {
      await renameNote(folder(open), open.id, title, false);
      const renamed = { ...open, title };
      noteRef.current = renamed;
      setNote(renamed);
    } catch {
      // It keeps its title; the next blur tries again.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getSticky(), getStatus()])
      .then(([content, status]) => {
        const element = host.current;
        if (cancelled || !element) return;
        const canWrite = status.access.state === "writable";
        noteRef.current = content;
        textRef.current = content.text;
        file.read(content.version);
        setNote(content);
        setWritable(canWrite);
        setProgress(checklistProgress(content.text));
        editor.current = createNoteEditor(element, {
          text: content.text,
          label: latest.current.t("note.editorLabel"),
          placeholder: latest.current.t("note.placeholder"),
          taskLabel: latest.current.t("note.task"),
          readOnly: !canWrite,
          onCursor: cursor.set,
          onChange: (text) => {
            textRef.current = text;
            if (progressTimer.current !== null) window.clearTimeout(progressTimer.current);
            progressTimer.current = window.setTimeout(() => {
              progressTimer.current = null;
              setProgress(checklistProgress(textRef.current));
            }, PROGRESS_DELAY_MS);
            const large = utf8Bytes(text) > MAX_NOTE_BYTES;
            setTooLarge(large);
            // The backend refuses it anyway; the last version that fits stays on disk.
            if (!large) saver.change(text);
          },
          onFocus: (has) => {
            if (!has) void saver.flush().then(retitle);
          },
        });
        // An empty note is there to be written in.
        if (content.text === "" && canWrite) editor.current.focus();
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      })
      .finally(() => {
        if (!cancelled) void windowReady().catch(() => null);
      });
    return () => {
      cancelled = true;
      if (progressTimer.current !== null) window.clearTimeout(progressTimer.current);
      editor.current?.destroy();
      editor.current = null;
    };
  }, [saver, retitle, file, cursor]);

  // Not disposed on unmount: StrictMode unmounts once in development, and the window's end is a
  // destroy anyway. What is still pending goes out right away.
  useEffect(
    () => () => {
      void saver.flush();
    },
    [saver],
  );

  const close = useCallback(async () => {
    if (closing.current) return;
    closing.current = true;
    // A failed write (full disk, folder gone) or a text over the limit keeps the window: closing
    // it would throw away the text that only exists here. The note offers to copy it; closing
    // again within 10 s closes anyway (leaveAnyway.ts), so the note cannot trap the person.
    const saved = (await saver.flush()) && utf8Bytes(textRef.current) <= MAX_NOTE_BYTES;
    if (!saved) {
      if (!leaveAnyway.refused()) {
        setStuck(true);
        closing.current = false;
        return;
      }
      saver.dispose();
      try {
        await closeNote();
      } catch {
        closing.current = false;
      }
      return;
    }
    leaveAnyway.reset();
    setStuck(false);
    const open = noteRef.current;
    try {
      if (open && writable && open.autoTitled && textRef.current.trim() === "") {
        // A new note left empty is not kept (Hangar's quick note).
        await deleteNote(folder(open), open.id);
        saver.dispose();
        return;
      }
      await retitle();
      await closeNote();
    } catch {
      closing.current = false;
    }
  }, [saver, retitle, writable, leaveAnyway]);

  const copyUnsaved = async () => {
    setCopyResult((await copyText(textRef.current)) ? "copied" : "failed");
  };

  /** The note as its file is now; only after the person confirmed that the typed text goes. */
  const reloadChanged = async () => {
    try {
      const fresh = await getSticky();
      saver.discard();
      file.read(fresh.version);
      noteRef.current = fresh;
      textRef.current = fresh.text;
      setNote(fresh);
      editor.current?.load(fresh.text);
      setProgress(checklistProgress(fresh.text));
      setTooLarge(false);
      setSaveState("saved");
      setConflict(null);
      setStuck(false);
      setCopyResult(null);
      leaveAnyway.reset();
      editor.current?.focus();
    } catch {
      setConflict("changed");
      setCopyResult(null);
    }
  };

  /**
   * The file was changed outside: the note shows it as it is now, without a click, while nothing
   * typed here waits for its save. With unsaved text the next save is refused as `changed`, and
   * that notice asks before anything is replaced. A note deleted outside keeps its text here and
   * says so, with a way to copy it.
   */
  const followOutside = useCallback(async () => {
    let fresh: OpenedNote;
    try {
      fresh = await getSticky();
    } catch (error) {
      if (storageError(error) === "not-found") setGone(true);
      return;
    }
    setGone(false);
    if (fresh.version === file.version() || file.conflicted()) return;
    if (saveNow.state !== "saved") return;
    file.read(fresh.version);
    noteRef.current = fresh;
    textRef.current = fresh.text;
    setNote(fresh);
    editor.current?.load(fresh.text);
    setProgress(checklistProgress(fresh.text));
  }, [file, saveNow]);

  const remove = useCallback(async () => {
    setMenuOpen(false);
    // Saved first, so "Undo" in the notes area brings back every word. A failed write keeps the
    // note, as on close: its text exists only here. The notes area, if it asked, learns why.
    if (!(await saver.flush())) {
      void noteFlushed(false).catch(() => null);
      return;
    }
    const open = noteRef.current;
    if (!open) return;
    try {
      await deleteNote(folder(open), open.id);
      // The window is gone now; a late blur must not write to a note in the trash.
      saver.dispose();
    } catch {
      // Not deleted: the note stays, and so does saving what is typed next.
    }
  }, [saver]);

  // Requests from the backend (windows.rs): Alt+F4, a delete from the notes area, quitting, and a
  // color chosen in the notes area.
  useEffect(() => {
    const listeners = [
      onCloseRequested(label, () => {
        void close();
      }),
      onDeleteRequested(label, () => {
        void remove();
      }),
      onFlushRequested(label, () => {
        void saver
          .flush()
          .then((saved) => noteFlushed(saved))
          .catch(() => null);
      }),
      onChangedOutside(label, () => {
        void followOutside();
      }),
      onLookChanged(label, (look) => {
        const open = noteRef.current;
        if (!open) return;
        const next = { ...open, color: look.color };
        noteRef.current = next;
        setNote(next);
      }),
    ].map((listening) => listening.catch(() => null));
    return () => {
      for (const listening of listeners) void listening.then((stop) => stop?.());
    };
  }, [label, close, remove, saver, followOutside]);

  const createNew = useCallback(() => {
    if (!writable) return;
    void newSticky(t("notes.untitled")).catch(() => null);
  }, [t, writable]);

  // Shortcuts (shortcuts.ts) in the capture phase, before CodeMirror sees them: its default
  // keymap binds Mod-i to "select parent syntax".
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = matchNoteShortcut(event, PLATFORM);
      if (action === null) return;
      if (action === "leave") {
        if (menuOpen) {
          setMenuOpen(false);
          menuButton.current?.focus();
        } else if (document.activeElement instanceof HTMLElement) {
          // Out of the editor or the formatting bar alike; the bar goes with the focus.
          document.activeElement.blur();
        }
        event.preventDefault();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (action === "newNote") createNew();
      else editor.current?.format(action);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
    };
  }, [menuOpen, createNew]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !menu.current?.contains(target) &&
        !menuButton.current?.contains(target)
      ) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    if (menu.current) focusFirstItem(menu.current);
    return () => {
      window.removeEventListener("mousedown", onDown);
    };
  }, [menuOpen]);

  const pickColor = (color: NoteColor) => {
    const open = noteRef.current;
    if (!open) return;
    void setNoteColor(folder(open), open.id, color)
      .then((saved) => {
        const next = { ...open, color: saved };
        noteRef.current = next;
        setNote(next);
      })
      .catch(() => null);
  };

  const toggleOnTop = () => {
    const open = noteRef.current;
    if (!open) return;
    void setNoteOnTop(!open.onTop)
      .then((onTop) => {
        const next = { ...open, onTop };
        noteRef.current = next;
        setNote(next);
      })
      .catch(() => null);
  };

  const color = note?.color ?? "lemon";
  const style = toneVariables(noteTone(color, theme));
  const withKeys = (text: string, action: KeyedAction) =>
    t("common.withShortcut", { label: text, keys: shortcutLabel(action, PLATFORM, t) });
  const formatLabel = (format: Format) => t(`format.${format}`);

  const toolsShown = focused || hovered;
  const savedText =
    saveState === "failed" || tooLarge
      ? t("notes.unsaved")
      : saveState === "saved"
        ? t("notes.saved")
        : t("notes.saving");
  const progressText = t("notes.progress", { done: progress.done, total: progress.total });
  const newButton = (
    <button
      key="new"
      type="button"
      className="icon-button"
      title={withKeys(t("note.new"), "newNote")}
      aria-label={t("note.new")}
      disabled={!writable}
      onClick={createNew}
    >
      <PlusIcon />
    </button>
  );

  // Every part has a key and the same parent in every look: React keeps the editor's element
  // (`body`) when the look changes, and with it the editor and its text.
  return (
    <div
      className={hovered ? "note hovered" : "note"}
      data-look={look}
      style={style}
      onMouseEnter={() => {
        setHovered(true);
      }}
      onMouseLeave={() => {
        setHovered(false);
      }}
      // React's focus and blur bubble (focusin and focusout): the bar stays while the focus moves
      // between the editor, the bar and the header, and goes when it leaves the window.
      onFocus={() => {
        setFocused(true);
      }}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node && event.currentTarget.contains(next))) setFocused(false);
      }}
    >
      <header key="head" className="note-head" data-tauri-drag-region title={t("note.drag")}>
        {look === "hangar" ? (
          <>
            <span className="note-head-title" data-tauri-drag-region>
              {note?.title ?? ""}
            </span>
            {progress.total > 0 && (
              <span className="note-head-progress" title={progressText} data-tauri-drag-region>
                <span aria-hidden="true">
                  {progress.done}/{progress.total}
                </span>
                <span className="sr-only">{progressText}</span>
              </span>
            )}
            {newButton}
          </>
        ) : (
          <>
            {newButton}
            <span className="note-head-fill" data-tauri-drag-region />
          </>
        )}
        <button
          ref={menuButton}
          type="button"
          className="icon-button"
          title={t("note.menu")}
          aria-label={t("note.menu")}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => {
            setMenuOpen((open) => !open);
          }}
        >
          <MoreIcon />
        </button>
        <button
          type="button"
          className="icon-button"
          title={t("note.close")}
          aria-label={t("note.close")}
          onClick={() => {
            void close();
          }}
        >
          <CloseIcon />
        </button>
      </header>

      {menuOpen && (
        <div
          key="menu"
          ref={menu}
          className="note-menu"
          role="menu"
          aria-label={t("note.menu")}
          onKeyDown={(event) => {
            if (moveMenuFocus(event.currentTarget, event.key)) event.preventDefault();
          }}
        >
          <p className="menu-heading" aria-hidden="true">
            {t("note.color")}
          </p>
          <div className="menu-swatches" role="group" aria-label={t("note.color")}>
            {NOTE_COLORS.map((option) => (
              <button
                key={option}
                type="button"
                role="menuitemradio"
                aria-checked={option === color}
                className={option === color ? "menu-swatch on" : "menu-swatch"}
                title={colorName(option, colorNames, t)}
                aria-label={colorName(option, colorNames, t)}
                onClick={() => {
                  pickColor(option);
                }}
              >
                <span className="swatch-dot" style={dotStyle(option)}>
                  {option === color && <CheckIcon size={12} />}
                </span>
              </button>
            ))}
          </div>
          <div className="menu-separator" role="separator" />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={note?.onTop === true}
            className="menu-item"
            onClick={toggleOnTop}
          >
            <span className="menu-check">{note?.onTop === true && <CheckIcon size={14} />}</span>
            {t("note.keepOnTop")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setMenuOpen(false);
              void openHub().catch(() => null);
            }}
          >
            <span className="menu-check" />
            {t("note.allNotes")}
          </button>
          {writable && (
            <>
              <div className="menu-separator" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="menu-item danger"
                onClick={() => {
                  void remove();
                }}
              >
                <span className="menu-check" />
                {t("note.delete")}
              </button>
            </>
          )}
        </div>
      )}

      <div key="body" className="note-body" ref={host}>
        {loadFailed && <p className="note-message">{t("note.loadFailed")}</p>}
        {!note && !loadFailed && <p className="note-message muted">{t("note.loading")}</p>}
      </div>

      {!writable && (
        <p key="readOnly" className="note-message note-error" role="status">
          {t("note.readOnly")}
        </p>
      )}

      {(tooLarge || saveState === "failed") && !stuck && conflict === null && (
        <p key="saveError" className="note-message note-error" role="status">
          {tooLarge ? t("note.tooLarge") : t(saveError)}
        </p>
      )}

      {gone && !stuck && (
        <div key="gone" className="note-message note-stuck" role="status">
          <p>{t("note.deletedOutside")}</p>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              void copyUnsaved();
            }}
          >
            {t("notes.copyMarkdown")}
          </button>
          {copyResult !== null && (
            <p role="status">
              {copyResult === "copied" ? t("notes.copied") : t("notes.copyFailed")}
            </p>
          )}
        </div>
      )}

      {conflict !== null && !stuck && !gone && (
        <div key="changed" className="note-message note-error note-stuck" role="alert">
          <p>{conflict === "confirm" ? t("notes.reloadDiscards") : t("error.changed")}</p>
          {conflict === "confirm" ? (
            <>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  void reloadChanged();
                }}
              >
                {t("notes.reloadConfirm")}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setConflict("changed");
                }}
              >
                {t("notes.reloadCancel")}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setCopyResult(null);
                  setConflict("confirm");
                }}
              >
                {t("notes.reloadNote")}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  void copyUnsaved();
                }}
              >
                {t("notes.copyMarkdown")}
              </button>
            </>
          )}
          {copyResult !== null && (
            <p role="status">
              {copyResult === "copied" ? t("notes.copied") : t("notes.copyFailed")}
            </p>
          )}
        </div>
      )}

      {stuck && (
        <div key="stuck" className="note-message note-error note-stuck" role="alert">
          <p>{t("note.closeUnsaved")}</p>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              void copyUnsaved();
            }}
          >
            {t("notes.copyMarkdown")}
          </button>
          {copyResult !== null && (
            <p role="status">
              {copyResult === "copied" ? t("notes.copied") : t("notes.copyFailed")}
            </p>
          )}
        </div>
      )}

      {writable && (
        // hangar keeps the bar's place while it is hidden, so the text does not jump when it shows;
        // paper's bar floats over the text, which keeps room for it at its end.
        <div key="format" className="format-slot">
          {toolsShown && (
            <div className="format-bar" role="toolbar" aria-label={t("format.bar")}>
              {FORMATS.map((format) => (
                <button
                  key={format}
                  type="button"
                  className={`icon-button format-${format}`}
                  title={withKeys(formatLabel(format), format)}
                  aria-label={formatLabel(format)}
                  // Keeps the focus (and the selection) in the editor.
                  onMouseDown={(event) => {
                    event.preventDefault();
                  }}
                  onClick={() => {
                    editor.current?.format(format);
                  }}
                >
                  {format === "bold" && <b>B</b>}
                  {format === "italic" && <i>I</i>}
                  {format === "strike" && <s>S</s>}
                  {format === "bullet" && <BulletIcon />}
                  {format === "task" && <TaskIcon />}
                </button>
              ))}
              {look === "hangar" && (
                <span
                  className={
                    saveState === "failed" || tooLarge ? "format-saved unsaved" : "format-saved"
                  }
                >
                  {savedText}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Under everything, so a notice or the formatting bar never pushes it out of place. */}
      <CursorFooter key="footer" store={cursor} language={language} />
    </div>
  );
}

/** The color dot of a swatch as a custom property (styles.css draws the dot). */
function dotStyle(color: NoteColor): Record<string, string> {
  return { "--dot": swatchColor(color) };
}
