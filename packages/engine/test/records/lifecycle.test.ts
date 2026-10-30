// The run transition function (DIPO-364, DIPO-373): every state of a run against every event, with
// the next state each pair yields or null where the event does not apply. The table must name
// every pair. A run ends only done, parked or dropped, and a run at In Review stays open.

import { describe, expect, it } from "bun:test";

import { nextRunState, RUN_ENDS, type RunEvent, type RunState } from "../../src/records/lifecycle";

const OPEN: RunState = {
  endedAt: null,
  ending: null,
  waiting: null,
  waitingSince: null,
  parkedMs: 100,
};
const WAITING: RunState = { ...OPEN, waiting: "fix", waitingSince: 1_000 };
const IN_REVIEW: RunState = { ...OPEN, endedAt: 2_000 };
const PARKED: RunState = { ...IN_REVIEW, ending: "parked" };
const DONE: RunState = { ...IN_REVIEW, ending: "done" };
const DROPPED: RunState = { ...IN_REVIEW, ending: "dropped" };

const STATES = {
  none: null,
  open: OPEN,
  waiting: WAITING,
  inReview: IN_REVIEW,
  parked: PARKED,
  done: DONE,
  dropped: DROPPED,
} as const satisfies Record<string, RunState | null>;

const EVENTS = {
  start: { kind: "start" },
  inReview: { kind: "in-review", at: 5_000 },
  inReviewAfterReview: { kind: "in-review", at: 5_000, reviewSince: 4_000 },
  endParked: { kind: "end", at: 5_000, ending: "parked" },
  endDone: { kind: "end", at: 5_000, ending: "done" },
  endDropped: { kind: "end", at: 5_000, ending: "dropped" },
  endDoneAfterReview: { kind: "end", at: 5_000, ending: "done", reviewSince: 4_000 },
  reopen: { kind: "reopen", at: 5_000 },
  unpark: { kind: "unpark" },
  wait: { kind: "wait", as: "review", since: 5_000 },
  takePlace: { kind: "take-place", at: 5_000, counted: true },
  takePlaceUncounted: { kind: "take-place", at: 5_000, counted: false },
  requeue: { kind: "requeue", as: "fix", since: 1_000, counted: 50 },
} as const satisfies Record<string, RunEvent>;

type StateName = keyof typeof STATES;
type EventName = keyof typeof EVENTS;

/** A run whose active period ended at `at`: open at In Review, or ended as `ending`. */
const stopped = (at: number, ending: RunState["ending"], parkedMs = 100): RunState => ({
  endedAt: at,
  ending,
  waiting: null,
  waitingSince: null,
  parkedMs,
});

const NOTHING: Record<EventName, null> = {
  start: null,
  inReview: null,
  inReviewAfterReview: null,
  endParked: null,
  endDone: null,
  endDropped: null,
  endDoneAfterReview: null,
  reopen: null,
  unpark: null,
  wait: null,
  takePlace: null,
  takePlaceUncounted: null,
  requeue: null,
};

/** The next state of every pair; null where the event does not apply. */
const TABLE: Record<StateName, Record<EventName, RunState | null>> = {
  none: {
    ...NOTHING,
    start: { endedAt: null, ending: null, waiting: null, waitingSince: null, parkedMs: 0 },
  },
  open: {
    ...NOTHING,
    inReview: stopped(5_000, null),
    inReviewAfterReview: stopped(5_000, null, 1_100),
    endParked: stopped(5_000, "parked"),
    endDone: stopped(5_000, "done"),
    endDropped: stopped(5_000, "dropped"),
    endDoneAfterReview: stopped(5_000, "done", 1_100),
    wait: { ...OPEN, waiting: "review", waitingSince: 5_000 },
    requeue: { ...OPEN, waiting: "fix", waitingSince: 1_000, parkedMs: 50 },
  },
  waiting: {
    ...NOTHING,
    inReview: stopped(5_000, null),
    inReviewAfterReview: stopped(5_000, null, 1_100),
    endParked: stopped(5_000, "parked"),
    endDone: stopped(5_000, "done"),
    endDropped: stopped(5_000, "dropped"),
    endDoneAfterReview: stopped(5_000, "done", 1_100),
    wait: { ...OPEN, waiting: "review", waitingSince: 5_000 },
    takePlace: { ...OPEN, parkedMs: 4_100 },
    takePlaceUncounted: OPEN,
  },
  inReview: {
    ...NOTHING,
    endParked: PARKED,
    endDone: DONE,
    endDropped: DROPPED,
    endDoneAfterReview: DONE,
    reopen: { ...OPEN, parkedMs: 3_100 },
  },
  parked: {
    ...NOTHING,
    endDone: DONE,
    endDropped: DROPPED,
    endDoneAfterReview: DONE,
    reopen: { ...OPEN, parkedMs: 3_100 },
    unpark: IN_REVIEW,
  },
  done: NOTHING,
  dropped: NOTHING,
};

describe("nextRunState", () => {
  it("has a row for every state and a column for every event", () => {
    expect(Object.keys(TABLE).toSorted()).toEqual(Object.keys(STATES).toSorted());
    for (const row of Object.values(TABLE)) {
      expect(Object.keys(row).toSorted()).toEqual(Object.keys(EVENTS).toSorted());
    }
  });

  for (const state of Object.keys(STATES) as StateName[]) {
    for (const event of Object.keys(EVENTS) as EventName[]) {
      it(`${state} + ${event}`, () => {
        expect(nextRunState(STATES[state], EVENTS[event])).toEqual(TABLE[state][event]);
      });
    }
  }

  it("ends runs only as done, parked or dropped, and keeps an In Review run open in its phase", () => {
    expect([...RUN_ENDS]).toEqual(["done", "parked", "dropped"]);
    for (const state of Object.values(STATES)) {
      for (const event of Object.values(EVENTS)) {
        const next = nextRunState(state, event);
        if (next?.ending != null) expect(RUN_ENDS).toContain(next.ending);
      }
    }
    // At In Review the active period ends and the run stays open, until its story is Done.
    const inReview = nextRunState(OPEN, EVENTS.inReview);
    expect(inReview).toMatchObject({ endedAt: 5_000, ending: null });
    expect(nextRunState(inReview, EVENTS.endDone)).toMatchObject({
      endedAt: 5_000,
      ending: "done",
    });
    // Done and dropped are final: nothing reopens or ends them again.
    for (const final of [DONE, DROPPED]) {
      for (const event of Object.values(EVENTS)) expect(nextRunState(final, event)).toBeNull();
    }
  });

  it("never counts a negative time", () => {
    expect(nextRunState(IN_REVIEW, { kind: "reopen", at: 1_000 })?.parkedMs).toBe(100);
    expect(
      nextRunState(OPEN, { kind: "end", at: 1_000, ending: "parked", reviewSince: 2_000 })
        ?.parkedMs,
    ).toBe(100);
    expect(nextRunState(WAITING, { kind: "take-place", at: 500, counted: true })?.parkedMs).toBe(
      100,
    );
    expect(
      nextRunState(OPEN, { kind: "requeue", as: "fix", since: 1, counted: 500 })?.parkedMs,
    ).toBe(0);
  });

  it("does not change the state it is given", () => {
    const before = structuredClone(WAITING);
    nextRunState(WAITING, EVENTS.takePlace);
    expect(WAITING).toEqual(before);
  });
});
