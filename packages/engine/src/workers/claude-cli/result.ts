// The run's result once `exit.json` exists (0008 sections 1 and 7). Pure. It applies only when
// no pending intent explains the exit: the engine reads `stop`, `reassign`, `cap` and `pause`
// first. The adapter reports facts and proposes a park; the engine decides.

import type { ParkReason } from "@dipsaus-orchestrator/contract";

import type { ExitRecord, WorkerOutcome, WorkerReport, WorkerResult } from "../types";
import { currentTotals, type ClaudeParseState } from "./interpret";

/** Exit code of a Claude process ended by SIGTERM (0008 "Exit and resume"). */
export const SIGTERM_EXIT_CODE = 143;

interface Decision {
  readonly outcome: WorkerOutcome;
  readonly report: WorkerReport | null;
  readonly park?: { readonly reason: ParkReason; readonly detail: string };
  readonly resumable: boolean;
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
    return { outcome: "startFailed", report: null, resumable: false };
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
    };
  }
  if (turn.subtype === "error_max_structured_output_retries") {
    return noReport("error_max_structured_output_retries");
  }
  if (turn.subtype !== "success") {
    const why =
      turn.apiErrorStatus === null
        ? turn.terminal
        : `${turn.terminal}, HTTP ${turn.apiErrorStatus}`;
    const last = state.lastError === null ? "" : `, last error ${state.lastError}`;
    return crashed(`${turn.subtype} (${why})${last}, ${exitText(exit)}`);
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

/** No valid report after a turn: one feedback turn first (engine), then `ambiguous-spec`. */
function noReport(why: string): Decision {
  return {
    outcome: "blocked",
    report: null,
    park: { reason: "ambiguous-spec", detail: `no valid report: ${why}` },
    resumable: true,
  };
}

/** Pure: the Worker result from the parse state and the exit record. */
export function result(state: ClaudeParseState, exit: ExitRecord): WorkerResult {
  const decision = decide(state, exit);
  const sessionId = state.sessionId ?? "";
  return {
    outcome: decision.outcome,
    report: decision.report,
    usage: currentTotals(state),
    sessionId,
    resumable: decision.resumable && sessionId !== "",
    ...(decision.park === undefined ? {} : { park: decision.park }),
  };
}
