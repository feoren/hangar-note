// Times for the notes list, in the UI language via Intl, so no unit needs translating. Taken from
// Hangar's src/format.ts (MIT, same owner).

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * "just now", "5 minutes ago", "yesterday", up to a week; older times as a short date. `then` and
 * `now` in ms. A time in the future (clock skew, another machine) counts as now.
 */
export function relativeTime(then: number, now: number, language: string): string {
  const age = Math.max(0, now - then);
  const format = new Intl.RelativeTimeFormat(language, { numeric: "auto", style: "long" });
  if (age < MINUTE_MS) return format.format(0, "second");
  if (age < HOUR_MS) return format.format(-Math.floor(age / MINUTE_MS), "minute");
  if (age < DAY_MS) return format.format(-Math.floor(age / HOUR_MS), "hour");
  if (age < 7 * DAY_MS) return format.format(-Math.floor(age / DAY_MS), "day");
  const date = new Date(then);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(language, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(date);
}

/** "14:32" in the UI language, for the heading of captured text. */
export function shortTime(date: Date, language: string): string {
  return new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit" }).format(date);
}

/** "26. Nov., 14:32" in the UI language: when a captured text arrived, for its note's title. */
export function captureStamp(date: Date, language: string): string {
  return new Intl.DateTimeFormat(language, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
