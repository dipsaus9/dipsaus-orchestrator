// CI only (0017 section 1): the slower ways the planning lane fails without holding the office
// (DIPO-34 review), kept out of the local suite for its time budget (DIPO-77): an engine commit
// that waits on signing is killed after its timeout and stays journaled, a CLI that commits by
// itself (Backlog.md `auto_commit`) has its commit undone, and a branch whose first operation
// merged on its own is rebuilt with the rest.

import { describe, expect, it } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { git, withBareRemote } from "@dipsaus-orchestrator/testkit";

import { allEntries, LANE_NOTICES, LaneFlushError, pendingLaneOp } from "../../../src/backlog/lane";
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

if (process.env["DIPO_TEST_CI"] === "1") {
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
}
