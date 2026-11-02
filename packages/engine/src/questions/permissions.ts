// The questions a worker asks and the answers the maintainer gives (0008, 0020): `work.answer`.
//
// The relay of a worker's approval calls (the `PermissionRequest` hook, its live permission
// question, its timeout and allow-once answers) is gone with the developer's Mac sandbox (DIPO-240):
// a developer runs in its box with all permissions and no hooks, and a reviewer has no approval
// relay, so a call that would need approval is denied. What stays here:
//
// - The question of a worker's report (the door's message W3, DIPO-272). A blocked report with a
//   question parks its story `ambiguous-spec` at once, whichever client is connected (0001,
//   0020): the park asks the question itself (`run/park.ts`), and no worker waits on stdin for it.
// - An answer to a question of a park: on an `ambiguous-spec` park, the answer resumes the park
//   (`QuestionParkResumer`, the `work.resume` path with the answer as its note:
//   `feedback/answer.md` first, the answer written as a resolved unknown). On any other park that
//   carries a worker question (one an earlier binary asked live), the answer is held for the first
//   message of the run's next session, as a steer to a parked story is.
//
// An office load closes the questions a previous daemon left open with no park (`expired`), each
// with its `question.closed`; a park resolved in any way expires the questions it carried
// (`resolvePark`).

import { type Clock, type OfficeId, type RunId, workAnswer } from "@dipsaus-orchestrator/contract";
import type { z } from "zod";

import { appendEntries, type NewEntry } from "../changelog/log";
import { CommandError } from "../commands/errors";
import type { AsyncCommandContext, CommandOutcome, FeatureModule } from "../commands/registry";
import type { OfficeHandle } from "../db/office";
import { sendFeedback } from "../run/feedback";
import { openPark } from "../run/park";
import type { ParkStore } from "../records/park-state";
import { findRun, type StoredRun } from "../records/run-records";
import { withWorkViews, workRefOf } from "../views/work";

import {
  closeQuestion,
  findQuestion,
  openQuestions,
  type QuestionClose,
  type StoredQuestion,
} from "../run-state/questions";

/** What `work.answer` replies. */
type AnswerResult = z.input<typeof workAnswer.result>;

/** The error of `work.answer` for a question that is not waiting (0005). */
export const QUESTION_CLOSED = "question.closed";

/** An open park of a story, as `openPark` returns it. */
export type OpenPark = NonNullable<ReturnType<typeof openPark>>;

/**
 * The resume of an `ambiguous-spec` park by its answer (0020, DIPO-159): `work.resume`'s park path
 * with the answer as the note. The resumption provides it.
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
  /** Resumes an `ambiguous-spec` question park with its answer (DIPO-159). */
  readonly questionParks?: () => QuestionParkResumer | undefined;
  /** Called after change-log entries were appended outside a command. */
  readonly onChanged?: (office: OfficeId) => void;
}

/** The first line of the user message that carries the maintainer's answer to a worker question. */
export const WORKER_ANSWER_INTRO = "The maintainer answered your question:";

/** The user message that carries the maintainer's answer to the worker's question. */
export function workerAnswerText(text: string): string {
  return `${WORKER_ANSWER_INTRO}\n\n${text.trim()}`;
}

export class PermissionAsks {
  readonly #deps: PermissionAsksDeps;
  constructor(deps: PermissionAsksDeps) {
    this.#deps = deps;
  }

  /**
   * `work.answer { question, text }` on a worker question a park other than a question park
   * carries (one an earlier binary asked live, then a cap or a stop parked the run, DIPO-272): the
   * answer is recorded and held for the first message of the run's next session through the one
   * feedback path (`sendFeedback`, source `answer`), as a steer to a parked story is; the story
   * stays Parked until its park is resumed.
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

  /** `work.answer { question, text }`: a worker's question its run's park carries (DIPO-159). */
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
      return this.#answerParkedWorker(ctx, question, args);
    }
    // Every worker question parks (0020), so an open one without a park is one a previous daemon
    // left; office load expires it, as it does a permission question of the relay (DIPO-240).
    throw new CommandError(
      QUESTION_CLOSED,
      `${args.question} is not a question this engine can answer.`,
      { question: args.question },
    );
  }

  /** The command `work.answer`. */
  get feature(): FeatureModule {
    return {
      name: "questions",
      register: (registry) => {
        registry.addAsyncOfficeCommand({
          definition: workAnswer,
          handle: (ctx, args) => this.answer(ctx, args),
        });
        // Questions a previous daemon left open with no park: nothing waits on them.
        registry.registerLoadStep("expire open permission questions", (ctx) => {
          const stale = openQuestions(ctx.office).filter((question) => question.parkId === null);
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
