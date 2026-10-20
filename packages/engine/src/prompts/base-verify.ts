// The `base_verify` section of the task message (0014 section 2, note of 2026-10-20, DIPO-183):
// what the office's verify said about the base commit in the worker's own sandbox, so a worker
// never rebuilds a baseline to show that a failure is not its own. Code reads the stored result;
// no model writes any of it.

import { formatCount } from "../context/truncate";
import { cutTailLines } from "./cut";
import { renderTemplate, TASK_TEMPLATES } from "./templates";

/** What is known of the base commit's verify. */
export type BaseVerifyFacts =
  /** Verify passed on the base in the worker's sandbox. */
  | { readonly kind: "green" }
  /**
   * Verify failed on the base. `failing` holds the failing test names read from the runner's
   * output; when it is empty, `tail` holds the end of the output instead.
   */
  | { readonly kind: "red"; readonly failing: readonly string[]; readonly tail: string | null }
  /** No result: verify could not run, or the worktree was not at the base commit. */
  | { readonly kind: "unknown"; readonly reason: string };

/** The facts of a run with no stored result and no reason to give. */
export const BASE_VERIFY_UNKNOWN: BaseVerifyFacts = {
  kind: "unknown",
  reason: "dipo has no verify result for this base commit",
};

/** Failing test names the section lists; the rest are counted. */
export const BASE_VERIFY_MAX_NAMES = 40;

/** Lines and characters of output tail the section shows when no test name could be read. */
export const BASE_VERIFY_TAIL_LINES = 40;
export const BASE_VERIFY_TAIL_CHARS = 3_000;

function redText(failing: readonly string[], tail: string | null): string {
  if (failing.length > 0) {
    const shown = failing.slice(0, BASE_VERIFY_MAX_NAMES).map((name) => `- ${name}`);
    const rest = failing.length - shown.length;
    if (rest > 0) shown.push(`[dipo: ${formatCount(rest)} more failing tests are not listed.]`);
    return [
      `The base commit fails verify in your sandbox. ${failing.length === 1 ? "This test fails" : "These tests fail"} on the base without this story's change, so ${failing.length === 1 ? "its failure is" : "their failures are"} not yours and need no baseline of your own:`,
      ...shown,
    ].join("\n");
  }
  const cut = cutTailLines(
    tail ?? "",
    BASE_VERIFY_TAIL_LINES,
    BASE_VERIFY_TAIL_CHARS,
    (shown, total) =>
      `[dipo: output cut, showing the last ${formatCount(shown)} of ${formatCount(total)} lines.]`,
  );
  return [
    "The base commit fails verify in your sandbox, without this story's change, and no failing test name could be read from the output. The end of that output:",
    cut.text === "" ? "(no output)" : cut.text,
  ].join("\n");
}

/** The `base_verify` section for `facts`. */
export function renderBaseVerify(facts: BaseVerifyFacts): string {
  switch (facts.kind) {
    case "green":
      return renderTemplate(TASK_TEMPLATES.baseVerify, {
        result:
          "The base commit passes verify in your sandbox. A verify failure you see comes from this story's change.",
      });
    case "red":
      return renderTemplate(TASK_TEMPLATES.baseVerify, {
        result: redText(facts.failing, facts.tail),
      });
    case "unknown":
      return renderTemplate(TASK_TEMPLATES.baseVerify, {
        result: `Not known: ${facts.reason}. Whether the base commit passes verify in your sandbox is not recorded; if a failure looks unrelated to your change, check it before you spend turns on it.`,
      });
  }
}
