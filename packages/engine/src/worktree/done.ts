// The Done poll per office (DIPO-58, DIPO-363; 0002, 0010): every `polling.prStateSeconds` of the
// office configuration in force, each finished live claim (its claim commit recorded) is checked
// with the one Done check (`done-check.ts`): its story PR as the code host (`platform/host.ts`) or
// dipo's record gives it, and its story's status in `_base`, which the story index's fetch keeps
// at `<remote>/<base>`, read through the story store. `git merge-tree` is no Done signal (0010).
//
// - Merged: the story is torn down (`teardown.ts`) unless it is Parked or a worker host of its run
//   is still live: a parked story keeps its branch. A branch that moved past the merged head with
//   changes the base lacks (`git merge-tree` decides only that, 0010) is released as `done` with its
//   branch as a leftover once no worker runs (`releaseMovedPastMerge`, DIPO-332), or kept with a
//   notice while it is parked.
// - Done on the base (DIPO-161; 0020): a claim with a live worker is flagged once and released
//   when its run next ends; a parked or idle one is released as `done-elsewhere` and its PR and
//   branch settled (`done-elsewhere.ts`).
//
// Each notice is put on the office once per claim and cause, so a kept claim is not reported again
// on every poll. Each poll first settles the released rows a crash left unsettled.
//
// The teardown's release ends the claim's run done (0020): the run stood open at In Review, its
// last active period's end is kept, and its final `run_outcomes` row is written in the release's
// transaction (`endRun`, DIPO-142).
//
// The load step only arms the poll; it must run after `git.version` (the office's git) and after
// the claims' load step, so the daemon registers this feature right after `StoryClaims.feature`.
// Polls of one office run one at a time.
//
// With the office's PR-state poll (`prState`, DIPO-314) the Done poll is part of each of its
// rounds, after the story-PR poll, instead of a timer of its own, and that poll asks whether a
// branch merged through the reads the round gave it, so a story PR the story-PR poll read this
// round answers it without another host call. Any other poll asks the host.

import type { Clock, OfficeId, TimerHandle } from "@dipsaus-orchestrator/contract";

