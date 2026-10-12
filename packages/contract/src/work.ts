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

// 0001 and 0012, plus `stopped` and `interrupted` (0005) and `needs-permission` and
// `worker-failed` (0008).
export const KNOWN_PARK_REASONS = [
  "ambiguous-spec",
  "verify-failing",
  "conflict",
  "scope-violation",
  "review-blocked",
  "budget-exceeded",
  "on-hold",
  "stopped",
  "interrupted",
  "needs-permission",
  "worker-failed",
] as const;
export const ParkReason = openEnum(KNOWN_PARK_REASONS);
export type ParkReason = z.infer<typeof ParkReason>;

// Why `work.run` did not start a story (0005 section 4). `notRunnable` covers states run never
// picks; `capacity` means `maxAgents` or the office cap was reached.
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
export const KNOWN_SIGNALS = [
  "quiet",
  "no-output",
  "same-failure",
  "input-wait",
  "plan-limit",
  "host-lost",
  "follow-only",
] as const;
export const Signal = openEnum(KNOWN_SIGNALS);
export type Signal = z.infer<typeof Signal>;

// The eight health states of 0009 section 3, in the engine's precedence order.
export const KNOWN_HEALTH = [
  "lost",
  "asking",
  "limited",
  "paused",
  "looping",
  "stuck",
  "quiet",
  "busy",
] as const;
export const Health = openEnum(KNOWN_HEALTH);
export type Health = z.infer<typeof Health>;

// Engine-derived queue column of a story (0009 section 3).
export const KNOWN_COLUMNS = [
  "draft",
  "refined",
  "ready",
  "waiting",
  "running",
  "review",
  "desk",
  "held",
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
  evidence: EvidenceMap.optional(),
});
export type StoryView = z.infer<typeof StoryView>;

export const ActiveSignal = z.object({ signal: Signal, since: Timestamp });
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

export const TestView = z.object({
  test: TestId,
  story: StoryId,
  key: StoryKey,
  checkout: z.string(),
  startedAt: Timestamp,
});
export type TestView = z.infer<typeof TestView>;

export const GateDecision = z.enum(["approved", "rejected"]);
export type GateDecision = z.infer<typeof GateDecision>;

export const DecidedBy = z.enum(["maintainer", "rule"]);
export type DecidedBy = z.infer<typeof DecidedBy>;

export const TestResult = z.enum(["pass", "fail"]);
export type TestResult = z.infer<typeof TestResult>;

// Where stored output came from.
export const OutputSource = z.enum(["worker", "verify", "script"]);
export type OutputSource = z.infer<typeof OutputSource>;
