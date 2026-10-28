// `work.resume` of a parked story with a run (0020): the one resume path, for every reason the
// resume table resumes (`resume-policy.ts`).
//
// 1. Check, with no writes: the reason resumes (`scope-violation` answers `resume.notResumable`
//    naming `dipo discard`), the park has a run, a `budget-exceeded` park comes with its top-up
//    (`resume.topUpRequired` naming `--budget` and the cap that fired), the answer of an
//    `ambiguous-spec` park or the note a reason requires is given (`resume.noteRequired`), the
//    office's starts are not paused (`run.refused` naming why, 0020), no session of the run is alive
//    (`run.hostAlive`), the daemon schedules work (`scheduling.off`), what remains of the caps,
//    counting this resume's grants, is above zero (`resume.capReached` naming `--budget`; for a
//    top-up `resume.topUpTooSmall` naming the smallest share that clears it), and a top-up was
//    confirmed (`confirmation.required` with the caps before and after).
// 2. Intent first: an `answer` intent tagged `maintainer-resume` with the request id, the first
//    message and the grants, so a restart or a retry of the same request finishes the resume and
//    repeats nothing (the grants have ids made from the request).
// 3. The park is lifted on the story branch (the F16 block removed, the status set), in dipo's own
//    copy of the story's backlog (`gitUnparkWriter`); a lift already written commits nothing.
// 4. One transaction: the park resolved `resume` with the note, its questions closed (an answered
//    one as answered, the rest expired, each with its `question.closed`), the grants recorded, the
//    run reopened, `story.state` back, the intent sent; a session whose place is taken waits for it
//    (`waitForPlace`) and the reply says `queued`.
// 5. The next session of the same run (`resumeSession`, from the run's facts): a new developer
//    session in the story's box with a handoff, a fresh reviewer session of the same round on the
//    same head when the park stopped the reviewer, a fix round with the last verdict's blocking
//    findings for `review-blocked`, or none for a story the maintainer parked while it waited In
//    Review (it waits there again; a closed story PR is replaced, 0002).
//
// Grants (0020): a top-up (`--budget`) is a budget grant. A round grant is one more round of the
// counted cap that fired, read from the run's counters: the CI attempts or the loops of a
// `verify-failing` park, the review rounds of a `review-blocked` one, the failed hand-offs of a
// `conflict` one. Each records the caps before and after it. A resumed review needs no grant: the
// reviewer's caps hold per session, and the fresh session starts with all of them (0002).
//
// The first message is code-built: the reason's part, then `feedback/maintainer-note.md` with the
// note, so maintainer text never starts a message. A top-up of a park a reopened fix round hit
// before its session (DIPO-205) sends that round's undelivered feedback first, then
// `feedback/topup.md`. A reviewer never gets the note (0002).
//
// An `ambiguous-spec` park resumes with its answer: the note, or the text of `work.answer` on the
// park's question, which comes here as the note. The first message is `feedback/answer.md` with the
// question and the answer, and the note is not sent again. The lift adds the answer to the story's
// unknowns as a resolved unknown in the same task-file commit, or, when that would break R26,
// leaves it out with an `engine.notice`. A park that carries a worker question whose answer is held
// already (it came while the run was ending) resumes without a note: the held answer goes with the
// first message.
//
// A `conflict` park's developer session starts with the first message `ConflictResumer.prepare`
// builds from git (the kept merge's conflict item, or the commits only the remote branch holds),
// and the merge it needs runs once that session started (`afterStart`), in the live run's box.
//
// The one resume that needs no command (0020): when the office's starts paused lifts, dipo resumes
// each park a plan limit made through this same path (`ResumeRequest.lifted`, `starts-paused.ts`),
// with no note. It never grows a cap: a resume that would need a grant is refused, and the park
// waits for the maintainer.

import {
  type Lifecycle,
  type OfficeId,
  type ResumeBudget,
  type ResumeCaps,
  type ResumeGrant,
  RoleId,
  type RunId,
  StoryId,
  type StoryKey,
  type WorkRef,
  type workResume,
} from "@dipsaus-orchestrator/contract";
import type { z } from "zod";

import type { NewEntry } from "../changelog/log";
import { CommandError } from "../commands/errors";
import type { AsyncCommandContext, CommandOutcome } from "../commands/registry";
import type { OfficeHandle } from "../db/office";
import { closeQuestion, parkWorkerQuestion } from "../hooks/questions";
import { CONTRACT_MAX_DEFAULT } from "../prompts/contract";
import { latestVerdictOfRun } from "../review/store";
import { fixRoundMessage } from "../prompts/feedback";
import { capNote } from "../prompts/handoff";
import answerTemplate from "../prompts/feedback/answer.md" with { type: "text" };
import parkedTemplate from "../prompts/feedback/parked.md" with { type: "text" };
import topupTemplate from "../prompts/feedback/topup.md" with { type: "text" };
import { renderTemplate } from "../prompts/templates";
import type { StoryIdentity } from "../stories/keys";
import { deriveStoryView, storyView } from "../views/story";
import { workRefOf } from "../views/work";
import type { Caps } from "../workers/types";

import { type CapName, firedCap, REVIEWER_ROLE, runCaps } from "./caps";
import { CONFLICT_CAP_DEFAULT, conflictCapOf, handOffState } from "./conflicts";
import { feedbackItems, feedbackOfIntent, markFeedbackSent } from "./feedback-items";
import { pendingFixRound } from "./fix-rounds";
import { recordGrant, type RoundCap } from "./grants";
import { markIntentSent, recordIntent, resolveIntent } from "./intents";
import { markPhase } from "./markers";
import type { OutcomeParts } from "./outcomes";
import { intentRest, intentTag, messageOf, type RunView } from "./outcome-types";
import { openPark, PARK_NOTICES, reopenParkedRun, resolvePark } from "./park";
import { MAINTAINER_TAGS } from "./steers";
import { PLACE_NOTICES, type Places, START_KINDS, waitForPlace } from "./places";
import { findRun, IN_REVIEW_END, REVIEWED_END, runRoundCounts, type StoredRun } from "./records";
import { recordBranchPush } from "../story-pr/records";
import { resumeRow, resumeSession, type ResumeSession, SUGGESTED_SHARE } from "./resume-policy";
import {
  budgetText,
  type PlannedGrant,
  share,
  smallestShare,
  startCaps,
  usedOf,
  withGrants,
} from "./resume-caps";
import { noteText } from "./resume";
import { type StartsPausedState, startsPausedRefusal } from "./starts-paused";
import { resumeLine } from "./summary";

type ResumeArgs = z.output<typeof workResume.args>;
type ResumeResult = z.input<typeof workResume.result>;
type OpenPark = NonNullable<ReturnType<typeof openPark>>;

