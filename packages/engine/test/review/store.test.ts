// Stored review verdicts (0019 sections 5, 6, 14 and 16; DIPO-146 AC #2): a verdict is a review
// gate keyed on the code tree key plus its `review_verdicts` row, read back by run and code tree
// key, and shown on `story.detail` as `Verdict.review`.

import { describe, expect, it } from "bun:test";

import { RequestId, type Verdict } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import type { OfficeDirectory } from "../../src/commands/offices";
import { buildRegistry } from "../../src/commands/registry";
import type { OfficeHandle } from "../../src/db/office";
import { executeRead } from "../../src/reads/execute";
import { parseStoryDiff } from "../../src/review/diff";
import {
  recordReviewCommentUrl,
  recordReviewOverride,
  recordReviewVerdict,
  reviewDecidedEntry,
  reviewVerdictForTree,
  reviewVerdictOfGate,
  reviewVerdictsOf,
} from "../../src/review/store";
import { validateReport } from "../../src/review/validate";
import { judgeReview } from "../../src/review/verdict";
import { viewsFeature } from "../views/views-feature";
import type { ReviewFinding, ReviewReport } from "../../src/workers/types";
import { addOffice, openTestState, type TestState } from "../commands/helpers";
import { pass, task } from "../stories/helpers";
import { type StartedRun, startRun } from "../views/helpers";

const DIFF = parseStoryDiff(`diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,2 @@
 const a = 1;
+const b = a - 1;
`);

const CORRECTNESS: ReviewFinding = {
  severity: "blocking",
  kind: "correctness",
  file: "a.ts",
  line: 2,
  quote: "const b = a - 1;",
  text: "Off by one.",
};

const BLOCKED: ReviewReport = {
  criteria: [
    { n: 1, status: "met", evidence: "the migration exists" },
    { n: 2, status: "unmet", evidence: "story.detail shows no review" },
  ],
  findings: [
    CORRECTNESS,
    { severity: "blocking", kind: "maintainability", text: "Name b better." },
  ],
  summary: "One criterion is unmet.",
};

function judged(report: ReviewReport) {
  const checked = validateReport(report, {
    criteria: [1, 2],
    testPlan: undefined,
    diff: DIFF,
  });
  if (!checked.valid) throw new Error(checked.problems.join("; "));
  return judgeReview(report, checked.findings);
}

let request = 0;

async function detailVerdicts(t: TestState, office: OfficeHandle): Promise<Verdict[]> {
  request += 1;
  const offices: OfficeDirectory = {
    get: (id) => (id === office.officeId ? office : undefined),
    load: async () => ({ ok: true, office }),
  };
  const reply = await executeRead(
    { registry: buildRegistry([viewsFeature]), offices, clock: t.clock },
    {
      requestId: RequestId.parse(`01J9ZK5Q8W3V4X6Y7Z${String(request).padStart(8, "0")}`),
      name: "story.detail",
      args: { office: office.officeId, story: "TASK-1" },
    },
  );
  if (!reply.ok) throw new Error(`story.detail failed: ${reply.error.message}`);
  return (reply.result as { verdicts: Verdict[] }).verdicts;
}

async function withRun(
  fn: (t: TestState, office: OfficeHandle, started: StartedRun) => Promise<void>,
): Promise<void> {
  await withTempDir(async (dir) => {
    const t = await openTestState(dir);
    try {
      const office = addOffice(t);
      pass(t, office, [task("TASK-1", { status: "In Review", criteria: { met: 2, total: 2 } })]);
      await fn(t, office, startRun(t, office, "TASK-1", dir));
    } finally {
      t.state.close();
    }
  });
}

/** Adds the run's reviewer agent with its usage. */
function addReviewer(t: TestState, office: OfficeHandle, started: StartedRun): string {
  const agent = t.ids.next("agt");
  office.immediate(() => {
    office.run(
      `insert into agents (office_id, agent_id, run_id, role, model, started_at)
       values ($office_id, $agent, $run, 'reviewer', 'opus', $at)`,
      { agent, run: started.run, at: t.clock.now() },
    );
    office.run(
      `insert into usage_totals (office_id, run_id, agent_id, model, role, tier, input, output,
         turns, updated_at)
       values ($office_id, $run, $agent, 'opus', 'reviewer', 'S', 1200, 300, 4, $at)`,
      { agent, run: started.run, at: t.clock.now() },
    );
  });
  return agent;
}

