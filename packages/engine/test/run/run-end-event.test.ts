// The `run.ended` entry of the office stream (0005, DIPO-397): every end of a run writes one entry,
// whatever path ends it, and an end that does not apply writes none, so no end is sent twice.

import { describe, expect, it } from "bun:test";

import type { RunId, StoryKey } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import type { OfficeHandle } from "../../src/db/office";
import { endRunMarked } from "../../src/run/markers";
import { endRun, insertRun, type NewRun } from "../../src/records/run-records";
import { addOffice, openTestState, type TestState } from "../commands/helpers";
import { entriesAfter } from "../stories/helpers";

const STORY_RUN = "run_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D" as RunId;
const SESSION_RUN = "run_01J9ZK5Q8W3V4X6Y7Z8A9B0C2E" as RunId;
const KEY = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C3F" as StoryKey;
const START = Date.parse("2026-10-30T10:00:00.000Z");
const END = Date.parse("2026-10-30T10:05:00.000Z");

async function withOffice(fn: (office: OfficeHandle) => Promise<void>): Promise<void> {
  await withTempDir(async (dir) => {
    const t: TestState = await openTestState(dir);
    try {
      await fn(addOffice(t));
    } finally {
      t.state.close();
    }
  });
}

function startRun(office: OfficeHandle, run: NewRun): void {
  office.immediate(() => insertRun(office, run));
}

/** A story run of `KEY`, as the planner starts it. */
function storyRun(office: OfficeHandle): void {
  startRun(office, {
    runId: STORY_RUN,
    kind: "story",
    key: KEY,
    story: "DIPO-397",
    tier: "S",
    role: "developer",
    model: "haiku",
    startSha: "a".repeat(40),
    branch: "DIPO-397/x",
    budgetUnit: "tokens",
    budgetLimit: 400_000,
    loopCap: 3,
    reviewRoundCap: null,
    configHash: "hash",
    overrideKeys: null,
    runProfileId: null,
    startedAt: START,
  });
}

/** A scan session run, which has no story. */
function sessionRun(office: OfficeHandle): void {
  startRun(office, {
    runId: SESSION_RUN,
    kind: "session",
    key: null,
    story: null,
    tier: null,
    role: "scanner",
    model: "sonnet",
    startSha: null,
    branch: null,
    budgetUnit: "tokens",
    budgetLimit: 1_000,
    loopCap: 0,
    reviewRoundCap: null,
    configHash: "hash",
    overrideKeys: null,
    runProfileId: null,
    startedAt: START,
  });
}

/** The `run.ended` entries of the office stream, in order. */
function runEnded(office: OfficeHandle): { type: string; key: string | null; delta: unknown }[] {
  return entriesAfter(office)
    .filter((entry) => entry.type === "run.ended")
    .map((entry) => ({ type: entry.type, key: entry.key, delta: entry.delta }));
}

describe("run.ended (DIPO-397)", () => {
  it("a story run's end writes one entry with its key, story and ending", () =>
    withOffice(async (office) => {
      storyRun(office);
      expect(office.immediate(() => endRun(office, STORY_RUN, END, "done"))).toBe(true);
      expect(runEnded(office)).toEqual([
        {
          type: "run.ended",
          key: KEY,
          delta: {
            run: STORY_RUN,
            kind: "story",
            ending: "done",
            endedAt: new Date(END).toISOString(),
            key: KEY,
            story: "DIPO-397",
          },
        },
      ]);
    }));

  it("a session run's end writes one entry with no story or key", () =>
    withOffice(async (office) => {
      sessionRun(office);
      expect(office.immediate(() => endRun(office, SESSION_RUN, END, "dropped"))).toBe(true);
      expect(runEnded(office)).toEqual([
        {
          type: "run.ended",
          key: null,
          delta: {
            run: SESSION_RUN,
            kind: "session",
            ending: "dropped",
            endedAt: new Date(END).toISOString(),
          },
        },
      ]);
    }));

  it("an end that does not apply writes no entry, so no end is sent twice", () =>
    withOffice(async (office) => {
      sessionRun(office);
      office.immediate(() => endRun(office, SESSION_RUN, END, "dropped"));
      expect(office.immediate(() => endRun(office, SESSION_RUN, END + 1, "dropped"))).toBe(false);
      expect(runEnded(office)).toHaveLength(1);
    }));

  it("a parked run that ends again as done is a second end, with its own entry", () =>
    withOffice(async (office) => {
      storyRun(office);
      office.immediate(() => endRun(office, STORY_RUN, END, "parked"));
      office.immediate(() => endRun(office, STORY_RUN, END + 1_000, "done"));
      expect(runEnded(office).map((entry) => (entry.delta as { ending: string }).ending)).toEqual([
        "parked",
        "done",
      ]);
    }));

  it("the done path of endRunMarked, with its review period, writes one entry", () =>
    withOffice(async (office) => {
      storyRun(office);
      expect(
        office.immediate(() => endRunMarked(office, STORY_RUN, END, "done", START + 60_000)),
      ).toBe(true);
      expect(runEnded(office).map((entry) => (entry.delta as { ending: string }).ending)).toEqual([
        "done",
      ]);
    }));

  it("the dropped path of endRunMarked, as a claim release or a reconcile writes one entry", () =>
    withOffice(async (office) => {
      sessionRun(office);
      expect(office.immediate(() => endRunMarked(office, SESSION_RUN, END, "dropped"))).toBe(true);
      expect(runEnded(office).map((entry) => (entry.delta as { ending: string }).ending)).toEqual([
        "dropped",
      ]);
    }));

  it("the park path of endRunMarked writes its entry once, with its ended marker", () =>
    withOffice(async (office) => {
      storyRun(office);
      expect(office.immediate(() => endRunMarked(office, STORY_RUN, END, "parked"))).toBe(true);
      expect(office.immediate(() => endRunMarked(office, STORY_RUN, END + 1, "parked"))).toBe(
        false,
      );
      expect(runEnded(office)).toHaveLength(1);
      // The marker is stored once in the run's output too (0005: the output is not an end event).
      expect(
        office.get<{ n: number }>(
          "select count(*) as n from output_chunks where office_id = $office_id and text like '%ended parked%'",
        )?.n,
      ).toBe(1);
    }));
});
