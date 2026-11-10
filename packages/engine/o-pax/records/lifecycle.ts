// A run's state and its transitions (0002, 0020; DIPO-364, DIPO-373): one pure function decides a
// run's next state from its state and an event. It does no I/O and reads no clock: every time it
// uses comes with the event. The runs writer (`records.ts`) reads the state, asks `nextRunState`
// and writes what it returns, so every change of `ended_at`, `end_kind`, `waiting`,
// `waiting_since` and `parked_ms` goes through here.
//
// A run ends in one of three ways (0020): `done` (its story is Done), `parked` (with one of the
// eight reasons, kept on its park) or `dropped` (its story was dropped or discarded, or its start
// failed). Until then it is open. An open run is active while a session works or waits for its
// place (`waiting`, `run-state/places.ts`). At In Review its active period ends (`endedAt`), but
// the run stays open, in phase review, test or merge (its `phase` run steps), until its story is
// Done; a review, a fix round or a conflict hand-off makes it active again. `done` and `dropped`
// are final; a parked run reopens on resume, or stands open at In Review again when the
// maintainer's override or a resume with no session lifts the park. `parkedMs` is the time the run
// stood ended, at In Review or waiting, which its minute cap leaves out.

/** How a run ends (0020). */
export const RUN_ENDS = ["done", "parked", "dropped"] as const;
export type RunEnd = (typeof RUN_ENDS)[number];

/** The fields of a `runs` row the transitions change. */
export interface RunState {
  /**
   * When the run's last active period ended: at its end, or at In Review while it stays open.
   * Null while a session works or the run waits for its place.
   */
  readonly endedAt: number | null;
  /** How the run ended; null while it is open. */
  readonly ending: RunEnd | null;
  readonly waiting: string | null;
  readonly waitingSince: number | null;
  readonly parkedMs: number;
}

/** What happens to a run. */
export type RunEvent =
  /** The run row is created. */
  | { readonly kind: "start" }
  /**
   * The active run's active period ends at `at` at In Review; the run stays open. `reviewSince`,
   * when given, is when the review period that ends began; its time joins `parkedMs`.
   */
  | { readonly kind: "in-review"; readonly at: number; readonly reviewSince?: number }
  /**
   * The run ends as `ending`. An active run's active period ends at `at` (with `reviewSince` as
   * for `in-review`); a run open at In Review keeps the end of its last one. A parked run ends
   * again only as done or dropped; a run done or dropped never ends again.
   */
  | {
      readonly kind: "end";
      readonly at: number;
      readonly ending: RunEnd;
      readonly reviewSince?: number;
    }
  /**
   * A parked run, or one open at In Review, is active again at `at`; the time since its active
   * period ended joins `parkedMs`.
   */
  | { readonly kind: "reopen"; readonly at: number }
  /** A parked run's park is lifted with no session: it stands open at In Review again. */
  | { readonly kind: "unpark" }
  /** An active run waits for its place as `as` from `since`. */
  | { readonly kind: "wait"; readonly as: string; readonly since: number }
  /**
   * A waiting run takes its place at `at`. The time it waited joins `parkedMs` when `counted`
   * (a developer session's wait); a review's wait leaves with the review's own time.
   */
  | { readonly kind: "take-place"; readonly at: number; readonly counted: boolean }
  /**
   * An active run whose start did not happen waits again as `as` from `since`, and the `counted`
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
  ending: null,
  waiting: null,
  waitingSince: null,
  parkedMs: 0,
};

/** True when the run is open and active: a session works or it waits for its place. */
function active(state: RunState): boolean {
  return state.endedAt === null && state.ending === null;
}

/**
 * The next state of a run in `state` (null: no run yet) after `event`, or null when the event does
 * not apply to that state, so nothing is written.
 */
export function nextRunState(state: RunState | null, event: RunEvent): RunState | null {
  if (state === null) return event.kind === "start" ? STARTED : null;
  switch (event.kind) {
    case "start":
      return null;
    case "in-review":
      return active(state) ? periodEnded(state, event.at, event.reviewSince) : null;
    case "end":
      return ended(state, event);
    case "reopen":
      return reopened(state, event.at);
    case "unpark":
      return state.ending === "parked" && state.endedAt !== null
        ? { ...state, ending: null }
        : null;
    case "wait":
      return active(state) ? { ...state, waiting: event.as, waitingSince: event.since } : null;
    case "take-place":
      return tookPlace(state, event.at, event.counted);
    case "requeue":
      return active(state) && state.waiting === null
        ? {
            ...state,
            waiting: event.as,
            waitingSince: event.since,
            parkedMs: Math.max(0, state.parkedMs - event.counted),
          }
        : null;
  }
}

/** The active run's active period ended at `at`; a review period's time joins `parkedMs`. */
function periodEnded(state: RunState, at: number, reviewSince: number | undefined): RunState {
  const review = reviewSince === undefined ? 0 : Math.max(0, at - reviewSince);
  return {
    ...state,
    endedAt: at,
    waiting: null,
    waitingSince: null,
    parkedMs: state.parkedMs + review,
  };
}

function ended(state: RunState, event: Extract<RunEvent, { kind: "end" }>): RunState | null {
  if (active(state)) {
    return { ...periodEnded(state, event.at, event.reviewSince), ending: event.ending };
  }
  if (state.ending === null) return { ...state, ending: event.ending };
  if (state.ending === "parked" && event.ending !== "parked") {
    return { ...state, ending: event.ending };
  }
  return null;
}

function reopened(state: RunState, at: number): RunState | null {
  if (state.endedAt === null || (state.ending !== null && state.ending !== "parked")) return null;
  return {
    ...state,
    endedAt: null,
    ending: null,
    parkedMs: state.parkedMs + Math.max(0, at - state.endedAt),
  };
}

function tookPlace(state: RunState, at: number, counted: boolean): RunState | null {
  if (state.waiting === null) return null;
  const waited = counted ? Math.max(0, at - (state.waitingSince ?? at)) : 0;
  return { ...state, waiting: null, waitingSince: null, parkedMs: state.parkedMs + waited };
}
