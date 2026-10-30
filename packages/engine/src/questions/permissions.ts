// The questions a worker asks and the answers the maintainer gives (0008 section 5, 0020 section 7,
// 0021 section 11): `work.answer` and the live rule of a worker's question.
//
// The relay of a worker's approval calls (the `PermissionRequest` hook, its live permission
// question, its timeout and allow-once answers) is gone with the developer's Mac sandbox (DIPO-240,
// 0021 section 7): a developer runs in its box with all permissions and no hooks, and a reviewer
// has no approval relay, so a call that would need approval is denied. What stays here:
//
// - The question of a worker's report (the door's message W3, DIPO-272, DIPO-159). Run control
//   hands a blocked report's question to `askWorker`, before it parks:
//   - With a TUI connected at that moment (`questionRoute`, DIPO-279), the run not being ended and
//     a wait above zero, the question is live: a question of kind `question` is stored with the end
//     of its wait (`asked_at` plus `timeouts.questionWaitMinutes`), and `question.asked` is emitted;
//     the run shows no health of its own for it (0009). The worker's turn has ended and it waits
//     on stdin, holding the worker place; the wait is left out of the run's minute cap
//     (`questionWaitMs`).
//     `work.answer` with text sends the answer as its next user message (`answer`, delivered
//     `now`), and the question closes `answered`.
//   - Otherwise `askWorker` returns false and run control parks the story `ambiguous-spec`; the
//     park asks the question itself (`run/park.ts`).
//   - When its wait ends with no answer, or the last TUI closes while it is live (DIPO-284), the
//     question is let go, still open: `parkQuestion` closes the worker's stdin and parks the story
//     `ambiguous-spec`, and the park carries the question.
//   - When the run ends while it is live (a cap, a stop), or the worker exits on its own, the park
//     the run's end or exit decision makes carries it. When no park follows an exit, the question
//     closes `ended` after the exit decision (`afterExit`).
// - An answer to a question of a park: on an `ambiguous-spec` park, the answer
//   resumes the park (`QuestionParkResumer`, the `work.resume` path with the answer as its
//   note: `feedback/answer.md` first, the answer written as a resolved unknown). On any other park
//   (a cap or a stop that carried it), and on a question let go by a run being ended that no park
//   has carried yet, the answer is held for the first message of the run's next session, as a
//   steer to a parked story is; so is an answer that comes after a cap or stop began, before the
//   run's end is ingested, instead of going to the stopping worker.
//
// An office load closes the questions a previous daemon left open (`expired`), each with its
// `question.closed`; a park resolved in any way expires the questions it carried (`resolvePark`).

import {
  type Clock,
  type IdSource,
  type OfficeId,
  type RunId,
  type TimerHandle,
  workAnswer,
} from "@dipsaus-orchestrator/contract";
import type { z } from "zod";

