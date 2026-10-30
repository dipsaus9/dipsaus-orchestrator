// The planning lane flushes again and says when it cannot (DIPO-401, gap G16), against real
// temporary repositories, a bare remote and the pinned Backlog CLI:
// - the cause: Backlog.md 1.53's `draft create` fails without a `backlog/drafts` folder, which git
//   does not keep while it is empty; every flush failed at the first accepted proposal, so the
//   discards journaled after it were never reached and stayed pending too;
// - the fix: proposals journaled before discards of Done stories flush into one backlog branch on
//   a repository with no drafts folder, and the discards are dropped with their notice;
// - an operation the CLI fails on is closed as `failed` with a notice, and the others go on;
// - every flush that holds, fails or waits logs its reason, and a lane with an operation unapplied
//   for 30 minutes of the engine clock is on the desk until a flush applies it;
// - the planning lane's `flush(change)` says what happened to the change, as `proposal.accept`
//   reports it.

import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withBareRemote, withTempRepo } from "@dipsaus-orchestrator/testkit";

import {
  allEntries,
  DISCARD_KIND,
  editKind,
  failedHoldDeskItems,
  HOLD_KIND,
  LANE_NOTICES,
  LANE_STUCK_MS,
  laneDeskItems,
  OfficeLane,
  type OfficeLaneOptions,
  PLANNING_LANE_DESK,
  planningLane,
  PROPOSE_KIND,
  proposeKind,
  recordPrRef,
} from "../../../src/backlog/lane";
import { BacklogCommandError, runBacklog } from "../../../src/backlog/runner";
import type { ProposedDraft } from "../../../src/story-store/planning";
import { backlogLayout } from "../../story-store/backlog";
import {
  BACKLOG_FIXTURE,
  inRemote,
  type LaneSetup,
  laneSetup,
  notices,
  publish,
  storyKey,
  subjects,
  taskFile,
} from "./helpers";

const FIXTURE = { fixture: BACKLOG_FIXTURE };

interface Line {
  readonly level: "info" | "warn";
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>> | undefined;
}

function memoryLog(): { lines: Line[]; logger: NonNullable<OfficeLaneOptions["logger"]> } {
  const lines: Line[] = [];
  return {
    lines,
    logger: {
      info: (message, fields) => lines.push({ level: "info", message, fields }),
      warn: (message, fields) => lines.push({ level: "warn", message, fields }),
    },
  };
}

/** The setup's lane with the kinds `proposal.accept`, `work.discard` and `story.park` journal, and `extra`. */
function laneOf(s: LaneSetup, extra: Partial<OfficeLaneOptions> = {}): OfficeLane {
  s.kinds.set(PROPOSE_KIND, proposeKind);
  s.kinds.set(DISCARD_KIND, editKind(DISCARD_KIND));
  s.kinds.set(HOLD_KIND, editKind(HOLD_KIND));
  return new OfficeLane({
    officeId: s.office.officeId,
    office: s.office,
    git: s.git,
    cli: s.cli,
    clock: s.t.clock,
    kinds: s.kinds,
    ...extra,
  });
}

/** A repository like this one: no draft yet, so git holds no `backlog/drafts` folder. */
function withoutDrafts(dir: string): void {
  rmSync(join(dir, "backlog", "drafts"), { recursive: true, force: true });
}

function setStatus(dir: string, id: string, status: string): void {
  const file = taskFile(dir, id);
  writeFileSync(file, readFileSync(file, "utf8").replace(/^status: .*$/m, `status: ${status}`));
}

function draft(n: number): ProposedDraft {
  return {
    proposal: String(n).repeat(64),
    title: `Split the module ${n}`,
    description: `Outcome (the worker's words): module ${n} is two.`,
    references: ["src/module.ts"],
  };
}

