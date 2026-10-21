// The worker report as Claude returns it through `--json-schema` (0008 section 1 and option A of
// "Report channel"; fields from 0014). The zod schema parses the `structured_output` of a result;
// the JSON Schema is what the launch plan passes on argv and writes to the run directory. Each
// report kind has its own (0008 amendment of 2026-10-16): `WorkerReport` for `implement`,
// `ReviewReport` for `review` (0019 section 5).
//
// The worker report is the door of the messages story done, question, blocked and proposal (0021
// section 7, W2 to W5; DIPO-272): `parseWorkerReport` holds it to `WORKER_REPORT_MAX_CHARS`, cleans
// every string of terminal control and other unsafe characters (`cleanDoorText`) and then parses
// it strictly, every text field with its length cap. dipo reads the report as data only.

import { z } from "zod";

import { cleanDoorStrings } from "../../box/door";
import {
  REVIEW_SUMMARY_MAX,
  type JsonSchema,
  type ReportKind,
  type ReviewReport,
  type WorkerReport,
} from "../types";

const Text = z.string().min(1);

/** The largest worker report, as JSON characters, before any field is read. */
export const WORKER_REPORT_MAX_CHARS = 64_000;

/** The length caps of the worker report's text fields (characters). */
export const WORKER_REPORT_CAPS = {
  criteria: 50,
  evidence: 2_000,
  summary: 4_000,
  commitSubject: 200,
  question: 2_000,
  notes: 8_000,
  permission: 2_000,
  proposals: 3,
  proposalTitle: 120,
  proposalOutcome: 500,
  proposalWhy: 1_000,
  proposalPaths: 20,
  path: 300,
} as const;

const caps = WORKER_REPORT_CAPS;

/** A proposal (0021 W5): a follow-up story, a spike, or a tool the box lacks. Data only. */
export const WorkerProposalSchema = z.strictObject({
  kind: z
    .enum(["follow-up", "spike", "tool"])
    .describe("follow-up: a story; spike: a question to research; tool: a tool the box lacks"),
  title: Text.max(caps.proposalTitle).describe("a short title"),
  outcome: Text.max(caps.proposalOutcome).describe("what would be true when it is done"),
  why: Text.max(caps.proposalWhy).describe("why it is needed, and what you saw"),
  paths: z
    .array(Text.max(caps.path))
    .max(caps.proposalPaths)
    .exactOptional()
    .describe("files it concerns, relative to the repository root"),
});

export const WorkerReportSchema = z.strictObject({
  status: z.enum(["done", "blocked"]).describe("done when every criterion is met, else blocked"),
  criteria: z
    .array(
      z.strictObject({
        n: z.int().positive().describe("criterion number as in the story"),
        met: z.boolean(),
        evidence: z
          .string()
          .max(caps.evidence)
          .describe("file, test or command output that shows it"),
      }),
    )
    .max(caps.criteria)
    .describe("one entry per acceptance criterion"),
  summary: Text.max(caps.summary).describe(
    "what changed, in a few sentences; when blocked without a question, the reason",
  ),
  commitSubject: Text.max(caps.commitSubject).describe(
    "proposed commit subject, imperative, without the story id",
  ),
  question: Text.max(caps.question)
    .exactOptional()
    .describe("blocked only: the one question the maintainer must answer"),
  notes: z.string().max(caps.notes).exactOptional().describe("notes for a next session"),
  needsPermission: z
    .strictObject({ tool: Text.max(caps.permission), action: Text.max(caps.permission) })
    .exactOptional()
    .describe("blocked only: the denied call the work cannot do without"),
  proposals: z
    .array(WorkerProposalSchema)
    .max(caps.proposals)
    .exactOptional()
    .describe(
      "follow-ups, spikes or tools for the maintainer to decide on; nothing happens on its own",
    ),
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
const fromContract = (report: WorkerReport): Parsed => {
  const { proposals, ...rest } = report;
  return {
    ...rest,
    criteria: [...report.criteria],
    ...(proposals === undefined
      ? {}
      : {
          proposals: proposals.map(({ paths, ...proposal }) => ({
            ...proposal,
            ...(paths === undefined ? {} : { paths: [...paths] }),
          })),
        }),
  };
};
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

/** A worker report, or why the output is not one. */
export type WorkerReportRead =
  | { readonly ok: true; readonly report: WorkerReport }
  | { readonly ok: false; readonly error: string };

/**
 * Pure: a result's `structured_output` as a worker report (the door of W2 to W5): at most
 * `WORKER_REPORT_MAX_CHARS` as JSON, every string cleaned with `cleanDoorText`, then the strict
 * schema with its length caps, so an empty text after cleaning fails too.
 */
export function parseWorkerReport(output: unknown): WorkerReportRead {
  if (output === undefined || output === null) return { ok: false, error: "no structured_output" };
  let size: number;
  try {
    size = JSON.stringify(output).length;
  } catch {
    return { ok: false, error: "structured_output is not JSON" };
  }
  if (size > WORKER_REPORT_MAX_CHARS) {
    return {
      ok: false,
      error: `structured_output has ${size} characters; at most ${WORKER_REPORT_MAX_CHARS} are allowed`,
    };
  }
  // The error names no field or key: an unknown key is the worker's text, and this one goes into
  // a park detail and the report feedback.
  const parsed = WorkerReportSchema.safeParse(cleanDoorStrings(output));
  if (!parsed.success) return { ok: false, error: "structured_output fails the report schema" };
  return { ok: true, report: parsed.data };
}

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
