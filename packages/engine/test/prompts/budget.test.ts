// The budget line (DIPO-256): the last line of a verify feedback, a CI feedback and a handoff.

import { describe, expect, it } from "bun:test";

import {
  budgetLine,
  ciFeedback,
  renderHandoff,
  verifyFeedback,
  type BudgetFacts,
  type HandoffFacts,
} from "../../src/prompts";

const BUDGET: BudgetFacts = {
  caps: { budgetTokens: 800_000, maxTurns: 200, maxMinutes: 90 },
  used: { budgetTokens: 123_456, turns: 160, elapsedMs: 31 * 60_000 + 5_000 },
};
const LINE =
  "Budget: 160 turns used, 40 left; 31 minutes used, 59 left; 123,456 tokens used, 676,544 left.";

const HANDOFF: HandoffFacts = {
  commits: "abc123 first part",
  criteria: null,
  verify: null,
  feedback: [],
  notes: null,
  budget: BUDGET,
};

describe("budget line", () => {
  it("names turns, minutes and tokens used and left", () => {
    expect(budgetLine(BUDGET)).toBe(LINE);
  });

  it("never shows a negative amount left", () => {
    const over = { ...BUDGET, used: { ...BUDGET.used, turns: 210 } };
    expect(budgetLine(over)).toContain("210 turns used, 0 left");
  });

  it("ends a verify feedback message, once", () => {
    const item = verifyFeedback(
      { step: "lint", command: "bun run lint", exitCode: 1, output: "boom" },
      { budget: BUDGET },
    );
    expect(item.text.endsWith(`\n${LINE}`)).toBe(true);
    expect(item.text.split(LINE).length).toBe(2);
  });

  it("ends a CI feedback message, once", () => {
    const item = ciFeedback(
      { check: "ci-ok", link: "", log: null, noLog: "no log" },
      { budget: BUDGET },
    );
    expect(item.text.endsWith(`\n${LINE}`)).toBe(true);
    expect(item.text.split(LINE).length).toBe(2);
  });

  it("is left out of the feedback when there are no budget facts", () => {
    const item = verifyFeedback({ step: "lint", command: "x", exitCode: 1, output: "" });
    expect(item.text).not.toContain("Budget:");
  });

  it("is the last line of a handoff, before its closing tag", () => {
    const text = renderHandoff(HANDOFF);
    expect(text.endsWith(`\n${LINE}\n</handoff>`)).toBe(true);
  });

  it("is left out of a handoff without budget facts", () => {
    const { budget: _budget, ...rest } = HANDOFF;
    expect(renderHandoff(rest)).not.toContain("Budget:");
  });
});
