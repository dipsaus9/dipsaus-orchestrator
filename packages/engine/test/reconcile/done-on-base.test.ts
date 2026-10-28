// Reconcile releases the claim of a story that is Done on `_base` (DIPO-216 test plan): the
// 2026-10-19 case with real git and a remote, the crash between the teardown's start and the
// release, a run reopened before the git queue item, and the claims this step leaves alone. The
// Backlog CLI is scripted (see helpers.ts).
//
// Two cases stay local: the claims this step leaves alone, and a run reopened before the git queue
// item. The rest is in done-on-base.ci.test.ts (CI only, DIPO-225).

import { describe, expect, it } from "bun:test";

import type { StoryKey } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../../src/db/office";
import type { OfficeGit } from "../../src/git/office";
import { reconcileOffice, type ReconcileReport } from "../../src/reconcile";
import { findClaim, type ClaimRecord, liveClaimOf } from "../../src/worktree/records";
import {
  branchOf,
  claim,
  type FakeTask,
  keyOf,
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

function claimRow(office: OfficeHandle, record: ClaimRecord): ClaimRecord {
  const found = findClaim(office, record.runId);
  if (found === null) throw new Error("the claim is gone");
  return found;
}

describe("a story Done on the base releases its claim (DIPO-216)", () => {
  it("keeps the branch and claim of a run reopened before the git queue item", () =>
    withReconcileOffice({ base: DONE }, async (o) => {
      const one = await claim(o, o.office, "TASK-1", keyOf(o.office, "TASK-1"), { active: false });
      const s = setupOf(o);
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

      expect(liveClaimOf(o.office, one.key)).not.toBeNull();
      expect(claimRow(o.office, one).teardownStartedAt).toBeNull();
      expect((await o.repo.git("rev-parse", one.branch)).trim()).toBe(one.claimSha as string);
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

        const { reindexed } = await s.reconcile();

        for (const record of [running, notDone, noCommit]) {
          expect(liveClaimOf(o.office, record.key as StoryKey)).not.toBeNull();
          expect((await o.repo.git("branch", "--list", record.branch)).trim()).not.toBe("");
        }
        expect(reindexed).toBe(0);
        expect(branchOf("TASK-1")).toBe(running.branch);
      },
    ));
});
