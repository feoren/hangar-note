// "All notes" (ADR 0001): search, the notes as cards, "New note", deleting with "Undo", the
// "Recently deleted" view with "Restore", and a small settings view.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  createNote,
  deleteNote,
  isNotSaved,
  listNotes,
  listTrash,
  onNotesChanged,
  openNote,
  restoreNote,
  setAutostart,
  setSettings,
  windowReady,
  type NoteSummary,
  type Settings,
  type ThemeSetting,
  type TrashItem,
} from "./api";
import type { AppSettings } from "./appSettings";
import { colorLabelKey, NOTE_COLORS, noteTone, toneVariables, type Theme } from "./colors";
import { LANGUAGE_NAMES, LANGUAGES, useT, type Language, type MessageKey } from "./i18n";
import { BackIcon, CheckIcon, MoreIcon, PlusIcon, SearchIcon } from "./icons";
import { moveMenuFocus } from "./menuKeys";
import { fitMenu } from "./menuPlacement";
import { filterNotes, noteExcerpt, noteTitle } from "./noteText";

/** How long "Undo" stays after a delete. */
const UNDO_MS = 8000;

type View = "notes" | "trash" | "settings";

interface Undo {
  id: string;
  /** Reopen the note's window on undo: it was on the desktop. */
  wasOpen: boolean;
}

interface CardMenu {
  note: NoteSummary;
  x: number;
  y: number;
  /** Gets the focus back when the menu closes with Escape. */
  trigger: HTMLElement;
}

const THEMES: readonly { value: ThemeSetting; label: MessageKey }[] = [
  { value: "system", label: "settings.themeSystem" },
  { value: "light", label: "settings.themeLight" },
  { value: "dark", label: "settings.themeDark" },
];

function formatDate(ms: number, language: Language): string {
  if (ms <= 0) return "";
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(ms),
  );
}

