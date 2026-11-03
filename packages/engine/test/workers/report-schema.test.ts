import { describe, expect, it } from "bun:test";

import {
  parseWorkerReport,
  WORKER_REPORT_CAPS,
  WORKER_REPORT_JSON_SCHEMA,
  WorkerCliReportSchema,
  WorkerReportSchema,
} from "../../src/workers/claude-cli/report-schema";
import type { WorkerReport } from "../../src/workers/types";

const done: WorkerReport = {
  status: "done",
  criteria: [{ n: 1, met: true, evidence: "bun test packages/cli passes" }],
  summary: "The CLI prints hello.",
  commitSubject: "print a greeting",
};
const cliOk = (report: unknown) => WorkerCliReportSchema.safeParse(report).success;

describe("worker report schema", () => {
  it("parses a done report and a blocked one with a question", () => {
    expect<WorkerReport>(WorkerReportSchema.parse(done)).toEqual(done);
    const blocked: WorkerReport = { ...done, status: "blocked", question: "Which registry?" };
    expect<WorkerReport>(WorkerReportSchema.parse(blocked)).toEqual(blocked);
  });

  it("refuses unknown fields and a missing summary", () => {
    expect(WorkerReportSchema.safeParse({ ...done, extra: 1 }).success).toBe(false);
    const { summary: _summary, ...partial } = done;
    expect(WorkerReportSchema.safeParse(partial).success).toBe(false);
  });

  it("exports a JSON Schema without a dialect line that requires the core fields and the test plan", () => {
    expect(WORKER_REPORT_JSON_SCHEMA).not.toHaveProperty("$schema");
    expect(WORKER_REPORT_JSON_SCHEMA["required"]).toEqual([
      "status",
      "criteria",
      "summary",
      "commitSubject",
      "testPlan",
    ]);
  });

  it("refuses a report without testPlan against the CLI schema, and takes an empty list", () => {
    expect(cliOk(done)).toBe(false);
    expect(cliOk({ ...done, testPlan: [] })).toBe(true);
    expect(cliOk({ ...done, testPlan: [{ n: 1, status: "done", evidence: "a.test.ts" }] })).toBe(
      true,
    );
    // The parser still takes a report without it (0017 recordings and scripted turns).
    expect(WorkerReportSchema.safeParse(done).success).toBe(true);
    expect(parseWorkerReport(done)).toEqual({ ok: true, report: done });
  });
});

// DIPO-186 with DIPO-254 and DIPO-259: test-plan entries, deviations, proposals and decision
// notes as data, each with its caps.
const ok = (report: unknown) => WorkerReportSchema.safeParse(report).success;
const note = {
  file: "docs/decisions/0008-worker-adapter.md",
  section: "1. The worker port",
  text: "The report gains a field.",
};

