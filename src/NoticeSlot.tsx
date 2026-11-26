// The one notice place of the notes area, in its footer (notices.ts has the rules). An info goes
// after `INFO_MS`, but not while the pointer or the focus is on it; errors and "not saved" stay.
// Two live regions share the place: a polite one that is always there (an info), and an alert
// that appears with an error, so screen readers announce each as they should. When a notice goes
// while one of its buttons has the focus, the window gives the focus a new place (`onFocusLost`),
// so it never falls back to the page.

import { useEffect, useRef, useState } from "react";

import { useT } from "./i18n";
import { AlertIcon, CloseIcon, InfoIcon } from "./icons";
import { noticeLifetime, type NoticeKind } from "./notices";

export interface NoticeAction {
  label: string;
  run: () => void;
}

export interface Notice {
  message: string;
  /** A second line, e.g. the result of "Copy as Markdown" inside a warning. */
  detail?: string | undefined;
  /** The button that helps. */
  action?: NoticeAction | undefined;
  /** A second way out, where one button is not enough (a note changed outside). */
  secondAction?: NoticeAction | undefined;
  /** Where an error came from: a save error goes once a save works again. */
  source?: "save" | undefined;
}

interface Props {
  shown: { kind: NoticeKind; notice: Notice } | null;
  onDismiss: (kind: NoticeKind, notice: Notice) => void;
  /** The focus was on the notice that just went. */
  onFocusLost?: (() => void) | undefined;
}

export function NoticeSlot({ shown, onDismiss, onFocusLost }: Props) {
  const t = useT();
  const [paused, setPaused] = useState(false);
  const dismiss = useRef(onDismiss);
  const lost = useRef(onFocusLost);
  useEffect(() => {
    dismiss.current = onDismiss;
    lost.current = onFocusLost;
  });
  const slot = useRef<HTMLDivElement>(null);
  /** The focus is on one of the notice's buttons (a removed button may not report its blur). */
  const focusInside = useRef(false);

  // The notice itself is the timer's key: a re-render of the window does not restart it.
  const kind = shown?.kind ?? null;
  const notice = shown?.notice ?? null;
  useEffect(() => {
    if (kind === null || notice === null || paused) return;
    const lifetime = noticeLifetime(kind);
    if (lifetime === null) return;
    const timer = window.setTimeout(() => {
      dismiss.current(kind, notice);
    }, lifetime);
    return () => {
      window.clearTimeout(timer);
    };
  }, [kind, notice, paused]);

  useEffect(() => {
    if (!focusInside.current) return;
    const active = document.activeElement;
    if (active instanceof Node && slot.current?.contains(active)) return;
    focusInside.current = false;
    setPaused(false);
    // Only a focus that fell to the page is moved; one the person put elsewhere stays there.
    if (active === null || active === document.body) lost.current?.();
  }, [kind, notice]);

  const body = (which: NoticeKind, item: Notice) => (
    <>
      <span className="notice-icon" aria-hidden="true">
        {which === "info" ? <InfoIcon /> : <AlertIcon />}
      </span>
      <p className="notice-text">
        {item.message}
        {item.detail !== undefined && (
          <>
            {" "}
            <span className="notice-detail">{item.detail}</span>
          </>
        )}
      </p>
      {/* The buttons stay together: short of room, they move under the sentence as one row. */}
      <span className="notice-actions">
        {item.action && (
          <button type="button" className="link-button" onClick={item.action.run}>
            {item.action.label}
          </button>
        )}
        {item.secondAction && (
          <button type="button" className="link-button" onClick={item.secondAction.run}>
            {item.secondAction.label}
          </button>
        )}
        {which !== "unsaved" && (
          <button
            type="button"
            className="icon-button"
            aria-label={t("notes.dismiss")}
            title={t("notes.dismiss")}
            onClick={() => {
              onDismiss(which, item);
            }}
          >
            <CloseIcon size={12} />
          </button>
        )}
      </span>
    </>
  );

  const info = shown?.kind === "info" ? shown : null;
  const alert = shown !== null && shown.kind !== "info" ? shown : null;

  return (
    <div
      ref={slot}
      className={shown === null ? "notice-slot" : "notice-slot filled"}
      onMouseEnter={() => {
        setPaused(true);
      }}
      onMouseLeave={() => {
        setPaused(false);
      }}
      onFocus={() => {
        focusInside.current = true;
        setPaused(true);
      }}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        // No next element: the button went away with its notice, or the window lost the focus.
        if (next !== null) focusInside.current = false;
        setPaused(false);
      }}
    >
      <div role="status" className={info === null ? "notice-live" : "notice-live toast"}>
        {info !== null && body(info.kind, info.notice)}
      </div>
      {alert !== null && (
        <div
          role="alert"
          className={
            alert.kind === "unsaved" ? "notice notes-error notes-stuck" : "notice notes-error"
          }
        >
          {body(alert.kind, alert.notice)}
        </div>
      )}
    </div>
  );
}
