// The worker report as Claude returns it through `--json-schema` (0008 section 1 and option A of
// "Report channel"; fields from 0014). The zod schema parses the `structured_output` of a result;
// the JSON Schema is what the launch plan passes on argv and writes to the run directory.

import { z } from "zod";

import type { JsonSchema, WorkerReport } from "../types";

const Text = z.string().min(1);

export const WorkerReportSchema = z.strictObject({
  status: z.enum(["done", "blocked"]).describe("done when every criterion is met, else blocked"),
  criteria: z
    .array(
      z.strictObject({
        n: z.int().positive().describe("criterion number as in the story"),
        met: z.boolean(),
        evidence: z.string().describe("file, test or command output that shows it"),
      }),
    )
    .describe("one entry per acceptance criterion"),
  summary: Text.describe("what changed, in a few sentences"),
  commitSubject: Text.describe("proposed commit subject, imperative, without the story id"),
  question: Text.exactOptional().describe(
    "blocked only: the one question the maintainer must answer",
  ),
  notes: z.string().exactOptional().describe("notes for a next session"),
  needsPermission: z
    .strictObject({ tool: Text, action: Text })
    .exactOptional()
    .describe("blocked only: the denied call the work cannot do without"),
});

// Compile-time check that the parser and the contract type agree in both directions.
type Parsed = z.infer<typeof WorkerReportSchema>;
const toContract = (report: Parsed): WorkerReport => report;
const fromContract = (report: WorkerReport): Parsed => ({
  ...report,
  criteria: [...report.criteria],
});
void toContract;
void fromContract;

function buildJsonSchema(): JsonSchema {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(WorkerReportSchema, { io: "output" });
  return schema;
}

/** The JSON Schema of `WorkerReport` for `--json-schema`. */
export const WORKER_REPORT_JSON_SCHEMA: JsonSchema = buildJsonSchema();
