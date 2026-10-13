// Claim facts (DIPO-38; 0007 section 4): migration 8's `claims` and `released_branches`, one live
// claim per story and per branch, and the release that keeps a branch for its story.

import { describe, expect, it } from "bun:test";

import { RunId, StoryKey } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { insertClaim, type NewClaim } from "../../src/worktree/records";
import {
  hasLiveClaim,
  keysTrackingBranch,
  liveClaims,
  releaseClaim,
  releasedBranchFor,
} from "../../src/worktree";
import { addOffice, openTestState } from "../commands/helpers";

function newClaim(key: StoryKey, runId: RunId, branch = "TASK-1/add-csv"): NewClaim {
  return {
    runId,
    key,
    story: "TASK-1",
    branch,
    worktree: "/w/TASK-1",
    base: "main",
    baseSha: "a".repeat(40),
    startSha: "a".repeat(40),
    claimSha: null,
    reused: false,
    snapshot: {
      path: "/w/TASK-1",
      adminDir: "/r/.git/worktrees/TASK-1",
      commondir: "../..\n",
      gitdir: "/w/TASK-1/.git\n",
      pointer: "gitdir: /r/.git/worktrees/TASK-1\n",
    },
    firstFeedback: null,
    claimedAt: 1,
  };
}

describe("claim records", () => {
  it("keeps one live claim per story and branch, and records a kept branch at release", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      const office = addOffice(t);
      const key = StoryKey.parse(t.ids.next("sto"));
      const other = StoryKey.parse(t.ids.next("sto"));
      const run1 = RunId.parse(t.ids.next("run"));
      const run2 = RunId.parse(t.ids.next("run"));

      office.immediate(() => insertClaim(office, newClaim(key, run1)));
      expect(hasLiveClaim(office, key)).toBe(true);
      expect(() => office.immediate(() => insertClaim(office, newClaim(key, run2, "x")))).toThrow();
      expect(() => office.immediate(() => insertClaim(office, newClaim(other, run2)))).toThrow();

      office.immediate(() =>
        releaseClaim(office, run1, { at: 5, reason: "amend", keepBranch: true }),
      );
      expect(hasLiveClaim(office, key)).toBe(false);
      expect(liveClaims(office)).toEqual([]);
      expect(releasedBranchFor(office, key, "TASK-1/add-csv")).toEqual({
        branch: "TASK-1/add-csv",
        key,
        releasedAt: 5,
        reason: "amend",
      });
      expect(releasedBranchFor(office, other, "TASK-1/add-csv")).toBeNull();
      expect(keysTrackingBranch(office, "TASK-1/add-csv")).toEqual([key]);
      t.state.close();
    }));
});
