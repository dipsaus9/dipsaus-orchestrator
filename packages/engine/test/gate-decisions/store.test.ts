// Stored Ready gate decisions (DIPO-71): the content hash covers the story fields the gate reads
// and not free context, every rule result is stored with the hash, and the latest passing decision
// for a hash is found. The base tree's file paths R29 reads are listed once per base commit and
// passed in the gate input (DIPO-251).

import { describe, expect, it } from "bun:test";

import { OfficeId, StoryId } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { parseView } from "../../src/backlog/plain";
import type { OfficeHandle } from "../../src/db/office";
import type { GitSession } from "../../src/git/office";
import {
  evaluateGate,
  gateContentHash,
  type GateMode,
  rulesFor,
  WARNING_RULES,
} from "../../src/gate";
import {
  BaseTreeCache,
  findPassingDecision,
  gateDecisionsOf,
  listTreeFiles,
  ruleNamesFor,
  ruleResults,
  storeGateDecision,
  treePaths,
} from "../../src/gate-decisions";
import { isStoryNotFound, parseMilestones } from "../../src/backlog";
import { gateInputOf } from "../../src/gate-decisions/read";
import { BacklogCommandError } from "../../src/backlog/runner";
import { addStory, type StoryIdentity } from "../../src/stories/keys";
import { readManifest, recorded } from "../backlog/helpers";
import { addOffice, countRows, openTestState, type TestState } from "../commands/helpers";
import {
  ACTIVE_TASKS,
  BRANCH,
  DEFAULT_CONFIG,
  description,
  input,
  PASSING_BLOCK,
  PASSING_STORY,
} from "../gate/fixtures";

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
      // R29 only warns, so it is named but not among the rules that fail (DIPO-251).
      expect(ruleNamesFor(mode)).toHaveLength(rulesFor(mode).length + WARNING_RULES.length);
      expect(ruleNamesFor(mode)[0]).toBe(mode === "ready" ? "R01a" : "R01b");
    });
  }

  it("stores an R29 warning on a passed R29 result and keeps the decision approved (DIPO-251)", () =>
    withStory((t, office, story) => {
      const plan = description(
        [
          "```dipo",
          `branch: "${BRANCH}"`,
          "unknowns: []",
          "test_plan:",
          "  entries:",
          '    - kind: "automated"',
          '      check: "(unit) packages/daemon/x.test.ts runs"',
          "```",
        ].join("\n"),
      );
      const decision = store(t, office, story, "pickup", { description: plan });
      expect(decision.passed).toBe(true);
      const r29 = decision.ruleResults.find((result) => result.rule === "R29");
      expect(r29).toEqual({
        rule: "R29",
        passed: true,
        messages: [],
        warnings: [
          "ready DIPO-7 warning R29: test plan entry #1 names packages/daemon/x.test.ts, which no Reference covers; add it to the References or drop it from the plan",
        ],
      });
      expect(gateDecisionsOf(office, story.key)[0]?.ruleResults).toEqual(decision.ruleResults);
      expect(
        ruleResults(evaluateGate(input(), "ready")).some((result) => "warnings" in result),
      ).toBe(false);
    }));

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

/** A git session that answers every `ok` step with `listing` and records the steps it ran. */
function treeSession(listing: string): { session: GitSession; steps: string[][] } {
  const steps: string[][] = [];
  const session = {
    repository: { kind: "repository", commonDir: "/x/.git" },
    step: async () => ({ code: 0, stdout: listing, stderr: "" }),
    ok: async (_location: unknown, args: readonly string[]) => {
      steps.push([...args]);
      return listing;
    },
  } as unknown as GitSession;
  return { session, steps };
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const LISTING = "packages/engine/test/workers/plan.test.ts\0docs/a b.md\0README.md\0";

describe("the base tree's file paths (R29, DIPO-251)", () => {
  it("are read from git's objects at the base commit, with the NUL-separated names as listed", async () => {
    const { session, steps } = treeSession(LISTING);
    expect(await listTreeFiles(session, SHA_A)).toEqual([
      "packages/engine/test/workers/plan.test.ts",
      "docs/a b.md",
      "README.md",
    ]);
    expect(steps).toEqual([["ls-tree", "-r", "-z", "--name-only", "--full-tree", SHA_A]]);
    expect(treePaths("")).toEqual([]);
  });

  it("are listed once per office and base commit, and again when the base moves", async () => {
    const cache = new BaseTreeCache();
    const office = OfficeId.parse("off_01J00000000000000000000000");
    const other = OfficeId.parse("off_01J00000000000000000000001");
    const { session, steps } = treeSession(LISTING);
    const list = (commit: string) => listTreeFiles(session, commit);
    const first = await cache.filesAt(office, SHA_A, list);
    expect(await cache.filesAt(office, SHA_A, list)).toBe(first);
    expect(steps).toHaveLength(1);
    // Without a session to list with, only the list of that very commit is known.
    expect(await cache.filesAt(office, SHA_A)).toBe(first);
    expect(await cache.filesAt(office, SHA_B)).toBeUndefined();
    await cache.filesAt(office, SHA_B, list);
    expect(steps.map((step) => step.at(-1))).toEqual([SHA_A, SHA_B]);
    await cache.filesAt(other, SHA_B, list);
    expect(steps).toHaveLength(3);
    expect(await cache.filesAt(office, SHA_A)).toBeUndefined();
  });

  it("are passed in the gate input, where R29 reads them, and leave the content hash alone", () => {
    const FOLDERS = ["backlog"];
    const view = parseView(recorded("task-view-full"));
    const files = ["packages/engine/test/workers/plan.test.ts"];
    const withFiles = gateInputOf(view, [], ["m-0"], FOLDERS, DEFAULT_CONFIG, files);
    expect(withFiles.baseFiles).toEqual(files);
    expect(gateInputOf(view, [], ["m-0"], FOLDERS, DEFAULT_CONFIG)).not.toHaveProperty("baseFiles");
    expect(gateContentHash(withFiles.story)).toBe(
      gateContentHash(gateInputOf(view, [], ["m-0"], FOLDERS, DEFAULT_CONFIG).story),
    );

    const plan = description(
      [
        "```dipo",
        `branch: "${BRANCH}"`,
        "unknowns: []",
        "test_plan:",
        "  entries:",
        '    - kind: "automated"',
        '      check: "(unit) plan.test.ts keeps the order"',
        "```",
      ].join("\n"),
    );
    const story = { description: plan, references: ["packages/engine/test/workers/"] };
    const r29 = (baseFiles?: readonly string[]) =>
      (
        evaluateGate(input(story, baseFiles === undefined ? {} : { baseFiles }), "ready")
          .warnings ?? []
      ).map((found) => found.rule);
    expect(r29(files)).toEqual([]);
    expect(r29()).toEqual(["R29"]);
  });
});
