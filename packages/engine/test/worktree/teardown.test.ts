// The Done poll's one Done check (DIPO-363; 0002) and teardown (DIPO-58, DIPO-349; 0010, 0007 tier
// T), fast: a fake git executor that answers each git step by its arguments, a fake code host and a
// real state database. A claim has no worktree, so teardown deletes only the branch. The same rules
// against real repositories and a bare remote are in teardown.ci.test.ts.

import { describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";

import { type OfficeId, RunId, StoryKey } from "@dipsaus-orchestrator/contract";
import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import type { FeatureModule } from "../../src/commands/registry";
import { OFFICE_DEFAULTS, type OfficeConfig } from "../../src/config";
import type { OfficeHandle } from "../../src/db/office";
import { type GitCall, type GitResult, OfficeGit } from "../../src/git";
import { HAND_MERGE_NOTE, mergeGate } from "../../src/merge";
import type { OfficeLoadContext } from "../../src/office/steps";
import { GIT_STEP_DEADLINE_MS } from "../../src/git/runner";
import { CALL_DEADLINE_MS, KILL_GRACE_MS } from "../../src/platform/deadline";
import { CodeHostError, GhHost, type HostPr, type PrStateHost } from "../../src/platform/host";
import {
  type ClaimRecord,
  DONE_RELEASE_REASON,
  findClaim,
  StoryTeardown,
  TEARDOWN_NOTICES,
  TEARDOWN_STEP,
  tearDown,
} from "../../src/worktree";
import { insertStoryPr } from "../../src/story-pr/records";
import { HOST_FAILURES_NOTICED } from "../../src/worktree/done";
import { insertClaim, markTeardownStarted } from "../../src/worktree/records";
import { notices } from "../backlog/lane/helpers";
import { hangingSpawn, settle as letCallsRun } from "../platform/hanging";
import { addOffice, openTestState, type TestState } from "../commands/helpers";
import { backlogStoryStore } from "../../src/backlog/store";

const START = "1".repeat(40);
const TIP = "2".repeat(40);
const BASE_TREE = "3".repeat(40);
/** The merged story PR a teardown names. */
const PR9 = { number: 9, url: "https://github.com/o/r/pull/9" } as const;
const BRANCH = "TASK-1/add-csv";
const OTHER_BRANCH = "TASK-2/other";
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
  /** Every git step, its arguments joined by spaces. */
  readonly steps: string[];
  /** Answers a step; undefined means exit 0 with no output. */
  /** The reply to a git step; `"hang"` makes the step never end (DIPO-314). */
  answer: (args: readonly string[]) => Reply | "hang";
  claim(): ClaimRecord;
}

/** Facts a default fake repository reports: remote, branch at TIP, base tree. */
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
  return undefined;
}

async function withWorld(fn: (world: World) => Promise<void>): Promise<void> {
  await withTempDir(async (raw) => {
    const dir = realpathSync(raw);
    const t = await openTestState(dir);
    const office = addOffice(t);
    const common = join(dir, "repo", ".git");
    const steps: string[] = [];
    const runId = RunId.parse(t.ids.next("run"));
    const key = StoryKey.parse(t.ids.next("sto"));
    const world: World = {
      t,
      office,
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
            return { code: 0, stdout: "", stderr: "", ...reply };
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
        base: "main",
        baseSha: START,
        startSha: START,
        claimSha: TIP,
        reused: false,
        claimedAt: t.clock.now(),
      }),
    );
    // Tier T rows of the branch, and a row of another branch that must stay.
    for (const branch of [BRANCH, OTHER_BRANCH]) {
      office.immediate(() => {
        office.run(
          `insert into worker_notes (office_id, branch, agent_id, run_id, story_key, role, text, recorded_at)
           values ($office_id, $branch, 'agt_1', $run, null, 'builder', 'note', 1)`,
          { branch, run: runId },
        );
        office.run(
          `insert into context_packs (office_id, branch, head_sha, blob_ids, provider, pack_sha256, built_at)
           values ($office_id, $branch, $sha, '{}', 'default', 'x', 1)`,
          { branch, sha: TIP },
        );
      });
    }
    // The run's story PR #9, open, as the PR poll recorded it.
    recordPr(world, "open");
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
    .all<{ branch: string }>(
      `select branch from ${table} where office_id = $office_id order by branch`,
    )
    .map((row) => row.branch);
}

