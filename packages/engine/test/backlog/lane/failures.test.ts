// How the planning lane fails without holding the office (DIPO-34 review): an engine commit that
// waits on signing is killed after its timeout on the injected clock, stays journaled and is named
// by a `backlog.lane.commitStuck` notice, as is a push that waits; any failed flush puts a notice on the office; a CLI that
// commits by itself (Backlog.md `auto_commit`) has its commit undone and its operation dropped;
// without a remote and without `base` the lane is refused; an operation whose target state is on
// the base already is closed as merged; a branch whose first operation merged on its own is
// rebuilt with the rest.
// The slower cases run in CI only, in failures.ci.test.ts (DIPO-77).

import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
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
import { BACKLOG_FIXTURE, inRemote, laneSetup, notices, publish, storyKey } from "./helpers";

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
