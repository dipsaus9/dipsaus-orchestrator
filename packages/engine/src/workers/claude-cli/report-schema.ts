// The worker report as Claude returns it through `--json-schema` (0008 section 1 and option A of
// "Report channel"; fields from 0014). The zod schema parses the `structured_output` of a result;
// the JSON Schema is what the launch plan passes on argv and writes to the run directory. Each
// report kind has its own (0008 amendment of 2026-10-16): `WorkerReport` for `implement`,
// `ReviewReport` for `review` (0019 section 5).

import { z } from "zod";

import {
  REVIEW_SUMMARY_MAX,
  type JsonSchema,
  type ReportKind,
  type ReviewReport,
  type WorkerReport,
} from "../types";

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

export const ReviewReportSchema = z.strictObject({
  criteria: z
    .array(
      z.strictObject({
        n: z.int().positive().describe("criterion number as in the story"),
        status: z
          .enum(["met", "unmet", "maintainer"])
          .describe("maintainer: only the maintainer can check it"),
        evidence: z
          .string()
          .describe("what in the diff or the worktree shows it; required for unmet and maintainer"),
      }),
    )
    .describe("exactly one entry per acceptance criterion"),
  findings: z
    .array(
      z.strictObject({
        severity: z.enum(["blocking", "advisory"]),
        kind: z.enum(["scope", "test", "correctness", "security", "maintainability", "other"]),
        criterion: z.int().positive().exactOptional().describe("the criterion it concerns"),
        testEntry: z
          .int()
          .positive()
          .exactOptional()
          .describe("kind test: the number of the automated test plan entry with no test"),
        file: Text.exactOptional().describe("a changed path, relative to the worktree root"),
        line: z.int().positive().exactOptional().describe("the line in that file at this commit"),
        quote: Text.exactOptional().describe("that line, exactly as it is in the file"),
        text: Text.describe("what is wrong and why"),
      }),
    )
    .describe("problems found; an empty list when there are none"),
  summary: Text.max(REVIEW_SUMMARY_MAX).describe("the review in a few sentences"),
});

// Compile-time checks that the parsers and the contract types agree in both directions.
type Parsed = z.infer<typeof WorkerReportSchema>;
const toContract = (report: Parsed): WorkerReport => report;
const fromContract = (report: WorkerReport): Parsed => ({
  ...report,
  criteria: [...report.criteria],
});
void toContract;
void fromContract;
type ParsedReview = z.infer<typeof ReviewReportSchema>;
const reviewToContract = (report: ParsedReview): ReviewReport => report;
const reviewFromContract = (report: ReviewReport): ParsedReview => ({
  ...report,
  criteria: [...report.criteria],
  findings: [...report.findings],
});
void reviewToContract;
void reviewFromContract;

function buildJsonSchema(schema: z.ZodType): JsonSchema {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { io: "output" });
  return rest;
}

/** The JSON Schema of `WorkerReport` for `--json-schema`. */
export const WORKER_REPORT_JSON_SCHEMA: JsonSchema = buildJsonSchema(WorkerReportSchema);

/** The JSON Schema of `ReviewReport` for `--json-schema` (0019 section 5). */
export const REVIEW_REPORT_JSON_SCHEMA: JsonSchema = buildJsonSchema(ReviewReportSchema);

/** The report schema of each report kind, as `WorkerPort.reportSchema` hands it out. */
export const REPORT_JSON_SCHEMAS: Readonly<Record<ReportKind, JsonSchema>> = {
  implement: WORKER_REPORT_JSON_SCHEMA,
  review: REVIEW_REPORT_JSON_SCHEMA,
};

/** A review report, or why the output is not one. */
export type ReviewReportRead =
  | { readonly ok: true; readonly report: ReviewReport }
  | { readonly ok: false; readonly error: string };

/** Pure: a result's `structured_output` as a review report, or the schema's error. */
export function parseReviewReport(output: unknown): ReviewReportRead {
  if (output === undefined || output === null) return { ok: false, error: "no structured_output" };
  const parsed = ReviewReportSchema.safeParse(output);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "report"}: ${issue.message}`)
      .join("; ");
    return { ok: false, error: `structured_output fails the review report schema: ${issues}` };
  }
  return { ok: true, report: parsed.data };
}
