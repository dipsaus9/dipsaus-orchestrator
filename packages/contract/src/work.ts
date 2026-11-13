// The story and work model: lifecycle, park and skip reasons, tiers, phases, signals, health,
// evidence, and the views the engine derives (0005 with the 0008 and 0009 additions).
// Clients render views as they arrive and never derive status themselves (0005).

import { z } from "zod";

import { AgentId, GateId, QuestionId, RoleId, RunId, StoryId, StoryKey, TestId } from "./ids";

// An open enum: the known values are exported, and any other string still parses, so an older
// client keeps working against a newer engine. A client renders an unknown value generically, as
// its plain word (0005). A new known value is a minor change.
export type OpenEnum<T extends string> = T | (string & {});

export function openEnum<const T extends readonly [string, ...string[]]>(
  known: T,
): z.ZodType<OpenEnum<T[number]>, OpenEnum<T[number]>> {
  return z.union([z.enum(known), z.string()]) as unknown as z.ZodType<
    OpenEnum<T[number]>,
    OpenEnum<T[number]>
  >;
}

const Count = z.int().nonnegative();
const Timestamp = z.iso.datetime();

// 0012. Removed is engine-only: the terminal state of an archived or deleted story.
// Closed enum: a new state is a major change (0005).
export const LIFECYCLES = [
  "Draft",
  "Refined",
  "Ready",
  "In Progress",
  "In Review",
  "Done",
  "Parked",
  "Removed",
] as const;
export const Lifecycle = z.enum(LIFECYCLES);
export type Lifecycle = z.infer<typeof Lifecycle>;

// 0012 F11. The engine validates a tier against the office's configured tier set.
export const KNOWN_TIERS = ["S", "M", "L"] as const;
export const Tier = openEnum(KNOWN_TIERS);
export type Tier = z.infer<typeof Tier>;

// The eight reasons of 0001. A park also carries a one-line text detail that no code decides from
// (0020).
export const KNOWN_PARK_REASONS = [
  "ambiguous-spec",
  "verify-failing",
  "conflict",
  "scope-violation",
  "review-blocked",
  "budget-exceeded",
  "by-maintainer",
  "worker-failed",
] as const;
export const ParkReason = openEnum(KNOWN_PARK_REASONS);
export type ParkReason = z.infer<typeof ParkReason>;

// Why `work.run` did not start a story (0005). `notRunnable` covers states run never
// picks; `capacity` means the office runs as many stories as `caps.parallelRuns` allows, or a run
// without named stories started its one story. The office's starts paused
// (0020) refuses the whole `work.run` instead of skipping a story. `starting` means an earlier
// `work.run` already decided to start the story and its claim and box are under way (DIPO-456).
export const KNOWN_SKIP_REASONS = [
  "parked",
  "notReady",
  "notRunnable",
  "dependency",
  "collision",
  "capacity",
  "pickupCheckFailed",
  "starting",
] as const;
export const SkipReason = openEnum(KNOWN_SKIP_REASONS);
export type SkipReason = z.infer<typeof SkipReason>;

// The phases of 0009. `test` waits for the maintainer's test. Verify runs in the box at the end of
// `build`, so it has no phase of its own (0002).
export const KNOWN_PHASES = ["setup", "build", "review", "test", "merge"] as const;
export const Phase = openEnum(KNOWN_PHASES);
export type Phase = z.infer<typeof Phase>;

// The watchdog facts behind health (0009): the evidence of a `work.observed` event, never a second
// health vocabulary. `no-output` stands behind `quiet` and `stuck`, `same-failure` behind
// `looping`, `host-lost` behind `lost`.
export const KNOWN_WATCHDOG_SIGNALS = ["no-output", "same-failure", "host-lost"] as const;
export const WatchdogSignal = openEnum(KNOWN_WATCHDOG_SIGNALS);
export type WatchdogSignal = z.infer<typeof WatchdogSignal>;

// The five health states of 0009, in the engine's precedence order. A question parks and a plan
// limit pauses the office's starts (0020), so no run shows `asking`, `limited` or `paused`.
export const KNOWN_HEALTH = ["lost", "looping", "stuck", "quiet", "busy"] as const;
export const Health = openEnum(KNOWN_HEALTH);
export type Health = z.infer<typeof Health>;

// Engine-derived queue column of a story (0009).
export const KNOWN_COLUMNS = [
  "draft",
  "refined",
  "ready",
  "waiting",
  "running",
  "review",
  "desk",
  "done",
] as const;
export const QueueColumn = openEnum(KNOWN_COLUMNS);
export type QueueColumn = z.infer<typeof QueueColumn>;

