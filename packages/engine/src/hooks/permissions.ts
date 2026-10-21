// The permission wait (0008 section 5, open question 2: hybrid, decided by code; DIPO-59). A
// worker's `PermissionRequest` hook arrives as a neutral `permissionRequest` hook event with the id
// its worker host holds the call under. The engine decides at once:
//
// - With `permissions.ask: when-present` and a TUI connected at that moment (`questionRoute`, 0021
//   section 11, DIPO-279), the question is live: the engine stores a permission question, emits
//   `question.asked` (kind permission, the tool and a one-line input summary) and
//   `work.observed input-wait`, and waits up to `timeouts.permissionWaitSeconds` for
//   `work.answer`. An answer allows or denies the call; no answer in time denies it.
// - Otherwise (no TUI connected, `never`, a run being ended, no story work), the question parks:
//   the hook gets no decision at once, so the call is denied, the worker reports blocked with the
//   tool and action it needs, and the story parks `needs-permission` with that question
//   (DIPO-75). With the daemon down nobody answers and the worker host itself returns no decision.
// - When the last TUI closes while a question is live (DIPO-284), the daemon calls
//   `presenceChanged`: every live question closes (`ended`) and its hook gets no decision at once,
//   so its story parks with the question exactly as above. A question stays live while another
//   TUI is still connected.
//
// The reply goes to the worker host as the adapter encodes the neutral `HookReply`; this module
// never names a CLI field. A worker's exit closes its open questions (`ended`), and an office load
// closes the ones a previous daemon left (`expired`): their hook calls were already answered by the
// host with no decision.
//
// The timeout's own writes run in a timer, outside any command: a database error there is logged
// once with its error code and the deny is still sent; the question's timer is armed again and
// only its close is retried (DIPO-123).
//
// The question of a worker's report (the door's message W3, DIPO-272) takes the same rule. Run
// control hands a blocked report's question to `askWorker`, before it parks:
//
// - With a TUI connected at that moment (`questionRoute`) and the run not being ended, the question
//   is live: a question of kind `question` is stored and `question.asked` and `work.observed
//   input-wait` are emitted. The worker's turn has ended and it waits on stdin, so `work.answer`
//   with text sends the answer as its next user message (`answer`), and the question closes
//   `answered`. There is no timeout; the run's caps still run.
// - Otherwise `askWorker` returns false and run control parks the story `ambiguous-spec` with the
//   question, as before.
// - When the last TUI closes while it is live (DIPO-284), `presenceChanged` closes it (`ended`) and
//   parks the story with the question through `parkQuestion`.
// - When the run ends while it is live (a cap, a stop), the park takes it over (`run/park.ts`): it
//   stays open as the park's question, and its answer is held for the first message of the run's
//   next session, as a steer to a parked story is. The story stays Parked until its park resumes.

import {
  type Clock,
  type IdSource,
  type OfficeId,
  type RunId,
  workAnswer,
} from "@dipsaus-orchestrator/contract";

