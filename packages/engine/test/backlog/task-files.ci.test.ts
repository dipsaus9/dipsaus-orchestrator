// CI only (0017): the one pass over the task files gives every active task the id, status,
// dependencies and branch a `task view` of the pinned Backlog.md CLI gives (DIPO-494), on a
// fixture built with the forms a hand edit can leave and on this repository's own backlog. The
// fast tests of the same forms, without the CLI, are task-files.test.ts.

import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { backlogStoryStore } from "../../src/backlog/store";
import { readTaskFacts } from "../../src/backlog/task-files";
import { gateTaskFromView } from "../../src/gate/input";
import { systemSpawn } from "../../src/platform/process";
import { mapLimited } from "../../src/stories/read";
import type { TaskFacts } from "../../src/story-store/story";
import { type FileTask, withBacklog } from "../gate/task-files";
import { BACKLOG_CLI } from "./helpers";

const store = backlogStoryStore({ spawn: systemSpawn, command: BACKLOG_CLI });
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

/** The facts a view gives of each task of `facts`, in the shape of `readTaskFacts`. */
async function viewed(dir: string, facts: readonly TaskFacts[]): Promise<TaskFacts[]> {
  return mapLimited(facts, 8, async (fact) => {
    const view = await store.view(dir, fact.id);
    const { id, dependencies, branch } = gateTaskFromView(view);
    return { id, status: view.status, dependencies, ...(branch === undefined ? {} : { branch }) };
  });
}

const FIXTURE: readonly FileTask[] = [
  {
    id: "DIPO-1",
    status: "Ready",
    dependencies: "\n  - dipo-2\n  - DIPO-3",
    branch: "'DIPO-1/single'",
  },
  {
    id: "DIPO-2",
    status: "ready",
    dependencies: "[DIPO-4, dipo-5, DIPO-4]",
    branch: '"DIPO-2/a\\u0062c"',
  },
  { id: "DIPO-3", dependencies: "DIPO-4", branch: "DIPO-3/plain" },
  {
    id: "DIPO-4",
    status: "Done",
    dependencies: "[7, ' DIPO-3 ', DIPO-99, task-8, dipo-2, 10, DIPO-1.2]",
  },
  { id: "DIPO-5", status: "Done", folder: "completed" },
  { id: "DIPO-6", status: "Done", folder: "archive/tasks" },
  { id: "DRAFT-7", status: "Draft", folder: "drafts" },
  {
    id: "DIPO-8",
    text: '---\nid: DIPO-8\ntitle: No markers\nstatus: Ready\ndependencies: []\n---\n\nStory: x\n\n```dipo\nbranch: "DIPO-8/h"\n```\n',
  },
  {
    id: "DIPO-9",
    text: '---\nid: DIPO-9\ntitle: Header only\nstatus: Ready\ndependencies: []\n---\n\n## Description\n\nStory: x\n\n```dipo\nbranch: "DIPO-9/i"\n```\n\n## Acceptance Criteria\n- [ ] #1 x\n',
  },
];

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("the one pass over the task files against the pinned Backlog.md CLI", () => {
    it(
      "gives every task of a fixture what its view gives",
      () =>
        withBacklog(FIXTURE, async (dir) => {
          const facts = readTaskFacts(dir);
          expect(facts.map((task) => task.id)).toEqual([
            "DIPO-1",
            "DIPO-2",
            "DIPO-3",
            "DIPO-4",
            "DIPO-8",
            "DIPO-9",
          ]);
          expect(await viewed(dir, facts)).toEqual(facts);
        }),
      120_000,
    );

    it("gives every active task of this repository's backlog what its view gives", async () => {
      const facts = readTaskFacts(REPO_ROOT);
      expect(facts.length).toBeGreaterThan(100);
      expect(await viewed(REPO_ROOT, facts)).toEqual(facts);
    }, 600_000);
  });
}
