// The 0014 section 8 budget nudge (DIPO-60 AC #1 to #4, cut to the reviewer's one fact by
// DIPO-342): past 80% of the run's budget a tool use gets its text and nothing else gives one; a
// nudge is at most 300 characters and sent once per session; every call is answered (a nudge or an
// empty reply) and a failure stays silent; nudges are counted per run in `prompt_parts`. A migrated
// state database, the manual clock and a steering fake that records the neutral ops reaching the
// worker host.

import { describe, expect, it } from "bun:test";

import { type RunId, StoryId } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import type { OfficeHandle } from "../../src/db/office";
import {
  budgetFact,
  composeNudge,
  NUDGE_MAX_CHARS,
  nudgeCount,
  nudgeSignature,
  nudgeText,
  Nudges,
} from "../../src/hooks/nudges";
import type { HookEvent } from "../../src/hooks/types";
import { insertRun, recordGrant, runIntents } from "../../src/run";
import { addStory } from "../../src/stories/keys";
import type { RunSteering } from "../../src/run/control";
import type { SteerOp, WorkerEvent } from "../../src/workers/types";
import { addOffice, openTestState, type TestState } from "../commands/helpers";

const RUN = "run_01JZ0000000000000000000060" as RunId;
const WORKTREE = "/trees/DIPO-1";
const SCOPE = ["packages/a/", "docs/x.md"];
const BUDGET_TEXT = "80% of this story's budget is used; finish the current criterion and report.";

describe("the budget nudge text and fact (pure)", () => {
  it("gives the 0014 section 8 text within 300 characters", () => {
    expect(nudgeText({ trigger: "budget" })).toBe(BUDGET_TEXT);
    const composed = composeNudge([{ trigger: "budget" }]);
    expect(composed).toEqual({ text: BUDGET_TEXT, facts: [{ trigger: "budget" }] });
    expect(composed.text.length).toBeLessThanOrEqual(NUDGE_MAX_CHARS);
    expect(composeNudge([])).toEqual({ text: "", facts: [] });
  });

  it("signs the fact as its prompt_parts name", () => {
    expect(nudgeSignature({ trigger: "budget" })).toBe("nudge.budget");
  });

  it("gives the budget fact from 80% of the budget", () => {
    expect(budgetFact(799, 1000)).toBeNull();
    expect(budgetFact(800, 1000)).toEqual({ trigger: "budget" });
    expect(budgetFact(5, 0)).toBeNull();
  });
});

interface World {
  readonly t: TestState;
  readonly office: OfficeHandle;
  readonly nudges: Nudges;
  /** Every neutral op the module encoded, in order. */
  readonly ops: SteerOp[];
  readonly steering: { fail: "throw" | "refuse" | null };
}

function addAgent(office: OfficeHandle, agent: string, session: string, at: number): void {
  office.run(
    `insert into agents (office_id, agent_id, run_id, role, model, session_id, started_at)
     values ($office_id, $agent, $run, 'developer', 'haiku', $session, $at)`,
    { agent, run: RUN, session, at },
  );
}

function setUsage(office: OfficeHandle, input: number): void {
  office.run(
    `insert into usage_totals (office_id, run_id, agent_id, model, role, tier, input, final, updated_at)
     values ($office_id, $run, 'agt-1', 'haiku', 'developer', 'M', $input, 0, 0)
     on conflict do update set input = excluded.input`,
    { run: RUN, input },
  );
}

async function withWorld(fn: (w: World) => Promise<void> | void): Promise<void> {
  await withTempDir(async (dir) => {
    const t = await openTestState(dir);
    try {
      const office = addOffice(t);
      const at = t.clock.now();
      const { key } = office.immediate(() =>
        addStory(office, t.ids, { story: StoryId.parse("DIPO-1") }, at),
      );
      office.immediate(() => {
        insertRun(office, {
          runId: RUN,
          kind: "story",
          key,
          story: "DIPO-1",
          tier: "M",
          role: "developer",
          model: "haiku",
          startSha: "c".repeat(40),
          branch: "DIPO-1/x",
          worktree: WORKTREE,
          slot: 1,
          budgetUnit: "tokens",
          budgetLimit: 1000,
          loopCap: 3,
          reviewRoundCap: null,
          configHash: "h",
          overrideKeys: null,
          runProfileId: null,
          startedAt: at,
          scope: SCOPE,
        });
        addAgent(office, "agt-1", "session-1", at);
      });
      const ops: SteerOp[] = [];
      const steering = { fail: null as "throw" | "refuse" | null };
      const send: RunSteering = {
        send: async () => {
          if (steering.fail === "throw") throw new Error("socket gone");
          return steering.fail === "refuse"
            ? { ok: false, reason: "no call", code: "hook.unknown" }
            : { ok: true };
        },
      };
      const nudges = new Nudges({
        clock: t.clock,
        steering: send,
        encode: (op) => {
          ops.push(op);
          return [];
        },
      });
      await fn({ t, office, nudges, ops, steering });
    } finally {
      t.state.close();
    }
  });
}

