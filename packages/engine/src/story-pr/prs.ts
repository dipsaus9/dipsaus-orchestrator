// The story PR (DIPO-144; 0019 section 3). Right after an In Review push the engine looks for an
// open PR with the story branch as head (`findOpenPr`, so a crash between push and create never
// opens a second one) and creates a ready PR, not a draft, when there is none. Every later In
// Review push updates the same PR: the title and body are rebuilt by code, and written to the host
// only when the title or the body's hash changed. The PR is recorded in `story_prs`, and
// `story.pr` is emitted when it opens, changes state or gets a new head.
//
// A failed create is a `pr.openFailed` notice, put once per cause; the story stays In Review. The
// PR poll runs every `polling.prStateSeconds` of the office configuration in force: it reads each
// PR still open on the host (`viewPr`), writes the state and close time of one merged or closed
// there and emits `story.pr` with the new state, then syncs each In Review run that has no PR yet.
// Work for one office runs one piece at a time, and `sync` never throws: whatever went wrong is
// the notice.
//
// A failed In Review push (DIPO-315). Each poll first pushes again, never forced, the branch of
// every run open at In Review waiting for its review whose claim's `pushed_at` is null or earlier
// than the run's end (`runsToPush`), since the review waits for the head on the remote
// (`pendingReviews`). A push that reaches the remote records `pushed_at` and syncs the PR
// at once (the PR is opened below when it has none); one that finds no remote records
// `no_remote_at`; a failure is a `pr.pushFailed` notice, once per cause, and is tried again.
// With the poll off (`polling.prStateSeconds` 0) nothing pushes again: each held run gets one
// `pr.pushHeld` notice saying why its review waits, at the load and at its failed push
// (`pushHeld`).
//
// CI on the story PR (DIPO-147; 0002). The same poll reads, for each open PR of a story still In
// Review or waiting for its merge, the required checks of the pushed head with one call, and only
// while the head's checks are not final: a final head is not read again until the head changes.
// The required checks are GitHub's: the names the base branch's protection and rulesets require
// (`AutoMergeHost.requiredCheckNames`, read once per head; a head whose list cannot be read waits),
// and every other check the host marks required. The PR itself is still read each interval, so a PR merged or closed on the host is
// seen. A head whose checks are not final after `merge.checksWaitMinutes` raises one
// `ci.stuck` notice and is read every 10 minutes from then on. A head with a failed required check
// is red once its checks are final (or the wait ran out): the engine lists every check of the
// head once, reads the failed Actions job logs, builds one CI feedback item per failed check,
// appends one `ci` run step for the head and, when the run's CI cap (snapshot plus `ciAttempt`
// grants) is reached, parks the story `verify-failing`. The items stay in memory
// for the fix round (`ciItems`, `ciState`), and each listener of `onCiFinal` is told when a head's
// CI stops being pending (red, green, no CI or stuck), so the fix round of DIPO-148 starts once
// both the verdict and the checks of that head are in; a story run in review holds no session
// place. The body's status block lists each required check with its state and is rewritten when
// one changes.
//
// CI is the final gate of a box run (0002): dipo ran the office's verify in the box at done
// (DIPO-346), so the body's status block says CI checks the head after it, and red CI takes the
// same loop as above.
// An office whose story PRs get no CI is not held waiting: when the host reports no check at all
// for a box run's pushed head (neither a required one nor any other) once `NO_CI_WAIT_MS` has
// passed since the engine first watched that head, the head is final with no CI. The wait is never
// shorter, whatever `merge.checksWaitMinutes` says, so a slow CI's late red check is still
// read. One `ci-none` run step records it on the run (not a CI attempt), a `ci.none` notice tells
// the maintainer, the body says no CI ran, and the review decides. A check that shows up for the
// head later is not read; a new head is watched again. A Mac run keeps its wait for unreported
// checks: its verify ran on the Mac.
//
// With the office's PR-state poll (`prState`, DIPO-314) the PR poll is the first part of each of
// its rounds instead of a timer of its own, and that pass reads each open PR through the reads the
// round gave it, so the auto-merge and the Done poll that follow get the same read. Every other
// read (a sync after an In Review push) goes to the host.

import type {
  Clock,
  CommandName,
  OfficeId,
  RunId,
  StoryKey,
  TimerHandle,
} from "@dipsaus-orchestrator/contract";

