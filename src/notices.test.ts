import { describe, expect, it } from "vitest";

import {
  clearNotice,
  INFO_MS,
  noNotices,
  noticeLifetime,
  putNotice,
  shownNotice,
  type NoticeSlots,
} from "./notices";

const empty = noNotices<string>();

describe("the notice slot", () => {
  it("shows nothing at first", () => {
    expect(shownNotice(empty)).toBeNull();
  });

  it("replaces a notice with a new one of its kind", () => {
    const first = putNotice(empty, "info", "deleted A");
    const second = putNotice(first, "info", "deleted B");
    expect(shownNotice(second)).toEqual({ kind: "info", notice: "deleted B" });
  });

  it("ranks not saved before an error before an info", () => {
    let slots: NoticeSlots<string> = putNotice(empty, "unsaved", "not saved");
    slots = putNotice(slots, "error", "disk full");
    slots = putNotice(slots, "info", "copied");
    expect(shownNotice(slots)).toEqual({ kind: "unsaved", notice: "not saved" });
    slots = clearNotice(slots, "unsaved");
    expect(shownNotice(slots)).toEqual({ kind: "error", notice: "disk full" });
    slots = clearNotice(slots, "error");
    expect(shownNotice(slots)).toEqual({ kind: "info", notice: "copied" });
  });

  it("drops older notices of a lower rank when a higher one comes", () => {
    let slots = putNotice(empty, "info", "deleted A");
    slots = putNotice(slots, "error", "disk full");
    expect(slots.info).toBeNull();
    slots = putNotice(slots, "unsaved", "not saved");
    expect(slots.error).toBeNull();
    slots = clearNotice(slots, "unsaved");
    expect(shownNotice(slots)).toBeNull();
  });

  it("lets a timer clear only its own notice", () => {
    const first = putNotice(empty, "info", "deleted A");
    const second = putNotice(first, "info", "deleted B");
    expect(clearNotice(second, "info", "deleted A")).toBe(second);
    expect(shownNotice(clearNotice(second, "info", "deleted B"))).toBeNull();
    expect(clearNotice(empty, "error")).toBe(empty);
  });

  it("lets only an info go on its own", () => {
    expect(noticeLifetime("info")).toBe(INFO_MS);
    expect(INFO_MS).toBe(6000);
    expect(noticeLifetime("error")).toBeNull();
    expect(noticeLifetime("unsaved")).toBeNull();
  });
});
