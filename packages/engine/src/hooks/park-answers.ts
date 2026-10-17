// `work.answer` on the permission question of a `needs-permission` park (0008 sections 5 and 8,
// DIPO-75; M0 breakdown decision D10). The park (DIPO-50) stored the question with the recorded
// tool and action; the maintainer answers it with a decision:
//
// - Allow once: the park is lifted and the run's session resumes (`Resumption.resumePark`) with a
//   message naming the call. For that run only, the first permission request whose tool and exact
//   command or path equal the recorded ones is allowed (`takeAllowOnce`, called by the permission
//   wait); never a prefix or glob, never saved as a rule or for a later run, and never a change
//   to the sandbox.
// - Deny: the session resumes with "do it without <action>".
//
// The answer needs `decision` (DIPO-59's rule, `args.invalid` without one). It resumes only a
// story whose open park is the question's `needs-permission` park; a question of a story parked for
// another reason fails naming that reason and the story stays Parked. Resuming any other parked
// story stays M1 (`work.resume` answers `story.notPausedOrParked`, 0005 amendment of DIPO-61).

import type { OfficeId, RunId } from "@dipsaus-orchestrator/contract";

import type { NewEntry } from "../changelog/log";
import { CommandError } from "../commands/errors";
import type { AsyncCommandContext, CommandOutcome } from "../commands/registry";
import type { OfficeHandle } from "../db/office";
import type { ResumeParkOutcome, ResumeParkRequest } from "../run/outcome-types";
import { openPark } from "../run/park";
import { findRun } from "../run/records";
import { resumeVia } from "../run/resumption";

import { closeQuestion, openQuestions, type StoredQuestion } from "./questions";

/** The error of `work.answer` for a question that is not waiting (0005 section 4). */
const QUESTION_CLOSED = "question.closed";

/** `work.resume` and resume to In Progress while the parked worker has not exited (0005, 0006). */
const RUN_HOST_ALIVE = "run.hostAlive";

/** A command that would schedule work while the daemon schedules none (0006 decision 7). */
const SCHEDULING_OFF = "scheduling.off";

/** Resumes a parked run (the real one is `Resumption.resumePark`). */
export interface ParkResumer {
  resume(office: OfficeId, run: RunId, request: ResumeParkRequest): Promise<ResumeParkOutcome>;
}

export interface ParkAnswerDeps {
  readonly now: () => number;
  readonly resumer?: ParkResumer;
  /** False while the daemon schedules no work (`safe`, `draining`); true by default. */
  readonly scheduling?: () => boolean;
  /** `question.closed` (with `answer`) and what else closing the question emits. */
  readonly closing: (
    office: OfficeHandle,
    question: StoredQuestion,
    at: number,
    answer?: string,
  ) => NewEntry[];
}

export interface ParkAnswerResult {
  question: string;
  delivered: "now" | "on-resume";
  run?: string;
}

function storyOf(office: OfficeHandle, question: StoredQuestion): string {
  return findRun(office, question.runId as RunId)?.story ?? question.runId;
}

/**
 * The refusal of `work.answer` with a decision on a question of a parked story whose open park is
 * not the question's own `needs-permission` park (AC #4), naming that park's reason; null when the
 * question's story is not parked, or parked for this question. 0005 has no closer code than
 * `question.closed`; `details.questionOpen` says what became of the question:
 *
 * - a park's question whose park ended (`closeStale`): it can never resume the story, so the caller
 *   closes it `expired` and `questionOpen` is false;
 * - a question of a live hook call: it stays open until its worker exits (then `ended`), but no
 *   answer to it resumes the parked story, and `questionOpen` is true.
 */
