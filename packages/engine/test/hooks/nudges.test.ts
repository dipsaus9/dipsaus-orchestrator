// The 0014 section 8 nudges (DIPO-60 AC #1 to #4): each trigger with its fact gives its text and
// nothing else gives one; a nudge is at most 300 characters and sent once per fact signature per
// session; every call is answered (a nudge or an empty reply) and a failure stays silent; nudges
// are counted per run in `prompt_parts`. A migrated state database, the manual clock and a steering
// fake that records the neutral ops reaching the worker host.

import { describe, expect, it } from "bun:test";

import { type RunId, StoryId } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import type { OfficeHandle } from "../../src/db/office";
import {
  budgetFact,
  composeNudge,
  contextPathsOf,
  inputPathsOf,
  type InputChangeReader,
  NUDGE_MAX_CHARS,
  nudgeCount,
  nudgeSignature,
  nudgeText,
  Nudges,
  parseInputChanges,
  writeFacts,
  worktreePath,
  writeNudgeSources,
} from "../../src/hooks/nudges";
import type { HookEvent } from "../../src/hooks/types";
import { insertRun } from "../../src/run";
import { addStory } from "../../src/stories/keys";
import type { RunSteering } from "../../src/run/control";
import type { SteerOp, WorkerEvent } from "../../src/workers/types";
import { addOffice, openTestState, type TestState } from "../commands/helpers";

const RUN = "run_01JZ0000000000000000000060" as RunId;
const WORKTREE = "/trees/DIPO-1";
const SCOPE = ["packages/a/", "docs/x.md"];

