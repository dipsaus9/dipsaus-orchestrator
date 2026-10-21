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

import type { Clock, OfficeId, TimerHandle } from "@dipsaus-orchestrator/contract";

import { viewStory } from "../backlog/fields/write";
import type { BacklogCli } from "../backlog/runner";
import type { FeatureModule } from "../commands/registry";
import { OFFICE_DEFAULTS, type OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import type { GitLocation } from "../git/hardened";
import type { OfficeGit } from "../git/office";
import type { Logger } from "../log/logger";
import type { PrStateHost } from "../platform/host";

import { inStoryBacklog, notice, writeWith } from "./claim";
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
  readonly onChanged?: (office: OfficeId) => void;
  readonly logger?: Logger;
}

/** What one poll did. */
export interface PollReport {
  /** Claims checked for Done. */
  readonly checked: number;
  /** Claims torn down. */
  readonly tornDown: readonly ClaimRecord[];
  /** Done claims that kept everything (parked, dirty, locked, live worker). */
  readonly kept: readonly ClaimRecord[];
}

interface Polled {
  readonly office: OfficeHandle;
  readonly clock: Clock;
  timer: TimerHandle | null;
  busy: Promise<unknown>;
  /** The last notice text per claim run and notice code, so a cause is reported once. */
  readonly told: Map<string, string>;
}

export class StoryTeardown {
  readonly #deps: StoryTeardownDeps;
  readonly #offices = new Map<OfficeId, Polled>();
  #stopped = false;

  constructor(deps: StoryTeardownDeps) {
    this.#deps = deps;
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
    });
  }

  /** One poll of a tracked office, after any poll already running. */
  poll(officeId: OfficeId): Promise<PollReport> {
    const state = this.#offices.get(officeId);
    if (state === undefined) {
      return Promise.reject(new Error(`Office ${officeId} is not loaded.`));
    }
    const run = state.busy.then(
      () => this.#poll(officeId, state),
      () => this.#poll(officeId, state),
    );
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
    let checked = 0;
    const deps = {
      officeId,
      office: state.office,
      git,
      clock: state.clock,
      ...(this.#deps.slots === undefined ? {} : { slots: this.#deps.slots }),
      ...(this.#deps.onChanged === undefined ? {} : { onChanged: this.#deps.onChanged }),
    };
    for (const claim of liveClaims(state.office)) {
      // A claim whose setup never finished is the claims' load step's to roll back.
      if (claim.claimSha === null) continue;
      checked += 1;
      try {
        const result = await this.#settle(state, deps, claim);
        if (result === "tornDown") tornDown.push(claim);
        else if (result === "kept") kept.push(claim);
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
    return { checked, tornDown, kept };
  }

  /** Detects Done for one claim and tears it down unless something keeps it. */
  async #settle(
    state: Polled,
    deps: TeardownDeps,
    claim: ClaimRecord,
  ): Promise<"open" | "kept" | "tornDown"> {
    const check = await detectDone({ git: deps.git, host: this.#deps.host }, claim);
    if (!check.done) {
      if (check.problem !== undefined) {
        this.#tell(state, deps, claim, "warn", check.problem.code, check.problem.text);
      }
      return "open";
    }
    if (hasLiveHost(state.office, claim)) {
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
          false,
          async (backlog) =>
            (await viewStory({ cli: this.#deps.cli, cwd: backlog.cwd, id: claim.story })).status,
        ),
      );
    } catch {
      return null;
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
    if (seconds <= 0) return;
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

/** True when a worker host of the claim's run has not ended. */
function hasLiveHost(office: OfficeHandle, claim: ClaimRecord): boolean {
  return (
    office.get<{ n: number }>(
      `select 1 as n from worker_hosts
       where office_id = $office_id and run_id = $run and ended_at is null limit 1`,
      { run: claim.runId },
    ) !== null
  );
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
