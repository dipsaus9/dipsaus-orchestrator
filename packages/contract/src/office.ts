// Office-level messages: work, story, gate and test commands, the office reads and the office
// events (0005 with the 0008 and 0009 additions).

import { z } from "zod";

import { defineCommand, defineEvent, defineRead } from "./definition";
import { CommandName } from "./envelope";
import {
  IdeaAnswer,
  IdeaId,
  IdeaRef,
  IdeaState,
  IdeaView,
  ProposedStory,
  QUICK_IDEA_MAX,
} from "./ideas";
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
  PLANNING_KINDS,
  PlanningEndReason,
  PlanningProposal,
  PlanningProposalState,
  PlanningView,
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
  // Omit `stories` and the engine picks one story from the Ready queue; named stories each start
  // while the office has a free slot (`caps.parallelRuns`, 0002). (DIPO-48): `from` is
  // the main worktree a client resolved the office from (its current directory); the daemon
  // answers `office.unknown` when it is not the office's registered path.
  // (DIPO-271): `box` is accepted and changes nothing, because every run is a box run (0008).
  args: z.object({
    stories: z.array(StoryRefValue).optional(),
    from: z.string().min(1).optional(),
    box: z.boolean().optional(),
  }),
  // Per-story problems are skips, not command errors. A `capacity` skip's `detail` names the
  // office's limit and its setting.
  result: z.object({
    started: z.array(z.object({ story: StoryId, key: StoryKey, run: RunId })),
    skipped: z.array(
      z.object({
        story: StoryId,
        key: StoryKey,
        reason: SkipReason,
        detail: z.array(z.string()).optional(),
      }),
    ),
  }),
  confirm: false,
  irreversible: false,
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
    delivered: z.literal("on-resume"),
    run: RunId.optional(),
  }),
  confirm: false,
  irreversible: false,
});

// (DIPO-163, 0020): a running worker gets the text as its next user message
// (`next-turn`), read in its running turn or, when its session ends first, carried by the next
// session's first message (DIPO-412); a steer to a parked story is stored once and sent with the first message on
// resume (`on-resume`). A story whose live session is its reviewer, or whose host is followed
// only, answers `story.notSteerable`.
export const workSteer = defineCommand({
  name: "work.steer",
  level: "office",
  args: z.object({ ...StoryRef.shape, text: z.string().min(1) }),
  result: z.object({ run: RunId, delivered: z.enum(["next-turn", "on-resume"]) }),
  confirm: false,
  irreversible: false,
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
    // (DIPO-401) True when the story was not parked but held by a park that failed to write: the
    // resume dismissed that park, and pickup may take the story again.
    dismissed: z.boolean().optional(),
  }),
  confirm: false,
  confirmWhen: ["budget"],
  irreversible: false,
});

// Ends the run, deletes the story branch and returns the story to Refined
// (0020). (DIPO-161), on the waiting command path. Clients list what is
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
});

// Parks a Refined, Ready, In Progress or In Review story with reason `by-maintainer` and the note
// as its detail (0020). A running worker is stopped first; a story with no run is parked through
// the planning lane. `run` names the run the park ended or kept. Parking a story parked already
// answers `changed: false`; any other status fails `story.notParkable`. A park whose write to
// Backlog.md fails records nothing and fails `story.parkNotWritten`, so it can be sent again
// (DIPO-360). A story parks only once its worker exited: a stop that could not be sent, or a worker
// still running after the wait, fails the retryable `run.hostAlive` naming what still runs
// (DIPO-411).
export const storyPark = defineCommand({
  name: "story.park",
  level: "office",
  args: z.object({ ...StoryRef.shape, note: z.string().min(1) }),
  result: z.object({ story: StoryId, key: StoryKey, run: RunId.optional() }),
  confirm: false,
  irreversible: false,
});

// Archives the story through the planning lane and releases its claim; deletes its branch only
// when asked (0020). (DIPO-160). Clients ask for typed confirmation when
// `deleteBranch` is true (0009); `irreversibleWhen` says so in `commands.describe`.
// Errors: `story.active` (In Progress or In Review), `story.hasDependents`, and `run.hostAlive` while a worker host of the parked run still runs (0020, DIPO-227).
export const storyDrop = defineCommand({
  name: "story.drop",
  level: "office",
  args: z.object({ ...StoryRef.shape, deleteBranch: z.boolean() }),
  result: StoryResult,
  confirm: true,
  irreversible: false,
  irreversibleWhen: ["deleteBranch"],
});

// (DIPO-140): the maintainer's decision on a gate, such as a merge gate that waits
// for the maintainer (0002).
export const gateApprove = defineCommand({
  name: "gate.approve",
  level: "office",
  args: z.object({ gate: GateId, note: z.string().optional() }),
  result: z.object({ gate: GateId, decision: z.literal("approved") }),
  confirm: false,
  irreversible: false,
});