import { appendEntries, type NewEntry } from "../changelog/log";
import type { FeatureModule } from "../commands/registry";
import { OFFICE_DEFAULTS, type OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import type { Logger } from "../log/logger";
import type { PrStatePoll, PrStateReads } from "./pr-state";
import {
  type AutoMergeHost,
  type CodeHost,
  CodeHostError,
  type HostPr,
  type PrCheck,
  type PrReviewHost,
  type RequiredCheck,
  repoOfRemoteUrl,
} from "../platform/host";
import { type CiFeedbackItem, ciFeedback, FEEDBACK_LOG_LINES_DEFAULT } from "../prompts/feedback";
import { cutHead } from "../prompts/cut";
import { type EnvSecretsReader, officeEnvSecrets } from "../records/env-secrets";
import {
  findingCounts,
  latestVerdictOfRun,
  recordReviewCommentUrl,
  redactComment,
  reviewComment,
  reviewerEffort,
  type StoredReviewVerdict,
  uncommentedVerdicts,
} from "../review";
import { runConfigOf } from "../records/config-snapshot";
import { storedDoneReport } from "../run/done-report";
import { runBudgetFacts } from "../records/budget-line";
import { runCaps } from "../records/caps";
import { type ParkWriter, parkStory } from "../run/park";
import { type ParkStore, runHeldByPark } from "../records/park-state";
import {
  appendRunStep,
  findRun,
  openAtInReview,
  runRoundCounts,
  runSteps,
  type StoredRun,
} from "../records/run-records";
import { findStoryByKey } from "../stories/keys";
import { withWorkViews } from "../views/work";

import { type PrBodyReview, type PrBodyTest, storyPrBodyHash, storyPrBody } from "./body";
import { latestRecordedTest } from "../run/test-records";
import {
  checksFinal,
  evaluateChecks,
  requiredCheckStates,
  type RequiredCheckState,
} from "./checks";
import type { StoryPrGit } from "./git";
import {
  findStoryPr,
  insertStoryPr,
  noCiRan,
  openStoryPrs,
  pendingPrReplacements,
  replaceStoryPr,
  runParked,
  recordBranchPush,
  runsToPush,
  runsWithoutPr,
  type UnpushedRun,
  setStoryPrState,
  storyInReview,
  type StoryPrRecord,
  updateStoryPr,
} from "./records";
import { storyPrTitle } from "./title";

/** `engine.notice` codes of the story PR. */
export const STORY_PR_NOTICES = {
  opened: "pr.opened",
  openFailed: "pr.openFailed",
  ciStuck: "ci.stuck",
  ciNone: "ci.none",
  commentFailed: "pr.commentFailed",
  pushedAgain: "pr.pushedAgain",
  pushFailed: "pr.pushFailed",
  pushHeld: "pr.pushHeld",
} as const;

/**
 * How long a box run's pushed head may show no check at all before it counts as having no CI
 * (DIPO-299). GitHub lists a workflow's checks as pending when it queues the run, within about a
 * minute of the push; ten minutes covers a slow queue and still never holds a story for long.
 */
export const NO_CI_WAIT_MS = 10 * 60_000;

/** How often a head whose checks are stuck is read (0019 section 7). */
export const CI_STUCK_POLL_MS = 10 * 60_000;

/** The load step's name in the registry. */
export const STORY_PR_STEP = "story-pr.poll";

export interface StoryPrsDeps {
  /** The story store: the park a pending planning change writes (`plannedPark`, 0010). */
  readonly stories: ParkStore;
  readonly host: CodeHost;
  readonly git: StoryPrGit;
  /** The loaded offices and the configuration in force for each next interval. */
  readonly offices: {
    get(office: OfficeId): OfficeHandle | undefined;
    config(office: OfficeId): OfficeConfig | undefined;
  };
  readonly clock: Clock;
  readonly onChanged?: (office: OfficeId) => void;
  readonly logger?: Logger;
  /**
   * What the CI feedback reads on the host (every check of a head, failed job logs). Without it a
   * failed check becomes an item with its name only.
   */
  readonly review?: PrReviewHost;
  /** What a red head at the CI cap parks through; without it that story is not parked. */
  readonly park?: {
    readonly writer: ParkWriter;
    readonly implemented: (name: CommandName) => boolean;
  };
  /**
   * Whether the run's developer works in a box (DIPO-299): CI is its final gate, and its head may
   * be final with no CI. False for every run without it.
   */
  readonly boxRun?: (office: OfficeId, run: StoredRun) => boolean;
  /** True when dipo turns auto-merge on for story PRs: the body says dipo merges. */
  readonly mergesStories?: boolean;
  /**
   * The names of the checks the base branch requires on GitHub (0002). Without it only the checks
   * the host reports as required count (tests).
   */
  readonly required?: Pick<AutoMergeHost, "requiredCheckNames">;
  /** The office's main checkout, where its env files are read; undefined when it is not known. */
  readonly checkout: (office: OfficeId) => string | undefined;
  /**
   * Reads the values of the office's env files for the review comments (DIPO-152); the files of
   * `readEnvSecrets` by default. It throws when a file cannot be read.
   */
  readonly secrets?: EnvSecretsReader;
  /**
   * The office's one PR-state poll (DIPO-314): the PR poll runs as the first part of its rounds,
   * not on a timer of its own, and reads each open PR through it. Without it the PR poll keeps its
   * own timer and reads the host.
   */
  readonly prState?: Pick<PrStatePoll, "subscribe">;
}

/** What the poll knows of the pushed head of one story PR. */
interface Watch {
  readonly head: string;
  /** When the engine first saw this head's checks unfinished. */
  readonly since: number;
  /** The checks are final and handled: not read again until the head changes. */
  final: boolean;
  stuck: boolean;
  /** Earliest next read of a stuck head. */
  nextAt: number;
  /** The checks the base requires, read once for the head; null before that read. */
  names: readonly string[] | null;
  /** The last states written to the body. */
  states: string;
  /** The reports the body is built from. */
  reports: readonly RequiredCheck[];
  items: readonly CiFeedbackItem[] | null;
  /** The failed park of this head was already warned about. */
  parkWarned: boolean;
  /** The host reported no check for this box run's head: final with no CI (DIPO-299). */
  noCi: boolean;
  /** A required check failed while others still run: not final, but it cannot pass (DIPO-382). */
  failing: boolean;
}

interface Polled {
  readonly office: OfficeHandle;
  readonly clock: Clock;
  timer: TimerHandle | null;
  busy: Promise<unknown>;
  /** The failure last noticed for each run, so a retry that fails the same way is silent. */
  readonly told: Map<string, string>;
  /** The CI watch of each run's pushed head. */
  readonly watch: Map<string, Watch>;
  /** The review state last written to each run's PR body, so a new verdict rewrites it. */
  readonly reviewed: Map<string, string>;
  /** The reads of the PR-state round the running pass belongs to (DIPO-314), or null. */
  reads: Pick<PrStateReads, "viewPr"> | null;
}

/** Where the CI of a run's pushed head stands (`StoryPrs.ciState`, DIPO-148). */
export type CiHeadState =
  | { readonly kind: "pending" | "failing" | "stuck" | "green" | "none"; readonly head: string }
  | { readonly kind: "red"; readonly head: string; readonly items: readonly CiFeedbackItem[] };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class StoryPrs {
  readonly #deps: StoryPrsDeps;
  readonly #offices = new Map<OfficeId, Polled>();
  readonly #listeners: ((office: OfficeId, runId: RunId) => void)[] = [];
  #stopped = false;

  constructor(deps: StoryPrsDeps) {
    this.#deps = deps;
    deps.prState?.subscribe("story-pr", (office, reads) =>
      this.#offices.has(office) ? this.retry(office, reads) : Promise.resolve([]),
    );
  }

  /** How the PR poll reads a PR: through the PR-state round its pass runs in, else the host. */
  #reads(state: Polled): Pick<PrStateReads, "viewPr"> {
    return state.reads ?? this.#deps.host;
  }

  /** The feature module that adds the load step arming the retry poll. */
  get feature(): FeatureModule {
    return {
      name: "story-pr",
      register: (registry) => {
        registry.registerLoadStep(STORY_PR_STEP, (ctx) => {
          this.track(ctx.officeId, ctx.office, ctx.clock);
          this.#schedule(ctx.officeId, ctx.config);
          return { ok: true };
        });
      },
    };
  }

  /** Tracks a loaded office without arming its poll. */
  track(officeId: OfficeId, office: OfficeHandle, clock: Clock): void {
    const existing = this.#offices.get(officeId);
    if (existing !== undefined && existing.office === office) return;
    if (existing !== undefined) this.#cancel(existing);
    this.#offices.set(officeId, {
      office,
      clock,
      timer: null,
      busy: Promise.resolve(),
      told: new Map(),
      watch: new Map(),
      reviewed: new Map(),
      reads: null,
    });
  }

  /** Stops every poll; a sync already running finishes. */
  stop(): void {
    this.#stopped = true;
    for (const state of this.#offices.values()) this.#cancel(state);
  }

  /** Opens or updates the PR of a run right after its In Review push. */
  sync(officeId: OfficeId, runId: RunId): Promise<void> {
    const state = this.#state(officeId);
    return this.#serial(state, () => this.#sync(officeId, state, runId));
  }

  /**
   * One pass of the PR poll: reads the state of each PR still open on the host, then syncs each In
   * Review run that has no PR yet. Returns the runs whose PR it tried to open. With `reads` (a
   * PR-state round, DIPO-314) the pass reads each open PR through them.
   */
  retry(officeId: OfficeId, reads?: Pick<PrStateReads, "viewPr">): Promise<RunId[]> {
    const state = this.#state(officeId);
    return this.#serial(state, async () => {
      state.reads = reads ?? null;
      try {
        return await this.#retry(officeId, state);
      } finally {
        state.reads = null;
      }
    });
  }

  async #retry(officeId: OfficeId, state: Polled): Promise<RunId[]> {
    // The In Review pushes that did not reach the remote first (DIPO-315).
    await this.#pushAgain(officeId, state);
    for (const stored of openStoryPrs(state.office)) {
      await this.#poll(officeId, state, stored);
      await this.#reviewStep(officeId, state, stored.runId);
    }
    const tried: RunId[] = [];
    for (const { runId } of runsWithoutPr(state.office)) {
      tried.push(runId);
      await this.#sync(officeId, state, runId);
    }
    // A replacement of a closed PR whose create failed is tried again (DIPO-324).
    for (const runId of pendingPrReplacements(state.office)) {
      tried.push(runId);
      await this.#replace(officeId, state, runId);
    }
    return tried;
  }

  /**
   * DIPO-155's `PrReplacement` (DIPO-324; 0002, a PR closed on GitHub): the run's story
   * PR that was closed on the host without a merge is replaced by a new one for the branch's
   * head, whose body names the closed one ("Replaces #n"); the run's record then holds the new PR,
   * with `replaces`. A PR still open on the host is only updated, and a merged one is the Done
   * poll's. A create that fails is the usual `pr.openFailed` notice, and the PR poll tries again
   * (`pendingPrReplacements`).
   */
  replace(officeId: OfficeId, runId: RunId): Promise<void> {
    const state = this.#state(officeId);
    return this.#serial(state, () => this.#replace(officeId, state, runId));
  }

  async #replace(officeId: OfficeId, state: Polled, runId: RunId): Promise<void> {
    const stored = findStoryPr(state.office, runId);
    if (stored === null) return this.#sync(officeId, state, runId);
    if (stored.state === "merged") return;
    // The host decides: the auto-merge poll parks on its state, which the poll may not have recorded,
    // and the maintainer may have reopened the closed PR before resuming.
    const repo = repoOfPrUrl(stored.url);
    const viewed =
      repo === null ? null : await this.#deps.host.viewPr(repo, stored.number).catch(() => null);
    if (viewed?.state === "merged") return;
    if (viewed?.state === "open") {
      // Reopened (or never closed): the same PR, updated, never its own replacement.
      if (stored.state !== "open") {
        const story = findRun(state.office, runId)?.story ?? runId;
        this.#write(officeId, state, () => {
          setStoryPrState(state.office, runId, { state: "open", closedAt: null });
          return [prEntry({ ...stored, state: "open", closedAt: null }, story)];
        });
      }
      return this.#sync(officeId, state, runId);
    }
    const closed = viewed?.state === "closed" || (viewed === null && stored.state === "closed");
    await this.#sync(officeId, state, runId, closed ? stored : undefined);
  }

  /**
   * Where the CI of a run's pushed head stands now (DIPO-148's fix-round timing): `pending` while
   * its required checks are not final, `failing` while one already failed and others still run
   * (DIPO-382: the head cannot pass, so a merge gate decided by rule does not close out on it, and
   * a fix round still waits for the final checks), `stuck` once they are past the wait cap, `red` with the CI
   * items once a failed head was handled, `green` once they passed, `none` for a box run's head
   * the host reported no check for (`noCiRan`). Null before the poll watched any head of the run.
   */
  ciState(officeId: OfficeId, runId: RunId): CiHeadState | null {
    const watch = this.#offices.get(officeId)?.watch.get(runId);
    if (watch === undefined) return null;
    const head = watch.head;
    if (watch.noCi) return { kind: "none", head };
    if (watch.items !== null) return { kind: "red", head, items: watch.items };
    if (watch.final) return { kind: "green", head };
    if (watch.failing) return { kind: "failing", head };
    if (watch.stuck) return { kind: "stuck", head };
    return { kind: "pending", head };
  }

  /**
   * Calls `listener` each time the CI of a run's pushed head stops being pending (`ciState`): a
   * fix round waits for that (DIPO-148). A listener that throws is logged.
   */
  onCiFinal(listener: (office: OfficeId, runId: RunId) => void): void {
    this.#listeners.push(listener);
  }

  /**
   * The review part of the poll for one open PR (0019 section 3): posts the comment of each
   * verdict that has none, oldest first, and rewrites the body when the latest verdict changed
   * (or an override was recorded). Nothing here is awaited by the gate, a fix round or a merge: the
   * poll runs apart from them, and a failure is a notice and the next poll's retry.
   */
  async #reviewStep(officeId: OfficeId, state: Polled, runId: RunId): Promise<void> {
    const stored = findStoryPr(state.office, runId);
    if (stored === null || stored.state !== "open") return;
    try {
      await this.#comments(officeId, state, stored);
    } catch (error) {
      this.#deps.logger?.warn("posting the review comments failed", {
        office: officeId,
        run: runId,
        reason: messageOf(error),
      });
    }
    const key = reviewKey(latestVerdictOfRun(state.office, runId));
    if (state.reviewed.get(runId) !== key) await this.#sync(officeId, state, runId);
  }

  /**
   * Posts one comment per verdict without a comment URL, built by code, with every value of the
   * copied env files redacted after the size cap. A verdict whose comment cannot be built or
   * posted raises `pr.commentFailed` once per cause and waits for the next poll; the comments
   * after it wait too, so they stay in round order. A posted comment is never edited.
   */
  async #comments(officeId: OfficeId, state: Polled, stored: StoryPrRecord): Promise<void> {
    const review = this.#deps.review;
    if (review === undefined) return;
    const office = state.office;
    const repo = repoOfPrUrl(stored.url);
    const run = findRun(office, stored.runId);
    if (repo === null || run === null) return;
    for (const verdict of uncommentedVerdicts(office, stored.runId)) {
      const told = `comment:${verdict.gate}`;
      let body: string;
      try {
        const secrets = officeEnvSecrets(
          this.#deps.checkout(officeId),
          this.#config(officeId).box.files ?? [],
          this.#deps.secrets,
        );
        body = redactComment(
          reviewComment(verdict, { effort: reviewerEffort(office, verdict.agent) }),
          secrets,
        );
      } catch (error) {
        this.#commentFailed(
          officeId,
          state,
          stored,
          verdict,
          told,
          `the comment was held back: ${messageOf(error)}`,
        );
        return;
      }
      let url: string;
      try {
        url = await review.commentPr(repo, stored.number, body);
      } catch (error) {
        this.#commentFailed(officeId, state, stored, verdict, told, messageOf(error));
        return;
      }
      state.told.delete(told);
      state.office.immediate(() => recordReviewCommentUrl(office, verdict.gate, url));
    }
  }

  #commentFailed(
    officeId: OfficeId,
    state: Polled,
    stored: StoryPrRecord,
    verdict: StoredReviewVerdict,
    told: string,
    reason: string,
  ): void {
    this.#deps.logger?.warn("posting the review comment failed", {
      office: officeId,
      run: stored.runId,
      reason,
    });
    if (state.told.get(told) === reason) return;
    state.told.set(told, reason);
    this.#write(officeId, state, () => [
      notice(
        "warn",
        STORY_PR_NOTICES.commentFailed,
        `dipo could not post the review comment of round ${verdict.round} on the PR for ${stored.key}: ${reason}. dipo tries again at the next poll; the review itself is not held.`,
        stored.key,
        stored.runId,
      ),
    ]);
  }

  /** The CI feedback items built for the red head of a run, or none (DIPO-148 sends them). */
  ciItems(
    officeId: OfficeId,
    runId: RunId,
  ): { head: string; items: readonly CiFeedbackItem[] } | null {
    const watch = this.#offices.get(officeId)?.watch.get(runId);
    return watch?.items == null ? null : { head: watch.head, items: watch.items };
  }

  #config(officeId: OfficeId): OfficeConfig {
    return this.#deps.offices.config(officeId) ?? OFFICE_DEFAULTS;
  }

  /**
   * The configuration the run started with (the DIPO-303 review): its snapshot laid on the
   * configuration in force, which a run without a snapshot reads alone.
   */
  #runConfig(officeId: OfficeId, run: StoredRun): OfficeConfig {
    const office = this.#offices.get(officeId)?.office ?? this.#deps.offices.get(officeId);
    return office === undefined
      ? this.#config(officeId)
      : runConfigOf(office, run, this.#config(officeId));
  }

  /**
   * A run's In Review push failed (DIPO-315, from verify and commit): with the office's PR poll off
   * nothing pushes it again, so its held review gets one `pr.pushHeld` notice saying why. With the
   * poll on, the poll pushes it and says nothing here.
   */
  pushHeld(officeId: OfficeId, runId: RunId): void {
    const config = this.#deps.offices.config(officeId) ?? OFFICE_DEFAULTS;
    if (config.polling.prStateSeconds > 0) return;
    const state = this.#offices.get(officeId) ?? this.#state(officeId);
    const run = findRun(state.office, runId);
    if (run === null || run.key === null || run.branch === null) return;
    this.#heldNotice(officeId, state, { runId, key: run.key, branch: run.branch });
  }

  /** One `pr.pushHeld` notice per run while this daemon runs (DIPO-315). */
  #heldNotice(officeId: OfficeId, state: Polled, run: UnpushedRun): void {
    const told = `held:${run.runId}`;
    if (state.told.has(told)) return;
    state.told.set(told, "held");
    const story = findRun(state.office, run.runId)?.story ?? run.runId;
    this.#write(officeId, state, () => [
      notice(
        "warn",
        STORY_PR_NOTICES.pushHeld,
        `${story} is In Review, but its review waits: its In Review push did not reach the remote, and dipo pushes ${run.branch} again only from the PR poll, which is off (polling.prStateSeconds is 0). Set polling.prStateSeconds above 0 so dipo pushes it again and the review starts.`,
        run.key,
        run.runId,
      ),
    ]);
  }

  /**
   * Pushes again, never forced, each run whose In Review head may not be on the remote (DIPO-315),
   * and records what the push did on its claim.
   */
  async #pushAgain(officeId: OfficeId, state: Polled): Promise<void> {
    const git = this.#deps.git;
    if (git.push === undefined) return;
    const push = git.push.bind(git);
    for (const unpushed of runsToPush(state.office)) {
      const run = findRun(state.office, unpushed.runId);
      if (run === null) continue;
      const story = run.story ?? unpushed.runId;
      const told = `push:${unpushed.runId}`;
      const result = await push(officeId, unpushed.branch).catch((error: unknown) => ({
        pushed: false,
        rejected: false,
        error: messageOf(error),
      }));
      if (result.error !== null) {
        this.#deps.logger?.warn("pushing a story branch again failed", {
          office: officeId,
          run: unpushed.runId,
          reason: result.error,
        });
        if (state.told.get(told) === result.error) continue;
        state.told.set(told, result.error);
        const why = result.rejected
          ? `${result.error}; the remote branch has commits the story branch lacks, so dipo never forces it: bring the branch up to date by hand`
          : result.error;
        this.#write(officeId, state, () => [
          notice(
            "warn",
            STORY_PR_NOTICES.pushFailed,
            `${story} is In Review, but dipo could not push ${unpushed.branch} again: ${why}. Its review waits until the head is on the remote; dipo tries again.`,
            unpushed.key,
            unpushed.runId,
          ),
        ]);
        continue;
      }
      state.told.delete(told);
      const at = this.#deps.clock.now();
      this.#write(officeId, state, () => {
        recordBranchPush(state.office, unpushed.branch, result, at);
        return result.pushed
          ? [
              notice(
                "info",
                STORY_PR_NOTICES.pushedAgain,
                `dipo pushed ${unpushed.branch} of ${story} again: its In Review push had not reached the remote. Its review and CI start on that head.`,
                unpushed.key,
                unpushed.runId,
              ),
            ]
          : [];
      });
      // A PR that exists follows the pushed head now; one still to open is opened below.
      if (result.pushed && findStoryPr(state.office, unpushed.runId) !== null) {
        await this.#sync(officeId, state, unpushed.runId);
      }
    }
  }

  /** Opens or updates the run's PR; with `replacing`, opens a new one in place of that closed PR. */
  async #sync(
    officeId: OfficeId,
    state: Polled,
    runId: RunId,
    replacing?: StoryPrRecord,
  ): Promise<void> {
    const office = state.office;
    const run = findRun(office, runId);
    if (run === null || run.key === null || run.branch === null) return;
    const key = run.key;
    try {
      const facts = await this.#deps.git.read(officeId, {
        branch: run.branch,
        story: run.story as string,
      });
      const repo = facts.remoteUrl === null ? null : repoOfRemoteUrl(facts.remoteUrl);
      if (repo === null) {
        throw new Error(
          `the remote (${facts.remoteUrl ?? "no URL"}) is not a GitHub repository dipo can open a PR on`,
        );
      }
      const title = storyPrTitle(facts.story);
      const watch = state.watch.get(runId);
      const checks = requiredCheckStates(
        watch?.head === facts.head ? watch.reports : [],
        watch?.head === facts.head ? (watch.names ?? []) : [],
      );
      const box = this.#deps.boxRun?.(officeId, run) === true;
      const reviewed = latestVerdictOfRun(office, runId);
      state.reviewed.set(runId, reviewKey(reviewed));
      const stored = findStoryPr(office, runId);
      const replaces = replacing?.number ?? stored?.replaces ?? null;
      const body = storyPrBody(
        { ...facts.story, doneReport: storedDoneReport(office, runId) },
        {
          head: facts.head,
          checks,
          review: reviewed === null ? null : reviewOfVerdict(reviewed),
          ...(box ? { verify: "ci" as const } : {}),
          ...(this.#deps.mergesStories === true ? { merge: "dipo" as const } : {}),
          ...(box && noCiRan(office, runId, facts.head) ? { noCi: true } : {}),
          ...(replaces === null ? {} : { replaces }),
          ...testOfRun(office, runId),
        },
      );
      const hash = storyPrBodyHash(body);
      if (stored === null || replacing !== undefined) {
        await this.#open(officeId, state, {
          runId,
          story: run.story as string,
          key,
          repo,
          branch: run.branch,
          facts,
          title,
          body,
          hash,
          ...(replacing === undefined ? {} : { replaces: replacing.number }),
        });
      } else if (stored.state === "open") {
        await this.#update(officeId, state, {
          stored,
          story: run.story as string,
          repo,
          head: facts.head,
          title,
          body,
          hash,
        });
      }
      state.told.delete(runId);
    } catch (error) {
      this.#failed(officeId, state, runId, key, error);
    }
  }

  async #open(
    officeId: OfficeId,
    state: Polled,
    input: {
      runId: RunId;
      story: string;
      key: StoryKey;
      repo: string;
      branch: string;
      facts: { head: string; base: string };
      title: string;
      body: string;
      hash: string;
      /** The closed PR of the run the new one replaces (DIPO-324). */
      replaces?: number;
    },
  ): Promise<void> {
    const host = this.#deps.host;
    let pr: HostPr | null = await host.findOpenPr(input.repo, input.branch);
    if (pr !== null && pr.number === input.replaces) {
      // The closed PR is open again on the host: it is the run's PR, never its own replacement.
      // Its record is open with no stored body, so the next sync writes the body it should have.
      this.#write(officeId, state, () => {
        setStoryPrState(state.office, input.runId, { state: "open", closedAt: null });
        updateStoryPr(state.office, input.runId, {
          headSha: input.facts.head,
          title: input.title,
          bodyHash: "",
        });
        return [];
      });
      return;
    }
    // An open PR a crash left: what it holds is not known to match, so it is written once.
    if (pr !== null) {
      await host.updatePr(input.repo, pr.number, { title: input.title, body: input.body });
    }
    pr ??= await host.createPr(input.repo, {
      base: input.facts.base,
      head: input.branch,
      title: input.title,
      body: input.body,
    });
    const opened = pr;
    const record: StoryPrRecord = {
      runId: input.runId,
      key: input.key,
      number: opened.number,
      url: opened.url,
      branch: input.branch,
      base: opened.base === "" ? input.facts.base : opened.base,
      headSha: input.facts.head,
      state: "open",
      title: input.title,
      bodyHash: input.hash,
      openedAt: this.#deps.clock.now(),
      closedAt: null,
      replaces: input.replaces ?? null,
    };
    this.#write(officeId, state, () => {
      if (input.replaces === undefined) insertStoryPr(state.office, record);
      else replaceStoryPr(state.office, record);
      return [
        prEntry(record, input.story),
        notice(
          "info",
          STORY_PR_NOTICES.opened,
          input.replaces === undefined
            ? `dipo opened PR #${record.number} for ${input.key}: ${record.url}`
            : `dipo opened PR #${record.number} for ${input.key} in place of PR #${input.replaces}, which was closed on the host: ${record.url}`,
          input.key,
          input.runId,
        ),
      ];
    });
  }

  async #update(
    officeId: OfficeId,
    state: Polled,
    input: {
      stored: StoryPrRecord;
      story: string;
      repo: string;
      head: string;
      title: string;
      body: string;
      hash: string;
    },
  ): Promise<void> {
    const { stored } = input;
    if (stored.title !== input.title || stored.bodyHash !== input.hash) {
      await this.#deps.host.updatePr(input.repo, stored.number, {
        title: input.title,
        body: input.body,
      });
    }
    if (
      stored.title === input.title &&
      stored.bodyHash === input.hash &&
      stored.headSha === input.head
    ) {
      return;
    }
    const next: StoryPrRecord = {
      ...stored,
      headSha: input.head,
      title: input.title,
      bodyHash: input.hash,
    };
    this.#write(officeId, state, () => {
      updateStoryPr(state.office, stored.runId, {
        headSha: input.head,
        title: input.title,
        bodyHash: input.hash,
      });
      // A new head is a change `story.pr` reports; a new body on the same head is not.
      return stored.headSha === input.head ? [] : [prEntry(next, input.story)];
    });
  }

  /**
   * Reads one open PR on the host (`viewPr`). A PR merged or closed there gets its state and close
   * time written and one `story.pr` with the new state; an open PR goes on to the CI watch. A failed read is
   * logged and the next poll reads again.
   */
  async #poll(officeId: OfficeId, state: Polled, stored: StoryPrRecord): Promise<void> {
    const repo = repoOfPrUrl(stored.url);
    if (repo === null) {
      this.#deps.logger?.warn("the story PR URL names no repository", {
        office: officeId,
        run: stored.runId,
        url: stored.url,
      });
      return;
    }
    let viewed: HostPr;
    try {
      viewed = await this.#reads(state).viewPr(repo, stored.number);
    } catch (error) {
      this.#deps.logger?.warn("reading the story PR failed", {
        office: officeId,
        run: stored.runId,
        reason: messageOf(error),
      });
      return;
    }
    const hostState = viewed.state;
    if (hostState === stored.state) {
      if (hostState === "open")
        await this.#watchAndTell(officeId, state, stored, repo, viewed.headSha);
      return;
    }
    const closedAt = hostState === "open" ? null : this.#deps.clock.now();
    // The head that merged, as the host reports it (DIPO-332): the Done poll compares the local
    // branch with it when the host gives no answer.
    const headSha =
      hostState === "merged" && /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(viewed.headSha)
        ? viewed.headSha
        : stored.headSha;
    const next: StoryPrRecord = { ...stored, state: hostState, closedAt, headSha };
    const story = findStoryByKey(state.office, stored.key)?.story;
    this.#write(officeId, state, () => {
      setStoryPrState(state.office, stored.runId, { state: hostState, closedAt });
      if (headSha !== stored.headSha) {
        updateStoryPr(state.office, stored.runId, {
          headSha,
          title: stored.title,
          bodyHash: stored.bodyHash,
        });
      }
      return story === undefined ? [] : [prEntry(next, story)];
    });
  }

  /**
   * `#watch`, then each listener told when the head's CI stopped being pending in this pass, or
   * after a restart rebuilt a watch that is already past it.
   */
  async #watchAndTell(
    officeId: OfficeId,
    state: Polled,
    stored: StoryPrRecord,
    repo: string,
    hostHead: string,
  ): Promise<void> {
    const before = this.ciState(officeId, stored.runId);
    await this.#watch(officeId, state, stored, repo, hostHead);
    const after = this.ciState(officeId, stored.runId);
    if (after === null || after.kind === "pending") return;
    if (before !== null && before.kind === after.kind && before.head === after.head) return;
    for (const listener of this.#listeners) {
      try {
        listener(officeId, stored.runId);
      } catch (error) {
        this.#deps.logger?.warn("a CI listener failed", {
          office: officeId,
          run: stored.runId,
          reason: messageOf(error),
        });
      }
    }
  }

  /**
   * The CI watch of one open PR (0019 section 7): reads the required checks of the pushed head
   * unless they are final or the head is stuck and not due, rewrites the body when a check's
   * state changed, raises `ci.stuck` once, and handles a red head. A failed read is logged and the
   * next poll reads again.
   */
  async #watch(
    officeId: OfficeId,
    state: Polled,
    stored: StoryPrRecord,
    repo: string,
    hostHead: string,
  ): Promise<void> {
    const office = state.office;
    const run = findRun(office, stored.runId);
    // A story dipo closed out is Done on its branch until GitHub merges it, and still watched.
    if (run === null) return;
    if (!storyInReview(office, stored.key) && !waitsForMerge(this.#deps.stories, office, run))
      return;
    const config = this.#runConfig(officeId, run);
    const now = this.#deps.clock.now();
    let watch = state.watch.get(stored.runId);
    if (watch?.head !== stored.headSha) {
      watch = {
        head: stored.headSha,
        since: now,
        final: false,
        stuck: false,
        nextAt: 0,
        names: null,
        states: "",
        reports: [],
        items: null,
        parkWarned: false,
        noCi: false,
        failing: false,
      };
      state.watch.set(stored.runId, watch);
    }
    if (watch.final || now < watch.nextAt) return;
    const box = this.#deps.boxRun?.(officeId, run) === true;
    // A box run's head recorded without CI (before a daemon restart) waits for nothing.
    if (box && noCiRan(office, run.runId, stored.headSha)) {
      watch.final = true;
      watch.noCi = true;
      return;
    }
    // Checks the host reports for another head than the one the engine pushed do not count.
    const onHead = hostHead === "" || hostHead === stored.headSha;
    const [names, reports] = await Promise.all([
      this.#requiredNames(officeId, watch, stored, repo),
      onHead ? this.#reports(officeId, stored, repo) : Promise.resolve([]),
    ]);
    if (names === null || reports === null) return;
    watch.reports = reports;
    if (
      box &&
      onHead &&
      reports.length === 0 &&
      now - watch.since >= NO_CI_WAIT_MS &&
      (await this.#noChecks(officeId, stored, repo))
    ) {
      this.#noCi(officeId, state, stored, run);
      watch.final = true;
      watch.noCi = true;
      await this.#sync(officeId, state, stored.runId);
      return;
    }
    const states = JSON.stringify(requiredCheckStates(reports, names));
    if (states !== watch.states) {
      watch.states = states;
      await this.#sync(officeId, state, stored.runId);
    }
    // A base that requires no check, with no check reported, has not shown its CI yet: nothing is
    // final then, so a head is never green before CI starts. A box run's head with no check at all
    // is decided by the no-CI wait above.
    const unknown = names.length === 0 && reports.length === 0;
    const verdict = unknown
      ? ({ state: "pending", waiting: [] } as const)
      : evaluateChecks(reports, names);
    const final = !unknown && checksFinal(reports, names);
    const waited = now - watch.since >= config.merge.checksWaitMinutes * 60_000;
    if (!final && waited) {
      if (!watch.stuck) {
        watch.stuck = true;
        this.#write(officeId, state, () => [
          notice(
            "warn",
            STORY_PR_NOTICES.ciStuck,
            `The required checks of the PR for ${stored.key} are still not final after ${config.merge.checksWaitMinutes} minutes (waiting for: ${waitingFor(reports, names).join(", ") || "any check to be reported"}). dipo keeps watching, now every 10 minutes.`,
            stored.key,
            stored.runId,
          ),
        ]);
      }
      watch.nextAt = now + CI_STUCK_POLL_MS;
    }
    if (verdict.state === "passed") watch.final = true;
    watch.failing = verdict.state === "failed";
    if (verdict.state === "failed" && (final || waited)) {
      // A park that failed leaves the head open, so the next poll tries the park again.
      watch.final = await this.#red(officeId, state, run, stored, repo, reports);
    }
  }

  /** The required checks the host reports for the PR's head; null when the read failed (logged). */
  async #reports(
    officeId: OfficeId,
    stored: StoryPrRecord,
    repo: string,
  ): Promise<RequiredCheck[] | null> {
    try {
      return await this.#deps.host.requiredChecks(repo, stored.number);
    } catch (error) {
      this.#deps.logger?.warn("reading the checks of the story PR failed", {
        office: officeId,
        run: stored.runId,
        reason: messageOf(error),
      });
      return null;
    }
  }

  /**
   * The checks the base requires on GitHub, read once per watched head; null when the read failed
   * (logged), so the head waits for the next poll.
   */
  async #requiredNames(
    officeId: OfficeId,
    watch: Watch,
    stored: StoryPrRecord,
    repo: string,
  ): Promise<readonly string[] | null> {
    if (watch.names !== null) return watch.names;
    const required = this.#deps.required;
    try {
      watch.names =
        required === undefined ? [] : await required.requiredCheckNames(repo, stored.base);
    } catch (error) {
      this.#deps.logger?.warn("reading the base's required checks failed", {
        office: officeId,
        run: stored.runId,
        reason: messageOf(error),
      });
      return null;
    }
    return watch.names;
  }

  /**
   * A red head: builds its CI items (one log read per failed check, once per head per poller, so again after a restart), appends the
   * head's `ci` step unless an earlier poll did, and parks the story `verify-failing`
   * when the run's CI cap is reached. False when that park failed, so the head stays open.
   */
  async #red(
    officeId: OfficeId,
    state: Polled,
    run: StoredRun,
    stored: StoryPrRecord,
    repo: string,
    reports: readonly RequiredCheck[],
  ): Promise<boolean> {
    const office = state.office;
    const watch = state.watch.get(run.runId) as Watch;
    const recorded = runSteps(office, run.runId).some(
      (step) => step.kind === "ci" && step.value === stored.headSha,
    );
    // After a restart the step is recorded but the items are gone: rebuild them, append no step.
    if (watch.items === null) {
      watch.items = await this.#ciItems(officeId, run, stored, repo, reports);
    }
    if (!recorded) {
      this.#write(officeId, state, () => {
        appendRunStep(office, run.runId, "ci", stored.headSha, this.#deps.clock.now());
        return [];
      });
    }
    const cap = runCaps(office, run).ciCap;
    const attempts = runRoundCounts(office, run.runId).ciAttempts;
    if (cap === null || attempts < cap || runParked(office, run.runId)) return true;
    const park = this.#deps.park;
    if (park === undefined) return true;
    const items = (watch.items ?? []).map((item) => item.text).join("\n\n");
    const detail = `required checks were red on ${attempts} pushed heads (the CI cap is ${cap}).${
      items === "" ? "" : ` ${cutHead(items, CI_DETAIL_MAX, cutMarker).text}`
    }`;
    try {
      await parkStory(
        {
          office,
          writer: park.writer,
          now: () => this.#deps.clock.now(),
          write: (fn) => this.#write(officeId, state, () => withWorkViews(office, fn())),
          implemented: park.implemented,
        },
        {
          run,
          reason: "verify-failing",
          detail,
        },
      );
      return true;
    } catch (error) {
      // One warn per head and run; the retries of the next polls log at debug.
      const log = watch.parkWarned ? "debug" : "warn";
      watch.parkWarned = true;
      this.#deps.logger?.[log]("parking the story on red checks failed", {
        office: officeId,
        run: run.runId,
        reason: messageOf(error),
      });
      return false;
    }
  }

  /**
   * True when the host lists no check at all for the PR's head, required or not (DIPO-299). Without
   * the review host only the empty required list is known; a failed list is logged and counts as
   * not known, so the next poll asks again.
   */
  async #noChecks(officeId: OfficeId, stored: StoryPrRecord, repo: string): Promise<boolean> {
    const review = this.#deps.review;
    if (review === undefined) return true;
    try {
      return (await review.prChecks(repo, stored.number)).length === 0;
    } catch (error) {
      this.#deps.logger?.warn("listing the checks of the story PR failed", {
        office: officeId,
        run: stored.runId,
        reason: messageOf(error),
      });
      return false;
    }
  }

  /** Records on the run that no CI ran for the box run's pushed head, once, with its notice. */
  #noCi(officeId: OfficeId, state: Polled, stored: StoryPrRecord, run: StoredRun): void {
    const office = state.office;
    const minutes = NO_CI_WAIT_MS / 60_000;
    this.#write(officeId, state, () => {
      if (noCiRan(office, run.runId, stored.headSha)) return [];
      appendRunStep(office, run.runId, "ci-none", stored.headSha, this.#deps.clock.now());
      return [
        notice(
          "info",
          STORY_PR_NOTICES.ciNone,
          `No CI checks were reported for the PR of ${stored.key} at ${stored.headSha.slice(0, 8)} within ${minutes} minutes, so no CI ran for it. dipo does not wait for CI on this head: the review decides.`,
          stored.key,
          run.runId,
        ),
      ];
    });
  }

  /** One item per failed check of the head; the host is asked for every check once. */
  async #ciItems(
    officeId: OfficeId,
    run: StoredRun,
    stored: StoryPrRecord,
    repo: string,
    reports: readonly RequiredCheck[],
  ): Promise<CiFeedbackItem[]> {
    const config = this.#runConfig(officeId, run);
    const budgets = config.prompt.budgets.feedbackItem as Readonly<Record<string, number>>;
    const polled = this.#offices.get(officeId);
    const names = polled?.watch.get(run.runId)?.names ?? [];
    const options = {
      itemMax: (run.tier === null ? undefined : budgets[run.tier]) ?? budgets.M ?? 3_000,
      logLines: FEEDBACK_LOG_LINES_DEFAULT,
      ...(polled === undefined
        ? {}
        : { budget: runBudgetFacts(polled.office, run, this.#deps.clock.now()) }),
    };
    const review = this.#deps.review;
    let all: readonly PrCheck[] = [];
    let listFailed = "";
    if (review !== undefined) {
      try {
        all = await review.prChecks(repo, stored.number);
      } catch (error) {
        listFailed = messageOf(error);
      }
    }
    const required = new Set(requiredCheckStates(reports, names).map((c) => c.name));
    const failed = all.filter(isFailed);
    // A failed required check the full list does not show is named, with no link.
    for (const report of reports) {
      if (isFailed(report) && !failed.some((check) => check.name === report.name)) {
        failed.push({ ...report, link: "", workflow: "" });
      }
    }
    const items: CiFeedbackItem[] = [];
    for (const check of failed) {
      const explainedBy = explainingJobs(check, failed, required);
      if (explainedBy.length > 0) {
        items.push(
          ciFeedback(
            {
              check: check.name,
              link: check.link,
              log: null,
              noLog: `no log: it failed because other jobs of its workflow run failed (${explainedBy.join(", ")}).`,
            },
            options,
          ),
        );
        continue;
      }
      let log: string | null = null;
      let noLog = "no log: the check is not a GitHub Actions job, see its link.";
      if (review !== undefined && check.link !== "") {
        try {
          log = await review.failedJobLog(repo, check.link);
        } catch (error) {
          noLog = `no log: reading it failed (${messageOf(error)}).`;
        }
      } else if (listFailed !== "") {
        noLog = `no log: the checks of the head could not be listed (${listFailed}).`;
      } else if (review === undefined) {
        noLog = "no log: dipo has no way to read job logs here.";
      }
      items.push(ciFeedback({ check: check.name, link: check.link, log, noLog }, options));
    }
    return items;
  }

  #failed(officeId: OfficeId, state: Polled, runId: RunId, key: StoryKey, error: unknown): void {
    const reason =
      error instanceof CodeHostError ? `${error.code}: ${error.message}` : messageOf(error);
    this.#deps.logger?.warn("opening the story PR failed", {
      office: officeId,
      run: runId,
      reason,
    });
    if (state.told.get(runId) === reason) return;
    state.told.set(runId, reason);
    this.#write(officeId, state, () => [
      notice(
        "warn",
        STORY_PR_NOTICES.openFailed,
        `dipo could not open the PR for ${key}: ${reason}. The story stays In Review; dipo tries again.`,
        key,
        runId,
      ),
    ]);
  }

  #write(officeId: OfficeId, state: Polled, fn: () => NewEntry[]): void {
    const at = this.#deps.clock.now();
    const count = state.office.immediate(() => {
      const entries = fn();
      appendEntries(state.office, entries, { at });
      return entries.length;
    });
    if (count > 0) this.#deps.onChanged?.(officeId);
  }

  #state(officeId: OfficeId): Polled {
    const state = this.#offices.get(officeId);
    if (state !== undefined) return state;
    const office = this.#deps.offices.get(officeId);
    if (office === undefined) throw new Error(`Office ${officeId} is not loaded.`);
    this.track(officeId, office, this.#deps.clock);
    return this.#offices.get(officeId) as Polled;
  }

  #serial<T>(state: Polled, fn: () => Promise<T>): Promise<T> {
    const run = state.busy.then(fn, fn);
    state.busy = run.catch(() => undefined);
    return run;
  }

  #schedule(officeId: OfficeId, config: OfficeConfig | undefined): void {
    const state = this.#offices.get(officeId);
    if (state === undefined || this.#stopped || state.timer !== null) return;
    const seconds = (config ?? OFFICE_DEFAULTS).polling.prStateSeconds;
    if (seconds <= 0) {
      // No poll pushes a held run again: say so once for each (DIPO-315).
      for (const held of runsToPush(state.office)) this.#heldNotice(officeId, state, held);
      return;
    }
    // The office's PR-state poll runs the PR poll in its rounds (DIPO-314).
    if (this.#deps.prState !== undefined) return;
    state.timer = state.clock.setTimeout(() => {
      state.timer = null;
      if (this.#offices.get(officeId) !== state) return;
      if (this.#deps.offices.get(officeId) === undefined) {
        this.#offices.delete(officeId);
        return;
      }
      void this.retry(officeId)
        .catch((error: unknown) => {
          this.#deps.logger?.warn("the story PR retry failed", {
            office: officeId,
            reason: messageOf(error),
          });
        })
        .finally(() => this.#schedule(officeId, this.#deps.offices.config(officeId)));
    }, seconds * 1000);
  }

  #cancel(state: Polled): void {
    if (state.timer !== null) state.clock.clearTimeout(state.timer);
    state.timer = null;
  }
}

