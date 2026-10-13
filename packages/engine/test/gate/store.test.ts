// Stored Ready gate decisions (DIPO-71): the content hash covers the story fields the gate reads
// and not free context, every rule result is stored with the hash, and the latest passing decision
// for a hash is found.

import { describe, expect, it } from "bun:test";

import { StoryId } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import type { OfficeHandle } from "../../src/db/office";
import {
  evaluateGate,
  findPassingDecision,
  gateContentHash,
  gateDecisionsOf,
  type GateMode,
  isStoryNotFound,
  parseMilestones,
  ruleNamesFor,
  ruleResults,
  rulesFor,
  storeGateDecision,
} from "../../src/gate";
import { BacklogCommandError } from "../../src/backlog/runner";
import { addStory, type StoryIdentity } from "../../src/stories/keys";
import { readManifest } from "../backlog/helpers";
import { addOffice, countRows, openTestState, type TestState } from "../commands/helpers";
import { ACTIVE_TASKS, BRANCH, description, input, PASSING_BLOCK, PASSING_STORY } from "./fixtures";

describe("gate content hash", () => {
  const base = gateContentHash(PASSING_STORY);

  it("changes when a criterion changes", () => {
    const [first, second] = PASSING_STORY.acceptanceCriteria;
    if (first === undefined || second === undefined) throw new Error("fixture has two criteria");
    const reworded = { ...first, text: `${first.text}, quoted` };
    expect(gateContentHash({ ...PASSING_STORY, acceptanceCriteria: [reworded, second] })).not.toBe(
      base,
    );
    expect(
      gateContentHash({
        ...PASSING_STORY,
        acceptanceCriteria: [{ ...first, checked: true }, second],
      }),
    ).not.toBe(base);
    expect(gateContentHash({ ...PASSING_STORY, acceptanceCriteria: [first] })).not.toBe(base);
  });

  it("stays equal when only free context in the description changes", () => {
    const edited = PASSING_STORY.description.replace(
      "Context: the export runs nightly.",
      "Context: the export runs nightly, after the backup.\n\nSee the ops notes.",
    );
    expect(edited).not.toBe(PASSING_STORY.description);
    expect(gateContentHash({ ...PASSING_STORY, description: edited })).toBe(base);
  });

  it("stays equal when only the status changes, so a Ready story matches its Refined decision", () => {
    expect(gateContentHash({ ...PASSING_STORY, status: "Ready" })).toBe(base);
  });

  it("changes with the outcome, the field block and the other gate fields", () => {
    const variants = [
      { description: description(PASSING_BLOCK, "Outcome: the export writes rows as TSV too.") },
      { description: description(PASSING_BLOCK.replace("A comma.", "A semicolon.")) },
      { description: description("```dipo\nbranch: [\n```") },
      { title: "Export rows to TSV" },
      { type: "bug" },
      { milestone: "m-1" },
      { labels: ["tier:L"] },
      { references: ["packages/export/"] },
      { documentation: [] },
      { dependencies: ["DIPO-3"] },
      { subtasks: ["DIPO-7.1"] },
      { implementationPlan: "Write a new iterator." },
    ];
    const hashes = variants.map((change) => gateContentHash({ ...PASSING_STORY, ...change }));
    for (const hash of hashes) expect(hash).not.toBe(base);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("is a sha256 hex digest and ignores label order", () => {
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    const two = { ...PASSING_STORY, labels: ["tier:M", "role:developer"] };
    expect(gateContentHash(two)).toBe(
      gateContentHash({ ...two, labels: ["role:developer", "tier:M"] }),
    );
  });
});

describe("rule results", () => {
  for (const mode of ["ready", "pickup"] as const) {
    it(`names one rule per check of ${mode} mode`, () => {
      expect(ruleNamesFor(mode)).toHaveLength(rulesFor(mode).length);
      expect(ruleNamesFor(mode)[0]).toBe(mode === "ready" ? "R01a" : "R01b");
    });
  }

  it("lists every rule with its failures, passed or not", () => {
    const result = evaluateGate(input({ references: [], milestone: "m-9" }), "pickup");
    const results = ruleResults(result);
    expect(results.map((r) => r.rule)).toEqual(ruleNamesFor("pickup"));
    const failed = results.filter((r) => !r.passed);
    expect(failed.map((r) => r.rule)).toEqual(["R01b", "R07", "R11"]);
    expect(failed.flatMap((r) => r.messages)).toEqual(result.failures.map((f) => f.message));
    expect(results.filter((r) => r.passed).every((r) => r.messages.length === 0)).toBe(true);
  });
});

function failure(stderr: string, stdout = ""): BacklogCommandError {
  return new BacklogCommandError(["backlog", "task", "view"], 1, stdout, stderr, "exited 1");
}

/** The stderr Backlog.md 1.53.0 printed for an unknown id, recorded by `record-plain.ts`. */
function recordedStderr(name: string): string {
  const recording = readManifest().recordings.find((r) => r.name === name);
  if (recording === undefined) throw new Error(`no recording ${name}`);
  return recording.stderr;
}

describe("isStoryNotFound", () => {
  it("matches the recorded 1.53 not-found lines for that very id", () => {
    expect(isStoryNotFound(failure(recordedStderr("task-view-unknown")), "TASK-99")).toBe(true);
    expect(isStoryNotFound(failure(recordedStderr("draft-view-unknown")), "DRAFT-99")).toBe(true);
    expect(isStoryNotFound(failure(recordedStderr("task-view-unknown")), "TASK-9")).toBe(false);
  });

  it("does not match other failures that say `not found`", () => {
    for (const stderr of [
      "sh: backlog: command not found",
      "env: bun: No such file or directory\nnot found",
      "Error: config file not found",
    ]) {
      expect(isStoryNotFound(failure(stderr), "TASK-99")).toBe(false);
    }
    expect(isStoryNotFound(failure("", "Task TASK-99 not found."), "TASK-99")).toBe(false);
  });
});

describe("parseMilestones", () => {
  it("reads ids and names of active and completed milestones", () => {
    const output = [
      "Active milestones (2):",
      "  m-0: M0 Walking skeleton (45/76 done)",
      "  m-1: M1: Review and park (0/0 done)",
      "",
      "Completed milestones (1):",
      "  m-9: Old (3/3 done)",
      "",
    ].join("\n");
    expect(parseMilestones(output)).toEqual([
      "m-0",
      "M0 Walking skeleton",
      "m-1",
      "M1: Review and park",
      "m-9",
      "Old",
    ]);
  });

  it("reads none from an empty list", () => {
    const output = "Active milestones (0):\n  (none)\n\nCompleted milestones (0):\n  (none)\n";
    expect(parseMilestones(output)).toEqual([]);
  });
});

function withStory(
  fn: (t: TestState, office: OfficeHandle, story: StoryIdentity) => void,
): Promise<void> {
  return withTempDir(async (dir) => {
    const t = await openTestState(dir);
    try {
      const office = addOffice(t);
      const story = office.immediate(() =>
        addStory(office, t.ids, { story: StoryId.parse("DIPO-7") }, t.clock.now()),
      );
      fn(t, office, story);
    } finally {
      t.state.close();
    }
  });
}

function store(
  t: TestState,
  office: OfficeHandle,
  story: StoryIdentity,
  mode: GateMode,
  changes: Parameters<typeof input>[0] = {},
  rest: Parameters<typeof input>[1] = {},
) {
  const gateInput = input({ status: mode === "ready" ? "Refined" : "Ready", ...changes }, rest);
  return office.immediate(() =>
    storeGateDecision(office, t.ids, {
      key: story.key,
      result: evaluateGate(gateInput, mode),
      contentHash: gateContentHash(gateInput.story),
      at: t.clock.now(),
    }),
  );
}

describe("stored decisions", () => {
  it("stores one gate and one decision with the mode, every rule result and the hash", () =>
    withStory((t, office, story) => {
      const record = store(t, office, story, "pickup", { references: [] });
      expect(countRows(office, "gates")).toBe(1);
      expect(countRows(office, "gate_decisions")).toBe(1);
      const row = office.get<Record<string, unknown>>(
        `select g.kind, g.key, g.waiting_on, g.summary, d.decision, d.decided_by, d.rule_results,
                d.content_hash, d.decided_at
           from gates g join gate_decisions d using (office_id, gate_id)
          where g.office_id = $office_id`,
      );
      expect(row).toMatchObject({
        kind: "pickup",
        key: story.key,
        waiting_on: null,
        summary: "1 failure",
        decision: "rejected",
        decided_by: "rule",
        content_hash: gateContentHash(input({ status: "Ready", references: [] }).story),
        decided_at: t.clock.now(),
      });
      const stored = JSON.parse(String(row?.["rule_results"])) as { rule: string }[];
      expect(stored.map((r) => r.rule)).toEqual(ruleNamesFor("pickup"));
      expect(stored).toEqual(record.ruleResults as never);
      expect(gateDecisionsOf(office, story.key)).toEqual([record]);
    }));

  it("finds the latest passing decision for the hash, or none", () =>
    withStory((t, office, story) => {
      const hash = gateContentHash(input({ status: "Ready" }).story);
      expect(findPassingDecision(office, story.key, hash)).toBeUndefined();

      const failing = store(t, office, story, "pickup", { milestone: "m-9" });
      expect(failing.passed).toBe(false);
      expect(findPassingDecision(office, story.key, failing.contentHash)).toBeUndefined();

      const first = store(t, office, story, "ready");
      expect(first.passed).toBe(true);
      expect(first.contentHash).toBe(hash);
      t.clock.advance(1000);
      const second = store(t, office, story, "pickup");
      expect(second.passed).toBe(true);
      expect(findPassingDecision(office, story.key, hash)).toEqual(second);

      // A later failure under the same hash (another task took the branch, R19) is stored too,
      // and the passing decision for the hash is still found.
      t.clock.advance(1000);
      const taken = store(
        t,
        office,
        story,
        "pickup",
        {},
        {
          activeTasks: [...ACTIVE_TASKS, { id: "DIPO-9", dependencies: [], branch: BRANCH }],
        },
      );
      expect(taken.passed).toBe(false);
      expect(taken.contentHash).toBe(hash);
      expect(gateDecisionsOf(office, story.key).map((d) => d.gate)).toEqual([
        failing.gate,
        first.gate,
        second.gate,
        taken.gate,
      ]);
      expect(findPassingDecision(office, story.key, hash)).toEqual(second);
      expect(findPassingDecision(office, story.key, "0".repeat(64))).toBeUndefined();
    }));
});