// The note becomes worker input.
export const gateReject = defineCommand({
  name: "gate.reject",
  level: "office",
  args: z.object({ gate: GateId, note: z.string().min(1) }),
  result: z.object({ gate: GateId, decision: z.literal("rejected") }),
  confirm: true,
  irreversible: false,
});

// A worker's decision note (DIPO-404), and the proposal of an older dipo (DIPO-186): its stored id
// is a hash of 64 lower-case hex characters. A command may name it by a unique prefix of at least 8
// of them.
export const ProposalId = z.string().regex(/^[0-9a-f]{64}$/, "expected a proposal id");
export type ProposalId = z.infer<typeof ProposalId>;
export const ProposalRef = z
  .string()
  .regex(/^[0-9a-f]{8,64}$/, "expected a proposal id, or at least its first 8 characters");

// What a flush of the planning lane did with one journaled change (DIPO-401, 0010): `opened` or
// `updated` the office's backlog PR `pr` (its URL) on `branch`; `pushed` the branch but no PR is
// recorded yet; `merged`, the change is on the base already; `held`, the open backlog PR has
// auto-merge on and the change waits for it; `waiting`, the change waits on a remote, a fetch or a
// push, with the branch it is on when it is on one; `failed`, the flush failed and the change stays journaled; `closed`, the change itself
// was dropped or failed and is not applied. `reason` is code-built text.
export const LaneFlush = z.discriminatedUnion("state", [
  z.object({ state: z.literal("opened"), branch: z.string(), pr: z.string() }),
  z.object({ state: z.literal("updated"), branch: z.string(), pr: z.string() }),
  z.object({ state: z.literal("pushed"), branch: z.string() }),
  z.object({ state: z.literal("merged") }),
  z.object({ state: z.literal("held"), branch: z.string(), reason: z.string() }),
  z.object({ state: z.literal("waiting"), branch: z.string().optional(), reason: z.string() }),
  z.object({ state: z.literal("failed"), reason: z.string() }),
  z.object({ state: z.literal("closed"), reason: z.string() }),
]);
export type LaneFlush = z.infer<typeof LaneFlush>;

// (DIPO-454; 0020, 0022) [`ideas`]: files an idea that passed the audit, open on the desk, as a
// Backlog draft through the planning lane: its title, the proposed user story with what was found,
// its evidence, its source story and its origin in the description, the evidence files as
// references, and the milestone it serves; a tech-debt idea gets no milestone and the label
// `tech-debt`. The draft has no real id and no branch, so it never runs. `draft` is the draft's id
// once the lane created it; draft ids are reused by Backlog.md, so it names the draft only until it
// is promoted or archived. Accepting an accepted idea changes nothing. Errors: `idea.unknown`,
// `idea.ambiguous` (a prefix of several), `idea.notOpen` (not passed, or dismissed already).
// `flush` says what the lane's flush did with the draft (DIPO-401); it is absent when nothing was
// flushed (the idea was filed already).
export const ideaAccept = defineCommand({
  name: "idea.accept",
  level: "office",
  args: z.object({ idea: IdeaRef }),
  result: z.object({
    idea: IdeaId,
    state: z.literal("accepted"),
    draft: z.string().optional(),
    flush: LaneFlush.optional(),
  }),
  confirm: false,
  irreversible: false,
});

// (DIPO-454) [`ideas`]: closes an idea that passed the audit without filing anything; it is kept
// as dismissed by the maintainer, for retro. Dismissing a dismissed idea changes nothing. Errors as
// `idea.accept`; `idea.notOpen` when it was accepted already.
export const ideaDismiss = defineCommand({
  name: "idea.dismiss",
  level: "office",
  args: z.object({ idea: IdeaRef }),
  result: z.object({ idea: IdeaId, state: z.literal("dismissed") }),
  confirm: false,
  irreversible: false,
});

// (DIPO-454; 0022) [`ideas`]: hands the maintainer's quick idea to the audit (`dipo idea`, the
// TUI's idea key). Its first line is the title, the whole text its text; `story` names the story it
// is about, if any. `held` is false when the same idea is held already, and `idea` then names it.
// Errors: `story.unknown`.
export const ideaAdd = defineCommand({
  name: "idea.add",
  level: "office",
  args: z.object({
    text: z.string().trim().min(1).max(QUICK_IDEA_MAX),
    story: StoryRefValue.optional(),
  }),
  result: z.object({ idea: IdeaId, held: z.boolean() }),
  confirm: false,
  irreversible: false,
});

