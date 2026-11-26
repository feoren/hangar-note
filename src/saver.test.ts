import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSaver, SAVE_DELAY_MS, type SaveState } from "./saver";

describe("createSaver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes the last text once, 500 ms after the last keystroke", async () => {
    const save = vi.fn(() => Promise.resolve());
    const saver = createSaver({ save });
    saver.change("a");
    await vi.advanceTimersByTimeAsync(300);
    saver.change("ab");
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS - 1);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("ab");
  });

  it("writes at once on flush and not again afterwards", async () => {
    const save = vi.fn(() => Promise.resolve());
    const saver = createSaver({ save });
    saver.change("typed");
    await saver.flush();
    expect(save).toHaveBeenCalledWith("typed");
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS * 2);
    expect(save).toHaveBeenCalledTimes(1);
    // Nothing pending: nothing to write.
    await saver.flush();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("never writes an older text after a newer one", async () => {
    const written: string[] = [];
    let release: () => void = () => undefined;
    const save = vi.fn(
      (text: string) =>
        new Promise<void>((resolve) => {
          release = () => {
            written.push(text);
            resolve();
          };
        }),
    );
    const saver = createSaver({ save });
    saver.change("one");
    const first = saver.flush();
    // Typed while the first write runs.
    saver.change("one two");
    const second = saver.flush();
    release();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await Promise.all([first, second]);
    expect(written).toEqual(["one", "one two"]);
  });

  it("keeps the text after a failed write for the next attempt", async () => {
    const states: SaveState[] = [];
    const save = vi
      .fn<(text: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
    const saver = createSaver({ save, onState: (state) => states.push(state) });
    saver.change("keep me");
    // `false` tells the note window not to close: the text is not on disk yet.
    expect(await saver.flush()).toBe(false);
    expect(states.at(-1)).toBe("failed");
    expect(await saver.flush()).toBe(true);
    expect(save).toHaveBeenLastCalledWith("keep me");
    expect(states.at(-1)).toBe("saved");
  });

  it("stops after dispose", async () => {
    const save = vi.fn(() => Promise.resolve());
    const saver = createSaver({ save });
    saver.change("x");
    saver.dispose();
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS * 2);
    saver.change("y");
    await saver.flush();
    expect(save).not.toHaveBeenCalled();
  });

  it("forgets a pending text on discard and saves what is typed after it", async () => {
    const save = vi.fn(() => Promise.resolve());
    const saver = createSaver({ save });
    saver.change("refused");
    saver.discard();
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS * 2);
    expect(await saver.flush()).toBe(true);
    expect(save).not.toHaveBeenCalled();
    saver.change("after reload");
    await saver.flush();
    expect(save).toHaveBeenCalledWith("after reload");
  });
});
