// Done detection and teardown (DIPO-58; 0010 section 7 "Merge and Done", "Teardown", the
// dirty-worktree failure case and open question 8; 0007 section 7 tier T), fast: a fake git
// executor that answers each git step by its arguments, a fake code host, a real state database
// and a minimal worktree layout on disk so the office git can name the worktree. The same rules
// against real repositories and a bare remote are in teardown.ci.test.ts.

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type OfficeId, RunId, StoryKey } from "@dipsaus-orchestrator/contract";
import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import type { FeatureModule } from "../../src/commands/registry";
import { OFFICE_DEFAULTS, type OfficeConfig } from "../../src/config";
import type { OfficeHandle } from "../../src/db/office";
import { type GitCall, type GitResult, OfficeGit } from "../../src/git";
import { HAND_MERGE_NOTE, mergeGate } from "../../src/merge-slot";
import type { OfficeLoadContext } from "../../src/office/steps";
import { GIT_STEP_DEADLINE_MS } from "../../src/git/runner";
import { CALL_DEADLINE_MS, KILL_GRACE_MS } from "../../src/platform/deadline";
import { CodeHostError, GhHost, type HostPr, type PrStateHost } from "../../src/platform/host";
import {
  type ClaimRecord,
  detectDone,
  DONE_RELEASE_REASON,
  findClaim,
  lockInList,
  SlotTable,
  StoryTeardown,
  TEARDOWN_NOTICES,
  TEARDOWN_STEP,
  tearDown,
} from "../../src/worktree";
import { insertClaim, markTeardownStarted } from "../../src/worktree/records";
import { notices } from "../backlog/lane/helpers";
import { hangingSpawn, settle as letCallsRun } from "../platform/hanging";
import { addOffice, openTestState, type TestState } from "../commands/helpers";

const START = "1".repeat(40);
const TIP = "2".repeat(40);
const BASE_TREE = "3".repeat(40);
const BRANCH = "TASK-1/add-csv";
const REMOTE_URL = "https://github.com/o/r.git";

type Reply = Partial<GitResult> | undefined;

