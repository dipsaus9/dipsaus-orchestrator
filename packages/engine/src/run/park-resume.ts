// `work.resume` of a parked story (ADR 0020 sections 1 to 5, DIPO-155): one path for every park
// with a resuming row in the matrix (`resume-policy.ts`).
//
// 1. Check, with no writes: the park has a run, its row resumes, a `budget-exceeded` park comes
//    with its top-up (`resume.topUpRequired` naming `--budget` and the cap that fired), a required
//    note is given (`resume.noteRequired`), the adapter hold of a `worker-failed` park is lifted
//    (`run.refused` naming it), no session of the run is alive (`run.hostAlive`), the daemon
//    schedules work (`scheduling.off`), what remains of the caps, counting this resume's grants,
//    is above zero (`resume.capReached` naming `--budget`; for a top-up `resume.topUpTooSmall`
//    naming the smallest share that clears it), a top-up was confirmed (`confirmation.required`
//    with the caps before and after), and for a git-state park the worktree's git links still
//    match the claim (else `resume.notResumable` naming `dipo discard`) while a new backstop
//    snapshot is read.
// 2. Intent first: an `answer` intent tagged `maintainer-resume` with the request id, the first
//    message, the grants and the snapshot, so a restart or a retry of the same request finishes the
//    resume and repeats nothing (the grants have ids made from the request).
// 3. The park is lifted on the story branch (the F16 block removed, the status set), in dipo's own
//    copy of the story's backlog (`gitUnparkWriter`); a lift already written commits nothing.
// 4. One transaction: the park resolved `resume` with the note (`parks.resolved_note`), the grants
//    recorded (`run_grants`), the run reopened, the new snapshot stored, `story.state` back, the
//    intent sent; a session whose place is taken waits for it (`waitForPlace`) and the reply says
//    `queued`.
// 5. The next session of the same run, by the row's session: the developer's (a native resume when
//    the 0014 section 6 checks pass, else a handoff; a box run always gets a new session in its box,
//    0021 section 6), a fresh reviewer session of the same round on the same head (the reviewer
//    place's `review-resume` start), a fix round with the last verdict's blocking findings (the fix
//    rounds, which set the story In Progress), or none.
//
// The first message is code-built (0020 section 3): the reason's delta, then
// `feedback/maintainer-note.md` with the note, so maintainer text never starts a message. A top-up
// of a park a reopened fix round hit before its session (DIPO-205) sends that round's undelivered
// feedback first, then `feedback/topup.md`. A reviewer never gets the note (0002).
//
// A question park (`ambiguous-spec` with cause `question`, 0020 section 7, DIPO-159) resumes with
// its answer: the note, or the text of `work.answer` on the park's question, which comes here as
// the note. The first message is `feedback/answer.md` with the question and the answer, and the
// note is not sent again. The lift adds the answer to the story's unknowns as a resolved unknown
// in the same task-file commit, or, when that would break R26, leaves it out with an
// `engine.notice`. The transaction closes the park's question as answered. A park that carries a
// worker question whose answer is held already (it came while the run was ending) resumes without
// a note: the held answer goes with the first message. Every other open question of the park
// closes as expired with the resume.
//
// The parks another part of dipo finishes (DIPO-324): a `conflict` park's developer session starts
// with the first message `ConflictResumer.prepare` builds (the kept merge's conflict item, or the
// commits only the remote branch holds), and the merge it needs runs once that session started
// (`afterStart`), in the live run's box. A `slot-refused` or `pr-closed` park starts no session:
// its run waits In Review again (end kind `in-review`, or `reviewed` once a verdict exists), and
// the merge slot takes it in again (`SlotReentry`) or a new story PR opens in place of the closed
// one (`PrReplacement`).

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
import { GitError } from "../git/runner";
import {
  closeQuestion,
  openParkQuestions,
  parkWorkerQuestion,
  type StoredQuestion,
} from "../hooks/questions";
import { CONTRACT_MAX_DEFAULT } from "../prompts/contract";
import { latestVerdictOfRun } from "../review/store";
import { fixRoundMessage } from "../prompts/feedback";
import { capNote } from "../prompts/handoff";
import answerTemplate from "../prompts/feedback/answer.md" with { type: "text" };
import parkedTemplate from "../prompts/feedback/parked.md" with { type: "text" };
import topupTemplate from "../prompts/feedback/topup.md" with { type: "text" };
import { FEEDBACK_TEMPLATES, renderTemplate } from "../prompts/templates";
import type { StoryIdentity } from "../stories/keys";
import { deriveStoryView, storyView } from "../views/story";
import { workRefOf } from "../views/work";
import { type AdapterHold, holdMessage } from "../workers/hold";
import type { Caps } from "../workers/types";

