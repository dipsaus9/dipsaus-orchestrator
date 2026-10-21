// Every Backlog CLI call dipo makes for a story runs in a folder that holds no file a worker wrote,
// with a minimal, explicit environment (DIPO-270; 0021 section 14). Arbitrary files are put into
// the story's worktree, at its root and in its `backlog/` folders, the way a worker could deliver
// them. Then the claim, In Review, park, unpark and lane paths run on real git and the pinned
// Backlog CLI through a recording `Spawn`, and every call is checked: its working folder is not the
// worktree, holds only dipo's own copy of the backlog and none of those files, and its environment
// holds only the explicit keys, not a variable of the caller's environment.

import { describe, expect, it } from "bun:test";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";

import type { Spawn } from "@dipsaus-orchestrator/contract";
import { git, withTempRepo } from "@dipsaus-orchestrator/testkit";

import { EDIT_KIND, editKind, OfficeLane } from "../../src/backlog/lane";
import { BACKLOG_ENV_KEYS, type BacklogCli } from "../../src/backlog/runner";
import { GitError } from "../../src/git";
import { systemSpawn } from "../../src/platform/process";
import { gitParkWriter, gitUnparkWriter } from "../../src/run/park";
import { gitStoryOps } from "../../src/run/story-git";
import { claimStory, type ClaimOutcome } from "../../src/worktree";
import { BACKLOG_FOLDER_ERROR } from "../../src/worktree/claim";
import {
  BACKLOG_FIXTURE,
  BRANCH_1,
  claimSetup,
  publish,
  TASK_1,
  TASK_FILE_1,
} from "../worktree/helpers";

import { BACKLOG_CLI } from "./helpers";

const FIXTURE = { fixture: BACKLOG_FIXTURE };

/** Files a worker could write into its worktree: dotfiles and config-looking files. */
const DELIVERED = [
  ".worker-rc",
  "worker.config.json",
  "backlog/.worker-rc",
  "backlog/worker.config.json",
  "backlog/tasks/.worker-rc",
  "backlog/tasks/worker.config.yml",
];

/** A variable of the caller's environment that must not reach the CLI. */
const CALLER_ONLY = "DIPO_CALLER_ONLY";

interface CliCall {
  readonly args: readonly string[];
  /** The real path of the working folder. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>> | undefined;
  /** Every file under `cwd` when the call started, relative to it. */
  readonly files: readonly string[];
}

function filesUnder(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    return entry.isDirectory() ? filesUnder(dir, path) : [path];
  });
}

/** The CLI on the fixture, recording each call, with a caller environment holding more keys. */
function recordingCli(env: Readonly<Record<string, string>>): {
  cli: BacklogCli;
  calls: CliCall[];
} {
  const calls: CliCall[] = [];
  const spawn: Spawn = (options) => {
    calls.push({
      args: options.cmd.slice(BACKLOG_CLI.length),
      cwd: realpathSync(options.cwd ?? ""),
      env: options.env,
      files: filesUnder(options.cwd ?? "").toSorted(),
    });
    return systemSpawn(options);
  };
  return { cli: { spawn, command: BACKLOG_CLI, env: { ...env, [CALLER_ONLY]: "1" } }, calls };
}