export function Hub({ app }: { app: AppSettings }) {
  const t = useT();
  const { theme, language } = app;
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [actionError, setActionError] = useState<MessageKey | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("notes");
  const [undo, setUndo] = useState<Undo | null>(null);
  const [menu, setMenu] = useState<CardMenu | null>(null);
  const menuElement = useRef<HTMLDivElement>(null);
  const shown = useRef(false);

  const reload = useCallback(
    () =>
      listNotes()
        .then((list) => {
          setNotes(list);
          setFailed(false);
        })
        .catch(() => {
          setFailed(true);
        })
        .finally(() => {
          if (!shown.current) {
            shown.current = true;
            void windowReady().catch(() => null);
          }
        }),
    [],
  );

  useEffect(() => {
    void reload();
    const unlisten = onNotesChanged(() => {
      void reload();
    }).catch(() => null);
    return () => {
      void unlisten.then((stop) => stop?.());
    };
  }, [reload]);

  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => {
      setUndo(null);
    }, UNDO_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [undo]);

  useEffect(() => {
    if (!menu) return;
    const close = () => {
      setMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      menu.trigger.focus();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  // The menu opens at the pointer or below the "more" button; near the window's edge it is moved
  // back inside, measured before the first paint so it never shows cut off.
  useLayoutEffect(() => {
    const element = menuElement.current;
    if (!menu || !element) return;
    const { width, height } = element.getBoundingClientRect();
    const place = fitMenu(
      { x: menu.x, y: menu.y },
      { width, height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    element.style.left = `${String(place.x)}px`;
    element.style.top = `${String(place.y)}px`;
  }, [menu]);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    try {
      await action();
      setActionError(null);
    } catch (error) {
      // Only deleting an open note that could not save has its own message.
      setActionError(isNotSaved(error) ? "hub.notSaved" : "hub.actionFailed");
    }
  }, []);

  const remove = (note: NoteSummary) => {
    setMenu(null);
    void run(async () => {
      await deleteNote(note.id);
      setUndo({ id: note.id, wasOpen: note.open });
      await reload();
    });
  };

  const undoDelete = (item: Undo) => {
    setUndo(null);
    void run(async () => {
      await restoreNote(item.id);
      if (item.wasOpen) await openNote(item.id);
      await reload();
    });
  };

  const visible = useMemo(() => filterNotes(notes ?? [], query), [notes, query]);

  return (
    <div className="hub">
      {view === "notes" && (
        <>
          <header className="hub-head">
            <h1>{t("hub.title")}</h1>
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                void run(createNote);
              }}
            >
              <PlusIcon />
              {t("hub.new")}
            </button>
          </header>
          <label className="search">
            <SearchIcon />
            <input
              type="search"
              value={query}
              placeholder={t("hub.search")}
              aria-label={t("hub.search")}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
          </label>
          <main className="hub-main">
            {failed && <p className="hub-message error-text">{t("hub.loadFailed")}</p>}
            {notes?.length === 0 && <p className="hub-message">{t("hub.empty")}</p>}
            {notes !== null && notes.length > 0 && visible.length === 0 && (
              <p className="hub-message">{t("hub.noMatches", { query: query.trim() })}</p>
            )}
            <ul className="cards">
              {visible.map((note) => (
                <NoteCard
                  key={note.id}
                  note={note}
                  theme={theme}
                  language={language}
                  onOpen={() => {
                    void run(() => openNote(note.id));
                  }}
                  onMenu={(x, y, trigger) => {
                    setMenu({ note, x, y, trigger });
                  }}
                  onDelete={() => {
                    remove(note);
                  }}
                />
              ))}
            </ul>
          </main>
        </>
      )}

      {view === "trash" && (
        <Trash
          theme={theme}
          language={language}
          onBack={() => {
            setView("notes");
          }}
          onRestored={() => {
            void reload();
          }}
        />
      )}

      {view === "settings" && (
        <SettingsView
          app={app}
          onBack={() => {
            setView("notes");
          }}
        />
      )}

      {actionError && (
        <p className="hub-message error-text" role="alert">
          {t(actionError)}
        </p>
      )}

      {undo && (
        <div className="toast" role="status">
          <span>{t("hub.deleted")}</span>
          <button
            type="button"
            className="link-button"
            onClick={() => {
              undoDelete(undo);
            }}
          >
            {t("hub.undo")}
          </button>
        </div>
      )}

      {view === "notes" && (
        <footer className="hub-foot">
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setView("trash");
            }}
          >
            {t("hub.trash")}
          </button>
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setView("settings");
            }}
          >
            {t("hub.settings")}
          </button>
        </footer>
      )}

      {menu && (
        <div
          ref={menuElement}
          className="card-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(event) => {
            event.stopPropagation();
          }}
          onKeyDown={(event) => {
            if (moveMenuFocus(event.currentTarget, event.key)) event.preventDefault();
          }}
        >
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            autoFocus
            onClick={() => {
              const id = menu.note.id;
              setMenu(null);
              void run(() => openNote(id));
            }}
          >
            {t("hub.open")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item danger"
            onClick={() => {
              remove(menu.note);
            }}
          >
            {t("hub.delete")}
          </button>
        </div>
      )}
    </div>
  );
}

interface CardProps {
  note: NoteSummary;
  theme: Theme;
  language: Language;
  onOpen: () => void;
  onMenu: (x: number, y: number, trigger: HTMLElement) => void;
  onDelete: () => void;
}

function NoteCard({ note, theme, language, onOpen, onMenu, onDelete }: CardProps) {
  const t = useT();
  const title = noteTitle(note.preview);
  const excerpt = noteExcerpt(note.preview);
  const label = title ?? t("hub.untitled");
  return (
    <li className="card" style={toneVariables(noteTone(note.color, theme))}>
      <button
        type="button"
        className="card-open"
        onClick={onOpen}
        onContextMenu={(event) => {
          event.preventDefault();
          onMenu(event.clientX, event.clientY, event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (event.key === "Delete") {
            event.preventDefault();
            onDelete();
          }
        }}
      >
        <span className={title ? "card-title" : "card-title muted"}>{label}</span>
        {excerpt !== "" && <span className="card-excerpt">{excerpt}</span>}
        <span className="card-date">{formatDate(note.updatedAt, language)}</span>
      </button>
      <button
        type="button"
        className="icon-button card-more"
        title={t("hub.more", { title: label })}
        aria-label={t("hub.more", { title: label })}
        aria-haspopup="menu"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          onMenu(rect.left, rect.bottom + 4, event.currentTarget);
        }}
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
      >
        <MoreIcon />
      </button>
    </li>
  );
}

