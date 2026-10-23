// The `questions` table (0007 section 4, migrations 22 and 23) and its views (0005 `QuestionView`): what the
// engine asks the maintainer for a run's agent, and how each question stopped waiting. The writers
// run inside the caller's immediate transaction; nothing here sends anything.

import {
  type QuestionKind,
  QuestionId,
  type QuestionView,
  type RunId,
  type StoryKey,
} from "@dipsaus-orchestrator/contract";

import type { NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import { workRefOf } from "../views/work";

import type { PermissionDecision } from "./types";

/** How a question stopped waiting (migration 22). */
export type QuestionClose = "answered" | "timeout" | "ended" | "expired";

export interface StoredQuestion {
  readonly questionId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly kind: QuestionKind;
  readonly text: string;
  readonly tool: string | null;
  readonly input: string | null;
  /** The waiting hook call's id, for a permission question. */
  readonly hook: number | null;
  readonly askedAt: number;
  readonly answer: string | null;
  readonly decision: Exclude<PermissionDecision, null> | null;
  readonly closedAt: number | null;
  readonly closedHow: QuestionClose | null;
  /** The park the question belongs to, for the question of a `needs-permission` park (DIPO-75). */
  readonly parkId: number | null;
  /** When an allow of a park question let its one matching request through (DIPO-75). */
  readonly allowUsedAt: number | null;
}

interface QuestionRow {
  question_id: string;
  run_id: string;
  agent_id: string;
  kind: QuestionKind;
  text: string;
  tool: string | null;
  input: string | null;
  hook: number | null;
  asked_at: number;
  answer: string | null;
  decision: "allow" | "deny" | null;
  closed_at: number | null;
  closed_how: QuestionClose | null;
  park_id: number | null;
  allow_used_at: number | null;
}

const COLUMNS = `question_id, run_id, agent_id, kind, text, tool, input, hook, asked_at, answer,
  decision, closed_at, closed_how, park_id, allow_used_at`;

function stored(row: QuestionRow): StoredQuestion {
  return {
    questionId: row.question_id,
    runId: row.run_id,
    agentId: row.agent_id,
    kind: row.kind,
    text: row.text,
    tool: row.tool,
    input: row.input,
    hook: row.hook,
    askedAt: row.asked_at,
    answer: row.answer,
    decision: row.decision,
    closedAt: row.closed_at,
    closedHow: row.closed_how,
    parkId: row.park_id,
    allowUsedAt: row.allow_used_at,
  };
}

/** What the maintainer sees for a permission request: `Tool(input)`, or the tool alone. */
export function permissionText(tool: string, input: string): string {
  return input === "" ? tool : `${tool}(${input})`;
}

export interface NewWorkerQuestion {
  readonly questionId: string;
  readonly runId: string;
  readonly agentId: string;
  /** The question of the worker's report, cleaned at the door. */
  readonly text: string;
  readonly at: number;
}

/**
 * Stores the open question of a worker's report that is asked live (kind `question`, DIPO-272):
 * no tool, no hook call and no park; returns it.
 */
export function insertWorkerQuestion(
  office: OfficeHandle,
  question: NewWorkerQuestion,
): StoredQuestion {
  office.run(
    `insert into questions (office_id, question_id, run_id, agent_id, kind, text, asked_at)
     values ($office_id, $question, $run, $agent, 'question', $text, $at)`,
    {
      question: question.questionId,
      run: question.runId,
      agent: question.agentId,
      text: question.text,
      at: question.at,
    },
  );
  const row = findQuestion(office, question.questionId);
  if (row === null) throw new Error(`question ${question.questionId} was not stored`);
  return row;
}

export interface NewParkQuestion {
  readonly questionId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly parkId: number;
  /** The recorded tool and action of the `needs-permission` park. */
  readonly tool: string;
  readonly action: string;
  /** What the maintainer sees (`parkQuestionText`). */
  readonly text: string;
  readonly at: number;
}

/**
 * Stores the open permission question of a `needs-permission` park (DIPO-75, migration 23): the
 * recorded tool, the action as `input`, no hook call; returns it.
 */
export function insertParkQuestion(
  office: OfficeHandle,
  question: NewParkQuestion,
): StoredQuestion {
  office.run(
    `insert into questions (office_id, question_id, run_id, agent_id, kind, text, tool, input, hook,
       asked_at, park_id)
     values ($office_id, $question, $run, $agent, 'permission', $text, $tool, $input, null, $at,
       $park)`,
    {
      question: question.questionId,
      run: question.runId,
      agent: question.agentId,
      text: question.text,
      tool: question.tool,
      input: question.action,
      at: question.at,
      park: question.parkId,
    },
  );
  const row = findQuestion(office, question.questionId);
  if (row === null) throw new Error(`question ${question.questionId} was not stored`);
  return row;
}

/** The open questions of the park `parkId`, oldest first. */
export function openParkQuestions(office: OfficeHandle, parkId: number): StoredQuestion[] {
  return office
    .all<QuestionRow>(
      `select ${COLUMNS} from questions
        where office_id = $office_id and park_id = $park and closed_at is null
        order by asked_at, question_id`,
      { park: parkId },
    )
    .map(stored);
}

/**
 * Inside the caller's transaction (DIPO-75): records the maintainer's answer to a park's question
 * (`answered`, delivered `on-resume`) and returns its `question.closed`; nothing when the question
 * was not open.
 */
export function answeredParkQuestion(
  office: OfficeHandle,
  questionId: string,
  decision: "allow" | "deny",
  text: string,
  at: number,
): NewEntry[] {
  const question = findQuestion(office, questionId);
  if (question === null) return [];
  if (
    !closeQuestion(office, questionId, "answered", at, { text, decision, delivered: "on-resume" })
  ) {
    return [];
  }
  const reason = text.trim();
  const work = workRefOf(office, question.runId as RunId);
  return [
    {
      type: "question.closed",
      ...(work === null ? {} : { key: work.key }),
      run: question.runId as RunId,
      delta: { question: questionId, answer: reason === "" ? decision : `${decision}: ${reason}` },
    },
  ];
}

export function findQuestion(office: OfficeHandle, questionId: string): StoredQuestion | null {
  const row = office.get<QuestionRow>(
    `select ${COLUMNS} from questions where office_id = $office_id and question_id = $question`,
    { question: questionId },
  );
  return row === null ? null : stored(row);
}

/** The open questions of the office, or of one run, oldest first. */
export function openQuestions(office: OfficeHandle, runId?: string): StoredQuestion[] {
  return office
    .all<QuestionRow>(
      `select ${COLUMNS} from questions
        where office_id = $office_id and closed_at is null and ($run is null or run_id = $run)
        order by asked_at, question_id`,
      { run: runId ?? null },
    )
    .map(stored);
}

/**
 * Closes an open question at `at`; with `answer` it records the maintainer's answer. False when it
 * was not open (already closed, or unknown).
 */
export function closeQuestion(
  office: OfficeHandle,
  questionId: string,
  how: QuestionClose,
  at: number,
  answer?: {
    readonly text: string;
    readonly decision: Exclude<PermissionDecision, null> | null;
    readonly delivered: "now" | "on-resume";
  },
): boolean {
  const before = findQuestion(office, questionId);
  if (before === null || before.closedAt !== null) return false;
  office.run(
    `update questions set closed_at = $at, closed_how = $how, answer = $answer,
       decision = $decision, answered_at = $answered, delivered = $delivered
     where office_id = $office_id and question_id = $question and closed_at is null`,
    {
      at,
      how,
      answer: answer?.text ?? null,
      decision: answer?.decision ?? null,
      answered: answer === undefined ? null : at,
      delivered: answer?.delivered ?? null,
      question: questionId,
    },
  );
  return true;
}

/** The contract view of a stored question; null when its run has no work ref. */
export function questionViewOf(
  office: OfficeHandle,
  question: StoredQuestion,
): QuestionView | null {
  const work = workRefOf(office, question.runId as RunId);
  if (work === null) return null;
  return {
    question: QuestionId.parse(question.questionId),
    work,
    kind: question.kind,
    text: question.text,
    askedAt: new Date(question.askedAt).toISOString(),
  };
}

/** The open questions of the office as views, oldest first (`office.snapshot`). */
export function openQuestionViews(office: OfficeHandle): QuestionView[] {
  return openQuestions(office).flatMap((question) => {
    const view = questionViewOf(office, question);
    return view === null ? [] : [view];
  });
}

/** The open questions of the story `key` as views, oldest first (`story.detail`). */
export function storyQuestionViews(office: OfficeHandle, key: StoryKey): QuestionView[] {
  return openQuestionViews(office).filter((view) => view.work.key === key);
}
