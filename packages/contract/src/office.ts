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
  TestEndReason,
  TestResult,
  TestStep,
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

// The answer to a worker's question is always text, so an answer that reads "allow" is never a
// decision (0020). `run` names the run an answer to an `ambiguous-spec` park resumed.
export const workAnswer = defineCommand({
  name: "work.answer",
  level: "office",
  args: z.object({
    question: QuestionId,
    text: z.string(),
  }),
  result: z.object({
    question: QuestionId,
    delivered: z.enum(["now", "on-resume"]),
    run: RunId.optional(),
  }),
  confirm: false,
  irreversible: false,
  since: 0,
});

// Since minor 1 (DIPO-163, 0020): a running worker gets the text as its next user message
// (`next-turn`); a steer to a parked story is stored once and sent with the first message on
// resume (`on-resume`). A story whose live session is its reviewer, or whose host is followed
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

// The one way back from a park (0020): a parked story returns to the status it had before, and a
// story with a run gets its next session; it is refused while the office's starts are paused
// (`run.refused`). What a park's reason requires is the 0020 table: `note` is the maintainer's note (the
// answer of an `ambiguous-spec` park, the direction of a `review-blocked` one), `budget` the top-up
// of a `budget-exceeded` park (a share of the run's starting caps, or a token amount), which needs
// the yes/no confirmation (`confirmWhen`); the result names the grants the resume recorded and
// says `queued` when the session waits for its place. Errors: `resume.topUpRequired`,
// `resume.topUpTooSmall`, `resume.noteRequired`, `resume.notResumable`, `resume.capReached`, and
// `confirmation.required` with the caps before and after (`ResumeConfirmDetails`) for a top-up
// sent without `confirmed`.
// A top-up: `share` is a percent of the run's starting caps (`50` is +50%), `tokens` a token amount.
export const ResumeBudget = z.union([
  z.object({ share: z.number().positive() }),
  z.object({ tokens: z.int().positive() }),
]);
export type ResumeBudget = z.infer<typeof ResumeBudget>;

// One grant a resume recorded (0020): a `budget` grant names its tokens, turns and minutes, a
// `round` grant the counted cap it grows (`loops`, `reviewRounds`, `ciAttempts` or
// `conflictAttempts`) and its count.
export const ResumeGrant = z.object({
  kind: z.string(),
  cap: z.string().optional(),
  tokens: Count.optional(),
  turns: Count.optional(),
  minutes: Count.optional(),
  count: Count.optional(),
});
export type ResumeGrant = z.infer<typeof ResumeGrant>;

// The developer caps of a run: its budget tokens, turns and minutes.
export const ResumeCaps = z.object({ budgetTokens: Count, maxTurns: Count, maxMinutes: Count });
export type ResumeCaps = z.infer<typeof ResumeCaps>;

// `details` of `confirmation.required` for a top-up: the caps before and after it.
export const ResumeConfirmDetails = z.object({ before: ResumeCaps, after: ResumeCaps });
export type ResumeConfirmDetails = z.infer<typeof ResumeConfirmDetails>;

export const workResume = defineCommand({
  name: "work.resume",
  level: "office",
  args: z.object({
    ...StoryRef.shape,
    note: z.string().optional(),
    budget: ResumeBudget.optional(),
  }),
  // `queued` (DIPO-163): the run waits for the office's session place before its session starts.
  result: z.object({
    story: StoryId,
    key: StoryKey,
    to: Lifecycle,
    run: RunId.optional(),
    queued: z.boolean().optional(),
    grants: z.array(ResumeGrant).optional(),
  }),
  confirm: false,
  confirmWhen: ["budget"],
  irreversible: false,
  since: 1,
});

// Ends the run, deletes the story branch and returns the story to Refined
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

// Parks a Refined, Ready, In Progress or In Review story with reason `by-maintainer` and the note
// as its detail (0020). A running worker is stopped first; a story with no run is parked through
// the planning lane. `run` names the run the park ended or kept. Parking a story parked already
// answers `changed: false`; any other status fails `story.notParkable`. A park whose write to
// Backlog.md fails records nothing and fails `story.parkNotWritten`, so it can be sent again
// (DIPO-360).
export const storyPark = defineCommand({
  name: "story.park",
  level: "office",
  args: z.object({ ...StoryRef.shape, note: z.string().min(1) }),
  result: z.object({ story: StoryId, key: StoryKey, run: RunId.optional() }),
  confirm: false,
  irreversible: false,
  since: 1,
});

// Archives the story through the planning lane and releases its claim; deletes its branch only
// when asked (0020 section 8). Since minor 1 (DIPO-160). Clients ask for typed confirmation when
// `deleteBranch` is true (0009 section 5); `irreversibleWhen` says so in `commands.describe`.
// Errors: `story.active` (In Progress or In Review), `story.hasDependents`, and `run.hostAlive` while a worker host of the parked run still runs (0020 section 8, DIPO-227).
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
// of several), `proposal.notOpen` (dismissed already).
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
// Dismissing a dismissed proposal changes nothing. Errors as `proposal.accept`; `proposal.notOpen`
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

