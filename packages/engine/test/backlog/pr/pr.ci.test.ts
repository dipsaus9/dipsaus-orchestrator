// The slower backlog PR cases, in CI only (0017): a block is cleared once a later backlog PR that
// touches the story merges with a passing check, and a new Ready that matches a stored passing
// gate decision passes. The fast tests of the same rules are in check.test.ts and records.test.ts.

import { describe, expect, it } from "bun:test";

import { StoryId } from "@dipsaus-orchestrator/contract";
import { withBareRemote } from "@dipsaus-orchestrator/testkit";

import { viewStory } from "../../../src/backlog/fields/write";
import { backlogCheckBlocked, findPr } from "../../../src/backlog/pr";
import { gateStoryFromView } from "../../../src/gate/input";
import { gateContentHash, storeGateDecision } from "../../../src/gate/store";
import { addStory } from "../../../src/stories/keys";
import { BACKLOG_FIXTURE, publish, squashMergeOnRemote } from "../lane/helpers";

import { laneSetup, prSetup } from "./helpers";

const FIXTURE = { fixture: BACKLOG_FIXTURE };

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("the backlog PR", () => {
    it("clears a block once a later backlog PR touching the story merges with a passing check", async () => {
      await withBareRemote(async (repo) => {
        await publish(repo);
        const s = await prSetup(repo, await laneSetup(repo));
        const one = addStory(s.office, s.t.ids, { story: StoryId.parse("TASK-1") }, 0).key;
        // An earlier merged PR #9 failed on TASK-1.
        s.office.immediate(() =>
          s.office.run(
            `insert into backlog_pr_blocks (office_id, key, pr_number, failures, blocked_at)
           values ($office_id, $key, 9, '[]', 0)`,
            { key: one },
          ),
        );
        expect(backlogCheckBlocked(s.office, one)?.prs).toEqual([9]);

        const { report } = await s.lane().submit({
          kind: "edit",
          key: one,
          subject: "TASK-1",
          target: { status: "Refined" },
        });
        const branch = report.branch as string;
        expect(findPr(s.office, 1)?.check).toBe("passed");
        await squashMergeOnRemote(repo, branch);
        s.host.mergedByHand(1, (await repo.git("rev-parse", branch)).trim());
        await s.prs.sync(s.officeId);
        expect(backlogCheckBlocked(s.office, one)).toBeNull();
      }, FIXTURE);
    });

    it("passes a new Ready that matches a stored passing gate decision", async () => {
      await withBareRemote(async (repo) => {
        await publish(repo);
        const s = await prSetup(repo, await laneSetup(repo));
        const two = addStory(s.office, s.t.ids, { story: StoryId.parse("TASK-2") }, 0).key;
        // The decision is stored for the hash the head's view of TASK-2 gives; status is not hashed.
        const view = await viewStory({ cli: s.cli, cwd: repo.dir, id: "TASK-2", kind: "task" });
        s.office.immediate(() =>
          storeGateDecision(s.office, s.t.ids, {
            key: two,
            result: { mode: "ready", passed: true, failures: [] },
            contentHash: gateContentHash(gateStoryFromView(view, [])),
            at: 0,
          }),
        );
        await s
          .lane()
          .submit({ kind: "edit", key: two, subject: "TASK-2", target: { status: "Ready" } });
        expect(findPr(s.office, 1)).toMatchObject({ check: "passed", failures: [] });
      }, FIXTURE);
    });
  });
}
