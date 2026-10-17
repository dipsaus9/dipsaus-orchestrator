// Resuming a run that stands still (ADR 0020 section 1, DIPO-138): the one module for every resume
// of a held or parked run, moved out of `RunOutcomes` (DIPO-61, DIPO-75) and `plan-limit.ts`.
//
// - `resumeWait` resumes a run held by a plan limit; `work.resume` (`resumeCommand`) and the
//   schedule's timers call it.
// - `resumePark` resumes the run of a story parked `needs-permission` after its question is
//   answered (`work.answer`, `hooks/park-answers.ts`): the park is lifted on the branch, the run
//   reopened and its next session started. `recoverParkResumes` finishes one a restart interrupted.
// - `PARK_RESUME_POLICY` says, per reason a run stands still, which command resumes it. The rows of M0
//   are `needs-permission` (the permission answer) and `plan-limit` (`work.resume` of the held
//   run). Any other reason answers `story.notPausedOrParked` to `work.resume`; later rows extend
//   this table, not the run outcomes.

import {
  type Lifecycle,
  type OfficeId,
  type RunId,
  workResume,
} from "@dipsaus-orchestrator/contract";
import type { z } from "zod";

import type { NewEntry } from "../changelog/log";
import { CommandError } from "../commands/errors";
import type {
  AsyncCommandContext,
  CommandOutcome,
  FeatureModule,
  FeatureRegistry,
} from "../commands/registry";
import type { OfficeHandle } from "../db/office";
import { parkAnswerMessage } from "../hooks/park-questions";
import { answeredParkQuestion, findQuestion } from "../hooks/questions";
import { workRefOf } from "../views/work";

import { markIntentSent, recordIntent, resolveIntent, runIntents } from "./intents";
import { RunOutcomes, type OutcomeParts } from "./outcomes";
import {
  INTENT_TAGS,
  intentRest,
  intentTag,
  messageOf,
  openWait,
  PLAN_LIMIT_CONTINUE,
  type ResumeParkOutcome,
  type ResumeParkRequest,
  type RunOutcomesDeps,
} from "./outcome-types";
import { openPark, PARK_NOTICES, reopenParkedRun } from "./park";
import { activeRuns, capsStartedAt, findRun, type StoredRun } from "./records";

/** `work.resume` on a story with no run it can resume (0005 section 4). */
export const NOT_PAUSED_OR_PARKED = "story.notPausedOrParked";
/** `work.resume` while the held worker has not exited (0005 section 10, retryable). */
export const RUN_HOST_ALIVE = "run.hostAlive";

/** What answers `resumeWait`. */
export type ResumeWaitOutcome = "started" | "failed" | "notHeld" | "busy";

/** The command that resumes a run standing still for a reason. */
export type ResumeVia = "permission-answer" | "work.resume";

export interface ResumePolicyRow {
  readonly via: ResumeVia;
}

/**
 * The per-reason resume policy. Keyed by the park reason; a run held by a plan limit is not parked
 * and stands under the reason `plan-limit`. A reason with no row cannot be resumed here yet.
 */
export const PARK_RESUME_POLICY: Readonly<Record<string, ResumePolicyRow>> = {
  "needs-permission": { via: "permission-answer" },
  "plan-limit": { via: "work.resume" },
};

/** The command that resumes a run standing still for `reason`, or null without a row. */
export function resumeVia(reason: string): ResumeVia | null {
  return Object.hasOwn(PARK_RESUME_POLICY, reason)
    ? (PARK_RESUME_POLICY[reason]?.via ?? null)
    : null;
}

/** The plan-limit schedule as `work.resume` uses it (`PlanLimits.resumeNow`). */
export interface HeldRunResumer {
  resumeNow(office: OfficeId, run: RunId): Promise<ResumeWaitOutcome>;
}

export interface ResumptionOptions {
  /** The plan-limit schedule; read when needed, since it is built after this. */
  readonly planLimits?: () => HeldRunResumer | undefined;
}

type ResumeArgs = z.output<typeof workResume.args>;
type ResumeResult = z.input<typeof workResume.result>;