// Since minor 1 (DIPO-309, 0002) [`test.sessions`]: runs the story's pushed head in a new test box
// and replies once the product runs: the test id, the head, the manual steps in order, `checkout`
// (the test box's name), and the optional `url` (http://localhost:<port> on the Mac) and `shell`
// (the `dipo test shell <ID>` line). A story with an open test for its head gets that test back
// unchanged. Errors: `story.notTestable` (no manual test-plan entry), `test.notInReview` (not In
// Review in phase review, test or merge), `test.refused` (install or `dev` unresolved after the
// fingerprint check; `details.capability` names it), `test.startFailed` (the box, install, setup
// or `dev` failed; the message says which).
export const testStart = defineCommand({
  name: "test.start",
  level: "office",
  args: StoryRef,
  result: z.object({
    test: TestId,
    head: z.string(),
    checkout: z.string(),
    steps: z.array(TestStep),
    url: z.string().optional(),
    shell: z.string().optional(),
  }),
  confirm: false,
  irreversible: false,
  since: 1,
});

// Since minor 1 (DIPO-309, 0002) [`test.sessions`]: records the open test's result for the head
// it tested and closes its box. A pass decides the story's test gate for that head; a fail needs a
// note and sends it to the same builder as a fix round item. Error: `test.closed` for a test that
// is no longer open, or whose head is older than the story's current head.
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
  since: 1,
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
  outcome: z.string().optional(), // how the run ended (done, parked, dropped), absent while open
  // Since minor 1 (DIPO-373): a run open at In Review, with no session, since its active period
  // ended; absent once it ended or while a session works.
  inReviewSince: Timestamp.optional(),
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
    // The story's open gates that wait for the maintainer, oldest first (DIPO-150, minor 1; 0019
    // section 11): `dipo approve` and `dipo reject` send the newest one's id.
    gates: z.array(GateView).optional(),
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
// story's branch that are not on the base. The branch is the live claim's, else the open released
// branches of the story; empty for a story with neither. Changes nothing. A story has no worktree,
// so no uncommitted files are lost (DIPO-349).
// `command` (DIPO-161) names the command the list is for, `story.drop` by default. For
// `work.discard` of a story without a live claim it lists exactly what the discard removes: the
// commits of the open released branches and of the branches of its leftovers (a story Done on the
// base through another branch).
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
  }),
  since: 1,
});

// The worker launch `work.run` would make for the story it would pick (DIPO-74): the branch it
// would create, the launch (absolute program path first in `argv`, the environment
// variable names without their values, the files written into the run directory, such as the run
// settings with the sandbox), and the system file and task message the worker would get. The run
// id, the session id and the run directory are placeholders until a real run makes them.
export const WorkerLaunchPreview = z.object({
  adapter: z.string(),
  branch: z.string(),
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

// Code-built "since you left" counts and lines (0009 section 8) [`digest`]. Since minor 1
// (DIPO-308): `since` is optional; without it the engine counts from when the office's last TUI
// client disconnected, which it stores per office, or from the time of the read when no TUI has
// left it yet. The result's `since` is the time it counted from.
export const officeDigest = defineRead({
  name: "office.digest",
  args: z.object({ office: OfficeId, since: Timestamp.optional() }),
  result: z.object({
    since: Timestamp,
    counts: z.record(z.string(), Count), // for example done, parked
    lines: z.array(z.string()),
    evidence: EvidenceMap.optional(),
  }),
  since: 1,
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
// kinds (DIPO-161 `DONE ELSEWHERE` and `LEFTOVERS`, 0019 `PR HEAD CHANGED`, scope requests; DIPO-310
// `PROFILE`, a pending proposal or stale confirmation of the run profile, with no story; DIPO-359
// `STARTS PAUSED`, the office's starts paused with its reason and what lifts it, with no story;
// DIPO-349 `LEFTOVER WORKTREE`, a story worktree of an earlier binary that holds changes, with no
// story).
export const KNOWN_DESK_KINDS = [
  "STARTS PAUSED",
  "QUESTION",
  "SCOPE",
  "MERGE",
  "PARKED",
  "PR HEAD CHANGED",
  "DONE ELSEWHERE",
  "LEFTOVERS",
  "BACKLOG PR",
  "NOTICE",
  "PROPOSAL",
  "PARKED BY YOU",
  "PROFILE",
  "LEFTOVER WORKTREE",
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
  detail: z.string(),
  since: Timestamp,
  blocks: z.array(StoryId),
  actions: z.array(DeskAction),
  hand: z.string().optional(),
});
export type DeskItem = z.infer<typeof DeskItem>;

// What waits on the maintainer, in the order of 0020: the office's starts paused (DIPO-359),
// questions with a waiting worker, merge
// gates, parks by reason with the stories parked by the maintainer last, hand actions and
// proposals; within a group the items blocking the most stories first, then the oldest. Changes nothing. Since minor 1
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

// Run start and re-attach on resume.
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

// Sent with `story.state` to Parked. `work` is absent for a story parked with no run, where
// `detail` is the maintainer's note. `actions` lists the commands a client may offer, such as
// `work.resume`, `work.discard` and `story.drop`.
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

// Since minor 1 (DIPO-309): an open test closed without a record, and its test box deleted: a new
// head, the idle timeout, the story dropped, discarded, merged or out of review, its box lost, or
// a start that failed. A client drops the test from its view.
export const testEnded = defineEvent({
  type: "test.ended",
  stream: "office",
  derived: false,
  data: z.object({ test: TestId, story: StoryId, key: StoryKey, reason: TestEndReason }),
});

export const officeCommands = [
  workRun,
  workAnswer,
  workSteer,
  workResume,
  workDiscard,
  storyPark,
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
  testEnded,
] as const;
