// The caps of a run (0020, 0002): its start snapshot plus its `budget` and `round` grants, read by
// `runCaps`, and nothing else. A tier edit reaches new runs only, so a parked run keeps the caps it
// started with. The reviewer's tokens, turns and minutes count against its own caps only.

import { describe, expect, it } from "bun:test";

import { RunId } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { REVIEWER_ROLE, reviewTotals, runCaps, runTotals } from "../../src/records/caps";
import { type GrantAmount, recordGrant } from "../../src/records/grants";
import { appendRunStep, findRun, insertRun, type NewRun } from "../../src/records/run-records";
import { type IngestFixture, ingestFixture } from "../ingest/helpers";

const T0 = Date.parse("2026-10-18T09:00:00.000Z");

interface Start {
  readonly budget: number;
  readonly loopCap: number;
  readonly reviewRoundCap: number | null;
  readonly maxTurns?: number | null;
  readonly maxMinutes?: number | null;
  readonly ciCap?: number | null;
  readonly conflictCap?: number | null;
  readonly reviewMaxTurns?: number | null;
  readonly reviewMaxMinutes?: number | null;
  readonly reviewMaxTokens?: number | null;
}

/** The review loop caps of a run that has none (a session run, DIPO-146). */
const NO_REVIEW_CAPS = {
  ciCap: null,
  conflictCap: null,
  reviewMaxTurns: null,
  reviewMaxMinutes: null,
  reviewMaxTokens: null,
};

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
    budgetUnit: "tokens",
    budgetLimit: start.budget,
    loopCap: start.loopCap,
    maxTurns: start.maxTurns ?? null,
    maxMinutes: start.maxMinutes ?? null,
    reviewRoundCap: start.reviewRoundCap,
    ciCap: start.ciCap ?? null,
    conflictCap: start.conflictCap ?? null,
    reviewMaxTurns: start.reviewMaxTurns ?? null,
    reviewMaxMinutes: start.reviewMaxMinutes ?? null,
    reviewMaxTokens: start.reviewMaxTokens ?? null,
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

/** Records one grant of the run, given by the maintainer at T0. */
function grant(f: IngestFixture, runId: RunId, grantId: string, amount: GrantAmount): void {
  f.office.immediate(() =>
    recordGrant(f.office, runId, {
      ...amount,
      grantId,
      note: null,
      origin: "maintainer",
      client: null,
      at: T0,
    }),
  );
}

describe("runCaps", () => {
  it("adds the budget grants and the round grant of each counted cap to the start snapshot", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      try {
        const runId = startRun(f, {
          budget: 1000,
          loopCap: 3,
          reviewRoundCap: 2,
          maxTurns: 50,
          maxMinutes: 30,
          ciCap: 2,
          conflictCap: 2,
          reviewMaxTurns: 60,
          reviewMaxMinutes: 30,
          reviewMaxTokens: 200_000,
        });
        grant(f, runId, "grt_1", {
          kind: "budget",
          amount: { tokens: 500, turns: 10, minutes: 6 },
        });
        grant(f, runId, "grt_2", { kind: "budget", amount: { tokens: 250, turns: 5, minutes: 3 } });
        grant(f, runId, "grt_3", { kind: "round", amount: { cap: "loops", count: 2 } });
        grant(f, runId, "grt_4", { kind: "round", amount: { cap: "reviewRounds", count: 1 } });
        grant(f, runId, "grt_6", { kind: "round", amount: { cap: "ciAttempts", count: 3 } });
        grant(f, runId, "grt_8", { kind: "round", amount: { cap: "conflictAttempts", count: 1 } });

        const caps = runCaps(f.office, storedRun(f, runId));
        expect(caps).toEqual({
          budgetTokens: 1750,
          maxTurns: 65,
          maxMinutes: 39,
          loopCap: 5,
          reviewRoundCap: 3,
          ciCap: 5,
          conflictCap: 3,
          // The reviewer's caps hold per session; no grant raises them.
          reviewMaxTurns: 60,
          reviewMaxMinutes: 30,
          reviewMaxTokens: 200_000,
        });
      } finally {
        f.t.state.close();
      }
    }));

  it("grows no cap by itself: review rounds started add nothing to the budget", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      try {
        const runId = startRun(f, {
          budget: 1000,
          loopCap: 3,
          reviewRoundCap: 3,
          maxTurns: 50,
          maxMinutes: 30,
          reviewMaxTokens: 200_000,
        });
        const before = runCaps(f.office, storedRun(f, runId));
        f.office.immediate(() => {
          for (const round of [1, 2, 3]) {
            appendRunStep(f.office, runId, "review", JSON.stringify({ round, since: T0 }), T0);
          }
        });
        expect(runCaps(f.office, storedRun(f, runId))).toEqual(before);
        expect(before.budgetTokens).toBe(1000);
      } finally {
        f.t.state.close();
      }
    }));

  it("counts the reviewer's tokens and turns only against the reviewer's own caps", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      try {
        const runId = startRun(f, { budget: 1000, loopCap: 3, reviewRoundCap: 3 });
        const usage = (agent: string, role: string, input: number, turns: number) => {
          f.office.run(
            `insert into agents (office_id, agent_id, run_id, role, model, started_at)
             values ($office_id, $agent, $run, $role, 'haiku', 0)`,
            { run: runId, agent, role },
          );
          f.office.run(
            `insert into usage_totals (office_id, run_id, agent_id, model, role, tier, input,
               turns, final, updated_at)
             values ($office_id, $run, $agent, 'haiku', $role, 'M', $input, $turns, 0, 0)`,
            { run: runId, agent, role, input, turns },
          );
        };
        f.office.immediate(() => {
          usage("agt-dev", "developer", 400, 7);
          usage("agt-rev-1", REVIEWER_ROLE, 900, 20);
          usage("agt-rev-2", REVIEWER_ROLE, 300, 5);
        });
        // The story's budget and turns leave every reviewer session out.
        expect(runTotals(f.office, runId, T0, T0)).toEqual({
          budgetTokens: 400,
          turns: 7,
          elapsedMs: 0,
        });
        // One reviewer session counts its own tokens and turns, not the developer's or another's.
        expect(reviewTotals(f.office, runId, "agt-rev-2", T0, T0 + 60_000)).toEqual({
          budgetTokens: 300,
          turns: 5,
          elapsedMs: 60_000,
        });
      } finally {
        f.t.state.close();
      }
    }));

  it("raises the token, turn and minute caps with one budget grant", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      try {
        const runId = startRun(f, {
          budget: 1000,
          loopCap: 3,
          reviewRoundCap: null,
          maxTurns: 50,
          maxMinutes: 30,
        });
        const before = runCaps(f.office, storedRun(f, runId));
        grant(f, runId, "grt_1", {
          kind: "budget",
          amount: { tokens: 500, turns: 25, minutes: 15 },
        });
        const after = runCaps(f.office, storedRun(f, runId));
        expect(before).toMatchObject({ budgetTokens: 1000, maxTurns: 50, maxMinutes: 30 });
        expect(after).toEqual({
          budgetTokens: 1500,
          maxTurns: 75,
          maxMinutes: 45,
          loopCap: 3,
          reviewRoundCap: null,
          ...NO_REVIEW_CAPS,
        });
        // The start snapshot itself never changes.
        expect(storedRun(f, runId)).toMatchObject({
          budgetLimit: 1000,
          maxTurns: 50,
          maxMinutes: 30,
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
          ...NO_REVIEW_CAPS,
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
          ...NO_REVIEW_CAPS,
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