import type { BackstopSnapshot } from "./backstop";
import { type CapName, firedCap, REVIEWER_ROLE, runCaps } from "./caps";
import { feedbackItems, feedbackOfIntent, markFeedbackSent } from "./feedback-items";
import { pendingFixRound } from "./fix-rounds";
import { recordGrant } from "./grants";
import { markIntentSent, recordIntent, resolveIntent } from "./intents";
import { markPhase } from "./markers";
import type { OutcomeParts } from "./outcomes";
import { intentRest, intentTag, messageOf, type RunView } from "./outcome-types";
import {
  openPark,
  PARK_NOTICES,
  reopenParkedRun,
  resolveParkResumed,
  WORKTREE_TAMPERED,
} from "./park";
import { MAINTAINER_TAGS } from "./pauses";
import { PLACE_NOTICES, type Places, START_KINDS, waitForPlace } from "./places";
import { findRun, IN_REVIEW_END, storeBackstopSnapshot, type StoredRun } from "./records";
import {
  type ParkRefusalRow,
  type ParkResumeRow,
  parkResumeRow,
  type ResumeSession,
} from "./resume-policy";
import {
  budgetText,
  HALF_SHARE,
  type PlannedGrant,
  share,
  smallestShare,
  startCaps,
  usedOf,
  withGrants,
} from "./resume-caps";
import { noteText } from "./resume";
import { REVIEWED_END } from "./rounds";
import { resumeLine } from "./summary";

type ResumeArgs = z.output<typeof workResume.args>;
type ResumeResult = z.input<typeof workResume.result>;
type OpenPark = NonNullable<ReturnType<typeof openPark>>;

/** The tag of a maintainer resume's `answer` intent: `maintainer-resume <ResumeIntent JSON>`. */
export const MAINTAINER_RESUME_TAG = "maintainer-resume";

/** `work.resume` error codes of a parked story (0020 section 14). */
export const RESUME_ERRORS = {
  topUpRequired: "resume.topUpRequired",
  topUpTooSmall: "resume.topUpTooSmall",
  noteRequired: "resume.noteRequired",
  notResumable: "resume.notResumable",
  capReached: "resume.capReached",
  decisionRequired: "resume.decisionRequired",
} as const;

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
   * After the park is lifted, before the session: the kept merge's conflict item, the commits only
   * the remote branch holds after a rejected push, and the merge the session needs once it runs
   * (the base again when it moved, or the remote branch), through the 0019 hand-off; or `parked`
   * when it parked the story again (an unwritable path still conflicts).
   */
  prepare(
    office: OfficeId,
    run: StoredRun,
    park: { readonly cause: string | null },
  ): Promise<ConflictPrepared | { readonly parked: true }>;
}

/** The merge slot a `slot-refused` park re-enters with a fresh per-stay count (DIPO-150's). */
export interface SlotReentry {
  reenter(office: OfficeId, run: StoredRun): Promise<void>;
}

/** A new story PR for the same head, its body naming the closed one (a `pr-closed` park). */
export interface PrReplacement {
  replace(office: OfficeId, run: StoredRun): Promise<void>;
}

