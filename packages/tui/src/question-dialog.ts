// The dialog of a planning session's question block (DIPO-455, 0022), pure. A block holds one to
// four questions, each with its purpose, two to four described options and, always, a free answer
// as the last row. Up and Down move over the rows of the question, Enter (or the row's digit)
// picks one; on the free row Enter opens a text the maintainer types, and Enter again takes it.
// Left and Right go to the previous and next question, to change an answer. Ctrl-S sends the
// answers once every question has one (`planning.answer`); Ctrl-N leaves the block unanswered to
// write a plain message instead.

import type { PlanningQuestionBlock } from "@dipsaus-orchestrator/contract";
import type { Key } from "ink";

import { truncate } from "./format";
import type { Display } from "./options";
import { glyphs } from "./views";

/** One answer, as `planning.answer` takes it: an option's index or a free text. */
export type DialogAnswer = { readonly option: number } | { readonly free: string };

export interface DialogState {
  /** The question shown. */
  readonly index: number;
  /** The row under the cursor: an option, or the free answer after the last option. */
  readonly cursor: number;
  /** The answer of each question; null while it has none. */
  readonly answers: readonly (DialogAnswer | null)[];
  /** The free text being typed; null while the maintainer is not typing one. */
  readonly typing: string | null;
}

/** What a key did: the new state, and whether it asks to send or to leave the block. */
export interface DialogStep {
  readonly state: DialogState;
  readonly action: "send" | "dismiss" | null;
  /** A line for the footer. */
  readonly message?: string;
}

/** The cursor row a question starts on: its recommended option, else the first. */
const startRow = (block: PlanningQuestionBlock, index: number): number =>
  Math.max(
    0,
    block.questions[index]?.options.findIndex((option) => option.recommended === true) ?? 0,
  );

export const freshDialog = (block: PlanningQuestionBlock): DialogState => ({
  index: 0,
  cursor: startRow(block, 0),
  answers: block.questions.map(() => null),
  typing: null,
});

/** The answered question `index` shows its answer's row under the cursor again. */
function rowOf(block: PlanningQuestionBlock, state: DialogState, index: number): number {
  const answer = state.answers[index];
  if (answer === null || answer === undefined) return startRow(block, index);
  return "option" in answer ? answer.option : (block.questions[index]?.options.length ?? 0);
}

/** True once every question has an answer. */
export const dialogComplete = (state: DialogState): boolean =>
  state.answers.every((answer) => answer !== null);

/** The answers to send; empty until `dialogComplete`. */
export function dialogAnswers(state: DialogState): DialogAnswer[] {
  return state.answers.flatMap((answer) => (answer === null ? [] : [answer]));
}

/** Text a key adds to a free answer: one line, no control characters. */
function typedText(input: string): string {
  return [...input]
    .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
    .join("");
}

/** Answers the question under the cursor and moves to the next one, if any. */
function pick(block: PlanningQuestionBlock, state: DialogState, answer: DialogAnswer): DialogState {
  const answers = state.answers.map((old, i) => (i === state.index ? answer : old));
  const next = state.index + 1 < block.questions.length ? state.index + 1 : state.index;
  const moved = { ...state, answers, typing: null };
  return { ...moved, index: next, cursor: rowOf(block, moved, next) };
}

/** The keys while a free answer is typed. */
function typingKey(block: PlanningQuestionBlock, state: DialogState, input: string, key: Key) {
  const typing = state.typing ?? "";
  if (key.escape) return { state: { ...state, typing: null }, action: null } as const;
  if (key.return) {
    const text = typing.trim();
    if (text === "") {
      return { state, action: null, message: "write the answer, or press Esc" } as const;
    }
    return { state: pick(block, state, { free: text }), action: null } as const;
  }
  if (key.backspace || key.delete) {
    return { state: { ...state, typing: typing.slice(0, -1) }, action: null } as const;
  }
  if (key.ctrl || key.meta || key.tab) return null;
  return { state: { ...state, typing: typing + typedText(input) }, action: null } as const;
}

