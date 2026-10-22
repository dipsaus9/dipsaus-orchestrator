// The prompt templates (0014 section 1): logic-free Markdown with named slots (`{{criteria}}`).
// Code decides whether a section appears, fills its slots, applies budgets and orders it. A
// template never holds a conditional or a loop; `templateProblems` is the check the tests run
// over every template file.

import implementBoxContract from "./contract/implement-box.md" with { type: "text" };
import implementContract from "./contract/implement.md" with { type: "text" };
import reviewContract from "./contract/review.md" with { type: "text" };
import ciFeedback from "./feedback/ci.md" with { type: "text" };
import reportFeedback from "./feedback/report.md" with { type: "text" };
import resumeMessage from "./feedback/resume.md" with { type: "text" };
import verifyFeedback from "./feedback/verify.md" with { type: "text" };
import developerRole from "./roles/developer.md" with { type: "text" };
import reviewerRole from "./roles/reviewer.md" with { type: "text" };
import answers from "./task/answers.md" with { type: "text" };
import background from "./task/background.md" with { type: "text" };
import baseFailures from "./task/base-failures.md" with { type: "text" };
import baseVerify from "./task/base-verify.md" with { type: "text" };
import changes from "./task/changes.md" with { type: "text" };
import contextItem from "./task/context-item.md" with { type: "text" };
import contextListed from "./task/context-listed.md" with { type: "text" };
import context from "./task/context.md" with { type: "text" };
import criteria from "./task/criteria.md" with { type: "text" };
import dependencies from "./task/dependencies.md" with { type: "text" };
import diff from "./task/diff.md" with { type: "text" };
import feedback from "./task/feedback.md" with { type: "text" };
import gateChanges from "./task/gate-changes.md" with { type: "text" };
import handoff from "./task/handoff.md" with { type: "text" };
import inputs from "./task/inputs.md" with { type: "text" };
import instructions from "./task/instructions.md" with { type: "text" };
import outcome from "./task/outcome.md" with { type: "text" };
import previousFindings from "./task/previous-findings.md" with { type: "text" };
import reviewCommit from "./task/review-commit.md" with { type: "text" };
import reviewScope from "./task/review-scope.md" with { type: "text" };
import reviewTestPlan from "./task/review-test-plan.md" with { type: "text" };
import scopeBox from "./task/scope-box.md" with { type: "text" };
import scope from "./task/scope.md" with { type: "text" };
import story from "./task/story.md" with { type: "text" };
import testPlanNotApplicable from "./task/test-plan-not-applicable.md" with { type: "text" };
import testPlan from "./task/test-plan.md" with { type: "text" };

/**
 * L1 worker contracts by run kind: `implement` and `review` (0019 section 4), and `implement-box`
 * for a developer in its own box (0021 section 7, 0014 amendment of 2026-10-21, DIPO-272): the door
 * messages, without the write-only-these-paths, no-git and no-`cd` rules. `implement` stays the Mac
 * worker's until DIPO-280 removes that path.
 */
export const CONTRACT_TEMPLATES = {
  implement: implementContract,
  "implement-box": implementBoxContract,
  review: reviewContract,
} as const;
export type ContractKind = keyof typeof CONTRACT_TEMPLATES;

/**
 * Built-in L2 roles until `.dipo/roles/` (M4): `developer`, and `reviewer`, used only by the
 * `review` kind and never named by a story (0019 section 4).
 */
export const ROLE_TEMPLATES = { developer: developerRole, reviewer: reviewerRole } as const;
export type BuiltInRole = keyof typeof ROLE_TEMPLATES;

/** L4 section templates. */
export const TASK_TEMPLATES = {
  context,
  contextItem,
  contextListed,
  inputs,
  dependencies,
  background,
  handoff,
  baseVerify,
  story,
  outcome,
  criteria,
  scope,
  // The box worker's scope section: References are a forecast (0021 section 13, DIPO-272).
  scopeBox,
  testPlan,
  testPlanNotApplicable,
  answers,
  instructions,
  feedback,
  changes,
  diff,
  gateChanges,
  // The tests a box verify passed with because they also fail on the base in the box (DIPO-294).
  baseFailures,
  reviewScope,
  reviewTestPlan,
  previousFindings,
  // The reviewer's read-only copy of the pushed commit, added at the session's start (DIPO-276).
  reviewCommit,
} as const;

/**
 * Feedback item templates (0014 section 7). M0 builds verify items, the one feedback turn for a
 * missing or invalid report, and the short first message of a resumed session (DIPO-51).
 */
export const FEEDBACK_TEMPLATES = {
  ci: ciFeedback,
  verify: verifyFeedback,
  report: reportFeedback,
  resume: resumeMessage,
} as const;

