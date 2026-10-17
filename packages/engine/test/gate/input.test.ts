// Gate inputs built from recorded `task view --plain` output (Backlog.md 1.53.0).

import { describe, expect, it } from "bun:test";

import { type DependencyEntry, parseView } from "../../src/backlog/plain";
import { gateStoryFromView, gateTaskFromView, waitingOnOf } from "../../src/gate";
import { recorded } from "../backlog/helpers";

describe("gate inputs from a parsed view", () => {
  const view = parseView(recorded("task-view-full"));

  it("maps the story fields the rules read", () => {
    expect(gateStoryFromView(view, ["TASK-1.1.1"])).toEqual({
      id: "TASK-1.1",
      title: "Ship the full export",
      status: "In Progress",
      type: "feature",
      milestone: "m-0",
      labels: ["tier:M", "role:developer", "test-before-merge"],
      description: view.description,
      acceptanceCriteria: view.acceptanceCriteria,
      references: ["packages/a/", "packages/b.ts"],
      documentation: ["docs/x.md", "https://example.com/y"],
      dependencies: ["TASK-1", "TASK-2"],
      subtasks: ["TASK-1.1.1"],
      implementationPlan: "Step one",
    });
  });

  it("lists the dependencies that are not Done, with their statuses", () => {
    expect(waitingOnOf(view)).toEqual([
      { id: "TASK-1", status: "Ready" },
      { id: "TASK-2", status: "Refined" },
    ]);
    const done: DependencyEntry = { id: "TASK-1", state: "resolved", status: "Done" };
    expect(waitingOnOf({ ...view, dependencies: [done] })).toEqual([]);
    const missing: DependencyEntry = { id: "TASK-9", state: "missing" };
    expect(waitingOnOf({ ...view, dependencies: [missing] })).toEqual([{ id: "TASK-9" }]);
  });

  it("reads an active task's branch from its field block, and none from a broken block", () => {
    expect(gateTaskFromView(view)).toEqual({
      id: "TASK-1.1",
      dependencies: ["TASK-1", "TASK-2"],
      branch: "TASK-1.1/ship-the-full-export",
    });
    const broken = { ...view, description: "Outcome: x\n\n```dipo\nbranch: 5\n```" };
    expect(gateTaskFromView(broken)).toEqual({
      id: "TASK-1.1",
      dependencies: ["TASK-1", "TASK-2"],
    });
  });
});
