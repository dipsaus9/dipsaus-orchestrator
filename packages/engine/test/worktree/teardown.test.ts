// Done detection and teardown (DIPO-58; 0010 section 7 "Merge and Done", "Teardown", the
// dirty-worktree failure case and open question 8; 0007 section 7 tier T), fast: a fake git
// executor that answers each git step by its arguments, a fake code host, a real state database
// and a minimal worktree layout on disk so the office git can name the worktree. The same rules
// against real repositories and a bare remote are in teardown.ci.test.ts.

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type OfficeId, RunId, StoryKey } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import type { FeatureModule } from "../../src/commands/registry";
import { OFFICE_DEFAULTS, type OfficeConfig } from "../../src/config";
import type { OfficeHandle } from "../../src/db/office";
import { type GitCall, type GitResult, OfficeGit } from "../../src/git";
import type { OfficeLoadContext } from "../../src/office/steps";
import { CodeHostError, type HostPr, type PrStateHost } from "../../src/platform/host";
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
import { insertClaim } from "../../src/worktree/records";
import { notices } from "../backlog/lane/helpers";
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
  answer: (args: readonly string[]) => Reply;
  claim(): ClaimRecord;
}

/** Facts a default fake repository reports: remote, branch at TIP, base tree, our lock. */
function defaults(world: World, args: readonly string[]): Reply {
  const line = args.join(" ");
  if (line.startsWith("config --get remote.origin.url")) return { stdout: `${REMOTE_URL}\n` };
  if (line === `rev-parse --verify --quiet refs/heads/${BRANCH}^{commit}`) {
    return world.steps.some((s) => s.startsWith("branch -D"))
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
            const reply = world.answer(args) ?? defaults(world, args) ?? {};
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
  options: { host?: PrStateHost | null; status?: string; config?: OfficeConfig } = {},
): StoryTeardown {
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
    statusOf: async () => options.status ?? "Done",
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
      });
      // The host decided; merge-tree did not run.
      expect(world.steps.some((s) => s.startsWith("merge-tree"))).toBe(false);
    }));

  it("is Done when merge-tree returns the base tree, and not by ancestry", () =>
    withWorld(async (world) => {
      world.answer = (args) =>
        args[0] === "merge-tree" ? { stdout: `${BASE_TREE}\n` } : undefined;
      const check = await detectDone({ git: world.git, host: null }, world.claim());
      expect(check).toEqual({ done: true, evidence: { by: "merge-tree", tree: BASE_TREE } });
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
      const outcome = await tearDown(deps(world), claim, {
        by: "host",
        number: 9,
        url: "https://github.com/o/r/pull/9",
      });
      expect(outcome).toEqual({ ok: true, remoteProblem: null });
      const git = world.steps.filter((s) =>
        /^(worktree (un)?lock|worktree remove|branch|push)/.test(s),
      );
      expect(git).toEqual([
        `worktree unlock ${world.worktree}`,
        `worktree remove ${world.worktree}`,
        `branch -D ${BRANCH}`,
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
      expect(await tearDown(deps(world), world.claim(), evidence)).toEqual({
        ok: true,
        remoteProblem: null,
      });
      expect(notices(world.office).map((n) => n.code)).toEqual([TEARDOWN_NOTICES.done]);
    }));

  it("reports a remote branch it could not delete, after the local teardown", () =>
    withWorld(async (world) => {
      world.answer = (args) =>
        args[0] === "push" ? { code: 128, stderr: "fatal: unable to access" } : undefined;
      const outcome = await tearDown(deps(world), world.claim(), {
        by: "merge-tree",
        tree: BASE_TREE,
      });
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
      expect(world.steps.some((s) => s.startsWith("branch -D") || s.startsWith("push"))).toBe(
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

  it("keeps everything for a worktree locked by someone else, without unlocking it", () =>
    withWorld(async (world) => {
      world.answer = (args) =>
        args.join(" ") === "worktree list --porcelain -z"
          ? { stdout: `worktree ${world.worktree}\0HEAD ${TIP}\0locked on a USB disk\0\0` }
          : undefined;
      const outcome = await tearDown(deps(world), world.claim(), {
        by: "merge-tree",
        tree: BASE_TREE,
      });
      expect(outcome.ok).toBe(false);
      expect(!outcome.ok && outcome.why).toContain("on a USB disk");
      expect(world.steps.some((s) => s.startsWith("worktree unlock"))).toBe(false);
      expect(world.steps.some((s) => s.startsWith("worktree remove"))).toBe(false);
      expect(world.claim().releasedAt).toBeNull();
    }));

  it("finishes a teardown a crash interrupted after the worktree and branch were gone", () =>
    withWorld(async (world) => {
      rmSync(world.worktree, { recursive: true });
      rmSync(join(world.git.commonDir, "worktrees"), { recursive: true });
      world.answer = (args) =>
        args.join(" ") === `rev-parse --verify --quiet refs/heads/${BRANCH}^{commit}`
          ? { code: 1 }
          : undefined;
      const report = await teardownOf(world).poll(world.office.officeId as OfficeId);
      expect(report.tornDown).toHaveLength(1);
      expect(world.steps.some((s) => s.startsWith("worktree remove"))).toBe(false);
      expect(world.steps.some((s) => s.startsWith("branch -D"))).toBe(false);
      expect(world.claim().releaseReason).toBe(DONE_RELEASE_REASON);
    }));
});

describe("the Done poll", () => {
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