/**
 * Builds worker outcomes and the resumption that shares their facts and guard: the outcomes'
 * restart step finishes the park resumes a restart interrupted through it.
 */
export function createRunOutcomes(
  deps: RunOutcomesDeps,
  options: ResumptionOptions = {},
): { readonly outcomes: RunOutcomes; readonly resumption: Resumption } {
  let resumption: Resumption | null = null;
  const outcomes = new RunOutcomes({
    ...deps,
    recoverParks: (officeId, office) => resumption?.recoverParkResumes(officeId, office) ?? 0,
  });
  resumption = new Resumption(outcomes.parts, options);
  return { outcomes, resumption };
}

export class Resumption {
  readonly #s: OutcomeParts["support"];
  readonly #deps: RunOutcomesDeps;
  readonly #guard: OutcomeParts["support"]["guard"];
  readonly #sessions: OutcomeParts["sessions"];
  readonly #options: ResumptionOptions;
  /** Sessions of resumed parks starting after their answer was replied to (DIPO-75). */
  readonly #inflight = new Set<Promise<unknown>>();

  constructor(parts: OutcomeParts, options: ResumptionOptions = {}) {
    this.#s = parts.support;
    this.#deps = parts.support.deps;
    this.#guard = parts.support.guard;
    this.#sessions = parts.sessions;
    this.#options = options;
  }

  /** Resolves once every session start of a resumed park this started has finished (DIPO-75). */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled(this.#inflight);
  }

  /** `work.resume` for held runs; read by the plan-limit schedule's feature. */
  get feature(): FeatureModule {
    return {
      name: "resumption",
      register: (registry: FeatureRegistry) => {
        registry.addAsyncOfficeCommand({
          definition: workResume,
          handle: (ctx, args) => this.resumeCommand(ctx, args),
        });
      },
    };
  }

  /**
   * `work.resume { story, note? }`: the policy table decides. A story whose active run holds an
   * open wait (`plan-limit`) is resumed at once, a `credits` hold on the adapter is lifted, and the
   * result names the run. A story under any other reason (a park, whose own way back is its row's
   * command) or with none fails `story.notPausedOrParked`; a held worker that has not exited yet
   * fails the retryable `run.hostAlive`.
   */
  async resumeCommand(
    ctx: AsyncCommandContext,
    args: ResumeArgs,
  ): Promise<CommandOutcome<ResumeResult>> {
    const handle = ctx.office;
    const identity = ctx.stories.get(args.story);
    if (identity === undefined) throw new Error(`${args.story} was not resolved`);
    const run = activeRuns(handle).find(
      (candidate) => candidate.kind === "story" && candidate.key === identity.key,
    );
    const notHeld = () =>
      new CommandError(
        NOT_PAUSED_OR_PARKED,
        `${identity.story} has no run held by a plan limit; work.resume continues only those for now.`,
        { story: identity.story },
      );
    const reason = run !== undefined && openWait(handle, run.runId) !== null ? "plan-limit" : null;
    if (run === undefined || reason === null || resumeVia(reason) !== "work.resume") {
      throw notHeld();
    }
    const planLimits = this.#options.planLimits?.();
    const outcome =
      planLimits === undefined
        ? await this.resumeWait(handle.officeId, run.runId, "work.resume of the held run")
        : await planLimits.resumeNow(handle.officeId, run.runId);
    switch (outcome) {
      case "notHeld":
        throw notHeld();
      case "busy":
        throw new CommandError(
          RUN_HOST_ALIVE,
          `${identity.story}'s held worker has not exited yet; send work.resume again in a moment.`,
          { story: identity.story, run: run.runId },
        );
      case "started":
        return {
          result: {
            story: identity.story,
            key: identity.key,
            to: "In Progress",
            run: run.runId,
          },
        };
      case "failed":
        return {
          result: {
            story: identity.story,
            key: identity.key,
            to: this.#afterFailure(handle, run.runId),
          },
        };
    }
  }

