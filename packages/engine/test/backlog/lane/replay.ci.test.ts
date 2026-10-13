// CI only (0017 section 1): the slower crash recovery case of the planning lane (DIPO-34; 0010
// section 2a step 3), kept out of the local suite for its time budget (DIPO-77): a commit made just
// before a crash is found again by its trailer instead of being applied twice.
// A fast local version, without a remote, is in replay.test.ts.

import { describe, expect, it } from "bun:test";

import { withBareRemote } from "@dipsaus-orchestrator/testkit";

import { allEntries, OP_TRAILER } from "../../../src/backlog/lane";
import { BACKLOG_FIXTURE, inRemote, laneSetup, publish, storyKey } from "./helpers";

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("replaying the journal at office load", () => {
    it("finds a commit made just before a crash by its trailer and does not apply it twice", async () => {
      await withBareRemote(
        async (repo) => {
          await publish(repo);
          const s = await laneSetup(repo);
          const key = storyKey(s);
          const { report } = await s.lane().submit({
            kind: "edit",
            key,
            subject: "TASK-1",
            target: { status: "Refined" },
          });
          const branch = report.branch as string;
          const sha = (await inRemote(repo, "rev-parse", branch)).trim();
          expect(await inRemote(repo, "log", "-1", "--format=%B", branch)).toContain(
            `${OP_TRAILER}: 1`,
          );

          // The crash came after the commit and before its journal update.
          s.office.immediate(() =>
            s.office.run(
              "update backlog_journal set state = 'applied', commit_sha = null where office_id = $office_id",
            ),
          );
          const replayed = await s.lane().flush();
          expect(replayed.committed).toEqual([]);
          expect(replayed.branch).toBe(branch);
          expect((await inRemote(repo, "rev-parse", branch)).trim()).toBe(sha);
          expect(allEntries(s.office).map((e) => [e.state, e.commit])).toEqual([["pushed", sha]]);
        },
        { fixture: BACKLOG_FIXTURE },
      );
    });
  });
}
