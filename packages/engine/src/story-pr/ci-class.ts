// Whose fault a failed check is (DIPO-465; 0002): the code's, or GitHub's and the tool hosts'.
// Code decides from the failed job's log as `gh run view --log-failed` prints it, with no model.
// Only the failing step's error is read: the `##[error]` lines of the first step that failed and
// the last lines that step printed before them. An infrastructure failure is a download or HTTP
// 5xx error, a lost runner or a rate limit (`INFRA_PATTERNS`). A test, lint or type failure in that
// window (`CODE_PATTERNS`) is the code's whatever else it says, and so is a log that matches no
// pattern, a log that could not be read and a check that is not an Actions job: fail closed.

import { parseActionsLog } from "../prompts/feedback";

/** Whose fault a failed check is. */
export type CiFailureClass = "infra" | "code";

/** A named pattern of a failing step's error lines. */
export interface CiPattern {
  readonly name: string;
  readonly pattern: RegExp;
}

/** The errors that are GitHub's or a tool host's, not the code's. */
export const INFRA_PATTERNS: readonly CiPattern[] = [
  // `curl -f` on a 5xx answer: `curl: (22) The requested URL returned error: 504`.
  { name: "http-5xx", pattern: /\breturned error: 5\d\d\b/i },
  // Actions' tool cache and `@actions/http-client`: `Unexpected HTTP response: 504`.
  { name: "http-5xx", pattern: /\bunexpected HTTP response: 5\d\d\b/i },
  {
    name: "http-5xx",
    pattern: /\b(?:502 Bad Gateway|503 Service Unavailable|504 Gateway Time-?out)\b/i,
  },
  // curl could not reach or finish a download: resolve, connect, timeout, TLS, receive.
  { name: "download", pattern: /\bcurl: \((?:6|7|28|35|52|56)\) / },
  { name: "lost-runner", pattern: /\bThe runner has received a shutdown signal\b/i },
  { name: "lost-runner", pattern: /\blost communication with the server\b/i },
  { name: "rate-limit", pattern: /\bAPI rate limit exceeded\b/i },
  { name: "rate-limit", pattern: /\bsecondary rate limit\b/i },
  { name: "rate-limit", pattern: /\b429 Too Many Requests\b/i },
];

/** Failures of the code's own checks; any of them makes the failure the code's. */
export const CODE_PATTERNS: readonly CiPattern[] = [
  { name: "test", pattern: /^\(fail\) /m },
  // bun test's summary: ` 1 fail`.
  { name: "test", pattern: /^\s*[1-9]\d* fail$/m },
  { name: "type", pattern: /\berror TS\d+:/ },
  // oxlint's annotations (`##[error]path:line:col: ...`) and its summary.
  { name: "lint", pattern: /^##\[error\][^\s:]+:\d+:\d+: /m },
  { name: "lint", pattern: /\bFound \d+ warnings? and [1-9]\d* errors?\b/ },
];

/** How many lines before the first `##[error]` of the failing step are read. */
export const ERROR_CONTEXT_LINES = 12;
/** How many last lines are read when the log has no `##[error]` line. */
export const TAIL_LINES = 10;

const STEP_START = /^##\[group\]Run /;
const ERROR_LINE = /^##\[error\]/;
const POST_JOB = /^Post job cleanup\.$/;

/**
 * The lines the class is read from: the `##[error]` lines of the failing step and the last
 * `ERROR_CONTEXT_LINES` lines that step printed before its first one. The failing step starts at
 * the last `##[group]Run` line before the first `##[error]` and ends at the next step or the job's
 * cleanup. A log with no `##[error]` line gives its last `TAIL_LINES` lines.
 */
export function failingStepLines(log: string): string[] {
  const lines = parseActionsLog(log)
    .text.split("\n")
    .filter((line) => line.trim() !== "");
  const first = lines.findIndex((line) => ERROR_LINE.test(line));
  if (first < 0) return lines.slice(-TAIL_LINES);
  let start = first;
  while (start > 0 && !STEP_START.test(lines[start] ?? "")) start--;
  let end = first + 1;
  while (
    end < lines.length &&
    !STEP_START.test(lines[end] ?? "") &&
    !POST_JOB.test(lines[end] ?? "")
  ) {
    end++;
  }
  const before = lines.slice(Math.max(start, first - ERROR_CONTEXT_LINES), first);
  const errors = lines.slice(first, end).filter((line) => ERROR_LINE.test(line));
  return [...before, ...errors];
}

/** The first pattern of `patterns` a line of `lines` matches, or null. */
function matched(lines: readonly string[], patterns: readonly CiPattern[]): string | null {
  const text = lines.join("\n");
  return patterns.find(({ pattern }) => pattern.test(text))?.name ?? null;
}

/**
 * The class of a failed Actions job from its `--log-failed` output; null (a log that was not read,
 * or an empty one) is the code's.
 */
export function classifyJobLog(log: string | null): CiFailureClass {
  if (log === null || log.trim() === "") return "code";
  const lines = failingStepLines(log);
  if (matched(lines, CODE_PATTERNS) !== null) return "code";
  return matched(lines, INFRA_PATTERNS) === null ? "code" : "infra";
}

/**
 * The class of an aggregate check (`ci-ok`) that failed only because other jobs of its run failed:
 * infrastructure only when each of those jobs is.
 */
export function aggregateClass(jobs: readonly CiFailureClass[]): CiFailureClass {
  return jobs.length > 0 && jobs.every((job) => job === "infra") ? "infra" : "code";
}
