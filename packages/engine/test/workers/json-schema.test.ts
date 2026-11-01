// The JSON Schema a session's `--json-schema` gets (DIPO-413): one function makes it for every
// session schema, and it carries no `$schema` dialect key, which the CLI refuses.

import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { SCAN_ANSWER_JSON_SCHEMA, ScanAnswerSchema } from "../../src/scan/answer";
import { toJsonSchema } from "../../src/workers/json-schema";
import {
  REPORT_JSON_SCHEMAS,
  REVIEW_REPORT_JSON_SCHEMA,
  ReviewReportSchema,
  WORKER_REPORT_JSON_SCHEMA,
  WorkerReportSchema,
} from "../../src/workers/claude-cli/report-schema";

describe("toJsonSchema", () => {
  it("drops the $schema dialect key zod adds, and keeps the rest", () => {
    const schema = z.strictObject({ name: z.string() });
    const { $schema: _dialect, ...rest } = zodJsonSchema(schema);
    expect(zodJsonSchema(schema)).toHaveProperty("$schema");
    expect(toJsonSchema(schema, "output")).toEqual(rest);
  });

  it("gives the scan fallback and the worker report schemas no $schema key", () => {
    expect(SCAN_ANSWER_JSON_SCHEMA).not.toHaveProperty("$schema");
    expect(WORKER_REPORT_JSON_SCHEMA).not.toHaveProperty("$schema");
    expect(REVIEW_REPORT_JSON_SCHEMA).not.toHaveProperty("$schema");
    expect(REPORT_JSON_SCHEMAS.implement).toBe(WORKER_REPORT_JSON_SCHEMA);
  });

  it("makes the scan fallback's and the worker report's schemas from the same function", () => {
    expect(SCAN_ANSWER_JSON_SCHEMA).toEqual(toJsonSchema(ScanAnswerSchema, "input"));
    expect(WORKER_REPORT_JSON_SCHEMA).toEqual(toJsonSchema(WorkerReportSchema, "output"));
    expect(REVIEW_REPORT_JSON_SCHEMA).toEqual(toJsonSchema(ReviewReportSchema, "output"));
  });
});

function zodJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: "output" }) as Record<string, unknown>;
}

describe("test plan 1", () => {
  it("the scan fallback's --json-schema carries no $schema key and comes from the same function as the worker report schema", () => {
    expect(SCAN_ANSWER_JSON_SCHEMA).not.toHaveProperty("$schema");
    expect(SCAN_ANSWER_JSON_SCHEMA).toEqual(toJsonSchema(ScanAnswerSchema, "input"));
    expect(WORKER_REPORT_JSON_SCHEMA).toEqual(toJsonSchema(WorkerReportSchema, "output"));
  });
});