describe("the report's data fields", () => {
  const proposal = {
    kind: "follow-up",
    title: "Split the parser",
    story:
      "As maintainer I want the parser split into two modules so that each module stays small enough to read.",
    why: "It grew past one screen.",
  } as const;

  it("parses a report with every data field, and one without them as before", () => {
    const full: WorkerReport = {
      ...done,
      testPlan: [
        { n: 1, status: "done", evidence: "test/a.test.ts: greets Ada" },
        { n: 2, status: "manual", evidence: "the maintainer runs it" },
        { n: 3, status: "not-done", evidence: "needs a live box" },
      ],
      deviations: [{ where: "criterion #2", what: "exits 64", why: "the CLI's usage code" }],
      proposals: [
        proposal,
        {
          ...proposal,
          kind: "spike",
          title: "Ask",
          story:
            "We need to decide which parser design the project keeps so that the next stories build on one design.",
          paths: ["src/a.ts"],
        },
      ],
      decisionNotes: [note],
    };
    expect<WorkerReport>(WorkerReportSchema.parse(full)).toEqual(full);
    expect(parseWorkerReport(full)).toEqual({ ok: true, report: full });
    expect<WorkerReport>(WorkerReportSchema.parse(done)).toEqual(done);
  });

  it("refuses a test-plan entry with an unknown status or a missing or empty evidence, and caps the evidence", () => {
    const entry = { n: 1, status: "done", evidence: "x" };
    expect(ok({ ...done, testPlan: [entry] })).toBe(true);
    expect(ok({ ...done, testPlan: [{ ...entry, status: "skipped" }] })).toBe(false);
    expect(ok({ ...done, testPlan: [{ n: 1, status: "done" }] })).toBe(false);
    expect(ok({ ...done, testPlan: [{ ...entry, evidence: "" }] })).toBe(false);
    expect(ok({ ...done, testPlan: [{ ...entry, n: 0 }] })).toBe(false);
    const cap = WORKER_REPORT_CAPS.testEvidence;
    expect(cap).toBe(500);
    expect(ok({ ...done, testPlan: [{ ...entry, evidence: "e".repeat(cap) }] })).toBe(true);
    expect(ok({ ...done, testPlan: [{ ...entry, evidence: "e".repeat(cap + 1) }] })).toBe(false);
  });

  it("refuses a deviation with a missing part or over a cap, and an eleventh deviation", () => {
    const deviation = { where: "src/a.ts", what: "w", why: "y" };
    expect(ok({ ...done, deviations: [deviation] })).toBe(true);
    expect(ok({ ...done, deviations: [{ where: "src/a.ts", what: "w" }] })).toBe(false);
    expect(
      ok({
        ...done,
        deviations: [{ ...deviation, why: "y".repeat(WORKER_REPORT_CAPS.deviationWhy + 1) }],
      }),
    ).toBe(false);
    expect(ok({ ...done, deviations: Array.from({ length: 10 }, () => deviation) })).toBe(true);
    expect(ok({ ...done, deviations: Array.from({ length: 11 }, () => deviation) })).toBe(false);
  });

  it("takes three proposals and refuses a fourth, with caps on title, story and why", () => {
    expect(ok({ ...done, proposals: [proposal, proposal, proposal] })).toBe(true);
    expect(ok({ ...done, proposals: [proposal, proposal, proposal, proposal] })).toBe(false);
    expect(ok({ ...done, status: "blocked", proposals: [proposal] })).toBe(true);
    const head = "As maintainer I want ";
    const tail = " so that the maintainer can read it in one go.";
    const story = (length: number) =>
      `${head}${"x".repeat(length - head.length - tail.length)}${tail}`;
    expect(
      ok({ ...done, proposals: [{ ...proposal, story: story(WORKER_REPORT_CAPS.proposalStory) }] }),
    ).toBe(true);
    expect(
      ok({
        ...done,
        proposals: [{ ...proposal, story: story(WORKER_REPORT_CAPS.proposalStory + 1) }],
      }),
    ).toBe(false);
    for (const [field, cap] of [
      ["title", WORKER_REPORT_CAPS.proposalTitle],
      ["why", WORKER_REPORT_CAPS.proposalWhy],
    ] as const) {
      expect(ok({ ...done, proposals: [{ ...proposal, [field]: "p".repeat(cap) }] })).toBe(true);
      expect(ok({ ...done, proposals: [{ ...proposal, [field]: "p".repeat(cap + 1) }] })).toBe(
        false,
      );
    }
    expect(ok({ ...done, proposals: [{ ...proposal, kind: "chore" }] })).toBe(false);
  });

  it("refuses a proposal whose story line fails the Ready gate's shape, naming each problem for the worker", () => {
    const refused = (story: string, kind: "follow-up" | "spike" | "tool" = "follow-up") =>
      parseWorkerReport({ ...done, proposals: [proposal, { ...proposal, kind, story }] });
    expect(refused("The parser is two modules.")).toEqual({
      ok: false,
      error:
        'structured_output fails the report schema: proposal 2: Story line does not read "As <maintainer|worker|reviewer> I want <capability> so that <value>."',
    });
    // A spike needs the spike's shape, and a story line the story's.
    expect(refused(proposal.story, "spike")).toMatchObject({
      ok: false,
      error: expect.stringContaining('proposal 2: Story line does not read "We need to decide'),
    });
    expect(
      refused(
        "We need to decide which queue design the office uses so that the next stories build on one design.",
        "spike",
      ),
    ).toMatchObject({ ok: true });
    // Short parts, a backtick, a path and code are each named.
    expect(refused("As worker I want it short so that ok.")).toMatchObject({
      error: expect.stringContaining("capability is shorter than 20 characters"),
    });
    const words = refused(
      "As maintainer I want the `parser` in src/parse.ts split with parseAll() so that each module stays small to read.",
    );
    expect(words.ok).toBe(false);
    if (words.ok) return;
    expect(words.error).toContain("proposal 2: Story line holds a backtick");
    expect(words.error).toContain("names the path src/parse.ts");
    expect(words.error).toContain("holds code (parseAll())");
    // Other schema problems stay unnamed.
    expect(parseWorkerReport({ ...done, proposals: [{ ...proposal, kind: "chore" }] })).toEqual({
      ok: false,
      error: "structured_output fails the report schema",
    });
  });

  it("takes a decision note with file, section and text; refuses a missing part, a long one, a fourth note or a file outside the decision records", () => {
    expect(ok({ ...done, decisionNotes: [note] })).toBe(true);
    for (const part of ["file", "section", "text"] as const) {
      const { [part]: _gone, ...partial } = note;
      expect(ok({ ...done, decisionNotes: [partial] })).toBe(false);
      expect(ok({ ...done, decisionNotes: [{ ...note, [part]: "" }] })).toBe(false);
    }
    expect(
      ok({
        ...done,
        decisionNotes: [{ ...note, text: "t".repeat(WORKER_REPORT_CAPS.noteText + 1) }],
      }),
    ).toBe(false);
    expect(
      ok({
        ...done,
        decisionNotes: [{ ...note, section: "s".repeat(WORKER_REPORT_CAPS.noteSection + 1) }],
      }),
    ).toBe(false);
    expect(ok({ ...done, decisionNotes: [note, note, note] })).toBe(true);
    expect(ok({ ...done, decisionNotes: [note, note, note, note] })).toBe(false);
    for (const file of [
      "docs/plan.md",
      "docs/decisions/../plan.md",
      "docs/decisions/sub/0001.md",
      "/docs/decisions/0001.md",
      "docs/decisions/0001.txt",
    ]) {
      expect(ok({ ...done, decisionNotes: [{ ...note, file }] })).toBe(false);
    }
  });

  it("puts the new fields in the JSON Schema as optional, with their caps", () => {
    const properties = WORKER_REPORT_JSON_SCHEMA["properties"] as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties["testPlan"]?.["maxItems"]).toBe(WORKER_REPORT_CAPS.testPlan);
    expect(properties["deviations"]?.["maxItems"]).toBe(10);
    expect(properties["decisionNotes"]?.["maxItems"]).toBe(3);
    expect(properties["proposals"]?.["maxItems"]).toBe(3);
    const items = properties["decisionNotes"]?.["items"] as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
    };
    expect(items.required).toEqual(["file", "section", "text"]);
    expect(items.properties["text"]?.["maxLength"]).toBe(WORKER_REPORT_CAPS.noteText);
    expect(typeof items.properties["file"]?.["pattern"]).toBe("string");
    const entry = properties["testPlan"]?.["items"] as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(entry.properties["status"]?.["enum"]).toEqual(["done", "not-done", "manual"]);
    expect(entry.properties["evidence"]?.["maxLength"]).toBe(500);
  });
});