/**
 * Who asks for a resume: `work.resume`'s command context, or dipo itself when the office's starts
 * paused lifted (`lifted`, with an engine-made request id and origin `other`).
 */
export type ResumeRequest = Pick<
  AsyncCommandContext,
  "office" | "origin" | "confirmed" | "client"
> & {
  /** The request id; a retry of the same request finishes its resume and repeats nothing. */
  readonly requestId: string;
  /** dipo resumes a park a plan limit made, after the office's starts paused lifted (0020). */
  readonly lifted?: true;
};

/** The tag of a maintainer resume's `answer` intent: `maintainer-resume <ResumeIntent JSON>`. */
export const MAINTAINER_RESUME_TAG = "maintainer-resume";

/** `work.resume` error codes of a parked story (0020). */
export const RESUME_ERRORS = {
  topUpRequired: "resume.topUpRequired",
  topUpTooSmall: "resume.topUpTooSmall",
  noteRequired: "resume.noteRequired",
  notResumable: "resume.notResumable",
  capReached: "resume.capReached",
} as const;

/**
 * The refusal of a park whose reason the resume table does not resume (`scope-violation`, 0020),
 * with or without a run.
 */
export function notResumable(story: string, reason: string): CommandError {
  return new CommandError(
    RESUME_ERRORS.notResumable,
    `${story} is parked as ${reason} and cannot be resumed: a part that touched a protected file or held what looks like a secret means its box can no longer be trusted. \`dipo discard ${story} --note <why>\` removes its work.`,
    { story, reason },
  );
}

/** `engine.notice` codes of a maintainer resume. */
export const PARK_RESUME_NOTICES = {
  resumed: "park.resumed",
} as const;

/** What a conflict resume prepared for the developer's next session (DIPO-324). */
export interface ConflictPrepared {
  /** The first message: the conflict item, or the commits only the remote branch holds. */
  readonly message: string;
  /**
   * Runs once that session started and the run is live: the merge a box run needs, made in the
   * run's turn of parts so the box gets it too (`BoxCollisions.mergeOnResume`).
   */
  readonly afterStart?: () => Promise<void>;
}

/** The 0019 conflict hand-off a `conflict` park resumes through (`ConflictResumes`, DIPO-324). */
export interface ConflictResumer {
  /**
   * After the park is lifted, before the session: what git says the developer needs (the kept
   * merge's conflict item, the commits only the remote branch holds after a rejected push, or the
   * base merged again), and the merge the session needs once it runs; or `parked` when it parked
   * the story again (a path the worker cannot write still conflicts).
   */
  prepare(office: OfficeId, run: StoredRun): Promise<ConflictPrepared | { readonly parked: true }>;
}

/** The auto-merge a story waiting In Review again goes back to (0002). */
export interface MergeReentry {
  reenter(office: OfficeId, run: StoredRun): Promise<void>;
}

/** A new story PR for the same head when the old one was closed on the host (0002). */
export interface PrReplacement {
  replace(office: OfficeId, run: StoredRun): Promise<void>;
}

export interface ParkResumeOptions {
  /** The office's places; read when needed, since they are built after this. */
  readonly places: () => Places | undefined;
  /** False while the daemon schedules no work; true by default. */
  readonly scheduling?: () => boolean;
  /** Whether the run's developer works in a box (DIPO-271); false without it. */
  readonly boxRun?: (office: OfficeId, run: StoredRun) => boolean;
  /** The fix rounds, which queue the round of a resumed `review-blocked` park (DIPO-148). */
  readonly fixRounds?: () =>
    | { consider(office: OfficeId, run: RunId): Promise<boolean> }
    | undefined;
  /** Starts a fresh review at once when the office has no places (a test's wiring). */
  readonly startReview?: (office: OfficeId, run: StoredRun) => Promise<boolean>;
  readonly conflicts?: () => ConflictResumer | undefined;
  readonly merge?: () => MergeReentry | undefined;
  readonly prs?: () => PrReplacement | undefined;
  /** `prompt.contractMax` of the office (R26), for a question park's answer; the default without. */
  readonly contractMax?: (office: OfficeId) => number;
  /** The office's starts paused (0020): no resume while it holds; none without it. */
  readonly startsPaused?: (office: OfficeId) => StartsPausedState | null;
}

/** The answer an `ambiguous-spec` park resumes with (0020, DIPO-159). */
interface ResumeAnswer {
  /** The park's worker question, or null when the park carries none (its detail is the question). */
  readonly question: string | null;
  /** The question as the worker asked it. */
  readonly text: string;
  readonly answer: string;
  /** True when the answer is held already for the next session (it came while the run ended). */
  readonly held: boolean;
}

/** What a maintainer resume's intent holds after its tag. */
interface ResumeIntent {
  readonly request: string;
  readonly parkId: number;
  readonly reason: string;
  readonly session: ResumeSession;
  /** The lifecycle the branch and the story go to. */
  readonly to: Lifecycle;
  /** The developer session's first message; null for none. */
  readonly message: string | null;
  readonly note: string | null;
  readonly why: string;
  readonly grants: readonly PlannedGrant[];
  /** The pending fix round whose undelivered feedback the message carries (DIPO-205). */
  readonly fix: number | null;
  /** The developer agent whose session continues, as it was at the request. */
  readonly agent: string | null;
  readonly origin: string;
  /** The client name the request's connection gave in `engine.hello`; null without one. */
  readonly client?: string | null;
  /** The answer of an `ambiguous-spec` park (DIPO-159); absent for every other park. */
  readonly answer?: ResumeAnswer | null;
  /** True when dipo resumed it after the office's starts paused lifted (0020). */
  readonly lifted?: boolean;
}

interface StoredResume {
  readonly intentId: number;
  readonly runId: RunId;
  readonly state: string;
  readonly resolvedAt: number | null;
  readonly detail: ResumeIntent;
}

interface IntentRow {
  run_id: string;
  intent_id: number;
  state: string;
  resolved_at: number | null;
  outcome: string | null;
  detail: string;
}

const CAP_LABELS: Readonly<Record<CapName, string>> = {
  budgetTokens: "token budget",
  maxTurns: "turn cap",
  maxMinutes: "time cap",
};

