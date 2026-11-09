// The planning lane's Done of a story whose own PR merged while it was parked (DIPO-468): against a
// real temporary repository with a remote and the pinned Backlog CLI, `setDone` journals one `done`
// operation that sets the Parked story Done with its park record removed, reuses it while it is
// open, and is dropped for a story that is not Parked.

import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";

import { withBareRemote } from "@dipsaus-orchestrator/testkit";

import {
  allEntries,
  DONE_KIND,
  editKind,
  OfficeLane,
  planningLane,
} from "../../../src/backlog/lane";
import {
  BACKLOG_FIXTURE,
  inRemote,
  laneSetup,
  publish,
  storyKey,
  subjects,
  taskFile,
} from "./helpers";

/** TASK-1 Parked from In Progress with its park record, as a story PR carried it to the base. */
function parkTask1(dir: string): void {
  const file = taskFile(dir, "TASK-1");
  writeFileSync(
    file,
    readFileSync(file, "utf8")
      .replace(/^status: .*$/m, "status: Parked")
      .replace(
        "unknowns: []\n",
        'unknowns: []\npark:\n  reason: "verify-failing"\n  from: "In Progress"\n  note: "verify red 5 times"\n',
      ),
  );
}

describe("setting a story Done whose PR merged while it was parked (DIPO-468)", () => {
  it("journals one done operation, writes Done without the park record, and drops it for a story that is not Parked", async () => {
    await withBareRemote(
      async (repo) => {
        parkTask1(repo.dir);
        await publish(repo);
        const s = await laneSetup(repo);
        s.kinds.set(DONE_KIND, editKind(DONE_KIND));
        const lane = new OfficeLane({
          officeId: s.office.officeId,
          office: s.office,
          git: s.git,
          cli: s.cli,
          clock: s.t.clock,
          kinds: s.kinds,
        });
        const planning = planningLane(lane);
        const key = storyKey(s);
        const first = await planning.setDone({ key, story: "TASK-1" });
        // Asked again while it is open: the same operation.
        expect(await planning.setDone({ key, story: "TASK-1" })).toEqual(first);
        expect(planning.outcomeOf(first)?.outcome).toBe("waiting");
        // TASK-2 is not Parked: the operation no longer applies.
        await planning.setDone({ key: storyKey(s), story: "TASK-2" });
        const report = await lane.flush();
        expect(report.pushed).toBe(true);
        const branch = report.branch as string;
        expect(await subjects(repo.remote, repo.home, branch, "main")).toEqual([
          "backlog: done TASK-1",
        ]);
        expect(allEntries(s.office).map((entry) => [entry.kind, entry.state])).toEqual([
          [DONE_KIND, "pushed"],
          [DONE_KIND, "dropped"],
        ]);
        const file = taskFile("", "TASK-1");
        const text = await inRemote(repo, "show", `${branch}:${file}`);
        expect(text).toMatch(/^status: Done$/m);
        expect(text).not.toContain("park:");
        expect(text).toContain('branch: "TASK-1/add-the-csv-export-command"');
      },
      { fixture: BACKLOG_FIXTURE },
    );
  }, 60_000);
});
