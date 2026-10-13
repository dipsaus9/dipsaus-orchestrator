// The planning lane against real temporary repositories and the pinned Backlog CLI (DIPO-34;
// 0010 section 2, lane b): operations are journaled before any CLI call, committed one by one on
// one engine branch and pushed; a merge on the remote drops them; a conflicting base change
// rebuilds them on a new branch and leaves the old one alone; an operation that no longer applies
// is dropped with a notice; every CLI write runs inside the office git queue; without a remote the
// branch stays local and the lane reports what waits.

import { describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";

import { withBareRemote, withTempRepo } from "@dipsaus-orchestrator/testkit";

import {
  allEntries,
  LANE_NOTICES,
  LaneError,
  OfficeLane,
  pendingLaneOp,
} from "../../../src/backlog/lane";
import {
  BACKLOG_FIXTURE,
  filesOf,
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

describe("the planning lane with a remote", () => {
  it("commits two operations on one engine branch and pushes it, every CLI call inside the git queue", async () => {
    await withBareRemote(async (repo) => {
      await publish(repo);
      const mainHead = await repo.git("rev-parse", "HEAD");
      const s = await laneSetup(repo);
      const lane = s.lane();
      const one = storyKey(s);
      const two = storyKey(s);

      // While the flush item runs, a probe item submitted from the first CLI call must wait.
      let probe: Promise<void> | undefined;
      let outsideQueue = 0;
      s.hooks.onCli = () => {
        if (s.git.queue.pending === 0) outsideQueue += 1;
        probe ??= s.git.run(async () => {
          s.log.push("probe");
        });
      };

      const first = await lane.submit({
        kind: "edit",
        key: one,
        subject: "TASK-1",
        target: { status: "Refined" },
      });
      expect(first.entry.state).toBe("pending");
      const second = await lane.submit({
        kind: "edit",
        key: two,
        subject: "TASK-2",
        target: { labels: { add: ["tier:M"] }, fields: { unknowns: [] } },
      });
      await probe;

      const branch = first.report.branch;
      expect(branch).toMatch(/^dipo\/backlog-20260101T000000$/);
      expect(second.report.branch).toBe(branch);
      expect(first.report.pushed).toBe(true);
      expect(second.report.pushed).toBe(true);

      // Two commits, one per operation, each touching only its task file, on the remote.
      expect(await subjects(repo.remote, repo.home, branch as string, "main")).toEqual([
        "backlog: edit TASK-1",
        "backlog: edit TASK-2",
      ]);
      const commits = (await inRemote(repo, "rev-list", "--reverse", branch as string, "^main"))
        .trim()
        .split("\n");
      expect(await filesOf(repo.remote, repo.home, commits[0] as string)).toEqual([
        "backlog/tasks/task-1 - Add-the-CSV-export-command.md",
      ]);
      expect(await filesOf(repo.remote, repo.home, commits[1] as string)).toEqual([
        "backlog/tasks/task-2 - Rename-the-export-setting.md",
      ]);
      expect(allEntries(s.office).map((e) => [e.opId, e.state, e.branch, e.commit])).toEqual([
        [1, "pushed", branch, commits[0] ?? null],
        [2, "pushed", branch, commits[1] ?? null],
      ]);

      // Every CLI call ran inside a queue item; the probe, queued during the first flush, ran only
      // after that flush's last CLI call and before the second operation's first.
      expect(outsideQueue).toBe(0);
      const probeAt = s.log.indexOf("probe");
      expect(probeAt).toBeGreaterThan(s.log.findLastIndex((line) => line.includes("TASK-1")));
      expect(probeAt).toBeLessThan(s.log.findIndex((line) => line.includes("TASK-2")));
      expect(s.log.filter((line) => line.startsWith("cli ")).length).toBeGreaterThan(4);

      // The maintainer's main checkout is untouched.
      expect(await repo.git("rev-parse", "HEAD")).toBe(mainHead);
      expect(await repo.git("status", "--porcelain")).toBe("");
      expect(await repo.git("symbolic-ref", "HEAD")).toBe("refs/heads/main\n");
    }, FIXTURE);
  });

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

  it("refuses an operation on a story with a live claim and journals nothing", async () => {
    await withBareRemote(async (repo) => {
      await publish(repo);
      const s = await laneSetup(repo);
      const key = storyKey(s);
      const lane = new OfficeLane({
        officeId: s.office.officeId,
        office: s.office,
        git: s.git,
        cli: s.cli,
        clock: s.t.clock,
        kinds: s.kinds,
        liveClaim: (_office, claimed) => claimed === key,
      });
      const refused = await lane
        .journal({ kind: "edit", key, subject: "TASK-1", target: { status: "Refined" } })
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(LaneError);
      expect((refused as LaneError).code).toBe("backlog.lane.liveClaim");
      expect(allEntries(s.office)).toEqual([]);
      expect(pendingLaneOp(s.office, key)).toBeNull();
    }, FIXTURE);
  });
});

describe("the planning lane without a remote", () => {
  it("keeps the branch local, reports what waits, and drops the operations after a hand merge", async () => {
    await withTempRepo(async (repo) => {
      await publish(repo);
      const s = await laneSetup(repo);
      const lane = s.lane();
      const key = storyKey(s);

      const { report } = await lane.submit({
        kind: "edit",
        key,
        subject: "TASK-1",
        target: { status: "Refined" },
      });
      const branch = report.branch as string;
      expect(report.pushed).toBe(false);
      expect(report.waiting).toMatchObject({
        branch,
        reason: "noRemote",
        ops: [{ opId: 1, message: "backlog: edit TASK-1" }],
      });
      expect(lane.waiting()?.branch).toBe(branch);
      expect(allEntries(s.office)[0]?.state).toBe("committed");
      const waiting = notices(s.office).filter((n) => n.code === LANE_NOTICES.waiting);
      expect(waiting).toHaveLength(1);
      expect(waiting[0]?.text).toContain(branch);
      expect(waiting[0]?.text).toContain("backlog: edit TASK-1");

      // The maintainer merges it by hand.
      await repo.git("merge", "--quiet", "--squash", branch);
      await repo.git("commit", "--quiet", "-m", "merge the backlog branch");
      const after = await lane.flush();
      expect(after).toMatchObject({ branch: null, merged: [1], waiting: null });
      expect(pendingLaneOp(s.office, key)).toBeNull();
      expect(realpathSync(lane.worktreePath())).toBe(
        realpathSync(join(repo.root, "repo.worktrees", "_backlog")),
      );
    }, FIXTURE);
  });
});
