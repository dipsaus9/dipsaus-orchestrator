// The questions a worker asks and the answers the maintainer gives (0008 section 5, 0021 section
// 11): `work.answer` and the live rule of a worker's question.
//
// The relay of a worker's approval calls (the `PermissionRequest` hook, its live permission
// question, its timeout and allow-once answers) is gone with the developer's Mac sandbox (DIPO-240,
// 0021 section 7): a developer runs in its box with all permissions and no hooks, and a reviewer
// has no approval relay, so a call that would need approval is denied. What stays here:
//
// - The question of a `needs-permission` park (DIPO-75), which a run parked before the change may
//   still have: `work.answer` with `decision` resumes the run (`park-answers.ts`).
// - The question of a worker's report (the door's message W3, DIPO-272). Run control hands a
//   blocked report's question to `askWorker`, before it parks:
//   - With a TUI connected at that moment (`questionRoute`, DIPO-279) and the run not being ended,
//     the question is live: a question of kind `question` is stored and `question.asked` and
//     `work.observed input-wait` are emitted. The worker's turn has ended and it waits on stdin, so
//     `work.answer` with text sends the answer as its next user message (`answer`), and the
//     question closes `answered`. There is no timeout; the run's caps still run.
//   - Otherwise `askWorker` returns false and run control parks the story `ambiguous-spec` with
//     the question, as before.
//   - When the last TUI closes while it is live (DIPO-284), `presenceChanged` closes it (`ended`)
//     and parks the story with the question through `parkQuestion`.
//   - When the run ends while it is live (a cap, a stop), the park takes it over (`run/park.ts`):
//     it stays open as the park's question, and its answer is held for the first message of the
//     run's next session, as a steer to a parked story is. The story stays Parked until its park
//     resumes.
//
// A worker's exit closes its open questions (`ended`), and an office load closes the ones a
// previous daemon left (`expired`).

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
import { failureFields } from "../platform/background";
import type { RunSteering } from "../run/control";
import { recordIntent } from "../run/intents";
import { type LiveQuestions, type Presence, questionRoute } from "../run/live-question";
import { openPark } from "../run/park";
import { MAINTAINER_TAGS } from "../run/pauses";
import { findRun } from "../run/records";
import { activeSignals, clearSignals, raiseSignal } from "../run/signals";
import { withWorkViews, workRefOf } from "../views/work";
import type { HostOp, SteerOp } from "../workers/types";

import {
  answerParkQuestion,
  type ParkAnswerResult,
  type ParkResumer,
  staleParkQuestions,
} from "./park-answers";
import {
  closeQuestion,
  findQuestion,
  insertWorkerQuestion,
  openQuestions,
  type QuestionClose,
  questionViewOf,
  type StoredQuestion,
} from "./questions";

/** The error of `work.answer` for a question that is not waiting (0005 section 4). */
export const QUESTION_CLOSED = "question.closed";

/** `engine.notice` code when an answer could not reach the worker host. */
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
  /** The worker adapter's pure `encode`, which turns an answer into host ops. */
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PermissionAsks implements LiveQuestions {
  readonly #deps: PermissionAsksDeps;
  /** The worker questions asked live by this engine (DIPO-272), with their office and run. */
  readonly #workerQuestions = new Map<string, { readonly office: OfficeId; readonly run: RunId }>();
  constructor(deps: PermissionAsksDeps) {
    this.#deps = deps;
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

  /** Resolves at once: no reply to a worker host is sent in the background any more. */
  async idle(): Promise<void> {}

  /** Forgets the live worker questions; open ones are closed as `expired` at the next load. */
  close(): void {
    this.#workerQuestions.clear();
  }

  /**
   * The daemon's TUI connections changed (0021 section 11, DIPO-284). With no TUI connected any
   * more, every live worker question ends at once: it closes as `ended` and its story parks with
   * the question as one asked with no TUI does. While a TUI is still connected nothing changes.
   */
  presenceChanged(): void {
    if (this.#workerQuestions.size === 0) return;
    if (this.#deps.presence.tuiConnected()) return;
    this.#endWorkerQuestions();
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

  /**
   * `work.answer { question, text, decision? }`: a `needs-permission` park's question (DIPO-75), or
   * a worker's question, live or taken over by its park (DIPO-272).
   */
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
    // A live permission question of a relayed approval call is gone with the relay (DIPO-240); one
    // a previous daemon left open is expired at office load.
    throw new CommandError(
      QUESTION_CLOSED,
      `${args.question} is not a question this engine can answer.`,
      { question: args.question },
    );
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
              question.parkId === null && !this.#workerQuestions.has(question.questionId),
          );
          // A park's question whose park ended while no engine listened (DIPO-75).
          stale.push(...staleParkQuestions(ctx.office));
          if (stale.length > 0) this.#close(ctx.office, stale, "expired");
        });
      },
    };
  }

  /**
   * Closes `questions` as `how` in one transaction, with their entries. Returns the questions this
   * call closed.
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
      (open) => open.kind === "question" && open.parkId === null,
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

/** The answer `question.closed` carries: the decision, and the maintainer's text after it. */
export function answerOf(decision: "allow" | "deny", text: string): string {
  const reason = text.trim();
  return reason === "" ? decision : `${decision}: ${reason}`;
}
