// The structural check of a backlog-only PR in CI (0010, 0016), over a fixture repository with the
// real Backlog CLI: a story the PR makes Ready that passes the Ready gate passes, one that fails
// the gate fails `ready-decision`, a status change a backlog PR may not make fails `transition`,
// and a path outside `backlog/` fails `backlog-only`. The temporary worktree is gone afterwards.

import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";

import { type TempRepo, withTempRepo } from "../packages/testkit/src/index";

import { checkBacklogPrIn } from "./check-backlog-pr";
import { REPO_BACKLOG_CLI } from "./check-ready-gate";

const CONFIG = [
  'project_name: "fixture"',
  'default_status: "Refined"',
  'statuses: ["To Do", "Refined", "Ready", "In Progress", "In Review", "Parked", "Done"]',
  "labels: []",
  "date_format: yyyy-mm-dd",
  "remote_operations: false",
  "auto_commit: false",
  "check_active_branches: false",
  'task_prefix: "DIPO"',
  "",
].join("\n");

const MILESTONE = ["---", "id: m-0", 'title: "M0 Fixture"', "---", "", "## Description", "", "M0."];

const CLEAN_PLAN = ['    - kind: "automated"', '      check: "the export writes one line per row"'];
// R20: a manual entry needs an expected result.
const NO_EXPECT = ['    - kind: "manual"', '      check: "the export opens in a spreadsheet"'];

/** A task file as Backlog.md 1.53 writes it. */
function taskFile(id: number, status: string, plan: readonly string[]): string {
  return [
    "---",
    `id: DIPO-${id}`,
    "title: Export the rows",
    `status: ${status}`,
    "assignee: []",
    "created_date: '2026-10-25 10:00'",
    "labels:",
    "  - 'tier:M'",
    "milestone: m-0",
    "dependencies: []",
    "references:",
    "  - packages/export/",
    "type: feature",
    "---",
    "",
    "## Description",
    "",
    "<!-- SECTION:DESCRIPTION:BEGIN -->",
    "Outcome: the export writes every row of the table to a CSV file.",
    "",
    "```dipo",
    `branch: "DIPO-${id}/export-rows"`,
    "unknowns: []",
    "test_plan:",
    "  entries:",
    ...plan,
    "```",
    "<!-- SECTION:DESCRIPTION:END -->",
    "",
    "## Acceptance Criteria",
    "<!-- AC:BEGIN -->",
    "- [ ] #1 Each row becomes one CSV line",
    "<!-- AC:END -->",
    "",
  ].join("\n");
}

const path = (id: number) => `backlog/tasks/dipo-${id} - Export-the-rows.md`;

/** A fixture whose base commit holds DIPO-1 and DIPO-2 as Refined; `change` makes the PR commit. */
async function pr(repo: TempRepo, change: Record<string, string>): Promise<[string, string]> {
  await Bun.write(`${repo.dir}/backlog/config.yml`, CONFIG);
  await Bun.write(`${repo.dir}/backlog/milestones/m-0 - m0-fixture.md`, MILESTONE.join("\n"));
  await Bun.write(`${repo.dir}/${path(1)}`, taskFile(1, "Refined", CLEAN_PLAN));
  await Bun.write(`${repo.dir}/${path(2)}`, taskFile(2, "Refined", NO_EXPECT));
  const base = await repo.commitAll("base");
  for (const [file, text] of Object.entries(change)) await Bun.write(`${repo.dir}/${file}`, text);
  return [base, await repo.commitAll("pr")];
}

async function check(repo: TempRepo, base: string, head: string) {
  return checkBacklogPrIn({ repo: repo.dir, base, head, cli: REPO_BACKLOG_CLI, tmp: repo.root });
}

const rules = (result: { failures: readonly { rule: string; task?: string }[] }) =>
  result.failures.map((failure) => `${failure.rule} ${failure.task ?? ""}`.trim());

describe("the structural check of a backlog-only PR in CI", () => {
  it("passes a story made Ready that passes the Ready gate, and leaves no worktree", async () => {
    await withTempRepo(async (repo) => {
      const [base, head] = await pr(repo, { [path(1)]: taskFile(1, "Ready", CLEAN_PLAN) });
      const result = await check(repo, base, head);
      expect(result.failures).toEqual([]);
      expect(result.passed).toBe(true);
      expect(result.touched.map(String)).toEqual(["DIPO-1"]);
      expect(await repo.git("worktree", "list", "--porcelain")).not.toContain("dipo-backlog-pr-");
      expect(readdirSync(repo.root).some((name) => name.startsWith("dipo-backlog-pr-"))).toBe(
        false,
      );
    });
  }, 60_000);

  it("fails a story made Ready that fails the Ready gate", async () => {
    await withTempRepo(async (repo) => {
      const [base, head] = await pr(repo, { [path(2)]: taskFile(2, "Ready", NO_EXPECT) });
      expect(rules(await check(repo, base, head))).toEqual(["ready-decision DIPO-2"]);
    });
  }, 60_000);

  it("fails a status change a backlog PR may not make, and a path outside backlog/", async () => {
    await withTempRepo(async (repo) => {
      const [base, head] = await pr(repo, {
        [path(1)]: taskFile(1, "Done", CLEAN_PLAN),
        "README.md": "outside\n",
      });
      expect(rules(await check(repo, base, head))).toEqual(["backlog-only", "transition DIPO-1"]);
    });
  }, 60_000);
});
