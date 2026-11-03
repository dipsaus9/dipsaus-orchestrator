// Starting the next session of a run, and the start failure that cannot, a part of worker
// outcomes (`outcomes.ts`).

import type { WorkRef } from "@dipsaus-orchestrator/contract";

import { pauseMessage, type AdapterPause } from "./starts-paused";
import { findClaim, releaseClaim } from "../worktree/records";

import type { OutcomeSupport } from "./outcome-support";
import {
  INTENT_TAGS,
  messageOf,
  OUTCOME_NOTICES,
  planLimitEnding,
  type RunOutcomesDeps,
  type RunView,
} from "./outcome-types";
import { markIntentSent, recordIntent, resolveIntent } from "../records/intents";
import { START_FAILED_RELEASE } from "./launch";
import type { OfficeHandle } from "../db/office";
import type { StoredRun } from "../records/run-records";

export class SessionStarts {
  readonly #s: OutcomeSupport;
  readonly #deps: RunOutcomesDeps;

  constructor(support: OutcomeSupport) {
    this.#s = support;
    this.#deps = support.deps;
  }

  /**
   * Starts the next session; a session that cannot start parks or releases the story. While the
   * office's starts are paused (0020) no session starts: under a plan limit the story parks
   * `worker-failed` with the pause's detail, to resume by itself when the pause lifts; under a
   * failed adapter check it goes the start failure's way. What the session is told comes from the
   * one feedback path (`feedback.ts`): the resumer sends every held message with its first one.
   */
  async next(
    office: OfficeHandle,
    run: StoredRun,
    view: RunView,
    request: { readonly why: string },
  ): Promise<boolean> {
    const paused = this.#deps.startsPaused?.()?.state(view.office) ?? null;
    if (paused?.reason === "plan-limit") {
      const pause = { detail: paused.detail, since: paused.since, until: paused.until };
      await this.#s.park(office, run, view.work, planLimitEnding(pause, []));
      return false;
    }
    if (paused?.reason === "adapter" && paused.pause !== undefined) {
      await this.startFailed(office, run, view.work, pauseMessage(paused.pause), paused.pause);
      return false;
    }
    const resumer = this.#deps.resumer;
    if (resumer === undefined) {
      await this.#s.park(office, run, view.work, {
        intent: "park",
        ops: [],
        reason: "worker-failed",
        detail: `${request.why}; dipo cannot start another session of the run`,
      });
      return false;
    }
    let outcome;
    try {
      outcome = await resumer.next({
        office: view.office,
        run,
        work: view.work,
        why: request.why,
        caps: view.caps,
        startedAt: view.startedAt,
      });
    } catch (error) {
      outcome = { kind: "failed" as const, reason: messageOf(error) };
    }
    switch (outcome.kind) {
      case "started":
        return true;
      case "startFailed":
        await this.startFailed(office, run, view.work, pauseMessage(outcome.pause), outcome.pause);
        return false;
      case "failed":
        await this.#s.park(office, run, view.work, {
          intent: "park",
          ops: [],
          reason: "worker-failed",
          detail: `${request.why}; the next session did not start: ${outcome.reason}`,
        });
        return false;
      case "hostAlive":
        // Retryable: `work.resume` starts the session once the old host has ended.
        await this.#s.park(office, run, view.work, {
          intent: "park",
          ops: [],
          reason: "worker-failed",
          detail: `${request.why}; ${outcome.code}: the earlier worker host of the run (pid ${outcome.pid}) still runs, so no new session starts`,
        });
        return false;
    }
  }

  /**
   * A start failure (0008): starts pause for the adapter (reason `adapter`) and
   * `run.startFailed` raised. A branch with work parks `worker-failed` and keeps everything;
   * otherwise the claim is released and the story stays Ready.
   */
  async startFailed(
    office: OfficeHandle,
    run: StoredRun,
    work: WorkRef,
    detail: string,
    held: AdapterPause | null,
  ): Promise<void> {
    const hold =
      held ??
      this.#deps.holds?.pause(this.#deps.worker.id, [{ check: "start-failed", detail }]) ??
      null;
    const message = hold === null ? detail : pauseMessage(hold);
    const claim = findClaim(office, run.runId);
    let holdsWork = true;
    try {
      holdsWork =
        claim === null
          ? false
          : ((await this.#deps.holdsWork?.(office.officeId, run, claim)) ?? true);
    } catch (error) {
      this.#deps.warn?.("reading the branch's work after a start failure failed", {
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
        notice: {
          level: "error",
          code: OUTCOME_NOTICES.startFailed,
          text: `${story}: the worker did not start (${detail}). Its branch holds work, so dipo parked the story as worker-failed and kept branch and session.`,
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
    let released = `dipo released the claim and kept the branch ${claim.branch} for the next run`;
    try {
      if (this.#deps.release === undefined) {
        office.immediate(() =>
          releaseClaim(office, run.runId, {
            at,
            reason: START_FAILED_RELEASE,
            ending: "dropped",
            keepBranch: true,
          }),
        );
        released = `dipo released the claim and kept the branch ${claim.branch}`;
      } else {
        await this.#deps.release(office.officeId, claim, START_FAILED_RELEASE);
      }
    } catch (error) {
      released = `releasing its claim failed (${messageOf(error)}), so the claim may still be there; check it`;
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
