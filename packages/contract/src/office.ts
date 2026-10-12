// Office-level messages: work, story, gate and test commands, the office reads and the office
// events (0005 sections 4, 5 and 7 with the 0008 and 0009 additions). Commands no engine has built
// yet are provisional (0005 section 11, amendment of 2026-10-12); the engine hides them with
// capability flags.

import { z } from "zod";

import { defineCommand, defineEvent, defineRead } from "./definition";
import { CommandName } from "./envelope";
import {
  AgentId,
  Cursor,
  GateId,
  OfficeId,
  QuestionId,
  RoleId,
  RunId,
  StoryId,
  StoryKey,
  TestId,
} from "./ids";
import {
  DecidedBy,
  EvidenceMap,
  GateDecision,
  GateKind,
  GateView,
  Lifecycle,
  OutputSource,
  ParkReason,
  Phase,
  Progress,
  QuestionView,
  Signal,
  SkipReason,
  StoryRef,
  StoryRefValue,
  StoryView,
  TestResult,
  TestView,
  Tier,
  Usage,
  UsageTotals,
  WorkRef,
  WorkView,
} from "./work";

const Count = z.int().nonnegative();
const Timestamp = z.iso.datetime();
const Offset = z.int().nonnegative(); // byte offset in stored output
const StoryResult = z.object({ story: StoryId, key: StoryKey });
const RunResult = z.object({ run: RunId });

// Commands

export const workRun = defineCommand({
  name: "work.run",
  level: "office",
  // Omit `stories` and the engine picks from the Ready queue.
  args: z.object({
    stories: z.array(StoryRefValue).optional(),
    maxAgents: z.int().positive().optional(),
  }),
  // Per-story problems are skips, not command errors.
  result: z.object({
    started: z.array(z.object({ story: StoryId, key: StoryKey, run: RunId })),
    skipped: z.array(z.object({ story: StoryId, key: StoryKey, reason: SkipReason })),
  }),
  confirm: false,
  irreversible: false,
  since: 0,
});

// `decision` answers a permission question (0008 section 5): allow once or deny.
export const workAnswer = defineCommand({
  name: "work.answer",
  level: "office",
  args: z.object({
    question: QuestionId,
    text: z.string(),
    decision: z.enum(["allow", "deny"]).optional(),
  }),
  result: z.object({ question: QuestionId, delivered: z.enum(["now", "on-resume"]) }),
  confirm: false,
  irreversible: false,
  since: 0,
});

export const workSteer = defineCommand({
  name: "work.steer",
  level: "office",
  args: z.object({ ...StoryRef.shape, text: z.string().min(1) }),
  result: z.object({ run: RunId, delivered: z.literal("next-turn") }),
  confirm: false,
  irreversible: false,
  provisional: true,
});

// The worker is held at its next safe point.
export const workPause = defineCommand({
  name: "work.pause",
  level: "office",
  args: StoryRef,
  result: RunResult,
  confirm: false,
  irreversible: false,
  provisional: true,
});

// A paused run continues; a parked story returns to `park.from`, and to In Progress or In Review
// it starts or re-attaches a run. Provisional until DIPO-61 ships it for held runs.
export const workResume = defineCommand({
  name: "work.resume",
  level: "office",
  args: z.object({ ...StoryRef.shape, note: z.string().optional() }),
  result: z.object({ story: StoryId, key: StoryKey, to: Lifecycle, run: RunId.optional() }),
  confirm: false,
  irreversible: false,
  provisional: true,
});

// A new agent with a bounded handoff; the old one is stopped first.
export const workReassign = defineCommand({
  name: "work.reassign",
  level: "office",
  args: z.object({ ...StoryRef.shape, role: RoleId.optional(), tier: Tier.optional() }),
  result: z.object({ run: RunId, agent: AgentId }),
  confirm: true,
  irreversible: false,
  provisional: true,
});

// The worker ends, branch and worktree are kept, and the story parks as `stopped`.
export const workStop = defineCommand({
  name: "work.stop",
  level: "office",
  args: z.object({ ...StoryRef.shape, note: z.string().optional() }),
  result: RunResult,
  confirm: true,
  irreversible: false,
  since: 0,
});

// Ends the run, removes the worktree, deletes the story branch and returns the story to Refined.
export const workDiscard = defineCommand({
  name: "work.discard",
  level: "office",
  args: z.object({ ...StoryRef.shape, note: z.string().min(1) }),
  result: StoryResult,
  confirm: true,
  irreversible: true,
  provisional: true,
});

// Parks a Refined or Ready story with reason `on-hold`.
export const storyHold = defineCommand({
  name: "story.hold",
  level: "office",
  args: z.object({ ...StoryRef.shape, note: z.string().min(1) }),
  result: StoryResult,
  confirm: false,
  irreversible: false,
  provisional: true,
});

