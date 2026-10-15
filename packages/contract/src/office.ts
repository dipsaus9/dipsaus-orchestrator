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
  WatchdogSignal,
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
  // Omit `stories` and the engine picks from the Ready queue. Since minor 1 (DIPO-48): `from` is
  // the main worktree a client resolved the office from (its current directory); the daemon
  // answers `office.unknown` when it is not the office's registered path.
  args: z.object({
    stories: z.array(StoryRefValue).optional(),
    maxAgents: z.int().positive().optional(),
    from: z.string().min(1).optional(),
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
  // `run` names the run an answer to a `needs-permission` park resumed (DIPO-75, minor 1).
  result: z.object({
    question: QuestionId,
    delivered: z.enum(["now", "on-resume"]),
    run: RunId.optional(),
  }),
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
// it starts or re-attaches a run. Since minor 1 (DIPO-61) the engine implements it for runs held
// by a plan limit: the held session continues at once and a `credits` hold is lifted. A parked
// story is not resumed yet; it fails `story.notPausedOrParked` like a story with no held run.
export const workResume = defineCommand({
  name: "work.resume",
  level: "office",
  args: z.object({ ...StoryRef.shape, note: z.string().optional() }),
  result: z.object({ story: StoryId, key: StoryKey, to: Lifecycle, run: RunId.optional() }),
  confirm: false,
  irreversible: false,
  since: 1,
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

// Switching offices changes no engine fact, so it is a read (0005 sections 4 and 7, 0009 section 4):
// the same args and result as `office.snapshot`. The client keeps the chosen office and sends it on
// every command. Since minor 1 (DIPO-52).
export const officeSwitch = defineRead({
  name: "office.switch",
  args: OfficeArgs,
  result: OfficeSnapshot,
  since: 1,
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

// One decided gate: a verdict on the story. `run` names the run it was decided on, absent for a
// gate outside a run, such as the Ready gate (`ready`) or its pickup re-check (`pickup`);
// `failures` holds the messages of the rules that failed (checked before v0.1.0, DIPO-52).
export const Verdict = z.object({
  gate: GateId,
  run: RunId.optional(),
  kind: GateKind,
  decision: GateDecision,
  by: DecidedBy,
  note: z.string().optional(),
  failures: z.array(z.string()).optional(),
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
    // The story's open questions (DIPO-59, minor 1), oldest first.
    questions: z.array(QuestionView).optional(),
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

// One failed Ready gate rule (0012 section 3): `rule` is the R-number, `message` the full line
// `ready <ID> failed <rule>: <message>`.
export const GateRuleFailure = z.object({ rule: z.string(), message: z.string() });
export type GateRuleFailure = z.infer<typeof GateRuleFailure>;

// The Ready gate of one story in `ready` mode, evaluated on the office's base and not stored
// (M0 breakdown decision D3, DIPO-71). It passes only with no failures; failures are in rule order.
export const storyGate = defineRead({
  name: "story.gate",
  args: z.object({ office: OfficeId, story: StoryRefValue }),
  result: z.object({
    story: StoryId,
    key: StoryKey,
    passed: z.boolean(),
    failures: z.array(GateRuleFailure),
  }),
  since: 1,
});

// The worker launch `work.run` would make for the story it would pick (DIPO-74): the branch and
// worktree it would create, the launch (absolute program path first in `argv`, the environment
// variable names without their values, the files written into the run directory, such as the run
// settings with the sandbox), and the system file and task message the worker would get. The run
// id, the session id and the run directory are placeholders until a real run makes them.
export const WorkerLaunchPreview = z.object({
  adapter: z.string(),
  branch: z.string(),
  worktree: z.string(),
  runDir: z.string(),
  cwd: z.string(),
  argv: z.array(z.string()).min(1),
  model: z.string(),
  effort: z.string(),
  caps: z.object({
    budgetTokens: Count,
    maxTurns: Count,
    maxMinutes: Count,
    loops: Count,
  }),
  envNames: z.array(z.string()),
  files: z.array(z.object({ name: z.string(), content: z.string() })),
  systemFile: z.object({ path: z.string(), text: z.string() }),
  taskMessage: z.string(),
});
export type WorkerLaunchPreview = z.infer<typeof WorkerLaunchPreview>;

// What `work.run` would do now, without doing it (DIPO-74, `dipo run --dry-run`). It selects as
// `work.run` does, from the base as last fetched, and claims, creates and stores nothing, not
// even a gate decision. `refusals` are the office checks that would refuse `work.run`; `notes`
// say what would not refuse it but matters (an adapter hold a named run re-checks); `story` is
// the story it would start and `launch` its worker launch, or null; `problem` says why no launch
// could be planned for that story.
export const workPreview = defineRead({
  name: "work.preview",
  args: z.object({ office: OfficeId, stories: z.array(StoryRefValue).optional() }),
  result: z.object({
    refusals: z.array(z.object({ check: z.string(), message: z.string() })),
    // Information that refuses nothing, such as an adapter hold the named run will re-check.
    notes: z.array(z.string()).optional(),
    story: StoryResult.nullable(),
    skipped: z.array(
      z.object({
        story: StoryId,
        key: StoryKey,
        reason: SkipReason,
        detail: z.array(z.string()).optional(),
      }),
    ),
    launch: WorkerLaunchPreview.nullable(),
    problem: z.string().nullable(),
  }),
  since: 1,
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

// Size of one office-scoped table for one office (0007 "Size"): its row count and the approximate
// bytes of its column data, so the retention periods can be tuned. Not a file size: indexes, page
// overhead and free pages are not counted.
export const TableStats = z.object({
  table: z.string(),
  rows: Count,
  bytes: Count,
});
export type TableStats = z.infer<typeof TableStats>;

// Row count and approximate bytes of each office-scoped table of the office, by table name
// (minor 1, DIPO-65) [`dipo stats`].
export const officeStats = defineRead({
  name: "office.stats",
  args: OfficeArgs,
  result: z.object({ office: OfficeId, tables: z.array(TableStats) }),
  since: 1,
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

// The work events below carry, since minor 1 (DIPO-52), the optional `view`: the `WorkView` the
// engine derived when it stored the fact (0005 section 6), so a client replaces the run's view
// and never derives health or phase itself.

// Run start, re-attach on resume, reassign.
export const workAssigned = defineEvent({
  type: "work.assigned",
  stream: "office",
  derived: false,
  data: z.object({ work: WorkRef, view: WorkView.optional() }),
});

export const workPhase = defineEvent({
  type: "work.phase",
  stream: "office",
  derived: false,
  data: z.object({ work: WorkRef, phase: Phase, progress: Progress, view: WorkView.optional() }),
});

// Debounced, latest wins.
export const workProgress = defineEvent({
  type: "work.progress",
  stream: "office",
  derived: false,
  data: z.object({ work: WorkRef, progress: Progress, view: WorkView.optional() }),
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
    view: WorkView.optional(),
  }),
});

// Watchdog facts. `clearedAt` is set when the signal stopped, for example `quiet` on the next line
// (DIPO-52).
export const workObserved = defineEvent({
  type: "work.observed",
  stream: "office",
  derived: false,
  data: z.object({
    work: WorkRef,
    signal: WatchdogSignal,
    since: Timestamp,
    clearedAt: Timestamp.optional(),
    view: WorkView.optional(),
  }),
});

// Cumulative, so a duplicate or skipped one is harmless.
export const usageUpdated = defineEvent({
  type: "usage.updated",
  stream: "office",
  derived: false,
  data: z.object({ work: WorkRef, usage: Usage, view: WorkView.optional() }),
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
  officeSwitch,
  storyDetail,
  workOutputRange,
  officeUsage,
  officeDigest,
  storyGate,
  officeStats,
  workPreview,
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