/** A slot: `{{name}}` with a lowercase name of letters, digits and `_`. */
const SLOT = /\{\{([a-z][a-z0-9_]*)\}\}/g;
/** Any brace or tag pair a template language could hide logic in. */
const TEMPLATE_SYNTAX = /\{\{[^}]*\}\}|\{%|%\}|<%|%>|\$\{/g;

/**
 * Every place `template` uses syntax other than a plain named slot: a conditional or loop such as
 * `{{#if x}}`, `{{/each}}`, `{{else}}`, `{% for %}`, `<% %>` or `${x}`. Empty for a valid template.
 */
export function templateProblems(template: string): string[] {
  const problems: string[] = [];
  for (const match of template.matchAll(TEMPLATE_SYNTAX)) {
    const slot = /^\{\{([a-z][a-z0-9_]*)\}\}$/.exec(match[0]);
    if (slot === null || RESERVED.has(slot[1] ?? "")) problems.push(match[0]);
  }
  return problems;
}

/** Words template languages read as logic, never allowed as slot names. */
const RESERVED: ReadonlySet<string> = new Set([
  "else",
  "end",
  "each",
  "for",
  "if",
  "this",
  "unless",
  "with",
]);

/** The slot names of `template`, sorted and without duplicates. */
export function slotsOf(template: string): string[] {
  return [...new Set([...template.matchAll(SLOT)].map((match) => match[1] ?? ""))].toSorted();
}

/** Text with `\r\n` and lone `\r` turned into `\n` (0014 section 5). */
export function normaliseNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * The tag names the prompts use: every task message section and the context `item`. Slot text
 * may not open or close one of them, so story text cannot end a section early and start another.
 */
export const PROMPT_TAGS: readonly string[] = [
  "context",
  "inputs",
  "dependencies",
  "background",
  "handoff",
  "base_verify",
  "story",
  "outcome",
  "criteria",
  "scope",
  "test_plan",
  "answers",
  "instructions",
  "feedback",
  "item",
  "changes",
  "diff",
  "gate_changes",
  "base_failures",
  "previous_findings",
];

// Whitespace around the slash is allowed, so `</ criteria>` and `< /criteria>` are caught too.
const TAG = new RegExp(`<\\s*(/?)\\s*(${PROMPT_TAGS.join("|")})(?=[\\s/>]|$)`, "gi");

/**
 * `text` with every opening or closing prompt tag neutralised: `</criteria>` (also `</ criteria>`
 * and `< /criteria>`) becomes `<\/criteria>` and `<item` becomes `<\item`. Idempotent: a `\`
 * after `<` never matches again.
 */
export function neutraliseTags(text: string): string {
  return text.replace(TAG, (_, slash: string, name: string) => `<\\${slash}${name}`);
}

/** Text code already rendered from templates; `renderTemplate` inserts it as is. */
export interface Rendered {
  readonly rendered: string;
}

/** Marks text built from rendered templates (and engine markers) as safe to insert as is. */
export const rendered = (text: string): Rendered => ({ rendered: text });

/**
 * Fills every slot of `template` from `values`. A plain string value is data: its prompt tags are
 * neutralised (`neutraliseTags`), in this one place for every slot. A `Rendered` value is
 * template output and goes in as is. A line that holds only a slot whose value is empty is left
 * out, so an empty list leaves no blank line. Throws when a slot has no value or a value has no
 * slot, so templates and code cannot drift apart. The result ends without a newline.
 */
export function renderTemplate(
  template: string,
  input: Readonly<Record<string, string | Rendered>>,
): string {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    values[key] = typeof value === "string" ? neutraliseTags(value) : value.rendered;
  }
  const problems = templateProblems(template);
  if (problems.length > 0) {
    throw new Error(`template holds syntax other than named slots: ${problems.join(", ")}`);
  }
  const slots = slotsOf(template);
  const missing = slots.filter((slot) => values[slot] === undefined);
  const unused = Object.keys(values)
    .filter((key) => !slots.includes(key))
    .toSorted();
  if (missing.length > 0) throw new Error(`template slots without a value: ${missing.join(", ")}`);
  if (unused.length > 0) throw new Error(`values without a template slot: ${unused.join(", ")}`);
  const lines = normaliseNewlines(template).replace(/\n+$/, "").split("\n");
  return lines
    .filter((line) => {
      const whole = /^\{\{([a-z][a-z0-9_]*)\}\}$/.exec(line);
      return whole === null || values[whole[1] ?? ""] !== "";
    })
    .map((line) => line.replace(SLOT, (_, name: string) => normaliseNewlines(values[name] ?? "")))
    .join("\n");
}
