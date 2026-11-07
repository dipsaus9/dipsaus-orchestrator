// The questions of a planning session (DIPO-455, 0022), pure. The session asks the maintainer in its
// answer as a fenced block with the info string `dipo-questions` holding one JSON object
// (`PLANNING_QUESTIONS_FENCE`). At each turn end the engine reads every block of the answer like a
// proposal block (`planning-proposals.ts`): held to `QUESTIONS_BLOCK_MAX_CHARS`, cleaned at the door
// (0008), then held to the contract's `PlanningQuestions` schema. A block that fails is refused with
// its problems, which go back to the session as one message (`questionsRefusalMessage`).
//
// The maintainer's answers go back as one message (`answersMessage`); each is a choice for the
// session's record.

import {
  cleanText,
  PLANNING_QUESTIONS_FENCE,
  PlanningQuestions,
  type PlanningQuestion,
} from "@dipsaus-orchestrator/contract";

import { cleanDoorStrings, doorKeysClean } from "../box/door";
import { toJsonSchema } from "../workers/json-schema";
import type { JsonSchema } from "../workers/types";

import { fencedBlocks } from "./planning-proposals";

/** The largest question block, in characters of JSON, before it is parsed. */
export const QUESTIONS_BLOCK_MAX_CHARS = 16_000;

/** The JSON Schema of a question block, which the first message gives the session. */
export const PLANNING_QUESTIONS_JSON_SCHEMA: JsonSchema = toJsonSchema(PlanningQuestions, "input");

/** One block read from an answer: valid questions, or why it was refused. */
export type QuestionsRead =
  | { readonly ok: true; readonly questions: readonly PlanningQuestion[] }
  | { readonly ok: false; readonly problems: readonly string[] };

/** Pure: every question block of an answer, read and checked. */
export function readQuestionBlocks(text: string): QuestionsRead[] {
  return fencedBlocks(text, PLANNING_QUESTIONS_FENCE).map((block): QuestionsRead => {
    if (block === null) return { ok: false, problems: ["the block is not closed with ```"] };
    if (block.length > QUESTIONS_BLOCK_MAX_CHARS) {
      return {
        ok: false,
        problems: [
          `the block has ${block.length} characters; at most ${QUESTIONS_BLOCK_MAX_CHARS}`,
        ],
      };
    }
    let value: unknown;
    try {
      value = JSON.parse(block);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return { ok: false, problems: [`the block is not one JSON object: ${cleanText(why)}`] };
    }
    if (!doorKeysClean(value)) {
      return { ok: false, problems: ["a key holds characters dipo does not accept"] };
    }
    const parsed = PlanningQuestions.safeParse(cleanDoorStrings(value));
    if (!parsed.success) {
      return {
        ok: false,
        problems: parsed.error.issues.map(
          (issue) => `${issue.path.join(".") || "questions"}: ${issue.message}`,
        ),
      };
    }
    return { ok: true, questions: parsed.data.questions };
  });
}

/** Pure: the message that tells the session which question blocks of its answer were refused. */
export function questionsRefusalMessage(refused: readonly (readonly string[])[]): string {
  const lines = refused.map(
    (problems, index) => `- block ${index + 1} of the refused ones: ${problems.join("; ")}`,
  );
  return [
    `[dipo] dipo refused ${refused.length === 1 ? "a question block" : `${refused.length} question blocks`} of your last answer, so the maintainer cannot answer ${refused.length === 1 ? "it" : "them"}. Write each again as one \`\`\`${PLANNING_QUESTIONS_FENCE} block holding one JSON object that passes the question schema of your first message:`,
    ...lines,
  ].join("\n");
}

/** One answer: an option of the question (its index) or a free text. */
export type QuestionAnswer = { readonly option: number } | { readonly free: string };

/** The answers as text, one per question, or why they do not fit the questions. */
export type AnswersRead =
  | { readonly ok: true; readonly answers: readonly string[] }
  | { readonly ok: false; readonly problem: string };

/** Pure: the text of each answer; an answer for every question and an option that exists. */
export function readAnswers(
  questions: readonly PlanningQuestion[],
  answers: readonly QuestionAnswer[],
): AnswersRead {
  if (answers.length !== questions.length) {
    return {
      ok: false,
      problem: `the block has ${questions.length} questions and ${answers.length} answers were given`,
    };
  }
  const texts: string[] = [];
  for (const [index, answer] of answers.entries()) {
    if ("free" in answer) {
      texts.push(answer.free);
      continue;
    }
    const option = questions[index]?.options[answer.option];
    if (option === undefined) {
      return { ok: false, problem: `question ${index + 1} has no option ${answer.option + 1}` };
    }
    texts.push(option.label);
  }
  return { ok: true, answers: texts };
}

/** Pure: the one message that carries the maintainer's answers to the session. */
export function answersMessage(
  questions: readonly PlanningQuestion[],
  answers: readonly string[],
): string {
  return [
    "[dipo] The maintainer answered your questions:",
    ...questions.map(
      (question, index) => `- ${question.header} (${question.question}): ${answers[index] ?? ""}`,
    ),
  ].join("\n");
}
