// The caps of a run (ADR 0020 section 5, DIPO-143): its start snapshot plus its grants, read by
// `runCaps`. A tier edit reaches new runs only, so a parked run keeps the caps it started with.

import { describe, expect, it } from "bun:test";

import { RunId } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { runCaps } from "../../src/run/caps";
import { recordGrant } from "../../src/run/grants";
import { findRun, insertRun, type NewRun } from "../../src/run/records";
import { type IngestFixture, ingestFixture } from "../ingest/helpers";

const T0 = Date.parse("2026-10-18T09:00:00.000Z");

interface Start {
  readonly budget: number;
  readonly loopCap: number;
  readonly reviewRoundCap: number | null;
  readonly maxTurns?: number | null;
  readonly maxMinutes?: number | null;
}

/** A session run (no story, so no claim or branch) started with the given caps. */
function startRun(f: IngestFixture, start: Start): RunId {
  const runId = RunId.parse(f.t.ids.next("run"));
  const run: NewRun = {
    runId,
    kind: "session",
    key: null,
    story: null,
    tier: "M",
    role: "developer",
    model: "haiku",
    startSha: null,
    branch: null,
    worktree: null,
    slot: null,
    budgetUnit: "tokens",
    budgetLimit: start.budget,
    loopCap: start.loopCap,
    maxTurns: start.maxTurns ?? null,
    maxMinutes: start.maxMinutes ?? null,
    reviewRoundCap: start.reviewRoundCap,
    configHash: "h",
    overrideKeys: null,
    runProfileId: null,
    startedAt: T0,
  };
  f.office.immediate(() => insertRun(f.office, run));
  return runId;
}

function storedRun(f: IngestFixture, runId: RunId) {
  const run = findRun(f.office, runId);
  if (run === null) throw new Error(`run ${runId} is not stored`);
  return run;
}

describe("runCaps", () => {
  it("adds the budget, loop and review cap grants to the start snapshot", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      try {
        const runId = startRun(f, {
          budget: 1000,
          loopCap: 3,
          reviewRoundCap: 2,
          maxTurns: 50,
          maxMinutes: 30,
        });
        const grant = (
          grantId: string,
          kind: Parameters<typeof recordGrant>[2]["kind"],
          amount: unknown,
        ) =>
          f.office.immediate(() =>
            recordGrant(f.office, runId, {
              grantId,
              kind,
              amount,
              note: null,
              origin: "maintainer",
              client: null,
              at: T0,
            }),
          );
        grant("grt_1", "budget", 500);
        grant("grt_2", "budget", 250);
        grant("grt_3", "loop", 2);
        grant("grt_4", "reviewCap", 1);
        // Kinds the caps do not count: a review round, a CI attempt and a scope.
        grant("grt_5", "reviewRound", 4);
        grant("grt_6", "ciAttempt", 3);
        grant("grt_7", "scope", ["src/"]);

        const caps = runCaps(f.office, storedRun(f, runId));
        expect(caps).toEqual({
          budgetTokens: 1750,
          maxTurns: 50,
          maxMinutes: 30,
          loopCap: 5,
          reviewRoundCap: 3,
        });
      } finally {
        f.t.state.close();
      }
    }));

  it("keeps a parked run's start caps when the tier is edited, and gives a new run the edited caps", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      try {
        const tier = { budgetTokens: 1000, maxTurns: 50, maxMinutes: 30 };
        const parked = startRun(f, {
          budget: tier.budgetTokens,
          loopCap: 3,
          reviewRoundCap: null,
          maxTurns: tier.maxTurns,
          maxMinutes: tier.maxMinutes,
        });
        // The maintainer edits the tier while the run is parked.
        const edited = { budgetTokens: 9000, maxTurns: 500, maxMinutes: 90 };

        expect(runCaps(f.office, storedRun(f, parked), edited)).toEqual({
          ...tier,
          loopCap: 3,
          reviewRoundCap: null,
        });

        const fresh = startRun(f, {
          budget: edited.budgetTokens,
          loopCap: 3,
          reviewRoundCap: null,
          maxTurns: edited.maxTurns,
          maxMinutes: edited.maxMinutes,
        });
        expect(runCaps(f.office, storedRun(f, fresh))).toEqual({
          ...edited,
          loopCap: 3,
          reviewRoundCap: null,
        });
      } finally {
        f.t.state.close();
      }
    }));

  it("reads turns and minutes from the fallback only for a run started before they were kept", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      try {
        const legacy = startRun(f, { budget: 1000, loopCap: 3, reviewRoundCap: null });
        const run = storedRun(f, legacy);
        expect(runCaps(f.office, run, { maxTurns: 40, maxMinutes: 20 })).toMatchObject({
          maxTurns: 40,
          maxMinutes: 20,
        });
        expect(runCaps(f.office, run)).toMatchObject({
          maxTurns: Number.POSITIVE_INFINITY,
          maxMinutes: Number.POSITIVE_INFINITY,
        });
      } finally {
        f.t.state.close();
      }
    }));
});
