// The Ready gate rules of 0012 section 3 and R26 of 0014 section 4, one function each. A rule
// returns its failures with the full message `ready <ID> failed <rule>: <message>`, or none.
// Thresholds, the type list, the tier set and the banned phrases come from office configuration;
// a message that names a threshold names the configured one (the 0012 text shows the defaults).
//
// When the field block fails R02 its data is unknown, so the rules over that data (R15, R18, R19,
// R20, R21, R26, R29 and the test-plan half of R23) report nothing rather than guess.

import type { FieldBlock } from "@dipsaus-orchestrator/contract";

import type { StoryLabels } from "../story-store/fields/labels";
import { characters, clean, looksLikePath, runCores, wordMatch } from "./text";
import type {
  GateFailure,
  GateInput,
  GateMode,
  GateRole,
  GateRule,
  GateStory,
  GateTask,
} from "./types";

/** What the rules read: the input plus the parsed field block and labels. */
export interface GateContext {
  readonly input: GateInput;
  readonly mode: GateMode;
  readonly story: GateStory;
  /** The parsed field block; undefined when it fails R02. */
  readonly fields: FieldBlock | undefined;
  /** The R02 parser error, when there is one. */
  readonly fieldError: string | undefined;
  readonly labels: StoryLabels;
  readonly roster: readonly GateRole[];
}

export type RuleCheck = (context: GateContext) => readonly GateFailure[];

/** `ready <ID> failed <rule>: <message>`. */
export function gateMessage(id: string, rule: GateRule, message: string): string {
  return `ready ${id} failed ${rule}: ${message}`;
}

/**
 * The `<message>` of a `gateMessage` or `gateWarningMessage` line of `rule`, so views send what
 * failed or warned as data (DIPO-97).
 * The `<ID>` is not checked, since a stored line keeps the id the story had when it was decided.
 * A line of another shape is returned as is.
 */
export function gateText(rule: string, line: string): string {
  if (!line.startsWith("ready ")) return line;
  for (const marker of [` failed ${rule}: `, ` warning ${rule}: `]) {
    const at = line.indexOf(marker);
    if (at >= 0) return line.slice(at + marker.length);
  }
  return line;
}

function fail(context: GateContext, rule: GateRule, message: string): GateFailure[] {
  return [{ rule, message: gateMessage(context.story.id, rule, message) }];
}

