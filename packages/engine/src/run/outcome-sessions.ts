// Starting the next session of a run, and the start failure that cannot (DIPO-51, split out of
// `outcomes.ts` by DIPO-128).

import type { WatchdogSignal, WorkRef } from "@dipsaus-orchestrator/contract";

import { holdMessage, type AdapterHold } from "../workers/hold";
import { findClaim, releaseClaim } from "../worktree/records";

import type { OutcomeSupport } from "./outcome-support";
import {
  INTENT_TAGS,
  messageOf,
  OUTCOME_ENDS,
  OUTCOME_NOTICES,
  type RunOutcomesDeps,
  type RunView,
} from "./outcome-types";
import { markIntentSent, recordIntent, resolveIntent } from "./intents";
import { START_FAILED_END } from "./launch";
import type { OfficeHandle } from "../db/office";
import type { StoredRun } from "./records";

export class SessionStarts {
  readonly #s: OutcomeSupport;
  readonly #deps: RunOutcomesDeps;

  constructor(support: OutcomeSupport) {
    this.#s = support;
    this.#deps = support.deps;
  }

  /** Starts the next session; a session that cannot start parks or releases the story. */
  async next(
    office: OfficeHandle,
    run: StoredRun,
    view: RunView,
    request: {
      readonly mode: "resume" | "handoff";
      readonly why: string;
      readonly message?: string;
      /** Only a resume will do; a session that cannot be resumed parks `interrupted` (DIPO-57). */
      readonly requireResume?: boolean;
      readonly clear?: readonly WatchdogSignal[];
    },
  ): Promise<boolean> {
    const resumer = this.#deps.resumer;
    if (resumer === undefined) {
      await this.#s.park(office, run, view.work, {
        intent: "park",
        ops: [],
        reason: "worker-failed",
        detail: `${request.why}; dipo cannot start another session of the run`,
        endKind: OUTCOME_ENDS.crashed,
      });
      return false;
    }
    let outcome;
    try {
      outcome = await resumer.next({
        office: view.office,
        run,
        work: view.work,
        mode: request.mode,
        why: request.why,
        ...(request.message === undefined ? {} : { message: request.message }),
        ...(request.requireResume === true ? { requireResume: true } : {}),
        ...(request.clear === undefined ? {} : { clear: request.clear }),
        caps: view.caps,
        startedAt: view.startedAt,
        snapshot: view.snapshot,
      });
    } catch (error) {
      outcome = { kind: "failed" as const, reason: messageOf(error) };
    }
    switch (outcome.kind) {
      case "started":
        return true;
      case "startFailed":
        await this.startFailed(office, run, view.work, holdMessage(outcome.hold), outcome.hold);
        return false;
      case "failed":
        await this.#s.park(office, run, view.work, {
          intent: "park",
          ops: [],
          reason: "worker-failed",
          detail: `${request.why}; the next session did not start: ${outcome.reason}`,
          endKind: OUTCOME_ENDS.crashed,
        });
        return false;
      case "hostAlive":
        // Retryable: `work.resume` starts the session once the old host has ended.
        await this.#s.park(office, run, view.work, {
          intent: "park",
          ops: [],
          reason: "worker-failed",
          detail: `${request.why}; ${outcome.code}: the earlier worker host of the run (pid ${outcome.pid}) still runs, so no new session starts`,
          endKind: OUTCOME_ENDS.crashed,
        });
        return false;
      case "notResumed":
        await this.#s.park(office, run, view.work, {
          intent: "park",
          ops: [],
          reason: "interrupted",
          detail: `${request.why}; its session cannot be resumed: ${outcome.reason}`,
          endKind: OUTCOME_ENDS.interrupted,
        });
        return false;
    }
  }

  /**
   * A start failure (0008 section 7 and its 2026-10-14 amendment): the adapter is held and
   * `run.startFailed` raised. A worktree with work parks `worker-failed` and keeps everything;
   * otherwise the claim is released as DIPO-74 does and the story stays Ready.
   */
  async startFailed(
    office: OfficeHandle,
    run: StoredRun,
    work: WorkRef,
    detail: string,
    held: AdapterHold | null,
  ): Promise<void> {
    const hold =
      held ??
      this.#deps.holds?.hold(this.#deps.worker.id, [{ check: "start-failed", detail }]) ??
      null;
    const message = hold === null ? detail : holdMessage(hold);
    const claim = findClaim(office, run.runId);
    let holdsWork = true;
    try {
      holdsWork =
        claim === null
          ? false
          : ((await this.#deps.holdsWork?.(office.officeId, run, claim)) ?? true);
    } catch (error) {
      this.#deps.warn?.("reading the worktree's work after a start failure failed", {
        run: run.runId,
        reason: messageOf(error),
      });
    }
    const story = run.story ?? run.runId;
    if (holdsWork || claim === null) {
      await this.#s.park(office, run, work, {
        intent: "stop",
        intentDetail: `${INTENT_TAGS.startFailed} ${detail}`,
        ops: [],
        reason: "worker-failed",
        detail: message,
        endKind: START_FAILED_END,
        notice: {
          level: "error",
          code: OUTCOME_NOTICES.startFailed,
          text: `${story}: the worker did not start (${detail}). Its worktree holds work, so dipo parked the story as worker-failed and kept worktree, branch and session.`,
        },
      });
      return;
    }
    const at = this.#deps.clock.now();
    office.immediate(() => {
      const id = recordIntent(
        office,
        run.runId,
        "stop",
        `${INTENT_TAGS.startFailed} ${detail}`,
        at,
      );
      markIntentSent(office, run.runId, id, at, null);
      resolveIntent(office, run.runId, id, "startFailed", at);
    });
    let released = `dipo removed the worktree and kept the branch ${claim.branch} for the next run`;
    try {
      if (this.#deps.release === undefined) {
        office.immediate(() =>
          releaseClaim(office, run.runId, { at, reason: START_FAILED_END, keepBranch: true }),
        );
        released = `dipo released the claim and kept the branch ${claim.branch}`;
      } else {
        await this.#deps.release(office.officeId, claim, START_FAILED_END);
      }
    } catch (error) {
      released = `releasing its claim failed (${messageOf(error)}), so the worktree ${claim.worktree} and the claim may still be there; check them`;
    }
    this.#s.write(office, () => [
      {
        type: "engine.notice",
        key: work.key,
        run: run.runId,
        delta: {
          level: "error",
          code: OUTCOME_NOTICES.startFailed,
          text: `${story} was not started: ${detail}. ${released}; the story stays Ready.`,
        },
      },
    ]);
  }
}
