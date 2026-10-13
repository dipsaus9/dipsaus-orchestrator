// The merge slot for backlog PRs (DIPO-73; 0016 rule 2, 0010 section 7) with a fake host, a
// scripted slot git and a fake structural check: green checks lead to one squash merge and the
// journal entries become merged; three refusals while the base moves leave the PR open with a
// notice; a conflicting base hands the branch to the lane for a rebuild; an operation submitted
// while the PR is in the slot is held for the next backlog PR; checks are read every
// `polling.prStateSeconds`. The real-git cases are in slot.ci.test.ts.

import { describe, expect, it } from "bun:test";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { allEntries, pendingLaneOp } from "../../src/backlog/lane";
import { findPr } from "../../src/backlog/pr";
import { OFFICE_DEFAULTS } from "../../src/config";
import { MAX_MERGE_ATTEMPTS, SLOT_NOTICES } from "../../src/merge-slot";
import { REPO } from "../backlog/pr/helpers";
import { notices } from "../backlog/lane/helpers";

import { BRANCH, GREEN, HEAD, openBacklogPr, slotSetup } from "./helpers";

const MERGED_HEAD = "2".repeat(40);

describe("the merge slot", () => {
  it("syncs, pushes once, waits for the checks, checks again, squash-merges and marks the entries merged", async () => {
    await withTempDir(async (dir) => {
      const s = await slotSetup(dir);
      await openBacklogPr(s);
      s.git.syncs = [{ kind: "merged", head: MERGED_HEAD }];

      // The PR enters the slot: the base is merged into the branch, pushed once, and the slot
      // waits while `ci-ok` is pending.
      expect(await s.slot.tick(s.officeId)).toBe("waiting");
      expect(s.slot.holding(s.officeId)).toBe(BRANCH);
      expect(s.git.calls).toEqual(["fetch", `syncBase ${BRANCH}`, `push ${BRANCH}`]);
      expect(s.host.merges).toEqual([]);

      // An operation submitted now is journaled and held: no flush reaches git.
      const held = await s.lane.submit({
        kind: "edit",
        key: s.keys.two,
        subject: "TASK-2",
        target: { status: "Refined" },
      });
      expect(held.report.held).toBe(true);
      expect(held.entry.state).toBe("pending");

      // Still pending: no second sync or push.
      expect(await s.slot.tick(s.officeId)).toBe("waiting");
      expect(s.git.calls.filter((call) => call.startsWith("push"))).toHaveLength(1);

      // Green: the structural check runs again on the merged head, then one squash merge at it.
      s.host.checks = GREEN;
      expect(await s.slot.tick(s.officeId)).toBe("merged");
      expect(s.rechecks).toEqual([MERGED_HEAD]);
      expect(s.host.merges).toEqual([{ number: 1, headSha: MERGED_HEAD }]);
      expect(s.host.calls.filter((call) => call.startsWith("merge"))).toEqual([
        `merge ${REPO} #1 at ${MERGED_HEAD}`,
      ]);

      // The PR's entries are merged, so pendingLaneOp stops reporting TASK-1; the held TASK-2
      // operation is still open and goes to the next backlog PR through a flush after the slot.
      expect(allEntries(s.office).map((entry) => [entry.subject, entry.state])).toEqual([
        ["TASK-1", "merged"],
        ["TASK-2", "pending"],
      ]);
      expect(pendingLaneOp(s.office, s.keys.one)).toBeNull();
      expect(pendingLaneOp(s.office, s.keys.two)?.ops).toEqual([2]);
      expect(findPr(s.office, 1)?.state).toBe("merged");
      expect(s.slot.holding(s.officeId)).toBeNull();
      expect(s.git.calls.at(-1)).toBe(`deleteBranch ${BRANCH}`);
      expect(s.flushes).toEqual([{ rebuild: undefined, heldThen: null }]);
      expect(notices(s.office).map((n) => n.code)).toEqual([
        SLOT_NOTICES.entered,
        SLOT_NOTICES.merged,
      ]);

      // Nothing is left for the slot.
      expect(await s.slot.tick(s.officeId)).toBe("idle");
    });
  });

  it("goes back to the base sync after a refusal and leaves the PR open after three", async () => {
    await withTempDir(async (dir) => {
      const s = await slotSetup(dir);
      await openBacklogPr(s);
      s.host.checks = GREEN;
      s.host.refusals = 3;
      // Each refusal comes with a moved base: the branch no longer contains it.
      s.git.containsBaseAnswer = false;
      s.git.syncs = [
        { kind: "contained", head: HEAD },
        { kind: "merged", head: "3".repeat(40) },
        { kind: "merged", head: "4".repeat(40) },
      ];

      expect(await s.slot.tick(s.officeId)).toBe("left");
      expect(s.host.merges.map((merge) => merge.headSha)).toEqual([
        HEAD,
        "3".repeat(40),
        "4".repeat(40),
      ]);
      expect(s.host.merges).toHaveLength(MAX_MERGE_ATTEMPTS);
      expect(s.git.calls.filter((call) => call.startsWith("syncBase"))).toHaveLength(3);
      expect(s.host.prs.get(1)?.state).toBe("open");
      expect(findPr(s.office, 1)?.state).toBe("open");
      const left = notices(s.office).filter((n) => n.code === SLOT_NOTICES.baseMoved);
      expect(left).toHaveLength(1);
      expect(left[0]?.text).toContain("base moved during merge 3 times");
      expect(s.slot.holding(s.officeId)).toBeNull();
      expect(pendingLaneOp(s.office, s.keys.one)).not.toBeNull();

      // It stays out of the slot until its head changes.
      expect(await s.slot.tick(s.officeId)).toBe("idle");
      s.git.heads.set(BRANCH, "5".repeat(40));
      expect(await s.slot.tick(s.officeId)).toBe("merged");
    });
  });

  it("leaves the PR open with a notice when the host refuses without a moved base", async () => {
    await withTempDir(async (dir) => {
      const s = await slotSetup(dir);
      await openBacklogPr(s);
      s.host.checks = GREEN;
      s.host.refusals = 1;
      expect(await s.slot.tick(s.officeId)).toBe("left");
      expect(s.host.merges).toHaveLength(1);
      expect(notices(s.office).map((n) => n.code)).toContain(SLOT_NOTICES.refused);
      expect(s.host.prs.get(1)?.state).toBe("open");
    });
  });

  it("hands a branch that conflicts with the base to the lane for a rebuild", async () => {
    await withTempDir(async (dir) => {
      const s = await slotSetup(dir);
      await openBacklogPr(s);
      s.git.syncs = [{ kind: "conflict" }];
      expect(await s.slot.tick(s.officeId)).toBe("rebuilt");
      // No push and no merge; the lane is flushed with the branch to rebuild, outside the hold.
      expect(s.git.calls).toEqual(["fetch", `syncBase ${BRANCH}`]);
      expect(s.host.merges).toEqual([]);
      expect(s.flushes).toEqual([{ rebuild: BRANCH, heldThen: null }]);
      expect(notices(s.office).map((n) => n.code)).toContain(SLOT_NOTICES.rebuilt);
    });
  });

  it("lets go of a PR whose required checks or structural check fail", async () => {
    await withTempDir(async (dir) => {
      const s = await slotSetup(dir);
      await openBacklogPr(s);
      s.host.checks = [
        { name: "ci-ok", state: "FAILURE", bucket: "fail" },
        { name: "pr-title", state: "SUCCESS", bucket: "pass" },
      ];
      expect(await s.slot.tick(s.officeId)).toBe("left");
      expect(notices(s.office).map((n) => n.code)).toContain(SLOT_NOTICES.checksFailed);
      expect(await s.slot.tick(s.officeId)).toBe("idle");

      // A re-run turns the checks green: it enters again, but now its structural check fails.
      s.host.checks = GREEN;
      s.recheckPasses = false;
      expect(await s.slot.tick(s.officeId)).toBe("left");
      expect(s.host.merges).toEqual([]);
      expect(await s.slot.tick(s.officeId)).toBe("idle");
    });
  });

  it("reads the checks every polling.prStateSeconds of the office configuration", async () => {
    await withTempDir(async (dir) => {
      const s = await slotSetup(dir);
      await openBacklogPr(s);
      s.config = { ...OFFICE_DEFAULTS, polling: { ...OFFICE_DEFAULTS.polling, prStateSeconds: 7 } };
      s.slot.watch(s.officeId, s.t.clock, 7);

      s.t.clock.advance(6_999);
      await s.slot.whenIdle(s.officeId);
      expect(s.host.checkReads).toBe(0);
      s.t.clock.advance(1);
      await s.slot.whenIdle(s.officeId);
      expect(s.host.checkReads).toBe(1);
      // Each tick's outcome is logged, so a slot that stops polling shows in the daemon log.
      expect(s.logs).toEqual(["debug merge slot entered #1", "debug merge slot tick waiting #1"]);

      // A changed configuration takes effect from the next interval.
      s.config = { ...OFFICE_DEFAULTS, polling: { ...OFFICE_DEFAULTS.polling, prStateSeconds: 3 } };
      s.t.clock.advance(7_000);
      await s.slot.whenIdle(s.officeId);
      expect(s.host.checkReads).toBe(2);
      s.t.clock.advance(3_000);
      await s.slot.whenIdle(s.officeId);
      expect(s.host.checkReads).toBe(3);

      // Green checks: the next poll merges.
      s.host.checks = GREEN;
      s.t.clock.advance(3_000);
      await s.slot.whenIdle(s.officeId);
      expect(s.host.merges).toEqual([{ number: 1, headSha: HEAD }]);
      expect(s.logs.at(-1)).toBe("debug merge slot tick merged #1");
      s.slot.stop();
      expect(s.t.clock.pendingTimers).toBe(0);
    });
  });

  it("keeps polling after a poll that failed, with a warning", async () => {
    await withTempDir(async (dir) => {
      const s = await slotSetup(dir);
      await openBacklogPr(s);
      s.slot.watch(s.officeId, s.t.clock, 7);
      Object.defineProperty(s, "config", {
        configurable: true,
        get: () => {
          throw new Error("config unreadable");
        },
      });
      s.t.clock.advance(7_000);
      expect(s.logs).toEqual(["warn merge slot poll failed"]);
      expect(s.t.clock.pendingTimers).toBe(1);

      Object.defineProperty(s, "config", { configurable: true, value: OFFICE_DEFAULTS });
      s.t.clock.advance(7_000);
      await s.slot.whenIdle(s.officeId);
      expect(s.host.checkReads).toBe(1);
      s.slot.stop();
    });
  });
});