export const KNOWN_GATE_KINDS = ["review", "test", "merge"] as const;
export const GateKind = openEnum(KNOWN_GATE_KINDS);
export type GateKind = z.infer<typeof GateKind>;

// How the engine knows a value (0009). Closed.
export const Evidence = z.enum(["checked", "claimed", "estimated", "none"]);
export type Evidence = z.infer<typeof Evidence>;

// Evidence per field path (0009).
export const EvidenceMap = z.record(z.string(), Evidence);
export type EvidenceMap = z.infer<typeof EvidenceMap>;

// A story named in a command: its Backlog.md id or its key (0005).
export const StoryRefValue = z.union([StoryKey, StoryId]);
export type StoryRefValue = z.infer<typeof StoryRefValue>;

export const StoryRef = z.object({ story: StoryRefValue });
export type StoryRef = z.infer<typeof StoryRef>;

// Who works on what. Every event about running work carries one.
export const WorkRef = z.object({
  story: StoryId,
  key: StoryKey,
  run: RunId,
  agent: AgentId,
  role: RoleId,
  tier: Tier,
  model: z.string(),
});
export type WorkRef = z.infer<typeof WorkRef>;

export const Progress = z.object({
  criteriaMet: Count,
  criteriaTotal: Count,
  loop: Count,
  loopCap: Count,
  reviewRound: Count,
  // (DIPO-140, 0002): the review rounds the story may run and how many
  // of its rounds failed, so a client shows "round 2, 1 of 3 failed" without computing it.
  reviewRoundCap: Count.optional(),
  reviewRoundsFailed: Count.optional(),
});
export type Progress = z.infer<typeof Progress>;

export const UsageTotals = z.object({
  inputTokens: Count,
  outputTokens: Count,
  cacheCreateTokens: Count,
  cacheReadTokens: Count,
  turns: Count,
  elapsedMs: Count,
  estimatedCost: z.number().nonnegative().optional(),
});
export type UsageTotals = z.infer<typeof UsageTotals>;

// Tokens: used = input + output + cache creation; cache reads do not count (0008).
export const Budget = z.object({
  unit: z.literal("tokens"),
  limit: z.number().nonnegative(),
  used: z.number().nonnegative(),
});
export type Budget = z.infer<typeof Budget>;

export const Usage = z.object({
  agent: UsageTotals, // cumulative for this agent within this run
  run: UsageTotals, // cumulative for the run across all its agents
  budget: Budget,
  budgetShare: z.number().nonnegative(), // used divided by limit, engine-derived (0009)
});
export type Usage = z.infer<typeof Usage>;

export const ParkRecord = z.object({
  reason: ParkReason,
  detail: z.string(),
  from: Lifecycle,
  since: Timestamp,
});
export type ParkRecord = z.infer<typeof ParkRecord>;

// One failed Ready gate rule (0012): `rule` is the R-number, `message` the full line
// `ready <ID> failed <rule>: <message>`.
export const GateRuleFailure = z.object({ rule: z.string(), message: z.string() });
export type GateRuleFailure = z.infer<typeof GateRuleFailure>;

// A failed Ready gate rule of a Refined story (DIPO-97): the rule id and full line of
// `GateRuleFailure`, and `text`, the line after `ready <ID> failed <rule>: `, so a client shows
// the rule and what failed without parsing the line.
export const StoryGateFailure = GateRuleFailure.extend({ text: z.string() });
export type StoryGateFailure = z.infer<typeof StoryGateFailure>;

// The story's PR on the code host (0002). (DIPO-140).
export const KNOWN_STORY_PR_STATES = ["open", "merged", "closed"] as const;
export const StoryPrState = openEnum(KNOWN_STORY_PR_STATES);
export type StoryPrState = z.infer<typeof StoryPrState>;

// (DIPO-459) What the desk's MERGE preview shows of a PR, each absent until the engine read it:
// `checks`, the count of the pushed head's required checks and where they stand as the CI watch
// evaluates them; `change`, the files the branch changes against the base and the lines it adds
// and removes, from git.
export const StoryPrChecks = z.object({
  required: z.int().nonnegative(),
  state: z.enum(["passed", "pending", "failed"]),
});
export type StoryPrChecks = z.infer<typeof StoryPrChecks>;

export const StoryPrChange = z.object({
  files: z.int().nonnegative(),
  additions: z.int().nonnegative(),
  deletions: z.int().nonnegative(),
});
export type StoryPrChange = z.infer<typeof StoryPrChange>;