describe("the stall of gap G16 (DIPO-401)", () => {
  it("is Backlog.md 1.53's draft create failing without a drafts folder", async () => {
    await withTempRepo(async (repo) => {
      withoutDrafts(repo.dir);
      await publish(repo);
      const s = await laneSetup(repo);
      const failed = await runBacklog(s.cli, repo.dir, [
        "draft",
        "create",
        "Split the module",
        "--description",
        "two",
      ]).catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(BacklogCommandError);
      expect((failed as BacklogCommandError).exitCode).toBe(1);
      expect((failed as BacklogCommandError).stderr).toContain("ENOENT");
      expect((failed as BacklogCommandError).stderr).toContain("backlog/drafts");
    }, FIXTURE);
  });

  it("flushes proposals journaled before discards of Done stories into one backlog branch, without a drafts folder", async () => {
    await withBareRemote(async (repo) => {
      withoutDrafts(repo.dir);
      setStatus(repo.dir, "TASK-2", "Done");
      await publish(repo);
      const s = await laneSetup(repo);
      const log = memoryLog();
      const lane = laneOf(s, { logger: log.logger });
      const planning = planningLane(lane);
      // As on the cutover daemon: the accepted proposals first, then a discard of a story that is
      // Done by now.
      await planning.fileDraft("DIPO-300", draft(1));
      await planning.fileDraft("DIPO-301", draft(2));
      await planning.discard({ key: storyKey(s), story: "TASK-2" });

      const report = await lane.flush();
      expect(report.committed).toEqual([1, 2]);
      expect(report.dropped).toEqual([3]);
      expect(report.pushed).toBe(true);
      const branch = report.branch as string;
      expect(await subjects(repo.remote, repo.home, branch, "main")).toEqual([
        "backlog: propose DIPO-300",
        "backlog: propose DIPO-301",
      ]);
      expect(allEntries(s.office).map((entry) => entry.state)).toEqual([
        "pushed",
        "pushed",
        "dropped",
      ]);
      const dropped = notices(s.office).filter((n) => n.code === LANE_NOTICES.dropped);
      expect(dropped.map((n) => n.text)).toEqual([expect.stringContaining("TASK-2 is Done now")]);
      expect(notices(s.office).filter((n) => n.code === LANE_NOTICES.flushFailed)).toEqual([]);
      expect(log.lines).toContainEqual(
        expect.objectContaining({ level: "info", message: "the planning lane flushed" }),
      );
      expect(lane.stall()).toBeNull();
    }, FIXTURE);
  });

  it("closes an operation the Backlog CLI fails on as failed, with a notice, and applies the others", async () => {
    await withBareRemote(async (repo) => {
      await publish(repo);
      const s = await laneSetup(repo);
      const log = memoryLog();
      const lane = laneOf(s, { logger: log.logger });
      // A status the fixture's config does not know: the CLI exits non-zero on this one alone.
      const broken = await lane.journal({
        kind: "edit",
        key: storyKey(s),
        subject: "TASK-1",
        target: { status: "No Such Status" },
      });
      const fine = await lane.journal({
        kind: "edit",
        key: storyKey(s),
        subject: "TASK-2",
        target: { status: "Ready" },
      });

      const report = await lane.flush();
      expect(report.failed).toEqual([broken.opId]);
      expect(report.committed).toEqual([fine.opId]);
      expect(report.pushed).toBe(true);
      expect(await inRemote(repo, "log", "--format=%s", "-1", report.branch as string)).toBe(
        "backlog: edit TASK-2\n",
      );
      const [first, second] = allEntries(s.office);
      expect(first?.state).toBe("failed");
      expect(first?.closedAt).not.toBeNull();
      expect(second?.state).toBe("pushed");
      const closed = notices(s.office).filter((n) => n.code === LANE_NOTICES.failed);
      expect(closed).toHaveLength(1);
      expect(closed[0]?.level).toBe("warn");
      expect(closed[0]?.text).toContain("`backlog: edit TASK-1` failed and is closed");
      expect(first?.notice).toBe(closed[0]?.text ?? "");
      expect(log.lines).toContainEqual(
        expect.objectContaining({
          level: "warn",
          message: "a planning lane operation failed and is closed",
        }),
      );
      // The `_backlog` worktree holds nothing of the failed operation, and it is not tried again.
      expect(await repo.git("-C", lane.worktreePath(), "status", "--porcelain")).toBe("");
      const again = await lane.flush();
      expect(again.failed).toBeUndefined();
      expect(notices(s.office).filter((n) => n.code === LANE_NOTICES.failed)).toHaveLength(1);
    }, FIXTURE);
  });
});