interface TrashProps {
  theme: Theme;
  language: Language;
  onBack: () => void;
  onRestored: () => void;
}

function Trash({ theme, language, onBack, onRestored }: TrashProps) {
  const t = useT();
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(
    () =>
      listTrash()
        .then((list) => {
          setItems(list);
          setFailed(false);
        })
        .catch(() => {
          setFailed(true);
        }),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const restore = (id: string) => {
    void (async () => {
      try {
        await restoreNote(id);
        onRestored();
        await load();
      } catch {
        setFailed(true);
      }
    })();
  };

  return (
    <>
      <header className="hub-head">
        <button type="button" className="icon-button" aria-label={t("hub.back")} onClick={onBack}>
          <BackIcon />
        </button>
        <h1>{t("hub.trash")}</h1>
      </header>
      <main className="hub-main">
        {failed && <p className="hub-message error-text">{t("hub.actionFailed")}</p>}
        {items?.length === 0 && <p className="hub-message">{t("hub.trashEmpty")}</p>}
        <ul className="trash-list">
          {items?.map((item) => (
            <li
              key={item.id}
              className="trash-item"
              style={toneVariables(noteTone(item.color, theme))}
            >
              <span className="trash-text">
                <span className="card-title">{noteTitle(item.preview) ?? t("hub.untitled")}</span>
                <span className="card-date">
                  {t("hub.deletedAt", { date: formatDate(item.deletedAt, language) })}
                </span>
              </span>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  restore(item.id);
                }}
              >
                {t("hub.restore")}
              </button>
            </li>
          ))}
        </ul>
      </main>
    </>
  );
}

function SettingsView({ app, onBack }: { app: AppSettings; onBack: () => void }) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  const { settings, theme, applySaved, applyAutostart } = app;
  if (!settings) return null;

  const save = (change: Partial<Settings>) => {
    const next: Settings = {
      language: settings.language,
      theme: settings.theme,
      newNoteColor: settings.newNoteColor,
      ...change,
    };
    setSettings(next)
      .then((saved) => {
        applySaved(saved);
        setFailed(false);
      })
      .catch(() => {
        setFailed(true);
      });
  };

  return (
    <>
      <header className="hub-head">
        <button type="button" className="icon-button" aria-label={t("hub.back")} onClick={onBack}>
          <BackIcon />
        </button>
        <h1>{t("hub.settings")}</h1>
      </header>
      <main className="hub-main settings">
        <label className="field">
          <span>{t("settings.language")}</span>
          <select
            value={settings.language ?? ""}
            onChange={(event) => {
              const value = LANGUAGES.find((code) => code === event.target.value) ?? null;
              save({ language: value });
            }}
          >
            <option value="">{t("settings.languageSystem")}</option>
            {LANGUAGES.map((code) => (
              <option key={code} value={code}>
                {LANGUAGE_NAMES[code]}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="field">
          <legend>{t("settings.theme")}</legend>
          <div className="segmented">
            {THEMES.map(({ value, label }) => (
              <label key={value} className={settings.theme === value ? "selected" : ""}>
                <input
                  type="radio"
                  name="theme"
                  value={value}
                  checked={settings.theme === value}
                  onChange={() => {
                    save({ theme: value });
                  }}
                />
                {t(label)}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="field">
          <legend>{t("settings.newNoteColor")}</legend>
          <div className="swatches" role="radiogroup">
            {NOTE_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                role="radio"
                aria-checked={settings.newNoteColor === color}
                className="swatch"
                title={t(colorLabelKey(color))}
                aria-label={t(colorLabelKey(color))}
                style={{ background: noteTone(color, theme).header }}
                onClick={() => {
                  save({ newNoteColor: color });
                }}
              >
                {settings.newNoteColor === color && <CheckIcon size={14} />}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="check-field">
          <input
            type="checkbox"
            checked={settings.autostart}
            onChange={(event) => {
              const enabled = event.target.checked;
              setAutostart(enabled)
                .then((now) => {
                  applyAutostart(now);
                  setFailed(false);
                })
                .catch(() => {
                  setFailed(true);
                });
            }}
          />
          {t("settings.autostart")}
        </label>

        {failed && <p className="hub-message error-text">{t("hub.actionFailed")}</p>}
      </main>
    </>
  );
}
