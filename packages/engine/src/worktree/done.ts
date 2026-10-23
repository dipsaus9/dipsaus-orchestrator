// The Done poll per office (DIPO-58; 0010 section 7): every `polling.prStateSeconds` of the office
// configuration in force, each finished live claim (its claim commit recorded) is checked for Done
// through the code host (`platform/host.ts`) and `git merge-tree` (`teardown.ts`). A Done story is
// torn down unless it is Parked or a worker host of its run is still live: a parked story keeps its
// worktree, branch and slot (0010 section 7, "Teardown"). Each notice is put on the office once per
// claim and cause, so a dirty worktree is not reported again on every poll.
//
// The teardown's release ends the claim's run with `done` (`DONE_END`): the run's last active
// period ended at In Review, so that end is its final one, and its final `run_outcomes` row is
// written in the release's transaction (`finishRun`, 0019 section 13, DIPO-142).
//
// The load step only arms the poll; it must run after `git.version` (the office's git) and after
// the claims' load step, so the daemon registers this feature right after `StoryClaims.feature`.
// Polls of one office run one at a time.
//
// A claim not detected Done on its own branch is checked on the base (DIPO-161; 0020 section 10):
// its story's status in `_base`, which the story index's fetch keeps at `<remote>/<base>`, read
// with the Backlog CLI. A Done there wins over the branch status: a claim with a live worker is
// flagged once and released when its run next ends; a parked or idle one is released as
// `done-elsewhere` and its PR, worktree and branch settled (`done-elsewhere.ts`). Each poll first
// settles the released rows a crash left unsettled.
//
// With the office's PR-state poll (`prState`, DIPO-314) the Done poll is part of each of its
// rounds, after the story-PR poll, instead of a timer of its own, and that poll asks whether a
// branch merged through the reads the round gave it, so a story PR the story-PR poll read this
// round answers it without another host call. Any other poll asks the host.

import type { Clock, OfficeId, TimerHandle } from "@dipsaus-orchestrator/contract";

