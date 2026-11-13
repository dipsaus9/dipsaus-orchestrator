// The one pass over the task files that gives the Ready gate its other active tasks (DIPO-494):
// the id, status, dependencies and branch of each, read as `task view` shows them. The forms a hand
// edit can leave (a branch in any quoting, a dependency in any list form) read as the CLI reads
// them, the tasks of `completed/`, `archive/` and `drafts/` are not active, and a file that does not
// parse fails the read. The same forms are compared with the real CLI in task-files.ci.test.ts.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { tempRoot } from "@dipsaus-orchestrator/testkit";

import { descriptionOf, normalizedId, readTaskFacts } from "../../src/backlog/task-files";
import { StoryParseError } from "../../src/story-store/errors";
import { type FileTask, withBacklog, writeBacklog } from "../gate/task-files";

const facts = (tasks: readonly FileTask[]) => withBacklog(tasks, (dir) => readTaskFacts(dir));

describe("the task facts of a checkout", () => {
  it("reads a branch single-quoted, double-quoted, plain and with a YAML escape", async () => {
    const read = await facts([
      { id: "DIPO-1", branch: "'DIPO-1/single'" },
      { id: "DIPO-2", branch: '"DIPO-2/double"' },
      { id: "DIPO-3", branch: "DIPO-3/plain" },
      { id: "DIPO-4", branch: '"DIPO-4/a\\u0062c"' },
      { id: "DIPO-5" },
    ]);
    expect(read.map((task) => task.branch)).toEqual([
      "DIPO-1/single",
      "DIPO-2/double",
      "DIPO-3/plain",
      "DIPO-4/abc",
      undefined,
    ]);
  });

  it("reads dependencies as a block list, a flow list, lower case, numbers and one string", async () => {
    const read = await facts([
      { id: "DIPO-1", dependencies: "\n  - DIPO-12\n  - DIPO-3" },
      { id: "DIPO-2", dependencies: "[DIPO-3, DIPO-12]" },
      { id: "DIPO-3", dependencies: "[dipo-2, 7, ' DIPO-4 ', DIPO-4, 10, DIPO-1.2]" },
      // A single string is no list: the CLI shows no dependency for it.
      { id: "DIPO-4", dependencies: "DIPO-3" },
      { id: "DIPO-5", dependencies: "[task-9, DIPO-99]" },
    ]);
    expect(read.map((task) => task.dependencies)).toEqual([
      ["DIPO-3", "DIPO-12"],
      ["DIPO-3", "DIPO-12"],
      ["DIPO-1.2", "DIPO-2", "DIPO-4", "7", "10"],
      [],
      ["task-9", "DIPO-99"],
    ]);
  });

  it("names the id as the CLI does, and keeps the status as written", async () => {
    const read = await facts([
      { id: "dipo-2", status: "ready" },
      { id: "DIPO-3", status: "In Progress" },
    ]);
    expect(read.map(({ id, status }) => [id, status])).toEqual([
      ["DIPO-2", "ready"],
      ["DIPO-3", "In Progress"],
    ]);
    expect(normalizedId("dipo-7", "dipo")).toBe("DIPO-7");
    expect(normalizedId("Task-7", "dipo")).toBe("Task-7");
  });

  it("does not count a task of completed/, archive/ or drafts/ as active", async () => {
    const read = await facts([
      { id: "DIPO-1" },
      { id: "DIPO-2", folder: "completed" },
      { id: "DIPO-3", folder: "archive/tasks" },
      { id: "DRAFT-4", folder: "drafts", status: "Draft" },
    ]);
    expect(read.map((task) => task.id)).toEqual(["DIPO-1"]);
  });

  it("reads the description as the CLI does: between its markers, under its header, or none", () => {
    expect(
      descriptionOf(
        "x\n<!-- SECTION:DESCRIPTION:BEGIN -->\nA\n<!-- SECTION:DESCRIPTION:END -->\ny",
      ),
    ).toBe("A");
    expect(descriptionOf("## Description\n\nB\n\n## Acceptance Criteria\nC")).toBe("B");
    expect(descriptionOf("no header, no markers")).toBe("");
  });

  it("uses the prefix the configuration names, and `task` without one", async () => {
    const dir = mkdtempSync(join(tempRoot(), "task-files-prefix-"));
    writeBacklog(dir, [{ id: "task-1" }, { id: "DIPO-2" }], 'project_name: "p"\n');
    expect(readTaskFacts(dir).map((task) => task.id)).toEqual(["DIPO-2", "TASK-1"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails a file that does not parse instead of counting a task with no dependencies", async () => {
    const bad: FileTask[] = [
      { id: "DIPO-9", text: "---\ntitle: no id\nstatus: Done\n---\n" },
      { id: "DIPO-9", text: "---\nid: DIPO-9\nstatus: [Done\n---\n" },
      { id: "DIPO-9", text: "no front matter\n" },
      { id: "DIPO-9", branch: "DIPO-9/Not_A_Slug" },
    ];
    for (const task of bad) {
      await withBacklog([{ id: "DIPO-1" }, task], async (dir) => {
        expect(() => readTaskFacts(dir)).toThrow(StoryParseError);
      });
    }
  });

  it("refuses a checkout the runner's scan refuses, and one that is no backlog", async () => {
    await withBacklog([{ id: "DIPO-1" }], async (dir) => {
      mkdirSync(join(dir, "backlog", "docs"), { recursive: true });
      writeFileSync(join(dir, "backlog", "docs", "x.md"), "---js\nx\n---\n");
      expect(() => readTaskFacts(dir)).toThrow(/front matter block that is not plain YAML/);
    });
    await withBacklog([{ id: "DIPO-1" }], async (dir) => {
      rmSync(join(dir, "backlog", "config.yml"));
      expect(() => readTaskFacts(dir)).toThrow(/no Backlog project configuration/);
    });
  });
});