/** The arguments after the hardened prefix (`--no-pager`, `-c k=v` pairs, `--bare`). */
function stepArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (out.length === 0 && (arg === "--no-pager" || arg === "--bare")) continue;
    if (out.length === 0 && arg === "-c") {
      i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

interface World {
  readonly t: TestState;
  readonly office: OfficeHandle;
  readonly git: OfficeGit;
  readonly worktree: string;
  readonly slots: SlotTable;
  /** Every git step, its arguments joined by spaces. */
  readonly steps: string[];
  /** Answers a step; undefined means exit 0 with no output. */
  /** The reply to a git step; `"hang"` makes the step never end (DIPO-314). */
  answer: (args: readonly string[]) => Reply | "hang";
  claim(): ClaimRecord;
}

/** Facts a default fake repository reports: remote, branch at TIP, base tree, our lock. */
function defaults(world: World, args: readonly string[]): Reply {
  const line = args.join(" ");
  if (line.startsWith("config --get remote.origin.url")) return { stdout: `${REMOTE_URL}\n` };
  if (line === `rev-parse --verify --quiet refs/heads/${BRANCH}^{commit}`) {
    return world.steps.some((s) => s.startsWith("update-ref -d"))
      ? { code: 1 }
      : { stdout: `${TIP}\n` };
  }
  if (line === "rev-parse --verify --quiet refs/remotes/origin/main^{tree}") {
    return { stdout: `${BASE_TREE}\n` };
  }
  if (line === "worktree list --porcelain -z") {
    return {
      stdout: `worktree /main\0HEAD ${START}\0branch refs/heads/main\0\0worktree ${world.worktree}\0HEAD ${TIP}\0branch refs/heads/${BRANCH}\0locked dipo ${world.claim().runId}\0\0`,
    };
  }
  return undefined;
}

async function withWorld(fn: (world: World) => Promise<void>): Promise<void> {
  await withTempDir(async (raw) => {
    const dir = realpathSync(raw);
    const t = await openTestState(dir);
    const office = addOffice(t);
    const common = join(dir, "repo", ".git");
    const worktree = join(dir, "wt", "TASK-1");
    const admin = join(common, "worktrees", "TASK-1");
    mkdirSync(admin, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(admin, "gitdir"), `${join(worktree, ".git")}\n`);
    writeFileSync(join(worktree, ".git"), `gitdir: ${admin}\n`);
    const steps: string[] = [];
    const runId = RunId.parse(t.ids.next("run"));
    const key = StoryKey.parse(t.ids.next("sto"));
    const world: World = {
      t,
      office,
      worktree,
      slots: new SlotTable(join(dir, "state", "slots.json"), { exists: () => true }),
      steps,
      answer: () => undefined,
      claim: () => {
        const claim = findClaim(office, runId);
        if (claim === null) throw new Error("no claim");
        return claim;
      },
      git: new OfficeGit({
        officeId: office.officeId as OfficeId,
        mainWorktree: join(dir, "repo"),
        commonDir: common,
        settings: { remote: "origin", base: "main" },
        runner: {
          exec: async (call: GitCall): Promise<GitResult> => {
            const args = stepArgs(call.args);
            steps.push(args.join(" "));
            const answered = world.answer(args);
            if (answered === "hang") return new Promise<GitResult>(() => {});
            const reply = answered ?? defaults(world, args) ?? {};
            const result = { code: 0, stdout: "", stderr: "", ...reply };
            if (args[0] === "worktree" && args[1] === "remove" && result.code === 0) {
              rmSync(worktree, { recursive: true, force: true });
              rmSync(admin, { recursive: true, force: true });
            }
            return result;
          },
          env: {},
          sleep: async () => {},
        },
        clock: t.clock,
      }),
    };
    office.immediate(() =>
      insertClaim(office, {
        runId,
        key,
        story: "TASK-1",
        branch: BRANCH,
        worktree,
        base: "main",
        baseSha: START,
        startSha: START,
        claimSha: TIP,
        reused: false,
        snapshot: {
          path: worktree,
          adminDir: admin,
          commondir: "../..\n",
          gitdir: `${join(worktree, ".git")}\n`,
          pointer: `gitdir: ${admin}\n`,
        },
        firstFeedback: null,
        claimedAt: t.clock.now(),
      }),
    );
    // Tier T rows of the worktree, and a row of another worktree that must stay.
    for (const path of [worktree, "/elsewhere"]) {
      office.immediate(() => {
        office.run(
          `insert into worker_notes (office_id, worktree, agent_id, run_id, story_key, role, text, recorded_at)
           values ($office_id, $path, 'agt_1', $run, null, 'builder', 'note', 1)`,
          { path, run: runId },
        );
        office.run(
          `insert into context_packs (office_id, worktree, head_sha, blob_ids, provider, pack_sha256, built_at)
           values ($office_id, $path, $sha, '{}', 'default', 'x', 1)`,
          { path, sha: TIP },
        );
      });
    }
    world.slots.take(
      { office: office.officeId, story: "TASK-1", worktree, takenAt: t.clock.now() },
      20,
    );
    try {
      await fn(world);
    } finally {
      t.state.close();
    }
  });
}

/** A host that reports `pr` as the merged PR of every branch, or fails with `fail`. */
function host(pr: Partial<HostPr> | null, fail = false): PrStateHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    findMergedPr: async (repo, branch) => {
      calls.push(`${repo} ${branch}`);
      if (fail) throw new CodeHostError("unauthenticated", "not logged in");
      if (pr === null) return null;
      return {
        number: 9,
        url: "https://github.com/o/r/pull/9",
        state: "merged",
        head: branch,
        headSha: TIP,
        base: "main",
        title: "feat(TASK-1): x",
        mergeCommit: "4".repeat(40),
        ...pr,
      };
    },
  };
}

function rows(world: World, table: "worker_notes" | "context_packs"): string[] {
  return world.office
    .all<{ worktree: string }>(
      `select worktree from ${table} where office_id = $office_id order by worktree`,
    )
    .map((row) => row.worktree);
}

function deps(world: World) {
  return {
    officeId: world.office.officeId as OfficeId,
    office: world.office,
    git: world.git,
    clock: world.t.clock,
    slots: world.slots,
  };
}

