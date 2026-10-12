// The runner and parser against the pinned Backlog.md CLI (DIPO-28): create, edit and view a task in
// a temporary copy of the Backlog fixture project and compare the parsed record; the version step
// accepts the pinned CLI; an unknown id is an error.

import { describe, expect, it } from "bun:test";

import { withTempRepo } from "@dipsaus-orchestrator/testkit";

import {
  BacklogCommandError,
  checkVersion,
  parseList,
  parseView,
  runBacklog,
  type BacklogCli,
} from "../../src/backlog";
import { systemSpawn } from "../../src/platform/process";
import { BACKLOG_CLI, BACKLOG_FIXTURE } from "./helpers";

describe("the pinned Backlog.md CLI", () => {
  it("creates, edits and views a task that parses back to the written fields", async () => {
    await withTempRepo(
      async (repo) => {
        await repo.commitAll("fixture");
        const cli: BacklogCli = { spawn: systemSpawn, command: BACKLOG_CLI, env: repo.env };
        const run = (...args: string[]) => runBacklog(cli, repo.dir, args);

        expect(checkVersion((await run("--version")).stdout)).toEqual({
          ok: true,
          version: "1.53.0",
        });

        await run(
          "task",
          "create",
          "Count the exported rows",
          "-d",
          "Outcome: the export reports how many rows it wrote.",
          "-l",
          "tier:S",
          "--type",
          "feature",
          "--ac",
          "The count is printed",
          "--ref",
          "src/export.ts",
          "--dep",
          "TASK-1",
        );
        await run(
          "task",
          "edit",
          "TASK-4",
          "-s",
          "Ready",
          "--add-label",
          "role:developer",
          "--check-ac",
          "1",
          "--doc",
          "docs/export.md",
          "--append-notes",
          "Counted in the writer.",
        );
        const task = parseView((await run("task", "view", "TASK-4", "--plain")).stdout);
        expect(task).toMatchObject({
          file: `${repo.dir}/backlog/tasks/task-4 - Count-the-exported-rows.md`,
          id: "TASK-4",
          title: "Count the exported rows",
          status: "Ready",
          type: "feature",
          labels: ["tier:S", "role:developer"],
          references: ["src/export.ts"],
          documentation: ["docs/export.md"],
          dependencies: [
            {
              id: "TASK-1",
              state: "resolved",
              title: "Add the CSV export command",
              status: "Ready",
            },
          ],
          description: "Outcome: the export reports how many rows it wrote.",
          acceptanceCriteria: [{ index: 1, checked: true, text: "The count is printed" }],
          implementationNotes: "Counted in the writer.",
          unknown: [],
        });

        const list = parseList((await run("task", "list", "--plain")).stdout);
        expect(list.entries.find((entry) => entry.id === "TASK-4")).toMatchObject({
          group: "Ready",
          ac: { checked: 1, total: 1 },
        });

        let error: unknown;
        try {
          await run("task", "view", "TASK-99", "--plain");
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(BacklogCommandError);
        expect((error as BacklogCommandError).message).toContain("TASK-99 not found");
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });
});
