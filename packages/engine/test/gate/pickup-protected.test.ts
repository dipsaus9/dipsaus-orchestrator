// R31 (DIPO-409): a pickup gate refuses a story whose References name a path the box protects, with
// the same `protectedKind` the scope-violation park uses, and Ready mode does not check it. The
// fail-closed read is shown on the real `readGateInput` path with a store whose folders cannot be read.

import { describe, expect, it } from "bun:test";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { DEFAULT_CONFIG, input, PASSING_STORY } from "./fixtures";
import { evaluateGate, type GateInput } from "../../src/gate";
import { readGateInput } from "../../src/gate-decisions/read";
import type { StoryStore } from "../../src/story-store/store";
import type { PlainTask } from "../../src/story-store/story";

/** The R31 failure messages of a pickup evaluation of a Ready story naming `reference`. */
function pickupFailures(reference: string, rest: Partial<GateInput> = {}): string[] {
  const story = { status: "Ready", references: [reference] };
  return evaluateGate(input(story, rest), "pickup").failures.map((failure) => failure.rule);
}

const PROTECTED = [
  ".dipo/office.yaml",
  ".dipo/",
  ".github/workflows/ci.yml",
  ".github/",
  ".GitHub/x",
  ".ＧitHub/x",
  "./.dipo/x",
  ".dipo/x/",
  ".gitmodules",
  "bunfig.toml",
  "backlog/tasks/a.md",
  ".claude/settings.json",
];

const NOT_PROTECTED = ["packages/engine/src/x.ts", "packages/", ".claude/"];

describe("R31 at pickup", () => {
  it("refuses a reference the box protects, naming the path, its kind and the taker", () => {
    const result = evaluateGate(
      input({ status: "Ready", references: ["packages/export/", ".github/workflows/ci.yml"] }),
      "pickup",
    );
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual([
      {
        rule: "R31",
        message:
          'ready DIPO-7 failed R31: reference ".github/workflows/ci.yml" names CI configuration (.github/), which only dipo or the maintainer writes; a builder or the maintainer takes such a story',
      },
    ]);
  });

  it("uses protectedKind for every reference form the box protects", () => {
    for (const path of PROTECTED) {
      expect([path, pickupFailures(path).includes("R31")]).toEqual([path, true]);
    }
  });

  it("passes references the box does not protect", () => {
    for (const path of NOT_PROTECTED) {
      expect([path, pickupFailures(path)]).toEqual([path, []]);
    }
  });

  it("refuses a story-folder reference through the story folders of the input", () => {
    expect(pickupFailures("planning/board/a.md", { storyFolders: ["planning"] })).toContain("R31");
    expect(pickupFailures("planning/board/a.md", { storyFolders: ["other"] })).not.toContain("R31");
  });

  it("does not check R31 in Ready mode, so a Refined story naming .github/ still passes", () => {
    const story = { references: [".github/", ".dipo/office.yaml"] };
    expect(evaluateGate(input(story), "ready")).toEqual({
      mode: "ready",
      passed: true,
      failures: [],
    });
  });

  it("the Ready-mode story of the fixture passes both modes unchanged", () => {
    expect(evaluateGate(input(), "ready").passed).toBe(true);
    expect(evaluateGate(input({ status: "Ready" }), "pickup").passed).toBe(true);
    expect(PASSING_STORY.references).toEqual(["packages/export/", "docs/export.md"]);
  });
});

describe("the gate input when the story folders cannot be read", () => {
  it("throws rather than building an input the pickup gate could pass", async () => {
    await withTempDir(async (dir) => {
      const stories = {
        view: async () =>
          ({ ...PASSING_STORY, subtasks: [], dependencies: [] }) as unknown as PlainTask,
        milestones: async () => ["m-0"],
        storyFolders: async () => {
          throw new Error("the folder names cannot be read");
        },
      } as unknown as StoryStore;
      await expect(readGateInput(stories, dir, "DIPO-7", DEFAULT_CONFIG, [])).rejects.toThrow(
        "the folder names cannot be read",
      );
    });
  });
});