// (DIPO-404, DIPO-454) [`proposals`]: closes a worker's open decision note; dipo never writes the
// decision records, and the maintainer adds a note by hand if they agree. Dismissing a dismissed
// note changes nothing. Errors: `note.unknown`, `note.ambiguous` (a prefix of several).
export const noteDismiss = defineCommand({
  name: "note.dismiss",
  level: "office",
  args: z.object({ note: ProposalRef }),
  result: z.object({ note: ProposalId, state: z.literal("dismissed") }),
  confirm: false,
  irreversible: false,
});

// (DIPO-309, 0002) [`test.sessions`]: runs the story's pushed head in a new test box
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
});

// (DIPO-440, 0010): starts the story a NEXT UP desk item offers for a free run slot, through the
// same start as `work.run` with the story named, and answers with `work.run`'s result. Error:
// `nextUp.notOffered` when the desk does not offer the story as next up now.
export const nextUpConfirm = defineCommand({
  name: "nextUp.confirm",
  level: "office",
  args: StoryRef,
  result: workRun.result,
  confirm: false,
  irreversible: false,
});

// (DIPO-440, 0010): removes a NEXT UP item without starting its story; the story is not offered
// again until its task file changes or it is started by hand. `offered` lists the stories the
// desk offers as next up after the decline. Error: `nextUp.notOffered` as `nextUp.confirm`.
export const nextUpDecline = defineCommand({
  name: "nextUp.decline",
  level: "office",
  args: StoryRef,
  result: z.object({ story: StoryId, key: StoryKey, offered: z.array(StoryId) }),
  confirm: false,
  irreversible: false,
});

// (DIPO-309, 0002) [`test.sessions`]: records the open test's result for the head
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
});

// The maintainer's planning session (DIPO-447, 0008): `planning.start` opens it with a kind and a
// goal, in a read-only box of its own; an office has at most one open, and it holds no run slot. The
// reply comes once its box is made and its session started (`planning.open` while one is open,
// `planning.startFailed` when the box or the session cannot start); its answers follow as
// `planning.output` and `planning.updated` events.
export const planningStart = defineCommand({
  name: "planning.start",
  level: "office",
  args: z.object({ kind: z.enum(PLANNING_KINDS), goal: z.string().trim().min(1) }),
  result: z.object({ run: RunId, view: PlanningView }),
  confirm: false,
  irreversible: false,
});

// Continues the newest planning session whose model session ended and that the maintainer did not
// end, after an idle end or a daemon restart, in a fresh model session whose first message code
// builds from the session's record (DIPO-448, 0007). `planning.open` while a session is open;
// `planning.notContinuable` when there is none to continue.
export const planningContinue = defineCommand({
  name: "planning.continue",
  level: "office",
  args: z.object({}),
  result: z.object({ run: RunId, view: PlanningView }),
  confirm: false,
  irreversible: false,
});

// One maintainer message to the open planning session: its next turn, read once the answer it
// works on is done (`planning.notOpen` without one).
export const planningMessage = defineCommand({
  name: "planning.message",
  level: "office",
  args: z.object({ text: z.string().trim().min(1) }),
  result: z.object({ run: RunId, delivered: z.literal("next-turn") }),
  confirm: false,
  irreversible: false,
});

// The maintainer's answers to one block of questions of the open planning session (DIPO-455,
// 0022), one per question: an option (its index) or a free text. The answers go to the session as
// one message, and each is stored as a choice in the session's record (DIPO-448).
// Errors: `planning.notOpen`, `planning.questionsUnknown` (no such block, or it was answered) and
// `planning.answerInvalid` (a question unanswered, an option out of range).
export const planningAnswer = defineCommand({
  name: "planning.answer",
  level: "office",
  args: z.object({
    block: z.int().positive(),
    answers: z
      .array(
        z.union([
          z.strictObject({ option: z.int().min(0).max(3) }),
          z.strictObject({ free: z.string().trim().min(1).max(2_000) }),
        ]),
      )
      .min(1)
      .max(4),
  }),
  result: z.object({ run: RunId, block: z.int().positive(), delivered: z.literal("next-turn") }),
  confirm: false,
  irreversible: false,
});

// The maintainer confirms a decision of the open planning session, and code stores it in the
// session's record (DIPO-448, 0007): a `choice` (`subject` the question, `text` the answer), a
// `story` filed or edited (`subject` the story id, `text` `filed` or `edited`) or an open
// `question` (`text`). `planning.notOpen` without a session.
export const planningRecord = defineCommand({
  name: "planning.record",
  level: "office",
  args: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("choice"),
      subject: z.string().trim().min(1),
      text: z.string().trim().min(1),
    }),
    z.object({ kind: z.literal("story"), subject: StoryId, text: z.enum(["filed", "edited"]) }),
    z.object({ kind: z.literal("question"), text: z.string().trim().min(1) }),
  ]),
  result: z.object({ run: RunId, recorded: z.literal(true) }),
  confirm: false,
  irreversible: false,
});