import { appendEntries, type NewEntry } from "../changelog/log";
import { CommandError } from "../commands/errors";
import type { AsyncCommandContext, CommandOutcome, FeatureModule } from "../commands/registry";
import type { OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import { background, failureFields } from "../platform/background";
import type { RunSteering } from "../run/control";
import { recordIntent } from "../run/intents";
import { type LiveQuestions, type Presence, questionRoute } from "../run/live-question";
import { openPark } from "../run/park";
import { MAINTAINER_TAGS } from "../run/pauses";
import { findRun } from "../run/records";
import { activeSignals, clearSignals, raiseSignal } from "../run/signals";
import { withWorkViews, workRefOf } from "../views/work";
import type { HostOp, SteerOp, WorkerEvent } from "../workers/types";

import {
  answerParkQuestion,
  type ParkAnswerResult,
  parkedElsewhere,
  type ParkResumer,
  staleParkQuestions,
} from "./park-answers";
import {
  closeQuestion,
  findQuestion,
  insertPermissionQuestion,
  insertWorkerQuestion,
  openQuestions,
  type QuestionClose,
  questionViewOf,
  type StoredQuestion,
  takeAllowOnce,
} from "./questions";
import type { HookEvent, HookReply, PermissionDecision } from "./types";

/** The error of `work.answer` for a question that is not waiting (0005 section 4). */
export const QUESTION_CLOSED = "question.closed";

/** The host's error for a hook call it no longer holds. */
const HOOK_GONE = "hook.unknown";

/** `engine.notice` code when a decision could not reach the worker host. */
export const REPLY_NOT_SENT = "run.hookReplyNotSent";

export { ABSENT, type Presence } from "../run/live-question";

export interface PermissionAsksDeps {
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly offices: {
    get(office: OfficeId): OfficeHandle | undefined;
    config(office: OfficeId): OfficeConfig | undefined;
  };
  /** Sends host ops to a run's worker host. */
  readonly steering: RunSteering;
  /** The worker adapter's pure `encode`, which turns the neutral reply into host ops. */
  readonly encode: (op: SteerOp) => HostOp[];
  readonly presence: Presence;
  /** True while a decision on the run (a cap, a park, a stop) is being carried out. */
  readonly ending?: (run: string) => boolean;
  /** Resumes the run of a `needs-permission` park its question's answer lifts (DIPO-75). */
  readonly parks?: ParkResumer;
  /** False while the daemon schedules no work (`safe`, `draining`); true by default. */
  readonly scheduling?: () => boolean;
  /** Called after change-log entries were appended outside a command. */
  readonly onChanged?: (office: OfficeId) => void;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
  /**
   * Parks the story of `run` `ambiguous-spec` with its worker's question once that question stopped
   * being live (the last TUI closed, DIPO-284); run control's `parkOnQuestion`.
   */
  readonly parkQuestion?: (office: OfficeId, run: RunId, question: string) => void;
}

/** The first line of the user message that carries the maintainer's answer to a worker question. */
export const WORKER_ANSWER_INTRO = "The maintainer answered your question:";

/** The user message that carries the maintainer's answer to the worker's question. */
export function workerAnswerText(text: string): string {
  return `${WORKER_ANSWER_INTRO}\n\n${text.trim()}`;
}

type PermissionRequest = Extract<HookEvent, { kind: "permissionRequest" }>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PermissionAsks implements LiveQuestions {
  readonly #deps: PermissionAsksDeps;
  /** The worker questions asked live by this engine (DIPO-272), with their office and run. */
  readonly #workerQuestions = new Map<string, { readonly office: OfficeId; readonly run: RunId }>();
  /** Open permission questions this engine waits on (the live ones), with their office and timeout. */
  readonly #timers = new Map<
    string,
    { readonly office: OfficeId; readonly timer: ReturnType<Clock["setTimeout"]> }
  >();
  readonly #inflight = new Set<Promise<unknown>>();

  constructor(deps: PermissionAsksDeps) {
    this.#deps = deps;
  }

  /** The events of one committed ingestion pass of `office`'s run `run` (`OfficeIngest`). */
  onWorkerEvents(
    office: OfficeHandle,
    run: string,
    agent: string,
    events: readonly WorkerEvent[],
  ): void {
    for (const event of events) {
      if (event.t === "hook" && event.hook.kind === "permissionRequest") {
        this.request(office, run as RunId, agent, event.hook);
      }
    }
  }

  /** The worker of `run` exited: its open questions stop waiting. */
  onEnded(office: OfficeHandle, run: string): void {
    for (const [questionId, live] of this.#workerQuestions) {
      if (live.run === run) this.#workerQuestions.delete(questionId);
    }
    // A park's question (DIPO-75) waits for the maintainer after its worker exited. So does a live
    // worker question of a run being ended: its park takes it over (DIPO-272).
    const ending = this.#deps.ending?.(run) === true;
    const open = openQuestions(office, run).filter(
      (question) => question.parkId === null && !(ending && question.kind === "question"),
    );
    if (open.length === 0) return;
    this.#close(office, open, "ended");
  }

  /** Resolves once every reply this module started has been sent. */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled(this.#inflight);
  }

  /** Stops every timeout; open questions are closed as `expired` at the next office load. */
  close(): void {
    for (const { timer } of this.#timers.values()) this.#deps.clock.clearTimeout(timer);
    this.#timers.clear();
    this.#workerQuestions.clear();
  }

  /**
   * The daemon's TUI connections changed (0021 section 11, DIPO-284). With no TUI connected any
   * more, every live question ends at once: it closes as `ended` and its hook gets no decision, so
   * its story parks with the question as one asked with no TUI does. While a TUI is still
   * connected nothing changes. A question whose close fails stays live until its timeout, with a
   * warning.
   */
  presenceChanged(): void {
    if (this.#timers.size + this.#workerQuestions.size === 0) return;
    if (this.#deps.presence.tuiConnected()) return;
    this.#endWorkerQuestions();
    const byOffice = new Map<OfficeId, string[]>();
    for (const [questionId, { office }] of this.#timers) {
      const ids = byOffice.get(office) ?? [];
      ids.push(questionId);
      byOffice.set(office, ids);
    }
    for (const [officeId, ids] of byOffice) {
      const office = this.#deps.offices.get(officeId);
      if (office === undefined) continue;
      let closed: StoredQuestion[];
      try {
        const live = ids
          .map((id) => findQuestion(office, id))
          .filter(
            (question): question is StoredQuestion =>
              question !== null &&
              question.closedAt === null &&
              question.hook !== null &&
              question.parkId === null,
          );
        closed = this.#close(office, live, "ended");
      } catch (error) {
        this.#deps.warn?.("ending live permission questions after the last TUI closed failed", {
          office: officeId,
          questions: ids,
          ...failureFields(error),
        });
        continue;
      }
      for (const question of closed) {
        if (question.hook === null) continue;
        this.#reply(office, question.runId as RunId, { hook: question.hook, decision: null });
      }
    }
  }

  /**
   * The last TUI closed (DIPO-284): every live worker question closes as `ended` and its story parks
   * with the question. One whose close fails stays live, with a warning.
   */
  #endWorkerQuestions(): void {
    const live = [...this.#workerQuestions];
    this.#workerQuestions.clear();
    for (const [questionId, { office: officeId, run }] of live) {
      const office = this.#deps.offices.get(officeId);
      if (office === undefined) continue;
      // A run being ended already parks: that park takes the question over.
      if (this.#deps.ending?.(run) === true) continue;
      let closed: StoredQuestion[];
      try {
        const question = findQuestion(office, questionId);
        if (question === null || question.closedAt !== null) continue;
        closed = this.#close(office, [question], "ended");
      } catch (error) {
        this.#workerQuestions.set(questionId, { office: officeId, run });
        this.#deps.warn?.("ending a live worker question after the last TUI closed failed", {
          office: officeId,
          question: questionId,
          ...failureFields(error),
        });
        continue;
      }
      for (const question of closed) this.#deps.parkQuestion?.(officeId, run, question.text);
    }
  }

  /**
   * The question of a worker's report (DIPO-272): asked live when a TUI is connected now and the
   * run is not being ended, and then true; false when the story must park (see the file comment).
   */
  askWorker(office: OfficeHandle, run: RunId, agent: string, text: string): boolean {
    const work = workRefOf(office, run);
    const allowed = work !== null && this.#deps.ending?.(run) !== true;
    if (work === null || questionRoute(this.#deps.presence, allowed) === "park") return false;
    const questionId = this.#deps.ids.next("qst");
    const now = this.#deps.clock.now();
    let appended: number;
    try {
      appended = office.immediate(() => {
        const question = insertWorkerQuestion(office, {
          questionId,
          runId: run,
          agentId: agent,
          text,
          at: now,
        });
        const view = questionViewOf(office, question);
        const entries: NewEntry[] = [];
        if (view !== null)
          entries.push({ type: "question.asked", key: work.key, run, delta: view });
        const raised = raiseSignal(office, run, "input-wait", now);
        if (raised !== null) {
          entries.push({
            type: "work.observed",
            key: work.key,
            run,
            delta: { work, signal: "input-wait", since: new Date(now).toISOString() },
          });
        }
        const ready = withWorkViews(office, entries);
        appendEntries(office, ready, { at: now });
        return ready.length;
      });
    } catch (error) {
      // A question that could not be stored cannot be answered: the story parks with it instead.
      this.#deps.warn?.("storing a live worker question failed; the story parks", {
        run,
        ...failureFields(error),
      });
      return false;
    }
    this.#workerQuestions.set(questionId, { office: office.officeId, run });
    if (appended > 0) this.#deps.onChanged?.(office.officeId);
    return true;
  }

  /**
   * `work.answer { question, text }` on a worker question its run's park took over (DIPO-272):
   * the answer is recorded and held for the first message of the run's next session, as a steer
   * to a parked story is (`heldMessages`); the story stays Parked until its park is resumed. A
   * question whose park ended waits no more.
   */
  async #answerParkedWorker(
    ctx: AsyncCommandContext,
    question: StoredQuestion,
    args: { readonly text: string; readonly decision?: "allow" | "deny" | undefined },
  ): Promise<CommandOutcome<ParkAnswerResult>> {
    const office = ctx.office;
    const text = workerAnswerTextOf(args);
    const run = findRun(office, question.runId as RunId);
    const park = run?.key == null ? null : openPark(office, run.key);
    const now = this.#deps.clock.now();
    if (park === null || park.parkId !== question.parkId) {
      ctx.commit(() =>
        closeQuestion(office, question.questionId, "expired", now)
          ? this.#closingEntries(office, question, now)
          : [],
      );
      throw new CommandError(
        QUESTION_CLOSED,
        `${question.questionId} is not waiting: its story is no longer parked for it.`,
        { question: question.questionId, questionOpen: false },
      );
    }
    let closed = false;
    ctx.commit(() => {
      closed = closeQuestion(office, question.questionId, "answered", now, {
        text,
        decision: null,
        delivered: "on-resume",
      });
      if (!closed) return [];
      recordIntent(
        office,
        question.runId as RunId,
        "steer",
        `${MAINTAINER_TAGS.held} ${workerAnswerText(text)}`,
        now,
      );
      return this.#closingEntries(office, question, now, text);
    });
    if (!closed) {
      throw new CommandError(
        QUESTION_CLOSED,
        `${question.questionId} is not waiting for an answer.`,
        {
          question: question.questionId,
        },
      );
    }
    return { result: { question: question.questionId, delivered: "on-resume" } };
  }

  /** `work.answer { question, text }` on a live worker question: the answer goes to the worker now. */
  async #answerWorker(
    ctx: AsyncCommandContext,
    question: StoredQuestion,
    args: { readonly text: string; readonly decision?: "allow" | "deny" | undefined },
  ): Promise<CommandOutcome<ParkAnswerResult>> {
    const office = ctx.office;
    const text = workerAnswerTextOf(args);
    let closed = false;
    const now = this.#deps.clock.now();
    ctx.commit(() => {
      closed = closeQuestion(office, question.questionId, "answered", now, {
        text,
        decision: null,
        delivered: "now",
      });
      return closed ? this.#closingEntries(office, question, now, text) : [];
    });
    if (!closed) {
      throw new CommandError(
        QUESTION_CLOSED,
        `${question.questionId} is not waiting for an answer.`,
        {
          question: question.questionId,
        },
      );
    }
    this.#workerQuestions.delete(question.questionId);
    const run = question.runId as RunId;
    let error: string | null = null;
    try {
      const sent = await this.#deps.steering.send(
        office,
        run,
        this.#deps.encode({ kind: "answer", text: workerAnswerText(text) }),
      );
      if (!sent.ok) error = sent.reason;
    } catch (thrown) {
      error = messageOf(thrown);
    }
    if (error !== null) {
      this.#deps.warn?.("a worker question's answer did not reach the worker host", {
        run,
        question: question.questionId,
        reason: error,
      });
      const work = workRefOf(office, run);
      office.immediate(() =>
        appendEntries(
          office,
          [
            {
              type: "engine.notice",
              ...(work === null ? {} : { key: work.key }),
              run,
              delta: {
                level: "warn",
                code: REPLY_NOT_SENT,
                text: `${work?.story ?? run}: dipo could not send the answer to its worker (${error}).`,
              },
            },
          ],
          { at: this.#deps.clock.now() },
        ),
      );
      this.#deps.onChanged?.(office.officeId);
    }
    return { result: { question: question.questionId, delivered: "now" } };
  }

  /** Asks the maintainer live, or denies at once so the story parks (see the file comment). */
  request(office: OfficeHandle, run: RunId, agent: string, hook: PermissionRequest): void {
    if (hook.id === null) return;
    const officeId = office.officeId;
    const config = this.#deps.offices.config(officeId);
    const now = this.#deps.clock.now();
    const work = workRefOf(office, run);
    if (work !== null && this.#deps.ending?.(run) !== true && this.#allowOnce(office, run, hook)) {
      return;
    }
    const allowed = this.#deps.ending?.(run) !== true && config?.permissions.ask === "when-present";
    if (work === null || questionRoute(this.#deps.presence, allowed) === "park") {
      this.#reply(office, run, { hook: hook.id, decision: null });
      return;
    }
    const questionId = this.#deps.ids.next("qst");
    const hookId = hook.id;
    const appended = office.immediate(() => {
      const question = insertPermissionQuestion(office, {
        questionId,
        runId: run,
        agentId: agent,
        tool: hook.tool,
        input: hook.input,
        hook: hookId,
        at: now,
      });
      const view = questionViewOf(office, question);
      const entries: NewEntry[] = [];
      if (view !== null) entries.push({ type: "question.asked", key: work.key, run, delta: view });
      const raised = raiseSignal(office, run, "input-wait", now);
      if (raised !== null) {
        entries.push({
          type: "work.observed",
          key: work.key,
          run,
          delta: { work, signal: "input-wait", since: new Date(now).toISOString() },
        });
      }
      const ready = withWorkViews(office, entries);
      appendEntries(office, ready, { at: now });
      return ready.length;
    });
    if (appended > 0) this.#deps.onChanged?.(officeId);
    const seconds = config?.timeouts.permissionWaitSeconds ?? 300;
    this.#arm(officeId, questionId, seconds, () => this.#timeout(officeId, questionId, seconds));
  }

  /** `work.answer { question, text, decision? }` on a permission question (0008 section 5). */
  async answer(
    ctx: AsyncCommandContext,
    args: {
      readonly question: string;
      readonly text: string;
      readonly decision?: "allow" | "deny" | undefined;
    },
  ): Promise<CommandOutcome<ParkAnswerResult>> {
    const office = ctx.office;
    const question = findQuestion(office, args.question);
    if (question === null || question.closedAt !== null) {
      throw new CommandError(QUESTION_CLOSED, `${args.question} is not waiting for an answer.`, {
        question: args.question,
      });
    }
    if (question.kind === "permission" && question.parkId !== null) {
      // The question of a `needs-permission` park (DIPO-75): the answer resumes the run.
      if (args.decision === undefined) throw decisionMissing();
      return answerParkQuestion(
        {
          now: () => this.#deps.clock.now(),
          ...(this.#deps.parks === undefined ? {} : { resumer: this.#deps.parks }),
          ...(this.#deps.scheduling === undefined ? {} : { scheduling: this.#deps.scheduling }),
          closing: (handle, closed, at, answer) => this.#closingEntries(handle, closed, at, answer),
        },
        ctx,
        question,
        { text: args.text, decision: args.decision },
      );
    }
    if (question.kind === "question" && question.parkId !== null) {
      // A live worker question its run's park took over (DIPO-272).
      return this.#answerParkedWorker(ctx, question, args);
    }
    if (question.kind === "question" && question.parkId === null && question.hook === null) {
      // A worker report's question asked live (DIPO-272).
      if (!this.#workerQuestions.has(question.questionId)) {
        throw new CommandError(QUESTION_CLOSED, `${args.question} is not waiting for an answer.`, {
          question: args.question,
        });
      }
      return this.#answerWorker(ctx, question, args);
    }
    if (question.kind !== "permission" || question.hook === null) {
      throw new CommandError(
        QUESTION_CLOSED,
        `${args.question} is not a permission question this engine can answer.`,
        { question: args.question },
      );
    }
    const decision = args.decision;
    if (decision === undefined) throw decisionMissing();
    // A story parked meanwhile resumes only through its park's question (DIPO-75, AC #4).
    const parked = parkedElsewhere(office, question);
    if (parked !== null) throw parked;
    let closed = false;
    const now = this.#deps.clock.now();
    ctx.commit(() => {
      closed = closeQuestion(office, question.questionId, "answered", now, {
        text: args.text,
        decision,
        delivered: "now",
      });
      return closed
        ? this.#closingEntries(office, question, now, answerOf(decision, args.text))
        : [];
    });
    if (!closed) {
      throw new CommandError(QUESTION_CLOSED, `${args.question} is not waiting for an answer.`, {
        question: args.question,
      });
    }
    this.#clearTimer(question.questionId);
    const reason = args.text.trim();
    await this.#send(office, question.runId as RunId, {
      hook: question.hook,
      decision,
      ...(decision === "deny" && reason !== "" ? { reason } : {}),
    });
    return { result: { question: question.questionId, delivered: "now" } };
  }

  /** The command `work.answer`. */
  get feature(): FeatureModule {
    return {
      name: "permission-asks",
      register: (registry) => {
        registry.addAsyncOfficeCommand({
          definition: workAnswer,
          handle: (ctx, args) => this.answer(ctx, args),
        });
        // Questions a previous daemon left open: their hook calls were answered by the host.
        registry.registerLoadStep("expire open permission questions", (ctx) => {
          // Worker questions too (DIPO-272): their worker ended with the previous daemon.
          const stale = openQuestions(ctx.office).filter(
            (question) =>
              question.parkId === null &&
              !this.#timers.has(question.questionId) &&
              !this.#workerQuestions.has(question.questionId),
          );
          // A park's question whose park ended while no engine listened (DIPO-75).
          stale.push(...staleParkQuestions(ctx.office));
          if (stale.length > 0) this.#close(ctx.office, stale, "expired");
        });
      },
    };
  }

  /**
   * Allow once (DIPO-75, 0008 section 5): a request whose tool and exact command or path equal
   * those of an answered `allow` of the run's park question, not used yet, is allowed at once and
   * the allow is spent. True when it was.
   */
  #allowOnce(office: OfficeHandle, run: RunId, hook: PermissionRequest): boolean {
    if (hook.id === null || hook.exact === undefined) return false;
    const exact = hook.exact;
    const now = this.#deps.clock.now();
    const taken = office.immediate(() => takeAllowOnce(office, run, hook.tool, exact, now));
    if (taken === null) return false;
    this.#reply(office, run, { hook: hook.id, decision: "allow" });
    return true;
  }

  /** Arms the timer of a question's wait; `fire` runs when it ends. */
  #arm(office: OfficeId, questionId: string, seconds: number, fire: () => void): void {
    const timer = this.#deps.clock.setTimeout(() => {
      this.#timers.delete(questionId);
      fire();
    }, seconds * 1000);
    this.#timers.set(questionId, { office, timer });
  }

  /**
   * The wait of a question ends. The deny is sent once; a retry (`retry`, DIPO-123) only closes
   * the question, so a close that failed before is tried again without a second reply.
   */
  #timeout(officeId: OfficeId, questionId: string, seconds: number, retry = false): void {
    const office = this.#deps.offices.get(officeId);
    if (office === undefined) return;
    let question: StoredQuestion | null;
    try {
      question = findQuestion(office, questionId);
    } catch (error) {
      // Without the question its hook is unknown; the host gives no decision when its wait ends.
      this.#deps.warn?.("reading a timed-out permission question failed", {
        question: questionId,
        ...failureFields(error),
      });
      return;
    }
    if (question === null || question.closedAt !== null || question.hook === null) return;
    try {
      this.#close(office, [question], "timeout");
    } catch (error) {
      this.#deps.warn?.("closing a timed-out permission question failed", {
        question: questionId,
        run: question.runId,
        ...failureFields(error),
      });
      // The question stays open: its timer is armed again and only the close is retried (DIPO-123).
      this.#arm(officeId, questionId, seconds, () =>
        this.#timeout(officeId, questionId, seconds, true),
      );
    }
    if (retry) return;
    this.#reply(
      office,
      question.runId as RunId,
      {
        hook: question.hook,
        decision: "deny",
        reason: `The maintainer did not answer within ${seconds} s.`,
      },
      true,
    );
  }

  /**
   * Closes `questions` as `how` in one transaction, with their entries, and stops their timers once
   * it committed. Returns the questions this call closed.
   */
  #close(
    office: OfficeHandle,
    questions: readonly StoredQuestion[],
    how: QuestionClose,
  ): StoredQuestion[] {
    const now = this.#deps.clock.now();
    const closed: StoredQuestion[] = [];
    const appended = office.immediate(() => {
      closed.length = 0;
      const entries: NewEntry[] = [];
      for (const question of questions) {
        if (!closeQuestion(office, question.questionId, how, now)) continue;
        closed.push(question);
        entries.push(...this.#closingEntries(office, question, now));
      }
      const ready = withWorkViews(office, entries);
      appendEntries(office, ready, { at: now });
      return ready.length;
    });
    for (const question of questions) this.#clearTimer(question.questionId);
    if (appended > 0) this.#deps.onChanged?.(office.officeId);
    return closed;
  }

  /**
   * `question.closed`, and `work.observed input-wait` cleared once no permission or live worker
   * question of the run waits any more. Runs inside the caller's transaction, after the question was closed.
   */
  #closingEntries(
    office: OfficeHandle,
    question: StoredQuestion,
    at: number,
    answer?: string,
  ): NewEntry[] {
    const run = question.runId as RunId;
    const work = workRefOf(office, run);
    const entries: NewEntry[] = [
      {
        type: "question.closed",
        ...(work === null ? {} : { key: work.key }),
        run,
        delta: { question: question.questionId, ...(answer === undefined ? {} : { answer }) },
      },
    ];
    const waiting = openQuestions(office, run).some(
      (open) =>
        (open.kind === "permission" && open.hook !== null) ||
        (open.kind === "question" && open.parkId === null),
    );
    if (waiting || !activeSignals(office, run).some((s) => s.signal === "input-wait")) {
      return entries;
    }
    for (const cleared of clearSignals(office, run, ["input-wait"], at)) {
      if (work === null) continue;
      entries.push({
        type: "work.observed",
        key: work.key,
        run,
        delta: {
          work,
          signal: cleared.signal,
          since: new Date(cleared.since).toISOString(),
          clearedAt: new Date(at).toISOString(),
        },
      });
    }
    return entries;
  }

  #clearTimer(questionId: string): void {
    const live = this.#timers.get(questionId);
    if (live === undefined) return;
    this.#deps.clock.clearTimeout(live.timer);
    this.#timers.delete(questionId);
  }

  /**
   * Sends a reply without waiting for it. The notice of a reply that did not arrive is written in
   * the job too; a failure there is logged, never an unhandled rejection (DIPO-110).
   */
  #reply(office: OfficeHandle, run: RunId, reply: HookReply, timedOut = false): void {
    background(() => this.#send(office, run, reply, timedOut), {
      failed: "sending a permission decision failed",
      fields: { run, hook: reply.hook },
      log: this.#deps.warn,
      inflight: this.#inflight,
    });
  }

  /** Sends a reply to the run's worker host; a failure puts a notice on the office. */
  async #send(office: OfficeHandle, run: RunId, reply: HookReply, timedOut = false): Promise<void> {
    let error: string | null = null;
    let code: string | undefined;
    try {
      const sent = await this.#deps.steering.send(
        office,
        run,
        this.#deps.encode({ kind: "hookReply", reply }),
      );
      if (!sent.ok) {
        error = sent.reason;
        code = sent.code;
      }
    } catch (thrown) {
      error = messageOf(thrown);
    }
    if (error === null) return;
    // A timeout reply the host no longer holds a call for: the call was answered already (the
    // worker exited, or the host gave up), so there is nothing to report.
    if (timedOut && code === HOOK_GONE) return;
    this.#deps.warn?.("a permission decision did not reach the worker host", {
      run,
      hook: reply.hook,
      reason: error,
    });
    // No decision is the default the host gives anyway; only a maintainer's answer is worth a
    // notice.
    if (reply.decision === null) return;
    const at = this.#deps.clock.now();
    const work = workRefOf(office, run);
    office.immediate(() =>
      appendEntries(
        office,
        [
          {
            type: "engine.notice",
            ...(work === null ? {} : { key: work.key }),
            run,
            delta: {
              level: "warn",
              code: REPLY_NOT_SENT,
              text: `${work?.story ?? run}: dipo could not send the ${decisionWord(reply.decision)} to its worker (${error}); the worker's call was denied.`,
            },
          },
        ],
        { at },
      ),
    );
    this.#deps.onChanged?.(office.officeId);
  }
}

/** The trimmed answer text of `work.answer` on a worker question; refuses a decision or no text. */
function workerAnswerTextOf(args: {
  readonly text: string;
  readonly decision?: "allow" | "deny" | undefined;
}): string {
  if (args.decision !== undefined) {
    throw new CommandError(
      "args.invalid",
      "A worker question takes an answer text, not a decision.",
      {
        field: "decision",
      },
    );
  }
  const text = args.text.trim();
  if (text === "") {
    throw new CommandError("args.invalid", "A worker question needs an answer text.", {
      field: "text",
    });
  }
  return text;
}

/** `args.invalid` for a permission answer without `decision` (DIPO-59, and DIPO-75 AC #7). */
function decisionMissing(): CommandError {
  return new CommandError("args.invalid", "A permission question needs decision allow or deny.", {
    field: "decision",
  });
}

function decisionWord(decision: PermissionDecision): string {
  return decision === "allow" ? "allow" : "deny";
}

/** The answer `question.closed` carries: the decision, and the maintainer's text after it. */
export function answerOf(decision: "allow" | "deny", text: string): string {
  const reason = text.trim();
  return reason === "" ? decision : `${decision}: ${reason}`;
}