function inside(path: string, dir: string): boolean {
  const rel = relative(realpathSync(dir), path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Puts the delivered files into the worktree. */
function deliver(worktree: string): void {
  for (const path of DELIVERED) {
    mkdirSync(join(worktree, path, ".."), { recursive: true });
    writeFileSync(join(worktree, path), "written by the worker\n");
  }
}

/** Each call ran outside the worktree, on dipo's copy only, with only the explicit keys. */
function expectClean(calls: readonly CliCall[], worktree: string, only?: readonly string[]): void {
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(inside(call.cwd, worktree)).toBe(false);
    for (const path of DELIVERED) expect(call.files).not.toContain(path);
    if (only !== undefined) expect(call.files).toEqual(only);
    expect(Object.keys(call.env ?? {}).toSorted()).toEqual([...BACKLOG_ENV_KEYS].toSorted());
    expect(call.env?.[CALLER_ONLY]).toBeUndefined();
  }
}

function claimed(outcome: ClaimOutcome): Extract<ClaimOutcome, { ok: true }> {
  if (!outcome.ok)
    throw new Error(`expected a claim, got the skip ${outcome.reason}: ${outcome.notice}`);
  return outcome;
}

async function statusAt(dir: string, home: string, ref: string): Promise<string> {
  const text = await git(dir, home, "show", `${ref}:${TASK_FILE_1}`);
  return /^status: (.*)$/m.exec(text)?.[1] ?? "";
}

describe("the Backlog CLI for a story runs in a folder without worker-written files", () => {
  it("claims, marks In Review, parks and unparks with files a worker delivered in the worktree", async () => {
    await withTempRepo(async (repo) => {
      // Git ignores the delivered files, so the claim's own scope check passes with them there.
      appendFileSync(join(repo.dir, ".git", "info", "exclude"), ".worker-rc\nworker.config.*\n");
      await publish(repo);
      const s = await claimSetup(repo);
      const { cli, calls } = recordingCli(repo.env);
      const copy = ["backlog/config.yml", TASK_FILE_1];

      // The claim: the files are delivered during setup, before the claim commit.
      let worktree = "";
      const outcome = claimed(
        await claimStory(s.deps({ cli }), {
          ...s.request(s.key()),
          setup: async (claim) => {
            worktree = claim.worktree;
            deliver(claim.worktree);
            return { ok: true, release: () => {} };
          },
        }),
      );
      expect(outcome.claim.worktree).toBe(worktree);
      expectClean(calls, worktree, copy);
      expect(await statusAt(repo.dir, repo.home, BRANCH_1)).toBe("In Progress");

      // In Review: the story's view and the criteria and status edit.
      calls.length = 0;
      const ops = gitStoryOps({ git: () => s.git, cli });
      const story = await ops.story(s.office.officeId, worktree, TASK_1);
      expect(story.taskFile).toBe(TASK_FILE_1);
      const review = await ops.markInReview(s.office.officeId, {
        worktree,
        story: TASK_1,
        taskFile: TASK_FILE_1,
        criteria: story.criteria,
      });
      expect(review).not.toBeNull();
      expectClean(calls, worktree, copy);
      expect(await statusAt(repo.dir, repo.home, BRANCH_1)).toBe("In Review");
      expect(readFileSync(join(worktree, TASK_FILE_1), "utf8")).toContain("- [x] #1");

      // The park and its lift.
      calls.length = 0;
      const deps = { git: () => s.git, cli };
      const park = await gitParkWriter(deps).write(s.office.officeId, {
        story: TASK_1,
        branch: BRANCH_1,
        worktree,
        reason: "stopped",
        note: "Not now.",
      });
      expect(park.commit).not.toBeNull();
      expect(await statusAt(repo.dir, repo.home, BRANCH_1)).toBe("Parked");
      await gitUnparkWriter(deps).lift(s.office.officeId, {
        story: TASK_1,
        branch: BRANCH_1,
        worktree,
        to: park.from,
      });
      expectClean(calls, worktree, copy);
      expect(await statusAt(repo.dir, repo.home, BRANCH_1)).toBe("In Review");

      // The delivered files are still where the worker put them, and no copy is left behind.
      for (const path of DELIVERED) expect(readFileSync(join(worktree, path), "utf8")).toBeTruthy();
      const root = s.git.worktreeRoot();
      for (const name of readdirSync(root)) expect(name).not.toStartWith("_branch-read-");
      for (const call of calls) expect(() => readdirSync(call.cwd)).toThrow();
    }, FIXTURE);
  });

  it("does not write the task file through a folder of the worktree that leads elsewhere", async () => {
    await withTempRepo(async (repo) => {
      await publish(repo);
      const s = await claimSetup(repo);
      const { cli } = recordingCli(repo.env);
      const { worktree } = claimed(await claimStory(s.deps({ cli }), s.request(s.key()))).claim;

      // The worktree's tasks folder now leads to a folder outside it.
      const outside = join(repo.root, "outside-tasks");
      cpSync(join(worktree, "backlog", "tasks"), outside, { recursive: true });
      renameSync(join(worktree, "backlog", "tasks"), join(worktree, "backlog", "tasks-moved"));
      symlinkSync(outside, join(worktree, "backlog", "tasks"));
      const before = readFileSync(join(repo.root, "outside-tasks", basename(TASK_FILE_1)));

      const ops = gitStoryOps({ git: () => s.git, cli });
      const error = await ops
        .markInReview(s.office.officeId, {
          worktree,
          story: TASK_1,
          taskFile: TASK_FILE_1,
          criteria: [1],
        })
        .then(
          () => null,
          (caught: unknown) => caught,
        );
      expect(error).toBeInstanceOf(GitError);
      expect((error as GitError).code).toBe(BACKLOG_FOLDER_ERROR);
      expect(readFileSync(join(repo.root, "outside-tasks", basename(TASK_FILE_1)))).toEqual(before);
      expect(await statusAt(repo.dir, repo.home, BRANCH_1)).toBe("In Progress");
    }, FIXTURE);
  });

  it("runs the lane's calls in dipo's backlog worktree, never a story worktree, with only the explicit keys", async () => {
    await withTempRepo(async (repo) => {
      await publish(repo);
      const s = await claimSetup(repo);
      const { worktree } = claimed(await claimStory(s.deps(), s.request(s.key()))).claim;
      deliver(worktree);
      const { cli, calls } = recordingCli(repo.env);
      const lane = new OfficeLane({
        officeId: s.office.officeId,
        office: s.office,
        git: s.git,
        cli,
        clock: s.t.clock,
        kinds: new Map([[EDIT_KIND, editKind(EDIT_KIND)]]),
      });
      await lane.submit({
        kind: EDIT_KIND,
        key: s.key(),
        subject: "TASK-2",
        target: { status: "Refined" },
      });
      expectClean(calls, worktree);
      for (const call of calls) expect(call.cwd).toBe(realpathSync(lane.worktreePath()));
    }, FIXTURE);
  });
});