// Ends the open planning session: its worker stops and its box goes (`planning.notOpen` without
// one). A session that waits for a message longer than `planning.idleHours` ends by itself.
export const planningEnd = defineCommand({
  name: "planning.end",
  level: "office",
  args: z.object({}),
  result: z.object({ run: RunId, ended: PlanningEndReason }),
  confirm: false,
  irreversible: false,
});

// The maintainer's decisions on the open planning session's proposals (DIPO-450, 0022), each
// named by its number `n` in the session. Nothing is filed without a confirm.
//
// `planning.confirm` files the proposal through the planning lane (0010): a new story is created
// Refined to the story standard, an edit changes the existing task, a split does both. The
// filed and edited ids go into the session's record, and `stories` names those the lane has applied
// so far; `flush` says what the lane's flush did. Confirming a filed proposal changes nothing.
// Errors: `planning.notOpen`, `planning.proposalUnknown`, `planning.proposalClosed` (declined),
// `planning.storyUnknown` (an edit of a task the office does not have, or of one that is not
// Refined, Ready or Parked), `planning.duplicate` (a new story whose title an active story has)
// and `planning.notFiled` (the lane refused it, for example a story with a live claim).
export const planningConfirm = defineCommand({
  name: "planning.confirm",
  level: "office",
  args: z.object({ proposal: z.int().positive() }),
  result: z.object({
    run: RunId,
    proposal: z.int().positive(),
    state: PlanningProposalState,
    stories: z.array(z.string()),
    flush: LaneFlush.optional(),
  }),
  confirm: false,
  irreversible: false,
});

// Replaces an open proposal with the maintainer's version of it, of the same kind; the engine
// validates it as it validates the session's. Errors as `planning.confirm`, and `planning.kindChanged`.
export const planningEdit = defineCommand({
  name: "planning.edit",
  level: "office",
  args: z.object({ proposal: z.int().positive(), edited: PlanningProposal }),
  result: z.object({ run: RunId, proposal: z.int().positive() }),
  confirm: false,
  irreversible: false,
});

// Declines an open proposal: nothing is filed. Declining a declined one changes nothing; a filed
// one answers `planning.proposalClosed`.
export const planningDecline = defineCommand({
  name: "planning.decline",
  level: "office",
  args: z.object({ proposal: z.int().positive() }),
  result: z.object({ run: RunId, proposal: z.int().positive(), state: z.literal("declined") }),
  confirm: false,
  irreversible: false,
});

// The final confirm of a planning session (DIPO-451, 0012): the maintainer names the stories of the
// open session that go Ready. For each, dipo evaluates the Ready gate against the story as the
// base branch holds it (its filing PR merged) and stores the decision. A story that passes is set
// Ready through the planning lane, in a backlog PR of its own, never the one that filed it; one
// that fails stays as it is and is listed in `refused` with the gate's messages. `flush` says what
// the lane's flush did. Setting a story again that is set already changes nothing.
// Errors: `planning.notOpen`, `planning.storyUnknown` (a story the session neither filed nor
// edited) and `planning.notFiled` (the office has no backlog lane yet).
export const planningReady = defineCommand({
  name: "planning.ready",
  level: "office",
  args: z.object({ stories: z.array(z.string().min(1)).min(1) }),
  result: z.object({
    run: RunId,
    queued: z.array(z.string()),
    refused: z.array(z.object({ story: z.string(), messages: z.array(z.string()) })),
    flush: LaneFlush.optional(),
  }),
  confirm: false,
  irreversible: false,
});

// Reads

const OfficeArgs = z.object({ office: OfficeId });

// Derived and consistent with `cursor`: subscribe after it for a gap-free stream (0005).
export const OfficeSnapshot = z.object({
  cursor: Cursor,
  stories: z.array(StoryView),
  work: z.array(WorkView),
  gates: z.array(GateView),
  questions: z.array(QuestionView),
  tests: z.array(TestView),
  // The office's open planning session (DIPO-449); absent without one.
  planning: PlanningView.optional(),
});
export type OfficeSnapshot = z.infer<typeof OfficeSnapshot>;

export const officeSnapshot = defineRead({
  name: "office.snapshot",
  args: OfficeArgs,
  result: OfficeSnapshot,
});