export const StoryPr = z.object({
  number: z.int().positive(),
  url: z.url(),
  state: StoryPrState,
  checks: StoryPrChecks.optional(),
  change: StoryPrChange.optional(),
});
export type StoryPr = z.infer<typeof StoryPr>;

// One criterion's result in a review round: exactly one per criterion of the story
// (0002). `maintainer` means only the maintainer can check it.
export const ReviewCriterionStatus = z.enum(["met", "unmet", "maintainer"]);
export type ReviewCriterionStatus = z.infer<typeof ReviewCriterionStatus>;

export const ReviewCriterionResult = z.object({
  n: z.int().positive(),
  status: ReviewCriterionStatus,
  evidence: z.string(),
});
export type ReviewCriterionResult = z.infer<typeof ReviewCriterionResult>;

// Blocking kinds are `scope`, `test`, `correctness` and `security`; the rest are advisory.
export const KNOWN_FINDING_KINDS = [
  "scope",
  "test",
  "correctness",
  "security",
  "maintainability",
  "other",
] as const;
export const FindingKind = openEnum(KNOWN_FINDING_KINDS);
export type FindingKind = z.infer<typeof FindingKind>;

// A finding of a review round. `unverified` marks a blocking finding whose evidence failed the
// code check after its correction turn, so it is kept as advisory (0002).
export const ReviewFinding = z.object({
  severity: z.enum(["blocking", "advisory"]),
  kind: FindingKind,
  criterion: z.int().positive().optional(),
  testEntry: z.int().positive().optional(),
  file: z.string().optional(),
  line: z.int().positive().optional(),
  quote: z.string().optional(),
  text: z.string(),
  unverified: z.boolean().optional(),
});
export type ReviewFinding = z.infer<typeof ReviewFinding>;

// A maintainer override of a blocked review, with the required note (0002).
export const ReviewOverride = z.object({
  note: z.string().min(1),
  at: Timestamp,
});
export type ReviewOverride = z.infer<typeof ReviewOverride>;

// One review round as shown on `story.detail` (0002). `codeTreeKey` is the code tree key
// the verdict is keyed on.
export const ReviewVerdict = z.object({
  round: z.int().positive(),
  commit: z.string().min(1),
  codeTreeKey: z.string().min(1),
  verdict: z.enum(["approved", "blocked"]),
  criteria: z.array(ReviewCriterionResult),
  findings: z.array(ReviewFinding),
  summary: z.string(),
  model: z.string(),
  usage: UsageTotals,
  commentUrl: z.url().optional(),
  override: ReviewOverride.optional(),
});
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

// The review summary of a `gate.decided` event for a review gate (0002).
export const ReviewSummary = z.object({
  round: z.int().positive(),
  commit: z.string().min(1),
  verdict: z.enum(["approved", "blocked"]),
  blocking: Count,
  advisory: Count,
  commentUrl: z.url().optional(),
});
export type ReviewSummary = z.infer<typeof ReviewSummary>;

export const StoryView = z.object({
  key: StoryKey,
  story: StoryId,
  provisional: z.boolean(), // a DRAFT-n id
  title: z.string(),
  lifecycle: Lifecycle,
  tier: Tier.optional(),
  column: QueueColumn,
  work: WorkRef.optional(),
  parked: ParkRecord.optional(),
  waitingOn: z.array(StoryId).optional(), // dependencies not yet Done (column `waiting`)
  gateMessages: z.array(z.string()).optional(), // first Ready gate failures, for Refined
  // (DIPO-97): the failed rules among `gateMessages`, in the same order, each with
  // its rule id. A message no rule gave (a pickup check that could not size the story) is only in
  // `gateMessages`.
  gateFailures: z.array(StoryGateFailure).optional(),
  // (DIPO-482): the story's latest Ready gate decision approved it; set for a Refined story only,
  // so the Queue can say the gate passes. Absent without a decision or when it failed.
  gatePasses: z.boolean().optional(),
  // (DIPO-140): the story's PR, once one is open.
  pr: StoryPr.optional(),
  evidence: EvidenceMap.optional(),
});
export type StoryView = z.infer<typeof StoryView>;

// The view of a running session. Its one health value is engine-derived; the watchdog facts behind
// it travel only as the evidence of `work.observed` (0009).
export const WorkView = z.object({
  work: WorkRef,
  phase: Phase,
  progress: Progress,
  usage: Usage,
  health: Health,
  lastOutputAt: Timestamp.optional(), // display only
  startedAt: Timestamp,
  evidence: EvidenceMap.optional(),
});
export type WorkView = z.infer<typeof WorkView>;

