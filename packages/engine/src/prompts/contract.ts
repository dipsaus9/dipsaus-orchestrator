// The story contract sections of the task message (0014 sections 2 and 4): `story`, `outcome`,
// `criteria`, `scope`, `test_plan`, `answers` and `instructions`. They are never truncated. Their
// size is measured on its own, the way Ready gate rule R26 measures it, and over
// `prompt.contractMax` assembly fails with `prompt.contractTooLarge`: the backstop for a story
// that changed after its gate. Moving the story back to Refined is the caller's job (DIPO-48).

import { characters } from "../gate/text";
import type { PromptStory } from "./story";
import { renderTemplate, TASK_TEMPLATES } from "./templates";

/** The default of `prompt.contractMax` (0014 section 4). */
export const CONTRACT_MAX_DEFAULT = 12_000;

export const CONTRACT_TOO_LARGE = "prompt.contractTooLarge";

/** The story contract is over `prompt.contractMax`; the run must not start. */
export class ContractTooLargeError extends Error {
  readonly code = CONTRACT_TOO_LARGE;
  constructor(
    readonly size: number,
    readonly limit: number,
  ) {
    super(`story contract is ${size} characters; the limit is ${limit}`);
    this.name = "ContractTooLargeError";
  }
}

/** A rendered task message section. */
export interface Section {
  readonly name: SectionName;
  readonly text: string;
}

/** The `implement` task message sections in 0014 order. */
export const SECTION_ORDER = [
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
] as const;
export type SectionName = (typeof SECTION_ORDER)[number];

export const CONTRACT_SECTIONS = [
  "story",
  "outcome",
  "criteria",
  "scope",
  "test_plan",
  "answers",
  "instructions",
] as const satisfies readonly SectionName[];

const SPIKE = "spike";

/**
 * The contract's characters as R26 counts them (`contractCharacters` in `gate/rules.ts`): title,
 * outcome, criteria, scope paths, test plan (check, expected result, not-applicable reason),
 * resolved unknowns (question and answer) and extra instructions, each trimmed and NFC-normalised.
 */
export function contractSize(story: PromptStory): number {
  const plan = story.testPlan;
  const texts = [
    story.title,
    ...story.outcome.split("\n"),
    ...story.criteria.map((criterion) => criterion.text),
    ...story.scope,
    ...(plan?.entries ?? []).flatMap((entry) => [entry.check, entry.expect ?? ""]),
    plan?.not_applicable ?? "",
    ...story.unknowns
      .filter((unknown) => unknown.status === "resolved")
      .flatMap((unknown) => [unknown.q, unknown.answer ?? ""]),
    story.instructions,
  ];
  return texts.reduce((sum, text) => sum + characters(text), 0);
}

const bullets = (items: readonly string[]): string =>
  items.length === 0 ? "- none" : items.map((item) => `- ${item}`).join("\n");

function testPlanSection(story: PromptStory): Section | undefined {
  const plan = story.testPlan;
  if (story.type === SPIKE || plan === undefined) return undefined;
  if (plan.not_applicable !== undefined) {
    return {
      name: "test_plan",
      text: renderTemplate(TASK_TEMPLATES.testPlanNotApplicable, { reason: plan.not_applicable }),
    };
  }
  const entries = plan.entries ?? [];
  const line = (entry: (typeof entries)[number]) =>
    entry.expect === undefined ? entry.check : `${entry.check} Expected: ${entry.expect}`;
  return {
    name: "test_plan",
    text: renderTemplate(TASK_TEMPLATES.testPlan, {
      automated: bullets(entries.filter((entry) => entry.kind === "automated").map(line)),
      manual: bullets(entries.filter((entry) => entry.kind === "manual").map(line)),
    }),
  };
}

function answersSection(story: PromptStory): Section | undefined {
  const resolved = story.unknowns.filter((unknown) => unknown.status === "resolved");
  if (resolved.length === 0) return undefined;
  return {
    name: "answers",
    text: renderTemplate(TASK_TEMPLATES.answers, {
      answers: resolved
        .map((unknown) => `Q: ${unknown.q.trim()}\nA: ${(unknown.answer ?? "").trim()}`)
        .join("\n"),
    }),
  };
}

/**
 * The story contract sections, in order, each present only under its 0014 condition: `story`,
 * `outcome`, `criteria` and `scope` always, `test_plan` for a non-spike, `answers` when an
 * unknown is resolved, `instructions` when non-empty. Throws `ContractTooLargeError` when the
 * contract is over `contractMax`. With `box`, the scope section is the box worker's forecast
 * (`scopeBox`).
 */
export function assembleContract(
  story: PromptStory,
  contractMax: number = CONTRACT_MAX_DEFAULT,
  options: { readonly box?: boolean } = {},
): readonly Section[] {
  const size = contractSize(story);
  if (size > contractMax) throw new ContractTooLargeError(size, contractMax);
  const sections: (Section | undefined)[] = [
    {
      name: "story",
      text: renderTemplate(TASK_TEMPLATES.story, {
        id: story.id,
        title: story.title.trim(),
        type: story.type ?? "none",
        tier: story.tier ?? "none",
      }),
    },
    { name: "outcome", text: renderTemplate(TASK_TEMPLATES.outcome, { outcome: story.outcome }) },
    {
      name: "criteria",
      text: renderTemplate(TASK_TEMPLATES.criteria, {
        criteria: story.criteria.map(({ index, text }) => `#${index} ${text.trim()}`).join("\n"),
      }),
    },
    {
      name: "scope",
      // A box worker's scope is a forecast, not a fence (0021 section 13, DIPO-272).
      text: renderTemplate(options.box === true ? TASK_TEMPLATES.scopeBox : TASK_TEMPLATES.scope, {
        paths: bullets(story.scope),
      }),
    },
    testPlanSection(story),
    answersSection(story),
    story.instructions === ""
      ? undefined
      : {
          name: "instructions",
          text: renderTemplate(TASK_TEMPLATES.instructions, { instructions: story.instructions }),
        },
  ];
  return sections.filter((section) => section !== undefined);
}