describe("nudge texts and facts (pure)", () => {
  it("gives each trigger's 0014 section 8 text", () => {
    expect(nudgeText({ trigger: "scope", path: "src/x.ts" })).toBe(
      "`src/x.ts` is outside the declared scope; the engine will reject it.",
    );
    expect(nudgeText({ trigger: "context", path: "src/y.ts" })).toBe(
      "The context shown for `src/y.ts` predates your edit.",
    );
    expect(nudgeText({ trigger: "budget" })).toBe(
      "80% of this story's budget is used; finish the current criterion and report.",
    );
    expect(nudgeText({ trigger: "input", path: "docs/spec.md", sha: "0123456789abcdef0123" })).toBe(
      "Input `docs/spec.md` changed on the base at `0123456789ab`.",
    );
  });

  it("keeps a nudge within 300 characters", () => {
    const long = nudgeText({ trigger: "scope", path: `${"deep/".repeat(100)}x.ts` });
    expect(long).toHaveLength(NUDGE_MAX_CHARS);
    expect(long.endsWith("…")).toBe(true);
    const facts = [
      { trigger: "scope", path: "a".repeat(120) },
      { trigger: "context", path: "b".repeat(120) },
      { trigger: "budget" },
    ] as const;
    const composed = composeNudge(facts);
    expect(composed.text.length).toBeLessThanOrEqual(NUDGE_MAX_CHARS);
    // The context text does not fit beside the scope text; the shorter budget text does.
    expect(composed.facts.map((fact) => fact.trigger)).toEqual(["scope", "budget"]);
    expect(composeNudge([])).toEqual({ text: "", facts: [] });
  });

  it("signs each fact so the same fact has one signature and another fact another", () => {
    const signatures = [
      nudgeSignature({ trigger: "scope", path: "a.ts" }),
      nudgeSignature({ trigger: "context", path: "a.ts" }),
      nudgeSignature({ trigger: "budget" }),
      nudgeSignature({ trigger: "input", path: "a.ts", sha: "1".repeat(40) }),
      nudgeSignature({ trigger: "input", path: "a.ts", sha: "2".repeat(40) }),
    ];
    expect(new Set(signatures).size).toBe(signatures.length);
    expect(nudgeSignature({ trigger: "scope", path: "a.ts" })).toBe(signatures[0] as string);
  });

  it("finds the scope and context facts of a written file and nothing for an in-scope one", () => {
    const context = new Set(["packages/a/b.ts", "README.md"]);
    expect(writeFacts({ path: "packages/a/c.ts", scope: SCOPE, contextPaths: context })).toEqual(
      [],
    );
    expect(writeFacts({ path: "docs/x.md", scope: SCOPE, contextPaths: context })).toEqual([]);
    expect(writeFacts({ path: "packages/a/b.ts", scope: SCOPE, contextPaths: context })).toEqual([
      { trigger: "context", path: "packages/a/b.ts" },
    ]);
    expect(writeFacts({ path: "README.md", scope: SCOPE, contextPaths: context })).toEqual([
      { trigger: "scope", path: "README.md" },
      { trigger: "context", path: "README.md" },
    ]);
    // A lockfile pairs with a manifest at `done`; a run without a scope has no scope fact.
    expect(writeFacts({ path: "bun.lock", scope: SCOPE, contextPaths: context })).toEqual([]);
    expect(writeFacts({ path: "z.ts", scope: null, contextPaths: context })).toEqual([]);
    // The story's own task file is committed by the engine, as at `done`.
    const task = "backlog/tasks/dipo-1 - Add-a-greeting.md";
    expect(
      writeFacts({ path: task, scope: SCOPE, story: "DIPO-1", contextPaths: context }),
    ).toEqual([]);
    expect(
      writeFacts({ path: task, scope: SCOPE, story: "DIPO-2", contextPaths: context }),
    ).toEqual([{ trigger: "scope", path: task }]);
  });

  it("makes a written path worktree-relative and leaves a path outside the worktree without facts", () => {
    expect(worktreePath("/trees/DIPO-1/src/a.ts", WORKTREE)).toBe("src/a.ts");
    expect(worktreePath("/private/tmp/w/src/a.ts", "/tmp/w")).toBe("src/a.ts");
    expect(worktreePath("/tmp/w/src/a.ts", "/private/tmp/w")).toBe("src/a.ts");
    expect(worktreePath("./src/a.ts", WORKTREE)).toBe("src/a.ts");
    expect(worktreePath("/tmp/scratch.txt", WORKTREE)).toBeNull();
    expect(worktreePath("/trees/DIPO-10/a.ts", WORKTREE)).toBeNull();
  });

  it("gives the budget fact from 80% of the budget", () => {
    expect(budgetFact(799, 1000)).toBeNull();
    expect(budgetFact(800, 1000)).toEqual({ trigger: "budget" });
    expect(budgetFact(5, 0)).toBeNull();
  });

  it("reads the newest base commit per input path from git log", () => {
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    const output = `\0${a}\n\ndocs/spec.md\nsrc/in.ts\n\0${b}\n\ndocs/spec.md\n`;
    expect(parseInputChanges(output, ["src/in.ts", "docs/spec.md", "other.md"])).toEqual([
      { path: "src/in.ts", sha: a },
      { path: "docs/spec.md", sha: a },
    ]);
    expect(parseInputChanges("", ["x"])).toEqual([]);
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

async function withWorld(
  fn: (w: World) => Promise<void> | void,
  inputChanges?: InputChangeReader,
): Promise<void> {
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
        writeNudgeSources(
          office,
          RUN,
          "agt-1",
          { context: ["packages/a/b.ts"], inputs: ["docs/spec.md"] },
          { "packages/a/b.ts": "export const b = 1;\n" },
          at,
        );
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
        ...(inputChanges === undefined ? {} : { inputChanges }),
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
  it("nudges a write outside scope once per session and counts it in prompt_parts", () =>
    withWorld(async (w) => {
      await pass(w, "agt-1", {
        kind: "toolUsed",
        id: 10,
        tool: "Edit",
        wrote: `${WORKTREE}/README.md`,
      });
      await pass(w, "agt-1", { kind: "toolUsed", id: 20, tool: "Write", wrote: "README.md" });
      expect(w.ops).toEqual([
        {
          kind: "nudge",
          hook: 10,
          on: "toolUsed",
          text: "`README.md` is outside the declared scope; the engine will reject it.",
        },
        released(20),
      ]);
      expect(nudgeCount(w.office, RUN)).toBe(1);
      const row = w.office.get<{ nudges: number; bytes: number }>(
        `select nudges, bytes from prompt_parts where office_id = $office_id and part = $part`,
        { part: "nudge.scope:README.md" },
      );
      expect(row?.nudges).toBe(1);
      expect(row?.bytes).toBe(69);
    }));

  it("nudges a write to a context pack file, and the budget past 80%, each once", () =>
    withWorld(async (w) => {
      await pass(w, "agt-1", { kind: "toolUsed", id: 1, tool: "Edit", wrote: "packages/a/b.ts" });
      await pass(w, "agt-1", { kind: "toolUsed", id: 2, tool: "Bash" });
      setUsage(w.office, 800);
      await pass(w, "agt-1", { kind: "toolUsed", id: 3, tool: "Bash" });
      await pass(w, "agt-1", { kind: "toolUsed", id: 4, tool: "Edit", wrote: "packages/a/b.ts" });
      expect(w.ops).toEqual([
        {
          kind: "nudge",
          hook: 1,
          on: "toolUsed",
          text: "The context shown for `packages/a/b.ts` predates your edit.",
        },
        released(2),
        {
          kind: "nudge",
          hook: 3,
          on: "toolUsed",
          text: "80% of this story's budget is used; finish the current criterion and report.",
        },
        released(4),
      ]);
      expect(nudgeCount(w.office, RUN)).toBe(2);
    }));

  it("releases every other call with an empty reply and answers no other hook", () =>
    withWorld(async (w) => {
      await pass(
        w,
        "agt-1",
        { kind: "toolUsed", id: 1, tool: "Edit", wrote: "packages/a/new.ts" },
        { kind: "toolUsed", id: 2, tool: "Read" },
        { kind: "toolUsed", id: 22, tool: "Write", wrote: "/tmp/scratch.txt" },
        { kind: "sessionStarted", id: 3, source: "startup" },
        { kind: "toolUsed", id: null, tool: "Write", wrote: "README.md" },
        { kind: "permissionRequest", id: 4, tool: "Bash", input: "ls" },
        { kind: "stopped" },
      );
      expect(w.ops).toEqual([released(1), released(2), released(22), released(3)]);
      expect(nudgeCount(w.office, RUN)).toBe(0);
    }));

  it("sends a fact again in a new session, but not in a resume of the same session", () =>
    withWorld(async (w) => {
      await pass(w, "agt-1", { kind: "toolUsed", id: 1, tool: "Write", wrote: "README.md" });
      addAgent(w.office, "agt-2", "session-1", w.t.clock.now());
      await pass(w, "agt-2", { kind: "toolUsed", id: 2, tool: "Write", wrote: "README.md" });
      addAgent(w.office, "agt-3", "session-2", w.t.clock.now());
      await pass(w, "agt-3", { kind: "toolUsed", id: 3, tool: "Write", wrote: "README.md" });
      expect(w.ops.map((op) => op.kind)).toEqual(["nudge", "hookReply", "nudge"]);
      expect(nudgeCount(w.office, RUN)).toBe(2);
    }));

  it("records nothing when the reply does not reach the host, and stays silent", () =>
    withWorld(async (w) => {
      w.steering.fail = "throw";
      await pass(w, "agt-1", { kind: "toolUsed", id: 1, tool: "Write", wrote: "README.md" });
      w.steering.fail = "refuse";
      await pass(w, "agt-1", { kind: "toolUsed", id: 2, tool: "Write", wrote: "README.md" });
      expect(nudgeCount(w.office, RUN)).toBe(0);
      w.steering.fail = null;
      await pass(w, "agt-1", { kind: "toolUsed", id: 3, tool: "Write", wrote: "README.md" });
      expect(nudgeCount(w.office, RUN)).toBe(1);
    }));

  it("nudges an input changed on the base when a session resumes", async () => {
    const calls: { since: string; paths: readonly string[] }[] = [];
    const sha = "d".repeat(40);
    await withWorld(
      async (w) => {
        expect(inputPathsOf(w.office, RUN)).toEqual(["docs/spec.md"]);
        expect(contextPathsOf(w.office, RUN)).toEqual(["packages/a/b.ts"]);
        await pass(w, "agt-1", { kind: "sessionStarted", id: 5, source: "startup" });
        await pass(w, "agt-1", { kind: "sessionStarted", id: 6, source: "resume", resumed: true });
        await pass(w, "agt-1", { kind: "sessionStarted", id: 7, source: "resume", resumed: true });
        expect(w.ops).toEqual([
          released(5),
          {
            kind: "nudge",
            hook: 6,
            on: "sessionStarted",
            text: "Input `docs/spec.md` changed on the base at `dddddddddddd`.",
          },
          released(7),
        ]);
        expect(calls).toEqual([
          { since: "c".repeat(40), paths: ["docs/spec.md"] },
          { since: "c".repeat(40), paths: ["docs/spec.md"] },
        ]);
      },
      async (_office, _run, since, paths) => {
        calls.push({ since, paths });
        return [{ path: "docs/spec.md", sha }];
      },
    );
  });

  it("releases a resume without a nudge when the input check is too slow or fails", async () => {
    let mode: "hang" | "fail" = "hang";
    await withWorld(
      async (w) => {
        w.nudges.onWorkerEvents(w.office, RUN, "agt-1", [
          hook({ kind: "sessionStarted", id: 8, source: "resume", resumed: true }),
        ]);
        await Promise.resolve();
        expect(w.ops).toEqual([]);
        w.t.clock.advance(1_000);
        await w.nudges.idle();
        mode = "fail";
        await pass(w, "agt-1", { kind: "sessionStarted", id: 9, source: "resume", resumed: true });
        expect(w.ops).toEqual([released(8), released(9)]);
      },
      () => (mode === "hang" ? new Promise(() => undefined) : Promise.reject(new Error("git"))),
    );
  });
});
