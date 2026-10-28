// CI only (0017 section 1, DIPO-225): real git repositories and processes, too slow for the local
// run.
// Reconcile releases the claim of a story that is Done on `_base` (DIPO-216 test plan): the
// 2026-10-19 case with real git and a remote, the crash between the teardown's start and the
// release, a run reopened before the git queue item, and the claims this step leaves alone. The
// Backlog CLI is scripted (see helpers.ts).

import { describe, expect, it } from "bun:test";
import type { OfficeHandle } from "../../src/db/office";
import type { OfficeGit } from "../../src/git/office";
import { DONE_ON_BASE_NOTICES, releaseDoneOnBase } from "../../src/reconcile/done-on-base";
import { reconcileOffice, type ReconcileReport } from "../../src/reconcile";
import { DONE_ELSEWHERE_NOTICES, findDoneElsewhere } from "../../src/worktree/done-elsewhere";
import { findClaim, type ClaimRecord, liveClaimOf } from "../../src/worktree/records";
import { lastSeq } from "../stories/helpers";
import {
  claim,
  type FakeTask,
  keyOf,
  noticesAfter,
  type ReconcileOffice,
  withReconcileOffice,
} from "./helpers";

const DONE: readonly FakeTask[] = [
  { id: "TASK-1", status: "Done" },
  { id: "TASK-2", status: "Done" },
];

interface Setup {
  /** One reconcile at start with a fresh index pass; `git` replaces the office git. */
  reconcile(git?: OfficeGit): Promise<{ report: ReconcileReport; reindexed: number }>;
}

function setupOf(o: ReconcileOffice): Setup {
  return {
    reconcile: async (git) => {
      const real = o.engineGit.forOffice(o.officeId);
      if (real === undefined) throw new Error("the office git is not attached");
      const pass = await o.index.indexStories(o.officeId);
      let reindexed = 0;
      const report = await reconcileOffice(
        { officeId: o.officeId, office: o.office, git: git ?? real, clock: o.s.clock },
        {
          trigger: "start",
          pass,
          reindex: () => {
            reindexed += 1;
            return o.index.indexStories(o.officeId);
          },
        },
      );
      return { report, reindexed };
    },
  };
}

async function remoteTip(o: ReconcileOffice, branch: string): Promise<string> {
  return (await o.repo.git("ls-remote", "origin", `refs/heads/${branch}`)).split("\t")[0] ?? "";
}

async function localTip(o: ReconcileOffice, branch: string): Promise<string> {
  return (await o.repo.git("rev-parse", `refs/heads/${branch}`)).trim();
}

function claimRow(office: OfficeHandle, record: ClaimRecord): ClaimRecord {
  const found = findClaim(office, record.runId);
  if (found === null) throw new Error("the claim is gone");
  return found;
}

/**
 * The office git with one empty commit on `_base` before each of the git queue items whose
 * 0-based index is in `at`, so `_base` moves between the index pass and that queue item.
 * `moved()` counts the commits.
 */