/** A StoryTeardown on the world, tracked for its office. */
function teardownOf(
  world: World,
  options: {
    host?: PrStateHost | null;
    /** The story's status, or a function of the poll count; null is unreadable. */
    status?: string | null | ((call: number) => string | null);
    onStatus?: () => void;
    config?: OfficeConfig;
  } = {},
): StoryTeardown {
  let calls = 0;
  const officeId = world.office.officeId as OfficeId;
  const teardown = new StoryTeardown({
    git: () => world.git,
    host: options.host === undefined ? host({}) : options.host,
    cli: { spawn: () => Promise.reject(new Error("no CLI in this test")) as never },
    offices: {
      get: () => world.office,
      config: () => options.config ?? OFFICE_DEFAULTS,
    },
    slots: world.slots,
    statusOf: async () => {
      calls += 1;
      options.onStatus?.();
      const status = options.status;
      if (typeof status === "function") return status(calls);
      return status === undefined ? "Done" : status;
    },
  });
  teardown.track(officeId, world.office, world.t.clock);
  return teardown;
}

describe("detecting Done", () => {
  it("is Done when the host reports the branch's PR merged at the local tip", () =>
    withWorld(async (world) => {
      const check = await detectDone({ git: world.git, host: host({}) }, world.claim());
      expect(check).toEqual({
        done: true,
        evidence: { by: "host", number: 9, url: "https://github.com/o/r/pull/9" },
        tip: TIP,
      });
      // The host decided; merge-tree did not run.
      expect(world.steps.some((s) => s.startsWith("merge-tree"))).toBe(false);
    }));

  it("is Done when merge-tree returns the base tree, and not by ancestry", () =>
    withWorld(async (world) => {
      world.answer = (args) =>
        args[0] === "merge-tree" ? { stdout: `${BASE_TREE}\n` } : undefined;
      const check = await detectDone({ git: world.git, host: null }, world.claim());
      expect(check).toEqual({
        done: true,
        evidence: { by: "merge-tree", tree: BASE_TREE },
        tip: TIP,
      });
      expect(world.steps).toContain(
        `merge-tree --write-tree refs/remotes/origin/main refs/heads/${BRANCH}`,
      );
      expect(world.steps.some((s) => s.startsWith("merge-base"))).toBe(false);
    }));

  it("is not Done on another tree, a conflict, a closed PR or a branch with nothing of its own", () =>
    withWorld(async (world) => {
      const claim = world.claim();
      world.answer = (args) =>
        args[0] === "merge-tree" ? { stdout: `${"5".repeat(40)}\n` } : undefined;
      expect(await detectDone({ git: world.git, host: host(null) }, claim)).toEqual({
        done: false,
      });
      world.answer = (args) =>
        args[0] === "merge-tree" ? { code: 1, stdout: `${"5".repeat(40)}\nCONFLICT` } : undefined;
      expect(await detectDone({ git: world.git, host: null }, claim)).toEqual({ done: false });
      // A PR into another base does not count.
      world.answer = (args) =>
        args[0] === "merge-tree" ? { stdout: `${"5".repeat(40)}\n` } : undefined;
      expect(await detectDone({ git: world.git, host: host({ base: "release" }) }, claim)).toEqual({
        done: false,
      });
      // A branch still at its start has nothing of its own: merge-tree is not asked.
      world.steps.length = 0;
      expect(await detectDone({ git: world.git, host: null }, { ...claim, startSha: TIP })).toEqual(
        { done: false },
      );
      expect(world.steps.some((s) => s.startsWith("merge-tree"))).toBe(false);
    }));

  it("falls back to merge-tree when the host fails, and reports a merge-tree error", () =>
    withWorld(async (world) => {
      world.answer = (args) =>
        args[0] === "merge-tree" ? { code: 128, stderr: "fatal: bad object" } : undefined;
      const check = await detectDone({ git: world.git, host: host({}, true) }, world.claim());
      expect(check.done).toBe(false);
      expect(!check.done && check.problem?.code).toBe(TEARDOWN_NOTICES.checkFailed);
      expect(!check.done && check.problem?.text).toContain("fatal: bad object");
    }));

  it("falls back to merge-tree when gh never answers and is killed at its deadline (DIPO-314)", () =>
    withWorld(async (world) => {
      world.answer = (args) =>
        args[0] === "merge-tree" ? { code: 128, stderr: "fatal: bad object" } : undefined;
      const clock = new ManualClock();
      const gh = new GhHost({ spawn: hangingSpawn().spawn, env: {}, clock });
      let settled = false;
      const checked = detectDone({ git: world.git, host: gh }, world.claim()).finally(
        () => (settled = true),
      );
      for (let i = 0; i < 50 && clock.pendingTimers === 0; i += 1) await letCallsRun();
      expect(settled).toBe(false);
      clock.advance(CALL_DEADLINE_MS + KILL_GRACE_MS);
      const check = await checked;
      // The timed-out host call is the failure the Done poll already handles: merge-tree decides.
      expect(world.steps.some((step) => step.startsWith("merge-tree"))).toBe(true);
      expect(!check.done && check.problem?.code).toBe(TEARDOWN_NOTICES.checkFailed);
    }));

  it("reports a merged PR whose head is not the local tip while the branch adds changes", () =>
    withWorld(async (world) => {
      world.answer = (args) =>
        args[0] === "merge-tree" ? { stdout: `${"5".repeat(40)}\n` } : undefined;
      const check = await detectDone(
        { git: world.git, host: host({ headSha: "6".repeat(40) }) },
        world.claim(),
      );
      expect(!check.done && check.problem?.code).toBe(TEARDOWN_NOTICES.unmergedCommits);
    }));
});

