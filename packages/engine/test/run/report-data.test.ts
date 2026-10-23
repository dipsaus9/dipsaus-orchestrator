// The pure rules of the report gate (DIPO-186 with DIPO-254): which automated test-plan entries a
// done report leaves open, whether a decision note's section is in its file, and whether a box
// worker's tool trail shows a verify or test run after its last edit.

import { describe, expect, it } from "bun:test";

import type { TestPlan } from "@dipsaus-orchestrator/contract";

import {
  emptyTrail,
  followTool,
  hasSection,
  noteMiss,
  proposalHash,
  ranCheckAfterEdit,
  sectionHeadings,
  testPlanGaps,
  trailAt,
} from "../../src/run/report-data";
import { checkCommands, runnableCommand } from "../../src/run/verify-commit";
import { detect } from "../../src/scan/detect";

const PLAN: TestPlan = {
  entries: [
    { kind: "automated", check: "(unit) one" },
    { kind: "manual", check: "look" },
    { kind: "automated", check: " (unit) three " },
  ],
};

describe("testPlanGaps", () => {
  it("names each automated entry not reported done, in plan order, and never a manual one", () => {
    expect(
      testPlanGaps(PLAN, [
        { n: 3, status: "manual", evidence: "e" },
        { n: 2, status: "not-done", evidence: "e" },
      ]),
    ).toEqual([
      { n: 1, check: "(unit) one", reported: "missing" },
      { n: 3, check: "(unit) three", reported: "manual" },
    ]);
    expect(testPlanGaps(PLAN, undefined).map((gap) => gap.n)).toEqual([1, 3]);
    expect(
      testPlanGaps(PLAN, [
        { n: 1, status: "done", evidence: "e" },
        { n: 3, status: "done", evidence: "e" },
      ]),
    ).toEqual([]);
  });

  it("reads the first entry of a number and ignores numbers the plan does not have", () => {
    expect(
      testPlanGaps(PLAN, [
        { n: 1, status: "not-done", evidence: "e" },
        { n: 1, status: "done", evidence: "e" },
        { n: 3, status: "done", evidence: "e" },
        { n: 9, status: "done", evidence: "e" },
      ]),
    ).toEqual([{ n: 1, check: "(unit) one", reported: "not-done" }]);
  });

  it("checks nothing without a plan, for a plan that does not apply, or for a spike", () => {
    expect(testPlanGaps(undefined, undefined)).toEqual([]);
    expect(testPlanGaps({ not_applicable: "docs" }, undefined)).toEqual([]);
    expect(testPlanGaps(PLAN, undefined, "spike")).toEqual([]);
    expect(testPlanGaps(PLAN, undefined, "Spike")).toEqual([]);
  });
});

describe("decision note sections", () => {
  const TEXT = [
    "# 0008 Worker adapter",
    "",
    "## Decision",
    "",
    "### 1. The worker port ###",
    "",
    "```md",
    "## Not a heading",
    "```",
    "#hashtag is no heading",
  ].join("\n");

  it("reads Markdown headings outside fences", () => {
    expect(sectionHeadings(TEXT)).toEqual([
      "0008 Worker adapter",
      "Decision",
      "1. The worker port",
    ]);
  });

  it("matches a section by its heading, with or without marks, number, case or extra spaces", () => {
    for (const section of [
      "1. The worker port",
      "### 1. The worker port",
      "the  worker PORT",
      "Decision",
    ]) {
      expect(hasSection(TEXT, section)).toBe(true);
    }
    for (const section of ["Not a heading", "worker port", "", "##"]) {
      expect(hasSection(TEXT, section)).toBe(false);
    }
  });

  it("tells a missing file from a missing section", () => {
    const note = { file: "docs/decisions/0008-worker-adapter.md", section: "Decision", text: "t" };
    expect(noteMiss(note, null)).toBe("file");
    expect(noteMiss(note, TEXT)).toBeNull();
    expect(noteMiss({ ...note, section: "Context" }, TEXT)).toBe("section");
  });
});

