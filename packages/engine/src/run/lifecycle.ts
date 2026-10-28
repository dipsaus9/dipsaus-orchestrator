// A run's state and its transitions (0002, 0020; DIPO-364): one pure function decides a run's
// next state from its state and an event. It does no I/O and reads no clock: every time it uses
// comes with the event. The runs writer (`records.ts`) reads the state, asks `nextRunState` and
// writes what it returns, so every change of `ended_at`, `end_kind`, `waiting`, `waiting_since`
// and `parked_ms` goes through here.
//
// A run is open while `endedAt` is null and ended otherwise. An open run may wait for its place
// (`waiting`, `places.ts`). An ended run's end kind says what it waits for: `in-review` for its
// review, `reviewed` for its checks and merge, a park's or a release's kind, or `done`, which
// never opens again. `parkedMs` is the time the run stood ended, in review or waiting, which its
// minute cap leaves out.

/** The fields of a `runs` row the transitions change. */
export interface RunState {
  readonly endedAt: number | null;
  readonly endKind: string | null;
  readonly waiting: string | null;
  readonly waitingSince: number | null;
  readonly parkedMs: number;
}

/** The end kind of a run whose story is Done; such a run never opens again. */
export const DONE_KIND = "done";

/** The end kind of a run ended at In Review that has no verdict yet. */
export const IN_REVIEW_KIND = "in-review";

/** What happens to a run. */
export type RunEvent =
  /** The run row is created. */
  | { readonly kind: "start" }
  /**
   * The run's active period ends at `at` as `endKind`. `reviewSince`, when given, is when the
   * review period that ends began; its time joins `parkedMs`.
   */
  | {
      readonly kind: "end";
      readonly at: number;
      readonly endKind: string;
      readonly reviewSince?: number;
    }
  /** The story is Done: an ended run whose outcome row is not final yet takes the end kind done. */
  | { readonly kind: "finish"; readonly final: boolean }
  /** An ended run opens again at `at`; the time it stood ended joins `parkedMs`. */
  | { readonly kind: "reopen"; readonly at: number }
  /**
   * An ended run takes the end kind `endKind` and stays ended; only from the end kind `from` when
   * given.
   */
  | { readonly kind: "relabel"; readonly endKind: string; readonly from?: string }
  /** An open run waits for its place as `as` from `since`. */
  | { readonly kind: "wait"; readonly as: string; readonly since: number }
  /**
   * A waiting run takes its place at `at`. The time it waited joins `parkedMs` when `counted`
   * (a developer session's wait); a review's wait leaves with the review's own time.
   */
  | { readonly kind: "take-place"; readonly at: number; readonly counted: boolean }
  /**
   * An open run whose start did not happen waits again as `as` from `since`, and the `counted`
   * milliseconds its taken place added to `parkedMs` are taken back.
   */
  | {
      readonly kind: "requeue";
      readonly as: string;
      readonly since: number;
      readonly counted: number;
    };

/** The state of a new run. */
const STARTED: RunState = {
  endedAt: null,
  endKind: null,
  waiting: null,
  waitingSince: null,
  parkedMs: 0,
};

/**
 * The next state of a run in `state` (null: no run yet) after `event`, or null when the event does
 * not apply to that state, so nothing is written.
 */
export function nextRunState(state: RunState | null, event: RunEvent): RunState | null {
  if (state === null) return event.kind === "start" ? STARTED : null;
  switch (event.kind) {
    case "start":
      return null;
    case "end":
      return ended(state, event);
    case "finish":
      return state.endedAt !== null && !event.final ? { ...state, endKind: DONE_KIND } : null;
    case "reopen":
      return reopened(state, event.at);
    case "relabel":
      return state.endedAt !== null && (event.from === undefined || state.endKind === event.from)
        ? { ...state, endKind: event.endKind }
        : null;
    case "wait":
      return state.endedAt === null
        ? { ...state, waiting: event.as, waitingSince: event.since }
        : null;
    case "take-place":
      return tookPlace(state, event.at, event.counted);
    case "requeue":
      return state.endedAt === null && state.waiting === null
        ? {
            ...state,
            waiting: event.as,
            waitingSince: event.since,
            parkedMs: Math.max(0, state.parkedMs - event.counted),
          }
        : null;
  }
}

function ended(state: RunState, event: Extract<RunEvent, { kind: "end" }>): RunState | null {
  if (state.endedAt !== null) return null;
  const review = event.reviewSince === undefined ? 0 : Math.max(0, event.at - event.reviewSince);
  return {
    endedAt: event.at,
    endKind: event.endKind,
    waiting: null,
    waitingSince: null,
    parkedMs: state.parkedMs + review,
  };
}

function reopened(state: RunState, at: number): RunState | null {
  if (state.endedAt === null || state.endKind === DONE_KIND) return null;
  return {
    ...state,
    endedAt: null,
    endKind: null,
    parkedMs: state.parkedMs + Math.max(0, at - state.endedAt),
  };
}

function tookPlace(state: RunState, at: number, counted: boolean): RunState | null {
  if (state.waiting === null) return null;
  const waited = counted ? Math.max(0, at - (state.waitingSince ?? at)) : 0;
  return { ...state, waiting: null, waitingSince: null, parkedMs: state.parkedMs + waited };
}