import { appendEntries } from "../changelog/log";
import type { FeatureModule } from "../commands/registry";
import { OFFICE_DEFAULTS, type OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import type { OfficeGit } from "../git/office";
import type { Logger } from "../log/logger";
import { decideOnHandMerge } from "../merge/gates";
import { type CodeHost, type PrStateHost, repoOfRemoteUrl } from "../platform/host";
import type { PrStatePoll } from "../story-pr/pr-state";
import type { StoryStore } from "../story-store/store";
import { withWorkViews } from "../views/work";

import { notice, writeWith } from "./claim";
import { claimPr, decideDone, type DoneAnswer, type DonePr } from "./done-check";
import {
  type BaseStatus,
  baseStatusOf,
  type DoneElsewhereDeps,
  findDoneElsewhere,
  flagLiveWorker,
  hasLiveWorker,
  hasOpenPark,
  hasUnexitedHost,
  movedPastParkedText,
  releaseDoneElsewhere,
  releaseMovedPastMerge,
  settleDoneElsewhere,
  settlePending,
} from "./done-elsewhere";
import { type ClaimRecord, liveClaims } from "./records";
import { addsNothingTo } from "./release";
import {
  claimGitFacts,
  type ClaimGitFacts,
  tearDown,
  type TeardownDeps,
  TEARDOWN_NOTICES,
} from "./teardown";

/** The load step's name in the registry. */
export const TEARDOWN_STEP = "worktree.teardown";

/**
 * The polls in a row the code host must fail on one claim before the Done poll tells the
 * maintainer, once per streak: a story whose PR state cannot be read is not Done meanwhile.
 */
export const HOST_FAILURES_NOTICED = 3;

/** The Backlog.md status of a parked story (0012). */
export const PARKED_STATUS = "Parked";

export interface StoryTeardownDeps {
  /** The office's git, attached by the `git.version` load step (DIPO-31). */
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  /** The code host; null when the daemon has none, so only dipo's record of a story PR says it merged. */
  readonly host: PrStateHost | null;
  /** The story store; it reads a story's status on its branch and on the base. */
  readonly stories: StoryStore;
  /** The loaded offices and the configuration in force for each next interval. */
  readonly offices: {
    get(office: OfficeId): OfficeHandle | undefined;
    config(office: OfficeId): OfficeConfig | undefined;
  };
  /** The story's status on its branch, or null when unreadable; the story store by default. */
  readonly statusOf?: (claim: ClaimRecord) => Promise<string | null>;
  /** Closes dipo's open story PR of a story Done elsewhere; the `gh` host in the daemon. */
  readonly prCloser?: Pick<CodeHost, "closePr"> | null;
  /** Checks and deletes the boxes of ended runs after a release (0021 section 6). */
  readonly finishBoxes?: () => Promise<unknown>;
  readonly onChanged?: (office: OfficeId) => void;
  readonly logger?: Logger;
  /**
   * The office's one PR-state poll (DIPO-314): the Done poll runs as the last part of its rounds,
   * not on a timer of its own, and asks the host through it. Without it the Done poll keeps its
   * own timer.
   */
  readonly prState?: Pick<PrStatePoll, "subscribe">;
}

/** What one poll did. */
export interface PollReport {
  /** Claims checked for Done. */
  readonly checked: number;
  /** Claims torn down. */
  readonly tornDown: readonly ClaimRecord[];
  /** Done claims that kept everything (parked, a moved branch, a live worker). */
  readonly kept: readonly ClaimRecord[];
  /** Claims released because their story is Done on the base through another branch. */
  readonly released?: readonly ClaimRecord[];
}

/** The facts of one Done check and its answer. */
interface Checked {
  readonly facts: ClaimGitFacts;
  readonly pr: DonePr | null;
  /** The host's error when it was asked about the claim's PR and failed, else null. */
  readonly hostError: string | null;
  readonly base: BaseStatus;
  readonly answer: DoneAnswer;
}

interface Polled {
  readonly office: OfficeHandle;
  readonly clock: Clock;
  timer: TimerHandle | null;
  busy: Promise<unknown>;
  /** The last notice text per claim run and notice code, so a cause is reported once. */
  readonly told: Map<string, string>;
  /** The polls in a row the host failed per claim run (`HOST_FAILURES_NOTICED`). */
  readonly hostFailures: Map<string, number>;
  /** The reads of the PR-state round the running poll belongs to (DIPO-314), or null. */
  reads: PrStateHost | null;
}

export class StoryTeardown {
  readonly #deps: StoryTeardownDeps;
  readonly #offices = new Map<OfficeId, Polled>();
  #stopped = false;

  constructor(deps: StoryTeardownDeps) {
    this.#deps = deps;
    deps.prState?.subscribe("done", async (office, reads) => {
      if (this.#offices.has(office)) await this.poll(office, reads);
    });
  }

  /** The feature module that adds the load step arming the poll. */
  get feature(): FeatureModule {
    return {
      name: "worktree/teardown",
      register: (registry) => {
        registry.registerLoadStep(TEARDOWN_STEP, (ctx) => {
          this.track(ctx.officeId, ctx.office, ctx.clock);
          this.#schedule(ctx.officeId, ctx.config);
          return { ok: true };
        });
      },
    };
  }

  /** Tracks a loaded office without arming its poll (the load step arms it). */
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
      hostFailures: new Map(),
      reads: null,
    });
  }

  /**
   * One poll of a tracked office, after any poll already running; with `reads` (a PR-state round,
   * DIPO-314) it asks whether a branch merged through them.
   */
  poll(officeId: OfficeId, reads?: PrStateHost): Promise<PollReport> {
    const state = this.#offices.get(officeId);
    if (state === undefined) {
      return Promise.reject(new Error(`Office ${officeId} is not loaded.`));
    }
    const once = async () => {
      state.reads = reads ?? null;
      try {
        return await this.#poll(officeId, state);
      } finally {
        state.reads = null;
      }
    };
    const run = state.busy.then(once, once);
    state.busy = run.catch(() => undefined);
    return run;
  }

  /** Stops every poll; a poll already running finishes. */
  stop(): void {
    this.#stopped = true;
    for (const state of this.#offices.values()) this.#cancel(state);
  }

  async #poll(officeId: OfficeId, state: Polled): Promise<PollReport> {
    const git = this.#deps.git(officeId);
    if (git === undefined) return { checked: 0, tornDown: [], kept: [] };
    const tornDown: ClaimRecord[] = [];
    const kept: ClaimRecord[] = [];
    const released: ClaimRecord[] = [];
    let checked = 0;
    const deps = {
      officeId,
      office: state.office,
      git,
      clock: state.clock,
      ...(this.#deps.onChanged === undefined ? {} : { onChanged: this.#deps.onChanged }),
    };
    await settlePending(this.#elsewhereDeps(deps));
    for (const claim of liveClaims(state.office)) {
      // A claim whose setup never finished is the claims' load step's to roll back.
      if (claim.claimSha === null) continue;
      checked += 1;
      try {
        const result = await this.#settle(state, deps, claim);
        if (result === "tornDown") tornDown.push(claim);
        else if (result === "kept") kept.push(claim);
        else if (result === "released") released.push(claim);
      } catch (error) {
        // One claim's git error (a held lock) does not stop the others.
        this.#tell(
          state,
          deps,
          claim,
          "warn",
          TEARDOWN_NOTICES.checkFailed,
          `dipo could not check or tear down ${claim.story}: ${error instanceof Error ? error.message : String(error)}. It stays where it is; dipo tries again on its next poll.`,
        );
      }
    }
    // Forget what was told about claims that are no longer live.
    const live = new Set(liveClaims(state.office).map((claim) => claim.runId as string));
    for (const key of state.told.keys()) {
      if (!live.has(runOfToldKey(key))) state.told.delete(key);
    }
    for (const run of state.hostFailures.keys()) {
      if (!live.has(run)) state.hostFailures.delete(run);
    }
    return released.length === 0
      ? { checked, tornDown, kept }
      : { checked, tornDown, kept, released };
  }

  /**
   * The one Done check's answer for a live claim of a tracked office, from the facts a poll gathers
   * (`#check`); reconcile gathers the same facts (`reconcile/done-on-base.ts`).
   */
  async answer(officeId: OfficeId, claim: ClaimRecord): Promise<DoneAnswer> {
    const state = this.#offices.get(officeId);
    const git = this.#deps.git(officeId);
    if (state === undefined || git === undefined) {
      throw new Error(`Office ${officeId} is not loaded.`);
    }
    return (await this.#check(state, git, claim)).answer;
  }

  /**
   * The facts of the one Done check for a claim and its answer: the story PR through the PR-state
   * round this poll belongs to when it does (DIPO-314), else the host, else dipo's record
   * (`claimPr`), and the story's status in `_base`.
   */
  async #check(state: Polled, git: OfficeGit, claim: ClaimRecord): Promise<Checked> {
    const host = this.#deps.host === null ? null : (state.reads ?? this.#deps.host);
    const facts = await git.run((session) => claimGitFacts(git, session, claim));
    const repo = facts.url === null ? null : repoOfRemoteUrl(facts.url);
    const { pr, hostError } = await claimPr(host, repo, state.office, claim);
    const base = await baseStatusOf(git, this.#deps.stories, claim.story);
    const answer = decideDone({
      claim,
      pr,
      hostFailed: hostError !== null,
      baseStatus: base.status,
    });
    return { facts, pr, hostError, base, answer };
  }

  /**
   * Counts the polls in a row the host failed on the claim, and tells the maintainer once a streak
   * reaches `HOST_FAILURES_NOTICED`; an answer ends the streak.
   */
  #countHostFailure(
    state: Polled,
    deps: TeardownDeps,
    claim: ClaimRecord,
    error: string | null,
  ): void {
    if (error === null) {
      state.hostFailures.delete(claim.runId);
      state.told.delete(toldKey(claim.runId, TEARDOWN_NOTICES.hostUnreachable));
      return;
    }
    const failures = (state.hostFailures.get(claim.runId) ?? 0) + 1;
    state.hostFailures.set(claim.runId, failures);
    if (failures !== HOST_FAILURES_NOTICED) return;
    this.#tell(
      state,
      deps,
      claim,
      "warn",
      TEARDOWN_NOTICES.hostUnreachable,
      `dipo could not ask the code host whether the PR of ${claim.story} merged on ${HOST_FAILURES_NOTICED} polls in a row (${error}). Until it answers, dipo keeps the claim and its branch ${claim.branch} as they are; check \`gh auth status\` and the network.`,
    );
  }

  /** Checks one claim for Done and tears it down or releases it unless something keeps it. */
  async #settle(
    state: Polled,
    deps: TeardownDeps,
    claim: ClaimRecord,
  ): Promise<"open" | "kept" | "tornDown" | "released"> {
    const checked = await this.#check(state, deps.git, claim);
    this.#countHostFailure(state, deps, claim, checked.hostError);
    if (checked.answer === "doneOnBase") {
      return this.#doneElsewhere(state, deps, claim, checked.base);
    }
    if (checked.answer === "notDone" || checked.pr === null) {
      if (checked.facts.tip === null) {
        this.#tell(
          state,
          deps,
          claim,
          "warn",
          TEARDOWN_NOTICES.claimGone,
          `${claim.story} is claimed, but its branch ${claim.branch} is gone and dipo cannot tell whether it merged. Check the story by hand.`,
        );
      }
      return "open";
    }
    return this.#merged(state, deps, claim, checked.pr, checked.facts);
  }

  /** A claim whose own story PR merged: torn down unless something keeps it. */
  async #merged(
    state: Polled,
    deps: TeardownDeps,
    claim: ClaimRecord,
    pr: DonePr,
    facts: ClaimGitFacts,
  ): Promise<"open" | "kept" | "tornDown" | "released"> {
    // A merge by hand on the host closes the story's open merge gate (0002, DIPO-150).
    this.#handMerged(deps, claim);
    const { tip } = facts;
    if (tip !== null && tip !== pr.headSha) {
      // The branch moved past the merged head. `git merge-tree` decides only whether the branch
      // may go (0010): one that adds nothing to the base is torn down like any other.
      const ref = `refs/heads/${claim.branch}`;
      const nothing = await deps.git.run((git) => addsNothingTo(git, facts.baseRef, ref));
      if (!nothing) return this.#movedPast(state, deps, claim, pr, tip);
    }
    if (hasUnexitedHost(state.office, claim.runId)) {
      this.#tell(
        state,
        deps,
        claim,
        "info",
        TEARDOWN_NOTICES.kept,
        `${claim.story} is Done, but a worker of its run is still running; dipo deletes its branch once the worker has ended.`,
      );
      return "kept";
    }
    // A teardown that already started passed this check before it removed anything.
    if (claim.teardownStartedAt === null) {
      const status = await this.#statusOf(deps.git, claim);
      if (status === null) {
        this.#tell(
          state,
          deps,
          claim,
          "warn",
          TEARDOWN_NOTICES.statusUnknown,
          `${claim.story} looks merged, but dipo could not read its status on ${claim.branch}, so it cannot rule out a park and keeps the branch this time. dipo tries again on its next poll.`,
        );
        return "kept";
      }
      if (status === PARKED_STATUS) {
        this.#tell(
          state,
          deps,
          claim,
          "warn",
          TEARDOWN_NOTICES.parked,
          `${claim.story} looks merged, but it is Parked, so dipo keeps its branch ${claim.branch}. Resolve the park to finish it.`,
        );
        return "kept";
      }
    }
    const outcome = await tearDown(deps, claim, pr, tip);
    if (outcome.ok) return "tornDown";
    this.#tell(
      state,
      deps,
      claim,
      "warn",
      TEARDOWN_NOTICES.kept,
      `${claim.story} is Done, but dipo kept its branch ${claim.branch}: ${outcome.why}. dipo tries again on its next poll.`,
    );
    return "kept";
  }

  /**
   * A claim whose PR merged while its branch moved past the merged head with changes the base
   * lacks (DIPO-332): once no worker runs, those are leftovers with the `dipo discard` action, not
   * an open claim. A parked one stays, with a notice, as a Parked story is never torn down on its
   * own.
   */
  async #movedPast(
    state: Polled,
    deps: TeardownDeps,
    claim: ClaimRecord,
    pr: DonePr,
    tip: string,
  ): Promise<"open" | "kept" | "released"> {
    if (hasLiveWorker(state.office, claim)) {
      this.#tell(
        state,
        deps,
        claim,
        "warn",
        TEARDOWN_NOTICES.unmergedCommits,
        `The PR #${pr.number} of ${claim.story} merged, but the local branch ${claim.branch} is at ${tip}, not at the head that merged, and holds changes the base does not have. dipo keeps the branch; check it by hand.`,
      );
      return "open";
    }
    if (hasOpenPark(this.#deps.stories, state.office, claim)) {
      const text = movedPastParkedText(claim, pr);
      this.#tell(state, deps, claim, "warn", TEARDOWN_NOTICES.parked, text);
      return "kept";
    }
    await releaseMovedPastMerge(this.#elsewhereDeps(deps), claim, pr);
    return "released";
  }

  /**
   * The release of a claim whose story is Done on the base, not through its own PR (see the file
   * comment).
   */
  async #doneElsewhere(
    state: Polled,
    deps: TeardownDeps,
    claim: ClaimRecord,
    base: BaseStatus,
  ): Promise<"kept" | "released"> {
    const head = base.head;
    const commit =
      head === null
        ? null
        : await deps.git.run((session) =>
            this.#deps.stories.lastFileCommit(session, head, claim.story),
          );
    const elsewhere = this.#elsewhereDeps(deps);
    if (hasLiveWorker(state.office, claim)) {
      flagLiveWorker(elsewhere, claim, commit);
      return "kept";
    }
    releaseDoneElsewhere(elsewhere, claim, commit);
    const row = findDoneElsewhere(state.office, claim.runId);
    if (row !== null) await settleDoneElsewhere(elsewhere, row);
    return "released";
  }

  #elsewhereDeps(deps: TeardownDeps): DoneElsewhereDeps {
    return {
      officeId: deps.officeId,
      office: deps.office,
      git: deps.git,
      clock: deps.clock,
      ...(deps.onChanged === undefined ? {} : { onChanged: deps.onChanged }),
      ...(this.#deps.prCloser === undefined ? {} : { host: this.#deps.prCloser }),
      ...(this.#deps.finishBoxes === undefined ? {} : { finishBoxes: this.#deps.finishBoxes }),
    };
  }

  /**
   * The story's status as committed on its branch, read through the story store
   * (`viewOnBranch`); null when unreadable.
   */
  async #statusOf(git: OfficeGit, claim: ClaimRecord): Promise<string | null> {
    if (this.#deps.statusOf !== undefined) return this.#deps.statusOf(claim);
    try {
      return await git.run(
        async (session) => (await this.#deps.stories.viewOnBranch(git, session, claim)).view.status,
      );
    } catch {
      return null;
    }
  }

  /**
   * The story's PR merged on the host while a merge gate stood open (a hand merge, 0002): in one
   * transaction the open gate is decided approved by the maintainer with the note "merged on the
   * host". A gate already decided is left as it is.
   */
  #handMerged(deps: TeardownDeps, claim: ClaimRecord): void {
    const at = deps.clock.now();
    try {
      const appended = deps.office.immediate(() => {
        const entries = withWorkViews(deps.office, decideOnHandMerge(deps.office, claim.key, at));
        appendEntries(deps.office, entries, { at });
        return entries.length;
      });
      if (appended > 0) deps.onChanged?.(deps.officeId);
    } catch (error) {
      // The teardown goes on; the next poll decides the gate again.
      this.#deps.logger?.warn("deciding the merge gate of a hand merge failed", {
        office: deps.officeId,
        run: claim.runId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #tell(
    state: Polled,
    deps: Parameters<typeof writeWith>[0],
    claim: ClaimRecord,
    level: "info" | "warn",
    code: string,
    text: string,
  ): void {
    const key = toldKey(claim.runId, code);
    if (state.told.get(key) === text) return;
    state.told.set(key, text);
    writeWith(deps, () => [notice(level, code, text, claim.key)]);
  }

  #schedule(officeId: OfficeId, config: OfficeConfig | undefined): void {
    const state = this.#offices.get(officeId);
    if (state === undefined || this.#stopped || state.timer !== null) return;
    const seconds = (config ?? OFFICE_DEFAULTS).polling.prStateSeconds;
    // The office's PR-state poll runs the Done poll in its rounds (DIPO-314).
    if (seconds <= 0 || this.#deps.prState !== undefined) return;
    state.timer = state.clock.setTimeout(() => {
      state.timer = null;
      if (this.#offices.get(officeId) !== state) return;
      if (this.#deps.offices.get(officeId) === undefined) {
        this.#offices.delete(officeId);
        return;
      }
      void this.poll(officeId)
        .catch((error: unknown) => {
          this.#deps.logger?.warn("the Done poll failed", {
            office: officeId,
            reason: error instanceof Error ? error.message : String(error),
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

/** The key of a told notice: the claim's run and the notice code. */
function toldKey(runId: string, code: string): string {
  return `${runId}\n${code}`;
}

/** The run of a `toldKey`. */
function runOfToldKey(key: string): string {
  const end = key.indexOf("\n");
  return end === -1 ? key : key.slice(0, end);
}
