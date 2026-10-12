// The `--plain` parser over output recorded from Backlog.md 1.53.0 (DIPO-28; 0010 section 1).

import { describe, expect, it } from "bun:test";

import { BacklogParseError, parseList, parseView, type UnknownItem } from "../../src/backlog/plain";
import { readManifest, recorded } from "./helpers";

const RULE = "-".repeat(50);

describe("recorded fixtures", () => {
  it("come from Backlog.md 1.53.0 and cover every case", () => {
    const manifest = readManifest();
    expect(manifest.backlog).toBe("1.53.0");
    expect(manifest.recordings.map((r) => r.name).toSorted()).toEqual([
      "draft-list",
      "draft-view",
      "draft-view-unknown",
      "task-list",
      "task-view-dependents",
      "task-view-fake-section",
      "task-view-full",
      "task-view-unknown",
    ]);
  });
});

describe("parseView", () => {
  it("reads a task with every field", () => {
    const unknown: UnknownItem[] = [];
    const task = parseView(recorded("task-view-full"), { onUnknown: (item) => unknown.push(item) });
    expect(task).toMatchObject({
      file: "/fixture/backlog/tasks/task-1.1 - Ship-the-full-export.md",
      id: "TASK-1.1",
      title: "Ship the full export",
      status: "In Progress",
      priority: "High",
      type: "feature",
      ordinal: 4000,
      assignee: ["@alice"],
      due: "2026-12-01",
      labels: ["tier:M", "role:developer", "test-before-merge"],
      milestone: "m-0",
      parent: { id: "TASK-1", title: "Add the CSV export command" },
      subtasks: [],
      references: ["packages/a/", "packages/b.ts"],
      documentation: ["docs/x.md", "https://example.com/y"],
      acceptanceCriteria: [
        { index: 1, checked: true, text: "First criterion" },
        { index: 2, checked: false, text: "Second criterion" },
      ],
      definitionOfDone: [{ index: 1, checked: false, text: "Docs updated" }],
      implementationPlan: "Step one",
      implementationNotes: "Some notes",
      modifiedFiles: ["packages/a/z.ts"],
      finalSummary: "Done summary",
    });
    expect(task.created).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(UTC\)$/);
    expect(task.updated).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(UTC\)$/);
    // The first level only: TASK-3 is TASK-2's dependency, not this task's.
    expect(task.dependencies).toEqual([
      { id: "TASK-1", state: "resolved", title: "Add the CSV export command", status: "Ready" },
      { id: "TASK-2", state: "resolved", title: "Rename the export setting", status: "Refined" },
    ]);
    expect(task.description.split("\n")[0]).toBe(
      "Outcome: the full export ships with every field set.",
    );
    expect(task.description).toContain("```dipo\n");
    expect(task.description.endsWith("```")).toBe(true);
    expect(task.comments).toHaveLength(1);
    expect(task.comments[0]).toMatchObject({ index: 1, body: "A comment here" });
    expect(task.comments[0]?.byline).toStartWith("@bob - ");
    expect(task.unknown).toEqual([]);
    expect(unknown).toEqual([]);
  });

  it("reads subtasks and ignores the dependents graph", () => {
    const task = parseView(recorded("task-view-dependents"));
    expect(task.id).toBe("TASK-1");
    expect(task.status).toBe("Ready");
    expect(task.subtasks).toEqual([{ id: "TASK-1.1", title: "Ship the full export" }]);
    expect(task.dependencies).toEqual([]);
    expect(task.labels).toEqual(["tier:S"]);
    expect(task.acceptanceCriteria.map((c) => c.text)).toEqual([
      "The export command writes one CSV row per story",
      "A header row names every column",
    ]);
    expect(task.definitionOfDone).toEqual([]);
    expect(task.implementationPlan).toBeUndefined();
    expect(task.unknown).toEqual([]);
  });

  it("reads a draft", () => {
    const draft = parseView(recorded("draft-view"));
    expect(draft).toMatchObject({
      id: "DRAFT-1",
      title: "Sketch the export format",
      status: "Draft",
      labels: [],
      dependencies: [],
      acceptanceCriteria: [],
      definitionOfDone: [],
      modifiedFiles: [],
      comments: [],
      description:
        "Outcome: maintainers can export a story list as CSV.\n\nA rough idea, not refined yet.",
    });
    expect(draft.file).toEndWith("/backlog/drafts/draft-1 - Sketch-the-export-format.md");
  });

  it("refuses a fake section inside a description as R02", () => {
    let error: unknown;
    try {
      parseView(recorded("task-view-fake-section"));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(BacklogParseError);
    expect((error as BacklogParseError).rule).toBe("R02");
    expect((error as BacklogParseError).message).toContain(
      "section `Acceptance Criteria` appears twice",
    );
  });

  it("refuses a known section out of order as R02", () => {
    const text = recorded("draft-view").replace(
      `Description:\n${RULE}`,
      `Final Summary:\n${RULE}\nEarly\n\nDescription:\n${RULE}`,
    );
    expect(() => parseView(text)).toThrow("section `Description` is out of order");
  });

  it("requires File: on line 1 and the task line on line 2", () => {
    const text = recorded("draft-view");
    expect(() => parseView(text.slice(text.indexOf("\n") + 1))).toThrow("line 1 is not `File:`");
    expect(() => parseView(text.replace("Task DRAFT-1 - ", "Draft DRAFT-1 - "))).toThrow(
      "line 2 is not `Task <ID> - <title>`",
    );
    // An empty output, as for an unknown id.
    expect(() => parseView(recorded("task-view-unknown"))).toThrow(BacklogParseError);
  });

  it("keeps unknown keys, sections and lines raw and reports them", () => {
    const seen: UnknownItem[] = [];
    const text = recorded("draft-view")
      .replace("Created: ", "Sprint: 4\nCreated: ")
      .replace(
        "A rough idea, not refined yet.",
        `A rough idea, not refined yet.\n\nNotes Of Old:\n${RULE}\nkept in the text`,
      );
    const draft = parseView(text, { onUnknown: (item) => seen.push(item) });
    expect(seen).toEqual([
      { kind: "header", line: 7, key: "Sprint", value: "4" },
      { kind: "section", line: 16, name: "Notes Of Old" },
    ]);
    expect(draft.unknown).toEqual(seen);
    // An unknown name never starts a section: the text stays in the description.
    expect(draft.description).toEndWith(`Notes Of Old:\n${RULE}\nkept in the text`);
  });

  it("normalises to NFC", () => {
    const text = recorded("draft-view").replace("Sketch the", "Café sketch the");
    expect(parseView(text).title).toBe("Café sketch the export format");
  });
});