describe("tearing down", () => {
  it("unlocks, removes without --force, deletes the branch locally then remotely, and frees state", () =>
    withWorld(async (world) => {
      const claim = world.claim();
      const outcome = await tearDown(
        deps(world),
        claim,
        { by: "host", number: 9, url: "https://github.com/o/r/pull/9" },
        TIP,
      );
      expect(outcome).toEqual({ ok: true, remoteProblem: null });
      const git = world.steps.filter((s) =>
        /^(worktree (un)?lock|worktree remove|update-ref|branch|config --remove-section|push)/.test(
          s,
        ),
      );
      expect(git).toEqual([
        `worktree unlock ${world.worktree}`,
        `worktree remove ${world.worktree}`,
        `update-ref -d refs/heads/${BRANCH} ${TIP}`,
        `config --remove-section branch.${BRANCH}`,
        `push --quiet --no-verify origin --delete ${BRANCH}`,
      ]);
      expect(world.steps.some((s) => s.includes("--force"))).toBe(false);
      const after = world.claim();
      expect(after.releasedAt).not.toBeNull();
      expect(after.releaseReason).toBe(DONE_RELEASE_REASON);
      expect(rows(world, "worker_notes")).toEqual(["/elsewhere"]);
      expect(rows(world, "context_packs")).toEqual(["/elsewhere"]);
      expect(world.slots.slotOf(world.worktree)).toBeNull();
      expect(notices(world.office).map((n) => n.code)).toEqual([TEARDOWN_NOTICES.done]);
    }));

  it("ignores a branch without configuration when it drops the branch's config section", () =>
    withWorld(async (world) => {
      world.answer = (args) =>
        args[0] === "config" && args[1] === "--remove-section"
          ? { code: 128, stderr: "fatal: no such section: branch.x" }
          : undefined;
      const outcome = await tearDown(
        deps(world),
        world.claim(),
        { by: "merge-tree", tree: BASE_TREE },
        TIP,
      );
      expect(outcome).toEqual({ ok: true, remoteProblem: null });
      expect(world.steps).toContain(`config --remove-section branch.${BRANCH}`);
      expect(world.claim().releaseReason).toBe(DONE_RELEASE_REASON);
    }));

  it("accepts a remote branch the host already deleted, and reports another push failure", () =>
    withWorld(async (world) => {
      world.answer = (args) =>
        args[0] === "push"
          ? {
              code: 1,
              stderr: `error: unable to delete '${BRANCH}': remote ref does not exist\n`,
            }
          : undefined;
      const evidence = { by: "merge-tree", tree: BASE_TREE } as const;
      expect(await tearDown(deps(world), world.claim(), evidence, TIP)).toEqual({
        ok: true,
        remoteProblem: null,
      });
      expect(notices(world.office).map((n) => n.code)).toEqual([TEARDOWN_NOTICES.done]);
    }));

  it("reports a remote branch it could not delete, after the local teardown", () =>
    withWorld(async (world) => {
      world.answer = (args) =>
        args[0] === "push" ? { code: 128, stderr: "fatal: unable to access" } : undefined;
      const outcome = await tearDown(
        deps(world),
        world.claim(),
        {
          by: "merge-tree",
          tree: BASE_TREE,
        },
        TIP,
      );
      expect(outcome).toEqual({ ok: true, remoteProblem: "fatal: unable to access" });
      expect(notices(world.office).map((n) => n.code)).toEqual([
        TEARDOWN_NOTICES.done,
        TEARDOWN_NOTICES.remoteBranch,
      ]);
    }));

  it("keeps everything for a dirty worktree, locks it again and lists the files once", () =>
    withWorld(async (world) => {
      world.answer = (args) => {
        if (args[0] === "worktree" && args[1] === "remove") {
          return {
            code: 128,
            stderr: `fatal: '${world.worktree}' contains modified or untracked files, use --force to delete it`,
          };
        }
        if (args[0] === "status") return { stdout: " M src/a.ts\0?? notes.txt\0" };
        // The files differ from the start commit and the branch tip, so they are work.
        if (args.join(" ").startsWith("diff --name-only -z ")) return { stdout: "src/a.ts\0" };
        return undefined;
      };
      const teardown = teardownOf(world);
      const officeId = world.office.officeId as OfficeId;
      const first = await teardown.poll(officeId);
      await teardown.poll(officeId);
      expect(first.kept.map((c) => c.runId)).toEqual([world.claim().runId]);
      expect(world.steps).toContain(
        `worktree lock --reason dipo ${world.claim().runId} ${world.worktree}`,
      );
      expect(world.steps.some((s) => s.startsWith("update-ref") || s.startsWith("push"))).toBe(
        false,
      );
      expect(world.claim().releasedAt).toBeNull();
      expect(existsSync(world.worktree)).toBe(true);
      expect(world.slots.slotOf(world.worktree)).not.toBeNull();
      expect(rows(world, "worker_notes")).toContain(world.worktree);
      const told = notices(world.office);
      expect(told.map((n) => n.code)).toEqual([TEARDOWN_NOTICES.kept]);
      expect(told[0]?.text).toContain("src/a.ts, notes.txt");
    }));

  it("tells a teardown step that never ends at its deadline as a failed check, and frees the queue (DIPO-314)", () =>
    withWorld(async (world) => {
      world.answer = (args) =>
        args[0] === "worktree" && args[1] === "remove" ? "hang" : undefined;
      const teardown = teardownOf(world);
      const polled = teardown.poll(world.office.officeId as OfficeId);
      // Once the step hangs, its deadline and the grace pass on the office clock.
      for (
        let i = 0;
        i < 2_000 && !world.steps.some((step) => step.startsWith("worktree remove"));
        i += 1
      ) {
        await Bun.sleep(1);
      }
      world.t.clock.advance(GIT_STEP_DEADLINE_MS + KILL_GRACE_MS);
      const report = await polled;
      expect(report.tornDown).toEqual([]);
      const failed = notices(world.office).filter((n) => n.code === TEARDOWN_NOTICES.checkFailed);
      expect(failed).toHaveLength(1);
      expect(failed[0]?.text).toContain("did not finish within its deadline");
      expect(world.claim().releasedAt).toBeNull();
      expect(await world.git.run(async () => "next item")).toBe("next item");
    }));

  it("keeps everything for a worktree locked by someone else, without unlocking it", () =>
    withWorld(async (world) => {
      world.answer = (args) =>
        args.join(" ") === "worktree list --porcelain -z"
          ? { stdout: `worktree ${world.worktree}\0HEAD ${TIP}\0locked on a USB disk\0\0` }
          : undefined;
      const outcome = await tearDown(
        deps(world),
        world.claim(),
        {
          by: "merge-tree",
          tree: BASE_TREE,
        },
        TIP,
      );
      expect(outcome.ok).toBe(false);
      expect(!outcome.ok && outcome.why).toContain("on a USB disk");
      expect(world.steps.some((s) => s.startsWith("worktree unlock"))).toBe(false);
      expect(world.steps.some((s) => s.startsWith("worktree remove"))).toBe(false);
      expect(world.claim().releasedAt).toBeNull();
    }));

  it("finishes a teardown a crash interrupted after the worktree and branch were gone", () =>
    withWorld(async (world) => {
      crashAfterGitSteps(world);
      world.office.immediate(() =>
        markTeardownStarted(world.office, world.claim().runId, world.t.clock.now()),
      );
      // No code host: the recorded start alone resumes it, without merge-tree or a status read.
      const report = await teardownOf(world, { host: null, status: null }).poll(
        world.office.officeId as OfficeId,
      );
      expect(report.tornDown).toHaveLength(1);
      expect(world.steps.some((s) => s.startsWith("worktree remove"))).toBe(false);
      expect(world.steps.some((s) => s.startsWith("update-ref"))).toBe(false);
      expect(world.steps.some((s) => s.startsWith("merge-tree"))).toBe(false);
      expect(world.claim().releaseReason).toBe(DONE_RELEASE_REASON);
      expect(world.slots.slotOf(world.worktree)).toBeNull();
    }));

  it("reports a live claim whose worktree and branch vanished without a teardown, once", () =>
    withWorld(async (world) => {
      crashAfterGitSteps(world);
      const teardown = teardownOf(world, { host: null });
      await teardown.poll(world.office.officeId as OfficeId);
      await teardown.poll(world.office.officeId as OfficeId);
      expect(world.claim().releasedAt).toBeNull();
      expect(notices(world.office).map((n) => n.code)).toEqual([TEARDOWN_NOTICES.claimGone]);
    }));

  it("records the start of a teardown and clears it when the worktree is kept", () =>
    withWorld(async (world) => {
      let startedDuringRemove: number | null = null;
      world.answer = (args) => {
        if (args[0] === "worktree" && args[1] === "remove") {
          startedDuringRemove = world.claim().teardownStartedAt;
          return { code: 128, stderr: "fatal: contains modified or untracked files" };
        }
        return undefined;
      };
      await tearDown(deps(world), world.claim(), { by: "merge-tree", tree: BASE_TREE }, TIP);
      expect(startedDuringRemove).not.toBeNull();
      expect(world.claim().teardownStartedAt).toBeNull();
    }));

  it("keeps everything when the branch moves between detection and teardown", () =>
    withWorld(async (world) => {
      const moved = "7".repeat(40);
      const teardown = teardownOf(world, {
        // A commit lands while the poll reads the story's status.
        onStatus: () => {
          world.answer = (args) =>
            args.join(" ") === `rev-parse --verify --quiet refs/heads/${BRANCH}^{commit}`
              ? { stdout: `${moved}\n` }
              : undefined;
        },
      });
      const report = await teardown.poll(world.office.officeId as OfficeId);
      expect(report.kept).toHaveLength(1);
      for (const step of ["worktree unlock", "worktree remove", "update-ref", "branch", "push"]) {
        expect(world.steps.some((s) => s.startsWith(step))).toBe(false);
      }
      expect(existsSync(world.worktree)).toBe(true);
      expect(world.claim().releasedAt).toBeNull();
      expect(world.claim().teardownStartedAt).toBeNull();
      const told = notices(world.office);
      expect(told.map((n) => n.code)).toEqual([TEARDOWN_NOTICES.kept]);
      expect(told[0]?.text).toContain(`moved from ${TIP} to ${moved}`);
    }));
});