export function parkedElsewhere(
  office: OfficeHandle,
  question: StoredQuestion,
): CommandError | null {
  const run = findRun(office, question.runId as RunId);
  if (run === null || run.key === null) return null;
  const park = openPark(office, run.key);
  if (park === null) return null;
  if (question.parkId !== null && park.parkId === question.parkId) return null;
  const story = run.story ?? run.runId;
  const own =
    resumeVia(park.reason) === "permission-answer"
      ? openQuestions(office).find((open) => open.parkId === park.parkId)
      : undefined;
  const hint =
    own === undefined
      ? "work.answer with a decision resumes only a story parked needs-permission, through that park's own question"
      : `answer its park's question ${own.questionId} instead`;
  const questionOpen = question.parkId === null;
  const fate = questionOpen
    ? `${question.questionId} stays open until its worker exits, but no answer to it resumes the story`
    : `${question.questionId} belonged to an earlier needs-permission park of the story and is now closed`;
  return new CommandError(
    QUESTION_CLOSED,
    `${story} is parked ${park.reason} (${park.detail}), so the story stays Parked; ${fate}; ${hint}.`,
    {
      question: question.questionId,
      story,
      reason: park.reason,
      questionOpen,
      ...(own === undefined ? {} : { parkQuestion: own.questionId }),
    },
  );
}

/** `work.answer { question, text, decision }` on the question of a `needs-permission` park. */
export async function answerParkQuestion(
  deps: ParkAnswerDeps,
  ctx: AsyncCommandContext,
  question: StoredQuestion,
  args: { readonly text: string; readonly decision: "allow" | "deny" },
): Promise<CommandOutcome<ParkAnswerResult>> {
  const office = ctx.office;
  const parkId = question.parkId;
  if (parkId === null || question.tool === null || question.input === null) {
    throw new Error(`${question.questionId} is not the question of a park`);
  }
  const run = findRun(office, question.runId as RunId);
  const park = run?.key == null ? null : openPark(office, run.key);
  if (park === null || park.parkId !== parkId) {
    // The park ended another way (resumed, dropped, reconciled, replaced): the question can never
    // resume the story, so it waits no more.
    const at = deps.now();
    ctx.commit(() =>
      closeQuestion(office, question.questionId, "expired", at)
        ? deps.closing(office, question, at)
        : [],
    );
    throw (
      parkedElsewhere(office, question) ??
      new CommandError(
        QUESTION_CLOSED,
        `${question.questionId} is not waiting: ${storyOf(office, question)} is no longer parked for it.`,
        { question: question.questionId, questionOpen: false },
      )
    );
  }
  if (deps.scheduling?.() === false) {
    throw new CommandError(
      SCHEDULING_OFF,
      "Scheduling is off, so no parked story resumes; turn it on with `dipo daemon resume-scheduling` and answer again.",
      { question: question.questionId },
    );
  }
  const resumer = deps.resumer;
  if (resumer === undefined) {
    throw new Error("this engine cannot resume a parked story");
  }
  // The resumer records the answer in the transaction that reopens the run, after storing an
  // intent, so a restart in between finishes the resume (`Resumption.resumePark`).
  const outcome = await resumer.resume(office.officeId, question.runId as RunId, {
    parkId,
    question: question.questionId,
    decision: args.decision,
    text: args.text,
  });
  const story = storyOf(office, question);
  switch (outcome.kind) {
    case "busy":
      throw new CommandError(
        RUN_HOST_ALIVE,
        `${story}'s parked worker has not exited yet; answer again in a moment.`,
        { question: question.questionId, story, run: question.runId },
      );
    case "notParked":
      throw new CommandError(
        QUESTION_CLOSED,
        `${question.questionId} is not waiting: ${story} is no longer parked for it.`,
        { question: question.questionId },
      );
    case "failed":
      throw new Error(`${story} could not be resumed: ${outcome.reason}`);
    // The answer was recorded and the run reopened by the resumer, outside `ctx.commit`, so the
    // reply says itself that the state changed.
    case "started":
      return {
        result: { question: question.questionId, delivered: "on-resume", run: question.runId },
        changed: true,
      };
    case "notStarted":
      return { result: { question: question.questionId, delivered: "on-resume" }, changed: true };
  }
}

/**
 * Open park questions whose park is no longer open (resolved by a resume, a drop or reconcile
 * while no engine listened): an office load closes them as `expired`.
 */
export function staleParkQuestions(office: OfficeHandle): StoredQuestion[] {
  return openQuestions(office).filter((question) => {
    if (question.parkId === null) return false;
    const open = office.get<{ found: number }>(
      `select 1 as found from parks
        where office_id = $office_id and park_id = $park and resolved_at is null`,
      { park: question.parkId },
    );
    return open === null;
  });
}
