// The question dialog's keys (DIPO-455, DIPO-491): Enter picks and moves on, a Submit row sends,
// Left and Right change an answer, Esc leaves the block, and Ctrl-S and Ctrl-N do nothing.

import { describe, expect, it } from "bun:test";

import type { PlanningQuestionBlock } from "@dipsaus-orchestrator/contract";

import {
  dialogAnswers,
  dialogKey,
  dialogOnSubmit,
  dialogRows,
  freshDialog,
  type DialogState,
} from "./question-dialog";
import { spansText } from "./spans";

const question = (header: string) => ({
  header,
  question: `${header}?`,
  purpose: "why",
  options: [
    { label: "A", description: "first", recommended: true },
    { label: "B", description: "second" },
  ],
});
const block = {
  n: 1,
  at: "2026-10-14T10:04:00.000Z",
  questions: [question("One"), question("Two")],
};
const BLOCK = block as unknown as PlanningQuestionBlock;

const press = (state: DialogState, input: string, key: object = {}) => {
  const step = dialogKey(BLOCK, state, input, key as never);
  if (step === null) throw new Error(`the dialog did not take ${input}`);
  return step;
};
const enter = { return: true };

describe("the question dialog", () => {
  it("picks with Enter, moves on, lists both answers on Submit and sends from it", () => {
    let step = press(freshDialog(BLOCK), "\r", enter);
    expect(step.state.index).toBe(1);
    expect(step.state.answers).toEqual([{ option: 0 }, null]);
    step = press(step.state, "\r", { ...enter });
    // Question 2 starts on its recommended option A; Enter takes it.
    expect(dialogOnSubmit(step.state)).toBe(true);
    const rows = dialogRows(BLOCK, step.state, 80, { ascii: false } as never).map(spansText);
    expect(rows.join("\n")).toContain("One: A");
    expect(rows.join("\n")).toContain("Two: A");
    expect(rows.at(-1)).toContain("Submit");
    expect(step.action).toBeNull();
    const sent = press(step.state, "\r", enter);
    expect(sent.action).toBe("send");
    expect(dialogAnswers(sent.state)).toEqual([{ option: 0 }, { option: 0 }]);
  });

  it("goes back with Left, shows a changed answer on Submit and goes on to the next unanswered one", () => {
    let state = press(press(freshDialog(BLOCK), "\r", enter).state, "\r", enter).state;
    state = press(state, "", { leftArrow: true }).state;
    expect(state.index).toBe(1);
    state = press(state, "", { leftArrow: true }).state;
    state = press(state, "", { downArrow: true }).state;
    state = press(state, "\r", enter).state;
    expect(state.answers[0]).toEqual({ option: 1 });
    expect(dialogOnSubmit(state)).toBe(true);
    expect(press(state, "", { leftArrow: true }).state.index).toBe(1);
  });

  it("does not send from Submit while a question has no answer", () => {
    const first = press(freshDialog(BLOCK), "", { rightArrow: true }).state;
    const submit = press(first, "", { rightArrow: true });
    expect(dialogOnSubmit(submit.state)).toBe(true);
    const step = press(submit.state, "\r", enter);
    expect(step.action).toBeNull();
    expect(step.message).toBe("answer every question first");
  });

  it("leaves the block on Esc while choosing, and takes no Ctrl-S or Ctrl-N", () => {
    const state = freshDialog(BLOCK);
    expect(press(state, "", { escape: true }).action).toBe("dismiss");
    expect(dialogKey(BLOCK, state, "s", { ctrl: true } as never)).toBeNull();
    expect(dialogKey(BLOCK, state, "n", { ctrl: true } as never)).toBeNull();
  });

  it("opens the free text with Enter, takes it with Enter and goes back to the options on Esc", () => {
    let state = freshDialog(BLOCK);
    state = press(state, "", { downArrow: true }).state;
    state = press(state, "", { downArrow: true }).state;
    state = press(state, "\r", enter).state;
    expect(state.typing).toBe("");
    state = press(state, "x").state;
    expect(press(state, "", { escape: true }).state.typing).toBeNull();
    const taken = press(state, "\r", enter).state;
    expect(taken.answers[0]).toEqual({ free: "x" });
    expect(taken.typing).toBeNull();
  });
});
