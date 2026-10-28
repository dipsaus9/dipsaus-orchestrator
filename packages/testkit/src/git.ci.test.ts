// CI only (0017 section 1): the Backlog.md fixture project against the pinned CLI (seven CLI calls
// in a temporary copy), moved out of the local suite for its time budget (DIPO-79). Locally, the
// story index test in packages/engine/test/stories/index.test.ts reads the same fixture through the
// pinned CLI at every run.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { withTempRepo } from "./git";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const BACKLOG_FIXTURE = join(REPO_ROOT, "packages", "engine", "test", "fixtures", "backlog");
const BACKLOG_CLI = join(REPO_ROOT, "node_modules", ".bin", "backlog");

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("Backlog.md fixture project", () => {
    it("lists its tasks with the pinned CLI in a temporary copy", async () => {
      await withTempRepo(
        async (repo) => {
          const version = await repo.run([BACKLOG_CLI, "--version"]);
          expect(version.stdout.trim()).toBe("1.53.0");

          const list = await repo.run([BACKLOG_CLI, "task", "list", "--plain"]);
          expect(list.exitCode).toBe(0);
          expect(list.stdout).toContain("TASK-1 - Add the CSV export command");
          expect(list.stdout).toContain("TASK-2 - Rename the export setting");
          expect(list.stdout).toContain("TASK-3 - Export stories as JSON");

          const drafts = await repo.run([BACKLOG_CLI, "draft", "list", "--plain"]);
          expect(drafts.stdout).toContain("DRAFT-1 - Sketch the export format");

          const plan = await repo.run([BACKLOG_CLI, "task", "view", "TASK-1", "--plain"]);
          expect(plan.stdout).toContain('kind: "automated"');
          expect(plan.stdout).toContain('kind: "manual"');
          const na = await repo.run([BACKLOG_CLI, "task", "view", "TASK-2", "--plain"]);
          expect(na.stdout).toContain("not_applicable:");
          const held = await repo.run([BACKLOG_CLI, "task", "view", "TASK-3", "--plain"]);
          expect(held.stdout).toMatch(/^Status: .*Parked$/m);
          expect(held.stdout).toContain('reason: "by-maintainer"');

          // The CLI never touched the checked-in fixture.
          expect((await repo.git("status", "--porcelain")).trim()).toBe("?? backlog/");
        },
        { fixture: BACKLOG_FIXTURE },
      );
    }, 15_000);
  });
}
