// The Ready gate over a fixture backlog (DIPO-196): a Ready story whose manual test-plan entry has
// no expect fails R20, a clean Ready story passes, a Refined story with the same fault is not
// checked, an R29 warning is reported without a failure, and every task is viewed once.

import { describe, expect, it } from "bun:test";

import type { BacklogCli } from "../packages/engine/src/backlog/runner";

import { checkReadyGate } from "./check-ready-gate";

interface FixtureStory {
  readonly id: string;
  readonly status: "Ready" | "Refined";
  readonly testPlan: readonly string[];
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

/** A `task view --plain` output of `story`: the outcome, a field block and one criterion. */
function viewOf(story: FixtureStory): string {
  const block = [
    "```dipo",
    `branch: "${story.id}/export-rows"`,
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
    "Labels: tier:M",
    "Milestone: m-0",
    "References: packages/export/",
    "",
    "Description:",
    RULE,
    `Outcome: the export writes every row of the table to a CSV file.\n\n${block}`,
    "",
    "Acceptance Criteria:",
    RULE,
    "- [ ] #1 Each row becomes one CSV line",
    "",
  ].join("\n");
}

/** A `backlog` fake over `stories` that answers `task list`, `task view` and `milestone list`. */
function fakeCli(stories: readonly FixtureStory[]): { cli: BacklogCli; views: string[] } {
  const views: string[] = [];
  const byId = new Map(stories.map((story) => [story.id, story]));
  const spawn: BacklogCli["spawn"] = ({ cmd }) => {
    const [group, sub, id] = cmd.slice(1);
    let stdout = "";
    if (group === "task" && sub === "list") {
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
    } else if (group === "task" && sub === "view") {
      views.push(id ?? "");
      const story = byId.get(id ?? "");
      if (story !== undefined) stdout = viewOf(story);
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

// No `.dipo/office.yaml` here, so the office configuration is the defaults.
const NO_OFFICE = "/nonexistent/dipo-ready-gate-fixture";

describe("the Ready gate over the backlog", () => {
  it("fails a Ready story whose manual entry has no expect, and passes a clean one", async () => {
    const { cli } = fakeCli([
      { id: "DIPO-1", status: "Ready", testPlan: MISSING_EXPECT },
      { id: "DIPO-2", status: "Ready", testPlan: CLEAN },
    ]);
    const report = await checkReadyGate(NO_OFFICE, cli);
    expect(report.checked).toBe(2);
    expect(report.failures.length).toBeGreaterThan(0);
    expect(report.failures.every((line) => line.startsWith("ready DIPO-1 failed "))).toBe(true);
    expect(report.failures.some((line) => line.startsWith("ready DIPO-1 failed R20:"))).toBe(true);
  });

  it("passes when every Ready story passes", async () => {
    const { cli } = fakeCli([{ id: "DIPO-2", status: "Ready", testPlan: CLEAN }]);
    expect(await checkReadyGate(NO_OFFICE, cli)).toEqual({ checked: 1, failures: [] });
  });

  it("does not check a Refined story with the same fault", async () => {
    const { cli } = fakeCli([
      { id: "DIPO-1", status: "Ready", testPlan: CLEAN },
      { id: "DIPO-3", status: "Refined", testPlan: MISSING_EXPECT },
    ]);
    expect(await checkReadyGate(NO_OFFICE, cli)).toEqual({ checked: 1, failures: [] });
  });

  it("reports an R29 warning of a Ready story without failing it", async () => {
    const { cli } = fakeCli([{ id: "DIPO-4", status: "Ready", testPlan: OUTSIDE }]);
    expect(await checkReadyGate(NO_OFFICE, cli)).toEqual({
      checked: 1,
      failures: [],
      warnings: [
        "ready DIPO-4 warning R29: test plan entry #1 names packages/daemon/test/x.test.ts, which no Reference covers; add it to the References or drop it from the plan",
      ],
    });
  });

  it("views each task once for all Ready stories", async () => {
    const stories: FixtureStory[] = [
      { id: "DIPO-1", status: "Ready", testPlan: CLEAN },
      { id: "DIPO-2", status: "Ready", testPlan: CLEAN },
      { id: "DIPO-3", status: "Refined", testPlan: CLEAN },
    ];
    const { cli, views } = fakeCli(stories);
    await checkReadyGate(NO_OFFICE, cli);
    expect(views.toSorted()).toEqual(["DIPO-1", "DIPO-2", "DIPO-3"]);
  });
});
