// How the planning lane fails without holding the office (DIPO-34 review): an engine commit that
// waits on signing is killed after its timeout on the injected clock, stays journaled and is named
// by a `backlog.lane.commitStuck` notice, as is a push that waits; any failed flush puts a notice on the office; a CLI that
// commits by itself (Backlog.md `auto_commit`) has its commit undone and its operation dropped;
// without a remote and without `base` the lane is refused; an operation whose target state is on
// the base already is closed as merged; a branch whose first operation merged on its own is
// rebuilt with the rest.

import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { git, withBareRemote, withTempRepo } from "@dipsaus-orchestrator/testkit";

import {
  allEntries,
  LANE_NOTICES,
  LaneError,
  LaneFlushError,
  pendingLaneOp,
} from "../../../src/backlog/lane";
import { EXTERNAL_STEP_TIMEOUT_MS } from "../../../src/git";
import {
  BACKLOG_FIXTURE,
  inRemote,
  laneSetup,
  notices,
  otherClone,
  publish,
  storyKey,
  subjects,
} from "./helpers";

const FIXTURE = { fixture: BACKLOG_FIXTURE };

describe("a planning lane that cannot finish", () => {
  it("kills a commit that waits on signing after the timeout, keeps the operation journaled and frees the queue", async () => {
    await withBareRemote(async (repo) => {
      await publish(repo);
      // A signing program that never answers, as a pinentry waiting for a passphrase does.
      const gpg = join(repo.root, "hanging-gpg");
      writeFileSync(gpg, "#!/bin/sh\nexec sleep 30\n");
      chmodSync(gpg, 0o755);
      await repo.git("config", "commit.gpgsign", "true");
      await repo.git("config", "gpg.program", gpg);
      const s = await laneSetup(repo);
      const lane = s.lane();
      const key = storyKey(s);

      let commits = 0;
      s.hooks.onGit = (args) => {
        if (!args.includes("commit")) return;
        commits += 1;
        // Time passes on the injected clock while the commit waits.
        queueMicrotask(() => s.t.clock.advance(EXTERNAL_STEP_TIMEOUT_MS));
      };
      const failed = await lane
        .submit({ kind: "edit", key, subject: "TASK-1", target: { status: "Refined" } })
        .catch((error: unknown) => error);
      expect(commits).toBe(1);
      expect(failed).toBeInstanceOf(LaneFlushError);
      expect((failed as LaneFlushError).code).toBe(LANE_NOTICES.commitStuck);

      // The operation stays journaled and the story stays covered.
      expect(allEntries(s.office).map((e) => [e.state, e.commit])).toEqual([["applied", null]]);
      expect(pendingLaneOp(s.office, key)).not.toBeNull();
      const stuck = notices(s.office).filter((n) => n.code === LANE_NOTICES.commitStuck);
      expect(stuck).toHaveLength(1);
      expect(stuck[0]?.level).toBe("error");
      for (const cause of ["commit.gpgsign", "user.signingkey", "user.name", "user.email"]) {
        expect(stuck[0]?.text).toContain(cause);
      }

      // The office queue is free again.
      expect(await s.git.run(async () => "next item")).toBe("next item");

      // Once the maintainer fixed signing, the next flush commits and pushes the operation.
      delete s.hooks.onGit;
      await repo.git("config", "commit.gpgsign", "false");
      const report = await lane.flush();
      expect(report.committed).toEqual([1]);
      expect(report.pushed).toBe(true);
      expect(await subjects(repo.remote, repo.home, report.branch as string, "main")).toEqual([
        "backlog: edit TASK-1",
      ]);
    }, FIXTURE);
  });

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

  it("undoes a commit the Backlog CLI made by itself and drops the operation, naming auto_commit", async () => {
    await withBareRemote(async (repo) => {
      const config = join(repo.dir, "backlog", "config.yml");
      writeFileSync(
        config,
        readFileSync(config, "utf8").replace("auto_commit: false", "auto_commit: true"),
      );
      await publish(repo);
      const base = (await repo.git("rev-parse", "origin/main")).trim();
      const s = await laneSetup(repo);
      const lane = s.lane();
      const key = storyKey(s);

      const { report } = await lane.submit({
        kind: "edit",
        key,
        subject: "TASK-1",
        target: { status: "Refined" },
      });
      expect(report).toMatchObject({ branch: null, committed: [], dropped: [1], pushed: false });
      expect(allEntries(s.office)[0]?.state).toBe("dropped");
      expect(pendingLaneOp(s.office, key)).toBeNull();
      const dropped = notices(s.office).filter((n) => n.code === LANE_NOTICES.dropped);
      expect(dropped).toHaveLength(1);
      expect(dropped[0]?.text).toContain("auto_commit");

      // The CLI's commit is gone: `_backlog` is back on the base, clean, and nothing was pushed.
      const worktree = lane.worktreePath();
      expect((await repo.git("-C", worktree, "rev-parse", "HEAD")).trim()).toBe(base);
      expect(await repo.git("-C", worktree, "status", "--porcelain")).toBe("");
      expect((await inRemote(repo, "branch", "--list", "dipo/*")).trim()).toBe("");
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

  it("rebuilds the rest on a new branch when only some operations merged", async () => {
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
        target: { status: "Ready" },
      });
      const old = report.branch as string;
      const oldRemote = await inRemote(repo, "rev-parse", old);
      const [first] = allEntries(s.office);

      // Only the first operation lands on the base, as a cherry-pick would.
      const other = await otherClone(repo);
      await git(other, repo.home, "cherry-pick", first?.commit as string);
      await git(other, repo.home, "push", "--quiet", "origin", "HEAD:main");

      const rebuilt = await lane.flush();
      expect(rebuilt).toMatchObject({
        merged: [1],
        committed: [2],
        rebuiltFrom: old,
        branch: `${old}-2`,
        pushed: true,
      });
      expect(await subjects(repo.remote, repo.home, `${old}-2`, "main")).toEqual([
        "backlog: edit TASK-2",
      ]);
      // Never force-pushed: the old branch is where it was on the remote.
      expect(await inRemote(repo, "rev-parse", old)).toBe(oldRemote);
      expect(allEntries(s.office).map((e) => [e.opId, e.state, e.branch])).toEqual([
        [1, "merged", old],
        [2, "pushed", `${old}-2`],
      ]);
      expect(pendingLaneOp(s.office, one)).toBeNull();
      expect(pendingLaneOp(s.office, two)).not.toBeNull();
      expect(notices(s.office).map((n) => n.code)).toContain(LANE_NOTICES.rebuilt);
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
