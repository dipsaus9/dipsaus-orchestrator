// CI only (0017 section 1): verify and commit on real git with a bare `origin` and the pinned
// Backlog CLI (DIPO-49 test plan). Each case claims TASK-1 (scope `packages/export/`) with
// `work.run` and replays `success-single` (a `done` report marking criterion 1 met); before the
// worker starts, the test writes what the worker would have written in the worktree:
// - in-scope code, a `package.json` and the `bun.lock` beside it: green verify gives one code
//   commit and one `TASK-1: status In Review` commit, pushed to `origin`, criterion 1 checked;
// - a file outside scope: the story parks `scope-violation` naming it, nothing is committed;
// - a commit of its own: the backstop after the turn parks `scope-violation` (HEAD moved).
// The sandboxed verify step is a fake here (the sandbox has its own CI tests); each case needs an
// office load, a fetch, a claim, CLI calls and pushes, well over the local per-test budget. The
// same rules run locally against fakes in verify-commit.test.ts.

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type CommandReply, RequestId } from "@dipsaus-orchestrator/contract";

import { executeCommand } from "../../src/commands/execute";
import { createSystemIds } from "../../src/platform/ids";
import { runOutcome, runSummary, verifyResults } from "../../src/run";
import { detect } from "../../src/scan/detect";
import { CLI } from "../gate/gated-office";
import { resultOf } from "../office/helpers";
import { BRANCH, type Running, withRunOffice } from "./run-office";

const PROFILE = detect({
  texts: { "package.json": JSON.stringify({ name: "fixture", scripts: { verify: "bun test" } }) },
  lockfiles: ["bun.lock"],
  workspaceDirs: [],
  configImports: {},
  envFiles: [],
});

let count = 0;
function requestId(): RequestId {
  count += 1;
  return RequestId.parse(`01J9ZK5Q8W3V4X6Y7Z${(90_000 + count).toString().padStart(8, "0")}`);
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
  await r.control?.idle();
  return result.started[0]?.run as string;
}

function parks(r: Running): { reason: string; detail: string }[] {
  return r.office.all("select reason, detail from parks where office_id = $office_id");
}

function worktreeOf(r: Running, run: string): string {
  const row = r.office.get<{ worktree: string }>(
    "select worktree from runs where office_id = $office_id and run_id = $run",
    { run },
  );
  if (row === null) throw new Error(`no run ${run}`);
  return row.worktree;
}

function write(worktree: string, path: string, text: string): void {
  mkdirSync(join(worktree, path, ".."), { recursive: true });
  writeFileSync(join(worktree, path), text);
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("verify and commit on real git and the Backlog CLI", () => {
    it(
      "green: one code commit with the paired lockfile, one In Review commit, pushed",
      () =>
        withRunOffice(
          {
            host: "replay",
            checks: { ok: true },
            control: {},
            finisher: {
              profile: PROFILE,
              beforeWorker: (worktree) => {
                write(worktree, "packages/export/csv.ts", "export const csv = 1;\n");
                write(worktree, "packages/export/package.json", '{ "name": "export" }\n');
                write(worktree, "packages/export/bun.lock", "{}\n");
              },
            },
          },
          async (r) => {
            const run = await startRun(r);
            expect(parks(r)).toEqual([]);
            const log = (await r.repo.git("log", "--format=%s", "-n", "3", BRANCH)).trim();
            const [inReview, code, claim] = log.split("\n");
            expect(inReview).toBe("TASK-1: status In Review");
            expect(code?.startsWith("TASK-1: ")).toBe(true);
            expect(claim).toBe("TASK-1: status In Progress");
            const files = await r.repo.git("show", "--name-only", "--format=", `${BRANCH}~1`);
            expect(files.trim().split("\n").toSorted()).toEqual([
              "packages/export/bun.lock",
              "packages/export/csv.ts",
              "packages/export/package.json",
            ]);
            const status = await r.repo.git("show", "--name-only", "--format=", BRANCH);
            expect(status.trim().split("\n")).toHaveLength(1);
            expect(status).toContain("backlog/tasks/");
            const remote = await r.repo.git("ls-remote", "--heads", "origin", BRANCH);
            expect(remote.split("\t")[0]).toBe((await r.repo.git("rev-parse", BRANCH)).trim());
            const view = await r.repo.run(
              [...CLI(r.repo).command, "task", "view", "TASK-1", "--plain"],
              worktreeOf(r, run),
            );
            expect(view.stdout).toMatch(/^Status: \S+ In Review$/m);
            expect(view.stdout).toContain("- [x] #1");
            expect(verifyResults(r.office, run as never)[0]?.codeTreeKey).toMatch(/^[0-9a-f]{64}$/);
            expect(runOutcome(r.office, run as never)?.outcome).toBe("in-review");
            expect(runSummary(r.office, run as never)?.diffstat).toContain(
              "packages/export/csv.ts",
            );
          },
        ),
      60_000,
    );

    it(
      "a file outside scope parks scope-violation and commits nothing",
      () =>
        withRunOffice(
          {
            host: "replay",
            checks: { ok: true },
            control: {},
            finisher: {
              profile: PROFILE,
              beforeWorker: (worktree) => {
                write(worktree, "packages/export/csv.ts", "export const csv = 1;\n");
                write(worktree, "README.md", "changed\n");
              },
            },
          },
          async (r) => {
            await startRun(r);
            expect(parks(r).map((p) => [p.reason, p.detail])).toEqual([
              [
                "scope-violation",
                "Paths written outside the declared scope: README.md. Declared scope: packages/export/.",
              ],
            ]);
            expect((await r.repo.git("log", "--format=%s", "-n", "2", BRANCH)).trim()).toBe(
              "TASK-1: status Parked\nTASK-1: status In Progress",
            );
          },
        ),
      60_000,
    );

    it(
      "a worker turn that moves HEAD parks scope-violation",
      () =>
        withRunOffice(
          {
            host: "replay",
            checks: { ok: true },
            control: {},
            finisher: {
              profile: PROFILE,
              beforeWorker: async (worktree) => {
                write(worktree, "packages/export/csv.ts", "export const csv = 1;\n");
                const proc = Bun.spawn(
                  [
                    "git",
                    "-c",
                    "user.name=w",
                    "-c",
                    "user.email=w@example.com",
                    "commit",
                    "-q",
                    "--no-verify",
                    "-am",
                    "worker commit",
                    "--allow-empty",
                  ],
                  { cwd: worktree, stdout: "ignore", stderr: "ignore" },
                );
                await proc.exited;
              },
            },
          },
          async (r) => {
            await startRun(r);
            expect(parks(r).map((p) => p.reason)).toEqual(["scope-violation"]);
            expect(parks(r)[0]?.detail).toContain("HEAD moved from");
          },
        ),
      60_000,
    );
  });
}
