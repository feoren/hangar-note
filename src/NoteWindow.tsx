// One sticky note in its own frameless window (ADR 0001): a header row as the drag region with
// "New note", the menu and "Close"; the Markdown editor; a slim formatting bar while the focus is
// anywhere in the note. Typing is saved 500 ms after the last keystroke, at once on blur and
// close, and before the backend deletes the note from "All notes" or quits.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  closeNote,
  createNote,
  deleteNote,
  MAX_NOTE_BYTES,
  noteFlushed,
  onCloseRequested,
  onDeleteRequested,
  onFlushRequested,
  openHub,
  readNote,
  setNoteColor,
  setNoteOnTop,
  utf8Bytes,
  windowReady,
  writeNote,
  type NoteMeta,
} from "./api";
import {
  colorLabelKey,
  NOTE_COLORS,
  noteTone,
  toneVariables,
  type NoteColor,
  type Theme,
} from "./colors";
import { createNoteEditor, type Format, type NoteEditor } from "./editor";
import { useT } from "./i18n";
import { BulletIcon, CheckIcon, CloseIcon, MoreIcon, PlusIcon, TaskIcon } from "./icons";
import { focusFirstItem, moveMenuFocus } from "./menuKeys";
import { createSaver, type SaveState } from "./saver";
import { currentPlatform, matchNoteShortcut, shortcutLabel, type NoteAction } from "./shortcuts";

interface Props {
  id: string;
  theme: Theme;
}

const PLATFORM = currentPlatform();

type KeyedAction = Exclude<NoteAction, "leave">;

const FORMATS: readonly (Format & KeyedAction)[] = ["bold", "italic", "strike", "bullet", "task"];

export function NoteWindow({ id, theme }: Props) {
  const t = useT();
  const [note, setNote] = useState<NoteMeta | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [tooLarge, setTooLarge] = useState(false);
  const [focused, setFocused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<NoteEditor | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const closing = useRef(false);
  const [saver] = useState(() =>
    createSaver({
      save: async (text) => {
        await writeNote(id, text);
      },
      onState: (state) => {
        setSaveState(state);
      },
    }),
  );
  // The editor gets its callbacks once; they read the current values through this.
  const latest = useRef({ t });
  useEffect(() => {
    latest.current = { t };
  });

  useEffect(() => {
    let cancelled = false;
    readNote(id)
      .then((content) => {
        const element = host.current;
        if (cancelled || !element) return;
        setNote(content);
        editor.current = createNoteEditor(element, {
          text: content.text,
          label: latest.current.t("note.editorLabel"),
          placeholder: latest.current.t("note.placeholder"),
          taskLabel: latest.current.t("note.task"),
          onChange: (text) => {
            const large = utf8Bytes(text) > MAX_NOTE_BYTES;
            setTooLarge(large);
            // The backend refuses it anyway; the last version that fits stays on disk.
            if (!large) saver.change(text);
          },
          onFocus: (has) => {
            if (!has) void saver.flush();
          },
        });
        // An empty note is there to be written in.
        if (content.text === "") editor.current.focus();
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      })
      .finally(() => {
        if (!cancelled) void windowReady().catch(() => null);
      });
    return () => {
      cancelled = true;
      editor.current?.destroy();
      editor.current = null;
    };
  }, [id, saver]);

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
    // A failed write (full disk, folder gone) keeps the window: closing it would throw away the
    // text that only exists here. The note shows "Not saved" and the user can retry.
    if (!(await saver.flush())) {
      closing.current = false;
      return;
    }
    try {
      await closeNote(id);
    } catch {
      closing.current = false;
    }
  }, [id, saver]);

  const remove = useCallback(async () => {
    setMenuOpen(false);
    // Saved first, so "Undo" in "All notes" brings back every word. A failed write keeps the note,
    // as on close: its text exists only here. "All notes", if it asked, learns why.
    if (!(await saver.flush())) {
      void noteFlushed(false).catch(() => null);
      return;
    }
    try {
      await deleteNote(id);
      // The window is gone now; a late blur must not write to a note in the trash.
      saver.dispose();
    } catch {
      // Not deleted: the note stays, and so does saving what is typed next.
    }
  }, [id, saver]);

  // Requests from the backend (windows.rs): Alt+F4, a delete from "All notes", quitting.
  useEffect(() => {
    const listeners = [
      onCloseRequested(id, () => {
        void close();
      }),
      onDeleteRequested(id, () => {
        void remove();
      }),
      onFlushRequested(id, () => {
        void saver
          .flush()
          .then((saved) => noteFlushed(saved))
          .catch(() => null);
      }),
    ].map((listening) => listening.catch(() => null));
    return () => {
      for (const listening of listeners) void listening.then((stop) => stop?.());
    };
  }, [id, close, remove, saver]);

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
      if (action === "newNote") void createNote().catch(() => null);
      else editor.current?.format(action);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
    };
  }, [menuOpen]);

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
    void setNoteColor(id, color)
      .then(setNote)
      .catch(() => null);
  };

  const toggleOnTop = () => {
    if (!note) return;
    void setNoteOnTop(id, !note.onTop)
      .then(setNote)
      .catch(() => null);
  };

  const color = note?.color ?? "lemon";
  const style = toneVariables(noteTone(color, theme));
  const withKeys = (label: string, action: KeyedAction) =>
    t("common.withShortcut", { label, keys: shortcutLabel(action, PLATFORM, t) });
  const formatLabel = (format: Format) => t(`format.${format}`);

  return (
    <div
      className="note"
      style={style}
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
      <header className="note-head" data-tauri-drag-region>
        <button
          type="button"
          className="icon-button"
          title={withKeys(t("note.new"), "newNote")}
          aria-label={t("note.new")}
          onClick={() => {
            void createNote().catch(() => null);
          }}
        >
          <PlusIcon />
        </button>
        <span className="note-head-fill" data-tauri-drag-region />
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
          ref={menu}
          className="note-menu"
          role="menu"
          aria-label={t("note.menu")}
          onKeyDown={(event) => {
            if (moveMenuFocus(event.currentTarget, event.key)) event.preventDefault();
          }}
        >
          <div className="swatches" role="group" aria-label={t("note.color")}>
            {NOTE_COLORS.map((option) => (
              <button
                key={option}
                type="button"
                role="menuitemradio"
                aria-checked={option === color}
                className="swatch"
                title={t(colorLabelKey(option))}
                aria-label={t(colorLabelKey(option))}
                style={{ background: noteTone(option, theme).header }}
                onClick={() => {
                  pickColor(option);
                }}
              >
                {option === color && <CheckIcon size={14} />}
              </button>
            ))}
          </div>
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
        </div>
      )}

      <div className="note-body" ref={host}>
        {loadFailed && <p className="note-message">{t("note.loadFailed")}</p>}
        {!note && !loadFailed && <p className="note-message muted">{t("note.loading")}</p>}
      </div>

      {(tooLarge || saveState === "failed") && (
        <p className="note-message note-error" role="status">
          {tooLarge ? t("note.tooLarge") : t("note.saveFailed")}
        </p>
      )}

      {focused && (
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
        </div>
      )}
    </div>
  );
}
