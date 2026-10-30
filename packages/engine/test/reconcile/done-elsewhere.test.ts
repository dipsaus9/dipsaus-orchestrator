// A story Done on the base through another branch (DIPO-161; 0020 section 10), with real git and a
// bare remote and the scripted Backlog CLI of helpers.ts: the DIPO-105 replay, a branch that adds
// nothing, a live worker, an own-branch teardown a crash interrupted, and the Done poll.
//
// One case stays local: the kept branch that adds commits. The rest is in
// done-elsewhere.ci.test.ts (CI only, DIPO-225).

import { describe, expect, it } from "bun:test";

import type { OfficeGit } from "../../src/git/office";
import { reconcileOffice, type ReconcileReport } from "../../src/reconcile";
import { DONE_ELSEWHERE_DESK, doneElsewhereDeskItems } from "../../src/worktree/done-elsewhere";
import { openReleasedBranches, releaseClaim } from "../../src/worktree/records";
import { claim, type FakeTask, keyOf, type ReconcileOffice, withReconcileOffice } from "./helpers";
import { backlogLayout } from "../story-store/backlog";

const DONE: readonly FakeTask[] = [{ id: "TASK-1", status: "Done" }];

interface Closed {
  readonly repo: string;
  readonly number: number;
  readonly comment: string;
}

function hostOf(): {
  closePr: (repo: string, n: number, c: string) => Promise<void>;
  closed: Closed[];
} {
  const closed: Closed[] = [];
  return {
    closed,
    closePr: async (repo, number, comment) => {
      closed.push({ repo, number, comment });
    },
  };
}

function gitOf(o: ReconcileOffice): OfficeGit {
  const git = o.engineGit.forOffice(o.officeId);
  if (git === undefined) throw new Error("the office git is not attached");
  return git;
}

/** One reconcile at start with a fresh index pass. */
async function reconcile(
  o: ReconcileOffice,
  host = hostOf(),
  boxes = { n: 0 },
): Promise<{ report: ReconcileReport; host: ReturnType<typeof hostOf> }> {
  const pass = await o.index.indexStories(o.officeId);
  const report = await reconcileOffice(
    {
      stories: backlogLayout,
      officeId: o.officeId,
      office: o.office,
      git: gitOf(o),
      clock: o.s.clock,
      host,
      finishBoxes: async () => {
        boxes.n += 1;
      },
    },
    { trigger: "rescan", pass, reindex: () => o.index.indexStories(o.officeId) },
  );
  return { report, host };
}

async function tipOf(o: ReconcileOffice, ref: string): Promise<string | null> {
  const result = await o.repo.run(["git", "rev-parse", "--verify", "--quiet", ref], o.repo.dir);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

describe("a story Done on the base through another branch (DIPO-161)", () => {
  it("keeps the kept branch of such a teardown, with a leftovers item, when it adds commits", () =>
    withReconcileOffice({ base: DONE }, async (o) => {
      const key = keyOf(o.office, "TASK-1");
      const record = await claim(o, o.office, "TASK-1", key, { active: false });
      o.office.immediate(() => {
        o.office.run(
          "update claims set teardown_started_at = 5 where office_id = $office_id and run_id = $run",
          { run: record.runId },
        );
        releaseClaim(o.office, record.runId, {
          at: 6,
          reason: "done",
          ending: "done",
          keepBranch: false,
        });
      });
      const tip = await tipOf(o, `refs/heads/${record.branch}`);

      await reconcile(o);

      expect(await tipOf(o, `refs/heads/${record.branch}`)).toBe(tip);
      expect(openReleasedBranches(o.office, key).map((r) => r.reason)).toEqual(["done-elsewhere"]);
      expect(doneElsewhereDeskItems(o.office).map((i) => i.kind)).toEqual([
        DONE_ELSEWHERE_DESK.leftovers,
      ]);
    }));
});