export interface ParkResumeOptions {
  /** The office's places; read when needed, since they are built after this. */
  readonly places: () => Places | undefined;
  /** False while the daemon schedules no work; true by default. */
  readonly scheduling?: () => boolean;
  /** Reads a worktree's backstop snapshot (`readBackstop`); without it no git-state park resumes. */
  readonly snapshot?: (office: OfficeId, worktree: string) => Promise<BackstopSnapshot>;
  /** Whether the run's developer works in a box (DIPO-271); false without it. */
  readonly boxRun?: (office: OfficeId, run: StoredRun) => boolean;
  /** The fix rounds, which queue the round of a resumed `review-blocked` park (DIPO-148). */
  readonly fixRounds?: () =>
    | { consider(office: OfficeId, run: RunId): Promise<boolean> }
    | undefined;
  /** Starts a fresh review at once when the office has no places (a test's wiring). */
  readonly startReview?: (office: OfficeId, run: StoredRun) => Promise<boolean>;
  readonly conflicts?: () => ConflictResumer | undefined;
  readonly slot?: () => SlotReentry | undefined;
  readonly prs?: () => PrReplacement | undefined;
  /** `prompt.contractMax` of the office (R26), for a question park's answer; the default without. */
  readonly contractMax?: (office: OfficeId) => number;
}

/** The answer a question park resumes with (0020 section 7, DIPO-159). */
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
  readonly cause: string | null;
  readonly session: ResumeSession;
  /** The lifecycle the branch and the story go to. */
  readonly to: Lifecycle;
  /** The developer session's first message; null for none (the resume template then). */
  readonly message: string | null;
  readonly note: string | null;
  readonly why: string;
  readonly grants: readonly PlannedGrant[];
  readonly snapshot: BackstopSnapshot | null;
  /** The pending fix round whose undelivered feedback the message carries (DIPO-205). */
  readonly fix: number | null;
  /** The developer agent whose session continues, as it was at the request. */
  readonly agent: string | null;
  readonly origin: string;
  /** The client name the request's connection gave in `engine.hello`; null without one. */
  readonly client?: string | null;
  /** A question park's answer (DIPO-159); absent for every other park. */
  readonly answer?: ResumeAnswer | null;
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