export const GateView = z.object({
  gate: GateId,
  work: WorkRef,
  kind: GateKind,
  waitingOn: z.enum(["maintainer", "rule"]),
  summary: z.string(),
});
export type GateView = z.infer<typeof GateView>;

// `question`: the question of a worker's report, asked by its park (0020).
export const QuestionKind = z.enum(["question"]);
export type QuestionKind = z.infer<typeof QuestionKind>;

export const QuestionView = z.object({
  question: QuestionId,
  work: WorkRef,
  kind: QuestionKind,
  text: z.string(),
  askedAt: Timestamp,
});
export type QuestionView = z.infer<typeof QuestionView>;

// One manual test-plan entry of a story under test (0002, DIPO-309): what to check and, when the
// plan names it, the expected result.
export const TestStep = z.object({ check: z.string(), expect: z.string().optional() });
export type TestStep = z.infer<typeof TestStep>;

// An open test of a story's pushed head in its test box (0002, DIPO-309). `checkout` is the test
// box's name; `url` is where the product the box runs is reached on the Mac (absent when the
// product has nothing to start); `shell` is the `dipo test shell <ID>` line.
export const TestView = z.object({
  test: TestId,
  story: StoryId,
  key: StoryKey,
  checkout: z.string(),
  head: z.string(),
  steps: z.array(TestStep),
  url: z.string().optional(),
  shell: z.string().optional(),
  startedAt: Timestamp,
});
export type TestView = z.infer<typeof TestView>;

// Why a test closed without a record (DIPO-309): a new head, the idle timeout, the story dropped,
// discarded, merged or out of review, its box lost, or a start that failed.
export const KNOWN_TEST_END_REASONS = [
  "new-head",
  "idle",
  "dropped",
  "discarded",
  "merged",
  "not-in-review",
  "box-lost",
  "start-failed",
] as const;
export const TestEndReason = openEnum(KNOWN_TEST_END_REASONS);
export type TestEndReason = z.infer<typeof TestEndReason>;

// The maintainer's planning session (DIPO-447, 0008): one per office, started with a kind and a
// goal, talked to turn by turn. It has no story, so its events carry the planning view, never a
// `WorkRef`. `plan` writes new stories, `refine` works on drafts, `triage` goes through the drafts with
// their origin and refines each into a story or drops it (DIPO-454).
export const PLANNING_KINDS = ["plan", "refine", "triage"] as const;
export const PlanningKind = openEnum(PLANNING_KINDS);
export type PlanningKind = z.infer<typeof PlanningKind>;

// What the session does now: its box and first turn start (`starting`), it answers (`working`),
// it waits for the maintainer's next message (`waiting`), or it ended.
export const KNOWN_PLANNING_STATES = ["starting", "working", "waiting", "ended"] as const;
export const PlanningState = openEnum(KNOWN_PLANNING_STATES);
export type PlanningState = z.infer<typeof PlanningState>;

// Why a planning session's model session ended: the maintainer ended the planning session, it
// waited for a message longer than `planning.idleHours`, its worker exited, its start failed, the
// daemon stopped, or its context neared full (DIPO-448). Every reason but `maintainer` and a
// failed first start leaves the planning session open to continue in a fresh model session.
export const KNOWN_PLANNING_END_REASONS = [
  "maintainer",
  "idle",
  "exited",
  "start-failed",
  "daemon-stopped",
  "context-full",
] as const;
export const PlanningEndReason = openEnum(KNOWN_PLANNING_END_REASONS);
export type PlanningEndReason = z.infer<typeof PlanningEndReason>;

// A story or an edit a planning session proposes (DIPO-450, 0022). The session writes each in its
// answer as a fenced block whose info string is `dipo-proposal`, holding one JSON object; the
// engine validates it against `PlanningProposal` and refuses an invalid one with a message to
// the session that lists its problems. `story` is a new story, filed Refined to the story standard
// (0012); `edit` changes an existing task's title, Story line, context, criteria, references or dependencies;
// `split` files a new story and edits the existing one; `refine` turns a draft into a Refined story
// to the story standard, with its new id and a branch named for it, and `drop` archives a draft
// (DIPO-454, triage). Every text is one line unless it is the
// context below the Story line; `storyLine` is the Story line without its `Story:` prefix.
export const PLANNING_PROPOSAL_FENCE = "dipo-proposal";

export const PLANNING_PROPOSAL_CAPS = {
  title: 100,
  storyLine: 500,
  context: 4_000,
  why: 300,
  criteria: 20,
  criterion: 500,
  references: 30,
  path: 200,
  dependencies: 10,
  testPlan: 20,
  check: 500,
  purpose: 300,
  instructions: 20_000,
  modelName: 100,
} as const;

