import { describe, expect, it } from "vitest";

import { createLeaveAnyway, LEAVE_ANYWAY_MS } from "./leaveAnyway";

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("createLeaveAnyway", () => {
  it("stays on the first refusal and leaves on a second one within ten seconds", () => {
    const time = clock();
    const guard = createLeaveAnyway(time.now);
    expect(guard.refused()).toBe(false);
    time.advance(LEAVE_ANYWAY_MS - 1);
    expect(guard.refused()).toBe(true);
    // Left: the next note starts over.
    expect(guard.refused()).toBe(false);
  });

  it("counts a try after ten seconds as a first one again", () => {
    const time = clock();
    const guard = createLeaveAnyway(time.now);
    expect(guard.refused()).toBe(false);
    time.advance(LEAVE_ANYWAY_MS);
    expect(guard.refused()).toBe(false);
    time.advance(1);
    expect(guard.refused()).toBe(true);
  });

  it("forgets a refusal once a save worked", () => {
    const time = clock();
    const guard = createLeaveAnyway(time.now);
    expect(guard.refused()).toBe(false);
    guard.reset();
    time.advance(1);
    expect(guard.refused()).toBe(false);
  });

  it("does not leave when the clock went back", () => {
    const time = clock();
    const guard = createLeaveAnyway(time.now);
    expect(guard.refused()).toBe(false);
    time.advance(-1);
    expect(guard.refused()).toBe(false);
  });
});