import { viewStory } from "../backlog/fields/write";
import type { BacklogCli } from "../backlog/runner";
import { appendEntries } from "../changelog/log";
import type { FeatureModule } from "../commands/registry";
import { OFFICE_DEFAULTS, type OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import type { GitLocation } from "../git/hardened";
import type { OfficeGit } from "../git/office";
import type { Logger } from "../log/logger";
import { decideOnHandMerge } from "../merge-slot/gates";
import type { CodeHost, PrStateHost } from "../platform/host";
import type { PrStatePoll } from "../platform/pr-state";
import { withWorkViews } from "../views/work";

import { inStoryBacklog, notice, writeWith } from "./claim";
import {
  baseDoneOf,
  type DoneElsewhereDeps,
  findDoneElsewhere,
  flagLiveWorker,
  hasLiveWorker,
  hasUnexitedHost,
  releaseDoneElsewhere,
  settleDoneElsewhere,
  settlePending,
} from "./done-elsewhere";
import { type ClaimRecord, liveClaims } from "./records";
import type { SlotTable } from "./slots";
import { detectDone, tearDown, type TeardownDeps, TEARDOWN_NOTICES } from "./teardown";

/** The load step's name in the registry. */
export const TEARDOWN_STEP = "worktree.teardown";

/** The Backlog.md status of a parked story (0012). */
export const PARKED_STATUS = "Parked";

type WorktreeLocation = Extract<GitLocation, { kind: "worktree" }>;

export interface StoryTeardownDeps {
  /** The office's git, attached by the `git.version` load step (DIPO-31). */
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  /** The code host; null when the daemon has none, so only `merge-tree` detects Done. */
  readonly host: PrStateHost | null;
  /** How the Backlog CLI starts; it reads a Done story's status in dipo's copy of its backlog. */
  readonly cli: BacklogCli;
  /** The loaded offices and the configuration in force for each next interval. */
  readonly offices: {
    get(office: OfficeId): OfficeHandle | undefined;
    config(office: OfficeId): OfficeConfig | undefined;
  };
  /** The machine-wide port slot table; teardown frees the worktree's slot there. */
  readonly slots?: SlotTable;
  /** The story's status on its branch, or null when unreadable; the Backlog CLI by default. */
  readonly statusOf?: (claim: ClaimRecord) => Promise<string | null>;
  /**
   * Whether the claim's story is Done on the base, with the base commit that last changed its task
   * file; null when it is not Done there or cannot be read. Read in `_base` by default (DIPO-161).
   */
  readonly baseDoneOf?: (claim: ClaimRecord) => Promise<{ readonly commit: string | null } | null>;
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
  /** Done claims that kept everything (parked, dirty, locked, live worker). */
  readonly kept: readonly ClaimRecord[];
  /** Claims released because their story is Done on the base through another branch. */
  readonly released?: readonly ClaimRecord[];
}

interface Polled {
  readonly office: OfficeHandle;
  readonly clock: Clock;
  timer: TimerHandle | null;
  busy: Promise<unknown>;
  /** The last notice text per claim run and notice code, so a cause is reported once. */
  readonly told: Map<string, string>;
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
      ...(this.#deps.slots === undefined ? {} : { slots: this.#deps.slots }),
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
        // One claim's git error (a tampered worktree, a held lock) does not stop the others.
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
    return released.length === 0
      ? { checked, tornDown, kept }
      : { checked, tornDown, kept, released };
  }

  /** Detects Done for one claim and tears it down unless something keeps it. */
  async #settle(
    state: Polled,
    deps: TeardownDeps,
    claim: ClaimRecord,
  ): Promise<"open" | "kept" | "tornDown" | "released"> {
    // Through the PR-state round this poll belongs to, when it does (DIPO-314).
    const host = this.#deps.host === null ? null : (state.reads ?? this.#deps.host);
    const check = await detectDone({ git: deps.git, host }, claim);
    if (!check.done) {
      // Not Done through its own branch: a Done on the base wins (DIPO-161).
      const elsewhere = await this.#doneElsewhere(state, deps, claim);
      if (elsewhere !== null) return elsewhere;
      if (check.problem !== undefined) {
        this.#tell(state, deps, claim, "warn", check.problem.code, check.problem.text);
      }
      return "open";
    }
    // A merge by hand on the host closes the story's open merge gate (0019 section 11, DIPO-150).
    if (check.evidence.by === "host") this.#handMerged(deps, claim);
    if (hasUnexitedHost(state.office, claim.runId)) {
      this.#tell(
        state,
        deps,
        claim,
        "info",
        TEARDOWN_NOTICES.kept,
        `${claim.story} is Done, but a worker of its run is still running; dipo tears down its worktree once the worker has ended.`,
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
          `${claim.story} looks merged, but dipo could not read its status in ${claim.worktree}, so it cannot rule out a park and keeps the worktree, branch ${claim.branch} and port slot this time. dipo tries again on its next poll.`,
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
          `${claim.story} looks merged, but it is Parked, so dipo keeps its worktree, branch ${claim.branch} and port slot. Resolve the park to finish it.`,
        );
        return "kept";
      }
    }
    const outcome = await tearDown(deps, claim, check.evidence, check.tip);
    if (outcome.ok) return "tornDown";
    const files =
      outcome.files.length === 0
        ? ""
        : ` Files git lists there: ${outcome.files.join(", ")}. Commit, move or remove those changes.`;
    this.#tell(
      state,
      deps,
      claim,
      "warn",
      TEARDOWN_NOTICES.kept,
      `${claim.story} is Done, but dipo kept its worktree, branch ${claim.branch} and port slot: ${outcome.why}.${files} dipo tries again on its next poll.`,
    );
    return "kept";
  }

  /**
   * The release of a claim whose story is Done on the base (see the file comment); null when it is
   * not Done there, so the poll goes on as before.
   */
  async #doneElsewhere(
    state: Polled,
    deps: TeardownDeps,
    claim: ClaimRecord,
  ): Promise<"kept" | "released" | null> {
    const base = await this.#baseDone(deps.git, claim);
    if (base === null) return null;
    const elsewhere = this.#elsewhereDeps(deps);
    if (hasLiveWorker(state.office, claim)) {
      flagLiveWorker(elsewhere, claim, base.commit);
      return "kept";
    }
    releaseDoneElsewhere(elsewhere, claim, base.commit);
    const row = findDoneElsewhere(state.office, claim.runId);
    if (row !== null) await settleDoneElsewhere(elsewhere, row);
    return "released";
  }

  /** The story's Done on `_base` with the base commit of its task file, or null; never throws. */
  async #baseDone(git: OfficeGit, claim: ClaimRecord): Promise<{ commit: string | null } | null> {
    if (this.#deps.baseDoneOf !== undefined) return this.#deps.baseDoneOf(claim);
    return baseDoneOf(git, this.#deps.cli, claim.story);
  }

  #elsewhereDeps(deps: TeardownDeps): DoneElsewhereDeps {
    return {
      officeId: deps.officeId,
      office: deps.office,
      git: deps.git,
      clock: deps.clock,
      ...(deps.slots === undefined ? {} : { slots: deps.slots }),
      ...(deps.onChanged === undefined ? {} : { onChanged: deps.onChanged }),
      ...(this.#deps.prCloser === undefined ? {} : { host: this.#deps.prCloser }),
      ...(this.#deps.finishBoxes === undefined ? {} : { finishBoxes: this.#deps.finishBoxes }),
    };
  }

  /**
   * The story's status as committed on its branch, read with the Backlog CLI in dipo's own copy of
   * its backlog, never in the worktree (`inStoryBacklog`, 0021 section 14); null when unreadable.
   */
  async #statusOf(git: OfficeGit, claim: ClaimRecord): Promise<string | null> {
    if (this.#deps.statusOf !== undefined) return this.#deps.statusOf(claim);
    try {
      return await git.run((session) =>
        inStoryBacklog(
          git,
          session,
          git.worktreeLocation(claim.worktree) as WorktreeLocation,
          claim.story,
          async (backlog) =>
            (await viewStory({ cli: this.#deps.cli, cwd: backlog.cwd, id: claim.story })).status,
        ),
      );
    } catch {
      return null;
    }
  }

  /**
   * The story's PR merged on the host while a merge gate stood open (a hand merge, 0019 section
   * 11): in one transaction the open gate is decided approved by the maintainer with the note
   * "merged on the host". A gate the merge slot's merge already decided is left as it is.
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
