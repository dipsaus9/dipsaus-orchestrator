// CI only (0017 section 1): the slower planning lane cases against real temporary repositories and
// the pinned Backlog CLI (DIPO-34; 0010 section 2, lane b), kept out of the local suite for its
// time budget (DIPO-77): a merge on the remote drops the operations, and a conflicting base change
// rebuilds them on a new branch, drops what no longer applies and leaves the old branch alone.
// A fast local version of the rebuild, without a remote, is in lane.test.ts.

import { describe, expect, it } from "bun:test";

import { withBareRemote } from "@dipsaus-orchestrator/testkit";

import { allEntries, LANE_NOTICES, pendingLaneOp } from "../../../src/backlog/lane";
import {
  BACKLOG_FIXTURE,
  inRemote,
  laneSetup,
  notices,
  publish,
  pushStatusChange,
  squashMergeOnRemote,
  storyKey,
  subjects,
} from "./helpers";

const FIXTURE = { fixture: BACKLOG_FIXTURE };

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("the planning lane with a remote", () => {
    it("drops operations once the branch merged on the remote, and pendingLaneOp clears", async () => {
      await withBareRemote(async (repo) => {
        await publish(repo);
        const s = await laneSetup(repo);
        const lane = s.lane();
        const key = storyKey(s);

        const entry = await lane.journal({
          kind: "edit",
          key,
          subject: "TASK-1",
          target: { status: "Refined" },
        });
        // Covered from journaling on, before any CLI call.
        expect(s.log).toEqual([]);
        expect(pendingLaneOp(s.office, key)).toEqual({
          reason: "notRunnable",
          notice: "pending backlog PR",
          ops: [entry.opId],
        });

        const report = await lane.flush();
        const branch = report.branch as string;
        expect(report.pushed).toBe(true);
        expect(pendingLaneOp(s.office, key)?.notice).toBe("pending backlog PR");

        await squashMergeOnRemote(repo, branch);
        const after = await lane.flush();
        expect(after).toMatchObject({ branch: null, merged: [entry.opId], committed: [] });
        expect(allEntries(s.office)[0]?.state).toBe("merged");
        expect(pendingLaneOp(s.office, key)).toBeNull();

        // The local changes are dropped: the worktree sits on the new base, the branch is gone.
        const worktree = lane.worktreePath();
        expect(await repo.git("-C", worktree, "rev-parse", "HEAD")).toBe(
          await repo.git("rev-parse", "origin/main"),
        );
        expect(await repo.git("branch", "--list", branch)).toBe("");

        // The next operation starts a new branch from the new base.
        s.t.clock.advance(1000);
        const next = await lane.submit({
          kind: "edit",
          key,
          subject: "TASK-1",
          target: { labels: { add: ["tier:M"] } },
        });
        expect(next.report.branch).toBe("dipo/backlog-20260101T000001");
        expect(
          await subjects(repo.remote, repo.home, "dipo/backlog-20260101T000001", "main"),
        ).toEqual(["backlog: edit TASK-1"]);
      }, FIXTURE);
    });

    it("rebuilds on a new branch after a conflicting base change, drops what no longer applies, and leaves the old branch alone", async () => {
      await withBareRemote(async (repo) => {
        await publish(repo);
        const s = await laneSetup(repo);
        const lane = s.lane();
        const one = storyKey(s);
        const two = storyKey(s);

        await lane.submit({
          kind: "edit",
          key: one,
          subject: "TASK-1",
          target: { status: "Parked" },
        });
        const { report } = await lane.submit({
          kind: "edit",
          key: two,
          subject: "TASK-2",
          target: { from: ["Refined"], status: "Ready" },
        });
        const old = report.branch as string;
        const oldRemote = await inRemote(repo, "rev-parse", old);
        const oldLocal = await repo.git("rev-parse", old);

        // Someone else changes both status lines on the base.
        await pushStatusChange(repo, { "TASK-1": "In Progress", "TASK-2": "Done" });
        const rebuilt = await lane.flush();

        expect(rebuilt.rebuiltFrom).toBe(old);
        expect(rebuilt.branch).toBe(`${old}-2`);
        expect(rebuilt.committed).toEqual([1]);
        expect(rebuilt.dropped).toEqual([2]);
        expect(rebuilt.pushed).toBe(true);
        // Never force-pushed: the old branch is where it was, here and on the remote.
        expect(await inRemote(repo, "rev-parse", old)).toBe(oldRemote);
        expect(await repo.git("rev-parse", old)).toBe(oldLocal);
        expect(await subjects(repo.remote, repo.home, `${old}-2`, "main")).toEqual([
          "backlog: edit TASK-1",
        ]);
        const entries = allEntries(s.office);
        expect(entries.map((e) => [e.opId, e.state, e.branch])).toEqual([
          [1, "pushed", `${old}-2`],
          [2, "dropped", null],
        ]);
        expect(pendingLaneOp(s.office, two)).toBeNull();
        expect(pendingLaneOp(s.office, one)).not.toBeNull();

        const codes = notices(s.office).map((n) => [n.code, n.key]);
        expect(codes).toContainEqual([LANE_NOTICES.rebuilt, null]);
        expect(codes).toContainEqual([LANE_NOTICES.dropped, two]);
        expect(entries[1]?.notice).toContain("TASK-2 is Done now, not Refined");
      }, FIXTURE);
    });
  });
}