function isDeveloper(session: ResumeSession): boolean {
  return session === "developer" || session === "handoff";
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
    case "reviewCap":
      return { kind: "reviewCap", turns: amount.amount.turns, minutes: amount.amount.minutes };
    case "scope":
      return { kind: "scope" };
    default:
      return { kind: amount.kind, count: amount.amount };
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

/** The turns of the run's newest reviewer agent; null without one. */
function reviewerTurns(office: OfficeHandle, runId: RunId): number | null {
  const row = office.get<{ agent_id: string }>(
    `select agent_id from agents where office_id = $office_id and run_id = $run
      and role = $reviewer order by started_at desc, rowid desc limit 1`,
    { run: runId, reviewer: REVIEWER_ROLE },
  );
  if (row === null) return null;
  return (
    office.get<{ n: number | null }>(
      `select sum(turns) as n from usage_totals where office_id = $office_id and run_id = $run
        and agent_id = $agent`,
      { run: runId, agent: row.agent_id },
    )?.n ?? 0
  );
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
    ctx: AsyncCommandContext,
    identity: StoryIdentity,
    park: OpenPark,
    args: ResumeArgs,
  ): Promise<CommandOutcome<ResumeResult>> {
    const office = ctx.office;
    const stored = resumeOfRequest(office, ctx.requestId);
    if (stored !== null) return await this.#retried(office, identity, stored);

    const row = parkResumeRow(park.reason, park.cause);
    const story = identity.story;
    const label = park.cause === null ? park.reason : `${park.reason} (${park.cause})`;
    if (row === null) {
      throw new CommandError(
        "story.notPausedOrParked",
        `${story} is parked as ${label}, which work.resume does not resume yet.`,
        { story },
      );
    }
    if (row.kind === "refuse") throw refusal(row, story, label, park);
    const run = park.runId === null ? null : findRun(office, park.runId as RunId);
    if (run === null || run.kind !== "story" || run.endedAt === null) {
      throw new CommandError(
        RESUME_ERRORS.notResumable,
        `${story} is parked as ${label} without a run to resume; \`dipo drop ${story}\` or \`dipo discard ${story} --note <why>\` clears it.`,
        { story, reason: park.reason },
      );
    }
    const trimmed = args.note?.trim();
    const note = trimmed === undefined || trimmed === "" ? undefined : trimmed;
    if (row.topUp === true && args.budget === undefined) {
      throw this.#topUpRequired(office, run, story, row, label);
    }
    // A question park resumes with its answer, or with one held already (DIPO-159).
    const answer = row.delta === "answer" ? questionAnswer(office, park, note) : null;
    if (row.delta === "answer" && answer === null) {
      const asked = parkWorkerQuestion(office, park.parkId);
      const by = asked === null ? "" : `\`dipo answer ${asked.questionId} --text <answer>\` or `;
      throw new CommandError(
        RESUME_ERRORS.noteRequired,
        `${story} is parked on its worker's question and resumes with the answer: ${by}\`dipo resume ${story} --note <answer>\`.`,
        { story, reason: park.reason },
      );
    }
    if (row.note === "required" && note === undefined && answer === null) {
      throw new CommandError(
        RESUME_ERRORS.noteRequired,
        `${story} is parked as ${label}; its resume needs a note: \`dipo resume ${story} --note <text>\`.`,
        { story, reason: park.reason },
      );
    }
    if (args.budget !== undefined && row.topUp !== true && row.grant !== "budgetHalf") {
      throw new CommandError(
        "args.invalid",
        `--budget tops up a budget-exceeded or capped park only; ${story} is parked as ${label}.`,
        { story, issues: [] },
      );
    }
    if (row.holdCheck === true) this.#refuseWhileHeld(story);
    this.#refuseBusy(office, run, story);
    // Held from here (no await before it) to the resume's transaction.
    this.#resuming.add(run.runId);
    const release = () => this.#resuming.delete(run.runId);
    try {
      return await this.#checkedResume(
        ctx,
        identity,
        park,
        args,
        row,
        run,
        note,
        label,
        release,
        answer,
      );
    } finally {
      release();
    }
  }

  /** `resume` after the run is held for this request: the rest of step 1, then steps 2 to 5. */
  async #checkedResume(
    ctx: AsyncCommandContext,
    identity: StoryIdentity,
    park: OpenPark,
    args: ResumeArgs,
    row: ParkResumeRow,
    run: StoredRun,
    note: string | undefined,
    label: string,
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
    this.#refuseWithoutPort(row, story, label);

    // A git-state park raised during a review returns to a fresh review (0020 section 2).
    const session: ResumeSession =
      row.gitCheck === true && park.from === "In Review" ? "review" : row.session;
    const legacy = this.#s.deps.caps?.(officeId, run) ?? null;
    if (legacy === null || workRefOf(office, run.runId) === null) {
      throw new Error(`dipo cannot resume ${run.runId} in this office`);
    }
    const planned = this.#plan(ctx, run, row, args.budget, legacy);
    this.#checkCaps(office, run, story, row, session, planned, legacy, args.budget);
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
    // A budget grant records the caps before and after it (0020 section 4).
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
    const snapshot = row.gitCheck === true ? await this.#snapshot(officeId, run, story) : null;

    const fix = row.delta === "topup" ? pendingFixRound(office, run.runId) : null;
    const to: Lifecycle = isDeveloper(session) ? "In Progress" : "In Review";
    const detail: ResumeIntent = {
      request: ctx.requestId,
      parkId: park.parkId,
      reason: park.reason,
      cause: park.cause,
      session,
      to,
      message: isDeveloper(session)
        ? this.#message(office, run, park, row, grants, legacy, fix, answer)
        : null,
      note: note ?? null,
      why: row.why ?? `the maintainer resumed it from ${label}`,
      grants,
      snapshot,
      fix: fix?.intentId ?? null,
      agent: developerAgent(office, run.runId)?.agent ?? null,
      origin: ctx.origin,
      client: ctx.client ?? null,
      ...(answer === null ? {} : { answer }),
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
        isDeveloper(candidate.detail.session),
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
      if (!isDeveloper(stored.detail.session) || run.endedAt !== null || run.waiting != null) {
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
   * transaction, then the session by the row. `background` starts a developer session after
   * returning (the command), else waits for it (a restart).
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
        // The resume's line in the implementation notes (0020 section 13), in the same commit.
        line: resumeLine({
          at: clock.now(),
          grants: detail.grants.map((grant) => grant.amount),
          ...(detail.note === null ? {} : { note: detail.note }),
        }),
        // A question park's answer becomes a resolved unknown in the same commit (0020 section 7).
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
    const answerNotice: NewEntry[] =
      lifted.answerError == null
        ? []
        : [
            {
              type: "engine.notice",
              key: work.key,
              run: run.runId,
              delta: {
                level: "warn",
                code: PARK_NOTICES.answerNotWritten,
                text: `${run.story}: the answer goes to its worker, but it was not written to the story's unknowns: ${lifted.answerError}.`,
              },
            },
          ];
    const lineNotice: NewEntry[] =
      lifted.lineError == null
        ? []
        : [
            {
              type: "engine.notice",
              key: work.key,
              run: run.runId,
              delta: {
                level: "warn",
                code: PARK_NOTICES.summaryMissing,
                text: `${run.story}: the park was lifted, but its resume line is missing from the task file's implementation notes: ${lifted.lineError}`,
              },
            },
          ];
    const pushNotice: NewEntry[] =
      lifted.pushError === null
        ? []
        : [
            {
              type: "engine.notice",
              key: work.key,
              run: run.runId,
              delta: {
                level: "warn",
                code: PARK_NOTICES.pushFailed,
                text: `${run.story}: the park was lifted, but ${lifted.pushError}; the change is on the local branch only until a later push succeeds.`,
              },
            },
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
        const entries = this.#apply(office, run, current, detail, at);
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
        if (detail.snapshot !== null) storeBackstopSnapshot(office, run.runId, detail.snapshot);
        markIntentSent(office, run.runId, intentId, at, null);
        const waits = this.#queue(office, run, detail, places, at);
        queued.place = waits;
        // The places, the fix rounds or a port own what follows; nothing waits on the intent.
        if (!isDeveloper(detail.session)) {
          resolveIntent(office, run.runId, intentId, `resumed-${detail.session}`, at);
        }
        const story = run.story ?? run.runId;
        const granted =
          detail.grants.length === 0
            ? ""
            : ` with ${detail.grants.length} recorded grant${detail.grants.length === 1 ? "" : "s"}`;
        const notice: NewEntry = {
          type: "engine.notice",
          key: work.key,
          run: run.runId,
          delta: {
            level: "info",
            code: waits === null ? PARK_RESUME_NOTICES.resumed : PLACE_NOTICES.queued,
            text:
              waits === null
                ? `${story}: the maintainer resumed it from ${current.reason}${granted}.`
                : `${story}: resumed${granted}; its session starts when the office's ${detail.session === "review" ? "reviewer" : "worker"} place frees (${waits}).`,
          },
        };
        return [...entries, ...lineNotice, ...pushNotice, ...answerNotice, notice];
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
   * Inside the resume's transaction: the park's questions closed (DIPO-159), the park resolved and
   * the run as its session needs it.
   */
  #apply(
    office: OfficeHandle,
    run: StoredRun,
    park: OpenPark,
    detail: ResumeIntent,
    at: number,
  ): NewEntry[] {
    return [
      ...closeParkQuestions(office, run, park.parkId, detail.answer ?? null, at),
      ...this.#resolve(office, run, park, detail, at),
    ];
  }

  /** Inside the resume's transaction: the park resolved and the run as its session needs it. */
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
      case "handoff":
        return reopenParkedRun(office, park, run, detail.to, at, detail.note);
      case "review":
        return [
          ...reopenParkedRun(office, park, run, detail.to, at, detail.note),
          ...markPhase(office, run.runId, "review", at),
        ];
      case "fix-round":
        resolveParkResumed(office, park.parkId, at, detail.note);
        // The run waits in review again with its verdict in: the fix round decides from it.
        endedAs(office, run.runId, REVIEWED_END);
        if (detail.note !== null) {
          // The note goes with the fix round's first message, after its findings (0020 section 3).
          recordIntent(
            office,
            run.runId,
            "steer",
            `${MAINTAINER_TAGS.held} ${noteText(detail.note)}`,
            at,
          );
        }
        return stateEntries(office, run, detail.to, why);
      case "none":
        resolveParkResumed(office, park.parkId, at, detail.note);
        // The run waits In Review again (DIPO-324): the merge slot and the PR poll take only a run
        // ended at In Review or after its review, so a re-entry or a new story PR takes effect.
        if (detail.to === "In Review") {
          endedAs(
            office,
            run.runId,
            latestVerdictOfRun(office, run.runId) === null ? IN_REVIEW_END : REVIEWED_END,
          );
        }
        return stateEntries(office, run, detail.to, why);
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
        places?.blocked(
          officeId,
          { kind: START_KINDS.reviewResume, runId: run.runId, since: at },
          places.modelOf(officeId, "reviewer", run),
        ) ?? null;
      waitForPlace(office, run.runId, START_KINDS.reviewResume, at);
      return blocked;
    }
    if (!isDeveloper(detail.session)) return null;
    const blocked =
      places?.blocked(
        officeId,
        { kind: START_KINDS.resume, runId: run.runId, since: at },
        places.modelOf(officeId, "worker", run),
      ) ?? null;
    if (blocked !== null) waitForPlace(office, run.runId, START_KINDS.resume, at);
    return blocked;
  }

  /** Step 5: the session the row asks for, after the transaction. */
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
        if (detail.reason === "conflict") {
          await this.#options
            .slot?.()
            ?.reenter(officeId, run)
            .catch(warn("re-entering the merge slot failed"));
        } else {
          await this.#options
            .prs?.()
            ?.replace(officeId, run)
            .catch(warn("opening a new story PR failed"));
        }
        return;
      case "developer":
      case "handoff":
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
        prepared = await this.#options
          .conflicts?.()
          ?.prepare(officeId, run, { cause: detail.cause });
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
      // A box run's developer gets a new session in its box (0021 section 6).
      mode: box || detail.session === "handoff" ? "handoff" : "resume",
      why: detail.why,
      ...(message === null || message === "" ? {} : { message }),
      // After the delta in a native resume, in the handoff's open feedback otherwise (section 3).
      // A question park's note is its answer, which the delta carries already (DIPO-159).
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

  /** The grants this resume records, with ids made from the request so a retry writes none twice. */
  #plan(
    ctx: AsyncCommandContext,
    run: StoredRun,
    row: ParkResumeRow,
    budget: ResumeBudget | undefined,
    legacy: Caps,
  ): PlannedGrant[] {
    const id = (kind: string) => `${ctx.requestId}:${kind}`;
    const start = startCaps(run, legacy);
    if (row.topUp === true || (row.grant === "budgetHalf" && budget !== undefined)) {
      return [{ grantId: id("budget"), amount: { kind: "budget", amount: share(start, budget) } }];
    }
    switch (row.grant) {
      case undefined:
        return [];
      case "budgetHalf":
        return [
          {
            grantId: id("budget"),
            amount: { kind: "budget", amount: share(start, { share: HALF_SHARE }) },
          },
        ];
      case "reviewCap": {
        // The reviewer's cap that fired grows by half of its starting value.
        const turns = reviewerTurns(ctx.office, run.runId);
        const caps = runCaps(ctx.office, run, legacy);
        const turnsFired =
          turns !== null && caps.reviewMaxTurns !== null && turns >= caps.reviewMaxTurns;
        return [
          {
            grantId: id("reviewCap"),
            amount: {
              kind: "reviewCap",
              amount: turnsFired
                ? { turns: half(run.reviewMaxTurns), minutes: 0 }
                : { turns: 0, minutes: half(run.reviewMaxMinutes) },
            },
          },
        ];
      }
      default:
        return [{ grantId: id(row.grant), amount: { kind: row.grant, amount: 1 } }];
    }
  }

  /**
   * Step 1's cap check: what remains of the caps, counting this resume's grants, is above zero.
   * A developer session and a fix round count tokens, turns and minutes; a review counts the
   * story's budget; a resume with no session counts nothing.
   */
  #checkCaps(
    office: OfficeHandle,
    run: StoredRun,
    story: string,
    row: ParkResumeRow,
    session: ResumeSession,
    grants: readonly PlannedGrant[],
    legacy: Caps,
    budget: ResumeBudget | undefined,
  ): void {
    if (session === "none") return;
    const before = runCaps(office, run, legacy);
    const used = usedOf(office, run);
    const caps = withGrants(before, grants);
    const fired =
      session === "review"
        ? firedCap({ ...caps, maxTurns: Infinity, maxMinutes: Infinity }, used)
        : firedCap(caps, used);
    if (fired === null) return;
    if (grants.some((grant) => grant.amount.kind === "budget")) {
      const smallest = smallestShare(startCaps(run, legacy), before, used, session);
      const given = budget === undefined ? `+${HALF_SHARE}%` : budgetText(budget);
      throw new CommandError(
        RESUME_ERRORS.topUpTooSmall,
        `${given} leaves ${story}'s ${CAP_LABELS[fired.cap]} reached (${fired.detail}); the smallest top-up that clears it is +${smallest}%: \`dipo resume ${story} --budget +${smallest}% --note <why>\`.`,
        { story, cap: fired.cap, smallestShare: smallest },
      );
    }
    throw new CommandError(
      RESUME_ERRORS.capReached,
      `${story} has used its ${CAP_LABELS[fired.cap]} (${fired.detail}); resume it with a top-up: \`dipo resume ${story} --budget +${HALF_SHARE}% --note <why>\`.`,
      { story, cap: fired.cap },
    );
  }

  /** `resume.topUpRequired`, naming `--budget` and the cap that fired. */
  #topUpRequired(
    office: OfficeHandle,
    run: StoredRun,
    story: string,
    row: ParkResumeRow,
    label: string,
  ): CommandError {
    const legacy = this.#s.deps.caps?.(office.officeId as OfficeId, run) ?? undefined;
    const used = usedOf(office, run);
    const caps = runCaps(office, run, legacy);
    const fired =
      row.session === "review"
        ? firedCap({ ...caps, maxTurns: Infinity, maxMinutes: Infinity }, used)
        : firedCap(caps, used);
    const cap = fired === null ? "" : ` on its ${CAP_LABELS[fired.cap]} (${fired.detail})`;
    return new CommandError(
      RESUME_ERRORS.topUpRequired,
      `${story} parked as ${label}${cap}. Resume with \`dipo resume ${story} --budget +${HALF_SHARE}% --note <why>\`.`,
      { story, ...(fired === null ? {} : { cap: fired.cap }) },
    );
  }

  /** `run.refused` naming the adapter hold while it is set (0020 section 2, `worker-failed`). */
  #refuseWhileHeld(story: string): void {
    const adapter = this.#s.deps.worker.id;
    const hold: AdapterHold | null = this.#s.deps.holds?.adapterHeld?.(adapter) ?? null;
    if (hold === null) return;
    throw new CommandError(
      "run.refused",
      `${story} cannot resume while its adapter is held: ${holdMessage(hold)}`,
      { story, check: "adapter" },
    );
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

  /** A row whose resume needs another story's port answers `resume.notResumable` without it. */
  #refuseWithoutPort(row: ParkResumeRow, story: string, label: string): void {
    const missing =
      (row.port === "conflict" && this.#options.conflicts?.() === undefined) ||
      (row.port === "slot" && this.#options.slot?.() === undefined) ||
      (row.port === "pr" && this.#options.prs?.() === undefined);
    if (!missing) return;
    const what =
      row.port === "pr"
        ? "story PR replacement"
        : row.port === "slot"
          ? "story merge slot"
          : "conflict hand-off";
    throw new CommandError(
      RESUME_ERRORS.notResumable,
      `${story} is parked as ${label}, and this dipo has no ${what} to resume it with yet; \`dipo discard ${story} --note <why>\` removes its work.`,
      { story, port: row.port },
    );
  }

  /** The new backstop snapshot of a git-state park; tampered git links refuse the resume. */
  async #snapshot(officeId: OfficeId, run: StoredRun, story: string): Promise<BackstopSnapshot> {
    const read = this.#options.snapshot;
    if (read === undefined || run.worktree === null) {
      throw new Error(`dipo cannot read ${story}'s worktree in this office`);
    }
    try {
      return await read(officeId, run.worktree);
    } catch (error) {
      if (error instanceof GitError && error.code === WORKTREE_TAMPERED) {
        throw new CommandError(
          RESUME_ERRORS.notResumable,
          `${story}'s worktree git links changed since the claim, so it cannot be resumed; \`dipo discard ${story} --note <why>\` removes its work.`,
          { story, cause: "tampered" },
        );
      }
      throw error;
    }
  }

  /** The developer session's first message: the reason's delta, then the note (section 3). */
  #message(
    office: OfficeHandle,
    run: StoredRun,
    park: OpenPark,
    row: ParkResumeRow,
    grants: readonly PlannedGrant[],
    legacy: Caps,
    fix: ReturnType<typeof pendingFixRound>,
    answer: ResumeAnswer | null,
  ): string | null {
    const parked = (detail: string) =>
      renderTemplate(parkedTemplate, {
        reason: park.reason,
        cause: park.cause ?? park.reason,
        detail,
      });
    const lastItem = (source: "verify" | "ci") =>
      feedbackItems(office, run.runId)
        .filter((item) => item.source === source)
        .at(-1)?.text ?? park.detail;
    const parts: string[] = [];
    switch (row.delta) {
      case "resume":
        parts.push(renderTemplate(FEEDBACK_TEMPLATES.resume, { reason: row.why ?? park.detail }));
        break;
      case "detail":
        parts.push(parked(park.detail));
        break;
      case "verify-item":
        parts.push(parked(lastItem("verify")));
        break;
      case "ci-item":
        parts.push(parked(lastItem("ci")));
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
      case "none":
        break;
    }
    // The note follows the delta: the session start adds it (`NextSessionRequest.note`).
    return parts.length === 0 ? null : parts.join("\n\n");
  }
}

