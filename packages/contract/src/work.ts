// The story and work model: lifecycle, park and skip reasons, tiers, phases, signals, health,
// evidence, and the views the engine derives (0005 section 5 with the 0008 and 0009 additions).
// Clients render views as they arrive and never derive status themselves (0005 section 6).

import { z } from "zod";

import { AgentId, GateId, QuestionId, RoleId, RunId, StoryId, StoryKey, TestId } from "./ids";

// An open enum: the known values are exported, and any other string still parses, so an older
// client keeps working against a newer engine. A client renders an unknown value generically, as
// its plain word (0005 section 7 and amendment of 2026-10-12). A new known value is a minor change.
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

// 0012 section 2. Removed is engine-only: the terminal state of an archived or deleted story.
// Closed enum: a new state is a major change (0005 section 11).
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

// Why `work.run` did not start a story (0005 section 4). `notRunnable` covers states run never
// picks; `capacity` means `maxAgents` or the office cap was reached. The office's starts paused
// (0020) refuses the whole `work.run` instead of skipping a story.
export const KNOWN_SKIP_REASONS = [
  "parked",
  "notReady",
  "notRunnable",
  "dependency",
  "collision",
  "capacity",
  "pickupCheckFailed",
] as const;
export const SkipReason = openEnum(KNOWN_SKIP_REASONS);
export type SkipReason = z.infer<typeof SkipReason>;

// 0009 section 3, replacing the provisional names of 0005. `test` waits for the maintainer's test.
export const KNOWN_PHASES = ["setup", "build", "verify", "review", "test", "merge"] as const;
export const Phase = openEnum(KNOWN_PHASES);
export type Phase = z.infer<typeof Phase>;

// Watchdog signals of `work.observed` (0009 section 3).
export const KNOWN_WATCHDOG_SIGNALS = [
  "quiet",
  "no-output",
  "same-failure",
  "input-wait",
  "host-lost",
  "follow-only",
] as const;
export const WatchdogSignal = openEnum(KNOWN_WATCHDOG_SIGNALS);
export type WatchdogSignal = z.infer<typeof WatchdogSignal>;

// The health states of 0009 section 3, in the engine's precedence order. A plan limit pauses the
// office's starts and parks the session's story (0020), so no run shows `limited` or `paused`.
export const KNOWN_HEALTH = ["lost", "asking", "looping", "stuck", "quiet", "busy"] as const;
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

// How the engine knows a value (0009 section 3). Closed.
export const Evidence = z.enum(["checked", "claimed", "estimated", "none"]);
export type Evidence = z.infer<typeof Evidence>;

// Evidence per field path, sent only with the `evidence` capability flag (0009 section 8).
export const EvidenceMap = z.record(z.string(), Evidence);
export type EvidenceMap = z.infer<typeof EvidenceMap>;

// A story named in a command: its Backlog.md id or its key (0005 section 2).
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

export const VerifyState = z.enum(["none", "passing", "failing"]);
export type VerifyState = z.infer<typeof VerifyState>;

export const Progress = z.object({
  criteriaMet: Count,
  criteriaTotal: Count,
  loop: Count,
  loopCap: Count,
  verify: VerifyState,
  reviewRound: Count,
  // Since minor 1 (DIPO-140, 0019 section 14): the review rounds the story may run and how many
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

// One failed Ready gate rule (0012 section 3): `rule` is the R-number, `message` the full line
// `ready <ID> failed <rule>: <message>`.
export const GateRuleFailure = z.object({ rule: z.string(), message: z.string() });
export type GateRuleFailure = z.infer<typeof GateRuleFailure>;

// A failed Ready gate rule of a Refined story (minor 1, DIPO-97): the rule id and full line of
// `GateRuleFailure`, and `text`, the line after `ready <ID> failed <rule>: `, so a client shows
// the rule and what failed without parsing the line.
export const StoryGateFailure = GateRuleFailure.extend({ text: z.string() });
export type StoryGateFailure = z.infer<typeof StoryGateFailure>;

// The story's PR on the code host (0019 section 3). Since minor 1 (DIPO-140).
export const KNOWN_STORY_PR_STATES = ["open", "merged", "closed"] as const;
export const StoryPrState = openEnum(KNOWN_STORY_PR_STATES);
export type StoryPrState = z.infer<typeof StoryPrState>;

export const StoryPr = z.object({
  number: z.int().positive(),
  url: z.url(),
  state: StoryPrState,
});
export type StoryPr = z.infer<typeof StoryPr>;

// One criterion's result in a review round: exactly one per criterion of the story (0019
// section 5). `maintainer` means only the maintainer can check it.
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
// code check after its correction turn, so it is kept as advisory (0019 section 5).
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

// A maintainer override of a blocked review, with the required note (0019 section 11).
export const ReviewOverride = z.object({
  note: z.string().min(1),
  at: Timestamp,
});
export type ReviewOverride = z.infer<typeof ReviewOverride>;

// One review round as shown on `story.detail` (0019 section 14). `codeTreeKey` is the code tree key
// the verdict is keyed on (section 6); `carried` is set when an approval moved to a later head.
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
  carried: z.boolean().optional(),
  override: ReviewOverride.optional(),
});
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

// The review summary of a `gate.decided` event for a review gate (0019 section 14).
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
  // Since minor 1 (DIPO-97): the failed rules among `gateMessages`, in the same order, each with
  // its rule id. A message no rule gave (a pickup check that could not size the story) is only in
  // `gateMessages`.
  gateFailures: z.array(StoryGateFailure).optional(),
  // Since minor 1 (DIPO-140): the story's PR, once one is open.
  pr: StoryPr.optional(),
  evidence: EvidenceMap.optional(),
});
export type StoryView = z.infer<typeof StoryView>;

export const ActiveSignal = z.object({ signal: WatchdogSignal, since: Timestamp });
export type ActiveSignal = z.infer<typeof ActiveSignal>;

export const WorkView = z.object({
  work: WorkRef,
  phase: Phase,
  progress: Progress,
  usage: Usage,
  health: Health,
  signals: z.array(ActiveSignal), // watchdog signals in effect
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

// `permission`: the worker's permission hook asks the maintainer (0008 section 5).
export const QuestionKind = z.enum(["question", "permission"]);
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

// An engine-written marker in the stored worker output (DIPO-83), flagged as such since minor 1
// (DIPO-95): the byte range of its line, what it marks (`phase verify`, `ended in-review`) and
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
