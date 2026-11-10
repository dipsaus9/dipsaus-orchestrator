// The dialog of a planning session's question block (DIPO-455, 0022), pure. A block holds one to
// four questions, each with its purpose, two to four described options and, always, a free answer
// as the last row. Up and Down move over the rows of the question, Enter (or the row's digit)
// picks one; on the free row Enter opens a text the maintainer types, and Enter again takes it.
// Left and Right go to the previous and next question, to change an answer. Ctrl-S sends the
// answers once every question has one (`planning.answer`); Ctrl-N leaves the block unanswered to
// write a plain message instead. The free answer is edited by the Composer's `editDraft` (DIPO-457)
// on one line: Enter takes it. The footer keys come from the key registry (`FOOTER_KEYS`).

import type { PlanningQuestionBlock } from "@dipsaus-orchestrator/contract";
import type { Key } from "ink";

import { editDraft } from "./composer";
import type { Display } from "./options";
import { wrapSpans } from "./markdown";
import type { Span } from "./spans";
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
  if (key.ctrl || key.meta || key.tab) return null;
  // The Composer's editing on one line: a pasted line break becomes a space.
  const next = editDraft(typing, input, key) ?? typing;
  return { state: { ...state, typing: next.replace(/\n/g, " ") }, action: null } as const;
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

/** The text of an answer, as the dialog shows it. */
function answerWords(block: PlanningQuestionBlock, index: number, state: DialogState): string {
  const answer = state.answers[index];
  if (answer === null || answer === undefined) return "not answered";
  if ("free" in answer) return `free: ${answer.free}`;
  return block.questions[index]?.options[answer.option]?.label ?? "?";
}

/**
 * Pure: the dialog as rows of spans (DIPO-486), each wrapped at the column width. A heading with
 * the progress; the question set apart in hi and bold; why it is asked; the options as a numbered
 * list with the cursor's row marked, the recommended one in ok and the chosen one ticked, each
 * description under its option; the free answer row; and the answer of every question, so a choice
 * is seen before sending and changed with Left and Right.
 */
export function dialogRows(
  block: PlanningQuestionBlock,
  state: DialogState,
  columns: number,
  display: Display,
): Span[][] {
  const question = block.questions[state.index];
  if (question === undefined) return [];
  const { dot, bar, met } = glyphs(display.ascii);
  const width = Math.max(10, columns - 2);
  const mark = (on: boolean): Span => ({ text: on ? `${bar} ` : "  ", role: "acc" });
  const answer = state.answers[state.index];
  const chosen = answer !== null && answer !== undefined && "option" in answer ? answer.option : -1;
  const answered = state.answers.filter((a) => a !== null).length;
  const rows: Span[][] = [
    ...wrapSpans(
      [
        {
          text: `question ${state.index + 1} of ${block.questions.length} ${dot} ${question.header} ${dot} ${answered} answered`,
          role: "dim",
        },
      ],
      width,
      { indent: 0 },
    ),
    ...wrapSpans([{ text: question.question, role: "hi", bold: true }], width, {
      prefix: [{ text: "? ", role: "acc", bold: true }],
    }),
    ...wrapSpans([{ text: question.purpose, role: "dim" }], width, {
      prefix: [{ text: "  why I ask: ", role: "dim" }],
      indent: 2,
    }),
  ];
  for (const [i, option] of question.options.entries()) {
    const here = state.cursor === i && state.typing === null;
    rows.push(
      ...wrapSpans(
        [
          { text: option.label, role: "hi", ...(here ? { bold: true } : {}) },
          ...(option.recommended === true ? [{ text: " (recommended)", role: "ok" as const }] : []),
          ...(chosen === i ? [{ text: ` ${met}`, role: "ok" as const }] : []),
        ],
        width,
        { prefix: [mark(here), { text: `${i + 1}. ` }], indent: 5 },
      ),
      ...wrapSpans([{ text: option.description, role: "dim" }], width, {
        indent: 5,
        prefix: [{ text: "     " }],
      }),
    );
  }
  const free = question.options.length;
  rows.push(
    ...(state.typing === null
      ? wrapSpans([{ text: "Something else: write your own answer" }], width, {
          prefix: [mark(state.cursor === free), { text: `${free + 1}. ` }],
          indent: 5,
        })
      : wrapSpans([{ text: `${state.typing}_`, role: "hi" }], width, {
          prefix: [{ text: `  ${free + 1}. your answer: `, role: "acc" }],
          indent: 5,
        })),
  );
  rows.push([{ text: "answers", role: "dim" }]);
  for (const [i, other] of block.questions.entries()) {
    const words = answerWords(block, i, state);
    const done = state.answers[i] !== null;
    rows.push(
      ...wrapSpans(
        [
          { text: other.header, role: i === state.index ? "hi" : "dim" },
          { text: ": " },
          { text: words, role: done ? "ok" : "dim" },
          ...(done ? [{ text: ` ${met}`, role: "ok" as const }] : []),
        ],
        width,
        { prefix: [mark(i === state.index), { text: `${i + 1} ` }], indent: 5 },
      ),
    );
  }
  return rows;
}