function movingBase(
  o: ReconcileOffice,
  at: readonly number[],
): { git: OfficeGit; moved: () => number } {
  const real = o.engineGit.forOffice(o.officeId) as OfficeGit;
  const base = real.baseWorktreePath();
  let moved = 0;
  let item = 0;
  const git = new Proxy(real, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop === "run") {
        return async (fn: Parameters<OfficeGit["run"]>[0]) => {
          const index = item;
          item += 1;
          if (at.includes(index)) {
            moved += 1;
            await o.repo.run(
              [
                "git",
                "commit",
                "--quiet",
                "--allow-empty",
                "--no-verify",
                "-m",
                `base moves ${moved}`,
              ],
              base,
            );
          }
          return target.run(fn);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { git, moved: () => moved };
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("releaseDoneOnBase counts the claims it skips because _base moved (DIPO-226)", () => {
    it("returns the released count and the baseMoved count, with no notice for a skip", () =>
      withReconcileOffice({ base: DONE }, async (o) => {
        const one = await claim(o, o.office, "TASK-1", keyOf(o.office, "TASK-1"), {
          active: false,
        });
        const deps = {
          officeId: o.officeId,
          office: o.office,
          git: o.engineGit.forOffice(o.officeId) as OfficeGit,
          clock: o.s.clock,
        };
        const pass = await o.index.indexStories(o.officeId);
        const noticed: string[] = [];
        // As reconcile's recorder: the facts and the notice, written together.
        const record = (finding: { code: string }, facts?: () => void) => {
          facts?.();
          noticed.push(finding.code);
        };

        // A pass whose commit is not the HEAD of `_base`: the queue item skips the claim.
        const stale = { ...pass, sha: "0".repeat(40) };
        expect(await releaseDoneOnBase(deps, stale, record)).toEqual({
          released: 0,
          baseMoved: 1,
          skippedRuns: [one.runId],
        });
        expect(liveClaimOf(o.office, one.key)).not.toBeNull();
        expect(noticed).toEqual([]);

        expect(await releaseDoneOnBase(deps, pass, record)).toEqual({
          released: 1,
          baseMoved: 0,
          skippedRuns: [],
        });
        expect(claimRow(o.office, one).releaseReason).toBe("done-elsewhere");
      }));

    it("with a set of run ids, looks only at those claims", () =>
      withReconcileOffice({ base: DONE }, async (o) => {
        const one = await claim(o, o.office, "TASK-1", keyOf(o.office, "TASK-1"), {
          active: false,
        });
        const two = await claim(o, o.office, "TASK-2", keyOf(o.office, "TASK-2"), {
          active: false,
        });
        const deps = {
          officeId: o.officeId,
          office: o.office,
          git: o.engineGit.forOffice(o.officeId) as OfficeGit,
          clock: o.s.clock,
        };
        const pass = await o.index.indexStories(o.officeId);
        const stale = { ...pass, sha: "0".repeat(40) };

        // Both claims are skipped; the set names only `two`, so `one` is not looked at.
        expect(await releaseDoneOnBase(deps, stale, () => {}, new Set([two.runId]))).toEqual({
          released: 0,
          baseMoved: 1,
          skippedRuns: [two.runId],
        });
        expect(liveClaimOf(o.office, one.key)).not.toBeNull();
        expect(liveClaimOf(o.office, two.key)).not.toBeNull();

        // A set that names no live claim looks at nothing.
        expect(await releaseDoneOnBase(deps, pass, () => {}, new Set(["run_none"]))).toEqual({
          released: 0,
          baseMoved: 0,
          skippedRuns: [],
        });
        expect(liveClaimOf(o.office, one.key)).not.toBeNull();
        expect(liveClaimOf(o.office, two.key)).not.toBeNull();
      }));
  });

  describe("reconcile retries a claim skipped because _base moved, once (DIPO-226)", () => {
    it("moves _base after the index pass: the claim is released in the same reconcile after one reindex", () =>
      withReconcileOffice({ base: DONE }, async (o) => {
        const s = setupOf(o);
        const one = await claim(o, o.office, "TASK-1", keyOf(o.office, "TASK-1"), {
          active: false,
        });
        const { git, moved } = movingBase(o, [0]);

        const { reindexed } = await s.reconcile(git);

        expect(moved()).toBe(1);
        expect(claimRow(o.office, one).releaseReason).toBe("done-elsewhere");
        // One reindex before the retry, and one after the retry released the claim.
        expect(reindexed).toBe(2);
      }));

    it("moves _base again after the reindex: reconcile retries once only, keeps the claim and writes no notice", () =>
      withReconcileOffice({ base: DONE }, async (o) => {
        const s = setupOf(o);
        const one = await claim(o, o.office, "TASK-1", keyOf(o.office, "TASK-1"), {
          active: false,
        });
        const { git, moved } = movingBase(o, [0, 1]);
        const seq = lastSeq(o.office);

        const { reindexed } = await s.reconcile(git);

        // The first queue item and the retry both skipped; no third try was made.
        expect(moved()).toBe(2);
        expect(reindexed).toBe(1);
        expect(liveClaimOf(o.office, one.key)).not.toBeNull();
        expect(claimRow(o.office, one).teardownStartedAt).toBeNull();
        const notices = noticesAfter(o.office, seq).filter((n) =>
          n.code.startsWith("reconcile.doneOnBase"),
        );
        expect(notices).toEqual([]);
      }));

    it("retries only the skipped claim: the first is released before the move, the second by the retry", () =>
      withReconcileOffice({ base: DONE }, async (o) => {
        const s = setupOf(o);
        // The first claim's queue item runs before `_base` moves.
        const first = await claim(o, o.office, "TASK-1", keyOf(o.office, "TASK-1"), {
          active: false,
        });
        const second = await claim(o, o.office, "TASK-2", keyOf(o.office, "TASK-2"), {
          active: false,
        });
        // `_base` moves before the second queue item, the second claim's.
        const { git, moved } = movingBase(o, [1]);
        const seq = lastSeq(o.office);

        const { reindexed } = await s.reconcile(git);

        expect(moved()).toBe(1);
        // The second claim was skipped by the move and released by the retry.
        expect(claimRow(o.office, second).releaseReason).toBe("done-elsewhere");
        expect(claimRow(o.office, first).releaseReason).toBe("done-elsewhere");
        expect(findDoneElsewhere(o.office, first.runId)).toMatchObject({ branchKept: true });
        // One leftovers notice per claim (both branches hold their claim commit); the retry never
        // looked at the first claim again.
        const notices = noticesAfter(o.office, seq);
        expect(notices.filter((n) => n.code === DONE_ON_BASE_NOTICES.kept)).toEqual([]);
        const leftovers = notices.filter((n) => n.code === DONE_ELSEWHERE_NOTICES.leftovers);
        expect(leftovers.map((n) => n.key)).toEqual([first.key, second.key]);
        // One reindex after the skip, one after the retry released the second claim.
        expect(reindexed).toBe(2);
      }));
  });

  describe("a story Done on the base releases its claim (DIPO-216)", () => {
    it("replays 2026-10-19: both claims are released and their branches kept as leftovers (DIPO-161)", () =>
      withReconcileOffice({ base: DONE }, async (o) => {
        const s = setupOf(o);
        const one = await claim(o, o.office, "TASK-1", keyOf(o.office, "TASK-1"), {
          active: false,
        });
        const two = await claim(o, o.office, "TASK-2", keyOf(o.office, "TASK-2"), {
          active: false,
        });
        for (const record of [one, two]) {
          await o.repo.git("push", "--quiet", "origin", record.branch);
        }
        const before = {
          one: [await localTip(o, one.branch), await remoteTip(o, one.branch)],
          two: [await localTip(o, two.branch), await remoteTip(o, two.branch)],
        };
        const seq = lastSeq(o.office);

        const { report, reindexed } = await s.reconcile();

        // Both claims: released as done-elsewhere.
        const released = claimRow(o.office, one);
        expect(released.releaseReason).toBe("done-elsewhere");
        expect(released.releasedAt).not.toBeNull();
        expect(claimRow(o.office, two).releaseReason).toBe("done-elsewhere");
        expect(liveClaimOf(o.office, two.key)).toBeNull();
        // Per claim, a release notice, then a leftovers notice: both branches hold their claim
        // commit.
        const notices = noticesAfter(o.office, seq).filter((n) =>
          n.code.startsWith("doneElsewhere"),
        );
        expect(notices.map((n) => [n.code, n.key])).toEqual([
          [DONE_ELSEWHERE_NOTICES.released, one.key],
          [DONE_ELSEWHERE_NOTICES.leftovers, one.key],
          [DONE_ELSEWHERE_NOTICES.released, two.key],
          [DONE_ELSEWHERE_NOTICES.leftovers, two.key],
        ]);
        expect(notices[0]?.text).toContain("TASK-1");
        expect(notices[0]?.text).toContain("main");
        expect(notices[3]?.text).toContain(two.branch);
        expect(notices[3]?.text).toContain('dipo discard TASK-2 --note "<why>"');
        expect(report.findings.length).toBeGreaterThanOrEqual(4);
        // One more index pass after the releases.
        expect(reindexed).toBe(1);
        // No branch moved, locally or on the remote: each holds a commit the base does not have.
        expect(await localTip(o, one.branch)).toBe(before.one[0] as string);
        expect(await remoteTip(o, one.branch)).toBe(before.one[1] as string);
        expect(await localTip(o, two.branch)).toBe(before.two[0] as string);
        expect(await remoteTip(o, two.branch)).toBe(before.two[1] as string);
        expect(before.one[1]).not.toBe("");
      }));

    it("resolves an open park of the run and forgets the branch's tier T rows", () =>
      withReconcileOffice({ base: DONE }, async (o) => {
        const s = setupOf(o);
        const key = keyOf(o.office, "TASK-1");
        const one = await claim(o, o.office, "TASK-1", key, { active: false });
        o.office.run(
          `insert into parks (office_id, park_id, key, story_id, run_id, reason, detail, last_good_commit, at)
         values ($office_id, 1, $key, 'TASK-1', $run, 'stopped', 'x', null, 1)`,
          { key, run: one.runId },
        );
        await s.reconcile();
        const park = o.office.get<{ how: string | null }>(
          "select resolved_how as how from parks where office_id = $office_id and park_id = 1",
        );
        expect(park?.how).toBe("done-elsewhere");
        expect(claimRow(o.office, one).releaseReason).toBe("done-elsewhere");
      }));

    it("releases a claim whose teardown started, without git", () =>
      withReconcileOffice({ base: DONE }, async (o) => {
        const s = setupOf(o);
        const one = await claim(o, o.office, "TASK-1", keyOf(o.office, "TASK-1"), {
          active: false,
        });
        // A crash between the teardown's start and the release.
        o.office.run(
          "update claims set teardown_started_at = 5 where office_id = $office_id and run_id = $run",
          { run: one.runId },
        );
        const branch = await localTip(o, one.branch);
        // Without git: no git queue item runs while the claim is still live.
        const real = o.engineGit.forOffice(o.officeId) as OfficeGit;
        let queuedWhileLive = 0;
        const git = new Proxy(real, {
          get(target, prop) {
            const value = Reflect.get(target, prop, target) as unknown;
            if (prop === "run") {
              return (fn: Parameters<OfficeGit["run"]>[0]) => {
                if (claimRow(o.office, one).releasedAt === null) queuedWhileLive += 1;
                return target.run(fn);
              };
            }
            return typeof value === "function" ? value.bind(target) : value;
          },
        });

        await s.reconcile(git);

        expect(queuedWhileLive).toBe(0);
        expect(claimRow(o.office, one).releaseReason).toBe("done");
        expect(await localTip(o, one.branch)).toBe(branch);
      }));
  });
}
