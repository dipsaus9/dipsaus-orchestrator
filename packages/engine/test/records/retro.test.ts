// The retro numbers (DIPO-453): counted by code from the state database, on a fixture. What a new
// run outcome, story and merge keep is checked on the real writers.

import { describe, expect, it } from "bun:test";

import { RunId, type StoryKey } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import type { OfficeHandle } from "../../src/db/office";
import { retro, reworkShare } from "../../src/records/retro";
import { TABLE_RETENTION } from "../../src/retention/policy";
import { endRun, runOutcome } from "../../src/records";
import { setStoryPrState } from "../../src/records/story-prs";
import { recordStoryFiles } from "../../src/records/verify-records";
import { addOffice, openTestState, type TestState } from "../commands/helpers";
import { draft, pass, task } from "../stories/helpers";
import { keyOf, startRun } from "../views/helpers";

const MINUTE = 60_000;
const DAY = 86_400_000;

async function withOffice(fn: (t: TestState, office: OfficeHandle, dir: string) => void) {
  await withTempDir(async (dir) => {
    const t = await openTestState(dir);
    try {
      fn(t, addOffice(t), dir);
    } finally {
      t.state.close();
    }
  });
}

/** Marks a story as merged at `at` with its files, as the writers do. */
function merge(
  t: TestState,
  office: OfficeHandle,
  story: string,
  at: number,
  files: string[],
): StoryKey {
  const key = keyOf(office, story);
  const run = RunId.parse(t.ids.next("run"));
  office.immediate(() => {
    office.run(
      `insert into story_prs (office_id, run_id, key, pr_number, url, branch, base, head_sha, state,
         title, body_hash, opened_at)
       values ($office_id, $run, $key, 1, 'u', 'b', 'main', 'h', 'open', 't', 'x', 0)`,
      { run, key },
    );
    setStoryPrState(office, run, { state: "merged", closedAt: at });
    recordStoryFiles(office, key, files);
  });
  return key;
}

function outcome(
  office: OfficeHandle,
  key: StoryKey,
  fields: {
    tier: string;
    reasons?: string[];
    loops?: number;
    rounds?: number;
    failed?: number;
    ci?: number;
    cost?: number | null;
    id: string;
  },
): void {
  office.run(
    `insert into run_outcomes (office_id, run_id, story_id, tier, role, model, outcome, park_reasons,
       loops, review_rounds, verify_failures, budget_tokens, minutes, ended_at, review_rounds_failed,
       ci_attempts, story_key, cost_micros)
     values ($office_id, $id, 's', $tier, 'developer', 'm', 'done', $reasons, $loops, $rounds, 0, 0, 1, 1,
       $failed, $ci, $key, $cost)`,
    {
      id: fields.id,
      tier: fields.tier,
      reasons: JSON.stringify(fields.reasons ?? []),
      loops: fields.loops ?? 0,
      rounds: fields.rounds ?? 0,
      failed: fields.failed ?? 0,
      ci: fields.ci ?? 0,
      key,
      cost: fields.cost ?? null,
    },
  );
}

function idea(
  office: OfficeHandle,
  id: string,
  fields: { state: string; by?: string; reason?: string; answer?: string },
): void {
  office.run(
    `insert into ideas (office_id, idea_id, origin, title, body, state, decided_by, reason, proposal,
       answer, created_at, updated_at, decided_at)
     values ($office_id, $id, 'quick', $id, 'b', $state, $by, $reason, $proposal, $answer, 1, 1, 1)`,
    {
      id,
      state: fields.state,
      by: fields.by ?? (fields.state === "passed" ? "audit" : null),
      reason: fields.reason ?? null,
      proposal: fields.state === "passed" ? "{}" : null,
      answer: fields.answer ?? null,
    },
  );
}