/** The state after a teardown removed the worktree and deleted the branch, then crashed. */
function crashAfterGitSteps(world: World): void {
  rmSync(world.worktree, { recursive: true });
  rmSync(join(world.git.commonDir, "worktrees"), { recursive: true });
  world.answer = (args) =>
    args.join(" ") === `rev-parse --verify --quiet refs/heads/${BRANCH}^{commit}`
      ? { code: 1 }
      : undefined;
}

describe("the Done poll", () => {
  it("decides an open merge gate approved by the maintainer when the PR was merged by hand (DIPO-150)", () =>
    withWorld(async (world) => {
      const claim = world.claim();
      const gate = world.t.ids.next("gat");
      world.office.immediate(() => {
        world.office.run(
          `insert into stories (office_id, key, story_id, provisional, backlog_created, first_seen_at)
           values ($office_id, $key, 'TASK-1', 0, 1, 0)`,
          { key: claim.key },
        );
        world.office.run(
          `insert into gates (office_id, gate_id, kind, key, run_id, opened_at, waiting_on,
             summary, head_sha)
           values ($office_id, $gate, 'merge', $key, $run, 1, 'maintainer', 'waits', $head)`,
          { gate, key: claim.key, run: claim.runId, head: TIP },
        );
      });
      await teardownOf(world).poll(world.office.officeId as OfficeId);
      expect(mergeGate(world.office, gate)?.decision).toMatchObject({
        decision: "approved",
        by: "maintainer",
        note: HAND_MERGE_NOTE,
      });
      const decided = world.office.all<{ delta: string }>(
        "select delta from change_log where office_id = $office_id and type = 'gate.decided'",
      );
      expect(decided.map((row) => JSON.parse(row.delta) as unknown)).toEqual([
        { gate, decision: "approved", by: "maintainer", note: HAND_MERGE_NOTE },
      ]);
    }));

  it("keeps the worktree, branch and slot of a parked story", () =>
    withWorld(async (world) => {
      const report = await teardownOf(world, { status: "Parked" }).poll(
        world.office.officeId as OfficeId,
      );
      expect(report.kept).toHaveLength(1);
      expect(world.steps.some((s) => s.startsWith("worktree") || s.startsWith("branch"))).toBe(
        false,
      );
      expect(world.claim().releasedAt).toBeNull();
      expect(world.slots.slotOf(world.worktree)).not.toBeNull();
      expect(notices(world.office).map((n) => n.code)).toEqual([TEARDOWN_NOTICES.parked]);
    }));

  it("keeps everything this poll when the story's status cannot be read, noticed once", () =>
    withWorld(async (world) => {
      const officeId = world.office.officeId as OfficeId;
      const teardown = teardownOf(world, { status: (call) => (call < 3 ? null : "Done") });
      const first = await teardown.poll(officeId);
      await teardown.poll(officeId);
      expect(first.kept).toHaveLength(1);
      expect(world.steps.some((s) => s.startsWith("worktree remove"))).toBe(false);
      expect(world.claim().releasedAt).toBeNull();
      expect(notices(world.office).map((n) => n.code)).toEqual([TEARDOWN_NOTICES.statusUnknown]);
      // Readable again: the teardown goes ahead.
      const third = await teardown.poll(officeId);
      expect(third.tornDown).toHaveLength(1);
    }));

  it("tells each cause of a claim once, even when causes alternate", () =>
    withWorld(async (world) => {
      const officeId = world.office.officeId as OfficeId;
      const teardown = teardownOf(world, {
        status: (call) => (call % 2 === 1 ? null : "Parked"),
      });
      for (let i = 0; i < 4; i++) await teardown.poll(officeId);
      expect(notices(world.office).map((n) => n.code)).toEqual([
        TEARDOWN_NOTICES.statusUnknown,
        TEARDOWN_NOTICES.parked,
      ]);
    }));

  it("waits while a worker host of the run is live", () =>
    withWorld(async (world) => {
      world.office.immediate(() =>
        world.office.run(
          `insert into worker_hosts (office_id, run_id, agent_id, pid, start_time_ms, socket_path,
             protocol_version, run_dir, event_file, started_at)
           values ($office_id, $run, 'agt_1', 1, 1, '/s', 1, '/r', '/e', 1)`,
          { run: world.claim().runId },
        ),
      );
      const report = await teardownOf(world).poll(world.office.officeId as OfficeId);
      expect(report.kept).toHaveLength(1);
      expect(world.claim().releasedAt).toBeNull();
    }));

  it("does not wait for a host whose exit is recorded without an end time (DIPO-328)", () =>
    withWorld(async (world) => {
      world.office.immediate(() =>
        world.office.run(
          `insert into worker_hosts (office_id, run_id, agent_id, pid, start_time_ms, socket_path,
             protocol_version, run_dir, event_file, started_at, exit_code)
           values ($office_id, $run, 'agt_1', 1, 1, '/s', 1, '/r', '/e', 1, 0)`,
          { run: world.claim().runId },
        ),
      );
      const report = await teardownOf(world).poll(world.office.officeId as OfficeId);
      expect(report.kept).toHaveLength(0);
      expect(notices(world.office).map((n) => n.code)).not.toContain(TEARDOWN_NOTICES.kept);
    }));

  it("does not wait for a host killed by a signal, whose exit has no code (DIPO-328)", () =>
    withWorld(async (world) => {
      world.office.immediate(() =>
        world.office.run(
          `insert into worker_hosts (office_id, run_id, agent_id, pid, start_time_ms, socket_path,
             protocol_version, run_dir, event_file, started_at, exit_signal)
           values ($office_id, $run, 'agt_1', 1, 1, '/s', 1, '/r', '/e', 1, 'SIGKILL')`,
          { run: world.claim().runId },
        ),
      );
      const report = await teardownOf(world).poll(world.office.officeId as OfficeId);
      expect(report.kept).toHaveLength(0);
    }));

  it("reports a git error of one claim as a notice and keeps the claim", () =>
    withWorld(async (world) => {
      world.answer = (args) =>
        args.join(" ") === "worktree list --porcelain -z"
          ? { code: 128, stderr: "fatal: broken" }
          : undefined;
      const report = await teardownOf(world).poll(world.office.officeId as OfficeId);
      expect(report).toMatchObject({ checked: 1, tornDown: [], kept: [] });
      expect(world.claim().releasedAt).toBeNull();
      const told = notices(world.office);
      expect(told.map((n) => n.code)).toEqual([TEARDOWN_NOTICES.checkFailed]);
      expect(told[0]?.text).toContain("fatal: broken");
    }));

  it("skips a claim whose setup never finished", () =>
    withWorld(async (world) => {
      world.office.immediate(() =>
        world.office.run("update claims set claim_sha = null where office_id = $office_id", {}),
      );
      const report = await teardownOf(world).poll(world.office.officeId as OfficeId);
      expect(report.checked).toBe(0);
    }));

  it("reads the PR state every polling.prStateSeconds of the office configuration", () =>
    withWorld(async (world) => {
      const officeId = world.office.officeId as OfficeId;
      const reader = host(null);
      world.answer = (args) =>
        args[0] === "merge-tree" ? { stdout: `${"5".repeat(40)}\n` } : undefined;
      const config: OfficeConfig = {
        ...OFFICE_DEFAULTS,
        polling: { ...OFFICE_DEFAULTS.polling, prStateSeconds: 30 },
      };
      const teardown = teardownOf(world, { host: reader, config });
      const steps = new Map<string, (ctx: OfficeLoadContext) => unknown>();
      (teardown.feature as FeatureModule).register({
        registerLoadStep: (name: string, run: (ctx: OfficeLoadContext) => unknown) =>
          steps.set(name, run),
      } as never);
      await steps.get(TEARDOWN_STEP)?.({
        officeId,
        office: world.office,
        path: "/repo",
        commonDir: world.git.commonDir,
        config,
        clock: world.t.clock,
        ids: world.t.ids,
      });
      const settle = async () => {
        for (let i = 0; i < 50; i++) await Promise.resolve();
        await teardown.poll(officeId);
      };
      expect(reader.calls).toHaveLength(0);
      world.t.clock.advance(29_000);
      await settle();
      // The explicit poll in settle asked once; the timer has not fired yet.
      expect(reader.calls).toHaveLength(1);
      world.t.clock.advance(1_000);
      await settle();
      expect(reader.calls).toHaveLength(3);
      expect(reader.calls[0]).toBe(`o/r ${BRANCH}`);
      teardown.stop();
    }));
});

describe("worktree lock reasons", () => {
  it("reads the lock of one worktree from the porcelain list", () => {
    const list =
      "worktree /a\0HEAD x\0locked\0\0worktree /b\0HEAD y\0locked dipo run_1\0\0worktree /c\0HEAD z\0\0";
    expect(lockInList(list, "/a")).toBe("");
    expect(lockInList(list, "/b")).toBe("dipo run_1");
    expect(lockInList(list, "/c")).toBeNull();
    expect(lockInList(list, "/d")).toBeNull();
  });
});

// The box run worktrees of DIPO-302 and DIPO-332 are tested on real git in lagging-worktree.test.ts
// and lagging-worktree.ci.test.ts.