function list(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

const SPIKE = "spike";
const OUTCOME_PREFIX = "Outcome:";
/** R20: the minimum length of a test plan `check` and of a `not_applicable` reason. */
export const TEST_PLAN_TEXT_MIN = 10;
/** R22: an ADR path inside a criterion. */
const ADR_PATH = /docs\/decisions\/[0-9]{4}-[a-z0-9-]+\.md/g;
/** R25: the `<X>` of an input under `docs/design/<X>/`. */
const DESIGN_INPUT = /^docs\/design\/([^/]+)\//;

function isSpike(story: GateStory): boolean {
  return story.type === SPIKE;
}

function isActive(context: GateContext, id: string): boolean {
  return context.input.activeTasks.some((task) => task.id === id);
}

/** The text after `Outcome:` of every description line that starts with it. */
export function outcomeLines(description: string): string[] {
  return description
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    .filter((line) => line.startsWith(OUTCOME_PREFIX))
    .map((line) => line.slice(OUTCOME_PREFIX.length));
}

function statusRule(
  context: GateContext,
  rule: "R01a" | "R01b",
  wanted: string,
  what: string,
): GateFailure[] {
  const { story } = context;
  if (isActive(context, story.id) && story.status === wanted) return [];
  return fail(context, rule, `status is ${story.status}; only ${wanted} stories can be ${what}`);
}

/** R01a (`ready` mode): the story is an active task with status `Refined`. */
export const r01a: RuleCheck = (context) => statusRule(context, "R01a", "Refined", "made Ready");

/** R01b (pickup mode): the story is an active task with status `Ready`. */
export const r01b: RuleCheck = (context) => statusRule(context, "R01b", "Ready", "picked up");

/** R02: the field block parses and has no unknown fields. */
export const r02: RuleCheck = (context) =>
  context.fieldError === undefined
    ? []
    : fail(context, "R02", `structured fields are invalid: ${context.fieldError}`);

/** R03: the story has no subtasks. */
export const r03: RuleCheck = (context) =>
  context.story.subtasks.length === 0
    ? []
    : fail(
        context,
        "R03",
        `story has subtasks ${list(context.story.subtasks)}; milestones group work, subtasks are not used`,
      );

/** R04: the trimmed title is 1 to `story.titleMax` characters. */
export const r04: RuleCheck = (context) => {
  const max = context.input.config.story.titleMax;
  const length = characters(context.story.title);
  return length >= 1 && length <= max
    ? []
    : fail(context, "R04", `title is empty or longer than ${max} characters`);
};

/** R05: exactly one `Outcome:` line, its text at least `story.outcomeMin` characters. */
export const r05: RuleCheck = (context) => {
  const min = context.input.config.story.outcomeMin;
  const lines = outcomeLines(context.story.description);
  return lines.length === 1 && characters(lines[0] ?? "") >= min
    ? []
    : fail(
        context,
        "R05",
        `outcome line is missing, duplicated, or shorter than ${min} characters`,
      );
};

/** R06: the type is set and is in `story.types`. */
export const r06: RuleCheck = (context) => {
  const { types } = context.input.config.story;
  const { type } = context.story;
  return type !== undefined && types.includes(type)
    ? []
    : fail(context, "R06", `type is missing or not one of ${list(types)}`);
};

/** R07: the milestone is set and exists. */
export const r07: RuleCheck = (context) => {
  const { milestone } = context.story;
  return milestone !== undefined && context.input.milestones.includes(milestone)
    ? []
    : fail(context, "R07", "milestone is missing or does not exist");
};

/** R08: at least one acceptance criterion. */
export const r08: RuleCheck = (context) =>
  context.story.acceptanceCriteria.length > 0
    ? []
    : fail(context, "R08", "no acceptance criteria; add at least one with --ac");

/** R09: every criterion is unchecked and at least `story.criterionMin` characters. */
export const r09: RuleCheck = (context) => {
  const min = context.input.config.story.criterionMin;
  return context.story.acceptanceCriteria.flatMap((criterion) =>
    !criterion.checked && characters(criterion.text) >= min
      ? []
      : fail(
          context,
          "R09",
          `criterion #${criterion.index} is checked or shorter than ${min} characters`,
        ),
  );
};

/** R10: no criterion contains a banned phrase (word match); one failure per criterion and phrase. */
export const r10: RuleCheck = (context) => {
  const phrases = context.input.config.story.bannedPhrases;
  return context.story.acceptanceCriteria.flatMap((criterion) =>
    phrases
      .filter((phrase) => wordMatch(criterion.text, phrase))
      .flatMap((phrase) =>
        fail(context, "R10", `criterion #${criterion.index} contains vague phrase "${phrase}"`),
      ),
  );
};

/** R11: at least one scope path. */
export const r11: RuleCheck = (context) =>
  context.story.references.length > 0
    ? []
    : fail(context, "R11", "no declared scope; add at least one path with --ref");

/** R12's path check: a repo-relative POSIX path outside `backlog/`. */
export function isValidScopePath(path: string): boolean {
  if (path === "" || path === ".") return false;
  if (path.startsWith("/")) return false;
  if (path.includes("://")) return false;
  if (/\s/u.test(path)) return false;
  if (/[*?[\]]/.test(path)) return false;
  if (path.split("/").includes("..")) return false;
  if (path === "backlog" || path.startsWith("backlog/")) return false;
  return true;
}

/** R12: every scope path is a valid repo-relative path. */
export const r12: RuleCheck = (context) =>
  context.story.references.flatMap((path) =>
    isValidScopePath(path)
      ? []
      : fail(context, "R12", `scope path "${path}" is not a valid repo-relative path`),
  );

/** R13: every dependency is an active task other than the story itself. */
export const r13: RuleCheck = (context) =>
  context.story.dependencies.flatMap((dep) =>
    dep !== context.story.id && isActive(context, dep)
      ? []
      : fail(context, "R13", `dependency ${dep} is not an active task`),
  );

/**
 * The first dependency cycle through `start`, as the ids from `start` back to `start`, or
 * undefined. Edges follow dependency order, so the result is deterministic.
 */
export function cycleThrough(
  start: string,
  edges: ReadonlyMap<string, readonly string[]>,
): string[] | undefined {
  const done = new Set<string>();
  const path: string[] = [start];
  const walk = (node: string): boolean => {
    for (const next of edges.get(node) ?? []) {
      if (next === start) {
        path.push(next);
        return true;
      }
      if (done.has(next) || path.includes(next)) continue;
      path.push(next);
      if (walk(next)) return true;
      path.pop();
      done.add(next);
    }
    return false;
  };
  return walk(start) ? path : undefined;
}

function dependencyEdges(
  story: GateStory,
  tasks: readonly GateTask[],
): Map<string, readonly string[]> {
  const edges = new Map<string, readonly string[]>();
  for (const task of tasks) edges.set(task.id, task.dependencies);
  edges.set(story.id, story.dependencies);
  return edges;
}

/** R14: no dependency cycle runs through the story. */
export const r14: RuleCheck = (context) => {
  const cycle = cycleThrough(
    context.story.id,
    dependencyEdges(context.story, context.input.activeTasks),
  );
  return cycle === undefined ? [] : fail(context, "R14", `dependency cycle: ${cycle.join(" -> ")}`);
};

/** R15: the unknowns list exists, none is open, and every resolved one has an answer. */
export const r15: RuleCheck = (context) => {
  if (context.fields === undefined) return [];
  const { unknowns } = context.fields;
  if (unknowns === undefined) {
    return fail(context, "R15", "unknowns list is missing; add unknowns: [] to the field block");
  }
  const blocking = unknowns.filter(
    (unknown) => unknown.status === "open" || clean(unknown.answer ?? "") === "",
  );
  const first = blocking[0];
  return first === undefined
    ? []
    : fail(
        context,
        "R15",
        `${blocking.length} unknowns open or resolved without an answer: ${first.q}…`,
      );
};

/** R16: exactly one tier label, from `story.tiers`. */
export const r16: RuleCheck = (context) => {
  const allowed: readonly string[] = context.input.config.story.tiers;
  const { tiers } = context.labels;
  const [only] = tiers;
  return tiers.length === 1 && only !== undefined && allowed.includes(only)
    ? []
    : fail(context, "R16", `needs exactly one tier from ${list(allowed)}, found ${list(tiers)}`);
};

/** R17: at most one role label, naming a roster role. */
export const r17: RuleCheck = (context) => {
  const { roles } = context.labels;
  const [only] = roles;
  if (roles.length === 0) return [];
  if (roles.length === 1 && context.roster.some((role) => role.name === only)) return [];
  return fail(context, "R17", `role ${roles.join(", ")} is not in the roster`);
};

/** R18: the branch is `<ID>/<slug>`, slug lowercase hyphenated and at most `story.slugMax`. */
export const r18: RuleCheck = (context) => {
  if (context.fields === undefined) return [];
  const { id } = context.story;
  const branch = context.fields.branch ?? "";
  const prefix = `${id}/`;
  const slug = branch.slice(prefix.length);
  const valid =
    branch.startsWith(prefix) &&
    /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) &&
    slug.length <= context.input.config.story.slugMax;
  return valid
    ? []
    : fail(
        context,
        "R18",
        `branch "${branch}" must be ${id}/<slug> with a lowercase hyphenated slug`,
      );
};

