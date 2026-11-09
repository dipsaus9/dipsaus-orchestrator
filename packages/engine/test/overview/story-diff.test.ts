// `story.diff` (DIPO-462): the diff of the story's newest run branch against the base, for the story
// reader's Diff section; `branchDiff` reads it with git, three-dot as the PR shows it.

import { describe, expect, it } from "bun:test";

import { DIFF_MAX_BYTES, RequestId } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { buildRegistry } from "../../src/commands/registry";
import type { OfficeHandle } from "../../src/db/office";
import type { GitResult } from "../../src/git/runner";
import type { OfficeGit } from "../../src/git/office";
import { executeRead } from "../../src/reads/execute";
import { type BranchDiffSource, viewsFeatureWith } from "../../src/overview/feature";
import { branchDiff } from "../../src/story-pr/git";
import { addOffice, openTestState } from "../commands/helpers";
import { pass, task } from "../stories/helpers";
import { startRun } from "../views/helpers";
import { backlogLayout } from "../story-store/backlog";

async function readDiff(source: BranchDiffSource | undefined, withBranch: boolean) {
  return withTempDir(async (dir) => {
    const t = await openTestState(dir);
    try {
      const office: OfficeHandle = addOffice(t);
      pass(t, office, [task("TASK-1", { status: "In Progress" })]);
      if (withBranch) startRun(t, office, "TASK-1", dir);
      const reply = await executeRead(
        {
          registry: buildRegistry([
            viewsFeatureWith({ stories: backlogLayout }, undefined, source),
          ]),
          offices: { get: () => office, load: async () => ({ ok: true, office }) },
          clock: t.clock,
        },
        {
          requestId: RequestId.parse("01J9ZK5Q8W3V4X6Y7Z00000001"),
          name: "story.diff",
          args: { office: office.officeId, story: "TASK-1" },
        },
      );
      if (!reply.ok) throw new Error(reply.error.message);
      return reply.result as Record<string, unknown>;
    } finally {
      t.state.close();
    }
  });
}

describe("story.diff", () => {
  it("returns the story branch's diff from the source", async () => {
    const asked: string[] = [];
    const result = await readDiff(async (_office, branch, max) => {
      asked.push(`${branch} ${max}`);
      return { base: "main", diff: "diff --git a/x b/x\n+one\n", truncated: false };
    }, true);
    expect(asked).toEqual([`TASK-1/work ${DIFF_MAX_BYTES}`]);
    expect(result).toEqual({
      branch: "TASK-1/work",
      base: "main",
      diff: "diff --git a/x b/x\n+one\n",
      truncated: false,
    });
  });

  it("says why there is no diff", async () => {
    expect(await readDiff(async () => null, false)).toMatchObject({
      branch: null,
      diff: "",
      unavailable: "the story has no branch yet",
    });
    expect(await readDiff(async () => null, true)).toMatchObject({
      branch: "TASK-1/work",
      unavailable: "git could not read the branch against the base",
    });
  });
});

async function git(cwd: string, ...args: string[]): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr } as unknown as GitResult;
}

describe("branchDiff", () => {
  it("reads what the branch changes against the base, and cuts a long diff", async () => {
    await withTempDir(async (dir) => {
      const run = (...args: string[]) =>
        git(dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args);
      await run("init", "-q", "-b", "main");
      await Bun.write(`${dir}/a.txt`, "base\n");
      await run("add", "a.txt");
      await run("commit", "-q", "-m", "base");
      await run("checkout", "-q", "-b", "TASK-1/work");
      await Bun.write(`${dir}/a.txt`, "base\nchanged\n");
      await run("commit", "-q", "-am", "change");
      const session = {
        repository: { path: dir },
        step: (_location: unknown, args: readonly string[]) => run(...args),
      };
      const office = {
        settings: { remote: "origin" },
        resolveBaseIn: async () => "main",
        run: (fn: (s: typeof session) => unknown) => fn(session),
      } as unknown as OfficeGit;
      const whole = await branchDiff(office, "TASK-1/work", 100_000);
      expect(whole?.base).toBe("main");
      expect(whole?.truncated).toBe(false);
      expect(whole?.diff).toContain("+changed");
      const cut = await branchDiff(office, "TASK-1/work", 20);
      expect(cut?.truncated).toBe(true);
      expect(cut?.diff.length).toBeLessThanOrEqual(20);
      expect(await branchDiff(office, "no/such", 1000)).toBeNull();
    });
  });
});
