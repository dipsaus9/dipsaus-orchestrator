// CI only (0017): the pinned Backlog CLI and real git, too slow for the local run.
// The StoryStore contract (`contract.ts`, DIPO-356) on the Backlog.md store: the Backlog fixture
// committed in a temp repository, read with the pinned CLI, and an office of a test state database
// for the planning lane's journal.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { withTempRepo } from "@dipsaus-orchestrator/testkit";

import { EDIT_KIND } from "../../src/backlog/lane";
import { insertEntry } from "../../src/backlog/lane/journal";
import { backlogStoryStore } from "../../src/backlog/store";
import type { GitSession } from "../../src/git/office";
import { systemSpawn } from "../../src/platform/process";
import { BACKLOG_CLI, BACKLOG_FIXTURE } from "../backlog/helpers";
import { addOffice, openTestState } from "../commands/helpers";
import { storyStoreContract } from "./contract";

const CLI_TIMEOUT_MS = 120_000;

if (process.env["DIPO_TEST_CI"] === "1") {
  storyStoreContract(
    "Backlog.md with the pinned CLI",
    (fn) =>
      withTempRepo(
        async (repo) => {
          const head = await repo.commitAll("fixture");
          const t = await openTestState(repo.root);
          try {
            const office = addOffice(t);
            // Only what the store's layout reads take: git in the repository.
            const session = {
              repository: { kind: "repository", commonDir: join(repo.dir, ".git") },
              ok: (_location: unknown, args: readonly string[]) => repo.git(...args),
            } as unknown as GitSession;
            const tasks = join(repo.dir, "backlog", "tasks");
            await fn({
              store: backlogStoryStore({ spawn: systemSpawn, command: BACKLOG_CLI, env: repo.env }),
              checkout: repo.dir,
              session,
              head,
              office,
              fileText: (id) => {
                const name = readdirSync(tasks).find((file) =>
                  file.startsWith(`${id.toLowerCase()} - `),
                );
                if (name === undefined) throw new Error(`no task file for ${id}`);
                return readFileSync(join(tasks, name), "utf8");
              },
              journal: (key) =>
                office.immediate(() =>
                  insertEntry(
                    office,
                    { kind: EDIT_KIND, key, subject: "TASK-1", target: { status: "Refined" } },
                    t.clock.now(),
                  ),
                ),
            });
          } finally {
            t.state.close();
          }
        },
        { fixture: BACKLOG_FIXTURE },
      ),
    CLI_TIMEOUT_MS,
  );
}