// The notes and proposals of a run's done report (DIPO-152), the worker's own words, cleaned and
// capped as door messages are (0008). Absent when the report had neither.
export const DoneReport = z.object({
  notes: z.string().optional(),
  proposals: z
    .array(
      z.object({
        kind: z.string(),
        title: z.string(),
        story: z.string(), // the worker's story line, without the "Story:" prefix (0012 R05)
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
  // (DIPO-373): a run open at In Review, with no session, since its active period
  // ended; absent once it ended or while a session works.
  inReviewSince: Timestamp.optional(),
  usage: UsageTotals,
  // (DIPO-152): the notes and proposals of the done report that ended the run.
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
  // (DIPO-140): the review round of a review gate (0002).
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
    // The story's open questions (DIPO-59), oldest first.
    questions: z.array(QuestionView).optional(),
    // A conflict with the base found while the story is In Review (DIPO-149;
    // 0002): the base, the base commit and the conflicted paths. Absent once a merge handled it.
    baseConflict: z
      .object({
        base: z.string(),
        onto: z.string(),
        paths: z.array(z.string()),
        at: Timestamp,
      })
      .optional(),
    // The story's open gates that wait for the maintainer, oldest first (DIPO-150;
    // 0002): `dipo approve` and `dipo reject` send the newest one's id.
    gates: z.array(GateView).optional(),
  }),
});

// (DIPO-462): the unified diff of the story's branch against the base, three-dot as its PR shows
// it, for the story reader's Diff section. `diff` is cut at `DIFF_MAX_BYTES` (`truncated`); it is
// empty when the story has no branch or git could not say (`unavailable` says why then).
export const DIFF_MAX_BYTES = 512 * 1024;
export const storyDiff = defineRead({
  name: "story.diff",
  args: z.object({ office: OfficeId, story: StoryRefValue }),
  result: z.object({
    branch: z.string().nullable(),
    base: z.string().optional(),
    diff: z.string(),
    truncated: z.boolean(),
    unavailable: z.string().optional(),
  }),
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
    // The engine markers that overlap the range (DIPO-95), oldest first; absent when none.
    markers: z.array(OutputMarker).optional(),
  }),
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
});

// A dependency of a story that is not Done on the office's base (DIPO-179): its id and its status
// there. The status is absent when the Backlog CLI could not read the dependency (missing or
// ambiguous), so the story waits on it but its status is unknown.
export const GateDependency = z.object({ id: z.string(), status: z.string().optional() });
export type GateDependency = z.infer<typeof GateDependency>;

// The Ready gate of one story in `ready` mode, evaluated on the office's base and not stored
// (M0 breakdown decision D3, DIPO-71). It passes only with no failures; failures are in rule order.
// (DIPO-179): `waitingOn` lists the dependencies that are not Done, absent when none
// are open. The verdict does not depend on it: a passing story can still wait before pickup.
// (DIPO-251): `warnings` lists the rules that only warn (R29, test plan names no
// Reference covers; R32, more criteria or references than the tier usually holds), each `ready <ID> warning <rule>: <message>`, absent when none. They do not
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
    // (DIPO-460): how many rules the gate checked, warning rules included, for `Gate ✓ 31 rules`.
    rules: z.int().nonnegative(),
    // (DIPO-460): the story's declared scope (its References), absent when it declares none.
    touches: z.array(z.string()).optional(),
  }),
});

// A commit on a story's branch that is not on the base, short sha and subject (DIPO-228).
export const LostCommit = z.object({ sha: z.string(), subject: z.string() });
export type LostCommit = z.infer<typeof LostCommit>;

// What `story.drop` with `deleteBranch` loses (DIPO-228; 0020): the commits on the
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
});

// Code-built "since you left" counts and lines (0009) [`digest`]. The client keeps `since`, the
// time it last saw the office (0001); the result's `since` is the time the counts start from.
// (DIPO-459) `spent`, for the Desk's Since band: the estimated cost in dollars of the office's
// agents whose usage moved after `since`; absent when none of them reported a cost.
export const officeDigest = defineRead({
  name: "office.digest",
  args: z.object({ office: OfficeId, since: Timestamp }),
  result: z.object({
    since: Timestamp,
    counts: z.record(z.string(), Count), // for example done, parked
    lines: z.array(z.string()),
    spent: z.number().nonnegative().optional(),
    evidence: EvidenceMap.optional(),
  }),
});

// What a story waiting on others sees of the dependency graph (DIPO-460): `moving` is a story
// that is Ready, running or in review, `parked` one on the Desk, `refined` one that is Refined and
// waits for the maintainer to set it Ready (DIPO-484), `waiting` any other story that is not Done.
export const ChainState = z.enum(["parked", "moving", "refined", "waiting"]);
export type ChainState = z.infer<typeof ChainState>;