function count(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** The developer caps as the contract names them, each whole. */
function developerCaps(caps: Pick<Caps, "budgetTokens" | "maxTurns" | "maxMinutes">): ResumeCaps {
  return {
    budgetTokens: Math.round(caps.budgetTokens),
    maxTurns: Math.round(caps.maxTurns),
    maxMinutes: Math.round(caps.maxMinutes),
  };
}

/** A grant as the reply names it. */
function replyGrant(grant: PlannedGrant): ResumeGrant {
  const { amount } = grant;
  switch (amount.kind) {
    case "budget":
      return {
        kind: "budget",
        tokens: amount.amount.tokens,
        turns: amount.amount.turns,
        minutes: amount.amount.minutes,
      };
    case "round":
      return { kind: "round", cap: amount.amount.cap, count: amount.amount.count };
  }
}

function parseResume(detail: string): ResumeIntent | null {
  if (intentTag(detail) !== MAINTAINER_RESUME_TAG) return null;
  try {
    const parsed = JSON.parse(intentRest(detail)) as Partial<ResumeIntent>;
    return typeof parsed.request === "string" && typeof parsed.parkId === "number"
      ? (parsed as ResumeIntent)
      : null;
  } catch {
    return null;
  }
}

function storedOf(row: IntentRow): StoredResume | null {
  const detail = parseResume(row.detail);
  return detail === null
    ? null
    : {
        intentId: row.intent_id,
        runId: row.run_id as RunId,
        state: row.state,
        resolvedAt: row.resolved_at,
        detail,
      };
}

/** Every maintainer resume intent of the office not resolved yet, oldest first. */
function openResumes(office: OfficeHandle): StoredResume[] {
  return office
    .all<IntentRow>(
      `select run_id, intent_id, state, resolved_at, outcome, detail from run_intents
        where office_id = $office_id and kind = 'answer' and resolved_at is null
          and detail like $tag order by created_at, intent_id`,
      { tag: `${MAINTAINER_RESUME_TAG} %` },
    )
    .flatMap((row) => storedOf(row) ?? []);
}

/** The maintainer resume a request stored, unless it failed (a retry then runs again). */
export function resumeOfRequest(office: OfficeHandle, request: string): StoredResume | null {
  const rows = office.all<IntentRow>(
    `select run_id, intent_id, state, resolved_at, outcome, detail from run_intents
      where office_id = $office_id and kind = 'answer' and detail like $tag
      order by intent_id desc`,
    { tag: `${MAINTAINER_RESUME_TAG} %` },
  );
  for (const row of rows) {
    // A resume that failed or found its park changed runs again on a retry, checks first.
    if (row.outcome === "failed" || row.outcome === "abandoned") continue;
    const stored = storedOf(row);
    if (stored?.detail.request === request) return stored;
  }
  return null;
}

/** The `story.state` entry of a story whose park was resolved, from Parked to `to`. */
function stateEntries(
  office: OfficeHandle,
  run: StoredRun,
  to: Lifecycle,
  why: string,
): NewEntry[] {
  const key = run.key as StoryKey | null;
  if (key === null || run.story === null) return [];
  const current = storyView(office, key);
  const view = deriveStoryView({
    key,
    story: current?.story ?? StoryId.parse(run.story),
    title: current?.title ?? "",
    lifecycle: to,
    ...(current?.tier === undefined ? {} : { tier: current.tier }),
    ...(current?.pr === undefined ? {} : { pr: current.pr }),
  });
  return [
    {
      type: "story.state",
      key,
      delta: { story: run.story, key, from: "Parked", to, detail: [why] },
      view,
    },
  ];
}

/** The newest developer agent of the run: whose session a developer resume continues. */
function developerAgent(
  office: OfficeHandle,
  runId: RunId,
): { readonly agent: string; readonly model: string } | null {
  const row = office.get<{ agent_id: string; model: string }>(
    `select agent_id, model from agents where office_id = $office_id and run_id = $run
      and role <> $reviewer order by started_at desc, rowid desc limit 1`,
    { run: runId, reviewer: REVIEWER_ROLE },
  );
  return row === null ? null : { agent: row.agent_id, model: row.model };
}

/** The run's newest agent, any role; null without one. */
function newestAgent(
  office: OfficeHandle,
  runId: RunId,
): {
  readonly agent: string;
  readonly role: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
} | null {
  const row = office.get<{
    agent_id: string;
    role: string;
    started_at: number;
    ended_at: number | null;
  }>(
    `select agent_id, role, started_at, ended_at from agents
      where office_id = $office_id and run_id = $run
      order by started_at desc, rowid desc limit 1`,
    { run: runId },
  );
  return row === null
    ? null
    : { agent: row.agent_id, role: row.role, startedAt: row.started_at, endedAt: row.ended_at };
}

/**
 * The facts the resume's session follows from (`resumeSession`): whether the run waited In Review
 * when it parked (its end kind is still that of a run waiting for review or merge, since a park
 * never ends a run that ended already), and whether the park stopped its reviewer (its newest
 * session is the reviewer's, and the park ended the run).
 */
function resumeFacts(office: OfficeHandle, run: StoredRun) {
  const waitingInReview = run.endKind === IN_REVIEW_END || run.endKind === REVIEWED_END;
  const newest = newestAgent(office, run.runId);
  return { waitingInReview, reviewerStopped: !waitingInReview && newest?.role === REVIEWER_ROLE };
}

export class ParkResumes {
  readonly #s: OutcomeParts["support"];
  readonly #sessions: OutcomeParts["sessions"];
  readonly #options: ParkResumeOptions;
  /** Session starts of resumed parks running after the reply. */
  readonly #inflight = new Set<Promise<unknown>>();
  /**
   * Runs a request is resuming, from its checks to its transaction: a second request for the same
   * run in that time answers the retryable `run.hostAlive` instead of passing the checks too.
   */
  readonly #resuming = new Set<string>();

  constructor(parts: OutcomeParts, options: ParkResumeOptions) {
    this.#s = parts.support;
    this.#sessions = parts.sessions;
    this.#options = options;
  }

  /** Resolves once every session start this began after its reply has finished. */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled(this.#inflight);
  }

  /** A retry of a request that stored its resume: finished when it was not, then replied. */
  async replay(
    ctx: AsyncCommandContext,
    identity: StoryIdentity,
  ): Promise<CommandOutcome<ResumeResult> | null> {
    const stored = resumeOfRequest(ctx.office, ctx.requestId);
    return stored === null ? null : await this.#retried(ctx.office, identity, stored);
  }

  /**
   * `work.resume` of the story `identity`, parked with `park`: see the file comment. A retry of a
   * request that stored its intent finishes that resume and replies with it.
   */
  async resume(
    ctx: ResumeRequest,
    identity: StoryIdentity,
    park: OpenPark,
    args: ResumeArgs,
  ): Promise<CommandOutcome<ResumeResult>> {
    const office = ctx.office;
    const stored = resumeOfRequest(office, ctx.requestId);
    if (stored !== null) return await this.#retried(office, identity, stored);

    const row = resumeRow(park.reason);
    const story = identity.story;
    const reason = park.reason;
    if (row.need.kind === "refuse") throw notResumable(story, reason);
    const run = park.runId === null ? null : findRun(office, park.runId as RunId);
    if (run === null || run.kind !== "story" || run.endedAt === null) {
      throw new CommandError(
        RESUME_ERRORS.notResumable,
        `${story} is parked as ${reason} without a run to resume; \`dipo drop ${story}\` or \`dipo discard ${story} --note <why>\` clears it.`,
        { story, reason },
      );
    }
    const need = row.need;
    const trimmed = args.note?.trim();
    const note = trimmed === undefined || trimmed === "" ? undefined : trimmed;
    if (need.budget === true && args.budget === undefined) {
      throw this.#topUpRequired(office, run, story);
    }
    // An `ambiguous-spec` park resumes with its answer, or with one held already (DIPO-159).
    const answer = need.note === "answer" ? questionAnswer(office, park, note) : null;
    if (need.note === "answer" && answer === null) {
      const asked = parkWorkerQuestion(office, park.parkId);
      const by = asked === null ? "" : `\`dipo answer ${asked.questionId} --text <answer>\` or `;
      throw new CommandError(
        RESUME_ERRORS.noteRequired,
        `${story} is parked on its worker's question and resumes with the answer: ${by}\`dipo resume ${story} --note <answer>\`.`,
        { story, reason },
      );
    }
    if (need.note === "required" && note === undefined) {
      const what =
        reason === "review-blocked"
          ? `\`dipo resume ${story} --note <direction>\`, or \`dipo approve ${story} --note <why>\` to override the verdict`
          : `\`dipo resume ${story} --budget +${SUGGESTED_SHARE}% --note <why>\``;
      throw new CommandError(
        RESUME_ERRORS.noteRequired,
        `${story} is parked as ${reason}; its resume needs a note: ${what}.`,
        { story, reason },
      );
    }
    this.#refuseWhilePaused(office.officeId as OfficeId, story);
    this.#refuseBusy(office, run, story);
    // Held from here (no await before it) to the resume's transaction.
    this.#resuming.add(run.runId);
    const release = () => this.#resuming.delete(run.runId);
    try {
      return await this.#checkedResume(ctx, identity, park, args, run, note, release, answer);
    } finally {
      release();
    }
  }

  /** `resume` after the run is held for this request: the rest of step 1, then steps 2 to 5. */
  async #checkedResume(
    ctx: ResumeRequest,
    identity: StoryIdentity,
    park: OpenPark,
    args: ResumeArgs,
    run: StoredRun,
    note: string | undefined,
    release: () => void,
    answer: ResumeAnswer | null,
  ): Promise<CommandOutcome<ResumeResult>> {
    const office = ctx.office;
    const officeId = office.officeId as OfficeId;
    const story = identity.story;
    if (this.#options.scheduling?.() === false) {
      throw new CommandError(
        "scheduling.off",
        `dipo schedules no work now, so ${story} cannot resume; send work.resume again once scheduling is back on.`,
        { story },
      );
    }
    const session = resumeSession(park.reason, resumeFacts(office, run));
    if (session === "developer" && park.reason === "conflict" && !this.#options.conflicts?.()) {
      throw new CommandError(
        RESUME_ERRORS.notResumable,
        `${story} is parked as conflict, and this dipo has no conflict hand-off to resume it with; \`dipo discard ${story} --note <why>\` removes its work.`,
        { story, reason: park.reason },
      );
    }
    const legacy = this.#s.deps.caps?.(officeId, run) ?? null;
    if (legacy === null || workRefOf(office, run.runId) === null) {
      throw new Error(`dipo cannot resume ${run.runId} in this office`);
    }
    const planned = this.#plan(ctx, run, park.reason, session, args.budget, legacy);
    // The resume after starts paused lifted grows no cap (0020): one that needs a grant waits for
    // the maintainer.
    if (ctx.lifted === true && planned.length > 0) {
      throw new CommandError(
        RESUME_ERRORS.capReached,
        `${story} would need a grant to resume, and dipo grows no cap by itself; \`dipo resume ${story}\` resumes it.`,
        { story },
      );
    }
    this.#checkCaps(office, run, story, session, planned, legacy, args.budget);
    const capsBefore = runCaps(office, run, legacy);
    const before = developerCaps(capsBefore);
    const afterCaps = developerCaps(withGrants(capsBefore, planned));
    if (args.budget !== undefined && ctx.confirmed !== true) {
      throw new CommandError(
        "confirmation.required",
        `Raising ${story}'s caps needs confirmation; send work.resume again with confirmed.`,
        { before, after: afterCaps },
      );
    }
    // A budget grant records the caps before and after it (0020).
    const grants = planned.map((grant): PlannedGrant =>
      grant.amount.kind === "budget"
        ? {
            ...grant,
            amount: {
              kind: "budget",
              amount: { ...grant.amount.amount, before, after: afterCaps },
            },
          }
        : grant,
    );
    const developer = session === "developer";
    const fix =
      developer && park.reason === "budget-exceeded" ? pendingFixRound(office, run.runId) : null;
    const to: Lifecycle = developer ? "In Progress" : "In Review";
    const detail: ResumeIntent = {
      request: ctx.requestId,
      parkId: park.parkId,
      reason: park.reason,
      session,
      to,
      message: developer ? this.#message(office, run, park, grants, legacy, fix, answer) : null,
      note: note ?? null,
      why:
        ctx.lifted === true
          ? `dipo resumed it from ${park.reason} after the office's starts paused lifted`
          : `the maintainer resumed it from ${park.reason}`,
      grants,
      fix: fix?.intentId ?? null,
      agent: developerAgent(office, run.runId)?.agent ?? null,
      origin: ctx.origin,
      client: ctx.client ?? null,
      ...(answer === null ? {} : { answer }),
      ...(ctx.lifted === true ? { lifted: true } : {}),
    };
    // 2. Stored before anything changes, so a restart or a retry finishes the resume.
    const intentId = office.immediate(() =>
      recordIntent(
        office,
        run.runId,
        "answer",
        `${MAINTAINER_RESUME_TAG} ${JSON.stringify(detail)}`,
        this.#s.deps.clock.now(),
      ),
    );
    const outcome = await this.#finish(office, run, intentId, detail, true, release);
    return { result: this.#result(identity, run, detail, outcome.queued) };
  }

  /**
   * The starter of a maintainer resume of a developer session that waited for the worker place:
   * the run's sent, unresolved maintainer resume starts its session. Null when the run has none.
   */
  async startQueued(officeId: OfficeId, run: StoredRun): Promise<boolean | null> {
    const office = this.#s.deps.offices.get(officeId);
    if (office === undefined) return null;
    const stored = openResumes(office).find(
      (candidate) =>
        candidate.runId === run.runId &&
        candidate.state === "sent" &&
        candidate.detail.session === "developer",
    );
    if (stored === undefined) return null;
    if (this.#s.guard.busy(run.runId)) return false;
    return await this.#s.guard.within(`${run.runId} maintainer-resume`, () =>
      this.#startDeveloper(
        office,
        findRun(office, run.runId) ?? run,
        stored.intentId,
        stored.detail,
      ),
    );
  }

  /**
   * After a restart: a maintainer resume whose intent was stored but not sent is finished while
   * its park is still open (else dropped); one sent whose developer session never started (and
   * does not wait for its place) starts it.
   */
  async recover(office: OfficeHandle): Promise<number> {
    let finished = 0;
    for (const stored of openResumes(office)) {
      const run = findRun(office, stored.runId);
      if (run === null || this.#s.guard.busy(stored.runId)) continue;
      const resolve = (outcome: string) =>
        office.immediate(() =>
          resolveIntent(office, run.runId, stored.intentId, outcome, this.#s.deps.clock.now()),
        );
      if (stored.state === "pending") {
        const park = run.key === null ? null : openPark(office, run.key);
        if (park?.parkId !== stored.detail.parkId || run.endedAt === null) {
          resolve("abandoned");
          continue;
        }
        try {
          await this.#finish(office, run, stored.intentId, stored.detail, false);
          finished += 1;
        } catch (error) {
          this.#s.deps.warn?.("finishing a maintainer resume after a restart failed", {
            run: run.runId,
            reason: messageOf(error),
          });
        }
        continue;
      }
      if (stored.detail.session !== "developer" || run.endedAt !== null || run.waiting != null) {
        continue;
      }
      // A session started after the intent: the resume is done.
      if (developerAgent(office, run.runId)?.agent !== stored.detail.agent) {
        resolve("resumed");
        continue;
      }
      await this.#s.guard.within(`${run.runId} maintainer-resume`, () =>
        this.#startDeveloper(office, run, stored.intentId, stored.detail),
      );
      finished += 1;
    }
    return finished;
  }

  /** A retry of a request whose resume was stored: finished when it was not, then replied. */
  async #retried(
    office: OfficeHandle,
    identity: StoryIdentity,
    stored: StoredResume,
  ): Promise<CommandOutcome<ResumeResult>> {
    const run = findRun(office, stored.runId);
    if (run === null) throw new Error(`${identity.story}'s resumed run is gone`);
    if (stored.state === "pending" && stored.resolvedAt === null) {
      const outcome = await this.#finish(office, run, stored.intentId, stored.detail, true);
      return { result: this.#result(identity, run, stored.detail, outcome.queued) };
    }
    const queued = (findRun(office, run.runId) ?? run).waiting != null;
    return { result: this.#result(identity, run, stored.detail, queued), changed: false };
  }

  #result(
    identity: StoryIdentity,
    run: StoredRun,
    detail: ResumeIntent,
    queued: boolean,
  ): ResumeResult {
    return {
      story: identity.story,
      key: identity.key,
      to: detail.to,
      run: run.runId,
      ...(queued ? { queued: true } : {}),
      ...(detail.grants.length === 0 ? {} : { grants: detail.grants.map(replyGrant) }),
    };
  }

  /**
   * Steps 3 to 5 after the intent `intentId` is stored: the lift on the branch (idempotent), the
   * transaction, then the session. `background` starts a developer session after returning (the
   * command), else waits for it (a restart).
   */
  async #finish(
    office: OfficeHandle,
    run: StoredRun,
    intentId: number,
    detail: ResumeIntent,
    background: boolean,
    /** Called once the transaction ran, applied or not (the request's hold on the run). */
    applied: () => void = () => {},
  ): Promise<{ readonly queued: boolean }> {
    const officeId = office.officeId as OfficeId;
    const clock = this.#s.deps.clock;
    const fail = (why: string): never => {
      office.immediate(() => resolveIntent(office, run.runId, intentId, "failed", clock.now()));
      throw new Error(why);
    };
    // The park changed under the resume: nothing is written, nothing follows (DIPO-155 review).
    const gone = (): never => {
      office.immediate(() => resolveIntent(office, run.runId, intentId, "abandoned", clock.now()));
      const now = run.key === null ? null : storyView(office, run.key as StoryKey);
      const park = run.key === null ? null : openPark(office, run.key);
      const state =
        park === null
          ? `it is ${now?.lifecycle ?? "no longer Parked"} now`
          : `it is parked as ${park.reason} now`;
      throw new CommandError(
        "story.notPausedOrParked",
        `${run.story ?? run.runId} is no longer parked as it was when work.resume checked it; ${state}.`,
        { story: run.story ?? run.runId },
      );
    };
    const unpark = this.#s.deps.unpark;
    const work = workRefOf(office, run.runId);
    const key = run.key;
    if (
      unpark === undefined ||
      work === null ||
      run.story === null ||
      run.branch === null ||
      run.worktree === null ||
      key === null
    ) {
      return fail(`dipo cannot resume ${run.runId} in this office`);
    }
    const park = openPark(office, key);
    if (park === null || park.parkId !== detail.parkId) return gone();
    let lifted;
    try {
      lifted = await unpark.lift(officeId, {
        story: run.story,
        branch: run.branch,
        worktree: run.worktree,
        to: detail.to,
        // The resume's line in the implementation notes (0020), in the same commit.
        line: resumeLine({
          at: clock.now(),
          grants: detail.grants.map((grant) => grant.amount),
          ...(detail.note === null ? {} : { note: detail.note }),
        }),
        // An answer becomes a resolved unknown in the same commit (0020).
        ...(detail.answer == null
          ? {}
          : {
              answer: {
                q: detail.answer.text,
                answer: detail.answer.answer,
                contractMax: this.#options.contractMax?.(officeId) ?? CONTRACT_MAX_DEFAULT,
              },
            }),
      });
    } catch (error) {
      return fail(`lifting the park of ${run.story} failed: ${messageOf(error)}`);
    }
    const notice = (code: string, text: string): NewEntry => ({
      type: "engine.notice",
      key: work.key,
      run: run.runId,
      delta: { level: "warn", code, text },
    });
    const liftNotices: NewEntry[] = [
      ...(lifted.lineError == null
        ? []
        : [
            notice(
              PARK_NOTICES.summaryMissing,
              `${run.story}: the park was lifted, but its resume line is missing from the task file's implementation notes: ${lifted.lineError}`,
            ),
          ]),
      ...(lifted.pushError === null
        ? []
        : [
            notice(
              PARK_NOTICES.pushFailed,
              `${run.story}: the park was lifted, but ${lifted.pushError}; the change is on the local branch only until a later push succeeds.`,
            ),
          ]),
      ...(lifted.answerError == null
        ? []
        : [
            notice(
              PARK_NOTICES.answerNotWritten,
              `${run.story}: the answer goes to its worker, but it was not written to the story's unknowns: ${lifted.answerError}.`,
            ),
          ]),
    ];
    const places = this.#options.places();
    const queued: { place: string | null } = { place: null };
    let wrote = false;
    const step = async (): Promise<void> =>
      this.#s.write(office, () => {
        const at = clock.now();
        const current = openPark(office, key);
        if (current?.parkId !== detail.parkId) return [];
        wrote = true;
        // The lift's push, on the claim like every story-branch push (DIPO-315).
        const push = { pushed: lifted.pushed, error: lifted.pushError };
        recordBranchPush(office, run.branch as string, push, at);
        const entries = [
          ...answeredQuestion(office, run, detail.answer ?? null, at),
          ...this.#resolve(office, run, current, detail, at),
        ];
        for (const grant of detail.grants) {
          recordGrant(office, run.runId, {
            ...grant.amount,
            grantId: grant.grantId,
            note: detail.note,
            origin: detail.origin,
            client: detail.client ?? null,
            at,
          });
        }
        markIntentSent(office, run.runId, intentId, at, null);
        const waits = this.#queue(office, run, detail, places, at);
        queued.place = waits;
        // The places, the fix rounds or the PR poll own what follows; nothing waits on the intent.
        if (detail.session !== "developer") {
          resolveIntent(office, run.runId, intentId, `resumed-${detail.session}`, at);
        }
        const story = run.story ?? run.runId;
        const granted =
          detail.grants.length === 0
            ? ""
            : ` with ${detail.grants.length} recorded grant${detail.grants.length === 1 ? "" : "s"}`;
        const resumed: NewEntry = {
          type: "engine.notice",
          key: work.key,
          run: run.runId,
          delta: {
            level: "info",
            code: waits === null ? PARK_RESUME_NOTICES.resumed : PLACE_NOTICES.queued,
            text:
              waits === null
                ? `${story}: ${detail.lifted === true ? "dipo resumed it after the office's starts paused lifted" : "the maintainer resumed it"} from ${current.reason}${granted}.`
                : `${story}: resumed${granted}; its session starts when the office's ${detail.session === "review" ? "reviewer" : "worker"} place frees (${waits}).`,
          },
        };
        return [...entries, ...liftNotices, resumed];
      });
    // The place check and the reopen are one serialized step of the office (DIPO-229).
    try {
      if (places === undefined) await step();
      else await places.serialized(officeId, step);
    } finally {
      applied();
    }
    if (!wrote) return gone();
    await this.#s.deps.refreshStory?.(officeId, work.key).catch((error: unknown) => {
      this.#s.deps.warn?.("reading the resumed story again failed", {
        run: run.runId,
        reason: messageOf(error),
      });
    });
    const fresh = findRun(office, run.runId) ?? run;
    await this.#after(office, fresh, intentId, detail, queued.place, background);
    return { queued: queued.place !== null };
  }

  /**
   * Inside the resume's transaction: the park resolved, with its questions, and the run as its
   * session needs it.
   */
  #resolve(
    office: OfficeHandle,
    run: StoredRun,
    park: OpenPark,
    detail: ResumeIntent,
    at: number,
  ): NewEntry[] {
    const why = `resumed from ${park.reason}: ${park.detail}`;
    switch (detail.session) {
      case "developer":
        return reopenParkedRun(office, park, run, detail.to, at, detail.note);
      case "review":
        return [
          ...reopenParkedRun(office, park, run, detail.to, at, detail.note),
          ...markPhase(office, run.runId, "review", at),
        ];
      case "fix-round": {
        const closed = resolvePark(office, park.parkId, "resume", at, detail.note);
        // The run waits in review again with its verdict in: the fix round decides from it.
        endedAs(office, run.runId, REVIEWED_END);
        if (detail.note !== null) {
          // The note goes with the fix round's first message, after its findings (0020).
          recordIntent(
            office,
            run.runId,
            "steer",
            `${MAINTAINER_TAGS.held} ${noteText(detail.note)}`,
            at,
          );
        }
        return [...closed, ...stateEntries(office, run, detail.to, why)];
      }
      case "none": {
        const closed = resolvePark(office, park.parkId, "resume", at, detail.note);
        // The run waits In Review again: the auto-merge and the PR poll take only a run ended at
        // In Review or after its review.
        endedAs(
          office,
          run.runId,
          latestVerdictOfRun(office, run.runId) === null ? IN_REVIEW_END : REVIEWED_END,
        );
        return [...closed, ...stateEntries(office, run, detail.to, why)];
      }
    }
  }

  /** Inside the transaction: why a developer or review session must wait for its place, or null. */
  #queue(
    office: OfficeHandle,
    run: StoredRun,
    detail: ResumeIntent,
    places: Places | undefined,
    at: number,
  ): string | null {
    const officeId = office.officeId as OfficeId;
    if (detail.session === "review") {
      // A review always starts through the reviewer place's `review-resume` start.
      const blocked =
        places?.blocked(officeId, {
          kind: START_KINDS.reviewResume,
          runId: run.runId,
          since: at,
        }) ?? null;
      waitForPlace(office, run.runId, START_KINDS.reviewResume, at);
      return blocked;
    }
    if (detail.session !== "developer") return null;
    const blocked =
      places?.blocked(officeId, { kind: START_KINDS.resume, runId: run.runId, since: at }) ?? null;
    if (blocked !== null) waitForPlace(office, run.runId, START_KINDS.resume, at);
    return blocked;
  }

  /** Step 5: the session the resume starts, after the transaction. */
  async #after(
    office: OfficeHandle,
    run: StoredRun,
    intentId: number,
    detail: ResumeIntent,
    queued: string | null,
    background: boolean,
  ): Promise<void> {
    const officeId = office.officeId as OfficeId;
    const places = this.#options.places();
    const warn =
      (what: string) =>
      (error: unknown): false => {
        this.#s.deps.warn?.(what, { run: run.runId, reason: messageOf(error) });
        return false;
      };
    switch (detail.session) {
      case "review":
        if (places !== undefined) {
          void places.drain(officeId).catch(warn("starting a resumed review failed"));
        } else {
          await this.#options.startReview?.(officeId, run).catch(warn("starting a review failed"));
        }
        return;
      case "fix-round":
        await this.#options
          .fixRounds?.()
          ?.consider(officeId, run.runId)
          .catch(warn("queueing the fix round of a resumed story failed"));
        return;
      case "none":
        // A PR closed on the host is replaced (0002); one still open is only updated. Then the
        // auto-merge takes the story in again.
        await this.#options
          .prs?.()
          ?.replace(officeId, run)
          .catch(warn("opening a new story PR failed"));
        await this.#options
          .merge?.()
          ?.reenter(officeId, run)
          .catch(warn("handing the story back to the auto-merge failed"));
        // A run with no verdict yet is a pending review again: the reviewer place takes it.
        void places?.drain(officeId).catch(warn("starting the review of a resumed story failed"));
        return;
      case "developer":
        break;
    }
    if (queued !== null) {
      void places?.drain(officeId).catch(warn("starting a queued resume failed"));
      return;
    }
    const start = (): Promise<boolean> =>
      this.#s.guard.within(`${run.runId} maintainer-resume`, () =>
        this.#startDeveloper(office, run, intentId, detail),
      );
    if (!background) {
      await start();
      return;
    }
    // The reply does not wait for the worker host: the session starts after it.
    const job = start().catch(warn("starting the session of a resumed park failed"));
    this.#inflight.add(job);
    void job.finally(() => this.#inflight.delete(job));
  }

  /** The developer's next session with the resume's first message; the intent resolved after. */
  async #startDeveloper(
    office: OfficeHandle,
    run: StoredRun,
    intentId: number,
    detail: ResumeIntent,
  ): Promise<boolean> {
    const officeId = office.officeId as OfficeId;
    const clock = this.#s.deps.clock;
    const resolve = (outcome: string) =>
      office.immediate(() => resolveIntent(office, run.runId, intentId, outcome, clock.now()));
    const view = this.#developerView(officeId, office, run);
    if (view === null) {
      resolve("failed");
      return false;
    }
    let message = detail.message;
    let afterStart: (() => Promise<void>) | undefined;
    if (detail.reason === "conflict") {
      let prepared;
      try {
        prepared = await this.#options.conflicts?.()?.prepare(officeId, run);
      } catch (error) {
        this.#s.deps.warn?.("preparing the conflict of a resumed park failed", {
          run: run.runId,
          reason: messageOf(error),
        });
        prepared = undefined;
      }
      if (prepared === undefined || "parked" in prepared) {
        resolve(prepared === undefined ? "failed" : "parked");
        return false;
      }
      message = [prepared.message, message].filter((part) => part !== null).join("\n\n");
      afterStart = prepared.afterStart;
    }
    const box = this.#options.boxRun?.(officeId, run) === true;
    const started = await this.#sessions.next(office, run, view, {
      // A box run's developer gets a new session in its box with a handoff (0008).
      mode: box ? "handoff" : "resume",
      why: detail.why,
      ...(message === null || message === "" ? {} : { message }),
      // After the reason's part; an answer's note is the answer, which that part carries.
      ...(detail.note === null || detail.answer != null ? {} : { note: detail.note }),
    });
    const at = clock.now();
    office.immediate(() => {
      if (started && detail.fix !== null) {
        // The round's feedback reached the worker with this session (DIPO-205).
        markIntentSent(office, run.runId, detail.fix, at, null);
        markFeedbackSent(office, run.runId, detail.fix, at);
        resolveIntent(office, run.runId, detail.fix, "started", at);
      }
      resolveIntent(office, run.runId, intentId, started ? "resumed" : "notStarted", at);
    });
    if (started && afterStart !== undefined) {
      // The merge the session needs runs in its live run's turn, outside this run's guard.
      const job = afterStart().catch((error: unknown) => {
        this.#s.deps.warn?.("the merge of a resumed conflict failed", {
          run: run.runId,
          reason: messageOf(error),
        });
      });
      this.#inflight.add(job);
      void job.finally(() => this.#inflight.delete(job));
    }
    return started;
  }

  /** The run's view with its newest developer agent, whose session the resume continues. */
  #developerView(officeId: OfficeId, office: OfficeHandle, run: StoredRun): RunView | null {
    const view = this.#s.viewOf(officeId, office, run);
    if (view === null) return null;
    const developer = developerAgent(office, run.runId);
    if (developer === null) return view;
    const work = {
      ...view.work,
      agent: developer.agent,
      role: RoleId.parse(run.role),
      model: developer.model,
    } as WorkRef;
    return { ...view, work };
  }

  /**
   * The grants this resume records, with ids made from the request so a retry writes none twice:
   * the top-up, and one more round of the counted cap that fired (see the file comment). A resumed
   * review gets none: the reviewer's caps hold per session.
   */
  #plan(
    ctx: ResumeRequest,
    run: StoredRun,
    reason: string,
    session: ResumeSession,
    budget: ResumeBudget | undefined,
    legacy: Caps,
  ): PlannedGrant[] {
    const id = (kind: string) => `${ctx.requestId}:${kind}`;
    const grants: PlannedGrant[] = [];
    if (budget !== undefined) {
      grants.push({
        grantId: id("budget"),
        amount: { kind: "budget", amount: share(startCaps(run, legacy), budget) },
      });
    }
    if (session === "review") return grants;
    const office = ctx.office;
    const caps = runCaps(office, run, legacy);
    const rounds = runRoundCounts(office, run.runId);
    const round = (cap: RoundCap, before: number) =>
      grants.push({
        grantId: id(cap),
        amount: { kind: "round", amount: { cap, count: 1, before, after: before + 1 } },
      });
    switch (reason) {
      case "verify-failing":
        if (caps.ciCap !== null && rounds.ciAttempts >= caps.ciCap) round("ciAttempts", caps.ciCap);
        else if (rounds.loops >= caps.loopCap) round("loops", caps.loopCap);
        break;
      case "review-blocked":
        if (caps.reviewRoundCap !== null) round("reviewRounds", caps.reviewRoundCap);
        break;
      case "conflict": {
        const cap = conflictCapOf(office, run, CONFLICT_CAP_DEFAULT);
        if (handOffState(office, run.runId).failed >= cap) round("conflictAttempts", cap);
        break;
      }
    }
    return grants;
  }

  /**
   * Step 1's cap check: what remains of the developer's caps, counting this resume's grants, is
   * above zero. Only a developer session counts them: a review counts the reviewer's own caps,
   * which a fresh session starts with in full (0002), and a fix round or no session counts nothing
   * here.
   */
  #checkCaps(
    office: OfficeHandle,
    run: StoredRun,
    story: string,
    session: ResumeSession,
    grants: readonly PlannedGrant[],
    legacy: Caps,
    budget: ResumeBudget | undefined,
  ): void {
    if (session !== "developer") return;
    const before = runCaps(office, run, legacy);
    const used = usedOf(office, run);
    const fired = firedCap(withGrants(before, grants), used);
    if (fired === null) return;
    if (budget !== undefined) {
      const smallest = smallestShare(startCaps(run, legacy), before, used);
      throw new CommandError(
        RESUME_ERRORS.topUpTooSmall,
        `${budgetText(budget)} leaves ${story}'s ${CAP_LABELS[fired.cap]} reached (${fired.detail}); the smallest top-up that clears it is +${smallest}%: \`dipo resume ${story} --budget +${smallest}% --note <why>\`.`,
        { story, cap: fired.cap, smallestShare: smallest },
      );
    }
    throw new CommandError(
      RESUME_ERRORS.capReached,
      `${story} has used its ${CAP_LABELS[fired.cap]} (${fired.detail}); resume it with a top-up: \`dipo resume ${story} --budget +${SUGGESTED_SHARE}% --note <why>\`.`,
      { story, cap: fired.cap },
    );
  }

  /** `resume.topUpRequired`, naming `--budget` and the cap that fired. */
  #topUpRequired(office: OfficeHandle, run: StoredRun, story: string): CommandError {
    const legacy = this.#s.deps.caps?.(office.officeId as OfficeId, run) ?? undefined;
    const used = usedOf(office, run);
    const caps = runCaps(office, run, legacy);
    const fired = firedCap(caps, used);
    const cap = fired === null ? "" : ` on its ${CAP_LABELS[fired.cap]} (${fired.detail})`;
    return new CommandError(
      RESUME_ERRORS.topUpRequired,
      `${story} parked as budget-exceeded${cap}. Resume with \`dipo resume ${story} --budget +${SUGGESTED_SHARE}% --note <why>\`.`,
      { story, ...(fired === null ? {} : { cap: fired.cap }) },
    );
  }

  /** `run.refused` while the office's starts are paused: no session can start then (0020). */
  #refuseWhilePaused(officeId: OfficeId, story: string): void {
    const paused = this.#options.startsPaused?.(officeId) ?? null;
    if (paused === null) return;
    throw startsPausedRefusal(`${story} cannot resume now`, paused, { story });
  }

  /** `run.hostAlive` while a session of the run still runs or is being decided. */
  #refuseBusy(office: OfficeHandle, run: StoredRun, story: string): void {
    const live = office.get<{ found: number }>(
      `select 1 as found from agents where office_id = $office_id and run_id = $run
        and ended_at is null limit 1`,
      { run: run.runId },
    );
    if (live === null && !this.#s.guard.busy(run.runId) && !this.#resuming.has(run.runId)) return;
    throw new CommandError(
      "run.hostAlive",
      `${story}'s last worker has not exited yet; send work.resume again in a moment.`,
      { story, run: run.runId },
    );
  }

  /** The developer session's first message: the reason's part, then the note (0020). */
  #message(
    office: OfficeHandle,
    run: StoredRun,
    park: OpenPark,
    grants: readonly PlannedGrant[],
    legacy: Caps,
    fix: ReturnType<typeof pendingFixRound>,
    answer: ResumeAnswer | null,
  ): string | null {
    const parked = (detail: string) =>
      renderTemplate(parkedTemplate, { reason: park.reason, detail });
    const parts: string[] = [];
    switch (resumeRow(park.reason).delta) {
      case "check": {
        // The last red check or verify output the run stored; the park's detail without one.
        const item = feedbackItems(office, run.runId)
          .filter((candidate) => candidate.source === "verify" || candidate.source === "ci")
          .at(-1);
        parts.push(parked(item?.text ?? park.detail));
        break;
      }
      case "maintainer":
      case "detail":
        parts.push(parked(park.detail));
        break;
      case "topup": {
        // The undelivered feedback of the round the caps stopped before its session, first.
        if (fix !== null) {
          parts.push(
            fixRoundMessage({
              head: fix.detail.head,
              items: feedbackOfIntent(office, run.runId, fix.intentId),
              advisories: fix.detail.advisories,
            }),
          );
        }
        const budget = grants.find((grant) => grant.amount.kind === "budget")?.amount;
        if (budget?.kind === "budget") {
          const caps = withGrants(runCaps(office, run, legacy), grants);
          parts.push(
            renderTemplate(topupTemplate, {
              amount: `${count(budget.amount.tokens)} tokens, ${count(budget.amount.turns)} turns and ${count(budget.amount.minutes)} minutes`,
              caps: `${count(caps.budgetTokens)} tokens, ${count(caps.maxTurns)} turns and ${count(caps.maxMinutes)} minutes`,
            }),
          );
        }
        break;
      }
      case "answer":
        // An answer held already goes with the first message as it waited (`heldMessages`).
        if (answer !== null && !answer.held) {
          parts.push(
            renderTemplate(answerTemplate, {
              question: answer.text,
              answer: capNote(answer.answer),
            }),
          );
        }
        break;
      case "conflict":
      case "findings":
        // Built when the session starts (`ConflictResumer.prepare`), or by the fix round.
        break;
    }
    // The note follows the reason's part: the session start adds it (`NextSessionRequest.note`).
    return parts.length === 0 ? null : parts.join("\n\n");
  }
}