// The story types of 0012 F5.
export const STORY_TYPES = [
  "feature",
  "bug",
  "enhancement",
  "task",
  "chore",
  "docs",
  "spike",
] as const;

// The shortest criterion (0012 R09) and test-plan text (R20).
const CHECKABLE_MIN = 10;

const proposalCaps = PLANNING_PROPOSAL_CAPS;

// Texts the description of a task could not hold as they are: Backlog.md finds its sections by
// HTML comment marks, a line of 50 `-` prints as a section, only dipo writes the field block, and a
// story has exactly one Story line (0010, 0012 R05).
function descriptionProblems(text: string): string[] {
  const problems: string[] = [];
  const lines = text.split(/\r?\n/);
  if (text.includes("<!--")) problems.push("holds <!--, which Backlog.md reads as a section mark");
  if (lines.some((line) => /^-{50,}$/.test(line.trim()))) {
    problems.push("holds a line of 50 -, which Backlog.md prints as a section");
  }
  if (lines.some((line) => line.trim() === "```dipo")) {
    problems.push("holds a ```dipo line; only dipo writes the field block");
  }
  if (lines.some((line) => line.startsWith("Story:"))) {
    problems.push("holds a Story: line; the Story line goes in storyLine");
  }
  return problems;
}

const OneLine = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[^\r\n]*$/, "must be one line")
    .refine(
      (text) => !text.includes("<!--"),
      "holds <!--, which Backlog.md reads as a section mark",
    );

const ProposalContext = z
  .string()
  .min(1)
  .max(proposalCaps.context)
  .superRefine((text, ctx) => {
    for (const problem of descriptionProblems(text))
      ctx.addIssue({ code: "custom", message: problem });
  });

// A repo-relative POSIX path outside the backlog (0012 F8, R12): plain characters only, so no comma
// splits it and no leading `-` reads as an option.
const ProposalPath = z
  .string()
  .max(proposalCaps.path)
  .regex(/^[A-Za-z0-9_.@+][A-Za-z0-9_./@+-]*$/, "must be a plain repo-relative path")
  .refine(
    (path) => !path.split("/").includes("..") && !path.startsWith("backlog/"),
    "must stay inside the repository and outside backlog/",
  );

// A task id such as `DIPO-12`; a draft's `DRAFT-n` is not one.
const ProposalTaskId = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9]*-[0-9]+$/, "must be a task id such as DIPO-12")
  .refine((id) => !/^DRAFT-/i.test(id), "must name a task, not a draft");

// A draft's id such as `DRAFT-3` (DIPO-454).
const ProposalDraftId = z.string().regex(/^DRAFT-[0-9]+$/i, "must be a draft id such as DRAFT-3");

export const PlanningTestPlanEntry = z.strictObject({
  kind: z.enum(["automated", "manual"]),
  check: OneLine(CHECKABLE_MIN, proposalCaps.check).describe("what the test or the step checks"),
  expect: OneLine(CHECKABLE_MIN, proposalCaps.check)
    .optional()
    .describe("manual entries: the expected result"),
});

export const PlanningTestPlan = z.union([
  z.strictObject({
    entries: z.array(PlanningTestPlanEntry).min(1).max(proposalCaps.testPlan),
  }),
  z.strictObject({
    notApplicable: OneLine(CHECKABLE_MIN, proposalCaps.check).describe("why no test applies"),
  }),
]);
export type PlanningTestPlan = z.infer<typeof PlanningTestPlan>;

const storyShape = {
  title: OneLine(1, proposalCaps.title)
    .regex(/^[\p{L}\p{N}]/u, "must start with a letter or a digit")
    .describe("a short name"),
  type: z.enum(STORY_TYPES),
  milestone: OneLine(1, 40).describe("the milestone it belongs to, as the backlog names it"),
  tier: z.enum(KNOWN_TIERS).describe("the proposed tier"),
  storyLine: OneLine(1, proposalCaps.storyLine).describe(
    "As <maintainer|worker|reviewer> I want <capability> so that <value>. For a spike: We need to decide <question> so that <value>. Plain words: no backticks, paths or code",
  ),
  context: ProposalContext.optional().describe("technical context below the Story line"),
  criteria: z
    .array(OneLine(CHECKABLE_MIN, proposalCaps.criterion))
    .min(1)
    .max(proposalCaps.criteria)
    .describe("done-when statements, one checkable fact each"),
  references: z
    .array(ProposalPath)
    .min(1)
    .max(proposalCaps.references)
    .describe("the files the story will probably touch"),
  dependencies: z
    .array(ProposalTaskId)
    .max(proposalCaps.dependencies)
    .optional()
    .describe("stories that must be Done first"),
  testPlan: PlanningTestPlan.optional().describe("every story but a spike has one; a spike none"),
};