describe("review verdict store", () => {
  it("reads a stored verdict back by its code tree key with its notes, comment URL, carried-from commit and override", () =>
    withRun(async (t, office, started) => {
      const agent = addReviewer(t, office, started);
      const at = t.clock.now();
      const stored = office.immediate(() =>
        recordReviewVerdict(office, t.ids, {
          runId: started.run,
          key: started.key,
          round: 1,
          agent,
          model: "opus",
          commit: "c1".repeat(20),
          codeTreeKey: "tree-1",
          judged: judged(BLOCKED),
          at,
        }),
      );
      expect(stored).toMatchObject({
        verdict: "blocked",
        round: 1,
        commentUrl: null,
        carriedFrom: null,
        override: null,
        notes: [
          "finding 2 (maintainability): marked blocking, stored as advisory; only scope, test, correctness and security findings block",
        ],
      });
      // The review gate is decided by rule and keyed on the code tree key.
      expect(
        office.get<Record<string, unknown>>(
          `select g.kind, g.key, g.run_id, g.waiting_on, d.decision, d.decided_by, d.content_hash
             from gates g join gate_decisions d using (office_id, gate_id)
            where g.office_id = $office_id and g.gate_id = $gate`,
          { gate: stored.gate },
        ),
      ).toEqual({
        kind: "review",
        key: started.key,
        run_id: started.run,
        waiting_on: null,
        decision: "rejected",
        decided_by: "rule",
        content_hash: "tree-1",
      });

      office.immediate(() => {
        recordReviewCommentUrl(office, stored.gate, "https://github.com/o/r/pull/7#c-1");
        recordReviewOverride(office, stored.gate, { note: "merge it anyway", at: at + 5 });
      });
      const back = reviewVerdictForTree(office, started.run, "tree-1");
      expect(back).toEqual({
        ...stored,
        commentUrl: "https://github.com/o/r/pull/7#c-1",
        override: { note: "merge it anyway", at: at + 5 },
      });
      expect(reviewVerdictForTree(office, started.run, "tree-2")).toBeNull();

      // An approval carried to a new head is a verdict on its new tree, naming where it came from.
      t.clock.advance(1000);
      const carried = office.immediate(() =>
        recordReviewVerdict(office, t.ids, {
          runId: started.run,
          key: started.key,
          round: 1,
          agent: null,
          model: "opus",
          commit: "c2".repeat(20),
          codeTreeKey: "tree-2",
          judged: judged({
            ...BLOCKED,
            criteria: [
              { n: 1, status: "met", evidence: "the migration exists" },
              { n: 2, status: "met", evidence: "" },
            ],
            findings: [],
          }),
          carriedFrom: "c1".repeat(20),
          at: t.clock.now(),
        }),
      );
      expect(reviewVerdictOfGate(office, carried.gate)).toMatchObject({
        verdict: "approved",
        carriedFrom: "c1".repeat(20),
        codeTreeKey: "tree-2",
      });
      expect(reviewVerdictsOf(office, started.key).map((v) => v.gate)).toEqual([
        stored.gate,
        carried.gate,
      ]);
      expect(reviewDecidedEntry(back ?? stored)).toEqual({
        type: "gate.decided",
        key: started.key,
        run: started.run,
        delta: {
          gate: stored.gate,
          decision: "rejected",
          by: "rule",
          review: {
            round: 1,
            commit: "c1".repeat(20),
            verdict: "blocked",
            blocking: 1,
            advisory: 1,
            commentUrl: "https://github.com/o/r/pull/7#c-1",
          },
        },
      });
    }));

  it("shows the verdict on story.detail as Verdict.review", () =>
    withRun(async (t, office, started) => {
      const agent = addReviewer(t, office, started);
      const at = t.clock.now();
      const stored = office.immediate(() =>
        recordReviewVerdict(office, t.ids, {
          runId: started.run,
          key: started.key,
          round: 2,
          agent,
          model: "opus",
          commit: "c1".repeat(20),
          codeTreeKey: "tree-1",
          judged: judged(BLOCKED),
          carriedFrom: "c0".repeat(20),
          at,
        }),
      );
      office.immediate(() => {
        recordReviewCommentUrl(office, stored.gate, "https://github.com/o/r/pull/7#c-2");
        recordReviewOverride(office, stored.gate, { note: "merge it anyway", at: at + 5 });
      });

      const verdicts = await detailVerdicts(t, office);
      expect(verdicts).toEqual([
        {
          gate: stored.gate,
          run: started.run,
          kind: "review",
          decision: "rejected",
          by: "rule",
          failures: [
            "criterion #2 unmet: story.detail shows no review",
            "blocking correctness at a.ts:2: Off by one.",
          ],
          at: new Date(at).toISOString(),
          review: {
            round: 2,
            commit: "c1".repeat(20),
            codeTreeKey: "tree-1",
            verdict: "blocked",
            criteria: [...BLOCKED.criteria],
            findings: [
              { ...CORRECTNESS },
              { severity: "advisory", kind: "maintainability", text: "Name b better." },
            ],
            summary: "One criterion is unmet.",
            model: "opus",
            usage: {
              inputTokens: 1200,
              outputTokens: 300,
              cacheCreateTokens: 0,
              cacheReadTokens: 0,
              turns: 4,
              elapsedMs: 0,
            },
            commentUrl: "https://github.com/o/r/pull/7#c-2",
            carried: true,
            override: { note: "merge it anyway", at: new Date(at + 5).toISOString() },
          },
        },
      ]);
    }));
});