describe("a park whose hold the Backlog CLI fails on (DIPO-401)", () => {
  it("holds the story from pickup, fail closed, and puts it on the desk", async () => {
    await withBareRemote(async (repo) => {
      // A configuration without the Parked status: the CLI refuses `--status Parked`.
      const config = join(repo.dir, "backlog", "config.yml");
      writeFileSync(config, readFileSync(config, "utf8").replace(`"Parked", `, ""));
      await publish(repo);
      const s = await laneSetup(repo);
      const lane = laneOf(s);
      const key = storyKey(s);
      const hold = await planningLane(lane).hold(
        { key, story: "TASK-1" },
        { from: "Ready", note: "later" },
      );
      expect(backlogLayout.planningHold(s.office, key)).toBe("pending");

      const report = await lane.flush();
      expect(report.failed).toEqual([hold.opId]);
      // Nothing of it is open any more, and still the story is held.
      expect(backlogLayout.planningHold(s.office, key)).toBe("holdFailed");
      expect(planningLane(lane).failedHold(key)).toEqual({ opId: hold.opId, from: "Ready" });
      expect(failedHoldDeskItems(s.office).map((item) => [item.kind, item.story])).toEqual([
        ["PARK NOT WRITTEN", "TASK-1"],
      ]);

      // Sent again, it is pending; dismissed, nothing holds the story.
      const again = await planningLane(lane).hold(
        { key, story: "TASK-1" },
        { from: "Ready", note: "later" },
      );
      expect(again.opId).not.toBe(hold.opId);
      expect(backlogLayout.planningHold(s.office, key)).toBe("pending");
      planningLane(lane).withdraw(again);
      expect(backlogLayout.planningHold(s.office, key)).toBeNull();
    }, FIXTURE);
  });
});

describe("a planning lane that cannot flush (DIPO-401)", () => {
  it("logs each early return and failure with its reason, and keeps it as its stall", async () => {
    await withBareRemote(async (repo) => {
      await publish(repo);
      const s = await laneSetup(repo);
      const log = memoryLog();
      let held: string | null = "dipo/backlog-20260101T000000";
      let hook: Error | null = null;
      const lane = laneOf(s, {
        logger: log.logger,
        held: () => held,
        onFlushed: async () => {
          if (hook !== null) throw hook;
        },
      });

      // Nothing open.
      held = null;
      await lane.flush();
      expect(log.lines.at(-1)).toMatchObject({
        level: "info",
        message: "the planning lane has nothing to flush",
        fields: { reason: "no operation is open" },
      });

      // Held: the operation stays journaled.
      held = "dipo/backlog-20260101T000000";
      const { report } = await lane.submit({
        kind: "edit",
        key: storyKey(s),
        subject: "TASK-1",
        target: { status: "Refined" },
      });
      expect(report.held).toBe(true);
      expect(log.lines.at(-1)).toMatchObject({
        level: "info",
        message: "the planning lane holds its operations",
        fields: { pending: 1 },
      });
      expect(String(log.lines.at(-1)?.fields?.["reason"])).toContain(
        "dipo/backlog-20260101T000000 has auto-merge on",
      );
      expect(lane.stall()?.reason).toContain("has auto-merge on");

      // A failed flush: something that is not the engine's worktree sits where `_backlog` goes.
      held = null;
      mkdirSync(lane.worktreePath(), { recursive: true });
      writeFileSync(join(lane.worktreePath(), "mine.txt"), "not dipo's\n");
      await expect(lane.flush()).rejects.toThrow("is not a worktree of this repository");
      expect(log.lines.at(-1)).toMatchObject({
        level: "warn",
        message: "the planning lane's flush failed",
      });
      expect(lane.stall()?.reason).toContain("is not a worktree of this repository");
      rmSync(lane.worktreePath(), { recursive: true });

      // A failed fetch, then a push that waits for it.
      await repo.git("remote", "set-url", "origin", join(repo.root, "gone.git"));
      const waits = await lane.flush();
      expect(waits.waiting?.reason).toBe("fetchFailed");
      const fetchLine = log.lines.find(
        (line) =>
          line.message === "the planning lane could not fetch; it applies to the last fetched base",
      );
      expect(fetchLine?.level).toBe("warn");
      expect(log.lines.at(-1)).toMatchObject({
        level: "warn",
        message: "the planning lane's branch waits",
      });
      expect(lane.stall()?.reason).toContain("waits: the push waits until a fetch of origin");

      // The after-flush step (the backlog PR) fails: the flush itself stands, the log says so.
      await repo.git("remote", "set-url", "origin", repo.remote);
      hook = new Error("the host is down");
      const pushed = await lane.flush();
      expect(pushed.pushed).toBe(true);
      expect(log.lines.at(-1)).toMatchObject({
        level: "warn",
        message: "the planning lane's after-flush step failed",
        fields: { reason: "the host is down" },
      });
      expect(lane.stall()).toBeNull();
    }, FIXTURE);
  });

  it("logs a branch that waits for a remote it does not have", async () => {
    await withTempRepo(async (repo) => {
      await publish(repo);
      const s = await laneSetup(repo);
      const log = memoryLog();
      const lane = laneOf(s, { logger: log.logger });
      await lane.submit({
        kind: "edit",
        key: storyKey(s),
        subject: "TASK-1",
        target: { status: "Refined" },
      });
      expect(log.lines.at(-1)).toMatchObject({
        level: "warn",
        message: "the planning lane's branch waits",
      });
      expect(lane.stall()?.reason).toContain("the office has no remote origin");

      // What the flush did with a change says the branch it waits on, never an empty one.
      const planning = planningLane(lane);
      const change = await planning.hold(
        { key: storyKey(s), story: "TASK-2" },
        { from: "Refined", note: "later" },
      );
      const flush = await planning.flush(change);
      expect(flush).toEqual({
        state: "waiting",
        branch: expect.stringMatching(/^dipo\/backlog-/),
        reason: expect.stringContaining("the office has no remote origin"),
      });
    }, FIXTURE);
  });

  it("is on the desk once an operation waits 30 minutes of the engine clock, until a flush applies it", async () => {
    await withBareRemote(async (repo) => {
      await publish(repo);
      const s = await laneSetup(repo);
      let held: string | null = "dipo/backlog-20260101T000000";
      const lane = laneOf(s, { held: () => held });
      const desk = () => laneDeskItems(s.office, lane.stall(), s.t.clock.now());

      await lane.submit({
        kind: "edit",
        key: storyKey(s),
        subject: "TASK-1",
        target: { status: "Refined" },
      });
      s.t.clock.advance(LANE_STUCK_MS - 1);
      expect(desk()).toEqual([]);
      s.t.clock.advance(1);
      const [item, ...rest] = desk();
      expect(rest).toEqual([]);
      expect(item?.kind).toBe(PLANNING_LANE_DESK);
      expect(item?.detail).toContain("the planning lane is stuck: 1 backlog operation waits");
      expect(item?.detail).toContain("the oldest for 30 minutes");
      expect(item?.detail).toContain("has auto-merge on");
      expect(item?.since).toBe(allEntries(s.office)[0]?.createdAt ?? -1);
      expect(item?.hand).toContain("fix what the reason names");

      // The hold ends and a flush applies and pushes the operation: the item is gone.
      held = null;
      const report = await lane.flush();
      expect(report.pushed).toBe(true);
      expect(desk()).toEqual([]);
    }, FIXTURE);
  });
});