  /** Where the story is after a resume that did not start: parked, else released to Ready. */
  #afterFailure(handle: OfficeHandle, runId: RunId): Lifecycle {
    const parked = handle.get(
      "select 1 as found from parks where office_id = $office_id and run_id = $run",
      { run: runId },
    );
    return parked === null ? "Ready" : "Parked";
  }

  /**
   * Resumes a run held by a plan limit (DIPO-61, 0008 section 7): its native session continues
   * with "continue" (a handoff when it cannot be resumed), and the `plan-limit` signal ends when
   * the new session is recorded. `notHeld` when the run has no open wait or has ended, `busy`
   * while the held worker has not exited yet. A next session that cannot start parks or releases
   * the story as after a crash.
   */
  async resumeWait(officeId: OfficeId, runId: RunId, why: string): Promise<ResumeWaitOutcome> {
    const office = this.#deps.offices.get(officeId);
    if (office === undefined) return "notHeld";
    const run = findRun(office, runId);
    if (run === null || run.endedAt !== null || openWait(office, runId) === null) return "notHeld";
    const key = `${runId} plan-limit`;
    if (this.#guard.busy(runId)) return "busy";
    const latest = office.get<{ ended_at: number | null }>(
      `select ended_at from agents where office_id = $office_id and run_id = $run
        order by started_at desc, rowid desc limit 1`,
      { run: runId },
    );
    if (latest !== null && latest.ended_at === null) return "busy";
    const view = this.#s.viewOf(officeId, office, run);
    if (view === null) return "notHeld";
    return this.#guard.within(key, async () => {
      // The pause explained the held worker's exit; one left open (an exit a restart did not
      // decide) must not explain the next session's exit.
      const at = this.#deps.clock.now();
      for (const intent of runIntents(office, runId)) {
        if (intent.resolvedAt !== null || intent.kind !== "pause") continue;
        if (intentTag(intent.detail) !== INTENT_TAGS.planLimit) continue;
        this.#s.resolve(office, runId, intent, "plan-limit", at);
      }
      const started = await this.#sessions.next(office, run, view, {
        mode: "resume",
        why,
        message: PLAN_LIMIT_CONTINUE,
        clear: ["plan-limit"],
      });
      return started ? "started" : "failed";
    });
  }

  /**
   * Resumes the run of a story parked `needs-permission` after the maintainer answered the park's
   * question (DIPO-75; 0008 sections 5 and 8). An `answer` intent tagged `park-resume` with the
   * request is stored first. The park is lifted on the story branch (the F16 record removed, the
   * status back to the park's `from`, committed and pushed), then one transaction resolves the
   * park `resume`, reopens the run (`story.state` leaves Parked), records the answer, so an allow
   * is in place before the session's first call, and marks the intent sent. The run's next
   * session starts on the same run: `--resume` of the native session when `canResume` holds,
   * else a handoff, with the answer's message first and what remains of the run's caps; the time
   * the story stood parked does not count (`parked_ms`). The intent is then resolved. A session
   * that does not start parks or releases the story as after a crash. A restart before the
   * intent is resolved finishes the resume (`redispatch`).
   */
  async resumePark(
    officeId: OfficeId,
    runId: RunId,
    request: ResumeParkRequest,
  ): Promise<ResumeParkOutcome> {
    const office = this.#deps.offices.get(officeId);
    if (office === undefined) return { kind: "notParked" };
    const run = findRun(office, runId);
    if (run === null || run.kind !== "story" || run.key === null || run.endedAt === null) {
      return { kind: "notParked" };
    }
    const park = openPark(office, run.key);
    if (park === null || park.parkId !== request.parkId || park.runId !== runId) {
      return { kind: "notParked" };
    }
    // Only a reason whose row resumes through the permission answer resumes here.
    if (resumeVia(park.reason) !== "permission-answer") return { kind: "notParked" };
    if (this.#guard.busy(runId)) return { kind: "busy" };
    const latest = office.get<{ ended_at: number | null }>(
      `select ended_at from agents where office_id = $office_id and run_id = $run
        order by started_at desc, rowid desc limit 1`,
      { run: runId },
    );
    if (latest !== null && latest.ended_at === null) return { kind: "busy" };
    if (
      this.#deps.caps?.(officeId, run) == null ||
      workRefOf(office, runId) === null ||
      this.#deps.unpark === undefined
    ) {
      return { kind: "failed", reason: `dipo cannot resume ${runId} in this office` };
    }
    const question = findQuestion(office, request.question);
    if (question === null || question.closedAt !== null || question.parkId !== park.parkId) {
      return { kind: "notParked" };
    }
    const key = `${runId} park-resume`;
    return this.#guard.within(key, async () => {
      // Stored before anything changes, so a restart in between finishes the resume.
      const intentId = office.immediate(() =>
        recordIntent(
          office,
          runId,
          "answer",
          `${INTENT_TAGS.parkResume} ${JSON.stringify({ ...request, agent: workRefOf(office, runId)?.agent ?? null })}`,
          this.#deps.clock.now(),
        ),
      );
      return await this.#finishParkResume(office, run, request, intentId, false, true);
    });
  }

  /**
   * The steps of a park resume after its intent is stored: unless `reopened`, the park is lifted
   * on the branch (idempotent: a lift already written commits nothing), then one transaction
   * resolves the park, reopens the run, records the answer and marks the intent sent; then the
   * next session starts and the intent is resolved with how it went.
   */
  async #finishParkResume(
    office: OfficeHandle,
    run: StoredRun,
    request: ResumeParkRequest,
    intentId: number,
    reopened: boolean,
    /** Start the next session after returning (the command); wait for it otherwise (recovery). */
    background: boolean,
  ): Promise<ResumeParkOutcome> {
    const officeId = office.officeId as OfficeId;
    const runId = run.runId;
    const resolve = (outcome: string) =>
      office.immediate(() =>
        resolveIntent(office, runId, intentId, outcome, this.#deps.clock.now()),
      );
    const caps = this.#deps.caps?.(officeId, run) ?? null;
    const work = workRefOf(office, runId);
    const question = findQuestion(office, request.question);
    const unpark = this.#deps.unpark;
    if (
      caps === null ||
      work === null ||
      question?.tool == null ||
      question.input === null ||
      run.story === null ||
      run.branch === null ||
      run.worktree === null ||
      run.key === null ||
      (!reopened && unpark === undefined)
    ) {
      resolve("failed");
      return { kind: "failed", reason: `dipo cannot resume ${runId} in this office` };
    }
    if (!reopened && unpark !== undefined) {
      const park = openPark(office, run.key);
      if (park === null || park.parkId !== request.parkId) {
        resolve("notParked");
        return { kind: "notParked" };
      }
      const to = park.from === "In Review" ? "In Review" : "In Progress";
      let lifted;
      try {
        lifted = await unpark.lift(officeId, {
          story: run.story,
          branch: run.branch,
          worktree: run.worktree,
          to,
        });
      } catch (error) {
        resolve("failed");
        return { kind: "failed", reason: `lifting the park failed: ${messageOf(error)}` };
      }
      const at = this.#deps.clock.now();
      const pushNotice: NewEntry[] =
        lifted.pushError === null
          ? []
          : [
              {
                type: "engine.notice",
                key: work.key,
                run: runId,
                delta: {
                  level: "warn",
                  code: PARK_NOTICES.pushFailed,
                  text: `${run.story}: the park was lifted, but ${lifted.pushError}; the change is on the local branch only until a later push succeeds.`,
                },
              },
            ];
      // The park resolved, the run active again, the answer recorded (an allow is in place before
      // the session's first call) and the intent sent: one transaction.
      this.#s.write(office, () => {
        const reopenedEntries = reopenParkedRun(office, park, run, to, at);
        const answered = answeredParkQuestion(
          office,
          request.question,
          request.decision,
          request.text,
          at,
        );
        markIntentSent(office, runId, intentId, at, null);
        return [...reopenedEntries, ...answered, ...pushNotice];
      });
      await this.#deps.refreshStory?.(officeId, work.key).catch((error: unknown) => {
        this.#deps.warn?.("reading the resumed story again failed", {
          run: runId,
          reason: messageOf(error),
        });
      });
    }
    // The run's caps count the time it worked, not the time it stood parked (`parked_ms`).
    const fresh = findRun(office, runId) ?? run;
    const host = office.get<{ started_at: number | null }>(
      `select min(started_at) as started_at from worker_hosts
        where office_id = $office_id and run_id = $run`,
      { run: runId },
    );
    const permission = { tool: question.tool, action: question.input };
    const startSession = async (): Promise<boolean> => {
      const started = await this.#sessions.next(
        office,
        fresh,
        {
          office: officeId,
          runId,
          work,
          caps,
          startedAt: capsStartedAt(fresh, host?.started_at),
          snapshot: null,
        },
        {
          mode: "resume",
          why: `the maintainer's ${request.decision === "allow" ? "allow once" : "deny"} of ${permission.tool}: ${permission.action}`,
          message: parkAnswerMessage(permission, request.decision, request.text),
        },
      );
      resolve(started ? "resumed" : "notStarted");
      return started;
    };
    if (!background) {
      return (await startSession()) ? { kind: "started" } : { kind: "notStarted" };
    }
    // The answer's reply does not wait for the worker host (it may take many seconds): the
    // session starts after it. A start that fails parks or releases the story with its notice, as
    // after a crash; a restart before it is done finishes it from the intent.
    const key = `${runId} park-session`;
    const job = this.#guard.within(key, startSession).catch((error: unknown) => {
      this.#deps.warn?.("starting the session of a resumed park failed", {
        run: runId,
        reason: messageOf(error),
      });
      return false;
    });
    this.#inflight.add(job);
    void job.finally(() => this.#inflight.delete(job));
    return { kind: "started" };
  }

  /**
   * After a restart (DIPO-75): a park resume whose intent was stored but not resolved is finished.
   * Not yet sent (the daemon stopped before the reopen): the park is lifted again, which commits
   * nothing when it was already lifted, and the run reopened, while its park and question are still
   * open; otherwise the intent is dropped and the question stays answerable. Sent (reopened, the
   * answer recorded) but no session after it: the next session starts.
   */
  async recoverParkResumes(officeId: OfficeId, office: OfficeHandle): Promise<number> {
    const rows = office.all<{ run_id: string; intent_id: number; detail: string; state: string }>(
      `select run_id, intent_id, detail, state from run_intents
        where office_id = $office_id and kind = 'answer' and resolved_at is null
          and detail like $tag order by created_at, intent_id`,
      { tag: `${INTENT_TAGS.parkResume} %` },
    );
    let count = 0;
    for (const row of rows) {
      const runId = row.run_id as RunId;
      const run = findRun(office, runId);
      const resolve = (outcome: string) =>
        office.immediate(() =>
          resolveIntent(office, runId, row.intent_id, outcome, this.#deps.clock.now()),
        );
      let request: ResumeParkRequest;
      try {
        request = JSON.parse(intentRest(row.detail)) as ResumeParkRequest;
      } catch {
        resolve("failed");
        continue;
      }
      if (run === null || run.key === null || this.#guard.busy(runId)) continue;
      const key = `${runId} park-resume`;
      const finishing = run;
      const parkKey = run.key;
      count += await this.#guard.within(key, async () => {
        if (row.state === "pending") {
          const park = openPark(office, parkKey);
          const question = findQuestion(office, request.question);
          if (
            finishing.endedAt === null ||
            park?.parkId !== request.parkId ||
            question === null ||
            question.closedAt !== null
          ) {
            resolve("abandoned");
            return 0;
          }
          await this.#finishParkResume(office, finishing, request, row.intent_id, false, false);
          return 1;
        }
        // Reopened: start the session unless one started after the intent (a newer agent than the
        // parked one it names).
        const latest = office.get<{ agent_id: string }>(
          `select agent_id from agents where office_id = $office_id and run_id = $run
            order by started_at desc, rowid desc limit 1`,
          { run: runId },
        );
        const parkedAgent = (request as ResumeParkRequest & { agent?: string | null }).agent;
        const newer = latest !== null && parkedAgent != null && latest.agent_id !== parkedAgent;
        if (finishing.endedAt !== null || newer) {
          resolve("resumed");
          return 0;
        }
        await this.#finishParkResume(office, finishing, request, row.intent_id, true, false);
        return 1;
      });
    }
    return count;
  }
}