/**
 * The answer a question park resumes with (DIPO-159): the note, or the answer already held for the
 * park's worker question; null when there is neither. The question is the park's worker question,
 * or the park's detail when it carries none (a park from before questions were stored).
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
 * Inside the resume's transaction (DIPO-159): the park's worker question answered by this resume
 * closes as `answered` (delivered `on-resume`), and every other open question of the park as
 * `expired`, each with its `question.closed`. The trigger of migration 50 then finds none open.
 */
function closeParkQuestions(
  office: OfficeHandle,
  run: StoredRun,
  parkId: number,
  answer: ResumeAnswer | null,
  at: number,
): NewEntry[] {
  const entries: NewEntry[] = [];
  const closed = (question: StoredQuestion, text?: string) => {
    entries.push({
      type: "question.closed",
      ...(run.key === null ? {} : { key: run.key as StoryKey }),
      run: run.runId,
      delta: { question: question.questionId, ...(text === undefined ? {} : { answer: text }) },
    });
  };
  for (const question of openParkQuestions(office, parkId)) {
    if (answer !== null && !answer.held && question.questionId === answer.question) {
      const text = answer.answer;
      if (
        closeQuestion(office, question.questionId, "answered", at, {
          text,
          decision: null,
          delivered: "on-resume",
        })
      ) {
        closed(question, text);
      }
      continue;
    }
    if (closeQuestion(office, question.questionId, "expired", at)) closed(question);
  }
  return entries;
}

/** Half of a starting reviewer cap, rounded up: what a `reviewCap` grant adds. */
function half(value: number | null | undefined): number {
  return Math.ceil((value ?? 0) * (HALF_SHARE / 100));
}

/** The refusal of a matrix row that does not resume. */
function refusal(row: ParkRefusalRow, story: string, label: string, park: OpenPark): CommandError {
  const { code } = row;
  if (row.box === true) {
    return new CommandError(
      code,
      `${story} is parked as ${label}: a box part that touched a protected file, held what looks like a secret or was refused, or a task file with fields dipo does not know, is never resumed (the maintainer's decision); \`dipo discard ${story} --note <why>\` removes its work.`,
      { story, reason: park.reason, ...(park.cause === null ? {} : { cause: park.cause }) },
    );
  }
  return code === "resume.decisionRequired"
    ? new CommandError(
        code,
        `${story} is parked as ${label} and waits for a decision: answer its question with \`dipo answer <question> allow|deny\`.`,
        { story, reason: park.reason },
      )
    : new CommandError(
        code,
        `${story} is parked as ${label} and cannot be resumed; \`dipo discard ${story} --note <why>\` removes its work.`,
        { story, reason: park.reason, ...(park.cause === null ? {} : { cause: park.cause }) },
      );
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