function hook(event: HookEvent): WorkerEvent {
  return { t: "hook", hook: event };
}

async function pass(w: World, agent: string, ...events: HookEvent[]): Promise<void> {
  w.nudges.onWorkerEvents(w.office, RUN, agent, events.map(hook));
  await w.nudges.idle();
}

const released = (call: number): SteerOp => ({
  kind: "hookReply",
  reply: { hook: call, decision: null },
});

describe("Nudges (DIPO-60)", () => {
  it("nudges the budget past 80% once per session and counts it in prompt_parts", () =>
    withWorld(async (w) => {
      await pass(w, "agt-1", { kind: "toolUsed", id: 1, tool: "Read" });
      setUsage(w.office, 800);
      await pass(w, "agt-1", { kind: "toolUsed", id: 2, tool: "Read" });
      await pass(w, "agt-1", { kind: "toolUsed", id: 3, tool: "Grep" });
      expect(w.ops).toEqual([
        released(1),
        { kind: "nudge", hook: 2, on: "toolUsed", text: BUDGET_TEXT },
        released(3),
      ]);
      expect(nudgeCount(w.office, RUN)).toBe(1);
      // A nudge is an exception to the stored intent (the `intents.ts` header): no intent row.
      expect(runIntents(w.office, RUN)).toEqual([]);
      const row = w.office.get<{ nudges: number; bytes: number }>(
        `select nudges, bytes from prompt_parts where office_id = $office_id and part = $part`,
        { part: "nudge.budget" },
      );
      expect(row?.nudges).toBe(1);
      expect(row?.bytes).toBe(BUDGET_TEXT.length);
    }));

  it("moves the 80% budget threshold by a budget grant (DIPO-143)", () =>
    withWorld(async (w) => {
      // The start budget of 1000 plus a grant of 1000: 80% is now 1600 tokens, not 800.
      w.office.immediate(() =>
        recordGrant(w.office, RUN, {
          kind: "budget",
          amount: { tokens: 1000, turns: 0, minutes: 0 },
          grantId: "grt_1",
          note: null,
          origin: "maintainer",
          client: null,
          at: w.t.clock.now(),
        }),
      );
      setUsage(w.office, 800);
      await pass(w, "agt-1", { kind: "toolUsed", id: 1, tool: "Read" });
      setUsage(w.office, 1600);
      await pass(w, "agt-1", { kind: "toolUsed", id: 2, tool: "Read" });
      expect(w.ops).toEqual([
        released(1),
        { kind: "nudge", hook: 2, on: "toolUsed", text: BUDGET_TEXT },
      ]);
    }));

  it("releases every other call with an empty reply, a write and a resume included, and answers no other hook", () =>
    withWorld(async (w) => {
      await pass(
        w,
        "agt-1",
        { kind: "toolUsed", id: 1, tool: "Edit", wrote: `${WORKTREE}/README.md` },
        { kind: "toolUsed", id: 2, tool: "Read" },
        { kind: "sessionStarted", id: 3, source: "startup" },
        { kind: "sessionStarted", id: 5, source: "resume", resumed: true },
        { kind: "toolUsed", id: null, tool: "Write", wrote: "README.md" },
        { kind: "permissionRequest", id: 4, tool: "Bash", input: "ls" },
        { kind: "stopped" },
      );
      expect(w.ops).toEqual([released(1), released(2), released(3), released(5)]);
      expect(nudgeCount(w.office, RUN)).toBe(0);
    }));

  it("sends the nudge again in a new session, but not in a resume of the same session", () =>
    withWorld(async (w) => {
      setUsage(w.office, 900);
      await pass(w, "agt-1", { kind: "toolUsed", id: 1, tool: "Read" });
      addAgent(w.office, "agt-2", "session-1", w.t.clock.now());
      await pass(w, "agt-2", { kind: "toolUsed", id: 2, tool: "Read" });
      addAgent(w.office, "agt-3", "session-2", w.t.clock.now());
      await pass(w, "agt-3", { kind: "toolUsed", id: 3, tool: "Read" });
      expect(w.ops.map((op) => op.kind)).toEqual(["nudge", "hookReply", "nudge"]);
      expect(nudgeCount(w.office, RUN)).toBe(2);
    }));

  it("records nothing when the reply does not reach the host, and stays silent", () =>
    withWorld(async (w) => {
      setUsage(w.office, 900);
      w.steering.fail = "throw";
      await pass(w, "agt-1", { kind: "toolUsed", id: 1, tool: "Read" });
      w.steering.fail = "refuse";
      await pass(w, "agt-1", { kind: "toolUsed", id: 2, tool: "Read" });
      expect(nudgeCount(w.office, RUN)).toBe(0);
      w.steering.fail = null;
      await pass(w, "agt-1", { kind: "toolUsed", id: 3, tool: "Read" });
      expect(nudgeCount(w.office, RUN)).toBe(1);
    }));
});