/** The keys that move over the rows and questions or pick a row. */
function rowKey(
  block: PlanningQuestionBlock,
  state: DialogState,
  input: string,
  key: Key,
): DialogStep | null {
  const free = block.questions[state.index]?.options.length ?? 0;
  const go = (index: number): DialogStep => ({
    state: { ...state, index, cursor: rowOf(block, state, index) },
    action: null,
  });
  const move = (cursor: number): DialogStep => ({ state: { ...state, cursor }, action: null });
  if (key.upArrow) return move(Math.max(0, state.cursor - 1));
  if (key.downArrow) return move(Math.min(free, state.cursor + 1));
  if (key.leftArrow) return go(Math.max(0, state.index - 1));
  if (key.rightArrow) return go(Math.min(block.questions.length - 1, state.index + 1));
  const row = key.return ? state.cursor : /^[1-9]$/.test(input) ? Number(input) - 1 : null;
  if (row === null || row > free) return null;
  if (row === free) return { state: { ...state, cursor: row, typing: "" }, action: null };
  return { state: pick(block, { ...state, cursor: row }, { option: row }), action: null };
}

/**
 * The state after `key` in `block`'s dialog, or null for a key the dialog does not own, which the
 * caller gives to the rest of the view.
 */
export function dialogKey(
  block: PlanningQuestionBlock,
  state: DialogState,
  input: string,
  key: Key,
): DialogStep | null {
  if (block.questions[state.index] === undefined) return null;
  if (state.typing !== null) return typingKey(block, state, input, key);
  if (key.ctrl && input === "s") {
    return dialogComplete(state)
      ? { state, action: "send" }
      : { state, action: null, message: "answer every question first" };
  }
  if (key.ctrl && input === "n") return { state, action: "dismiss" };
  if (key.ctrl || key.meta || key.escape) return null;
  return rowKey(block, state, input, key);
}

/** The footer hints of the dialog. */
export function dialogHints(state: DialogState): readonly (readonly [string, number])[] {
  if (state.typing !== null) {
    return [
      ["[Enter] take the answer", 100],
      ["[Esc] back to the options", 85],
    ];
  }
  return [
    [
      dialogComplete(state) ? "[Ctrl-S] send the answers" : "[Ctrl-S] send (when all answered)",
      100,
    ],
    ["[Enter] pick", 90],
    ["[Up/Down] option", 80],
    ["[Left/Right] question", 78],
    ["[Ctrl-N] write a message instead", 70],
  ];
}

/** The text of an answer, as the dialog shows it. */
function answerWords(block: PlanningQuestionBlock, index: number, state: DialogState): string {
  const answer = state.answers[index];
  if (answer === null || answer === undefined) return "not answered";
  if ("free" in answer) return `free: ${answer.free}`;
  return block.questions[index]?.options[answer.option]?.label ?? "?";
}

/**
 * Pure: the dialog as rows: a heading with the progress, the question with its purpose, each
 * option with its description, the free answer row, and what each question answered so far.
 */
export function dialogLines(
  block: PlanningQuestionBlock,
  state: DialogState,
  columns: number,
  display: Display,
): string[] {
  const question = block.questions[state.index];
  if (question === undefined) return [];
  const { dot, ellipsis } = glyphs(display.ascii);
  const width = Math.max(10, columns - 4);
  const cut = (text: string) => truncate(text, width, ellipsis);
  const mark = (on: boolean) => (on ? (display.ascii ? ">" : "›") : " ");
  const lines = [
    cut(
      `question ${state.index + 1} of ${block.questions.length} ${dot} ${question.header} ${dot} ${state.answers.filter((a) => a !== null).length} answered`,
    ),
    cut(question.question),
    cut(`why I ask: ${question.purpose}`),
  ];
  for (const [i, option] of question.options.entries()) {
    lines.push(
      cut(
        `${mark(state.cursor === i && state.typing === null)} ${i + 1}. ${option.label}${option.recommended === true ? " (recommended)" : ""} ${dot} ${option.description}`,
      ),
    );
  }
  const free = question.options.length;
  lines.push(
    cut(
      state.typing === null
        ? `${mark(state.cursor === free)} ${free + 1}. Something else: write your own answer`
        : `  ${free + 1}. your answer: ${state.typing}_`,
    ),
  );
  lines.push(
    cut(
      `answers: ${block.questions.map((_, i) => `${i + 1} ${answerWords(block, i, state)}`).join(` ${dot} `)}`,
    ),
  );
  return lines;
}