// Archives the story; deletes its branch only when asked. Clients ask for typed confirmation when
// `deleteBranch` is true (0009 section 5); the flag below covers the command as a whole.
export const storyDrop = defineCommand({
  name: "story.drop",
  level: "office",
  args: z.object({ ...StoryRef.shape, deleteBranch: z.boolean() }),
  result: StoryResult,
  confirm: true,
  irreversible: false,
  provisional: true,
});

export const gateApprove = defineCommand({
  name: "gate.approve",
  level: "office",
  args: z.object({ gate: GateId, note: z.string().optional() }),
  result: z.object({ gate: GateId, decision: z.literal("approved") }),
  confirm: false,
  irreversible: false,
  provisional: true,
});

// The note becomes worker input.
export const gateReject = defineCommand({
  name: "gate.reject",
  level: "office",
  args: z.object({ gate: GateId, note: z.string().min(1) }),
  result: z.object({ gate: GateId, decision: z.literal("rejected") }),
  confirm: true,
  irreversible: false,
  provisional: true,
});

export const testStart = defineCommand({
  name: "test.start",
  level: "office",
  args: StoryRef,
  result: z.object({ test: TestId, checkout: z.string(), script: z.array(z.string()) }),
  confirm: false,
  irreversible: false,
  provisional: true,
});

// A fail needs a note; it sends the story back to In Progress with the note as worker input.
export const testRecord = defineCommand({
  name: "test.record",
  level: "office",
  args: z
    .object({ test: TestId, result: TestResult, note: z.string().optional() })
    .refine((a) => a.result === "pass" || (a.note !== undefined && a.note.trim() !== ""), {
      message: "a failed test needs a note",
      path: ["note"],
    }),
  result: z.object({ test: TestId, result: TestResult }),
  confirm: false,
  irreversible: false,
  provisional: true,
});

// Reads

const OfficeArgs = z.object({ office: OfficeId });

// Derived and consistent with `cursor`: subscribe after it for a gap-free stream (0005 section 8).
export const OfficeSnapshot = z.object({
  cursor: Cursor,
  stories: z.array(StoryView),
  work: z.array(WorkView),
  gates: z.array(GateView),
  questions: z.array(QuestionView),
  tests: z.array(TestView),
});
export type OfficeSnapshot = z.infer<typeof OfficeSnapshot>;

export const officeSnapshot = defineRead({
  name: "office.snapshot",
  args: OfficeArgs,
  result: OfficeSnapshot,
  since: 0,
});

// One past or current run of a story.
export const RunRecord = z.object({
  run: RunId,
  agents: z.array(AgentId),
  role: RoleId,
  tier: Tier,
  model: z.string(),
  startedAt: Timestamp,
  endedAt: Timestamp.optional(),
  outcome: z.string().optional(), // how the run ended, absent while it runs
  usage: UsageTotals,
});
export type RunRecord = z.infer<typeof RunRecord>;

// One decided gate: a verdict on a run.
export const Verdict = z.object({
  gate: GateId,
  run: RunId,
  kind: GateKind,
  decision: GateDecision,
  by: DecidedBy,
  note: z.string().optional(),
  at: Timestamp,
});
export type Verdict = z.infer<typeof Verdict>;

export const storyDetail = defineRead({
  name: "story.detail",
  args: z.object({ office: OfficeId, story: StoryRefValue }),
  result: z.object({
    view: StoryView,
    work: WorkView.optional(), // the active run, if any
    runs: z.array(RunRecord), // oldest first
    verdicts: z.array(Verdict),
  }),
  since: 0,
});

// Stored output text for a byte range; `to` absent reads to the end of what is stored.
export const workOutputRange = defineRead({
  name: "work.outputRange",
  args: z.object({
    office: OfficeId,
    run: RunId,
    source: OutputSource,
    from: Offset,
    to: Offset.optional(),
  }),
  result: z.object({
    run: RunId,
    source: OutputSource,
    from: Offset,
    to: Offset,
    text: z.string(),
  }),
  since: 0,
});

export const UsageWindow = z.enum(["today", "7d", "30d"]);
export type UsageWindow = z.infer<typeof UsageWindow>;

export const UsageGroup = z.object({
  group: z.string(), // a story id, role name or tier
  stories: Count,
  tokens: Count, // counted as the budget counts
  averageBudgetShare: z.number().nonnegative(),
  within: Count, // stories that stayed within budget
  over: Count, // stories parked with budget-exceeded
  averageLoops: z.number().nonnegative(),
  weekly: z.array(Count), // tokens per week, oldest first
  estimatedCost: z.number().nonnegative().optional(),
});
export type UsageGroup = z.infer<typeof UsageGroup>;

// Engine-derived usage report for the cost view (0009 section 8) [`usage.report`].
export const officeUsage = defineRead({
  name: "office.usage",
  args: z.object({
    office: OfficeId,
    groupBy: z.enum(["story", "role", "tier"]),
    window: UsageWindow,
  }),
  result: z.object({
    unit: z.literal("tokens"),
    groups: z.array(UsageGroup),
    evidence: EvidenceMap.optional(),
  }),
  provisional: true,
});

