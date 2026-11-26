// The one place for notices in the notes area (direction A): a slot in the footer, never two
// notices on top of each other and never one floating over text or buttons. Pure, so the rules
// are testable:
//
// - One slot per kind: a new notice replaces the old one of its kind.
// - Rank: "text not saved" before an error before an info. The highest kind present is shown.
// - A new notice drops older notices of a lower rank (they are stale now); a new one of a lower
//   rank waits behind a higher one and shows once that one is gone.
// - An info goes after `INFO_MS` (the timer pauses while the pointer or the focus is on it);
//   errors and "not saved" stay until they are fixed or dismissed.

export type NoticeKind = "unsaved" | "error" | "info";

export const NOTICE_KINDS: readonly NoticeKind[] = ["unsaved", "error", "info"];

export const NOTICE_RANK: Readonly<Record<NoticeKind, number>> = {
  unsaved: 3,
  error: 2,
  info: 1,
};

/** How long an info stays. */
export const INFO_MS = 6000;

export type NoticeSlots<T> = Readonly<Record<NoticeKind, T | null>>;

export function noNotices<T>(): NoticeSlots<T> {
  return { unsaved: null, error: null, info: null };
}

/** `notice` takes the slot of `kind` and drops older notices of a lower rank. */
export function putNotice<T>(slots: NoticeSlots<T>, kind: NoticeKind, notice: T): NoticeSlots<T> {
  const next: Record<NoticeKind, T | null> = { ...slots, [kind]: notice };
  for (const other of NOTICE_KINDS) {
    if (NOTICE_RANK[other] < NOTICE_RANK[kind]) next[other] = null;
  }
  return next;
}

/** Empties the slot of `kind`, or only when it still holds `notice` (a timer's own notice). */
export function clearNotice<T>(
  slots: NoticeSlots<T>,
  kind: NoticeKind,
  notice?: T,
): NoticeSlots<T> {
  if (slots[kind] === null) return slots;
  if (notice !== undefined && slots[kind] !== notice) return slots;
  return { ...slots, [kind]: null };
}

/** The notice the slot shows: the one of the highest rank, `null` when there is none. */
export function shownNotice<T>(slots: NoticeSlots<T>): { kind: NoticeKind; notice: T } | null {
  for (const kind of NOTICE_KINDS) {
    const notice = slots[kind];
    if (notice !== null) return { kind, notice };
  }
  return null;
}

/** How long a notice of `kind` stays on its own, `null` for "until fixed or dismissed". */
export function noticeLifetime(kind: NoticeKind): number | null {
  return kind === "info" ? INFO_MS : null;
}
