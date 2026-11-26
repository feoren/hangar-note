// The one notice place of the notes area, in its footer (notices.ts has the rules). An info goes
// after `INFO_MS`, but not while the pointer or the focus is on it; errors and "not saved" stay.
// Two live regions share the place: a polite one that is always there (an info), and an alert
// that appears with an error, so screen readers announce each as they should.

import { useEffect, useRef, useState } from "react";

import { useT } from "./i18n";
import { AlertIcon, CloseIcon, InfoIcon } from "./icons";
import { noticeLifetime, type NoticeKind } from "./notices";

export interface Notice {
  message: string;
  /** A second line, e.g. the result of "Copy as Markdown" inside a warning. */
  detail?: string | undefined;
  /** The one button that helps. */
  action?: { label: string; run: () => void } | undefined;
  /** Where an error came from: a save error goes once a save works again. */
  source?: "save" | undefined;
}

interface Props {
  shown: { kind: NoticeKind; notice: Notice } | null;
  onDismiss: (kind: NoticeKind, notice: Notice) => void;
}

export function NoticeSlot({ shown, onDismiss }: Props) {
  const t = useT();
  const [paused, setPaused] = useState(false);
  const dismiss = useRef(onDismiss);
  useEffect(() => {
    dismiss.current = onDismiss;
  });

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
      {item.action && (
        <button type="button" className="link-button" onClick={item.action.run}>
          {item.action.label}
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
    </>
  );

  const info = shown?.kind === "info" ? shown : null;
  const alert = shown !== null && shown.kind !== "info" ? shown : null;

  return (
    <div
      className={shown === null ? "notice-slot" : "notice-slot filled"}
      onMouseEnter={() => {
        setPaused(true);
      }}
      onMouseLeave={() => {
        setPaused(false);
      }}
      onFocus={() => {
        setPaused(true);
      }}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node && event.currentTarget.contains(next))) setPaused(false);
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
