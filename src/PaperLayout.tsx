// Look "paper" (direction B, ADR 0004): every note is a card in its own soft color, laid out in a
// grid like slips on a table; checklists can be ticked right on the card. Beside the sidebar
// (Sidebar.tsx) the search, "+" and the look switch sit at the top of the grid. A note opens, only
// by choice (paperSheet.ts), as a sheet over the grid (a modal dialog): Escape or the close button closes it, and the focus goes back to its
// card. While a sheet is open, notices float at its bottom (else at the window's, NotesArea.tsx).
// One column below 560 px (styles.css).

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { colorName, NOTE_COLORS, noteTone, toneVariables } from "./colors";
import { CheckIcon, CloseIcon, DesktopIcon, MoreIcon } from "./icons";
import { LookSwitch } from "./LookSwitch";
import {
  HeldPanel,
  ListMessages,
  ListTop,
  NotePage,
  OnDesktopPanel,
  PreviewToggle,
  RowMeta,
  UnsavedMark,
  Welcome,
} from "./NoteParts";
import { noteKey } from "./notes";
import { cardLines } from "./noteText";
import { dotStyle, type NotesModel, type Row } from "./useNotesArea";

/**
 * What can take the focus inside the sheet, for keeping Tab in it. Of the color radios only the
 * chosen one is a Tab stop, as Tab itself treats a radio group.
 */
const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]):not([type="radio"]), input[type="radio"]:checked, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Where a cut card body starts to fade out, in px from its top (`.card-body.is-cut`). */
const CARD_FADE_START = 156;

/**
 * The first line of a card body that lies beyond its edge, or `null` while everything fits. Only
 * a body that really overflows is cut (and fades out); in it, a line whose middle lies in the fade
 * or below is no longer shown, so its checkbox is no Tab stop.
 */
function firstCutLine(body: HTMLElement): number | null {
  if (body.scrollHeight <= body.clientHeight) return null;
  const lines = Array.from(body.children).filter((line) => line instanceof HTMLElement);
  const at = lines.findIndex((line) => line.offsetTop + line.offsetHeight / 2 > CARD_FADE_START);
  return at === -1 ? lines.length : at;
}

/** How many columns the card grid shows now, from its resolved tracks. */
function gridColumns(element: Element): number {
  const grid = element.closest(".paper-grid");
  if (grid === null) return 1;
  const tracks = getComputedStyle(grid).gridTemplateColumns.trim();
  return tracks === "" || tracks === "none" ? 1 : tracks.split(/\s+/).length;
}

