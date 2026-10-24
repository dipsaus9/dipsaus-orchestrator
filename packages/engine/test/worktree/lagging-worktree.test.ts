// A box run's Mac worktree that only lags its branch (DIPO-332, after DIPO-302), on real git with
// a bare remote and the scripted Backlog CLI of the reconcile helpers. The branch moves as a box
// run moves it: parts and dipo's own commits made outside the claim's worktree and put on the
// branch with `update-ref`, while dipo's task-file commits also write the task file in the worktree.
// So the worktree holds the claim's code files and a later task file. The Done teardown and the
// done-elsewhere release remove such a worktree, and keep one with a change only it holds.
//
// Two cases stay local: a real local edit, and the entries git status cannot judge. The rest is in
// lagging-worktree.ci.test.ts (CI only, DIPO-225).

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { git as gitIn } from "@dipsaus-orchestrator/testkit";

import { OFFICE_DEFAULTS } from "../../src/config";
import type { OfficeGit } from "../../src/git/office";
import { StoryTeardown } from "../../src/worktree/done";
import { unlaggedPaths } from "../../src/worktree/lagging";
import { type ClaimRecord, liveClaimOf } from "../../src/worktree/records";
import { TEARDOWN_NOTICES } from "../../src/worktree/teardown";
import { squashMergeOnRemote } from "../backlog/lane/helpers";
import {
  claim,
  editWorktree,
  type FakeTask,
  fakeBacklog,
  keyOf,
  noticesAfter,
  type ReconcileOffice,
  withReconcileOffice,
} from "../reconcile/helpers";
import { lastSeq } from "../stories/helpers";

function gitOf(o: ReconcileOffice): OfficeGit {
  const git = o.engineGit.forOffice(o.officeId);
  if (git === undefined) throw new Error("the office git is not attached");
  return git;
}

/** Code files (and `extra` ones) on the base before the claim, pushed and fetched. */
async function seedBase(
  o: ReconcileOffice,
  extra: Readonly<Record<string, string>> = {},
): Promise<void> {
  const files: Record<string, string> = {
    "src/shared.ts": "export const shared = 1;\n",
    "src/old.ts": "export const old = 1;\n",
    ...extra,
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(o.repo.dir, path)), { recursive: true });
    writeFileSync(join(o.repo.dir, path), text);
  }
  await o.repo.git("add", "--all");
  await o.repo.git("commit", "--quiet", "--no-verify", "-m", "Seed the code");
  await o.repo.git("push", "--quiet", "origin", "main");
  await o.repo.git("fetch", "--quiet", "origin");
}

