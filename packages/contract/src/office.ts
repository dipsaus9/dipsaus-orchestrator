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
  GateRuleFailure,
  GateView,
  Lifecycle,
  OutputMarker,
  openEnum,
  OutputSource,
  ParkReason,
  Phase,
  Progress,
  QuestionView,
  ReviewSummary,
  ReviewVerdict,
  WatchdogSignal,
  SkipReason,
  StoryPr,
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
  // answers `office.unknown` when it is not the office's registered path. Since minor 1
  // (DIPO-271): `box` asked for a box run (0021); since DIPO-240 every run is a box run, so it is
  // accepted and changes nothing.
  args: z.object({
    stories: z.array(StoryRefValue).optional(),
    maxAgents: z.int().positive().optional(),
    from: z.string().min(1).optional(),
    box: z.boolean().optional(),
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

// Since minor 1 (DIPO-163, 0020 section 9): a running worker gets the text as its next user message
// (`next-turn`); a steer to a paused or parked story is stored once and sent with the first message
// on resume (`on-resume`). A story whose live session is its reviewer, or whose host is followed
// only, answers `story.notSteerable`.
export const workSteer = defineCommand({
  name: "work.steer",
  level: "office",
  args: z.object({ ...StoryRef.shape, text: z.string().min(1) }),
  result: z.object({ run: RunId, delivered: z.enum(["next-turn", "on-resume"]) }),
  confirm: false,
  irreversible: false,
  since: 1,
});

// Since minor 1 (DIPO-163, 0020 section 9): the worker is held; the run stays In Progress with
// health `paused` and keeps its claim, slot and session place until stdin closes after 10 minutes.
export const workPause = defineCommand({
  name: "work.pause",
  level: "office",
  args: StoryRef,
  result: RunResult,
  confirm: false,
  irreversible: false,
  since: 1,
});

// A paused run continues (DIPO-163: at once while its worker lives, else with `--resume`, queued when
// the worker place is taken); a parked story returns to `park.from`, and to In Progress or In Review
// it starts or re-attaches a run. Since minor 1 (DIPO-61) the engine implements it for runs held
// by a plan limit: the held session continues at once and a `credits` hold is lifted. A parked
// story is not resumed yet; it fails `story.notPausedOrParked` like a story with no held run.
export const workResume = defineCommand({
  name: "work.resume",
  level: "office",
  args: z.object({ ...StoryRef.shape, note: z.string().optional() }),
  // `queued` (DIPO-163): the run waits for the office's worker place before its session starts.
  result: z.object({
    story: StoryId,
    key: StoryKey,
    to: Lifecycle,
    run: RunId.optional(),
    queued: z.boolean().optional(),
  }),
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

// Ends the run, removes the worktree, deletes the story branch and returns the story to Refined
// (0020 section 8). Since minor 1 (DIPO-161), on the waiting command path. Clients list what is
// lost (`story.losses`) and ask for the story id typed out. Also discards the leftovers of a story
// Done on the base through another branch, with no backlog write. Errors: `story.prMerged`,
// `story.notDiscardable`, `story.prNotClosed`, and the retryable `run.hostAlive` while a worker
// host of the run still runs. A remote branch whose tip dipo did not push is kept with a notice.
export const workDiscard = defineCommand({
  name: "work.discard",
  level: "office",
  args: z.object({ ...StoryRef.shape, note: z.string().min(1) }),
  result: StoryResult,
  confirm: true,
  irreversible: true,
  since: 1,
});

// Parks a Refined or Ready story with reason `on-hold` through the planning lane (0020 section 8).
// Since minor 1 (DIPO-160). A running story fails `story.notHoldable` naming `dipo stop`; a parked
// story with a claim fails it naming resume and discard.
export const storyHold = defineCommand({
  name: "story.hold",
  level: "office",
  args: z.object({ ...StoryRef.shape, note: z.string().min(1) }),
  result: StoryResult,
  confirm: false,
  irreversible: false,
  since: 1,
});

// Archives the story through the planning lane and releases its claim; deletes its branch only
// when asked (0020 section 8). Since minor 1 (DIPO-160). Clients ask for typed confirmation when
// `deleteBranch` is true (0009 section 5); `irreversibleWhen` says so in `commands.describe`.
// Errors: `story.active` (In Progress or In Review), `story.hasDependents`, `story.dirtyWorktree`,
// and `run.hostAlive` while a worker host of the parked run still runs (0020 section 8, DIPO-227).
export const storyDrop = defineCommand({
  name: "story.drop",
  level: "office",
  args: z.object({ ...StoryRef.shape, deleteBranch: z.boolean() }),
  result: StoryResult,
  confirm: true,
  irreversible: false,
  irreversibleWhen: ["deleteBranch"],
  since: 1,
});

// Since minor 1 (DIPO-140): the maintainer's decision on a gate, such as a merge gate that waits
// for the maintainer (0019 section 11).
export const gateApprove = defineCommand({
  name: "gate.approve",
  level: "office",
  args: z.object({ gate: GateId, note: z.string().optional() }),
  result: z.object({ gate: GateId, decision: z.literal("approved") }),
  confirm: false,
  irreversible: false,
  since: 1,
});

// The note becomes worker input.
export const gateReject = defineCommand({
  name: "gate.reject",
  level: "office",
  args: z.object({ gate: GateId, note: z.string().min(1) }),
  result: z.object({ gate: GateId, decision: z.literal("rejected") }),
  confirm: true,
  irreversible: false,
  since: 1,
});

// A worker's proposal (0020 section 11c, DIPO-186): its stored id is a hash of 64 lower-case hex
// characters. A command may name it by a unique prefix of at least 8 of them.
export const ProposalId = z.string().regex(/^[0-9a-f]{64}$/, "expected a proposal id");
export type ProposalId = z.infer<typeof ProposalId>;
export const ProposalRef = z
  .string()
  .regex(/^[0-9a-f]{8,64}$/, "expected a proposal id, or at least its first 8 characters");

// Since minor 1 (DIPO-166; 0020 sections 11c and 14) [`proposals`]: files an open follow-up, spike
// or tool proposal of a worker as a Backlog draft through the planning lane, with the title, the
// outcome line, the paths as references and the source story in the description, the worker's
// text marked as the worker's words. `draft` is the draft's id once the lane created it; draft ids
// are reused by Backlog.md, so it names the draft only until it is promoted or archived. Accepting
// an accepted proposal changes nothing. Errors: `proposal.unknown`, `proposal.ambiguous` (a prefix
// of several), `proposal.closed` (dismissed already).
export const proposalAccept = defineCommand({
  name: "proposal.accept",
  level: "office",
  args: z.object({ proposal: ProposalRef }),
  result: z.object({
    proposal: ProposalId,
    state: z.literal("accepted"),
    draft: z.string().optional(),
  }),
  confirm: false,
  irreversible: false,
  since: 1,
});

// Since minor 1 (DIPO-166) [`proposals`]: closes an open proposal without filing anything.
// Dismissing a dismissed proposal changes nothing. Errors as `proposal.accept`; `proposal.closed`
// when it was accepted already.
export const proposalDismiss = defineCommand({
  name: "proposal.dismiss",
  level: "office",
  args: z.object({ proposal: ProposalRef }),
  result: z.object({ proposal: ProposalId, state: z.literal("dismissed") }),
  confirm: false,
  irreversible: false,
  since: 1,
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

// The notes and proposals of a run's done report (DIPO-152), the worker's own words, cleaned and
// capped as door messages are (0021 section 7). Absent when the report had neither.
export const DoneReport = z.object({
  notes: z.string().optional(),
  proposals: z
    .array(
      z.object({
        kind: z.string(),
        title: z.string(),
        outcome: z.string(),
        why: z.string(),
        paths: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});
export type DoneReport = z.infer<typeof DoneReport>;

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
  // Since minor 1 (DIPO-152): the notes and proposals of the done report that ended the run.
  doneReport: DoneReport.optional(),
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
  // Since minor 1 (DIPO-140): the review round of a review gate (0019 section 14).
  review: ReviewVerdict.optional(),
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
    // A conflict with the base found while the story is In Review (DIPO-149, minor 1; 0019 section
    // 10): the base, the base commit and the conflicted paths. Absent once a merge handled it.
    baseConflict: z
      .object({
        base: z.string(),
        onto: z.string(),
        paths: z.array(z.string()),
        at: Timestamp,
      })
      .optional(),
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
    // The engine markers that overlap the range (DIPO-95, minor 1), oldest first; absent when none.
    markers: z.array(OutputMarker).optional(),
  }),
  since: 0,
});

// The prompt text dipo sent a worker session (DIPO-137, `privacy.storePrompts`): the system file
// (`system`) and the first message (`message`) of one agent, in that order. `texts` is empty when
// none is stored: the opt-in is off, retention removed it, or the session was never started. A
// resume stores only its message, because the session keeps the system file it started with.
export const PromptPart = z.enum(["system", "message"]);
export type PromptPart = z.infer<typeof PromptPart>;

export const workPrompt = defineRead({
  name: "work.prompt",
  args: z.object({ office: OfficeId, run: RunId, agent: AgentId }),
  result: z.object({
    run: RunId,
    agent: AgentId,
    texts: z.array(z.object({ part: PromptPart, text: z.string() })),
  }),
  since: 1,
});

// A dependency of a story that is not Done on the office's base (DIPO-179): its id and its status
// there. The status is absent when the Backlog CLI could not read the dependency (missing or
// ambiguous), so the story waits on it but its status is unknown.
export const GateDependency = z.object({ id: z.string(), status: z.string().optional() });
export type GateDependency = z.infer<typeof GateDependency>;

// The Ready gate of one story in `ready` mode, evaluated on the office's base and not stored
// (M0 breakdown decision D3, DIPO-71). It passes only with no failures; failures are in rule order.
// Since minor 1 (DIPO-179): `waitingOn` lists the dependencies that are not Done, absent when none
// are open. The verdict does not depend on it: a passing story can still wait before pickup.
// Since minor 1 (DIPO-251): `warnings` lists the rules that only warn (R29, test plan names no
// Reference covers), each `ready <ID> warning <rule>: <message>`, absent when none. They do not
// change `passed`.
export const storyGate = defineRead({
  name: "story.gate",
  args: z.object({ office: OfficeId, story: StoryRefValue }),
  result: z.object({
    story: StoryId,
    key: StoryKey,
    passed: z.boolean(),
    failures: z.array(GateRuleFailure),
    waitingOn: z.array(GateDependency).optional(),
    warnings: z.array(GateRuleFailure).optional(),
  }),
  since: 1,
});

// A commit on a story's branch that is not on the base, short sha and subject (DIPO-228).
export const LostCommit = z.object({ sha: z.string(), subject: z.string() });
export type LostCommit = z.infer<typeof LostCommit>;

// What `story.drop` with `deleteBranch` loses (DIPO-228; 0020 section 8): the commits on the
// story's branch that are not on the base, and the uncommitted and untracked files of its worktree.
// The branch is the live claim's, else the open released branches of the story; the files are the
// live claim's only. Both are empty for a story with neither. Changes nothing.
// `command` (DIPO-161) names the command the list is for, `story.drop` by default. For
// `work.discard` of a story without a live claim it lists exactly what the discard removes: the
// commits of the open released branches and of the branches of its leftovers (a story Done on the
// base through another branch), and the files of the worktrees kept as leftovers. For `story.drop`
// those worktrees are not removed: `kept` names them.
export const storyLosses = defineRead({
  name: "story.losses",
  args: z.object({
    office: OfficeId,
    story: StoryRefValue,
    command: z.enum(["story.drop", "work.discard"]).optional(),
  }),
  result: z.object({
    story: StoryId,
    key: StoryKey,
    commits: z.array(LostCommit),
    files: z.array(z.string()),
    kept: z.array(z.string()).optional(),
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

// The kinds of a desk item (0020 section 12), as `dipo desk` prints them. Open: later stories add
// kinds (DIPO-161 `DONE ELSEWHERE` and `LEFTOVERS`, 0019 `PR HEAD CHANGED`, scope requests).
export const KNOWN_DESK_KINDS = [
  "QUESTION",
  "PERMISSION",
  "SCOPE",
  "MERGE",
  "PARKED",
  "PR HEAD CHANGED",
  "DONE ELSEWHERE",
  "LEFTOVERS",
  "BACKLOG PR",
  "NOTICE",
  "PROPOSAL",
  "HELD",
] as const;
export const DeskKind = openEnum(KNOWN_DESK_KINDS);
export type DeskKind = z.infer<typeof DeskKind>;

// A command a desk item offers: the contract command and the exact command line to type, built by
// the engine (0020 section 12).
export const DeskAction = z.object({ command: CommandName, cli: z.string() });
export type DeskAction = z.infer<typeof DeskAction>;

// The proposal of a PROPOSAL item: a worker's follow-up, spike or tool proposal, or a decision note
// (DIPO-186), with the id the maintainer accepts or dismisses it by.
export const DeskProposal = z.object({
  id: z.string(),
  kind: z.string(), // follow-up, spike, tool or decision-note
  title: z.string(),
  run: RunId.optional(),
});
export type DeskProposal = z.infer<typeof DeskProposal>;

// One thing that waits on the maintainer (0020 section 12). `detail` is one code-built line;
// `since` is when it began to wait; `blocks` lists the active stories that depend on its story.
// `actions` are the commands it offers; `hand` says what to do by hand when no dipo command does
// it, such as a merge on the code host for a PR labelled `autorelease: pending`.
export const DeskItem = z.object({
  kind: DeskKind,
  story: StoryId.optional(),
  key: StoryKey.optional(),
  question: QuestionId.optional(),
  gate: GateId.optional(),
  pr: StoryPr.optional(),
  proposal: DeskProposal.optional(),
  reason: ParkReason.optional(),
  cause: z.string().optional(),
  detail: z.string(),
  since: Timestamp,
  blocks: z.array(StoryId),
  actions: z.array(DeskAction),
  hand: z.string().optional(),
});
export type DeskItem = z.infer<typeof DeskItem>;

// What waits on the maintainer, ordered by the engine in the six groups of 0020 section 12:
// questions with a waiting worker, merge gates, parks (a decision, then a direction, then a
// restart), hand actions, proposals, and the stories held by the maintainer; within a group the
// items blocking the most stories first, then the oldest. Changes nothing. Since minor 1
// (DIPO-158) [`desk`].
export const officeDesk = defineRead({
  name: "office.desk",
  args: OfficeArgs,
  result: z.array(DeskItem),
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
    // The engine markers in the range (DIPO-95, minor 1); absent when none. A range the engine
    // writes for a marker holds exactly that marker.
    markers: z.array(OutputMarker).optional(),
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
    // Since minor 1 (DIPO-140): the review summary of a review gate.
    review: ReviewSummary.optional(),
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
// and `story.drop`. `cause` (since minor 1, DIPO-142) says which of a reason's causes parked it
// (0020 section 2), an open string such as `loops` or `review`.
export const storyParked = defineEvent({
  type: "story.parked",
  stream: "office",
  derived: false,
  data: z.object({
    story: StoryId,
    key: StoryKey,
    work: WorkRef.optional(),
    reason: ParkReason,
    cause: z.string().optional(),
    detail: z.string(),
    from: Lifecycle,
    lastGoodCommit: z.string().optional(),
    actions: z.array(CommandName),
  }),
});

// Sent when a story's PR opens, changes state or gets a new head (0019 section 14). Since minor 1
// (DIPO-140).
export const storyPr = defineEvent({
  type: "story.pr",
  stream: "office",
  derived: false,
  data: z.object({ story: StoryId, key: StoryKey, pr: StoryPr }),
});

// Since minor 1 (DIPO-166; 0020 section 14) [`proposals`]: a worker report's proposal was stored for
// the maintainer, once per proposal (a later report with the same title and paths files none).
// `title` is the worker's words, cleaned of terminal control characters and on one line.
export const proposalFiled = defineEvent({
  type: "proposal.filed",
  stream: "office",
  derived: false,
  data: z.object({
    proposal: ProposalId,
    kind: z.string(), // follow-up, spike or tool
    key: StoryKey,
    story: StoryId.optional(),
    run: RunId,
    title: z.string(),
  }),
});

// Since minor 1 (DIPO-166) [`proposals`]: the maintainer accepted (filed as a Backlog draft through
// the planning lane) or dismissed a proposal.
export const proposalClosed = defineEvent({
  type: "proposal.closed",
  stream: "office",
  derived: false,
  data: z.object({
    proposal: ProposalId,
    key: StoryKey,
    state: z.enum(["accepted", "dismissed"]),
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
  proposalAccept,
  proposalDismiss,
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
  storyLosses,
  officeStats,
  workPreview,
  workPrompt,
  officeDesk,
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
  storyPr,
  proposalFiled,
  proposalClosed,
  testStarted,
  testRecorded,
] as const;