// One story of a chain: its state and the stories that wait on it directly.
export const ChainNode = z.object({
  story: StoryId,
  key: StoryKey,
  state: ChainState,
  // The first failed Ready gate rule of a `refined` story.
  reason: z.string().optional(),
  unblocks: z.array(StoryId),
});
export type ChainNode = z.infer<typeof ChainNode>;

// One connected piece of the graph of waiting stories, as levels: the first level holds the
// stories nothing in the piece blocks, each later level the stories whose last blocker is in the
// level before. `parked` names the parked story the rest waits on, absent when none is.
export const ChainRow = z.object({
  levels: z.array(z.array(StoryId)),
  parked: StoryId.optional(),
});
export type ChainRow = z.infer<typeof ChainRow>;

// The dependency chain the engine computes from the graph (DIPO-460): the pieces, parked ones
// first, then by lowest story number, and every story in them.
export const officeChain = defineRead({
  name: "office.chain",
  args: OfficeArgs,
  result: z.object({ rows: z.array(ChainRow), nodes: z.array(ChainNode) }),
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
// (DIPO-65) [`dipo stats`].
export const officeStats = defineRead({
  name: "office.stats",
  args: OfficeArgs,
  result: z.object({ office: OfficeId, tables: z.array(TableStats) }),
});

// The kinds of a desk item (0020), as `dipo desk` prints them. Open: later stories add
// kinds (DIPO-161 `DONE ELSEWHERE` and `LEFTOVERS`, 0002 `PR HEAD CHANGED`, scope requests; DIPO-310
// `PROFILE`, a pending proposal or stale confirmation of the run profile, with no story; DIPO-359
// `STARTS PAUSED`, the office's starts paused with its reason and what lifts it, with no story;
// DIPO-380 `LOADING`, an office whose load is still running, with no story; DIPO-401
// `PLANNING LANE`, a planning lane whose operations wait for a backlog PR longer than 30 minutes,
// with no story; DIPO-440 `NEXT UP`, a Ready story offered for a free run slot; DIPO-454
// `PROPOSED STORY`, an idea that passed the audit, and `DECISION NOTE`, a worker's decision note;
// DIPO-468 `MERGED WHILE PARKED`, one line with no action for a story whose PR merged while it was
// parked, until the base says Done).
// The order is the desk's (DIPO-459): the setup kinds (`PROFILE`) first, the stories the maintainer
// parked after next up; clients group the items by kind in this order and never sort them.
export const KNOWN_DESK_KINDS = [
  "PROFILE",
  "STARTS PAUSED",
  "QUESTION",
  "SCOPE",
  "MERGE",
  "PARKED",
  "PR HEAD CHANGED",
  "DONE ELSEWHERE",
  "LEFTOVERS",
  "BACKLOG PR",
  "PLANNING LANE",
  "NOTICE",
  "UPDATE DIPO",
  "PROPOSED STORY",
  "DECISION NOTE",
  "MERGED WHILE PARKED",
  "NEXT UP",
  "PARKED BY YOU",
  "LOADING",
] as const;
/** The kind of the one item `office.desk` shows while its office is loading (DIPO-380). */
export const DESK_LOADING_KIND = "LOADING";
export const DeskKind = openEnum(KNOWN_DESK_KINDS);
export type DeskKind = z.infer<typeof DeskKind>;

// A command a desk item offers: the contract command and the exact command line to type, built by
// the engine (0020). `consequence` (DIPO-459) is one code-built line saying what the action does,
// such as "Accepting files it as a Backlog draft.", absent for a command the engine has none for.
export const DeskAction = z.object({
  command: CommandName,
  cli: z.string(),
  consequence: z.string().optional(),
});
export type DeskAction = z.infer<typeof DeskAction>;

// The note of a DECISION NOTE item (DIPO-404, DIPO-454), with the id the maintainer dismisses it by.
export const DeskNote = z.object({
  id: z.string(),
  title: z.string(),
  run: RunId.optional(),
});
export type DeskNote = z.infer<typeof DeskNote>;

// The idea of a PROPOSED STORY item (0020, DIPO-454): an idea that passed the audit, with the id
// the maintainer accepts or dismisses it by, where it came from, its title and its proposed user
// story in full (what was found with its evidence and source story, the Story line, what is
// proposed, why, and the milestone it serves or `tech-debt`). Every text is cleaned of terminal
// sequences and kept whole: the card shows it in full.
// `raisedBy` (DIPO-459) names who raised it: the role of its run's agent (`developer` for a worker's
// proposal, `reviewer` for an advisory finding, `planner` for an aside) with that agent's model, or
// `maintainer` with no model for a quick idea; absent when the run's agent is not kept.
export const DeskIdeaRaiser = z.object({ role: z.string(), model: z.string().optional() });
export type DeskIdeaRaiser = z.infer<typeof DeskIdeaRaiser>;

export const DeskIdea = z.object({
  id: z.string(),
  origin: z.string(),
  title: z.string(),
  run: RunId.optional(),
  story: ProposedStory,
  raisedBy: DeskIdeaRaiser.optional(),
});
export type DeskIdea = z.infer<typeof DeskIdea>;

// One thing that waits on the maintainer (0020). `detail` is one code-built line;
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
  note: DeskNote.optional(),
  idea: DeskIdea.optional(),
  reason: ParkReason.optional(),
  detail: z.string(),
  since: Timestamp,
  blocks: z.array(StoryId),
  // The Refined stories that depend on its story: they wait for the maintainer to set them Ready, so
  // `blocks` does not count them (DIPO-484); `reason` is each one's first failed Ready gate rule.
  refined: z.array(z.object({ story: StoryId, reason: z.string().optional() })).optional(),
  actions: z.array(DeskAction),
  hand: z.string().optional(),
});
export type DeskItem = z.infer<typeof DeskItem>;