/**
 * R19: no other active task has the same branch. The failures follow the task ids, not the order
 * the tasks were read in, so the Backlog CLI's list and the mirror give the same lines.
 */
export const r19: RuleCheck = (context) => {
  const branch = context.fields?.branch;
  if (branch === undefined) return [];
  return context.input.activeTasks
    .filter((task) => task.id !== context.story.id && task.branch === branch)
    .toSorted((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }))
    .flatMap((task) => fail(context, "R19", `branch "${branch}" is already used by ${task.id}`));
};

/** R20: a non-spike story has a complete test plan. */
export const r20: RuleCheck = (context) => {
  if (context.fields === undefined || isSpike(context.story)) return [];
  const plan = context.fields.test_plan;
  const message = (n: number) =>
    fail(
      context,
      "R20",
      `test plan is missing, empty, or entry ${n} is incomplete; add entries or not_applicable with a reason`,
    );
  if (plan === undefined) return message(0);
  if (plan.not_applicable !== undefined) {
    return characters(plan.not_applicable) >= TEST_PLAN_TEXT_MIN ? [] : message(0);
  }
  const entries = plan.entries ?? [];
  if (entries.length === 0) return message(0);
  return entries.flatMap((entry, i) =>
    characters(entry.check) >= TEST_PLAN_TEXT_MIN &&
    (entry.kind !== "manual" || clean(entry.expect ?? "") !== "")
      ? []
      : message(i + 1),
  );
};

