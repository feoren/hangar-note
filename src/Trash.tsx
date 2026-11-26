// "Recently deleted": the trash of the shown scopes, newest first, with "Restore" per note. While
// the notes are read only it says why nothing can be restored instead of hiding the buttons
// silently; a failed load offers "Try again"; an empty trash says what it is for. Its rows look
// like the list's: the color as a 3 px edge, the time as the list says it. Escape goes back,
// wherever the focus is.

import { useCallback, useEffect, useRef, useState } from "react";

import { listTrash, type NoteFolder, type TrashRow } from "./api";
import type { AppSettings } from "./appSettings";
import { noteTone } from "./colors";
import { relativeTime } from "./format";
import { useT } from "./i18n";
import { BackIcon } from "./icons";

export interface TrashProps {
  folders: readonly NoteFolder[];
  mixed: boolean;
  language: string;
  now: number;
  theme: AppSettings["theme"];
  writable: boolean;
  projectLabel: (folder: NoteFolder) => string;
  onRestore: (folder: NoteFolder, id: string, title: string) => Promise<string | undefined>;
  onBack: () => void;
}

type Load = { state: "loading" } | { state: "failed" } | { state: "ready"; items: TrashRow[] };

export function Trash(props: TrashProps) {
  const { folders, mixed, language, now, theme, writable, projectLabel, onRestore, onBack } = props;
  const t = useT();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const back = useRef<HTMLButtonElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const key = folders.map((folder) => folder.path ?? "").join("|");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [onBack]);

  useEffect(() => {
    let live = true;
    Promise.all(folders.map((folder) => listTrash(folder)))
      .then((lists) => {
        if (!live) return;
        setLoad({
          state: "ready",
          items: lists.flat().sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0)),
        });
      })
      .catch(() => {
        if (live) setLoad({ state: "failed" });
      });
    return () => {
      live = false;
    };
    // `key` names the folders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  useEffect(() => {
    back.current?.focus();
  }, []);

  useEffect(() => {
    if (load.state === "failed") retryButton.current?.focus();
  }, [load.state]);

  const retry = useCallback(() => {
    setLoad({ state: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  const items = load.state === "ready" ? load.items : [];

  return (
    <>
      <header className="pane-head">
        <button
          ref={back}
          type="button"
          className="icon-button"
          aria-label={t("notes.back")}
          title={t("notes.back")}
          onClick={onBack}
        >
          <BackIcon />
        </button>
        <h1>{t("notes.trash")}</h1>
      </header>
      <div className="list-wrap single-wrap">
        {!writable && load.state === "ready" && items.length > 0 && (
          <p className="notes-message">{t("notes.trashReadOnly")}</p>
        )}
        {load.state === "failed" && (
          <div className="notes-empty" role="alert">
            <p>{t("notes.trashLoadFailed")}</p>
            <button ref={retryButton} type="button" className="secondary-button" onClick={retry}>
              {t("notes.retry")}
            </button>
          </div>
        )}
        {load.state === "ready" && items.length === 0 && (
          <div className="notes-empty">
            <p>{t("notes.trashEmpty")}</p>
            <button type="button" className="secondary-button" onClick={onBack}>
              {t("notes.backToNotes")}
            </button>
          </div>
        )}
        <ul className="trash-list">
          {items.map((item) => {
            const time = item.deletedAt === null ? "" : relativeTime(item.deletedAt, now, language);
            // The note's color as the same 3 px edge its row had in the list.
            const edge: Record<string, string> = {
              "--note-edge": noteTone(item.color, theme).edge,
            };
            return (
              <li
                key={`${item.folderKey}
${item.id}`}
                className="trash-row"
                style={edge}
              >
                <span className="trash-text">
                  <span className="note-row-title">{item.title}</span>
                  <span className="note-row-meta">
                    {mixed && (
                      <span className="note-row-project">{projectLabel({ path: item.path })}</span>
                    )}
                    {time !== "" && (
                      <span title={t("notes.deletedAgo", { time })}>
                        <span aria-hidden="true">{time}</span>
                        <span className="sr-only">{t("notes.deletedAgo", { time })}</span>
                      </span>
                    )}
                  </span>
                </span>
                {writable && (
                  <button
                    type="button"
                    className="secondary-button"
                    aria-label={t("notes.restoreNamed", { title: item.title })}
                    onClick={() => {
                      void onRestore({ path: item.path }, item.id, item.title).then((restored) => {
                        if (restored === undefined) return;
                        setLoad((old) =>
                          old.state === "ready"
                            ? { state: "ready", items: old.items.filter((row) => row !== item) }
                            : old,
                        );
                      });
                    }}
                  >
                    {t("notes.restore")}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}
