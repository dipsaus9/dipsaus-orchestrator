// The run transition function (DIPO-364): every state of a run against every event, with the next
// state each pair yields or null where the event does not apply. The table must name every pair.

import { describe, expect, it } from "bun:test";

import {
  DONE_KIND,
  IN_REVIEW_KIND,
  nextRunState,
  type RunEvent,
  type RunState,
} from "../../src/run/lifecycle";

const OPEN: RunState = {
  endedAt: null,
  endKind: null,
  waiting: null,
  waitingSince: null,
  parkedMs: 100,
};
const WAITING: RunState = { ...OPEN, waiting: "fix", waitingSince: 1_000 };
const IN_REVIEW: RunState = { ...OPEN, endedAt: 2_000, endKind: IN_REVIEW_KIND };
const REVIEWED: RunState = { ...OPEN, endedAt: 2_000, endKind: "reviewed" };
const PARKED: RunState = { ...OPEN, endedAt: 2_000, endKind: "interrupted" };
const DONE: RunState = { ...OPEN, endedAt: 2_000, endKind: DONE_KIND };

const STATES = {
  none: null,
  open: OPEN,
  waiting: WAITING,
  inReview: IN_REVIEW,
  reviewed: REVIEWED,
  parked: PARKED,
  done: DONE,
} as const satisfies Record<string, RunState | null>;

const EVENTS = {
  start: { kind: "start" },
  end: { kind: "end", at: 5_000, endKind: "parked-x" },
  endReview: { kind: "end", at: 5_000, endKind: "reviewed", reviewSince: 4_000 },
  finish: { kind: "finish", final: false },
  finishFinal: { kind: "finish", final: true },
  reopen: { kind: "reopen", at: 5_000 },
  relabel: { kind: "relabel", endKind: "reviewed" },
  relabelFromInReview: { kind: "relabel", endKind: "reviewed", from: IN_REVIEW_KIND },
  wait: { kind: "wait", as: "review", since: 5_000 },
  takePlace: { kind: "take-place", at: 5_000, counted: true },
  takePlaceUncounted: { kind: "take-place", at: 5_000, counted: false },
  requeue: { kind: "requeue", as: "fix", since: 1_000, counted: 50 },
} as const satisfies Record<string, RunEvent>;

type StateName = keyof typeof STATES;
type EventName = keyof typeof EVENTS;

const ended = (at: number, endKind: string, parkedMs = 100): RunState => ({
  endedAt: at,
  endKind,
  waiting: null,
  waitingSince: null,
  parkedMs,
});

/** The next state of every pair; null where the event does not apply. */
const TABLE: Record<StateName, Record<EventName, RunState | null>> = {
  none: {
    start: { endedAt: null, endKind: null, waiting: null, waitingSince: null, parkedMs: 0 },
    end: null,
    endReview: null,
    finish: null,
    finishFinal: null,
    reopen: null,
    relabel: null,
    relabelFromInReview: null,
    wait: null,
    takePlace: null,
    takePlaceUncounted: null,
    requeue: null,
  },
  open: {
    start: null,
    end: ended(5_000, "parked-x"),
    endReview: ended(5_000, "reviewed", 1_100),
    finish: null,
    finishFinal: null,
    reopen: null,
    relabel: null,
    relabelFromInReview: null,
    wait: { ...OPEN, waiting: "review", waitingSince: 5_000 },
    takePlace: null,
    takePlaceUncounted: null,
    requeue: { ...OPEN, waiting: "fix", waitingSince: 1_000, parkedMs: 50 },
  },
  waiting: {
    start: null,
    end: ended(5_000, "parked-x"),
    endReview: ended(5_000, "reviewed", 1_100),
    finish: null,
    finishFinal: null,
    reopen: null,
    relabel: null,
    relabelFromInReview: null,
    wait: { ...OPEN, waiting: "review", waitingSince: 5_000 },
    takePlace: { ...OPEN, parkedMs: 4_100 },
    takePlaceUncounted: OPEN,
    requeue: null,
  },
  inReview: {
    start: null,
    end: null,
    endReview: null,
    finish: { ...IN_REVIEW, endKind: DONE_KIND },
    finishFinal: null,
    reopen: { ...OPEN, parkedMs: 3_100 },
    relabel: REVIEWED,
    relabelFromInReview: REVIEWED,
    wait: null,
    takePlace: null,
    takePlaceUncounted: null,
    requeue: null,
  },
  reviewed: {
    start: null,
    end: null,
    endReview: null,
    finish: { ...REVIEWED, endKind: DONE_KIND },
    finishFinal: null,
    reopen: { ...OPEN, parkedMs: 3_100 },
    relabel: REVIEWED,
    relabelFromInReview: null,
    wait: null,
    takePlace: null,
    takePlaceUncounted: null,
    requeue: null,
  },
  parked: {
    start: null,
    end: null,
    endReview: null,
    finish: { ...PARKED, endKind: DONE_KIND },
    finishFinal: null,
    reopen: { ...OPEN, parkedMs: 3_100 },
    relabel: REVIEWED,
    relabelFromInReview: null,
    wait: null,
    takePlace: null,
    takePlaceUncounted: null,
    requeue: null,
  },
  done: {
    start: null,
    end: null,
    endReview: null,
    finish: DONE,
    finishFinal: null,
    reopen: null,
    relabel: REVIEWED,
    relabelFromInReview: null,
    wait: null,
    takePlace: null,
    takePlaceUncounted: null,
    requeue: null,
  },
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

  it("never counts a negative time", () => {
    expect(nextRunState(IN_REVIEW, { kind: "reopen", at: 1_000 })?.parkedMs).toBe(100);
    expect(
      nextRunState(OPEN, { kind: "end", at: 1_000, endKind: "x", reviewSince: 2_000 })?.parkedMs,
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