/** R21: a story flagged test-before-merge has at least one manual test plan entry. */
export const r21: RuleCheck = (context) => {
  if (context.fields === undefined || isSpike(context.story)) return [];
  if (!context.labels.testBeforeMerge) return [];
  const entries = context.fields.test_plan?.entries ?? [];
  return entries.some((entry) => entry.kind === "manual")
    ? []
    : fail(context, "R21", "flagged test-before-merge but the test plan has no manual entry");
};

/** True when a scope path equals `path` or ends in `/` and is a prefix of it. */
function covers(scope: string, path: string): boolean {
  return scope === path || (scope.endsWith("/") && path.startsWith(scope));
}

/** R22: a spike names its ADR in a criterion, and its scope covers that path. */
export const r22: RuleCheck = (context) => {
  if (!isSpike(context.story)) return [];
  const adrs = context.story.acceptanceCriteria.flatMap((criterion) =>
    [...criterion.text.matchAll(ADR_PATH)].map((match) => match[0]),
  );
  const covered = adrs.some((adr) => context.story.references.some((scope) => covers(scope, adr)));
  return covered
    ? []
    : fail(
        context,
        "R22",
        "spike must name its ADR (docs/decisions/NNNN-name.md) in a criterion and cover it in scope",
      );
};

/** R23: a spike has no test plan and is not flagged test-before-merge. */
export const r23: RuleCheck = (context) => {
  if (!isSpike(context.story)) return [];
  const planned = context.fields?.test_plan !== undefined;
  return !planned && !context.labels.testBeforeMerge
    ? []
    : fail(
        context,
        "R23",
        "spike cannot have a test plan or be flagged test-before-merge; it ships no behavior",
      );
};

/**
 * R24: a design story (a non-code roster role) writes only under `docs/design/<ID>/`. No non-code
 * role exists before M4, so until then every story with a non-code role fails.
 */
export const r24: RuleCheck = (context) => {
  const nonCode = context.labels.roles.some((name) =>
    context.roster.some((role) => role.name === name && !role.code),
  );
  return nonCode
    ? fail(context, "R24", `design story scope must be docs/design/${context.story.id}/ only`)
    : [];
};

/** R25: every input under `docs/design/<X>/` has `<X>` as a dependency. */
export const r25: RuleCheck = (context) => {
  const designs = new Set<string>();
  for (const path of context.story.documentation) {
    const design = DESIGN_INPUT.exec(path)?.[1];
    if (design !== undefined) designs.add(design);
  }
  return [...designs]
    .filter((design) => !context.story.dependencies.includes(design))
    .flatMap((design) =>
      fail(context, "R25", `input docs/design/${design}/ needs ${design} as a dependency`),
    );
};

/**
 * The story contract's size (R26): the characters of the title, outcome, criteria, scope paths,
 * test plan (each check, expected result and not-applicable reason), resolved unknowns (question
 * and answer) and extra instructions.
 */
