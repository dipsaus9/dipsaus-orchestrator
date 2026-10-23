// How the planning lane fails without holding the office (DIPO-34 review): an engine commit that
// waits on signing is killed after its timeout on the injected clock, stays journaled and is named
// by a `backlog.lane.commitStuck` notice, as is a push that waits; any failed flush puts a notice on the office; a CLI that
// commits by itself (Backlog.md `auto_commit`) has its commit undone and its operation dropped;
// without a remote and without `base` the lane is refused; an operation whose target state is on
// the base already is closed as merged; a branch whose first operation merged on its own is
// rebuilt with the rest.
// The slower cases run in CI only, in failures.ci.test.ts (DIPO-77).

import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withBareRemote, withTempRepo } from "@dipsaus-orchestrator/testkit";

import {
  allEntries,
  LANE_NOTICES,
  LaneError,
  LaneFlushError,
  pendingLaneOp,
} from "../../../src/backlog/lane";
import { EXTERNAL_STEP_TIMEOUT_MS } from "../../../src/git";
import { CALL_DEADLINE_MS, KILL_GRACE_MS } from "../../../src/platform/deadline";
import { systemSpawn } from "../../../src/platform/process";
import { hangingSpawn } from "../../platform/hanging";
import {
  BACKLOG_FIXTURE,
  inRemote,
  type LaneSetup,
  laneSetup,
  notices,
  publish,
  storyKey,
} from "./helpers";

const FIXTURE = { fixture: BACKLOG_FIXTURE };

describe("a planning lane that cannot finish", () => {
  it("kills a push that waits after the timeout and keeps the commits waiting", async () => {
    await withBareRemote(async (repo) => {
      await publish(repo);
      // A remote side that never answers, as a push waiting for credentials does.
      const hanging = join(repo.root, "hanging-receive-pack");
      writeFileSync(hanging, "#!/bin/sh\nexec sleep 30\n");
      chmodSync(hanging, 0o755);
      await repo.git("config", "remote.origin.receivepack", hanging);
      const s = await laneSetup(repo);
      const lane = s.lane();
      s.hooks.onGit = (args) => {
        if (args.includes("push")) {
          queueMicrotask(() => s.t.clock.advance(EXTERNAL_STEP_TIMEOUT_MS));
        }
      };

      const { report } = await lane.submit({
        kind: "edit",
        key: storyKey(s),
        subject: "TASK-1",
        target: { status: "Refined" },
      });
      expect(report.pushed).toBe(false);
      expect(report.waiting?.reason).toBe("pushFailed");
      expect(allEntries(s.office)[0]?.state).toBe("committed");
      const stuck = notices(s.office).filter((n) => n.code === LANE_NOTICES.commitStuck);
      expect(stuck).toHaveLength(1);
      expect(stuck[0]?.text).toContain("credentials");
      expect(await s.git.run(async () => "next item")).toBe("next item");

      delete s.hooks.onGit;
      await repo.git("config", "--unset", "remote.origin.receivepack");
      const retried = await lane.flush();
      expect(retried.pushed).toBe(true);
      expect(allEntries(s.office)[0]?.state).toBe("pushed");
    }, FIXTURE);
  });

  it("fails a flush whose Backlog CLI call never ends at its deadline, with flushFailed (DIPO-314)", async () => {
    await withBareRemote(async (repo) => {
      await publish(repo);
      const s = await laneSetup(repo);
      // The CLI's edit never ends; every other call runs the real CLI.
      const hang = hangingSpawn((options) =>
        options.cmd.includes("edit") ? null : systemSpawn(options),
      );
      const cli = { ...s.cli, spawn: hang.spawn, clock: s.t.clock };
      (s as { cli: LaneSetup["cli"] }).cli = cli;
      const lane = s.lane();
      const submitted = lane
        .submit({
          kind: "edit",
          key: storyKey(s),
          subject: "TASK-1",
          target: { status: "Refined" },
        })
        .catch((error: unknown) => error);
      // Once the edit hangs, its deadline and the grace pass on the office clock.
      for (let i = 0; i < 5_000 && hang.children.length === 0; i += 1) await Bun.sleep(1);
      s.t.clock.advance(CALL_DEADLINE_MS + KILL_GRACE_MS);
      const failed = await submitted;
      expect(failed).toBeInstanceOf(LaneFlushError);
      expect(hang.children[0]?.groupSignals).toEqual(["SIGTERM", "SIGKILL"]);
      const failure = notices(s.office).filter((n) => n.code === LANE_NOTICES.flushFailed);
      expect(failure).toHaveLength(1);
      expect(failure[0]?.text).toContain("did not finish within its deadline of 60 s");
      // The office git queue is free again.
      expect(await s.git.run(async () => "next item")).toBe("next item");
    }, FIXTURE);
  });

  it("puts a notice on the office when a flush fails, outside replay too", async () => {
    await withBareRemote(async (repo) => {
      await publish(repo);
      const s = await laneSetup(repo);
      const lane = s.lane();
      // Something that is not the engine's worktree sits where `_backlog` goes.
      mkdirSync(lane.worktreePath(), { recursive: true });
      writeFileSync(join(lane.worktreePath(), "mine.txt"), "not dipo's\n");

      const failed = await lane
        .submit({
          kind: "edit",
          key: storyKey(s),
          subject: "TASK-1",
          target: { status: "Refined" },
        })
        .catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(LaneFlushError);
      expect(allEntries(s.office)[0]?.state).toBe("pending");
      const failure = notices(s.office).filter((n) => n.code === LANE_NOTICES.flushFailed);
      expect(failure).toHaveLength(1);
      expect(failure[0]?.text).toContain("is not a worktree of this repository");
      expect(failure[0]?.text).toContain("They stay journaled");
    }, FIXTURE);
  });

  it("closes an operation as merged when its target state is on the base already", async () => {
    await withBareRemote(async (repo) => {
      await publish(repo);
      const s = await laneSetup(repo);
      const key = storyKey(s);
      // TASK-1 is Ready in the fixture.
      const { report } = await s.lane().submit({
        kind: "edit",
        key,
        subject: "TASK-1",
        target: { status: "Ready" },
      });
      expect(report).toMatchObject({ branch: null, committed: [], merged: [1], pushed: false });
      expect(allEntries(s.office).map((e) => [e.state, e.branch])).toEqual([["merged", null]]);
      expect(pendingLaneOp(s.office, key)).toBeNull();
      expect((await inRemote(repo, "branch", "--list", "dipo/*")).trim()).toBe("");
    }, FIXTURE);
  });
});