// Code-built "since you left" counts and lines (0009 section 8) [`digest`].
export const officeDigest = defineRead({
  name: "office.digest",
  args: z.object({ office: OfficeId, since: Timestamp }),
  result: z.object({
    since: Timestamp,
    counts: z.record(z.string(), Count), // for example done, parked
    lines: z.array(z.string()),
    evidence: EvidenceMap.optional(),
  }),
  provisional: true,
});

// Events (office stream, 0005 section 5)

// `detail` holds gate failure messages, for example a failed pickup re-check.
export const storyState = defineEvent({
  type: "story.state",
  stream: "office",
  derived: false,
  data: z.object({
    story: StoryId,
    key: StoryKey,
    from: Lifecycle,
    to: Lifecycle,
    view: StoryView,
    detail: z.array(z.string()).optional(),
  }),
});

export const storyRenumbered = defineEvent({
  type: "story.renumbered",
  stream: "office",
  derived: false,
  data: z.object({
    key: StoryKey,
    from: StoryId,
    to: StoryId,
    detectedBy: z.enum(["engine", "reconcile"]),
  }),
});

// Run start, re-attach on resume, reassign.
export const workAssigned = defineEvent({
  type: "work.assigned",
  stream: "office",
  derived: false,
  data: z.object({ work: WorkRef }),
});

export const workPhase = defineEvent({
  type: "work.phase",
  stream: "office",
  derived: false,
  data: z.object({ work: WorkRef, phase: Phase, progress: Progress }),
});

// Debounced, latest wins.
export const workProgress = defineEvent({
  type: "work.progress",
  stream: "office",
  derived: false,
  data: z.object({ work: WorkRef, progress: Progress }),
});

// A byte range in the stored output.
export const workOutput = defineEvent({
  type: "work.output",
  stream: "office",
  derived: false,
  data: z.object({
    work: WorkRef,
    source: OutputSource,
    from: Offset,
    to: Offset,
    text: z.string(),
  }),
});

// Watchdog facts.
export const workObserved = defineEvent({
  type: "work.observed",
  stream: "office",
  derived: false,
  data: z.object({ work: WorkRef, signal: Signal, since: Timestamp }),
});

// Cumulative, so a duplicate or skipped one is harmless.
export const usageUpdated = defineEvent({
  type: "usage.updated",
  stream: "office",
  derived: false,
  data: z.object({ work: WorkRef, usage: Usage }),
});

export const gateReached = defineEvent({
  type: "gate.reached",
  stream: "office",
  derived: false,
  data: GateView,
});

export const gateDecided = defineEvent({
  type: "gate.decided",
  stream: "office",
  derived: false,
  data: z.object({
    gate: GateId,
    decision: GateDecision,
    by: DecidedBy,
    note: z.string().optional(),
  }),
});

// Answered with `work.answer`.
export const questionAsked = defineEvent({
  type: "question.asked",
  stream: "office",
  derived: false,
  data: QuestionView,
});

export const questionClosed = defineEvent({
  type: "question.closed",
  stream: "office",
  derived: false,
  data: z.object({ question: QuestionId, answer: z.string().optional() }),
});

// Sent with `story.state` to Parked. `work` is absent for `on-hold`, where `detail` is the hold
// note. `actions` lists the commands a client may offer, such as `work.resume`, `work.discard`
// and `story.drop`.
export const storyParked = defineEvent({
  type: "story.parked",
  stream: "office",
  derived: false,
  data: z.object({
    story: StoryId,
    key: StoryKey,
    work: WorkRef.optional(),
    reason: ParkReason,
    detail: z.string(),
    from: Lifecycle,
    lastGoodCommit: z.string().optional(),
    actions: z.array(CommandName),
  }),
});

export const testStarted = defineEvent({
  type: "test.started",
  stream: "office",
  derived: false,
  data: TestView,
});

export const testRecorded = defineEvent({
  type: "test.recorded",
  stream: "office",
  derived: false,
  data: z.object({
    test: TestId,
    story: StoryId,
    key: StoryKey,
    result: TestResult,
    note: z.string().optional(),
  }),
});

export const officeCommands = [
  workRun,
  workAnswer,
  workSteer,
  workPause,
  workResume,
  workReassign,
  workStop,
  workDiscard,
  storyHold,
  storyDrop,
  gateApprove,
  gateReject,
  testStart,
  testRecord,
] as const;

export const officeReads = [
  officeSnapshot,
  storyDetail,
  workOutputRange,
  officeUsage,
  officeDigest,
] as const;

export const officeEvents = [
  storyState,
  storyRenumbered,
  workAssigned,
  workPhase,
  workProgress,
  workOutput,
  workObserved,
  usageUpdated,
  gateReached,
  gateDecided,
  questionAsked,
  questionClosed,
  storyParked,
  testStarted,
  testRecorded,
] as const;