export function contractCharacters(story: GateStory, fields: FieldBlock): number {
  const plan = fields.test_plan;
  const texts = [
    story.title,
    ...outcomeLines(story.description),
    ...story.acceptanceCriteria.map((criterion) => criterion.text),
    ...story.references,
    ...(plan?.entries ?? []).flatMap((entry) => [entry.check, entry.expect ?? ""]),
    plan?.not_applicable ?? "",
    ...(fields.unknowns ?? [])
      .filter((unknown) => unknown.status === "resolved")
      .flatMap((unknown) => [unknown.q, unknown.answer ?? ""]),
    story.implementationPlan ?? "",
  ];
  return texts.reduce((sum, text) => sum + characters(text), 0);
}

/** R26: the story contract is at most `prompt.contractMax` characters. */
export const r26: RuleCheck = (context) => {
  if (context.fields === undefined) return [];
  const max = context.input.config.prompt.contractMax;
  const size = contractCharacters(context.story, context.fields);
  return size <= max
    ? []
    : fail(context, "R26", `story contract is ${size} characters; the limit is ${max}`);
};

/** A path without a leading `./` and a trailing `/`, for comparing paths segment by segment. */
function trimmed(path: string): string {
  return path.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
}

/**
 * The scope prefix rule (0012 story standard): two paths collide when they are equal or either is
 * a prefix of the other on segment boundaries. A trailing `/` does not count, so the Reference
 * `packages/daemon/test` covers `packages/daemon/test/unit/x.test.ts`, and
 * `packages/engine` does not cover `packages/engine-x/a.ts`.
 */