function deps(world: World) {
  return {
    officeId: world.office.officeId as OfficeId,
    office: world.office,
    git: world.git,
    clock: world.t.clock,
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
    stories: backlogStoryStore({
      spawn: () => Promise.reject(new Error("no CLI in this test")) as never,
    }),
    offices: {
      get: () => world.office,
      config: () => options.config ?? OFFICE_DEFAULTS,
    },
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

/**
 * Records the claim's story PR `number` in `state`, its head at `head`, as the PR poll records
 * it, in place of the one recorded before.
 */
function recordPr(world: World, state: "open" | "merged" | "closed", head = TIP, number = 9): void {
  const claim = world.claim();
  world.office.immediate(() => {
    world.office.run("delete from story_prs where office_id = $office_id and run_id = $run", {
      run: claim.runId,
    });
    insertStoryPr(world.office, {
      runId: claim.runId,
      key: claim.key,
      number,
      url: `https://github.com/o/r/pull/${number}`,
      branch: BRANCH,
      base: "main",
      headSha: head,
      state,
      title: "feat(TASK-1): x",
      bodyHash: "h",
      openedAt: 1,
      closedAt: state === "open" ? null : 2,
    });
  });
}

/** A worker host row of the claim's run that has not exited, so its worker is live. */
function liveHost(world: World): void {
  world.office.immediate(() =>
    world.office.run(
      `insert into worker_hosts (office_id, run_id, agent_id, pid, start_time_ms, socket_path,
         protocol_version, run_dir, event_file, started_at)
       values ($office_id, $run, 'agt_1', 1, 1, '/s', 1, '/r', '/e', 1)`,
      { run: world.claim().runId },
    ),
  );
}

describe("detecting Done (the one Done check, DIPO-363)", () => {
  it("is Done when the host reports the branch's PR merged at the local tip", () =>
    withWorld(async (world) => {
      const officeId = world.office.officeId as OfficeId;
      const teardown = teardownOf(world);
      expect(await teardown.answer(officeId, world.claim())).toBe("merged");
      const report = await teardown.poll(officeId);
      expect(report.tornDown).toHaveLength(1);
      expect(world.claim().releaseReason).toBe(DONE_RELEASE_REASON);
      // The host decided; merge-tree did not run.
      expect(world.steps.some((s) => s.startsWith("merge-tree"))).toBe(false);
    }));

  it("is not Done when merge-tree returns the base tree: merge-tree is no Done signal (0010)", () =>
    withWorld(async (world) => {
      world.answer = (args) =>
        args[0] === "merge-tree" ? { stdout: `${BASE_TREE}\n` } : undefined;
      const officeId = world.office.officeId as OfficeId;
      const teardown = teardownOf(world, { host: host(null) });
      expect(await teardown.answer(officeId, world.claim())).toBe("notDone");
      const report = await teardown.poll(officeId);
      expect(report).toMatchObject({ checked: 1, tornDown: [], kept: [] });
      expect(world.claim().releasedAt).toBeNull();
      expect(world.steps.some((s) => s.startsWith("merge-tree"))).toBe(false);
      expect(world.steps.some((s) => s.startsWith("merge-base"))).toBe(false);
      expect(notices(world.office)).toEqual([]);
    }));

  it("is not Done for a PR into another base, an open or a closed PR", () =>
    withWorld(async (world) => {
      const officeId = world.office.officeId as OfficeId;
      const claim = world.claim();
      expect(
        await teardownOf(world, { host: host({ base: "release" }) }).answer(officeId, claim),
      ).toBe("notDone");
      recordPr(world, "open");
      expect(await teardownOf(world, { host: null }).answer(officeId, claim)).toBe("notDone");
      world.office.immediate(() =>
        world.office.run("update story_prs set state = 'closed' where office_id = $office_id", {}),
      );
      expect(await teardownOf(world, { host: host(null) }).answer(officeId, claim)).toBe("notDone");
      expect(world.claim().releasedAt).toBeNull();
    }));

  it("ignores an old merged PR of a reused branch: only the run's own recorded PR counts", () =>
    withWorld(async (world) => {
      // The story was claimed again on the same branch: this run's PR is #12, still open, while
      // the host's newest merged PR of the branch is the earlier run's #9, at another head.
      recordPr(world, "open", TIP, 12);
      world.answer = (args) =>
        args[0] === "merge-tree" ? { stdout: `${"5".repeat(40)}\n` } : undefined;
      const officeId = world.office.officeId as OfficeId;
      const old = host({ headSha: "6".repeat(40) });
      const teardown = teardownOf(world, { host: old });
      expect(await teardown.answer(officeId, world.claim())).toBe("notDone");
      const report = await teardown.poll(officeId);
      expect(old.calls.length).toBeGreaterThan(0);
      expect(report).toMatchObject({ checked: 1, tornDown: [], kept: [] });
      expect(report.released ?? []).toEqual([]);
      expect(world.claim().releasedAt).toBeNull();
      expect(world.steps.some((s) => s.startsWith("merge-tree"))).toBe(false);
      expect(notices(world.office)).toEqual([]);
    }));

  it("tells the maintainer once when the host failed on a claim for 3 polls in a row", () =>
    withWorld(async (world) => {
      const officeId = world.office.officeId as OfficeId;
      let failing = true;
      const flaky: PrStateHost = {
        findMergedPr: async () => {
          if (failing) throw new CodeHostError("unauthenticated", "not logged in");
          return null;
        },
      };
      const teardown = teardownOf(world, { host: flaky });
      const unreachable = () =>
        notices(world.office).filter((n) => n.code === TEARDOWN_NOTICES.hostUnreachable);
      for (let i = 1; i < HOST_FAILURES_NOTICED; i++) await teardown.poll(officeId);
      expect(unreachable()).toEqual([]);
      await teardown.poll(officeId);
      await teardown.poll(officeId);
      expect(unreachable()).toHaveLength(1);
      expect(unreachable()[0]?.text).toContain("3 polls in a row (not logged in)");
      // An answer ends the streak; a new streak is told again.
      failing = false;
      await teardown.poll(officeId);
      failing = true;
      for (let i = 0; i < HOST_FAILURES_NOTICED; i++) await teardown.poll(officeId);
      expect(unreachable()).toHaveLength(2);
      expect(world.claim().releasedAt).toBeNull();
    }));

  it("takes the PR dipo recorded merged when the host fails, and without it is not Done", () =>
    withWorld(async (world) => {
      const officeId = world.office.officeId as OfficeId;
      const failing = host({}, true);
      expect(await teardownOf(world, { host: failing }).answer(officeId, world.claim())).toBe(
        "notDone",
      );
      recordPr(world, "merged");
      const teardown = teardownOf(world, { host: failing });
      expect(await teardown.answer(officeId, world.claim())).toBe("merged");
      // A recorded merge is final: the host is not asked again.
      const asked = failing.calls.length;
      expect((await teardown.poll(officeId)).tornDown).toHaveLength(1);
      expect(failing.calls).toHaveLength(asked);
    }));

  it("falls back to dipo's record when gh never answers and is killed at its deadline (DIPO-314)", () =>
    withWorld(async (world) => {
      const clock = new ManualClock();
      const gh = new GhHost({ spawn: hangingSpawn().spawn, env: {}, clock });
      let settled = false;
      const officeId = world.office.officeId as OfficeId;
      const checked = teardownOf(world, { host: gh })
        .answer(officeId, world.claim())
        .finally(() => (settled = true));
      for (let i = 0; i < 50 && clock.pendingTimers === 0; i += 1) await letCallsRun();
      expect(settled).toBe(false);
      clock.advance(CALL_DEADLINE_MS + KILL_GRACE_MS);
      // The timed-out host call is the failure the Done poll already handles: the record decides.
      expect(await checked).toBe("notDone");
    }));

  it("tears down a merged PR whose head is not the local tip when the branch adds nothing", () =>
    withWorld(async (world) => {
      world.answer = (args) =>
        args[0] === "merge-tree" ? { stdout: `${BASE_TREE}\n` } : undefined;
      const report = await teardownOf(world, { host: host({ headSha: "6".repeat(40) }) }).poll(
        world.office.officeId as OfficeId,
      );
      expect(report.tornDown).toHaveLength(1);
      // merge-tree decided only that the branch may go (0010).
      expect(world.steps).toContain(
        `merge-tree --write-tree refs/remotes/origin/main refs/heads/${BRANCH}`,
      );
      expect(world.steps).toContain(`update-ref -d refs/heads/${BRANCH} ${TIP}`);
    }));

  it("keeps a merged branch that moved past the merged head with changes while its worker runs", () =>
    withWorld(async (world) => {
      world.answer = (args) =>
        args[0] === "merge-tree" ? { stdout: `${"5".repeat(40)}\n` } : undefined;
      liveHost(world);
      const report = await teardownOf(world, { host: host({ headSha: "6".repeat(40) }) }).poll(
        world.office.officeId as OfficeId,
      );
      expect(report).toMatchObject({ checked: 1, tornDown: [], kept: [] });
      expect(world.claim().releasedAt).toBeNull();
      expect(notices(world.office).map((n) => n.code)).toEqual([TEARDOWN_NOTICES.unmergedCommits]);
    }));
});

describe("tearing down", () => {
  it("deletes only the branch, locally then remotely, and frees state; it runs no worktree step", () =>
    withWorld(async (world) => {
      const claim = world.claim();
      const outcome = await tearDown(deps(world), claim, PR9, TIP);
      expect(outcome).toEqual({ ok: true, remoteProblem: null });
      expect(world.steps.some((s) => s.startsWith("worktree"))).toBe(false);
      const git = world.steps.filter((s) =>
        /^(update-ref|branch|config --remove-section|push)/.test(s),
      );
      expect(git).toEqual([
        `update-ref -d refs/heads/${BRANCH} ${TIP}`,
        `config --remove-section branch.${BRANCH}`,
        `push --quiet --no-verify --force-with-lease=refs/heads/${BRANCH}:${TIP} origin --delete ${BRANCH}`,
      ]);
      // No forced step: only the remote delete's lease.
      expect(world.steps.some((s) => /--force(?!-with-lease=)/.test(s))).toBe(false);
      const after = world.claim();
      expect(after.releasedAt).not.toBeNull();
      expect(after.releaseReason).toBe(DONE_RELEASE_REASON);
      expect(rows(world, "worker_notes")).toEqual([OTHER_BRANCH]);
      expect(rows(world, "context_packs")).toEqual([OTHER_BRANCH]);
      expect(notices(world.office).map((n) => n.code)).toEqual([TEARDOWN_NOTICES.done]);
    }));

  it("ignores a branch without configuration when it drops the branch's config section", () =>
    withWorld(async (world) => {
      world.answer = (args) =>
        args[0] === "config" && args[1] === "--remove-section"
          ? { code: 128, stderr: "fatal: no such section: branch.x" }
          : undefined;
      const outcome = await tearDown(deps(world), world.claim(), PR9, TIP);
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
      expect(await tearDown(deps(world), world.claim(), PR9, TIP)).toEqual({
        ok: true,
        remoteProblem: null,
      });
      expect(notices(world.office).map((n) => n.code)).toEqual([TEARDOWN_NOTICES.done]);
    }));

  it("reports a remote branch it could not delete, after the local teardown", () =>
    withWorld(async (world) => {
      world.answer = (args) =>
        args[0] === "push" ? { code: 128, stderr: "fatal: unable to access" } : undefined;
      const outcome = await tearDown(deps(world), world.claim(), PR9, TIP);
      expect(outcome).toEqual({ ok: true, remoteProblem: "fatal: unable to access" });
      expect(notices(world.office).map((n) => n.code)).toEqual([
        TEARDOWN_NOTICES.done,
        TEARDOWN_NOTICES.remoteBranch,
      ]);
    }));

  it("tells a teardown step that never ends at its deadline as a failed check, and frees the queue (DIPO-314)", () =>
    withWorld(async (world) => {
      world.answer = (args) => (args[0] === "update-ref" && args[1] === "-d" ? "hang" : undefined);
      const teardown = teardownOf(world);
      const polled = teardown.poll(world.office.officeId as OfficeId);
      // Once the step hangs, its deadline and the grace pass on the office clock.
      for (
        let i = 0;
        i < 2_000 && !world.steps.some((step) => step.startsWith("update-ref -d"));
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

  it("finishes a teardown a crash interrupted after the branch was gone", () =>
    withWorld(async (world) => {
      crashAfterGitSteps(world);
      world.office.immediate(() =>
        markTeardownStarted(world.office, world.claim().runId, world.t.clock.now()),
      );
      // No code host: the PR dipo recorded merged still answers the one Done check, and the
      // recorded start skips the status read.
      recordPr(world, "merged");
      const report = await teardownOf(world, { host: null, status: null }).poll(
        world.office.officeId as OfficeId,
      );
      expect(report.tornDown).toHaveLength(1);
      expect(world.steps.some((s) => s.startsWith("update-ref"))).toBe(false);
      expect(world.steps.some((s) => s.startsWith("merge-tree"))).toBe(false);
      expect(world.claim().releaseReason).toBe(DONE_RELEASE_REASON);
    }));

  it("reports a live claim whose branch vanished without a teardown, once", () =>
    withWorld(async (world) => {
      crashAfterGitSteps(world);
      const teardown = teardownOf(world, { host: null });
      await teardown.poll(world.office.officeId as OfficeId);
      await teardown.poll(world.office.officeId as OfficeId);
      expect(world.claim().releasedAt).toBeNull();
      expect(notices(world.office).map((n) => n.code)).toEqual([TEARDOWN_NOTICES.claimGone]);
    }));

  it("records the start of a teardown before the branch delete and clears it when the delete fails", () =>
    withWorld(async (world) => {
      let startedDuringDelete: number | null = null;
      world.answer = (args) => {
        if (args[0] === "update-ref" && args[1] === "-d") {
          startedDuringDelete = world.claim().teardownStartedAt;
          return { code: 128, stderr: "fatal: cannot lock ref" };
        }
        return undefined;
      };
      const outcome = await tearDown(deps(world), world.claim(), PR9, TIP);
      expect(outcome.ok).toBe(false);
      expect(startedDuringDelete).not.toBeNull();
      expect(world.claim().teardownStartedAt).toBeNull();
      expect(world.claim().releasedAt).toBeNull();
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
      for (const step of ["worktree", "update-ref", "branch", "push"]) {
        expect(world.steps.some((s) => s.startsWith(step))).toBe(false);
      }
      expect(world.claim().releasedAt).toBeNull();
      expect(world.claim().teardownStartedAt).toBeNull();
      const told = notices(world.office);
      expect(told.map((n) => n.code)).toEqual([TEARDOWN_NOTICES.kept]);
      expect(told[0]?.text).toContain(`moved from ${TIP} to ${moved}`);
    }));
});

/** The state after a teardown deleted the branch, then crashed. */
function crashAfterGitSteps(world: World): void {
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

  it("keeps the branch of a parked story", () =>
    withWorld(async (world) => {
      const report = await teardownOf(world, { status: "Parked" }).poll(
        world.office.officeId as OfficeId,
      );
      expect(report.kept).toHaveLength(1);
      expect(world.steps.some((s) => s.startsWith("worktree") || s.startsWith("branch"))).toBe(
        false,
      );
      expect(world.claim().releasedAt).toBeNull();
      expect(notices(world.office).map((n) => n.code)).toEqual([TEARDOWN_NOTICES.parked]);
    }));

  it("keeps everything this poll when the story's status cannot be read, noticed once", () =>
    withWorld(async (world) => {
      const officeId = world.office.officeId as OfficeId;
      const teardown = teardownOf(world, { status: (call) => (call < 3 ? null : "Done") });
      const first = await teardown.poll(officeId);
      await teardown.poll(officeId);
      expect(first.kept).toHaveLength(1);
      expect(world.steps.some((s) => s.startsWith("update-ref"))).toBe(false);
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
      liveHost(world);
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

  it("reports an error of one claim's check as a notice and keeps the claim", () =>
    withWorld(async (world) => {
      const broken: PrStateHost = {
        findMergedPr: () => Promise.reject(new Error("fatal: broken")),
      };
      const report = await teardownOf(world, { host: broken }).poll(
        world.office.officeId as OfficeId,
      );
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