// What waits on the maintainer, in the order of 0020: the office's starts paused (DIPO-359),
// questions with a waiting worker, merge
// gates, parks by reason with the stories parked by the maintainer last, hand actions and
// proposals; within a group the items blocking the most stories first, then the oldest. Changes nothing.
// (DIPO-158) [`desk`].
export const officeDesk = defineRead({
  name: "office.desk",
  args: OfficeArgs,
  result: z.array(DeskItem),
});

// The office's ideas (0022, DIPO-452): held, passed with their proposed user story, and rejected
// with their reason, oldest first; `state` lists only those. Changes nothing [`ideas`].
export const officeIdeas = defineRead({
  name: "office.ideas",
  args: z.object({ office: OfficeId, state: IdeaState.optional() }),
  result: z.array(IdeaView),
});

// What retro counts per tier and type (0022, DIPO-453): park reasons with counts, the rounds and
// loops, what the runs cost and how long a story took from Ready to merged. The engine computes
// every number from its database with no model call.
export const RetroGroup = z.object({
  tier: z.string(), // `none` for a story without a tier
  type: z.string(), // `unknown` for a story whose type was not kept
  stories: Count,
  merged: Count,
  parks: z.record(z.string(), Count),
  loops: Count,
  reviewRounds: Count,
  reviewRoundsFailed: Count,
  ciAttempts: Count,
  conflictHandoffs: Count,
  costMicros: Count.nullable(), // null when no run of the group reported a cost
  timed: Count, // merged stories whose Ready time was kept
  readyToMergedMinutes: z.number().nonnegative().nullable(), // their average
});
export type RetroGroup = z.infer<typeof RetroGroup>;

// Where the stories came from, by origin (planned, proposal, finding, quick, aside, unknown).
export const RetroOrigins = z.record(z.string(), Count);

export const RetroRework = z.object({
  merged: Count, // merged stories with their changed files kept
  rework: Count, // of them, those that changed mostly files another story changed in the 14 days before
});
export type RetroRework = z.infer<typeof RetroRework>;

export const RetroRejection = z.object({
  by: z.enum(["code", "audit"]),
  reason: z.string(),
  count: Count,
});
export type RetroRejection = z.infer<typeof RetroRejection>;

// The retro view's numbers and, built by code from them, its lines (also the text a planning
// session gets) [`retro`].
export const officeRetro = defineRead({
  name: "office.retro",
  args: OfficeArgs,
  result: z.object({
    office: OfficeId,
    groups: z.array(RetroGroup),
    origins: RetroOrigins,
    rework: RetroRework,
    rejected: z.array(RetroRejection),
    dismissed: Count,
    lines: z.array(z.string()),
  }),
});

// Events (office stream, 0005)

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
    detectedBy: z.literal("engine"),
  }),
});

// A run ended: done, parked or dropped (0020). The one place a run ends writes it, so every end
// comes once on the stream, a session run and a run with no story included. `key` and `story` are
// absent for a session run. Clients print the end from this event and read no detail for it.
export const runEnded = defineEvent({
  type: "run.ended",
  stream: "office",
  derived: false,
  data: z.object({
    run: RunId,
    kind: z.enum(["story", "session"]),
    ending: z.enum(["done", "parked", "dropped"]),
    endedAt: Timestamp,
    key: StoryKey.optional(),
    story: StoryId.optional(),
  }),
});

// The work events below carry the optional `view` (DIPO-52): the `WorkView` the
// engine derived when it stored the fact (0005), so a client replaces the run's view
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
    // The engine markers in the range (DIPO-95); absent when none. A range the engine
    // writes for a marker holds exactly that marker.
    markers: z.array(OutputMarker).optional(),
    view: WorkView.optional(),
  }),
});