export function pathsCollide(a: string, b: string): boolean {
  const x = trimmed(a);
  const y = trimmed(b);
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/** R29: a bare test file name, such as `plan.test.ts`: no slash, no glob character. */
const BARE_TEST_FILE = /^[\p{L}\p{N}_-][\p{L}\p{N}_.-]*\.test\.ts$/u;

/**
 * R29's repo-relative form of a path token, or undefined when the token is not one: an absolute or
 * home path, a URL, a path with a `..` segment or a glob, and a path under `backlog/` (which R12
 * keeps out of the References, so no Reference could cover it) are not checked.
 */
function repoRelativePath(token: string): string | undefined {
  const path = token.replace(/^(\.\/)+/, "");
  if (path.startsWith("~")) return undefined;
  return isValidScopePath(path) ? path : undefined;
}

function fileName(path: string): string {
  const parts = trimmed(path).split("/");
  return parts[parts.length - 1] ?? "";
}

/**
 * True when a Reference is a file named `name`, or a Reference directory holds a file of that name
 * in the base tree.
 */
function bareNameCovered(name: string, references: readonly string[], files: readonly string[]) {
  if (references.some((reference) => fileName(reference) === name)) return true;
  return files.some(
    (file) =>
      fileName(file) === name &&
      references.some((reference) => {
        const directory = trimmed(reference);
        return directory !== "" && file.startsWith(`${directory}/`);
      }),
  );
}

/** A name of a test plan check that no Reference covers, and whether the base file list was known. */
interface UncoveredName {
  readonly name: string;
  /** True for a bare test file name checked without the base tree's file list. */
  readonly unknownBase: boolean;
}

/** The paths and bare test file names of one test plan check that no Reference covers, each once. */
function uncoveredNames(
  check: string,
  references: readonly string[],
  files: readonly string[] | undefined,
): UncoveredName[] {
  const names: UncoveredName[] = [];
  for (const token of runCores(check)) {
    if (names.some((found) => found.name === token)) continue;
    if (token.includes("/")) {
      if (!looksLikePath(token)) continue;
      const path = repoRelativePath(token);
      if (path === undefined) continue;
      if (!references.some((reference) => pathsCollide(reference, path))) {
        names.push({ name: token, unknownBase: false });
      }
    } else if (BARE_TEST_FILE.test(token) && !bareNameCovered(token, references, files ?? [])) {
      names.push({ name: token, unknownBase: files === undefined });
    }
  }
  return names;
}

/** `ready <ID> warning <rule>: <message>`: a gate warning, which never fails the story. */
export function gateWarningMessage(id: string, rule: GateRule, message: string): string {
  return `ready ${id} warning ${rule}: ${message}`;
}

function warn(context: GateContext, rule: GateRule, message: string): GateFailure[] {
  return [{ rule, message: gateWarningMessage(context.story.id, rule, message) }];
}

/**
 * R29 (DIPO-251): every repo-relative path token (DIPO-218) and every bare `*.test.ts` file name
 * in an automated test plan entry's check is covered by a Reference. A path is covered under the
 * scope prefix rule; a bare name when a Reference is a file of that name or a Reference directory
 * holds one in the base tree. Manual entries are exempt. One warning per entry and name.
 *
 * R29 warns and never fails (maintainer decision of 2026-10-22): References are the planner's
 * forecast, not a write fence (0021 section 13), so an uncovered name is reported in the gate's
 * output and decision record but does not keep the story from Ready or from pickup.
 */
export const r29: RuleCheck = (context) => {
  const entries = context.fields?.test_plan?.entries ?? [];
  const { references } = context.story;
  const files = context.input.baseFiles;
  return entries.flatMap((entry, i) =>
    entry.kind !== "automated"
      ? []
      : uncoveredNames(entry.check, references, files).flatMap(({ name, unknownBase }) =>
          warn(
            context,
            "R29",
            unknownBase
              ? `test plan entry #${i + 1} names ${name}; the base file list is unknown, so only a Reference file of that name covers it; add it to the References or drop it from the plan`
              : `test plan entry #${i + 1} names ${name}, which no Reference covers; add it to the References or drop it from the plan`,
          ),
        ),
  );
};

/** R30: the three criteria parts of a security-sensitive story, with what each failure names. */
const SECURITY_PARTS = [
  ["oldBarrier", "what the old barrier caught and a test for each"],
  ["bypassForms", "the bypass forms to test (wrappers, quoting, indirection, chaining)"],
  ["failClosed", "a fail-closed test against the real path"],
] as const;

/**
 * R30 (DIPO-251, from DIPO-260): a story whose title or Outcome names a security barrier (a phrase
 * of `story.securityPhrases`, word match as R10) has, for each part of
 * `story.securityCriteriaPhrases`, a criterion that contains one of its phrases. One failure per
 * missing part, naming the first listed phrase the story matched. A spike ships no behavior, so it
 * adds no barrier and is exempt.
 */
export const r30: RuleCheck = (context) => {
  if (isSpike(context.story)) return [];
  const { securityPhrases, securityCriteriaPhrases } = context.input.config.story;
  const texts = [context.story.title, ...outcomeLines(context.story.description)];
  const phrase = securityPhrases.find((candidate) =>
    texts.some((text) => wordMatch(text, candidate)),
  );
  if (phrase === undefined) return [];
  const { acceptanceCriteria } = context.story;
  return SECURITY_PARTS.filter(
    ([part]) =>
      !acceptanceCriteria.some((criterion) =>
        securityCriteriaPhrases[part].some((candidate) => wordMatch(criterion.text, candidate)),
      ),
  ).flatMap(([, what]) =>
    fail(
      context,
      "R30",
      `title or outcome names a security barrier ("${phrase}") and no criterion covers ${what}; add a criterion for it`,
    ),
  );
};

/** R02 to R30 but R29, which only warns, evaluated in both modes, in rule order. */
export const SHARED_RULES: readonly RuleCheck[] = [
  r02,
  r03,
  r04,
  r05,
  r06,
  r07,
  r08,
  r09,
  r10,
  r11,
  r12,
  r13,
  r14,
  r15,
  r16,
  r17,
  r18,
  r19,
  r20,
  r21,
  r22,
  r23,
  r24,
  r25,
  r26,
  r30,
];

/** The rules that only warn (R29), evaluated in both modes after the others, in rule order. */
export const WARNING_RULES: readonly RuleCheck[] = [r29];
