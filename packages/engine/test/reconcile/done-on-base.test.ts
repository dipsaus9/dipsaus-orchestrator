// Reconcile releases the claim of a story that is Done on `_base` (DIPO-216 test plan): the
// 2026-10-19 case with real git and a remote, the crash between the worktree removal and the
// release, a run reopened before the git queue item, and the claims this step leaves alone. The
// Backlog CLI is scripted (see helpers.ts).

import { describe, expect, it } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { StoryKey } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../../src/db/office";
import type { OfficeGit } from "../../src/git/office";
import { DONE_ON_BASE_NOTICES } from "../../src/reconcile/done-on-base";
import { reconcileOffice, type ReconcileReport } from "../../src/reconcile";
import { findClaim, type ClaimRecord, liveClaimOf } from "../../src/worktree/records";
import { SlotTable } from "../../src/worktree/slots";
import { lastSeq } from "../stories/helpers";
import {
  branchOf,
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
  readonly slots: SlotTable;
  /** Takes a slot for the claim's worktree, as its setup does. */
  hold(record: ClaimRecord): number;
  /** One reconcile at start with a fresh index pass; `git` replaces the office git. */
  reconcile(git?: OfficeGit): Promise<{ report: ReconcileReport; reindexed: number }>;
}

function setupOf(o: ReconcileOffice): Setup {
  const slots = new SlotTable(join(o.repo.root, "slots.json"));
  return {
    slots,
    hold: (record) => {
      const slot = slots.take(
        { office: o.officeId, story: record.story, worktree: record.worktree, takenAt: 1 },
        20,
      );
      if (slot === null) throw new Error("no free slot");
      return slot;
    },
    reconcile: async (git) => {
      const real = o.engineGit.forOffice(o.officeId);
      if (real === undefined) throw new Error("the office git is not attached");
      const pass = await o.index.indexStories(o.officeId);
      let reindexed = 0;
      const report = await reconcileOffice(
        { officeId: o.officeId, office: o.office, git: git ?? real, clock: o.s.clock, slots },
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

describe("a story Done on the base releases its claim (DIPO-216)", () => {
  it("replays 2026-10-19: the clean worktree is removed and released, the dirty one is kept", () =>
    withReconcileOffice({ base: DONE }, async (o) => {
      const one = await claim(o, o.office, "TASK-1", keyOf(o.office, "TASK-1"), { active: false });
      const two = await claim(o, o.office, "TASK-2", keyOf(o.office, "TASK-2"), { active: false });
      for (const record of [one, two]) {
        await o.repo.git("push", "--quiet", "origin", record.branch);
      }
      writeFileSync(join(two.worktree, "scratch.txt"), "work in progress\n");
      const s = setupOf(o);
      const slotOne = s.hold(one);
      s.hold(two);
      const before = {
        one: [await localTip(o, one.branch), await remoteTip(o, one.branch)],
        two: [await localTip(o, two.branch), await remoteTip(o, two.branch)],
      };
      const seq = lastSeq(o.office);

      const { report, reindexed } = await s.reconcile();

      // The clean claim: released as done, worktree gone, slot free.
      const released = claimRow(o.office, one);
      expect(released.releaseReason).toBe("done");
      expect(released.releasedAt).not.toBeNull();
      expect(existsSync(one.worktree)).toBe(false);
      expect(s.slots.slotOf(one.worktree)).toBeNull();
      expect(slotOne).toBeGreaterThan(0);
      // The dirty claim keeps its worktree, claim, slot and lock.
      expect(existsSync(two.worktree)).toBe(true);
      expect(liveClaimOf(o.office, two.key)).not.toBeNull();
      expect(claimRow(o.office, two).teardownStartedAt).toBeNull();
      expect(s.slots.slotOf(two.worktree)).not.toBeNull();
      const locks = await o.repo.git("worktree", "list", "--porcelain");
      expect(locks).toContain(`locked dipo ${two.runId}`);
      // One info notice for the release, one warn notice naming the path and the file.
      const notices = noticesAfter(o.office, seq).filter((n) =>
        n.code.startsWith("reconcile.done"),
      );
      expect(notices.map((n) => n.code)).toEqual([
        DONE_ON_BASE_NOTICES.released,
        DONE_ON_BASE_NOTICES.kept,
      ]);
      expect(notices[0]?.text).toContain("TASK-1");
      expect(notices[0]?.text).toContain("main");
      expect(notices[1]?.text).toContain(two.worktree);
      expect(notices[1]?.text).toContain("scratch.txt");
      expect(report.findings.length).toBeGreaterThanOrEqual(2);
      // One more index pass after the release.
      expect(reindexed).toBe(1);
      // No branch moved, locally or on the remote.
      expect(await localTip(o, one.branch)).toBe(before.one[0] as string);
      expect(await remoteTip(o, one.branch)).toBe(before.one[1] as string);
      expect(await localTip(o, two.branch)).toBe(before.two[0] as string);
      expect(await remoteTip(o, two.branch)).toBe(before.two[1] as string);
      expect(before.one[1]).not.toBe("");
    }));

  it("resolves an open park of the run and forgets the worktree's tier T rows", () =>
    withReconcileOffice({ base: DONE }, async (o) => {
      const key = keyOf(o.office, "TASK-1");
      const one = await claim(o, o.office, "TASK-1", key, { active: false });
      o.office.run(
        `insert into parks (office_id, park_id, key, story_id, run_id, reason, from_state, detail,
           last_good_commit, at)
         values ($office_id, 1, $key, 'TASK-1', $run, 'stopped', 'In Progress', 'x', null, 1)`,
        { key, run: one.runId },
      );
      const s = setupOf(o);
      s.hold(one);
      await s.reconcile();
      const park = o.office.get<{ how: string | null }>(
        "select resolved_how as how from parks where office_id = $office_id and park_id = 1",
      );
      expect(park?.how).toBe("reconcile");
      expect(claimRow(o.office, one).releaseReason).toBe("done");
    }));

  it("releases a claim whose teardown started and whose worktree is already gone", () =>
    withReconcileOffice({ base: DONE }, async (o) => {
      const one = await claim(o, o.office, "TASK-1", keyOf(o.office, "TASK-1"), { active: false });
      const s = setupOf(o);
      s.hold(one);
      // A crash between the worktree removal and the release.
      await o.repo.git("worktree", "unlock", one.worktree);
      await o.repo.git("worktree", "remove", one.worktree);
      o.engineGit.forOffice(o.officeId)?.unpinWorktree(one.worktree);
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
      expect(s.slots.slotOf(one.worktree)).toBeNull();
      expect(await localTip(o, one.branch)).toBe(branch);
    }));

  it("keeps a worktree locked by someone else and clears a teardown start left by a crash", () =>
    withReconcileOffice({ base: DONE }, async (o) => {
      const one = await claim(o, o.office, "TASK-1", keyOf(o.office, "TASK-1"), { active: false });
      const s = setupOf(o);
      s.hold(one);
      await o.repo.git("worktree", "unlock", one.worktree);
      await o.repo.git("worktree", "lock", "--reason", "someone else", one.worktree);
      o.office.run(
        "update claims set teardown_started_at = 5 where office_id = $office_id and run_id = $run",
        { run: one.runId },
      );
      const seq = lastSeq(o.office);

      await s.reconcile();

      expect(existsSync(one.worktree)).toBe(true);
      expect(liveClaimOf(o.office, one.key)).not.toBeNull();
      expect(claimRow(o.office, one).teardownStartedAt).toBeNull();
      expect(s.slots.slotOf(one.worktree)).not.toBeNull();
      expect(await o.repo.git("worktree", "list", "--porcelain")).toContain("locked someone else");
      const kept = noticesAfter(o.office, seq).filter((n) => n.code === DONE_ON_BASE_NOTICES.kept);
      expect(kept.map((n) => n.text.includes("locked by someone else"))).toEqual([true]);
    }));

  it("keeps the worktree, lock and claim of a run reopened before the git queue item", () =>
    withReconcileOffice({ base: DONE }, async (o) => {
      const one = await claim(o, o.office, "TASK-1", keyOf(o.office, "TASK-1"), { active: false });
      const s = setupOf(o);
      s.hold(one);
      const real = o.engineGit.forOffice(o.officeId) as OfficeGit;
      const git = new Proxy(real, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target) as unknown;
          if (prop === "run") {
            return (fn: Parameters<OfficeGit["run"]>[0]) => {
              o.office.run(
                "update runs set ended_at = null, end_kind = null where office_id = $office_id and run_id = $run",
                { run: one.runId },
              );
              return target.run(fn);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      const { reindexed } = await s.reconcile(git);

      expect(existsSync(one.worktree)).toBe(true);
      expect(liveClaimOf(o.office, one.key)).not.toBeNull();
      expect(claimRow(o.office, one).teardownStartedAt).toBeNull();
      expect(s.slots.slotOf(one.worktree)).not.toBeNull();
      expect(await o.repo.git("worktree", "list", "--porcelain")).toContain(
        `locked dipo ${one.runId}`,
      );
      expect(reindexed).toBe(0);
    }));

  it("leaves alone a running claim, a story not Done on the base and a claim without a claim commit", () =>
    withReconcileOffice(
      {
        base: [
          { id: "TASK-1", status: "Done" },
          { id: "TASK-2", status: "In Progress" },
          { id: "TASK-3", status: "Done" },
        ],
      },
      async (o) => {
        const running = await claim(o, o.office, "TASK-1", keyOf(o.office, "TASK-1"));
        const notDone = await claim(o, o.office, "TASK-2", keyOf(o.office, "TASK-2"), {
          active: false,
        });
        const noCommit = await claim(o, o.office, "TASK-3", keyOf(o.office, "TASK-3"), {
          active: false,
        });
        o.office.run(
          "update claims set claim_sha = null where office_id = $office_id and run_id = $run",
          { run: noCommit.runId },
        );
        const s = setupOf(o);
        for (const record of [running, notDone, noCommit]) s.hold(record);

        const { reindexed } = await s.reconcile();

        for (const record of [running, notDone, noCommit]) {
          expect(existsSync(record.worktree)).toBe(true);
          expect(liveClaimOf(o.office, record.key as StoryKey)).not.toBeNull();
          expect(s.slots.slotOf(record.worktree)).not.toBeNull();
        }
        expect(reindexed).toBe(0);
        expect(branchOf("TASK-1")).toBe(running.branch);
      },
    ));
});