// The planning session (DIPO-447) has no story, so its events carry no `WorkRef`: each carries its
// run and the planning view the engine derived when it stored the fact.
export const planningStarted = defineEvent({
  type: "planning.started",
  stream: "office",
  derived: false,
  data: z.object({ run: RunId, view: PlanningView }),
});

// A byte range of the planning session's stored output: its answer as it streams.
export const planningOutput = defineEvent({
  type: "planning.output",
  stream: "office",
  derived: false,
  data: z.object({
    run: RunId,
    from: Offset,
    to: Offset,
    text: z.string(),
    view: PlanningView.optional(),
  }),
});

// The planning session's state, health or spend changed: a turn began or ended, its usage grew
// (at most once a second), or the watchdog saw no output while it works. Cumulative.
export const planningUpdated = defineEvent({
  type: "planning.updated",
  stream: "office",
  derived: false,
  data: z.object({ run: RunId, view: PlanningView }),
});

// A planning session continued in a fresh model session (DIPO-448): `run` is the fresh one,
// `previous` the model session that ended, and `reason` why it ended (a full context, an idle
// end, a daemon stop). Follows the `planning.started` of the fresh session.
export const planningContinued = defineEvent({
  type: "planning.continued",
  stream: "office",
  derived: false,
  data: z.object({
    run: RunId,
    previous: RunId,
    reason: PlanningEndReason,
    view: PlanningView,
  }),
});

export const planningEnded = defineEvent({
  type: "planning.ended",
  stream: "office",
  derived: false,
  data: z.object({ run: RunId, reason: PlanningEndReason, view: PlanningView }),
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
    // (DIPO-140): the review summary of a review gate.
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

// Sent when a story's PR opens, changes state or gets a new head (0002).
// (DIPO-140).
export const storyPr = defineEvent({
  type: "story.pr",
  stream: "office",
  derived: false,
  data: z.object({ story: StoryId, key: StoryKey, pr: StoryPr }),
});

// (DIPO-166; 0020) [`proposals`]: a worker report's proposal was stored for the maintainer. No
// longer written since a proposal is held as an idea (DIPO-454); kept so a stored log still
// renders.
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

// (DIPO-166) [`proposals`]: the maintainer accepted or dismissed a worker's proposal, or dismissed
// a decision note. Read-only: no longer written (`idea.answered` and `note.closed` replace it);
// kept so a stored log still renders.
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

// (DIPO-404, DIPO-454) [`proposals`]: the maintainer dismissed a worker's decision note
// (`note.dismiss`), or reconcile closed it because the decision record on the base holds it.
export const noteClosed = defineEvent({
  type: "note.closed",
  stream: "office",
  derived: false,
  data: z.object({ note: ProposalId, key: StoryKey, state: z.literal("dismissed") }),
});

// (DIPO-454; 0022) [`ideas`]: an idea passed the audit and waits on the desk as a proposed user
// story. `title` is the idea's title, cleaned and on one line.
export const ideaPassed = defineEvent({
  type: "idea.passed",
  stream: "office",
  derived: false,
  data: z.object({
    idea: IdeaId,
    origin: z.string(),
    story: StoryId.optional(),
    title: z.string(),
  }),
});

// (DIPO-454) [`ideas`]: the maintainer accepted (filed as a Backlog draft through the planning
// lane) or dismissed an idea that passed the audit.
export const ideaAnswered = defineEvent({
  type: "idea.answered",
  stream: "office",
  derived: false,
  data: z.object({ idea: IdeaId, state: IdeaAnswer }),
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

// (DIPO-309): an open test closed without a record, and its test box deleted: a new
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
  ideaAccept,
  ideaDismiss,
  ideaAdd,
  noteDismiss,
  nextUpConfirm,
  nextUpDecline,
  testStart,
  testRecord,
  planningStart,
  planningMessage,
  planningContinue,
  planningRecord,
  planningAnswer,
  planningEnd,
  planningConfirm,
  planningEdit,
  planningDecline,
  planningReady,
] as const;

export const officeReads = [
  officeSnapshot,
  storyDetail,
  storyDiff,
  workOutputRange,
  officeDigest,
  officeChain,
  storyGate,
  storyLosses,
  officeStats,
  workPreview,
  workPrompt,
  officeDesk,
  officeIdeas,
  officeRetro,
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
  runEnded,
  storyPr,
  proposalFiled,
  proposalClosed,
  noteClosed,
  ideaPassed,
  ideaAnswered,
  testStarted,
  testRecorded,
  testEnded,
  planningStarted,
  planningOutput,
  planningUpdated,
  planningContinued,
  planningEnded,
] as const;
