// Leaving a note whose text cannot be saved (ADR 0001, "Leaving an unsaved note"). The first try
// keeps the note open and offers to copy its text; a second try within `LEAVE_ANYWAY_MS` leaves
// anyway, as "Quit" does in the backend (`QUIT_ANYWAY_WITHIN`), so a note that can never save
// cannot trap the person on it. Pure: the clock comes in from outside.

export const LEAVE_ANYWAY_MS = 10_000;

export interface LeaveAnyway {
  /**
   * A try to leave failed to save. `true`: it is the second within `LEAVE_ANYWAY_MS` of the
   * first, so leave without the text. `false`: the first, so stay and warn.
   */
  refused: () => boolean;
  /** A save worked or the note was left: the next refusal is a first one again. */
  reset: () => void;
}

export function createLeaveAnyway(now: () => number = () => Date.now()): LeaveAnyway {
  let refusedAt: number | null = null;
  return {
    refused: () => {
      const at = now();
      if (refusedAt !== null && at - refusedAt >= 0 && at - refusedAt < LEAVE_ANYWAY_MS) {
        refusedAt = null;
        return true;
      }
      refusedAt = at;
      return false;
    },
    reset: () => {
      refusedAt = null;
    },
  };
}
