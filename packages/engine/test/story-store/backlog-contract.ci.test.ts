// CI only (0017): the pinned Backlog CLI and real git, too slow for the local run.
// The StoryStore contract (`contract.ts`, DIPO-356) on the Backlog.md store: the Backlog fixture
// committed in a temp repository with the office's git, read and edited with the pinned CLI, and
// an office of a test state database for the planning lane's journal and the backlog PR's blocks.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { withTempRepo } from "@dipsaus-orchestrator/testkit";

import { EDIT_KIND } from "../../src/backlog/lane";
import { insertEntry } from "../../src/backlog/lane/journal";
import { blockStories } from "../../src/backlog/pr/records";
import { backlogStoryStore } from "../../src/backlog/store";
import { BACKLOG_FIXTURE, laneSetup, publish } from "../backlog/lane/helpers";
import { storyStoreContract } from "./contract";

const CLI_TIMEOUT_MS = 120_000;
const BRANCH = "TASK-1/contract";

if (process.env["DIPO_TEST_CI"] === "1") {
  storyStoreContract(
    "Backlog.md with the pinned CLI",
    (fn) =>
      withTempRepo(
        async (repo) => {
          await publish(repo);
          const head = (await repo.git("rev-parse", "HEAD")).trim();
          await repo.git("branch", BRANCH, head);
          const s = await laneSetup(repo);
          try {
            const tasks = join(repo.dir, "backlog", "tasks");
            await fn({
              store: backlogStoryStore(s.cli),
              checkout: repo.dir,
              git: s.git,
              head,
              branch: BRANCH,
              office: s.office,
              fileText: (id) => {
                const name = readdirSync(tasks).find((file) =>
                  file.startsWith(`${id.toLowerCase()} - `),
                );
                if (name === undefined) throw new Error(`no task file for ${id}`);
                return readFileSync(join(tasks, name), "utf8");
              },
              journal: (key) =>
                s.office.immediate(() =>
                  insertEntry(
                    s.office,
                    { kind: EDIT_KIND, key, subject: "TASK-1", target: { status: "Refined" } },
                    s.t.clock.now(),
                  ),
                ),
              block: (key) =>
                s.office.immediate(() =>
                  blockStories(s.office, 7, [{ key, failures: [] }], s.t.clock.now()),
                ),
            });
          } finally {
            s.t.state.close();
          }
        },
        { fixture: BACKLOG_FIXTURE },
      ),
    CLI_TIMEOUT_MS,
  );
}
