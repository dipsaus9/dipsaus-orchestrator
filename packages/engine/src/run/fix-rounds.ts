// Fix rounds (0019 sections 7, 8 and 13; 0021 sections 6 and 10 and its amendment of 2026-10-22;
// DIPO-148): the feedback on a pushed head goes back to the same worker in one round.
//
// - Sources. A blocked review verdict (its unmet criteria and blocking findings), the red required
//   checks of the pushed head (`StoryPrs.ciState`, DIPO-147; CI is the verify of a box run,
//   DIPO-299) and a maintainer reject (`reject`, fed by DIPO-151's `gate.reject`, which does not
//   exist yet, so no reject item is produced until it does). A conflict hand-off of a run In
//   Review (`conflict`, the entry for the merge slot's sync, DIPO-150) is sent at once like a
//   reject. Advisory findings never start a round on their own; a round that starts for another
//   reason lists them as optional.
// - Timing (section 7). `consider` runs when a reviewer session's exit is decided after its verdict
//   ended the review period, and when the CI of a head stops being pending (`onCiFinal`). It waits
//   until the head's verdict is in (a run with the review loop's caps ended `reviewed`) and its
//   checks are final, past the wait cap, or known to be none (a box run's head with no CI, or an
//   office whose story PRs are off), so one round carries all feedback for that head. A reject is
//   sent at once.
// - Queue. One round per head: in one serialized step of the office (`Places.serialized`, so it
//   cannot race a pickup's place check), one transaction reopens the run for its fix round
//   (`reopenForRound`, phase `build`, waiting for the worker place), stores the round's steer
//   intent (`fix-round {head, advisories}`) and its `feedback_items` rows, send-once per head
//   (`planFeedback`), and raises `same-failure` when a CI or verify signature is sent twice in a
//   row. The rows and the intent are written before the places' shared pre-start cap check
//   (DIPO-205), so a round that check parks keeps its feedback, undelivered, for a top-up resume.
// - Start (`START_KINDS.fix`, the worker place). The story's status goes back to In Progress on
//   its branch (`<ID>: status In Progress`, lane a, through the park lift's single write path),
//   then the developer session continues: a resume when `canResume` holds, else a new session with
//   the handoff. A box run's developer gets a new session in its box with the feedback as its task
//   (0021 section 6; keeping the box from claim to merge is DIPO-240's). The intent is marked sent
//   and its items delivered once the session started; a session that did not start parks the story
//   as any next session does, and the feedback stays undelivered with its intent.

import {
  type Clock,
  type OfficeId,
  RoleId,
  type RunId,
  StoryId,
  type StoryKey,
  type WorkRef,
} from "@dipsaus-orchestrator/contract";