type StoryShape = z.infer<z.ZodObject<typeof storyShape>>;

function storyChecks(story: Pick<StoryShape, "type" | "testPlan">, ctx: z.RefinementCtx): void {
  if (story.type === "spike" && story.testPlan !== undefined) {
    ctx.addIssue({ code: "custom", path: ["testPlan"], message: "a spike has no test plan" });
  }
  if (story.type !== "spike" && story.testPlan === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["testPlan"],
      message: "a story that is no spike needs a test plan",
    });
  }
  if (story.testPlan !== undefined && "entries" in story.testPlan) {
    for (const [index, entry] of story.testPlan.entries.entries()) {
      if (entry.kind === "manual" && entry.expect === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["testPlan", "entries", index, "expect"],
          message: "a manual entry needs its expected result",
        });
      }
    }
  }
}

const editShape = {
  title: storyShape.title.optional(),
  storyLine: storyShape.storyLine.optional(),
  context: ProposalContext.optional().describe(
    "the whole technical context below the Story line, replacing the old one",
  ),
  criteria: storyShape.criteria
    .optional()
    .describe("the whole list of criteria, replacing the old one"),
  references: storyShape.references
    .optional()
    .describe("the whole list of references, replacing the old one"),
  dependencies: z
    .array(ProposalTaskId)
    .max(proposalCaps.dependencies)
    .optional()
    .describe(
      "the whole list of stories that must be Done first, replacing the old one; an empty list clears them",
    ),
};

type EditShape = z.infer<z.ZodObject<typeof editShape>>;

function editChecks(edit: EditShape, ctx: z.RefinementCtx): void {
  if (Object.values(edit).every((value) => value === undefined)) {
    ctx.addIssue({ code: "custom", message: "an edit changes at least one field" });
  }
}

const Why = OneLine(1, proposalCaps.why).describe("one line of why");

// A new story's fields.
export const PlanningStoryFields = z.strictObject(storyShape).superRefine(storyChecks);
export type PlanningStoryFields = z.infer<typeof PlanningStoryFields>;

// The changes of an edit: each field given replaces the story's.
export const PlanningEditFields = z
  .strictObject(editShape)
  .superRefine((edit, ctx) => editChecks(edit, ctx));
export type PlanningEditFields = z.infer<typeof PlanningEditFields>;

// A role a planning session proposes to add, edit or remove (DIPO-474, 0022): the role file
// `.dipo/roles/<name>.md` (0017). `purpose`, `model` and `effort` are one line; `instructions` is
// the file's Markdown body. A role-edit names only the fields that change.
const RoleName = z
  .string()
  .min(1)
  .max(40)
  .describe("the role's name, which is its file name without .md");
const rolePurpose = OneLine(1, proposalCaps.purpose).describe("one line: what the role is for");
const roleModel = OneLine(1, proposalCaps.modelName).describe("the model this role uses");
const roleEffort = OneLine(1, proposalCaps.modelName).describe("the effort this role uses");
const roleInstructions = z
  .string()
  .min(1)
  .max(proposalCaps.instructions)
  .describe("the role's instructions, Markdown");

export const PlanningProposal = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("role"),
    name: RoleName,
    purpose: rolePurpose,
    model: roleModel.optional(),
    effort: roleEffort.optional(),
    instructions: roleInstructions,
    why: Why,
  }),
  z
    .strictObject({
      kind: z.literal("role-edit"),
      name: RoleName,
      purpose: rolePurpose.optional(),
      model: roleModel.optional(),
      effort: roleEffort.optional(),
      instructions: roleInstructions.optional(),
      why: Why,
    })
    .superRefine(({ purpose, model, effort, instructions }, ctx) => {
      if ([purpose, model, effort, instructions].every((value) => value === undefined)) {
        ctx.addIssue({ code: "custom", message: "a role edit changes at least one field" });
      }
    }),
  z.strictObject({ kind: z.literal("role-remove"), name: RoleName, why: Why }),
  z.strictObject({ kind: z.literal("story"), ...storyShape, why: Why }).superRefine(storyChecks),
  z
    .strictObject({
      kind: z.literal("edit"),
      id: ProposalTaskId.describe("the task the edit changes"),
      ...editShape,
      why: Why,
    })
    .superRefine(({ kind: _kind, id: _id, why: _why, ...edit }, ctx) => editChecks(edit, ctx)),
  z.strictObject({
    kind: z.literal("split"),
    id: ProposalTaskId.describe("the task that is split"),
    edit: PlanningEditFields.describe("the changes to the task that is split"),
    story: PlanningStoryFields.describe("the new story split off it"),
    why: Why,
  }),
  z
    .strictObject({
      kind: z.literal("refine"),
      draft: ProposalDraftId.describe("the draft refined into this story"),
      ...storyShape,
      why: Why,
    })
    .superRefine(storyChecks),
  z.strictObject({
    kind: z.literal("drop"),
    draft: ProposalDraftId.describe("the draft that is dropped"),
    why: Why,
  }),
]);
export type PlanningProposal = z.infer<typeof PlanningProposal>;

