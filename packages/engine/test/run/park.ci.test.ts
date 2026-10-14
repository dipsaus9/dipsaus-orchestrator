// CI only (0017 section 1): parks on real git with a bare `origin` and the pinned Backlog CLI
// (DIPO-50 test plan). Each case claims TASK-1 with `work.run`, then:
// - replays `budget-engine-cap` through FakeProcess with the tier budget from its meta: run control
//   stops the worker and parks `budget-exceeded` naming the token cap, with one park commit
//   `TASK-1: status Parked` holding the F16 block, pushed to `origin`;
// - with no worker events, `work.stop` parks `stopped` the same way, branch and worktree kept;
// - with the worktree's `.git` pointer changed after the claim, `work.stop` parks `scope-violation`
//   and no git runs in that worktree: the branch tip stays the claim commit.
// Each case needs several CLI calls, an office load, a fetch, a claim and a push, well over the
// local per-test budget; the same rules run locally against fakes in control.test.ts.

import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type CommandReply, RequestId } from "@dipsaus-orchestrator/contract";

import { executeCommand } from "../../src/commands/execute";
import { createSystemIds } from "../../src/platform/ids";
import { runIntents } from "../../src/run";
import { CLI } from "../gate/gated-office";
import { resultOf } from "../office/helpers";
import { loadRecording } from "../workers/replay";
import { BRANCH, type Running, withRunOffice } from "./run-office";

let count = 0;
function requestId(): RequestId {
  count += 1;
  return RequestId.parse(`01J9ZK5Q8W3V4X6Y7Z${(80_000 + count).toString().padStart(8, "0")}`);
}

function command(r: Running, name: string, args: Record<string, unknown>): Promise<CommandReply> {
  return executeCommand(
    { ...r.s.deps, ids: createSystemIds(r.s.clock) },
    { requestId: requestId(), name, args, origin: "cli", confirmed: true, office: r.officeId },
  );
}

async function startRun(r: Running): Promise<string> {
  const result = resultOf<{ started: { story: string; run: string }[] }>(
    await command(r, "work.run", { from: r.repo.dir }),
  );
  expect(result.started.map((s) => s.story)).toEqual(["TASK-1"]);
  return result.started[0]?.run as string;
}

function worktreeOf(r: Running, run: string): string {
  const row = r.office.get<{ worktree: string }>(
    "select worktree from runs where office_id = $office_id and run_id = $run",
    { run },
  );
  if (row === null) throw new Error(`no run ${run}`);
  return row.worktree;
}

async function viewIn(r: Running, cwd: string): Promise<string> {
  const view = await r.repo.run([...CLI(r.repo).command, "task", "view", "TASK-1", "--plain"], cwd);
  return view.stdout;
}

function parks(r: Running): { reason: string; from_state: string; detail: string }[] {
  return r.office.all("select reason, from_state, detail from parks where office_id = $office_id");
}

async function tip(r: Running, ref: string): Promise<string> {
  return (await r.repo.git("rev-parse", ref)).trim();
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("parks on real git and the Backlog CLI", () => {
    it("budget-engine-cap: stops the worker and parks budget-exceeded with one pushed park commit", () => {
      const budget = loadRecording("budget-engine-cap").meta.testConfig?.["budgetTokens"] as number;
      return withRunOffice(
        {
          host: "replay",
          recording: "budget-engine-cap",
          checks: { ok: true },
          control: { caps: { budgetTokens: budget } },
        },
        async (r) => {
          const run = await startRun(r);
          await r.control?.idle();
          expect(parks(r).map((p) => [p.reason, p.from_state])).toEqual([
            ["budget-exceeded", "In Progress"],
          ]);
          expect(parks(r)[0]?.detail).toContain("token budget reached");
          // One park commit on top of the claim commit, on the branch and on origin.
          expect((await r.repo.git("log", "--format=%s", "-n", "2", BRANCH)).trim()).toBe(
            "TASK-1: status Parked\nTASK-1: status In Progress",
          );
          const remote = await r.repo.git("ls-remote", "--heads", "origin", BRANCH);
          expect(remote.split("\t")[0]).toBe(await tip(r, BRANCH));
          const changed = await r.repo.git("diff", "--name-only", `${BRANCH}~1`, BRANCH);
          expect(changed.trim().split("\n")).toHaveLength(1);
          expect(changed).toContain("backlog/tasks/");
          const view = await viewIn(r, worktreeOf(r, run));
          expect(view).toMatch(/^Status: \S+ Parked$/m);
          expect(view).toContain('reason: "budget-exceeded"');
          expect(view).toContain('from: "In Progress"');
          expect(r.sent[0]?.length).toBe(4);
          expect(runIntents(r.office, run as never).map((i) => i.kind)).toEqual(["cap"]);
        },
      );
    }, 30_000);

    it(
      "work.stop parks stopped with the note, keeping branch and worktree",
      () =>
        withRunOffice({ host: "stub", checks: { ok: true }, control: {} }, async (r) => {
          const run = await startRun(r);
          const reply = await command(r, "work.stop", { story: "TASK-1", note: "Not now." });
          if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`);
          expect(parks(r).map((p) => [p.reason, p.detail])).toEqual([["stopped", "Not now."]]);
          expect((await r.repo.git("log", "--format=%s", "-n", "1", BRANCH)).trim()).toBe(
            "TASK-1: status Parked",
          );
          const worktree = worktreeOf(r, run);
          expect(await viewIn(r, worktree)).toContain('reason: "stopped"');
          const worktrees = await r.repo.git("worktree", "list", "--porcelain");
          expect(worktrees).toContain(`branch refs/heads/${BRANCH}`);
          // A second stop finds no running worker.
          const again = await command(r, "work.stop", { story: "TASK-1" });
          expect(again.ok ? "ok" : again.error.code).toBe("story.notRunning");
        }),
      30_000,
    );

    it(
      "a changed .git pointer parks scope-violation and runs no git in the worktree",
      () =>
        withRunOffice({ host: "stub", checks: { ok: true }, control: {} }, async (r) => {
          const run = await startRun(r);
          const before = await tip(r, BRANCH);
          const pointer = join(worktreeOf(r, run), ".git");
          writeFileSync(pointer, `${readFileSync(pointer, "utf8").trim()}/../x\n`);
          const reply = await command(r, "work.stop", { story: "TASK-1" });
          expect(reply.ok).toBe(true);
          expect(parks(r).map((p) => p.reason)).toEqual(["scope-violation"]);
          expect(parks(r)[0]?.detail).toContain("dipo runs no git in that worktree");
          expect(await tip(r, BRANCH)).toBe(before);
        }),
      30_000,
    );
  });
}