describe("retro", () => {
  it("counts parks, rounds, loops, cost, time, origins, rework, rejections and dismissals", () =>
    withOffice((t, office) => {
      pass(t, office, [
        task("DIPO-1", { status: "Done", tier: "M", storyType: "feature" }),
        task("DIPO-2", { status: "Done", tier: "M", storyType: "feature" }),
        task("DIPO-3", { status: "Parked", tier: "S", storyType: "bug" }),
        task("DIPO-4", { status: "Refined" }),
      ]);
      const [k1, k2, k3] = ["DIPO-1", "DIPO-2", "DIPO-3"].map((s) => keyOf(office, s)) as [
        StoryKey,
        StoryKey,
        StoryKey,
      ];
      office.immediate(() => {
        office.run(
          "update stories set ready_at = $at, origin = 'planned' where office_id = $office_id and key = $key",
          { key: k1, at: 0 },
        );
        office.run(
          "update stories set ready_at = $at, origin = 'quick' where office_id = $office_id and key = $key",
          { key: k2, at: DAY },
        );
        outcome(office, k1, {
          id: "r1",
          tier: "M",
          loops: 2,
          rounds: 3,
          failed: 1,
          ci: 1,
          cost: 1_500_000,
        });
        outcome(office, k2, {
          id: "r2",
          tier: "M",
          reasons: ["verify-failing", "conflict"],
          loops: 1,
          cost: 2_500_000,
        });
        outcome(office, k3, { id: "r3", tier: "S", reasons: ["verify-failing"] });
      });
      merge(t, office, "DIPO-1", 2 * DAY, ["a.ts", "b.ts", "c.ts"]);
      merge(t, office, "DIPO-2", 3 * DAY, ["a.ts", "b.ts", "d.ts"]);
      idea(office, "i1", {
        state: "rejected",
        by: "code",
        reason: "it is the same as idea abc, held already",
      });
      idea(office, "i2", {
        state: "rejected",
        by: "code",
        reason: "it is the same as idea def, held already",
      });
      idea(office, "i3", { state: "rejected", by: "audit", reason: "already covered by m-2" });
      idea(office, "i4", { state: "passed", answer: "dismissed" });
      idea(office, "i5", { state: "passed", answer: "accepted" });

      const result = retro(office);
      expect(result.groups.map((g) => [g.tier, g.type, g.stories, g.merged])).toEqual([
        ["M", "feature", 2, 2],
        ["S", "bug", 1, 0],
      ]);
      const [feature, bug] = result.groups;
      expect(feature).toMatchObject({
        parks: { "verify-failing": 1, conflict: 1 },
        loops: 3,
        reviewRounds: 3,
        reviewRoundsFailed: 1,
        ciAttempts: 1,
        costMicros: 4_000_000,
        timed: 2,
        // DIPO-1: Ready at 0, merged at 2 days; DIPO-2: Ready at 1 day, merged at 3 days.
        readyToMergedMinutes: 2 * 24 * 60,
      });
      expect(bug).toMatchObject({
        parks: { "verify-failing": 1 },
        costMicros: null,
        readyToMergedMinutes: null,
      });
      expect(result.origins).toEqual({
        planned: 1,
        proposal: 0,
        finding: 0,
        quick: 1,
        aside: 0,
        unknown: 2,
      });
      // DIPO-1 merged first: nothing before it. DIPO-2 shares two of its three files with it.
      expect(result.rework).toEqual({ merged: 2, rework: 1 });
      expect(result.rejected).toEqual([
        { by: "code", reason: "it is the same as an idea held already", count: 2 },
        { by: "audit", reason: "already covered by m-2", count: 1 },
      ]);
      expect(result.dismissed).toBe(1);
      expect(result.lines).toContain("Tier M, type feature: 2 stories, 2 merged");
      expect(result.lines).toContain("  parks: conflict 1, verify-failing 1");
      expect(result.lines).toContain("  cost: $4.00; Ready to merged: 2.0 days on average over 2");
      expect(result.lines).toContain(
        "Rework: 1 of 2 merged stories (50%) changed mostly files another story changed in the 14 days before",
      );
      expect(result.lines).toContain("Ideas the audit rejected: 3");
      expect(result.lines).toContain("Proposed stories you dismissed: 1");
    }));

  it("counts rework only from stories merged in the 14 days before, and needs most of the files", () =>
    withOffice((t, office) => {
      pass(t, office, [task("DIPO-1"), task("DIPO-2"), task("DIPO-3"), task("DIPO-4")]);
      merge(t, office, "DIPO-1", 0, ["a", "b"]);
      merge(t, office, "DIPO-2", 20 * DAY, ["a", "b"]); // 20 days later: no rework
      merge(t, office, "DIPO-3", 25 * DAY, ["a", "x"]); // half of its files: not most
      merge(t, office, "DIPO-4", 26 * DAY, ["a", "b", "x"]); // two of three in the 14 days before
      expect(reworkShare(office)).toEqual({ merged: 4, rework: 1 });
    }));

  it("says so when nothing ended and nothing was kept", () =>
    withOffice((_t, office) => {
      const result = retro(office);
      expect(result.groups).toEqual([]);
      expect(result.lines[0]).toBe("No story run has ended yet.");
      expect(result.rework).toEqual({ merged: 0, rework: 0 });
    }));
});

