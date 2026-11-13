// The Ready gate over a fixture backlog (DIPO-196): a Ready story whose manual test-plan entry has
// no expect fails R20, a clean Ready story passes, a Refined story with the same fault is not
// checked, and an R29 warning is reported without a failure. Only the Ready stories are viewed
// through the CLI, none when no story is Ready; the other active tasks come from one pass over the
// fixture's task files (DIPO-494), so R13 (an unknown, archived or draft dependency), R14 (a cycle)
// and R19 (a shared branch) still fail, and a task file that does not parse fails the check. A task
// list that lost its last lines fails the check loudly instead of failing a story's rules
// (DIPO-323). The script's CLI is the daemon's spawn, and every call has the CLI write its output
// to files, never a pipe (DIPO-333).

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BacklogListIncompleteError } from "../packages/engine/src/backlog/list";
import type { BacklogCli } from "../packages/engine/src/backlog/runner";
import { systemSpawn } from "../packages/engine/src/platform/process";
import { type FileTask, writeBacklog } from "../packages/engine/test/gate/task-files";

import { checkReadyGate, REPO_BACKLOG_CLI } from "./check-ready-gate";

interface FixtureStory {
  readonly id: string;
  readonly status: "Ready" | "Refined" | "Done";
  readonly testPlan: readonly string[];
  /** A `role:` label on the story. */
  readonly role?: string;
  /** The ids it depends on; `view` shows one that is not a listed story as unknown. */
  readonly dependencies?: readonly string[];
  /** The branch of its field block; `<id>/export-rows` when not set. */
  readonly branch?: string;
}

const RULE = "-".repeat(50);
const MISSING_EXPECT = [
  "test_plan:",
  "  entries:",
  '    - kind: "manual"',
  '      check: "the export opens in a spreadsheet"',
];
// R29 (DIPO-251) only warns: a check that names a path outside `packages/export/`.
const OUTSIDE = [
  "test_plan:",
  "  entries:",
  '    - kind: "automated"',
  '      check: "(unit) packages/daemon/test/x.test.ts: the export runs"',
];
const CLEAN = [
  "test_plan:",
  "  entries:",
  '    - kind: "automated"',
  '      check: "the export writes one line per row"',
];

/** The `Depends on` lines of a view: a dependency that is no listed story is an unknown task ID. */
function dependsOf(story: FixtureStory, listed: ReadonlySet<string>): string[] {
  const deps = story.dependencies ?? [];
  if (deps.length === 0) return [];
  const lines = deps.map((dep, i) => {
    const mark = i === deps.length - 1 ? "└─" : "├─";
    return listed.has(dep)
      ? `${mark} ${dep} - Export [Refined]`
      : `${mark} ${dep} - unknown task ID`;
  });
  return [
    "Dependency Graph:",
    RULE,
    `Depends on (${deps.length} direct, ${deps.length} total):`,
    ...lines,
    "",
  ];
}

/** A `task view --plain` output of `story`: the outcome, a field block and one criterion. */
function viewOf(story: FixtureStory, listed: ReadonlySet<string> = new Set()): string {
  const block = [
    "```dipo",
    `branch: "${story.branch ?? `${story.id}/export-rows`}"`,
    "unknowns: []",
    ...story.testPlan,
    "```",
  ].join("\n");
  return [
    `File: /fixture/backlog/tasks/${story.id.toLowerCase()} - Export.md`,
    "",
    `Task ${story.id} - Export`,
    "=".repeat(50),
    "",
    `Status: ○ ${story.status}`,
    "Created: 2026-10-12 11:28 (UTC)",
    "Type: feature",
    `Labels: tier:M${story.role === undefined ? "" : `, role:${story.role}`}`,
    "Milestone: m-0",
    "References: packages/export/",
    "",
    ...dependsOf(story, listed),
    "Description:",
    RULE,
    `Story: As maintainer I want the export to write every row of the table to a CSV file so that I can open the nightly data in a spreadsheet.\n\n${block}`,
    "",
    "Acceptance Criteria:",
    RULE,
    "- [ ] #1 Each row becomes one CSV line",
    "",
  ].join("\n");
}

