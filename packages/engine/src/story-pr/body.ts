// The body of a story PR (0019 section 3), built by code from facts, no model text. Sections in
// this order: the outcome, the acceptance criteria ticked as the task file has them, the test plan,
// the declared scope, a status block and a footer. The body is capped at `STORY_PR_MAX_BODY`; the
// story contract (outcome, criteria and test plan) is never cut, the scope list is cut with a
// marker. The engine writes a body to the host only when its hash changed.

import { createHash } from "node:crypto";

import type { TestPlan } from "@dipsaus-orchestrator/contract";

/** GitHub allows 65,536 characters; dipo keeps its bodies well under (0019 section 3). */
export const STORY_PR_MAX_BODY = 20_000;

export interface PrBodyStory {
  readonly id: string;
  readonly outcome: string;
  readonly criteria: readonly {
    readonly index: number;
    readonly text: string;
    readonly checked: boolean;
  }[];
  readonly testPlan: TestPlan | undefined;
  readonly scope: readonly string[];
  /** Repo-relative path of the task file. */
  readonly taskFile: string;
}

export interface PrBodyStatus {
  /** The commit verify passed at. */
  readonly head: string;
}

const SHORT_SHA = 8;

const bullets = (items: readonly string[]): string =>
  items.length === 0 ? "- none" : items.map((item) => `- ${item}`).join("\n");

function testPlanSection(plan: TestPlan | undefined): string | null {
  if (plan === undefined) return null;
  if (plan.not_applicable !== undefined) {
    return `## Test plan\n\nNot applicable: ${plan.not_applicable.trim()}`;
  }
  const entries = plan.entries ?? [];
  const line = (entry: (typeof entries)[number]) =>
    entry.expect === undefined ? entry.check : `${entry.check} Expected: ${entry.expect}`;
  return [
    "## Test plan",
    "",
    "Automated:",
    bullets(entries.filter((entry) => entry.kind === "automated").map(line)),
    "",
    "Manual:",
    bullets(entries.filter((entry) => entry.kind === "manual").map(line)),
  ].join("\n");
}

function statusSection(status: PrBodyStatus): string {
  return [
    "## Status",
    "",
    `- verify: passed at \`${status.head.slice(0, SHORT_SHA)}\``,
    "- review: pending",
    "- merge: dipo merges after review and green required checks",
  ].join("\n");
}

function footer(story: PrBodyStory): string {
  return `---\nOpened by dipo for ${story.id} (\`${story.taskFile}\`).`;
}

const marker = (n: number): string =>
  `- … and ${n} more paths (cut to keep the body under ${STORY_PR_MAX_BODY} characters)`;

function scopeSection(paths: readonly string[], budget: number): string {
  const head = "## Declared scope\n\n";
  if (paths.length === 0) return `${head}- none`;
  const lines = paths.map((path) => `- \`${path}\``);
  if (head.length + lines.join("\n").length <= budget) return `${head}${lines.join("\n")}`;
  const reserve = marker(paths.length).length + 1;
  const kept: string[] = [];
  let used = head.length + reserve;
  for (const line of lines) {
    if (used + line.length + 1 > budget) break;
    kept.push(line);
    used += line.length + 1;
  }
  return `${head}${[...kept, marker(paths.length - kept.length)].join("\n")}`;
}

/** The body of a story PR. */
export function storyPrBody(story: PrBodyStory, status: PrBodyStatus): string {
  const outcome = `## Outcome\n\n${story.outcome.trim() === "" ? "none" : story.outcome.trim()}`;
  const criteria = [
    "## Acceptance criteria",
    "",
    ...story.criteria.map(
      (criterion) =>
        `- [${criterion.checked ? "x" : " "}] #${criterion.index} ${criterion.text.trim()}`,
    ),
  ].join("\n");
  const head = [outcome, criteria, testPlanSection(story.testPlan)].filter(
    (part): part is string => part !== null,
  );
  const tail = [statusSection(status), footer(story)];
  const fixed = [...head, ...tail].join("\n\n").length;
  // Two blank lines join the scope section to its neighbours.
  const scope = scopeSection(story.scope, Math.max(0, STORY_PR_MAX_BODY - fixed - 2));
  return [...head, scope, ...tail].join("\n\n");
}

/** The hash a stored body is compared by. */
export function storyPrBodyHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}