describe("the tool trail", () => {
  const COMMANDS = ["bun run verify", "bun test"];

  it("needs a verify or test run after the last edit, and nothing when nothing was edited", () => {
    const trail = emptyTrail();
    expect(ranCheckAfterEdit(trail, COMMANDS)).toBe(true);
    followTool(trail, "shell", "bun run verify");
    followTool(trail, "edit", undefined);
    expect(ranCheckAfterEdit(trail, COMMANDS)).toBe(false);
    followTool(trail, "shell", "ls src");
    expect(ranCheckAfterEdit(trail, COMMANDS)).toBe(false);
    followTool(trail, "shell", "PATH=/x:$PATH  bun   run verify 2>&1 | tail -40");
    expect(ranCheckAfterEdit(trail, COMMANDS)).toBe(true);
    const before = trailAt(trail);
    followTool(trail, "edit", undefined);
    expect(ranCheckAfterEdit(trail, COMMANDS)).toBe(false);
    // A copy taken before is not changed by later calls.
    expect(ranCheckAfterEdit(before, COMMANDS)).toBe(true);
    followTool(trail, "shell", "bun test packages/engine/test/x.test.ts");
    expect(ranCheckAfterEdit(trail, COMMANDS)).toBe(true);
  });

  it("asks nothing when the office has no verify or test command", () => {
    const trail = emptyTrail();
    followTool(trail, "edit", undefined);
    expect(ranCheckAfterEdit(trail, [])).toBe(true);
    expect(ranCheckAfterEdit(trail, ["  "])).toBe(true);
  });

  it("takes the office's verify and test commands from its profile, verify first", () => {
    const profile = detect({
      texts: {
        "package.json": JSON.stringify({
          name: "p",
          packageManager: "bun@1.4.2",
          scripts: { verify: "bun run lint && bun test", test: "bun test" },
        }),
      },
      lockfiles: ["bun.lock"],
      workspaceDirs: [],
      configImports: {},
      envFiles: [],
    });
    const commands = checkCommands(profile);
    expect(commands[0]).toEqual({ text: "bun run verify", cwd: "." });
    expect(commands).toContainEqual({ text: "bun run test", cwd: "." });
    expect(checkCommands(null)).toEqual([]);
  });

  it("matches a command off the root by its bare text and names it with cd for the worker", () => {
    const base = detect({
      texts: { "package.json": JSON.stringify({ name: "p", packageManager: "bun@1.4.2" }) },
      lockfiles: ["bun.lock"],
      workspaceDirs: [],
      configImports: {},
      envFiles: [],
    });
    const profile = {
      ...base,
      capabilities: {
        ...base.capabilities,
        verify: {
          status: "resolved",
          value: { commands: [["bun", "test"]], cwd: "packages/app" },
        },
      },
    } as unknown as typeof base;
    const commands = checkCommands(profile);
    expect(commands[0]).toEqual({ text: "bun test", cwd: "packages/app" });
    expect(runnableCommand({ text: "bun test", cwd: "packages/app" })).toBe(
      "cd packages/app && bun test",
    );
    expect(runnableCommand({ text: "bun test", cwd: "." })).toBe("bun test");
    // The worker's own cd line holds the bare text, so it counts as a run.
    const trail = emptyTrail();
    followTool(trail, "edit", undefined);
    followTool(trail, "shell", "cd packages/app && bun test");
    expect(
      ranCheckAfterEdit(
        trail,
        commands.map((command) => command.text),
      ),
    ).toBe(true);
  });
});

describe("proposalHash", () => {
  it("keys a proposal by its title and its paths in any order, not by its other fields", () => {
    const a = proposalHash({ title: "Split", paths: ["b", "a"] });
    expect(proposalHash({ title: " Split ", paths: ["a", "b"] })).toBe(a);
    expect(proposalHash({ title: "Split", paths: ["a"] })).not.toBe(a);
    expect(proposalHash({ title: "Split" })).toBe(proposalHash({ title: "Split", paths: [] }));
    expect(proposalHash({ title: "Other", paths: ["a", "b"] })).not.toBe(a);
  });
});
