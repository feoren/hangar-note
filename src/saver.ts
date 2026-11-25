// Debounced saving of a note (ADR 0001): 500 ms after the last keystroke, and at once on blur or
// close. At most one write runs at a time; text typed meanwhile is written right after, so the
// last version always reaches the disk and never an older one after a newer one.

export const SAVE_DELAY_MS = 500;

export type SaveState = "saved" | "pending" | "saving" | "failed";

export interface Saver {
  /** The text changed: write it after the quiet time. */
  change: (text: string) => void;
  /**
   * Write a pending change now. Resolves once everything typed so far is on disk (`true`) or the
   * write failed and the text is still pending (`false`).
   */
  flush: () => Promise<boolean>;
  /** Stop the timer; nothing pending is written any more. */
  dispose: () => void;
}

export interface SaverOptions {
  save: (text: string) => Promise<void>;
  onState?: (state: SaveState, error?: unknown) => void;
  delayMs?: number;
}

export function createSaver(options: SaverOptions): Saver {
  const delay = options.delayMs ?? SAVE_DELAY_MS;
  let pending: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let disposed = false;

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  // `change` may set `pending` while a write awaits; read it through this so the type checker
  // does not narrow it to the value before the await.
  const hasPending = () => pending !== null;

  const run = (): Promise<void> => {
    if (running) return running;
    running = (async () => {
      while (pending !== null && !disposed) {
        const text = pending;
        pending = null;
        options.onState?.("saving");
        try {
          await options.save(text);
          if (!hasPending()) options.onState?.("saved");
        } catch (error) {
          // Keep the text for the next attempt, unless newer text replaced it meanwhile.
          if (!hasPending()) pending = text;
          options.onState?.("failed", error);
          break;
        }
      }
    })().finally(() => {
      running = null;
    });
    return running;
  };

  return {
    change: (text) => {
      if (disposed) return;
      pending = text;
      options.onState?.("pending");
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        void run();
      }, delay);
    },
    flush: async () => {
      clearTimer();
      // A write in progress first, then whatever was typed while it ran.
      if (running) await running;
      if (pending !== null) await run();
      return !hasPending();
    },
    dispose: () => {
      disposed = true;
      clearTimer();
    },
  };
}