async function tipOf(o: ReconcileOffice, ref: string): Promise<string | null> {
  const result = await o.repo.run(["git", "rev-parse", "--verify", "--quiet", ref], o.repo.dir);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/**
 * Commits on the story branch as dipo commits a box part or its own commit: in a scratch checkout
 * of the tip, never in the claim's worktree, then `update-ref` from the tip. A null content
 * deletes the file; `task` also writes the story's task file there. Returns the new tip.
 */
async function onBranch(
  o: ReconcileOffice,
  record: ClaimRecord,
  message: string,
  files: Readonly<Record<string, string | null>>,
  task?: FakeTask,
): Promise<string> {
  const ref = `refs/heads/${record.branch}`;
  const tip = (await tipOf(o, ref)) ?? "";
  const scratch = join(o.repo.root, "scratch");
  await o.repo.git("worktree", "add", "--quiet", "--detach", scratch, tip);
  try {
    for (const [path, text] of Object.entries(files)) {
      const full = join(scratch, path);
      if (text === null) rmSync(full);
      else {
        await o.repo.run(["mkdir", "-p", join(full, "..")]);
        writeFileSync(full, text);
      }
    }
    if (task !== undefined) editWorktree({ worktree: scratch }, task);
    for (const args of [
      ["git", "add", "--all"],
      ["git", "commit", "--quiet", "--no-verify", "-m", message],
    ] as const) {
      const done = await o.repo.run(args, scratch);
      if (done.exitCode !== 0) throw new Error(`${args.join(" ")}: ${done.stderr}`);
    }
    const commit = (await o.repo.run(["git", "rev-parse", "HEAD"], scratch)).stdout.trim();
    await o.repo.git("update-ref", ref, commit, tip);
    return commit;
  } finally {
    await o.repo.git("worktree", "remove", "--force", scratch);
  }
}

/** The story's task file path in the worktree. */
async function taskPath(o: ReconcileOffice, record: ClaimRecord): Promise<string> {
  const out = await o.repo.run(["git", "ls-files", "--", "backlog/tasks"], record.worktree);
  const path = out.stdout.split("\n").find((line) => line.toLowerCase().includes("task-1 - "));
  if (path === undefined) throw new Error("no task file");
  return path;
}

/**
 * dipo's task-file commit: on the branch from its own copy, and the worktree's index entry and
 * file of the task file brought up to it (`commitFromCopy`), nothing else in the worktree.
 */
async function statusCommit(
  o: ReconcileOffice,
  record: ClaimRecord,
  status: string,
): Promise<string> {
  const commit = await onBranch(
    o,
    record,
    `TASK-1: status ${status}`,
    {},
    { id: "TASK-1", status },
  );
  const path = await taskPath(o, record);
  const done = await o.repo.run(["git", "checkout", commit, "--", path], record.worktree);
  if (done.exitCode !== 0) throw new Error(done.stderr);
  return commit;
}

/**
 * A box run as the live gap had it: two parts (a new file, a change, a deletion), the In Review
 * commit that also writes the worktree's task file, and the close-out commit that does not.
 */
async function boxRun(o: ReconcileOffice, record: ClaimRecord): Promise<string> {
  await onBranch(o, record, "TASK-1: part 1", {
    "src/feature.ts": "export const feature = 1;\n",
    "src/shared.ts": "export const shared = 2;\n",
  });
  await onBranch(o, record, "TASK-1: part 2", {
    "src/feature.ts": "export const feature = 2;\n",
    "src/old.ts": null,
  });
  await statusCommit(o, record, "In Review");
  return onBranch(o, record, "TASK-1: close out", {}, { id: "TASK-1", status: "Done" });
}

function pollOf(o: ReconcileOffice): StoryTeardown {
  const teardown = new StoryTeardown({
    git: () => gitOf(o),
    host: null,
    cli: { spawn: fakeBacklog(o.tables).spawn },
    offices: { get: () => o.office, config: () => OFFICE_DEFAULTS },
    statusOf: async () => "Done",
  });
  teardown.track(o.officeId as OfficeId, o.office, o.s.clock);
  return teardown;
}

/** A claim of TASK-1 with its run ended, on a base with code files. */
async function claimed(
  o: ReconcileOffice,
  extra: Readonly<Record<string, string>> = {},
): Promise<ClaimRecord> {
  await seedBase(o, extra);
  return claim(o, o.office, "TASK-1", keyOf(o.office, "TASK-1"), { active: false });
}

/** The unlagged paths of the claim's worktree, through the office git. */
function unlagged(o: ReconcileOffice, record: ClaimRecord): Promise<string[] | null> {
  const git = gitOf(o);
  return git.run((session) => unlaggedPaths(git, session, record));
}

describe("a box run's worktree that only lags its branch (DIPO-332)", () => {
  it("is kept with a real local edit, the notice naming only that file", () =>
    withReconcileOffice({}, async (o) => {
      const record = await claimed(o);
      const tip = await boxRun(o, record);
      writeFileSync(join(record.worktree, "src/shared.ts"), "export const shared = 99;\n");
      expect(await unlagged(o, record)).toEqual(["src/shared.ts"]);
      await o.repo.git("push", "--quiet", "origin", record.branch);
      await squashMergeOnRemote(o.repo, record.branch);
      await o.repo.git("fetch", "--quiet", "origin");
      const seq = lastSeq(o.office);

      const teardown = pollOf(o);
      const report = await teardown.poll(o.officeId as OfficeId);
      teardown.stop();

      expect(report.kept.map((c) => c.runId)).toEqual([record.runId]);
      expect(existsSync(join(record.worktree, "src/shared.ts"))).toBe(true);
      expect(await tipOf(o, `refs/heads/${record.branch}`)).toBe(tip);
      expect(liveClaimOf(o.office, record.key)).not.toBeNull();
      const kept = noticesAfter(o.office, seq).filter((n) => n.code === TEARDOWN_NOTICES.kept);
      expect(kept).toHaveLength(1);
      expect(kept[0]?.text).toContain("Files git lists there: src/shared.ts.");
      expect(kept[0]?.text).not.toContain("src/feature.ts");
    }));
});

describe("what git status does not list keeps the worktree (DIPO-332 review)", () => {
  it("cannot judge assume-unchanged, skip-worktree or unmerged entries, and compares links as links", () =>
    withReconcileOffice({}, async (o) => {
      const record = await claimed(o, { "lib/a.ts": "export const a = 1;\n" });
      await boxRun(o, record);
      const wt = record.worktree;
      const run = (...args: string[]) => gitIn(wt, o.repo.home, ...args);
      expect(await unlagged(o, record)).toEqual([]);

      await run("update-index", "--assume-unchanged", "src/shared.ts");
      expect(await unlagged(o, record)).toBeNull();
      await run("update-index", "--no-assume-unchanged", "src/shared.ts");
      await run("update-index", "--skip-worktree", "src/shared.ts");
      expect(await unlagged(o, record)).toBeNull();
      await run("update-index", "--no-skip-worktree", "src/shared.ts");
      expect(await unlagged(o, record)).toEqual([]);

      // A link the commits do not have, and a tracked folder replaced by a link to a copy of it:
      // the link is never followed, so the file below it is absent, as git reads it.
      symlinkSync("shared.ts", join(wt, "src/link.ts"));
      expect(await unlagged(o, record)).toEqual(["src/link.ts"]);
      rmSync(join(wt, "src/link.ts"));
      const copy = join(o.repo.root, "lib-copy");
      mkdirSync(copy);
      writeFileSync(join(copy, "a.ts"), "export const a = 1;\n");
      rmSync(join(wt, "lib"), { recursive: true });
      symlinkSync(copy, join(wt, "lib"));
      expect((await unlagged(o, record))?.toSorted()).toEqual(["lib", "lib/a.ts"]);
      rmSync(join(wt, "lib"));
      await run("checkout", "--", "lib");
      expect(await unlagged(o, record)).toEqual([]);

      // Unmerged index entries for one path.
      const blob = (await run("rev-parse", `${record.startSha}:src/shared.ts`)).trim();
      const info = Bun.spawn(["git", "update-index", "--index-info"], {
        cwd: wt,
        env: o.repo.env,
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
      });
      info.stdin.write(
        [
          `0 ${"0".repeat(40)}\tsrc/shared.ts`,
          ...[1, 2, 3].map((stage) => `100644 ${blob} ${stage}\tsrc/shared.ts`),
          "",
        ].join("\n"),
      );
      await info.stdin.end();
      expect(await info.exited).toBe(0);
      expect(await unlagged(o, record)).toBeNull();
    }));
});
