// The structural check of a backlog PR as a pure function over fixture diffs (DIPO-35; 0010
// section 2): each rule fails on its own fixture and names its rule and task, and a valid
// office-init diff passes.

import { describe, expect, it } from "bun:test";

import { StoryKey } from "@dipsaus-orchestrator/contract";

import {
  checkBacklogPr,
  type PrDiff,
  type PrFacts,
  type TaskSide,
} from "../../../src/backlog/pr/check";
import { taskOfPath } from "../../../src/backlog/pr/diff";
import type { PlainTask } from "../../../src/backlog/plain";
import { gateStoryFromView } from "../../../src/gate/input";
import { gateContentHash } from "../../../src/gate/store/hash";

const K1 = StoryKey.parse("sto_01HZZZZZZZZZZZZZZZZZZZZZZ1");
const K2 = StoryKey.parse("sto_01HZZZZZZZZZZZZZZZZZZZZZZ2");

const BLOCK = ["```dipo", 'branch: "TASK-1/add-csv"', "unknowns: []", "```"].join("\n");

function task(
  id: string,
  status: string,
  description = `Outcome: a story.\n\n${BLOCK}`,
): PlainTask {
  return {
    file: `/office/backlog/tasks/${id.toLowerCase()} - Story.md`,
    id,
    title: "Story",
    status,
    assignee: [],
    created: "2026-10-12 11:28 (UTC)",
    labels: ["tier:S"],
    subtasks: [],
    references: ["src/"],
    documentation: [],
    dependencies: [],
    description,
    acceptanceCriteria: [{ index: 1, checked: false, text: "It works as described." }],
    definitionOfDone: [],
    modifiedFiles: [],
    comments: [],
    unknown: [],
  };
}

function side(view: PlainTask): TaskSide {
  return { where: "task", view: { ok: true, task: view } };
}

function hashOf(view: PlainTask): string {
  return gateContentHash(gateStoryFromView(view, []));
}

const NO_FACTS: PrFacts = { keys: {}, claimed: [], passing: {} };

describe("taskOfPath", () => {
  it("maps Backlog.md task and draft files to ids and places", () => {
    expect(taskOfPath("backlog/tasks/task-1 - Add-it.md")).toEqual({ id: "TASK-1", where: "task" });
    expect(taskOfPath("backlog/drafts/draft-2 - Idea.md")).toEqual({
      id: "DRAFT-2",
      where: "draft",
    });
    expect(taskOfPath("backlog/archive/tasks/task-3 - Gone.md")).toEqual({
      id: "TASK-3",
      where: "archived",
    });
    expect(taskOfPath("backlog/config.yml")).toBeNull();
    expect(taskOfPath("backlog/docs/doc-1 - Notes.md")).toBeNull();
  });
});

describe("checkBacklogPr", () => {
  it("passes a valid office-init diff: config, To Do to Refined, a new draft, a gated Ready", () => {
    const ready = task("TASK-2", "Ready");
    const diff: PrDiff = {
      paths: [
        "backlog/config.yml",
        "backlog/tasks/task-1 - Story.md",
        "backlog/tasks/task-2 - Story.md",
        "backlog/drafts/draft-1 - Idea.md",
      ],
      tasks: [
        {
          id: "TASK-1",
          before: side(task("TASK-1", "To Do")),
          after: side(task("TASK-1", "Refined")),
        },
        { id: "TASK-2", before: side(task("TASK-2", "Refined")), after: side(ready) },
        {
          id: "DRAFT-1",
          before: { where: "absent" },
          after: { where: "draft", view: { ok: true, task: task("DRAFT-1", "Draft") } },
        },
      ],
    };
    const facts: PrFacts = {
      keys: { "TASK-1": K1, "TASK-2": K2 },
      claimed: [],
      passing: { [K2]: [hashOf(ready)] },
    };
    expect(checkBacklogPr(diff, facts)).toEqual({ passed: true, failures: [], touched: [K1, K2] });
  });

  it("fails a path outside backlog/", () => {
    const result = checkBacklogPr(
      { paths: ["backlog/config.yml", "src/index.ts"], tasks: [] },
      NO_FACTS,
    );
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual([
      { rule: "backlog-only", message: "the PR changes paths outside backlog/: src/index.ts" },
    ]);
  });

  it("fails a task that does not parse, and one whose field block is invalid (R02)", () => {
    const result = checkBacklogPr(
      {
        paths: ["backlog/tasks/task-1 - Story.md", "backlog/tasks/task-2 - Story.md"],
        tasks: [
          {
            id: "TASK-1",
            before: side(task("TASK-1", "Refined")),
            after: {
              where: "task",
              view: { ok: false, error: "R02: the Description section appears twice" },
            },
          },
          {
            id: "TASK-2",
            before: side(task("TASK-2", "Refined")),
            after: side(task("TASK-2", "Refined", "Outcome: x.\n\n```dipo\nbranch: 5\n```")),
          },
        ],
      },
      NO_FACTS,
    );
    expect(result.failures.map((f) => [f.rule, f.task])).toEqual([
      ["parses", "TASK-1"],
      ["parses", "TASK-2"],
    ]);
  });

  it("fails a status change lane b may not write", () => {
    const result = checkBacklogPr(
      {
        paths: ["backlog/tasks/task-1 - Story.md", "backlog/tasks/task-2 - Story.md"],
        tasks: [
          {
            id: "TASK-1",
            before: side(task("TASK-1", "Ready")),
            after: side(task("TASK-1", "In Progress")),
          },
          {
            id: "TASK-2",
            before: side(task("TASK-2", "Refined")),
            after: side(task("TASK-2", "Done")),
          },
        ],
      },
      NO_FACTS,
    );
    expect(result.failures.map((f) => [f.rule, f.task, f.message])).toEqual([
      [
        "transition",
        "TASK-1",
        "TASK-1 moves from Ready to In Progress, which a backlog PR may not do (0012 section 2)",
      ],
      [
        "transition",
        "TASK-2",
        "TASK-2 moves from Refined to Done, which a backlog PR may not do (0012 section 2)",
      ],
    ]);
  });

  it("fails a new Ready without a passing gate decision for its content", () => {
    const ready = task("TASK-1", "Ready");
    const edited = task("TASK-1", "Ready", `Outcome: another story now.\n\n${BLOCK}`);
    const diff: PrDiff = {
      paths: ["backlog/tasks/task-1 - Story.md"],
      tasks: [{ id: "TASK-1", before: side(task("TASK-1", "Refined")), after: side(edited) }],
    };
    // A decision for the content before the edit does not count.
    const result = checkBacklogPr(diff, {
      keys: { "TASK-1": K1 },
      claimed: [],
      passing: { [K1]: [hashOf(ready)] },
    });
    expect(result.failures.map((f) => [f.rule, f.task, f.key])).toEqual([
      ["ready-decision", "TASK-1", K1],
    ]);
    // A story dipo does not know cannot match a decision either.
    expect(checkBacklogPr(diff, NO_FACTS).failures.map((f) => f.rule)).toEqual(["ready-decision"]);
  });

  it("fails a touched task with a live claim", () => {
    const result = checkBacklogPr(
      {
        paths: ["backlog/tasks/task-1 - Story.md"],
        tasks: [
          {
            id: "TASK-1",
            before: side(task("TASK-1", "Refined")),
            after: side(task("TASK-1", "Refined")),
          },
        ],
      },
      { keys: { "TASK-1": K1 }, claimed: [K1], passing: {} },
    );
    expect(result.failures.map((f) => [f.rule, f.task])).toEqual([["no-claim", "TASK-1"]]);
  });
});
