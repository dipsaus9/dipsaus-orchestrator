// Records the `--plain` fixtures in `test/fixtures/backlog-plain/` from the pinned Backlog.md CLI
// (0010 section 1: a new minor is adopted by recording new fixtures and passing the parser tests).
// It works on a temporary copy of the Backlog fixture project, never on a real backlog, and
// replaces the temporary path in `File:` lines with `/fixture`.
//
//   bun packages/engine/test/backlog/record-plain.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isolatedEnv, runCommand, withTempRepo } from "@dipsaus-orchestrator/testkit";

import { BACKLOG_CLI, BACKLOG_FIXTURE, PLAIN_FIXTURES, type PlainRecording } from "./helpers";

const RULE = "-".repeat(50);

/** The steps that build the recorded project, run before any recording. */
const SETUP: readonly (readonly string[])[] = [
  ["milestone", "add", "m-0"],
  ["task", "edit", "TASK-2", "--dep", "TASK-3"],
  [
    "task",
    "create",
    "Ship the full export",
    "-d",
    'Outcome: the full export ships with every field set.\n\nFree context line.\n\n```dipo\nbranch: "TASK-1.1/ship-the-full-export"\nunknowns: []\ntest_plan:\n  entries:\n    - kind: "automated"\n      check: "(unit) every field"\n```',
    "-s",
    "In Progress",
    "-a",
    "@alice",
    "-l",
    "tier:M,role:developer,test-before-merge",
    "--priority",
    "High",
    "--type",
    "feature",
    "--ac",
    "First criterion",
    "--ac",
    "Second criterion",
    "--dod",
    "Docs updated",
    "--plan",
    "Step one",
    "--notes",
    "Some notes",
    "--final-summary",
    "Done summary",
    "--ordinal",
    "4000",
    "-m",
    "m-0",
    "-p",
    "TASK-1",
    "--dep",
    "TASK-1,TASK-2",
    "--ref",
    "packages/a/",
    "--ref",
    "packages/b.ts",
    "--doc",
    "docs/x.md",
    "--doc",
    "https://example.com/y",
    "--modified-file",
    "packages/a/z.ts",
    "--due-date",
    "2026-12-01",
  ],
  ["task", "edit", "TASK-1.1", "--check-ac", "1"],
  ["task", "edit", "TASK-1.1", "--comment", "A comment here", "--comment-author", "@bob"],
  // Fact 2: a description holding a section name and a rule prints a second, fake section.
  [
    "task",
    "create",
    "Describe a fake section",
    "-d",
    `Outcome: the parser refuses a fake section.\n\nAcceptance Criteria:\n${RULE}\n- [x] #1 Not a real criterion`,
    "--ac",
    "The real criterion",
  ],
];

const RECORD: readonly (readonly [string, readonly string[]])[] = [
  ["task-view-full", ["task", "view", "TASK-1.1", "--plain"]],
  ["task-view-dependents", ["task", "view", "TASK-1", "--plain"]],
  ["task-view-fake-section", ["task", "view", "TASK-4", "--plain"]],
  ["draft-view", ["draft", "view", "DRAFT-1", "--plain"]],
  ["task-list", ["task", "list", "--plain"]],
  ["draft-list", ["draft", "list", "--plain"]],
  ["task-view-unknown", ["task", "view", "TASK-99", "--plain"]],
  ["draft-view-unknown", ["draft", "view", "DRAFT-99", "--plain"]],
];

await withTempRepo(
  async (repo) => {
    await repo.commitAll("fixture");
    const env = isolatedEnv(repo.home);
    const cli = async (args: readonly string[]) =>
      runCommand([...BACKLOG_CLI, ...args], { cwd: repo.dir, env });
    const version = (await cli(["--version"])).stdout.trim();
    for (const step of SETUP) {
      const result = await cli(step);
      if (result.exitCode !== 0) throw new Error(`${step.join(" ")}: ${result.stderr}`);
    }
    mkdirSync(PLAIN_FIXTURES, { recursive: true });
    const recordings: PlainRecording[] = [];
    for (const [name, args] of RECORD) {
      const result = await cli(args);
      const clean = (text: string) => text.replaceAll(repo.dir, "/fixture");
      writeFileSync(join(PLAIN_FIXTURES, `${name}.stdout.txt`), clean(result.stdout));
      recordings.push({
        name,
        args: [...args],
        exitCode: result.exitCode,
        stderr: clean(result.stderr),
      });
    }
    writeFileSync(
      join(PLAIN_FIXTURES, "recordings.json"),
      `${JSON.stringify({ backlog: version, recordings }, null, 2)}\n`,
    );
    console.log(`recorded ${recordings.length} outputs from Backlog.md ${version}`);
  },
  { fixture: BACKLOG_FIXTURE },
);