import { appendEntries, type NewEntry } from "../changelog/log";
import type { OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import {
  advisoryLines,
  type FixItem,
  fixRoundMessage,
  rejectFeedbackItem,
  reviewFeedbackItems,
} from "../prompts/feedback";
import type { StoredReviewVerdict } from "../review/store";
import { reviewVerdictForTree } from "../review/store";
import type { CiHeadState } from "../story-pr/prs";
import { deriveStoryView, lifecycleOf, storyView } from "../views/story";
import { withWorkViews, workRefOf } from "../views/work";
import { findClaim } from "../worktree/records";

import { REVIEWER_ROLE } from "./caps";
import type { DecidingGuard } from "./deciding";
import {
  feedbackOfIntent,
  markFeedbackSent,
  nextFixRound,
  planFeedback,
  sameFailureAgain,
  storeFeedbackItems,
} from "./feedback-items";
import { markIntentSent, recordIntent, resolveIntent, runIntents } from "./intents";
import { intentRest, intentTag, type RunView } from "./outcome-types";
import { openPark, type UnparkWriter } from "./park";
import type { Places, PlaceStart } from "./places";
import { findRun, IN_REVIEW_END, type StoredRun } from "./records";
import type { RunStoryFacts } from "./resume";
import { REVIEWED_END, reopenForRound } from "./rounds";
import { raiseSignal } from "./signals";

/** The tag of a fix round's steer intent: `steer` `fix-round {"head":…,"advisories":[…]}`. */
export const FIX_ROUND_TAG = "fix-round";

/** `engine.notice` codes of the fix rounds. */
export const FIX_NOTICES = {
  /** A fix round was queued for the worker place. */
  queued: "fix.queued",
} as const;

/** What a fix round's intent detail holds after its tag. */
interface FixIntentDetail {
  readonly head: string;
  readonly advisories: readonly string[];
}

/** Starts the next developer session of a run (`SessionStarts.next`). */
export interface FixSessions {
  next(
    office: OfficeHandle,
    run: StoredRun,
    view: RunView,
    request: {
      readonly mode: "resume" | "handoff";
      readonly why: string;
      readonly message?: string;
    },
  ): Promise<boolean>;
}

export interface FixRoundsDeps {
  readonly clock: Clock;
  readonly offices: {
    get(office: OfficeId): OfficeHandle | undefined;
    config(office: OfficeId): OfficeConfig | undefined;
  };
  /** The story facts of a run, read on the office base (`baseStoryFacts`). */
  readonly story: (office: OfficeId, run: StoredRun) => Promise<RunStoryFacts>;
  /**
   * Where the CI of a run's pushed head stands (`StoryPrs.ciState`); without it no CI is waited
   * for. Null before the PR poll watched a head of the run.
   */
  readonly ci?: (office: OfficeId, runId: RunId) => CiHeadState | null;
  /** The run's next developer session (worker outcomes' `SessionStarts`). */
  readonly sessions: FixSessions;
  /** The view of a run that is not tracked (`OutcomeSupport.viewOf`); null without caps. */
  readonly view: (office: OfficeId, handle: OfficeHandle, run: StoredRun) => RunView | null;
  /** Sets the story's status on its branch (the park lift, DIPO-75); without it none is committed. */
  readonly unpark?: UnparkWriter;
  /** Whether the run's developer works in a box (DIPO-271); false without it. */
  readonly boxRun?: (office: OfficeId, run: StoredRun) => boolean;
  /** The office's places; read when needed, since they are built after this. */
  readonly places: () => Places | undefined;
  /** The deciding guard of worker outcomes, so a restart step leaves a starting round alone. */
  readonly guard?: DecidingGuard;
  /** Reads the story again at its branch tip after the status commit. */
  readonly refreshStory?: (office: OfficeId, key: StoryKey) => Promise<unknown>;
  readonly onChanged?: (office: OfficeId) => void;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The run's newest review verdict, or null. */
export function lastReviewVerdict(office: OfficeHandle, runId: RunId): StoredReviewVerdict | null {
  const row = office.get<{ code_tree_key: string }>(
    `select code_tree_key from review_verdicts where office_id = $office_id and run_id = $run
      order by decided_at desc, rowid desc limit 1`,
    { run: runId },
  );
  return row === null ? null : reviewVerdictForTree(office, runId, row.code_tree_key);
}

/** The fix round intents of the run, oldest first. */
function fixIntents(office: OfficeHandle, runId: RunId) {
  return runIntents(office, runId).filter(
    (intent) => intent.kind === "steer" && intentTag(intent.detail) === FIX_ROUND_TAG,
  );
}

function detailOf(detail: string): FixIntentDetail | null {
  try {
    const parsed = JSON.parse(intentRest(detail)) as Partial<FixIntentDetail>;
    if (typeof parsed.head !== "string") return null;
    return {
      head: parsed.head,
      advisories: Array.isArray(parsed.advisories)
        ? parsed.advisories.filter((line): line is string => typeof line === "string")
        : [],
    };
  } catch {
    return null;
  }
}

/** True when a fix round was queued for `head` already: one round per head (section 8). */
export function fixRoundQueued(office: OfficeHandle, runId: RunId, head: string): boolean {
  return fixIntents(office, runId).some((intent) => detailOf(intent.detail)?.head === head);
}

/** The run's fix round intent still waiting for its session, or null. */
export function pendingFixRound(
  office: OfficeHandle,
  runId: RunId,
): { readonly intentId: number; readonly detail: FixIntentDetail } | null {
  const intent = fixIntents(office, runId)
    .filter((candidate) => candidate.state === "pending")
    .at(-1);
  const detail = intent === undefined ? null : detailOf(intent.detail);
  return intent === undefined || detail === null ? null : { intentId: intent.intentId, detail };
}

export class FixRounds {
  readonly #deps: FixRoundsDeps;
  /** Runs whose round is being decided now. */
  readonly #deciding = new Set<string>();
  /** The drains a queued round started, until they finished. */
  readonly #inflight = new Set<Promise<unknown>>();

  constructor(deps: FixRoundsDeps) {
    this.#deps = deps;
  }

  /** Resolves once every drain a queued round started has finished. */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled(this.#inflight);
  }

  /**
   * Queues the fix round of the run's pushed head once its verdict and checks are in (see the file
   * comment); true when a round was queued. `exited` is the agent whose exit is being decided now,
   * which is not waited for.
   */
  async consider(
    officeId: OfficeId,
    runId: RunId,
    options: { readonly exited?: string } = {},
  ): Promise<boolean> {
    if (this.#deciding.has(runId)) return false;
    this.#deciding.add(runId);
    try {
      return await this.#consider(officeId, runId, options.exited);
    } catch (error) {
      this.#deps.warn?.("deciding a fix round failed; the story stays In Review", {
        run: runId,
        reason: messageOf(error),
      });
      return false;
    } finally {
      this.#deciding.delete(runId);
    }
  }

  async #consider(officeId: OfficeId, runId: RunId, exited: string | undefined): Promise<boolean> {
    const office = this.#deps.offices.get(officeId);
    const config = this.#deps.offices.config(officeId);
    if (office === undefined || config === undefined) return false;
    const run = findRun(office, runId);
    if (run === null || !this.#waitsInReview(office, run, exited)) return false;
    const reviewed = run.reviewRoundCap != null;
    // The head's verdict is in: the review period ended with it (section 7).
    if (reviewed && run.endKind !== REVIEWED_END) return false;
    const ci = this.#ciOf(officeId, config, run);
    if (ci.kind === "pending") return false;
    const verdict = reviewed ? lastReviewVerdict(office, runId) : null;
    const head = ci.head ?? verdict?.commit ?? null;
    if (head === null) return false;
    let facts: RunStoryFacts | null = null;
    try {
      facts = await this.#deps.story(officeId, run);
    } catch (error) {
      this.#deps.warn?.("reading a story before its fix round failed", {
        run: runId,
        reason: messageOf(error),
      });
    }
    // A story Done on the base gets no round; reconcile releases its claim.
    if (facts !== null && lifecycleOf("task", facts.view.status) === "Done") return false;
    const itemMax = itemMaxOf(config, run.tier);
    const review =
      verdict?.verdict === "blocked"
        ? reviewFeedbackItems(
            verdict,
            (n) => facts?.view.acceptanceCriteria.find((criterion) => criterion.index === n)?.text,
            itemMax,
          )
        : [];
    const red: FixItem[] =
      ci.kind === "red"
        ? ci.items.map((item) => ({ source: "ci", signature: item.signature, text: item.text }))
        : [];
    return await this.#queue(office, run, {
      head,
      items: [...review, ...red],
      advisories: verdict === null ? [] : advisoryLines(verdict.findings),
    });
  }

  /**
   * A maintainer reject (0019 sections 8 and 11): its note, verbatim and keyed on the gate id, goes
   * to the worker at once, through the same send path as review and CI items. The entry for
   * DIPO-151's `gate.reject`; nothing calls it before that story. True when a round was queued.
   */
  async reject(
    officeId: OfficeId,
    runId: RunId,
    reject: { readonly gateId: string; readonly note: string },
  ): Promise<boolean> {
    const office = this.#deps.offices.get(officeId);
    if (office === undefined) return false;
    const run = findRun(office, runId);
    if (run === null || !this.#waitsInReview(office, run, undefined)) return false;
    const head =
      office.get<{ head_sha: string }>(
        "select head_sha from story_prs where office_id = $office_id and run_id = $run",
        { run: runId },
      )?.head_sha ??
      lastReviewVerdict(office, runId)?.commit ??
      null;
    if (head === null) return false;
    return await this.#queue(office, run, {
      head,
      items: [rejectFeedbackItem(reject)],
      advisories: [],
      atOnce: true,
    });
  }

  /**
   * A conflict hand-off of a run waiting In Review (0019 sections 8 and 10, DIPO-149): the one
   * conflict item of a merge dipo made into the branch, sent at once like a reject, through the
   * same send path (once per head and signature). The entry for the merge slot's sync (DIPO-150);
   * a box run's sync before In Review hands its conflict over in the live session instead. True
   * when a round was queued.
   */
  async conflict(
    officeId: OfficeId,
    runId: RunId,
    input: { readonly head: string; readonly item: FixItem },
  ): Promise<boolean> {
    const office = this.#deps.offices.get(officeId);
    if (office === undefined) return false;
    const run = findRun(office, runId);
    if (run === null || !this.#waitsInReview(office, run, undefined)) return false;
    return await this.#queue(office, run, {
      head: input.head,
      items: [input.item],
      advisories: [],
      atOnce: true,
    });
  }

  /**
   * The fix starter (`START_KINDS.fix`): the run's pending fix round sets the story In Progress on
   * its branch and starts the developer's next session with the round's one message. True when
   * the session started.
   */
  async start(officeId: OfficeId, run: StoredRun, _start: PlaceStart): Promise<boolean> {
    const office = this.#deps.offices.get(officeId);
    if (office === undefined || run.story === null || run.key === null) return false;
    if (run.branch === null || run.worktree === null) return false;
    const pending = pendingFixRound(office, run.runId);
    if (pending === null) {
      this.#deps.warn?.("a run waits for a fix round that has no feedback", { run: run.runId });
      return false;
    }
    if (this.#deps.guard?.busy(run.runId) === true) return false;
    const { head, advisories } = pending.detail;
    if (this.#deps.unpark !== undefined) {
      try {
        await this.#deps.unpark.lift(officeId, {
          story: run.story,
          branch: run.branch,
          worktree: run.worktree,
          to: "In Progress",
        });
      } catch (error) {
        // The round waits again; the next drain tries the status commit again.
        this.#deps.warn?.("setting the story In Progress before its fix round failed", {
          run: run.runId,
          reason: messageOf(error),
        });
        return false;
      }
    }
    this.#write(office, () => inProgressEntries(office, run));
    await this.#deps.refreshStory?.(officeId, run.key).catch((error: unknown) => {
      this.#deps.warn?.("reading the story again before its fix round failed", {
        run: run.runId,
        reason: messageOf(error),
      });
    });
    const fresh = findRun(office, run.runId) ?? run;
    const view = this.#developerView(officeId, office, fresh);
    if (view === null) {
      this.#deps.warn?.("a fix round has no developer session to continue", { run: run.runId });
      return false;
    }
    const message = fixRoundMessage({
      head,
      items: feedbackOfIntent(office, run.runId, pending.intentId),
      advisories,
    });
    const box = this.#deps.boxRun?.(officeId, fresh) === true;
    const work = async (): Promise<boolean> =>
      await this.#deps.sessions.next(office, fresh, view, {
        // A box run's developer gets a new session in its box with the feedback as its task.
        mode: box ? "handoff" : "resume",
        why: `the feedback on ${head.slice(0, 12)}`,
        message,
      });
    const started =
      this.#deps.guard === undefined
        ? await work()
        : await this.#deps.guard.within(`${run.runId} fix-round`, work);
    if (started) {
      const at = this.#deps.clock.now();
      office.immediate(() => {
        markIntentSent(office, run.runId, pending.intentId, at, null);
        markFeedbackSent(office, run.runId, pending.intentId, at);
        resolveIntent(office, run.runId, pending.intentId, "started", at);
      });
    }
    return started;
  }

  /**
   * True when the run is a story run ended at In Review or after its review, with a live claim, no
   * open park and no session still running other than `exited`.
   */
  #waitsInReview(office: OfficeHandle, run: StoredRun, exited: string | undefined): boolean {
    if (run.kind !== "story" || run.key === null || run.worktree === null) return false;
    if (run.endedAt === null) return false;
    if (run.endKind !== REVIEWED_END && run.endKind !== IN_REVIEW_END) return false;
    const claim = findClaim(office, run.runId);
    if (claim === null || claim.releasedAt !== null) return false;
    if (openPark(office, run.key) !== null) return false;
    const live = office.get<{ found: number }>(
      `select 1 as found from agents where office_id = $office_id and run_id = $run
        and ended_at is null and agent_id is not $exited limit 1`,
      { run: run.runId, exited: exited ?? null },
    );
    return live === null;
  }

  /**
   * The CI of the run's pushed head: from the PR poll; `none` without a CI port or when the office
   * opens no story PRs; `pending` while the poll has not watched a head yet.
   */
  #ciOf(
    officeId: OfficeId,
    config: OfficeConfig,
    run: StoredRun,
  ): CiHeadState | { readonly kind: "none" | "pending"; readonly head: null } {
    if (this.#deps.ci === undefined || !config.storyPr.open) return { kind: "none", head: null };
    return this.#deps.ci(officeId, run.runId) ?? { kind: "pending", head: null };
  }

  /** In one serialized step of the office: the round queued, see the file comment. */
  async #queue(
    office: OfficeHandle,
    run: StoredRun,
    round: {
      readonly head: string;
      readonly items: readonly FixItem[];
      readonly advisories: readonly string[];
      /** Sent at once, not held to one round per head: a reject or a conflict (section 8). */
      readonly atOnce?: boolean;
    },
  ): Promise<boolean> {
    const officeId = office.officeId as OfficeId;
    const places = this.#deps.places();
    const step = async (): Promise<boolean> =>
      this.#writeWith(office, () => {
        const current = findRun(office, run.runId);
        const none = { value: false, entries: [] };
        if (current === null || current.endedAt === null) return none;
        // One round per head; a reject or a conflict is its own round, sent at once.
        if (round.atOnce !== true && fixRoundQueued(office, run.runId, round.head)) return none;
        const planned = planFeedback(office, run.runId, round.head, round.items);
        // Nothing new for this head: advisories never start a round on their own.
        if (planned.length === 0) return none;
        const at = this.#deps.clock.now();
        const same = sameFailureAgain(office, run.runId, planned);
        const number = nextFixRound(office, run.runId);
        const entries = reopenForRound(office, current, "fix", at);
        if (findRun(office, run.runId)?.endedAt !== null) return none;
        const detail: FixIntentDetail = { head: round.head, advisories: round.advisories };
        const intentId = recordIntent(
          office,
          run.runId,
          "steer",
          `${FIX_ROUND_TAG} ${JSON.stringify(detail)}`,
          at,
        );
        storeFeedbackItems(office, run.runId, {
          intentId,
          head: round.head,
          round: number,
          items: planned,
          at,
        });
        const observed: NewEntry[] = [];
        const work = workRefOf(office, run.runId);
        if (same) {
          const raised = raiseSignal(office, run.runId, "same-failure", at);
          if (raised !== null && work !== null) {
            observed.push({
              type: "work.observed",
              key: work.key,
              run: run.runId,
              delta: { work, signal: raised.signal, since: new Date(raised.since).toISOString() },
            });
          }
        }
        const story = run.story ?? run.runId;
        const repeats = planned.filter((item) => item.repeat).length;
        const notice: NewEntry = {
          type: "engine.notice",
          ...(run.key === null ? {} : { key: run.key }),
          run: run.runId,
          delta: {
            level: "info",
            code: FIX_NOTICES.queued,
            text: `${story}: dipo sends ${planned.length} feedback item${planned.length === 1 ? "" : "s"} on ${round.head.slice(0, 12)} back to its worker in fix round ${number}${repeats === 0 ? "" : ` (${repeats} still failing after the last change)`}; the round starts when the office's worker place is free.`,
          },
        };
        return { value: true, entries: [...entries, ...observed, notice] };
      });
    const queued = places === undefined ? await step() : await places.serialized(officeId, step);
    if (queued && places !== undefined) {
      // Started by the places when the worker place is free; a drain now starts it or arms the tick.
      const drained = places
        .drain(officeId)
        .catch((error: unknown) => {
          this.#deps.warn?.("starting a fix round failed", {
            run: run.runId,
            reason: messageOf(error),
          });
        })
        .finally(() => this.#inflight.delete(drained));
      this.#inflight.add(drained);
    }
    return queued;
  }

  /** The run's view with its newest developer agent, whose session the round continues. */
  #developerView(officeId: OfficeId, office: OfficeHandle, run: StoredRun): RunView | null {
    const view = this.#deps.view(officeId, office, run);
    if (view === null) return null;
    const developer = office.get<{ agent_id: string; model: string }>(
      `select agent_id, model from agents where office_id = $office_id and run_id = $run
        and role <> $reviewer order by started_at desc, rowid desc limit 1`,
      { run: run.runId, reviewer: REVIEWER_ROLE },
    );
    if (developer === null) return null;
    const work = {
      ...view.work,
      agent: developer.agent_id,
      role: RoleId.parse(run.role),
      model: developer.model,
    } as WorkRef;
    return { ...view, work };
  }

  #write(office: OfficeHandle, fn: () => readonly NewEntry[]): void {
    this.#writeWith(office, () => ({ value: undefined, entries: fn() }));
  }

  #writeWith<T>(
    office: OfficeHandle,
    fn: () => { readonly value: T; readonly entries: readonly NewEntry[] },
  ): T {
    const at = this.#deps.clock.now();
    const { value, appended } = office.immediate(() => {
      const out = fn();
      const entries = withWorkViews(office, out.entries);
      appendEntries(office, entries, { at });
      return { value: out.value, appended: entries.length };
    });
    if (appended > 0) this.#deps.onChanged?.(office.officeId as OfficeId);
    return value;
  }
}

/** The per-item budget of the run's tier (`prompt.budgets.feedbackItem`). */
function itemMaxOf(config: OfficeConfig, tier: string | null): number {
  const budgets = config.prompt.budgets.feedbackItem as Readonly<Record<string, number>>;
  return (tier === null ? undefined : budgets[tier]) ?? config.prompt.budgets.feedbackItem.M;
}

/** The story's `story.state` from In Review to In Progress, for the fix round's status commit. */
function inProgressEntries(office: OfficeHandle, run: StoredRun): NewEntry[] {
  const key = run.key as StoryKey;
  const current = storyView(office, key);
  if (current?.lifecycle === "In Progress") return [];
  const view = deriveStoryView({
    key,
    story: current?.story ?? StoryId.parse(run.story),
    title: current?.title ?? "",
    lifecycle: "In Progress",
    ...(current?.tier === undefined ? {} : { tier: current.tier }),
    ...(current?.pr === undefined ? {} : { pr: current.pr }),
  });
  return [
    {
      type: "story.state",
      key,
      run: run.runId,
      delta: {
        story: run.story as string,
        key,
        from: "In Review",
        to: "In Progress",
        view,
        detail: ["a fix round with the feedback on the pushed head"],
      },
    },
  ];
}
