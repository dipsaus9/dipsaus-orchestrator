// The `base_verify` section of the task message (0014 section 2, note of 2026-10-20, DIPO-183):
// what the office's verify said about the base commit in the worker's own sandbox, so a worker
// never rebuilds a baseline to show that a failure is not its own. Code reads the stored result;
// no model writes any of it. A box worker's section (DIPO-294) is the verify of its start commit
// in its own box, and says that only failures new against it count.

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

function redText(failing: readonly string[], tail: string | null, box: boolean): string {
  const fails = box
    ? "start commit fails verify in your box"
    : "base commit fails verify in your sandbox";
  if (failing.length > 0) {
    const shown = failing.slice(0, BASE_VERIFY_MAX_NAMES).map((name) => `- ${name}`);
    const rest = failing.length - shown.length;
    if (rest > 0) shown.push(`[dipo: ${formatCount(rest)} more failing tests are not listed.]`);
    return [
      `The ${fails}. ${failing.length === 1 ? "This test fails" : "These tests fail"} on the base without this story's change, so ${failing.length === 1 ? "its failure is" : "their failures are"} not yours and need no baseline of your own:`,
      ...shown,
      ...(box ? [BOX_RULE] : []),
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
    `The ${fails}, without this story's change, and no failing test name could be read from the output. The end of that output:`,
    cut.text === "" ? "(no output)" : cut.text,
  ].join("\n");
}

/**
 * What a box worker's red base means for its verify at done (DIPO-294): only failures that are
 * new against the list count.
 */
export const BOX_RULE =
  "When verify fails only on tests in this list, dipo counts it as passed. A failing test that is not in it, or a failure without a test name, counts against the story.";

/**
 * The `base_verify` section for `facts`. For a box worker (DIPO-294) the facts are the verify of
 * the start commit in its own box, and the text says so.
 */
export function renderBaseVerify(
  facts: BaseVerifyFacts,
  options: { readonly box?: boolean } = {},
): string {
  const box = options.box === true;
  const commit = box ? "start commit" : "base commit";
  const where = box ? "in your box" : "in your sandbox";
  switch (facts.kind) {
    case "green":
      return renderTemplate(TASK_TEMPLATES.baseVerify, {
        result: `The ${commit} passes verify ${where}. A verify failure you see comes from this story's change.`,
      });
    case "red":
      return renderTemplate(TASK_TEMPLATES.baseVerify, {
        result: redText(facts.failing, facts.tail, box),
      });
    case "unknown":
      return renderTemplate(TASK_TEMPLATES.baseVerify, {
        result: `Not known: ${facts.reason}. Whether the ${commit} passes verify ${where} is not recorded; if a failure looks unrelated to your change, check it before you spend turns on it.${box ? " Every verify failure counts against the story." : ""}`,
      });
  }
}