/**
 * True when the run waits for its merge: open at In Review with no active period, with a
 * live claim and no open park. Its story may read Done on its branch after the close-out commit.
 */
function waitsForMerge(stories: ParkStore, office: OfficeHandle, run: StoredRun): boolean {
  if (run.key === null || !openAtInReview(run)) return false;
  return (
    office.get(
      `select 1 as found from claims c where c.office_id = $office_id and c.run_id = $run
          and c.released_at is null`,
      { run: run.runId },
    ) !== null && !runHeldByPark(stories, office, run.runId)
  );
}

function reviewKey(verdict: StoredReviewVerdict | null): string {
  return verdict === null
    ? "none"
    : `${verdict.gate}:${verdict.commit}:${verdict.override?.at ?? ""}`;
}

/** The newest test recorded for the run, for the status block (DIPO-309); none when untested. */
function testOfRun(office: OfficeHandle, runId: RunId): { test?: PrBodyTest } {
  const tested = latestRecordedTest(office, runId);
  return tested === null || tested.result === null
    ? {}
    : { test: { result: tested.result, head: tested.head } };
}

function reviewOfVerdict(verdict: StoredReviewVerdict): PrBodyReview {
  return {
    round: verdict.round,
    verdict: verdict.verdict,
    commit: verdict.commit,
    ...findingCounts(verdict.findings),
    overridden: verdict.override !== null,
  };
}