// The questions a planning session asks the maintainer (DIPO-455, 0022). The session writes them in
// its answer as one fenced block whose info string is `dipo-questions`, holding one JSON object; the
// engine validates it against `PlanningQuestions` and refuses an invalid one with a message to the
// session that lists its problems. The TUI shows a valid block as a dialog with a free answer beside
// the options, so a free answer is no field of the block.
export const PLANNING_QUESTIONS_FENCE = "dipo-questions";

export const PLANNING_QUESTION_CAPS = {
  questions: 4,
  header: 30,
  question: 300,
  purpose: 500,
  label: 80,
  description: 500,
} as const;

const questionCaps = PLANNING_QUESTION_CAPS;

export const PlanningQuestionOption = z.strictObject({
  label: OneLine(1, questionCaps.label).describe("the short choice"),
  description: OneLine(1, questionCaps.description).describe("what choosing it means"),
  recommended: z.boolean().optional().describe("true on the recommended option, which goes first"),
});
export type PlanningQuestionOption = z.infer<typeof PlanningQuestionOption>;

export const PlanningQuestion = z
  .strictObject({
    header: OneLine(1, questionCaps.header).describe("a short header"),
    question: OneLine(1, questionCaps.question).describe("the question, standing on its own"),
    purpose: OneLine(1, questionCaps.purpose).describe("why the question is asked"),
    options: z.array(PlanningQuestionOption).min(2).max(4),
  })
  .superRefine((question, ctx) => {
    if (question.options.filter((option) => option.recommended === true).length > 1) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: "at most one option is recommended",
      });
    }
  });
export type PlanningQuestion = z.infer<typeof PlanningQuestion>;

export const PlanningQuestions = z.strictObject({
  questions: z.array(PlanningQuestion).min(1).max(questionCaps.questions),
});
export type PlanningQuestions = z.infer<typeof PlanningQuestions>;

// A block of questions waiting for the maintainer's answers, numbered in the session. It leaves the
// view once `planning.answer` answered it.
export const PlanningQuestionBlock = z.object({
  n: z.int().positive(),
  questions: z.array(PlanningQuestion),
  at: Timestamp,
});
export type PlanningQuestionBlock = z.infer<typeof PlanningQuestionBlock>;

// How far a proposal got: `open` until the maintainer confirms or declines it, `filing` while its
// lane changes are journaled and not yet applied, `filed` once the lane applied them, `declined`,
// or `failed` when the lane closed a change of it with the reason in `detail`.
export const KNOWN_PROPOSAL_STATES = ["open", "filing", "filed", "declined", "failed"] as const;
export const PlanningProposalState = openEnum(KNOWN_PROPOSAL_STATES);
export type PlanningProposalState = z.infer<typeof PlanningProposalState>;

// One proposal of a planning session as the engine shows it: its number in the session, the
// proposal (as the maintainer last edited it, `edited`), its state, and the ids it filed or edited,
// from the session's record.
export const PlanningProposalView = z.object({
  n: z.int().positive(),
  proposal: PlanningProposal,
  state: PlanningProposalState,
  edited: z.boolean().optional(),
  stories: z.array(z.string()).optional(),
  detail: z.string().optional(),
  at: Timestamp,
});
export type PlanningProposalView = z.infer<typeof PlanningProposalView>;

// How far setting one story of a planning session Ready got (DIPO-451): `refused` when the gate
// failed it or it cannot be set yet (its `messages` say why) and it stays as it was, `setting`
// while the lane change is journaled and not yet applied, `set` once the lane applied it, or
// `failed` when the lane closed it with the reason in `detail`.
export const KNOWN_READY_STATES = ["refused", "setting", "set", "failed"] as const;
export const PlanningReadyState = openEnum(KNOWN_READY_STATES);
export type PlanningReadyState = z.infer<typeof PlanningReadyState>;