export function PaperLayout({ m }: { m: NotesModel }) {
  const { t, note, emptyMode } = m;
  const sheet = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const openKey = note === null ? null : `${note.folder.path ?? ""}\n${note.id ?? ""}`;

  // A sheet that opens without the focus in it (a note on the desktop) takes it on its close
  // button, so the keyboard is never left behind on the hidden grid.
  useEffect(() => {
    if (openKey === null) return;
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!(active instanceof Node && sheet.current?.contains(active))) close.current?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [openKey]);

  const onSheetKey = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      void m.backToList();
      return;
    }
    if (event.key !== "Tab") return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (element) => !element.closest("[hidden]"),
    );
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className={emptyMode ? "notes-area layout-paper is-empty" : "notes-area layout-paper"}>
      <div className="paper-room" inert={note !== null}>
        <ListTop m={m} className="paper-top" end={<LookSwitch m={m} />} />
        {emptyMode ? (
          <Welcome m={m} mark={<PaperStack m={m} />} />
        ) : (
          <>
            <section className="paper-board" aria-label={t("notes.list")}>
              <ListMessages m={m} />
              <ul className="paper-grid">
                {m.visible.map((row, index) => (
                  <Card key={noteKey(row)} m={m} row={row} index={index} />
                ))}
              </ul>
            </section>
          </>
        )}
      </div>

      {note !== null && (
        <>
          <div className="paper-scrim" aria-hidden="true" onClick={() => void m.backToList()} />
          <section
            ref={sheet}
            className="note-pane paper-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={m.shownTitle === "" ? t("notes.noteLabel") : m.shownTitle}
            style={toneVariables(noteTone(note.color, m.theme))}
            onKeyDown={onSheetKey}
          >
            <div className="sheet-head">
              {note.id !== null && (
                <div className="sheet-colors" role="radiogroup" aria-label={t("notes.color")}>
                  {NOTE_COLORS.map((color) => {
                    const name = colorName(color, m.colorNames, t);
                    return (
                      <label key={color} className="sheet-swatch" title={name}>
                        <input
                          type="radio"
                          name="sheet-color"
                          aria-label={name}
                          checked={note.color === color}
                          onChange={() => {
                            m.pickOpenColor(color);
                          }}
                        />
                        <span className="swatch-dot" style={dotStyle(color)}>
                          {note.color === color && <CheckIcon size={12} />}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
              <span className="sheet-fill" />
              <UnsavedMark m={m} />
              <PreviewToggle m={m} />
              {note.id !== null && !note.onDesktop && (
                <button
                  type="button"
                  className="secondary-button sheet-desktop"
                  aria-label={t("notes.toDesktop")}
                  title={t("notes.toDesktopHint")}
                  onClick={() => void m.putOnDesktop()}
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
                aria-expanded={m.menuOpen("noteActions")}
                disabled={note.id === null}
                onClick={(event) => {
                  m.toggleMenu("noteActions", event);
                }}
              >
                <MoreIcon />
              </button>
              <button
                ref={close}
                type="button"
                className="icon-button"
                data-action="back"
                aria-label={t("notes.closeSheet")}
                title={t("notes.closeSheet")}
                onClick={() => void m.backToList()}
              >
                <CloseIcon />
              </button>
            </div>
            <HeldPanel m={m} />
            <OnDesktopPanel m={m} />
            <div className="note-body" hidden={note.onDesktop}>
              <NotePage m={m} />
            </div>
            <div className="notice-float sheet-notice">{m.noticeSlot}</div>
          </section>
        </>
      )}
    </div>
  );
}

/**
 * One note as a card: its title opens it as a sheet, its checklist can be ticked in place, its
 * tools (on the desktop, the note's menu) show on hover and focus. Only the current card is a Tab
 * stop; the arrow keys move between cards.
 */
function Card({ m, row, index }: { m: NotesModel; row: Row; index: number }) {
  const { t, writable } = m;
  const key = noteKey(row);
  const tabStop = key === m.rovingKey ? 0 : -1;
  const lines = row.preview === null ? [] : cardLines(row.preview, row.title);
  const canTick = writable && !row.onDesktop;
  const body = useRef<HTMLDivElement>(null);
  const [cutAt, setCutAt] = useState<number | null>(null);

  // Measured before the paint and again whenever the body changes its size (another width wraps
  // the lines differently); the fade itself changes no size, so measuring never loops.
  useLayoutEffect(() => {
    const element = body.current;
    if (element === null) return;
    const measure = () => {
      setCutAt(firstCutLine(element));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [row.preview, row.excerpt]);

  const bodyClass = cutAt === null ? "card-body" : "card-body is-cut";
  return (
    <li
      className="card"
      style={toneVariables(noteTone(row.color, m.theme))}
      onContextMenu={(event) => {
        m.onRowContextMenu(row, event);
      }}
    >
      <h2 className="card-title">
        <button
          type="button"
          className="note-row card-open"
          tabIndex={tabStop}
          ref={m.registerRow(key)}
          title={row.folder.path ?? t("notes.general")}
          onFocus={() => {
            m.setFocusKey(key);
          }}
          onClick={() => void m.openNote(row, !row.onDesktop)}
          onKeyDown={(event) => {
            m.onRowKeyDown(row, index, event, gridColumns(event.currentTarget));
          }}
        >
          <span className="note-row-title">{row.title}</span>
        </button>
      </h2>
      {lines.length > 0 ? (
        <div ref={body} className={bodyClass}>
          {lines.map((line, at) =>
            line.kind === "task" ? (
              <label
                key={`task-${String(line.line)}`}
                className={line.done ? "card-task done" : "card-task"}
                title={canTick ? undefined : t(row.onDesktop ? "notes.onDesktop" : "notes.task")}
              >
                <input
                  type="checkbox"
                  checked={line.done}
                  disabled={!canTick}
                  tabIndex={cutAt !== null && at >= cutAt ? -1 : tabStop}
                  onChange={() => {
                    m.toggleRowTask(row, line.line, line.source);
                  }}
                />
                <span>{line.text}</span>
              </label>
            ) : line.kind === "bullet" ? (
              <p key={`line-${String(at)}`} className="card-bullet">
                <span aria-hidden="true">{line.marker}</span>
                <span>{line.text}</span>
              </p>
            ) : (
              <p
                key={`line-${String(at)}`}
                className={line.kind === "heading" ? "card-heading" : "card-text"}
              >
                {line.text}
              </p>
            ),
          )}
        </div>
      ) : (
        row.excerpt !== "" && (
          <div ref={body} className={bodyClass}>
            <p className="card-text">{row.excerpt}</p>
          </div>
        )
      )}
      <div className="card-meta">
        <RowMeta m={m} row={row} />
      </div>
      <div className="card-tools">
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
        <button
          type="button"
          className="icon-button"
          tabIndex={tabStop}
          aria-label={t("notes.actionsFor", { title: row.title })}
          title={t("notes.more")}
          aria-haspopup="menu"
          aria-expanded={m.menuOpen("row", row)}
          onClick={(event) => {
            m.openRowMenu(row, event.currentTarget);
          }}
        >
          <MoreIcon />
        </button>
      </div>
    </li>
  );
}

/** The picture of the empty paper look: three slips on the table. */
function PaperStack({ m }: { m: NotesModel }) {
  return (
    <div className="paper-stack" aria-hidden="true">
      {(["mint", "lemon", "sky"] as const).map((color) => (
        <span key={color} style={toneVariables(noteTone(color, m.theme))} />
      ))}
    </div>
  );
}