import { appendEntries, type NewEntry } from "../changelog/log";
import { CommandError } from "../commands/errors";
import type { AsyncCommandContext, CommandOutcome, FeatureModule } from "../commands/registry";
import type { OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import { failureFields } from "../platform/background";
import type { RunSteering } from "../run/control";
import { type LiveQuestions, type Presence, questionRoute } from "../records/live-question";
import { sendFeedback } from "../run/feedback";
import { openPark } from "../run/park";
import type { ParkStore } from "../records/park-state";
import { findRun, type StoredRun } from "../records/run-records";
import { withWorkViews, workRefOf } from "../views/work";
import type { HostOp, SteerOp } from "../workers/types";

import {
  closeQuestion,
  findQuestion,
  insertWorkerQuestion,
  openQuestions,
  type QuestionClose,
  questionViewOf,
  type StoredQuestion,
} from "./questions";

/** What `work.answer` replies. */
type AnswerResult = z.input<typeof workAnswer.result>;

/** The error of `work.answer` for a question that is not waiting (0005 section 4). */
export const QUESTION_CLOSED = "question.closed";

/** `engine.notice` code when an answer could not reach the worker host. */
export const REPLY_NOT_SENT = "run.hookReplyNotSent";

/** `timeouts.questionWaitMinutes` when the office has no configuration (0008 section 6). */
export const QUESTION_WAIT_MINUTES_DEFAULT = 15;

export { ABSENT, type Presence } from "../records/live-question";

/** An open park of a story, as `openPark` returns it. */
export type OpenPark = NonNullable<ReturnType<typeof openPark>>;

/**
 * The resume of an `ambiguous-spec` park by its answer (0020 sections 2 and
 * 7, DIPO-159): `work.resume`'s park path with the answer as the note. The resumption provides it.
 */
export interface QuestionParkResumer {
  /** Resumes `park` of `run` with `answer`; refusals are `work.resume`'s `CommandError`s. */
  resume(
    ctx: AsyncCommandContext,
    run: StoredRun,
    park: OpenPark,
    answer: string,
  ): Promise<{ readonly run?: string; readonly queued?: boolean }>;
  /**
   * A retry of a request whose question park resume was stored (a crash before its reply): its
   * resume finished when it was not; null when the request stored none.
   */
  replay(ctx: AsyncCommandContext, run: StoredRun): Promise<{ readonly run?: string } | null>;
}

export interface PermissionAsksDeps {
  /** The story store: the park a pending planning change writes (`plannedPark`, 0010). */
  readonly stories: ParkStore;
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
  /** Resumes an `ambiguous-spec` question park with its answer (DIPO-159). */
  readonly questionParks?: () => QuestionParkResumer | undefined;
  /**
   * True when every worker exit is decided by worker outcomes and `afterExit` follows the decision
   * (DIPO-159): a worker question open at the exit is then left to the park the decision makes.
   * False by default: the exit closes it at once.
   */
  readonly exitDecides?: boolean;
  /** False while the daemon schedules no work (`draining`); true by default. */
  readonly scheduling?: () => boolean;
  /** Called after change-log entries were appended outside a command. */
  readonly onChanged?: (office: OfficeId) => void;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
  /**
   * Parks the story of `run` `ambiguous-spec` with its worker's question once that question stopped
   * being live (its wait ended, or the last TUI closed, DIPO-284); run control's `parkOnQuestion`.
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

/** A worker question asked live by this engine: its office, run and the timer of its wait. */
interface LiveQuestion {
  readonly office: OfficeId;
  readonly run: RunId;
  readonly timer: TimerHandle | null;
}

export class PermissionAsks implements LiveQuestions {
  readonly #deps: PermissionAsksDeps;
  /** The worker questions asked live by this engine (DIPO-272), with their wait (DIPO-159). */
  readonly #workerQuestions = new Map<string, LiveQuestion>();
  constructor(deps: PermissionAsksDeps) {
    this.#deps = deps;
  }

  /** Forgets the live question `questionId` and stops its wait; returns what it was. */
  #forget(questionId: string): LiveQuestion | undefined {
    const live = this.#workerQuestions.get(questionId);
    if (live === undefined) return undefined;
    this.#workerQuestions.delete(questionId);
    if (live.timer !== null) this.#deps.clock.clearTimeout(live.timer);
    return live;
  }

  /**
   * The worker of `run` exited: its live questions stop being live. A park's question (DIPO-75)
   * waits for the maintainer after its worker exited, and so does a worker question when the run is
   * being ended or the exit is decided (`exitDecides`): the park that follows carries it, else
   * `afterExit` closes it. Every other open question closes `ended`.
   */
  onEnded(office: OfficeHandle, run: string): void {
    for (const [questionId, live] of this.#workerQuestions) {
      if (live.run === run) this.#forget(questionId);
    }
    const kept = this.#deps.exitDecides === true || this.#deps.ending?.(run) === true;
    const open = openQuestions(office, run).filter(
      (question) => question.parkId === null && !(kept && question.kind === "question"),
    );
    if (open.length === 0) return;
    this.#close(office, open, "ended");
  }

  /**
   * After the exit decision of `run` (DIPO-159): a worker question that no park carried and that is
   * not live closes `ended`, since nothing waits for its answer any more.
   */
  afterExit(officeId: OfficeId, run: string): void {
    const office = this.#deps.offices.get(officeId);
    if (office === undefined) return;
    try {
      const open = openQuestions(office, run).filter(
        (question) =>
          question.kind === "question" &&
          question.parkId === null &&
          !this.#workerQuestions.has(question.questionId),
      );
      if (open.length > 0) this.#close(office, open, "ended");
    } catch (error) {
      this.#deps.warn?.("closing a worker question after its exit decision failed", {
        office: officeId,
        run,
        ...failureFields(error),
      });
    }
  }

  /** Resolves at once: no reply to a worker host is sent in the background any more. */
  async idle(): Promise<void> {}

  /** Forgets the live worker questions; open ones are closed as `expired` at the next load. */
  close(): void {
    for (const questionId of this.#workerQuestions.keys()) this.#forget(questionId);
  }

  /**
   * The daemon's TUI connections changed (0021 section 11, DIPO-284). With no TUI connected any
   * more, every live worker question is let go at once and its story parks with it, as one asked
   * with no TUI does. While a TUI is still connected nothing changes.
   */
  presenceChanged(): void {
    if (this.#workerQuestions.size === 0) return;
    if (this.#deps.presence.tuiConnected()) return;
    this.#letGo([...this.#workerQuestions.keys()]);
  }

  /**
   * Lets the live questions `ids` go (their wait ended, or the last TUI closed): each stays open,
   * and its story parks with it (`parkQuestion`), whose park carries it.
   * A run being ended already parks: that park carries it.
   */
  #letGo(ids: readonly string[]): void {
    for (const questionId of ids) {
      const live = this.#forget(questionId);
      if (live === undefined) continue;
      if (this.#deps.ending?.(live.run) === true) continue;
      const office = this.#deps.offices.get(live.office);
      if (office === undefined) continue;
      const question = findQuestion(office, questionId);
      if (question === null || question.closedAt !== null) continue;
      this.#deps.parkQuestion?.(live.office, live.run, question.text);
    }
  }

  /** The wait of a live question ended with no answer (0020 section 7): its story parks. */
  #waitEnded(questionId: string): void {
    this.#letGo([questionId]);
  }

  /** The live wait of the office's worker questions, in ms; 0 parks every question at once. */
  #waitMs(office: OfficeId): number {
    const minutes =
      this.#deps.offices.config(office)?.timeouts.questionWaitMinutes ??
      QUESTION_WAIT_MINUTES_DEFAULT;
    return Math.max(0, minutes) * 60_000;
  }

  /**
   * The question of a worker's report (DIPO-272): asked live when a TUI is connected now, the run
   * is not being ended and the wait is above zero, and then true; false when the story must park
   * (see the file comment).
   */
  askWorker(office: OfficeHandle, run: RunId, agent: string, text: string): boolean {
    const work = workRefOf(office, run);
    const waitMs = this.#waitMs(office.officeId as OfficeId);
    const allowed = work !== null && waitMs > 0 && this.#deps.ending?.(run) !== true;
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
          waitUntil: now + waitMs,
        });
        const view = questionViewOf(office, question);
        const entries: NewEntry[] = [];
        if (view !== null)
          entries.push({ type: "question.asked", key: work.key, run, delta: view });
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
    const timer = this.#deps.clock.setTimeout(() => this.#waitEnded(questionId), waitMs);
    this.#workerQuestions.set(questionId, { office: office.officeId as OfficeId, run, timer });
    if (appended > 0) this.#deps.onChanged?.(office.officeId);
    return true;
  }

  /**
   * `work.answer { question, text }` on a worker question no live worker waits on (DIPO-272,
   * DIPO-159): its run is being ended (a cap or stop began, its end not ingested yet), its run let
   * it go and no park carried it yet, or a park other than a question park carried it. The answer
   * is recorded and held for the first message of the run's next session through the one feedback
   * path (`sendFeedback`, source `answer`), as a steer to a parked story is; a parked story stays Parked until its park is resumed.
   */
  async #answerHeld(
    ctx: AsyncCommandContext,
    question: StoredQuestion,
    text: string,
  ): Promise<CommandOutcome<AnswerResult>> {
    const office = ctx.office;
    const now = this.#deps.clock.now();
    let closed = false;
    ctx.commit(() => {
      closed = closeQuestion(office, question.questionId, "answered", now, {
        text,
        decision: null,
        delivered: "on-resume",
      });
      if (!closed) return [];
      sendFeedback(
        office,
        question.runId,
        { source: "answer", text: workerAnswerText(text) },
        { at: now },
      );
      return this.#closingEntries(office, question, text);
    });
    if (!closed) {
      throw new CommandError(
        QUESTION_CLOSED,
        `${question.questionId} is not waiting for an answer.`,
        { question: question.questionId },
      );
    }
    this.#forget(question.questionId);
    return { result: { question: question.questionId, delivered: "on-resume" } };
  }

  /**
   * `work.answer { question, text }` on a worker question its run's park carries: an answer to the
   * question of an `ambiguous-spec` question park resumes that park (DIPO-159); on any other park
   * it is held for the next session (DIPO-272). A question whose park ended waits no more.
   */
  async #answerParkedWorker(
    ctx: AsyncCommandContext,
    question: StoredQuestion,
    args: { readonly text: string },
  ): Promise<CommandOutcome<AnswerResult>> {
    const office = ctx.office;
    const text = workerAnswerTextOf(args);
    const run = findRun(office, question.runId as RunId);
    const park = run?.key == null ? null : openPark(this.#deps.stories, office, run.key);
    const now = this.#deps.clock.now();
    if (run === null || park === null || park.parkId !== question.parkId) {
      ctx.commit(() =>
        closeQuestion(office, question.questionId, "expired", now)
          ? this.#closingEntries(office, question)
          : [],
      );
      throw new CommandError(
        QUESTION_CLOSED,
        `${question.questionId} is not waiting: its story is no longer parked for it.`,
        { question: question.questionId, questionOpen: false },
      );
    }
    const resumer = this.#deps.questionParks?.();
    if (resumer !== undefined && park.reason === "ambiguous-spec") {
      // The answer resumes the question park, as `dipo resume <id> --note <answer>` does.
      const resumed = await resumer.resume(ctx, run, park, text);
      return {
        result: {
          question: question.questionId,
          delivered: "on-resume",
          ...(resumed.run === undefined ? {} : { run: resumed.run }),
        },
      };
    }
    return this.#answerHeld(ctx, question, text);
  }

  /** `work.answer { question, text }` on a live worker question: the answer goes to the worker now. */
  async #answerWorker(
    ctx: AsyncCommandContext,
    question: StoredQuestion,
    text: string,
  ): Promise<CommandOutcome<AnswerResult>> {
    const office = ctx.office;
    let closed = false;
    const now = this.#deps.clock.now();
    ctx.commit(() => {
      closed = closeQuestion(office, question.questionId, "answered", now, {
        text,
        decision: null,
        delivered: "now",
      });
      return closed ? this.#closingEntries(office, question, text) : [];
    });
    if (!closed) {
      throw new CommandError(
        QUESTION_CLOSED,
        `${question.questionId} is not waiting for an answer.`,
        { question: question.questionId },
      );
    }
    this.#forget(question.questionId);
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
   * `work.answer { question, text }`: a worker's question, live, let go or carried by its run's park (DIPO-272, DIPO-159).
   */
  async answer(
    ctx: AsyncCommandContext,
    args: {
      readonly question: string;
      readonly text: string;
    },
  ): Promise<CommandOutcome<AnswerResult>> {
    const office = ctx.office;
    const question = findQuestion(office, args.question);
    if (question?.kind === "question" && question.parkId !== null) {
      // A retry of a request whose answer resumed the question park repeats nothing.
      const run = findRun(office, question.runId as RunId);
      const replayed = run === null ? null : await this.#deps.questionParks?.()?.replay(ctx, run);
      if (replayed != null) {
        return {
          result: {
            question: question.questionId,
            delivered: "on-resume",
            ...(replayed.run === undefined ? {} : { run: replayed.run }),
          },
          changed: false,
        };
      }
    }
    if (question === null || question.closedAt !== null) {
      throw new CommandError(QUESTION_CLOSED, `${args.question} is not waiting for an answer.`, {
        question: args.question,
      });
    }
    if (question.kind === "question" && question.parkId !== null) {
      // A worker question its run's park carries (DIPO-272, DIPO-159).
      return this.#answerParkedWorker(ctx, question, args);
    }
    if (question.kind === "question" && question.parkId === null && question.hook === null) {
      const text = workerAnswerTextOf(args);
      // A worker waits on stdin for it, and its run is not being ended: the answer goes now.
      const live = this.#workerQuestions.get(question.questionId);
      if (live !== undefined && this.#deps.ending?.(live.run) !== true) {
        return this.#answerWorker(ctx, question, text);
      }
      // A cap or stop began, or the run let it go before a park carried it: held (DIPO-159).
      return this.#answerHeld(ctx, question, text);
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
          // A park's question whose park ended, and the question of a park from before every
          // answer was text (DIPO-344): nothing waits on either.
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
        entries.push(...this.#closingEntries(office, question));
      }
      const ready = withWorkViews(office, entries);
      appendEntries(office, ready, { at: now });
      return ready.length;
    });
    if (appended > 0) this.#deps.onChanged?.(office.officeId);
    return closed;
  }

  /**
   * `question.closed` of a closed question. Runs inside the caller's transaction, after the question
   * was closed.
   */
  #closingEntries(office: OfficeHandle, question: StoredQuestion, answer?: string): NewEntry[] {
    const run = question.runId as RunId;
    const work = workRefOf(office, run);
    return [
      {
        type: "question.closed",
        ...(work === null ? {} : { key: work.key }),
        run,
        delta: { question: question.questionId, ...(answer === undefined ? {} : { answer }) },
      },
    ];
  }
}

/** The trimmed answer text of `work.answer` on a worker question; refuses an empty one. */
function workerAnswerTextOf(args: { readonly text: string }): string {
  const text = args.text.trim();
  if (text === "") {
    throw new CommandError("args.invalid", "A worker question needs an answer text.", {
      field: "text",
    });
  }
  return text;
}

/**
 * The open questions of a park that no longer waits on them: its park was resolved, or it is a
 * permission question, which no answer resumes any more (DIPO-344). Kept open, the desk would
 * still show them.
 */
function staleParkQuestions(office: OfficeHandle): StoredQuestion[] {
  return openQuestions(office).filter((question) => {
    if (question.parkId === null) return false;
    if (question.kind === "permission") return true;
    const open = office.get(
      `select 1 as found from parks where office_id = $office_id and park_id = $park
        and resolved_at is null`,
      { park: question.parkId },
    );
    return open === null;
  });
}