/** The `[HOST/]OWNER/REPO` of a PR URL (`https://github.com/o/r/pull/7`), or null. */
function repoOfPrUrl(url: string): string | null {
  const at = url.lastIndexOf("/pull/");
  return at <= 0 || !/^\/pull\/\d+\/?$/.test(url.slice(at))
    ? null
    : repoOfRemoteUrl(url.slice(0, at));
}

function prEntry(record: StoryPrRecord, story: string): NewEntry {
  return {
    type: "story.pr",
    key: record.key,
    run: record.runId,
    delta: {
      story,
      key: record.key,
      pr: { number: record.number, url: record.url, state: record.state },
    },
  };
}

function notice(
  level: "info" | "warn",
  code: string,
  text: string,
  key: StoryKey,
  run: RunId,
): NewEntry {
  return { type: "engine.notice", key, run, delta: { level, code, text } };
}

/** The most characters of CI items a park detail holds (0014's per-message budget). */
const CI_DETAIL_MAX = 8_000;

const cutMarker = (shown: number, total: number): string =>
  `[dipo: cut, showing ${shown} of ${total} characters.]`;

const isFailed = (check: RequiredCheck): boolean =>
  check.bucket === "fail" || check.bucket === "cancel";

/** The names of the checks a head still waits for. */
function waitingFor(reports: readonly RequiredCheck[], names: readonly string[]): string[] {
  const verdict = evaluateChecks(reports, names);
  if (verdict.state === "pending") return [...verdict.waiting];
  return requiredCheckStates(reports, names)
    .filter(({ state }: RequiredCheckState) => state === "pending")
    .map(({ name }) => name);
}

const runOfLink = (link: string): string | null =>
  /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/job\/\d+/.exec(link)?.[1] ?? null;

/**
 * The failed jobs that explain a failed required check: other failed checks of the same workflow
 * run that are not required themselves, as the jobs `ci-ok` waits for are. Empty when the check
 * is not an Actions job or no such job failed, so it gets a log of its own.
 */
function explainingJobs(
  check: PrCheck,
  failed: readonly PrCheck[],
  required: ReadonlySet<string>,
): string[] {
  const run = runOfLink(check.link);
  if (run === null || !required.has(check.name)) return [];
  return failed
    .filter(
      (other) => other !== check && !required.has(other.name) && runOfLink(other.link) === run,
    )
    .map((other) => other.name);
}