/** A `backlog` fake over `stories` that answers `task list`, `task view` and `milestone list`. */
function fakeCli(
  stories: readonly FixtureStory[],
  listed: (stdout: string) => string = (stdout) => stdout,
): { cli: BacklogCli; views: string[] } {
  const views: string[] = [];
  const byId = new Map(stories.map((story) => [story.id, story]));
  const listedIds = new Set(byId.keys());
  const spawn: BacklogCli["spawn"] = ({ cmd }) => {
    const [group, sub, id] = cmd.slice(1);
    let stdout = "";
    if (group === "task" && sub === "list" && cmd.includes("--count")) {
      stdout = `${stories.length}\n`;
    } else if (group === "task" && sub === "list") {
      const groups = [...new Set(stories.map((story) => story.status))];
      stdout = groups
        .map(
          (status) =>
            `${status}:\n${stories
              .filter((story) => story.status === status)
              .map((story) => `  ${story.id} - Export (ac: 0/1)`)
              .join("\n")}`,
        )
        .join("\n");
      stdout = listed(stdout);
    } else if (group === "task" && sub === "view") {
      views.push(id ?? "");
      const story = byId.get(id ?? "");
      if (story !== undefined) stdout = viewOf(story, listedIds);
    } else if (group === "milestone") {
      stdout = "Active milestones (1):\n  m-0: M0 (0/0 done)\n";
    }
    return {
      pid: 1,
      stdin: null,
      stdout: new Response(stdout).body as ReadableStream<Uint8Array>,
      stderr: new Response("").body as ReadableStream<Uint8Array>,
      exited: Promise.resolve({ code: 0, signal: null }),
      kill: () => {},
    };
  };
  return { cli: { spawn, command: ["backlog"] }, views };
}

/** The task file of a listed story: what the one pass over the task files reads of it. */
function fileOf(story: FixtureStory): FileTask {
  return {
    id: story.id,
    status: story.status,
    dependencies: `[${(story.dependencies ?? []).join(", ")}]`,
    branch: `"${story.branch ?? `${story.id}/export-rows`}"`,
  };
}

/**
 * A fixture checkout holding `stories` as task files, and `extra` files besides (a completed,
 * archived or draft task, or one that does not parse). There is no `.dipo/office.yaml` in it, so
 * the office configuration is the defaults.
 */
