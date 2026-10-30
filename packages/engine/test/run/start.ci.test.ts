// CI only (0017 section 1): the worker start of a claimed run on real git with a bare `origin` and
// the pinned Backlog CLI (DIPO-74 test plan, AC #9 and #10). Setup is stubbed (DIPO-39 has its own
// tests) and the launch checks are DIPO-43's hold gate with scripted outcomes, so no `claude`
// process ever starts:
// - with the worker start stubbed, `work.run` creates the branch named in the field block and the
//   claim commit, and no worktree (DIPO-349), and stops before any worker starts;
// - with the `success-single` recording replayed through FakeProcess in an in-process worker host,
//   the story is claimed with one claim commit, the run emits `work.assigned`, `work.phase setup`
//   and `work.phase build`, and the replay's usage is ingested;
// - a failed sandbox self-test deletes the new branch, keeps the story Ready
//   and holds the adapter;
// - `work.preview` changes no fact, branch, worktree or run.
// Each case needs several CLI calls, an office load, a fetch and a claim, well over the local
// per-test budget; the same rules run locally against fakes in start.test.ts.

import { describe, expect, it } from "bun:test";

import { type CommandReply, type ReadReply, RequestId } from "@dipsaus-orchestrator/contract";

import { cursorAt } from "../../src/changelog/log";
import { replay } from "../../src/changelog/replay";
import { executeCommand } from "../../src/commands/execute";
import { createSystemIds } from "../../src/platform/ids";
import { executeRead } from "../../src/reads/execute";
import type { LaunchCheckOutcome } from "../../src/workers/hold";
import { countRows } from "../commands/helpers";
import { CLI } from "../gate/gated-office";
import { resultOf } from "../office/helpers";
import { BRANCH, CLAUDE, type Running, withRunOffice } from "./run-office";

let count = 0;
function requestId(): RequestId {
  count += 1;
  return RequestId.parse(`01J9ZK5Q8W3V4X6Y7Z${(70_000 + count).toString().padStart(8, "0")}`);
}

function workRunCommand(r: Running): Promise<CommandReply> {
  // Run ids are ULIDs, as the worker host requires.
  return executeCommand(
    { ...r.s.deps, ids: createSystemIds(r.s.clock) },
    {
      requestId: requestId(),
      name: "work.run",
      args: { from: r.repo.dir },
      origin: "cli",
      confirmed: false,
      office: r.officeId,
    },
  );
}

function workPreview(r: Running): Promise<ReadReply> {
  return executeRead(
    { registry: r.s.deps.registry, offices: r.s.deps.offices, clock: r.s.clock },
    { requestId: requestId(), name: "work.preview", args: { office: r.officeId } },
  );
}

function events(r: Running): { type: string; delta: Record<string, unknown> }[] {
  const result = replay(r.office, cursorAt(r.officeId, 0));
  if (!result.ok) throw new Error(result.error.message);
  return result.entries.map(({ type, delta }) => ({
    type,
    delta: delta as Record<string, unknown>,
  }));
}

/** Branches, worktrees and the base's view of TASK-1, to compare before and after. */
async function gitState(r: Running): Promise<string> {
  const refs = await r.repo.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads");
  const remote = await r.repo.git("ls-remote", "--heads", "origin");
  const worktrees = await r.repo.git("worktree", "list", "--porcelain");
  return [refs, remote, worktrees].join("\n---\n");
}

