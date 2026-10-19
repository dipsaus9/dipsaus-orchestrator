// The run's result once `exit.json` exists (0008 sections 1 and 7). Pure. It applies only when
// no pending intent explains the exit: the engine reads `stop`, `reassign`, `cap` and `pause`
// first. The adapter reports facts and proposes a park; the engine decides.

import type { ParkReason } from "@dipsaus-orchestrator/contract";

import type {
  ExitRecord,
  ReportKind,
  ReviewReport,
  WorkerOutcome,
  WorkerReport,
  WorkerResult,
  WorkerRetry,
} from "../types";
import { currentTotals, type ClaudeParseState } from "./interpret";

/** Exit code of a Claude process ended by SIGTERM (0008 "Exit and resume"). */
export const SIGTERM_EXIT_CODE = 143;

interface Decision {
  readonly outcome: WorkerOutcome;
  readonly report: WorkerReport | null;
  readonly review?: ReviewReport;
  readonly park?: { readonly reason: ParkReason; readonly detail: string };
  readonly resumable: boolean;
  readonly retry?: WorkerRetry;
  readonly detail?: string;
}

function exitText(exit: ExitRecord): string {
  return exit.signal !== null ? `signal ${exit.signal}` : `exit ${exit.code ?? "unknown"}`;
}

function crashed(detail: string): Decision {
  // One resume if budget remains and `canResume` holds is the engine's call; the proposal is
  // the park that follows when it does not.
  return {
    outcome: "crashed",
    report: null,
    park: { reason: "worker-failed", detail },
    resumable: true,
  };
}

function decide(state: ClaudeParseState, exit: ExitRecord): Decision {
  const turn = state.lastTurn;

  if (state.initRejected !== null) {
    return {
      outcome: "initRejected",
      report: null,
      park: { reason: "worker-failed", detail: state.initRejected },
      resumable: false,
    };
  }
  // The story stays Ready: a start failure is never a park.
  if (state.startFailure !== null)
    return { outcome: "startFailed", report: null, resumable: false, detail: state.startFailure };
  // Plan limits wait for the reset; never a park.
  if (state.planLimit !== null) return { outcome: "plan-limit", report: null, resumable: true };
  if (state.capped !== null) {
    return {
      outcome: "capped",
      report: turn?.report ?? null,
      park: { reason: "budget-exceeded", detail: state.capped },
      resumable: true,
    };
  }
  if (exit.signal !== null || exit.code === SIGTERM_EXIT_CODE) {
    return crashed(`${exitText(exit)} with no intent recorded`);
  }
  if (state.truncated || state.pending !== "") {
    return crashed(`stream ended in a partial line, ${exitText(exit)}`);
  }
  if (turn === null) return crashed(`no result before ${exitText(exit)}`);

  if (turn.terminal === "prompt_too_long") {
    // 0008 section 7: one new session with a 0014 handoff, then `budget-exceeded`.
    return {
      outcome: "capped",
      report: null,
      park: { reason: "budget-exceeded", detail: "prompt_too_long: the context is full" },
      resumable: false,
      retry: "handoff",
    };
  }
  if (turn.subtype === "error_max_structured_output_retries") {
    return noReport("error_max_structured_output_retries", state.reportKind);
  }
  if (turn.subtype !== "success") {
    const why =
      turn.apiErrorStatus === null
        ? turn.terminal
        : `${turn.terminal}, HTTP ${turn.apiErrorStatus}`;
    const last = state.lastError === null ? "" : `, last error ${state.lastError}`;
    return crashed(`${turn.subtype} (${why})${last}, ${exitText(exit)}`);
  }

  if (state.reportKind === "review") {
    // A reviewer session (0019 sections 4 and 5): a valid report is all it returns; code computes
    // the verdict from it.
    const review = turn.review;
    if (review === undefined) return noReport(turn.reportProblem ?? "no report", "review");
    return exit.code === 0
      ? { outcome: "done", report: null, review, resumable: false }
      : { ...crashed(`review report but ${exitText(exit)}`), review };
  }
  const report = turn.report;
  if (report === null) return noReport(turn.reportProblem ?? "no report");
  if (report.status === "done") {
    return exit.code === 0
      ? { outcome: "done", report, resumable: true }
      : { ...crashed(`done report but ${exitText(exit)}`), report };
  }
  if (report.needsPermission !== undefined) {
    const { tool, action } = report.needsPermission;
    return {
      outcome: "blocked",
      report,
      park: { reason: "needs-permission", detail: `${tool}: ${action}` },
      resumable: true,
    };
  }
  return {
    outcome: "blocked",
    report,
    park: { reason: "ambiguous-spec", detail: report.question ?? report.summary },
    resumable: true,
  };
}

/**
 * No valid report after a turn: one feedback turn first (engine), then `ambiguous-spec`. A
 * reviewer's is handled as a crash after that turn (0019 section 4): `worker-failed`.
 */
function noReport(why: string, kind?: ReportKind): Decision {
  if (kind === "review") {
    return {
      outcome: "blocked",
      report: null,
      park: { reason: "worker-failed", detail: `no valid review report: ${why}` },
      resumable: false,
      retry: "report-feedback",
    };
  }
  return {
    outcome: "blocked",
    report: null,
    park: { reason: "ambiguous-spec", detail: `no valid report: ${why}` },
    resumable: true,
    retry: "report-feedback",
  };
}

/**
 * The exit the decision reads (DIPO-88): a signal the host inferred counts only with exit 143,
 * the code Claude ends with on SIGTERM; with any other code the exit reads as that code alone,
 * so the outcome is the one it was before the host inferred signals.
 */
function decidingExit(exit: ExitRecord): ExitRecord {
  if (exit.signalInferred !== true || exit.code === SIGTERM_EXIT_CODE) return exit;
  return { code: exit.code, signal: null };
}

/** Pure: the Worker result from the parse state and the exit record. */
export function result(state: ClaudeParseState, exit: ExitRecord): WorkerResult {
  const decision = decide(state, decidingExit(exit));
  const sessionId = state.sessionId ?? "";
  return {
    outcome: decision.outcome,
    report: decision.report,
    ...(decision.review === undefined ? {} : { review: decision.review }),
    usage: currentTotals(state),
    sessionId,
    // The reviewer never resumes (0008 section 8): a failed review starts a fresh session.
    resumable: decision.resumable && sessionId !== "" && state.reportKind !== "review",
    ...(decision.park === undefined ? {} : { park: decision.park }),
    ...(decision.retry === undefined ? {} : { retry: decision.retry }),
    ...(decision.detail === undefined ? {} : { detail: decision.detail }),
  };
}