describe("parseList", () => {
  it("reads task list groups, tags, (ac: n/m) counts and due dates", () => {
    const list = parseList(recorded("task-list"));
    expect(list.unknown).toEqual([]);
    expect(list.entries).toEqual([
      {
        id: "TASK-2",
        title: "Rename the export setting",
        group: "Refined",
        ac: { checked: 0, total: 1 },
      },
      {
        id: "TASK-4",
        title: "Describe a fake section",
        group: "Refined",
        ac: { checked: 0, total: 1 },
      },
      {
        id: "TASK-1",
        title: "Add the CSV export command",
        group: "Ready",
        ac: { checked: 0, total: 2 },
      },
      {
        id: "TASK-1.1",
        title: "Ship the full export",
        group: "In Progress",
        priority: "HIGH",
        type: "feature",
        ac: { checked: 1, total: 2 },
        due: "2026-12-01",
      },
      {
        id: "TASK-3",
        title: "Export stories as JSON",
        group: "Parked",
        ac: { checked: 0, total: 1 },
      },
    ]);
  });

  it("reads the draft list", () => {
    expect(parseList(recorded("draft-list")).entries).toEqual([
      { id: "DRAFT-1", title: "Sketch the export format", group: "Drafts" },
    ]);
  });

  it("reads an empty list", () => {
    expect(parseList("No tasks found.\n").entries).toEqual([]);
    expect(parseList("No drafts found.\n").entries).toEqual([]);
  });

  it("refuses an entry outside a group and reports unknown lines", () => {
    expect(() => parseList("  TASK-1 - Loose\n")).toThrow(BacklogParseError);
    const seen: UnknownItem[] = [];
    const list = parseList("Ready:\n  not an entry\n", { onUnknown: (item) => seen.push(item) });
    expect(list.entries).toEqual([]);
    expect(seen).toEqual([{ kind: "line", line: 2, text: "  not an entry" }]);
  });
});
