import { describe, expect, it } from "vitest";

import { captureStamp, relativeTime, shortTime } from "./format";

describe("relativeTime", () => {
  const now = Date.UTC(2026, 10, 26, 12, 0, 0);

  it("says how long ago within a week", () => {
    expect(relativeTime(now - 10_000, now, "en")).toBe("now");
    expect(relativeTime(now - 5 * 60_000, now, "en")).toBe("5 minutes ago");
    expect(relativeTime(now - 24 * 3_600_000, now, "en")).toBe("yesterday");
    // A time in the future counts as now.
    expect(relativeTime(now + 60_000, now, "en")).toBe("now");
  });

  it("names the date for older notes", () => {
    expect(relativeTime(Date.UTC(2026, 0, 5, 12), now, "en")).toBe("Jan 5");
    expect(relativeTime(Date.UTC(2024, 0, 5, 12), now, "en")).toBe("Jan 5, 2024");
  });

  it("formats a short time", () => {
    expect(shortTime(new Date(2026, 0, 1, 9, 5), "de")).toBe("09:05");
  });

  it("names day, month and time of a capture", () => {
    const stamp = captureStamp(new Date(2026, 10, 26, 9, 5), "de");
    expect(stamp).toContain("26.");
    expect(stamp).toContain("Nov");
    expect(stamp).toContain("09:05");
  });
});