/**
 * The answer an `ambiguous-spec` park resumes with (DIPO-159): the note, or the answer already
 * held for the park's worker question; null when there is neither. The question is the park's
 * worker question, or the park's detail when it carries none.
 */
function questionAnswer(
  office: OfficeHandle,
  park: OpenPark,
  note: string | undefined,
): ResumeAnswer | null {
  const asked = parkWorkerQuestion(office, park.parkId);
  const text = asked?.text ?? park.detail;
  if (note !== undefined) {
    return { question: asked?.questionId ?? null, text, answer: note, held: false };
  }
  if (asked?.closedHow === "answered" && asked.answer !== null) {
    return { question: asked.questionId, text, answer: asked.answer, held: true };
  }
  return null;
}

/**
 * Inside the resume's transaction, before the park is resolved (DIPO-159): the park's worker
 * question this resume answers closes as `answered` (delivered `on-resume`) with its
 * `question.closed`; resolving the park then expires every other question it holds open.
 */
function answeredQuestion(
  office: OfficeHandle,
  run: StoredRun,
  answer: ResumeAnswer | null,
  at: number,
): NewEntry[] {
  if (answer === null || answer.held || answer.question === null) return [];
  const closed = closeQuestion(office, answer.question, "answered", at, {
    text: answer.answer,
    decision: null,
    delivered: "on-resume",
  });
  if (!closed) return [];
  return [
    {
      type: "question.closed",
      ...(run.key === null ? {} : { key: run.key as StoryKey }),
      run: run.runId,
      delta: { question: answer.question, answer: answer.answer },
    },
  ];
}

/** Inside the caller's transaction: an ended run takes the end kind `kind`, its outcome row too. */
function endedAs(office: OfficeHandle, runId: RunId, kind: string): void {
  office.run(
    `update runs set end_kind = $kind where office_id = $office_id and run_id = $run
      and ended_at is not null`,
    { run: runId, kind },
  );
  office.run(
    `update run_outcomes set end_kind = $kind, outcome = $kind
      where office_id = $office_id and run_id = $run and final = 0`,
    { run: runId, kind },
  );
}
