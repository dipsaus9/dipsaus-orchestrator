import { describe, expect, it } from "bun:test";

import {
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
  it("parses a done report and a blocked one with a permission need", () => {
    expect<WorkerReport>(WorkerReportSchema.parse(done)).toEqual(done);
    const blocked: WorkerReport = {
      ...done,
      status: "blocked",
      needsPermission: { tool: "Bash", action: "curl https://registry.npmjs.org" },
    };
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