describe("what dipo keeps for retro (DIPO-453)", () => {
  it("keeps the cost and story key on a run outcome, and the story's type and Ready time", () =>
    withOffice((t, office, dir) => {
      pass(t, office, [task("DIPO-1", { status: "Ready", tier: "S", storyType: "feature" })]);
      const readyAt = t.clock.now();
      t.clock.advance(MINUTE);
      // Read again as In Progress: the Ready time stays the first one, the type stays.
      pass(t, office, [task("DIPO-1", { status: "In Progress", tier: "S", contentHash: "x2" })]);
      const run = startRun(t, office, "DIPO-1", dir);
      office.immediate(() => {
        for (const [agent, model, cost] of [
          [run.agent, "m1", 1_000_000],
          ["agt-review", "m2", 250_000],
        ] as const) {
          office.run(
            `insert or ignore into agents (office_id, agent_id, run_id, role, model, started_at)
             values ($office_id, $agent, $run, 'reviewer', $model, 0)`,
            { agent, run: run.run, model },
          );
          office.run(
            `insert into usage_totals (office_id, run_id, agent_id, model, role, tier, updated_at, cost_micros)
             values ($office_id, $run, $agent, $model, 'developer', 'S', 0, $cost)`,
            { agent, run: run.run, model, cost },
          );
        }
        endRun(office, run.run, t.clock.now() + MINUTE, "parked");
      });
      const kept = runOutcome(office, run.run);
      expect(kept?.storyKey).toBe(run.key);
      expect(kept?.costMicros).toBe(1_250_000);
      const story = office.get<{ story_type: string; ready_at: number }>(
        "select story_type, ready_at from stories where office_id = $office_id and key = $key",
        { key: run.key },
      );
      expect(story).toEqual({ story_type: "feature", ready_at: readyAt });
    }));

  it("records a new story's origin from its accepted idea or its planning session, else none", () =>
    withOffice((t, office) => {
      idea(office, "i1", { state: "passed", answer: "accepted" });
      office.run(
        "update ideas set origin = 'finding', draft_id = 'DRAFT-1', title = 'Fix it', answered_at = 1 where office_id = $office_id and idea_id = 'i1'",
      );
      office.run(
        `insert into planning_records (office_id, session_id, seq, kind, subject, text, at)
         values ($office_id, 's', 1, 'story', 'DIPO-7', 'filed', 1)`,
      );
      pass(t, office, [
        draft("DRAFT-1", { title: "Fix it" }),
        draft("DRAFT-2", { title: "Fix it" }), // another draft with the same title is no match by id
        task("DIPO-7"),
        task("DIPO-8"),
      ]);
      const origin = (story: string) =>
        office.get<{ origin: string | null }>(
          "select origin from stories where office_id = $office_id and story_id = $story",
          { story },
        )?.origin;
      expect(origin("DRAFT-1")).toBe("finding");
      expect(origin("DRAFT-2")).toBeNull();
      expect(origin("DIPO-7")).toBe("planned");
      expect(origin("DIPO-8")).toBeNull();
    }));

  it("keeps the merge time and the files through retention", () => {
    expect(TABLE_RETENTION["run_outcomes"]?.aged).toBe(false);
    expect(TABLE_RETENTION["story_files"]?.aged).toBe(false);
    expect(TABLE_RETENTION["stories"]?.aged).toBe(false);
  });
});