const READY: LaunchCheckOutcome = { ok: true };

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("the worker start on real git and the Backlog CLI", () => {
    it(
      "creates the branch and the claim commit, no worktree, and stops before any worker starts",
      () =>
        withRunOffice({ host: "stub", checks: READY }, async (r) => {
          const result = resultOf<{ started: { story: string; run: string }[] }>(
            await workRunCommand(r),
          );
          expect(result.started.map((s) => s.story)).toEqual(["TASK-1"]);
          const runId = result.started[0]?.run as string;

          const log = await r.repo.git("log", "--format=%s", BRANCH, "-n", "1");
          expect(log.trim()).toBe("TASK-1: status In Progress");
          const main = await r.repo.git("rev-parse", "origin/main");
          expect((await r.repo.git("rev-parse", `${BRANCH}~1`)).trim()).toBe(main.trim());
          const worktrees = await r.repo.git("worktree", "list", "--porcelain");
          expect(worktrees).not.toContain(`/TASK-1\n`);
          expect(worktrees).not.toContain(`locked dipo ${runId}`);
          // The worker start was stubbed: it got the plan and nothing ran.
          expect(r.hosts.map((h) => h.runId)).toEqual([runId]);
          expect(r.hosts[0]?.plan.argv[0]).toBe(CLAUDE);
        }),
      30_000,
    );

    it(
      "replays success-single through FakeProcess: In Progress, setup and build phases, usage ingested",
      () =>
        withRunOffice({ host: "replay", checks: READY }, async (r) => {
          const result = resultOf<{ started: { story: string; run: string }[] }>(
            await workRunCommand(r),
          );
          expect(result.started.map((s) => s.story)).toEqual(["TASK-1"]);
          const commits = await r.repo.git("rev-list", "--count", `origin/main..${BRANCH}`);
          expect(commits.trim()).toBe("1");
          const phases = events(r)
            .filter((e) => e.type === "work.assigned" || e.type === "work.phase")
            .map((e) => (e.type === "work.phase" ? `phase ${String(e.delta["phase"])}` : e.type));
          expect(phases).toEqual(["work.assigned", "phase setup", "phase build"]);
          const usage = r.office.get<{ n: number; input: number }>(
            "select count(*) as n, sum(input) as input from usage_totals where office_id = $office_id",
          );
          expect(usage?.n).toBeGreaterThan(0);
          expect(usage?.input).toBeGreaterThan(0);
        }),
      30_000,
    );

    it(
      "rolls back a failed sandbox self-test: branch deleted, story Ready, adapter held",
      () =>
        withRunOffice(
          {
            host: "stub",
            checks: {
              ok: false,
              failures: [{ check: "self-test", detail: "the worker wrote into <main>/.git" }],
            },
          },
          async (r) => {
            const before = await gitState(r);
            const result = resultOf<{ started: unknown[]; skipped: { reason: string }[] }>(
              await workRunCommand(r),
            );
            expect(result.started).toEqual([]);
            expect(result.skipped.map((s) => s.reason)).toEqual(["pickupCheckFailed"]);
            expect(await gitState(r)).toBe(before);
            expect(r.hosts).toEqual([]);
            expect(r.holds.adapterHeld("claude-cli")?.check).toBe("self-test");
            const status = await r.repo.run(
              [...CLI(r.repo).command, "task", "view", "TASK-1", "--plain"],
              r.repo.dir,
            );
            expect(status.stdout).toContain("Status: ○ Ready");
            expect(countRows(r.office, "runs")).toBe(0);
          },
        ),
      30_000,
    );

    it(
      "dry-runs without changing any fact, branch, worktree or run",
      () =>
        withRunOffice({ host: "stub", checks: READY }, async (r) => {
          const tables = ["claims", "runs", "agents", "gate_decisions", "change_log", "stories"];
          const rows = () => tables.map((table) => countRows(r.office, table));
          const factsBefore = rows();
          const gitBefore = await gitState(r);
          const reply = await workPreview(r);
          if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`);
          const preview = reply.result as {
            story: { story: string } | null;
            launch: { branch: string; argv: string[] } | null;
          };
          expect(preview.story?.story).toBe("TASK-1");
          expect(preview.launch?.branch).toBe(BRANCH);
          expect(preview.launch?.argv[0]).toBe(CLAUDE);
          expect(rows()).toEqual(factsBefore);
          expect(await gitState(r)).toBe(gitBefore);
          expect(r.hosts).toEqual([]);
        }),
      30_000,
    );
  });
}