describe("a planning lane without a remote", () => {
  it("undoes a commit the Backlog CLI made by itself and drops the operation, naming auto_commit", async () => {
    await withTempRepo(async (repo) => {
      const config = join(repo.dir, "backlog", "config.yml");
      writeFileSync(
        config,
        readFileSync(config, "utf8").replace("auto_commit: false", "auto_commit: true"),
      );
      await publish(repo);
      const base = (await repo.git("rev-parse", "main")).trim();
      const s = await laneSetup(repo);
      const lane = s.lane();
      const key = storyKey(s);

      const { report } = await lane.submit({
        kind: "edit",
        key,
        subject: "TASK-1",
        target: { status: "Refined" },
      });
      expect(report).toMatchObject({ branch: null, committed: [], dropped: [1] });
      expect(allEntries(s.office)[0]?.state).toBe("dropped");
      expect(pendingLaneOp(s.office, key)).toBeNull();
      const dropped = notices(s.office).filter((n) => n.code === LANE_NOTICES.dropped);
      expect(dropped).toHaveLength(1);
      expect(dropped[0]?.text).toContain("auto_commit");

      // The CLI's commit is gone: `_backlog` is back on the base and clean.
      const worktree = lane.worktreePath();
      expect((await repo.git("-C", worktree, "rev-parse", "HEAD")).trim()).toBe(base);
      expect(await repo.git("-C", worktree, "status", "--porcelain")).toBe("");
      expect((await repo.git("branch", "--list", "dipo/*")).trim()).toBe("");
    }, FIXTURE);
  });

  it("is refused with a notice asking for `base` when the office sets none", async () => {
    await withTempRepo(async (repo) => {
      await publish(repo);
      const s = await laneSetup(repo, { remote: "origin" });
      const refused = await s
        .lane()
        .journal({
          kind: "edit",
          key: storyKey(s),
          subject: "TASK-1",
          target: { status: "Refined" },
        })
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(LaneError);
      expect((refused as LaneError).code).toBe(LANE_NOTICES.baseUnset);
      expect(allEntries(s.office)).toEqual([]);
      expect(s.log).toEqual([]);
      const refusal = notices(s.office).filter((n) => n.code === LANE_NOTICES.baseUnset);
      expect(refusal).toHaveLength(1);
      expect(refusal[0]?.text).toContain("Set `base`");
    }, FIXTURE);
  });
});