async function inFixture<T>(
  stories: readonly FixtureStory[],
  extra: readonly FileTask[],
  body: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(process.env.DIPO_TMP ?? "/tmp", "rg-"));
  try {
    writeBacklog(dir, [...stories.map(fileOf), ...extra]);
    return await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const run = (
  stories: readonly FixtureStory[],
  extra: readonly FileTask[] = [],
  listed?: (stdout: string) => string,
) =>
  inFixture(stories, extra, async (dir) => {
    const { cli, views } = fakeCli(stories, listed);
    return { report: await checkReadyGate(dir, cli), views };
  });

const failuresOf = async (stories: readonly FixtureStory[], extra: readonly FileTask[] = []) =>
  (await run(stories, extra)).report.failures;

describe("the Ready gate over the backlog", () => {
  it("fails a Ready story whose role has no role file in the checkout, and passes it once added (DIPO-471)", () =>
    inFixture([], [], async (dir) => {
      const { cli } = fakeCli([
        { id: "DIPO-5", status: "Ready", testPlan: CLEAN, role: "developer" },
      ]);
      writeBacklog(dir, [{ id: "DIPO-5", status: "Ready", branch: '"DIPO-5/export-rows"' }]);
      const before = await checkReadyGate(dir, cli);
      expect(before.failures).toEqual([
        expect.stringContaining("ready DIPO-5 failed R17: role developer is not in the roster"),
      ]);
      mkdirSync(join(dir, ".dipo", "roles"), { recursive: true });
      writeFileSync(
        join(dir, ".dipo", "roles", "developer.md"),
        "---\nversion: 1\npurpose: Builds the story\n---\nDo the work.\n",
      );
      expect(await checkReadyGate(dir, cli)).toEqual({
        checked: 1,
        passed: ["DIPO-5"],
        failures: [],
      });
    }));

  it("fails a Ready story whose manual entry has no expect, and passes a clean one", async () => {
    const { report } = await run([
      { id: "DIPO-1", status: "Ready", testPlan: MISSING_EXPECT },
      { id: "DIPO-2", status: "Ready", testPlan: CLEAN },
    ]);
    expect(report.checked).toBe(2);
    expect(report.passed).toEqual(["DIPO-2"]);
    expect(report.failures.length).toBeGreaterThan(0);
    expect(report.failures.every((line) => line.startsWith("ready DIPO-1 failed "))).toBe(true);
    expect(report.failures.some((line) => line.startsWith("ready DIPO-1 failed R20:"))).toBe(true);
  });

  it("passes when every Ready story passes", async () => {
    expect((await run([{ id: "DIPO-2", status: "Ready", testPlan: CLEAN }])).report).toEqual({
      checked: 1,
      passed: ["DIPO-2"],
      failures: [],
    });
  });

  it("does not check a Refined story with the same fault", async () => {
    const { report } = await run([
      { id: "DIPO-1", status: "Ready", testPlan: CLEAN },
      { id: "DIPO-3", status: "Refined", testPlan: MISSING_EXPECT },
    ]);
    expect(report).toEqual({ checked: 1, passed: ["DIPO-1"], failures: [] });
  });

  it("reports an R29 warning of a Ready story without failing it", async () => {
    const { report } = await run([{ id: "DIPO-4", status: "Ready", testPlan: OUTSIDE }]);
    expect(report).toEqual({
      checked: 1,
      passed: ["DIPO-4"],
      failures: [],
      warnings: [
        "ready DIPO-4 warning R29: test plan entry #1 names packages/daemon/test/x.test.ts, which no Reference covers; add it to the References or drop it from the plan",
      ],
    });
  });

  it("views no task when no story is Ready, and exactly the Ready stories otherwise", async () => {
    const none = await run([
      { id: "DIPO-1", status: "Refined", testPlan: CLEAN },
      { id: "DIPO-2", status: "Refined", testPlan: CLEAN },
    ]);
    expect(none.views).toEqual([]);
    expect(none.report).toEqual({ checked: 0, passed: [], failures: [] });
    const two = await run([
      { id: "DIPO-1", status: "Ready", testPlan: CLEAN },
      { id: "DIPO-2", status: "Ready", testPlan: CLEAN },
      { id: "DIPO-3", status: "Refined", testPlan: CLEAN },
      { id: "DIPO-4", status: "Done", testPlan: CLEAN },
    ]);
    expect(two.views.toSorted()).toEqual(["DIPO-1", "DIPO-2"]);
  });

  it("runs every CLI call through the daemon's spawn with its output on files", async () => {
    expect(REPO_BACKLOG_CLI.spawn).toBe(systemSpawn);
    const stories: FixtureStory[] = [
      { id: "DIPO-1", status: "Ready", testPlan: CLEAN },
      { id: "DIPO-3", status: "Refined", testPlan: CLEAN },
    ];
    await inFixture(stories, [], async (dir) => {
      const { cli } = fakeCli(stories);
      const outputs: unknown[] = [];
      const spawn: BacklogCli["spawn"] = (options) => {
        outputs.push(options.output?.to);
        return cli.spawn(options);
      };
      await checkReadyGate(dir, { ...cli, spawn });
      expect(outputs.length).toBeGreaterThan(0);
      expect(outputs.every((to) => to === "file")).toBe(true);
    });
  });

  it("fails loudly when the task list lost its last lines", async () => {
    const stories: FixtureStory[] = [
      { id: "DIPO-1", status: "Ready", testPlan: CLEAN },
      { id: "DIPO-3", status: "Refined", testPlan: CLEAN },
    ];
    await inFixture(stories, [], async (dir) => {
      const { cli, views } = fakeCli(stories, (stdout) =>
        stdout.slice(0, stdout.indexOf("\n  DIPO-3")),
      );
      const check = checkReadyGate(dir, cli);
      await expect(check).rejects.toBeInstanceOf(BacklogListIncompleteError);
      await expect(check).rejects.toThrow(/printed 1 entries, but its --count says 2/);
      expect(views).toEqual([]);
    });
  });

  it("fails loudly when a Ready story's own view does not parse", async () => {
    const stories: FixtureStory[] = [{ id: "DIPO-1", status: "Ready", testPlan: CLEAN }];
    await inFixture(stories, [], async (dir) => {
      const { cli } = fakeCli(stories);
      const spawn: BacklogCli["spawn"] = (options) =>
        options.cmd[2] === "list" || options.cmd[1] !== "task"
          ? cli.spawn(options)
          : fakeCli([]).cli.spawn(options);
      await expect(checkReadyGate(dir, { ...cli, spawn })).rejects.toThrow(
        "DIPO-1 is Ready but its Backlog view does not parse",
      );
    });
  });
});

const ready = (id: string, over: Partial<FixtureStory> = {}): FixtureStory => ({
  id,
  status: "Ready",
  testPlan: CLEAN,
  ...over,
});
const refined = (id: string, over: Partial<FixtureStory> = {}): FixtureStory =>
  ready(id, { status: "Refined", ...over });

describe("the Ready gate's other tasks from the task files (DIPO-494)", () => {
  it("fails R13 for a dependency that is unknown, archived or a draft, and not for a Done task", async () => {
    const failures = await failuresOf(
      [
        ready("DIPO-1", {
          dependencies: ["DIPO-2", "DIPO-6", "DIPO-7", "DRAFT-8", "DIPO-9", "DIPO-99"],
        }),
        { id: "DIPO-2", status: "Done", testPlan: CLEAN },
      ],
      [
        { id: "DIPO-6", status: "Done", folder: "archive/tasks" },
        { id: "DIPO-7", status: "Done", folder: "completed" },
        { id: "DRAFT-8", status: "Draft", folder: "drafts" },
      ],
    );
    expect(failures).toEqual(
      ["DIPO-6", "DIPO-7", "DRAFT-8", "DIPO-9", "DIPO-99"].map(
        (id) => `ready DIPO-1 failed R13: dependency ${id} is not an active task`,
      ),
    );
  });

  it("fails R14 for a dependency cycle through the story", async () => {
    const failures = await failuresOf([
      ready("DIPO-1", { dependencies: ["DIPO-2"] }),
      refined("DIPO-2", { dependencies: ["DIPO-3"] }),
      refined("DIPO-3", { dependencies: ["DIPO-1"] }),
    ]);
    expect(failures).toContain(
      "ready DIPO-1 failed R14: dependency cycle: DIPO-1 -> DIPO-2 -> DIPO-3 -> DIPO-1",
    );
  });

  it("fails R19 for another active task with the story's branch in any quoting", async () => {
    const shared = "DIPO-1/export-rows";
    const files: FileTask[] = [
      { id: "DIPO-2", branch: `'${shared}'` },
      { id: "DIPO-3", branch: shared },
      { id: "DIPO-4", branch: '"DIPO-1/export-\\u0072ows"' },
      { id: "DIPO-5", branch: '"DIPO-5/other"' },
      { id: "DIPO-6", folder: "completed", branch: `"${shared}"` },
    ];
    const failures = await failuresOf([ready("DIPO-1")], files);
    expect(failures).toEqual(
      ["DIPO-2", "DIPO-3", "DIPO-4"].map(
        (id) => `ready DIPO-1 failed R19: branch "${shared}" is already used by ${id}`,
      ),
    );
  });

  it("reads a dependency list and an id in the forms the CLI reads them", async () => {
    const failures = await failuresOf(
      [ready("DIPO-1", { dependencies: ["DIPO-2", "dipo-3"] })],
      [
        { id: "DIPO-2", dependencies: "[dipo-1]" },
        { id: "dipo-3", dependencies: "\n  - DIPO-1" },
      ],
    );
    expect(failures).toContain(
      "ready DIPO-1 failed R14: dependency cycle: DIPO-1 -> DIPO-2 -> DIPO-1",
    );
  });

  it("fails the check when another task's file does not parse, with no Ready story too", async () => {
    const hidden: FileTask = { id: "DIPO-2", text: "---\ntitle: no id\nstatus: Refined\n---\n" };
    await expect(run([ready("DIPO-1")], [hidden])).rejects.toThrow(
      /dipo-2 - Task\.md: its front matter has no id/,
    );
    await expect(run([refined("DIPO-1")], [hidden])).rejects.toThrow(/its front matter has no id/);
    const badBlock: FileTask = { id: "DIPO-3", branch: '"DIPO-3/Not_A_Slug"' };
    await expect(run([ready("DIPO-1")], [badBlock])).rejects.toThrow(/field block does not parse/);
  });
});
