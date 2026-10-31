// The backlog PR of a flush that runs while its office loads (DIPO-403; gap G18): the lane pushes
// its branch at load, the office has no handle yet, so the PR waits and opens once the office has
// loaded, with no further lane operation. Real temporary repositories and the in-memory host.

import { describe, expect, it } from "bun:test";

import { StoryId } from "@dipsaus-orchestrator/contract";
import { withBareRemote } from "@dipsaus-orchestrator/testkit";

import { findPr, TITLE_PREFIX } from "../../../src/backlog/pr";
import { addStory } from "../../../src/records/story-keys";
import { BACKLOG_FIXTURE, publish } from "../lane/helpers";

import { laneSetup, prSetup } from "./helpers";

const FIXTURE = { fixture: BACKLOG_FIXTURE };

describe("the backlog PR of a flush during office load", () => {
  it("opens the PR once the office has loaded, without another lane operation", async () => {
    await withBareRemote(async (repo) => {
      await publish(repo);
      let loading = true;
      const s = await prSetup(repo, await laneSetup(repo), { loading: () => loading });
      const key = addStory(s.office, s.t.ids, { story: StoryId.parse("TASK-1") }, 0).key;

      // The flush at load pushes the branch; the office has no handle, so no PR opens yet.
      const flushed = await s.lane().submit({
        kind: "edit",
        key,
        subject: "TASK-1",
        target: { status: "Refined" },
      });
      const branch = flushed.report.branch as string;
      expect(flushed.report.pushed).toBe(true);
      expect(s.host.prs.size).toBe(0);

      // The office has loaded: the waiting flush opens its PR, and nothing else is run.
      loading = false;
      await s.prs.loaded(s.officeId);
      expect(s.host.calls.filter((call) => call.startsWith("create"))).toHaveLength(1);
      expect([...s.host.prs.values()].map((pr) => [pr.head, pr.title])).toEqual([
        [branch, `${TITLE_PREFIX}edit TASK-1`],
      ]);
      expect(findPr(s.office, 1)).toMatchObject({ state: "open", branch, check: "passed" });

      // Once published, a later call has nothing left to do.
      await s.prs.loaded(s.officeId);
      expect(s.host.calls.filter((call) => call.startsWith("create"))).toHaveLength(1);
    }, FIXTURE);
  });
});
