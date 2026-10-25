import { describe, expect, it } from "bun:test";

import {
  parseWorkerReport,
  WORKER_REPORT_CAPS,
  WORKER_REPORT_JSON_SCHEMA,
  WorkerReportSchema,
} from "../../src/workers/claude-cli/report-schema";
import type { WorkerReport } from "../../src/workers/types";

const done: WorkerReport = {
  status: "done",
  criteria: [{ n: 1, met: true, evidence: "bun test packages/cli passes" }],
  summary: "The CLI prints hello.",
  commitSubject: "print a greeting",
};

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

  it("exports a JSON Schema without a dialect line that requires the core fields", () => {
    expect(WORKER_REPORT_JSON_SCHEMA).not.toHaveProperty("$schema");
    expect(WORKER_REPORT_JSON_SCHEMA["required"]).toEqual([
      "status",
      "criteria",
      "summary",
      "commitSubject",
    ]);
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
    outcome: "The parser is two modules.",
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
      proposals: [proposal, { ...proposal, kind: "spike", title: "Ask", paths: ["src/a.ts"] }],
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

  it("takes three proposals and refuses a fourth, with caps on title, outcome and why", () => {
    expect(ok({ ...done, proposals: [proposal, proposal, proposal] })).toBe(true);
    expect(ok({ ...done, proposals: [proposal, proposal, proposal, proposal] })).toBe(false);
    expect(ok({ ...done, status: "blocked", proposals: [proposal] })).toBe(true);
    for (const [field, cap] of [
      ["title", WORKER_REPORT_CAPS.proposalTitle],
      ["outcome", WORKER_REPORT_CAPS.proposalOutcome],
      ["why", WORKER_REPORT_CAPS.proposalWhy],
    ] as const) {
      expect(ok({ ...done, proposals: [{ ...proposal, [field]: "p".repeat(cap) }] })).toBe(true);
      expect(ok({ ...done, proposals: [{ ...proposal, [field]: "p".repeat(cap + 1) }] })).toBe(
        false,
      );
    }
    expect(ok({ ...done, proposals: [{ ...proposal, kind: "chore" }] })).toBe(false);
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