export const PlanningReadyView = z.object({
  story: z.string(),
  state: PlanningReadyState,
  // The gate's messages for a refused story.
  messages: z.array(z.string()).optional(),
  detail: z.string().optional(),
  at: Timestamp,
});
export type PlanningReadyView = z.infer<typeof PlanningReadyView>;

// A proposal block the engine refused, with its problems, as the message to the session listed them.
export const PlanningRefusal = z.object({ at: Timestamp, problems: z.array(z.string()) });
export type PlanningRefusal = z.infer<typeof PlanningRefusal>;

// One model session of a planning session, in order (DIPO-490): its run, when it started and, once
// it ended, when and why.
export const PlanningModelSession = z.object({
  run: RunId,
  startedAt: Timestamp,
  endedAt: Timestamp.optional(),
  ended: PlanningEndReason.optional(),
});
export type PlanningModelSession = z.infer<typeof PlanningModelSession>;

// A message the maintainer sent in a planning session, from its record (DIPO-490): the model
// session it went to and the end of that run's stored output when it was sent.
export const PlanningMessageView = z.object({
  run: RunId,
  text: z.string(),
  outputOffset: Count,
  at: Timestamp,
});
export type PlanningMessageView = z.infer<typeof PlanningMessageView>;

// The view of a planning session, derived by the engine. `usage` is the session's spend so far, as
// the model proxy counted it; `turns` the answers it finished; `health` is `quiet` or `stuck`
// only while it works on an answer, never while it waits for the maintainer. `proposals` are the
// session's proposals in order, `refusals` the latest refused blocks (DIPO-450).
export const PlanningView = z.object({
  run: RunId,
  // The planning session: the run of its first model session. `run` is the model session now.
  session: RunId.optional(),
  agent: AgentId.optional(),
  kind: PlanningKind,
  goal: z.string(),
  model: z.string(),
  state: PlanningState,
  health: Health.optional(),
  turns: Count,
  usage: UsageTotals,
  startedAt: Timestamp,
  lastOutputAt: Timestamp.optional(),
  endedAt: Timestamp.optional(),
  ended: PlanningEndReason.optional(),
  detail: z.string().optional(),
  // When the session last continued in a fresh model session, after its context filled or its
  // model session ended (DIPO-448); absent while it never did.
  continuedAt: Timestamp.optional(),
  // The session's model sessions in order, and the maintainer's messages from the record
  // (DIPO-490).
  sessions: z.array(PlanningModelSession).optional(),
  messages: z.array(PlanningMessageView).optional(),
  proposals: z.array(PlanningProposalView).optional(),
  refusals: z.array(PlanningRefusal).optional(),
  // The question blocks the maintainer has not answered yet (DIPO-455).
  questions: z.array(PlanningQuestionBlock).optional(),
  // The stories the maintainer chose to go Ready, and how far each got (DIPO-451).
  ready: z.array(PlanningReadyView).optional(),
});
export type PlanningView = z.infer<typeof PlanningView>;

export const GateDecision = z.enum(["approved", "rejected"]);
export type GateDecision = z.infer<typeof GateDecision>;

export const DecidedBy = z.enum(["maintainer", "rule"]);
export type DecidedBy = z.infer<typeof DecidedBy>;

export const TestResult = z.enum(["pass", "fail"]);
export type TestResult = z.infer<typeof TestResult>;

// Where stored output came from.
export const OutputSource = z.enum(["worker", "verify", "script"]);
export type OutputSource = z.infer<typeof OutputSource>;

// What an engine marker in the worker output marks: a phase the run entered, or its end.
export const KNOWN_OUTPUT_MARKER_KINDS = ["phase", "ended"] as const;
export const OutputMarkerKind = openEnum(KNOWN_OUTPUT_MARKER_KINDS);
export type OutputMarkerKind = z.infer<typeof OutputMarkerKind>;

// An engine-written marker in the stored worker output (DIPO-83), flagged as such
// (DIPO-95): the byte range of its line, what it marks (`phase build`, `ended parked`) and
// when. Only the engine sets it; worker text that reads like a marker carries no flag, so clients
// show it as text.
export const OutputMarker = z.object({
  from: z.int().nonnegative(),
  to: z.int().nonnegative(),
  kind: OutputMarkerKind,
  value: z.string().min(1),
  at: Timestamp,
});
export type OutputMarker = z.infer<typeof OutputMarker>;