describe("what the planning lane's flush did with a change (DIPO-401)", () => {
  it("names the backlog PR it opened, then updated, a hold, a closed change and a failed flush", async () => {
    await withBareRemote(async (repo) => {
      withoutDrafts(repo.dir);
      await publish(repo);
      const s = await laneSetup(repo);
      let held: string | null = null;
      const url = "https://github.com/acme/app/pull/9";
      const lane = laneOf(s, {
        held: () => held,
        // As `BacklogPrs.afterFlush` does once it opened the branch's PR.
        onFlushed: async (_office, report) => {
          if (report.branch !== null) {
            const branch = report.branch;
            s.office.immediate(() => recordPrRef(s.office, branch, url, s.t.clock.now()));
          }
        },
      });
      const planning = planningLane(lane);

      const one = await planning.fileDraft("DIPO-300", draft(1));
      const opened = await planning.flush(one);
      expect(opened).toEqual({
        state: "opened",
        branch: expect.stringMatching(/^dipo\/backlog-/),
        pr: url,
      });
      const two = await planning.fileDraft("DIPO-301", draft(2));
      expect(await planning.flush(two)).toEqual({
        state: "updated",
        branch: opened?.state === "opened" ? opened.branch : "",
        pr: url,
      });

      held = "dipo/backlog-20260101T000000";
      const three = await planning.fileDraft("DIPO-302", draft(3));
      expect(await planning.flush(three)).toEqual({
        state: "held",
        branch: "dipo/backlog-20260101T000000",
        reason: expect.stringContaining("has auto-merge on"),
      });
      held = null;

      const broken = await lane.journal({
        kind: "edit",
        key: storyKey(s),
        subject: "TASK-1",
        target: { status: "No Such Status" },
      });
      expect(await planning.flush(broken)).toEqual({
        state: "closed",
        reason: expect.stringContaining("`backlog: edit TASK-1` failed and is closed"),
      });

      await repo.git("worktree", "remove", "--force", lane.worktreePath());
      mkdirSync(lane.worktreePath(), { recursive: true });
      writeFileSync(join(lane.worktreePath(), "mine.txt"), "not dipo's\n");
      const four = await planning.fileDraft("DIPO-303", draft(4));
      expect(await planning.flush(four)).toEqual({
        state: "failed",
        reason: expect.stringContaining("is not a worktree of this repository"),
      });
    }, FIXTURE);
  });
});
