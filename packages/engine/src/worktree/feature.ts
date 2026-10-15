// Claims per office (DIPO-38), and their office load step (DIPO-27 seam): when an office loads,
// the run-start snapshot of every live claim's worktree is pinned on the office's git again, so
// the refusal of git calls in a tampered worktree (0008 section 2) survives a daemon restart. The
// step must run after `git.version`, which attaches the office's git, so the daemon registers
// this feature right after `EngineGit.feature`. `work.run` (DIPO-48) calls `claim`.
//
// The same step rolls back every live claim whose setup never finished (no recorded claim commit),
// for example because the daemon stopped during setup (DIPO-39): its worktree is removed, its
// branch restored, its row ended as `setup-failed` and its port slot freed.
//
// Before the rollback, the step sweeps the `_branch-read-*` scratch directories a killed or
// crashed daemon left under the worktree root (DIPO-90, see `sweep.ts`). The story index's load
// step, which runs branch reads, follows this one.

import type { Clock, OfficeId } from "@dipsaus-orchestrator/contract";

import type { BacklogCli } from "../backlog/runner";
import type { FeatureModule } from "../commands/registry";
import type { OfficeHandle } from "../db/office";
import type { OfficeGit } from "../git/office";
import type { OfficeLoadContext } from "../office/steps";
import { type DiskProbe, systemDiskProbe } from "../platform/disk";

import {
  claimStory,
  type ClaimOutcome,
  type ClaimRequest,
  type ClaimSetupDone,
  releaseUnstarted,
  rollBackInterruptedSetup,
} from "./claim";
import { type ClaimRecord, liveClaims } from "./records";
import type { SlotTable } from "./slots";
import { sweepBranchReads } from "./sweep";

/** The load step's name in the registry. */
export const CLAIMS_STEP = "worktree.claims";

export interface StoryClaimsDeps {
  /** The office's git, attached by the `git.version` load step (DIPO-31). */
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  /** How the Backlog CLI starts in a story worktree. */
  readonly cli: BacklogCli;
  /** The free-space probe; the real `statfs` by default. */
  readonly disk?: DiskProbe;
  /** The machine-wide port slot table; a rolled-back interrupted setup frees its slot there. */
  readonly slots?: SlotTable;
  readonly onChanged?: (office: OfficeId) => void;
  /** Logs a release step that failed (the daemon's logger); nothing by default. */
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
  /** Logs the branch-read sweep at office load (the daemon's logger); nothing by default. */
  readonly info?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
  /**
   * The daemon start (epoch ms, from its clock): scratch directories older than this are swept.
   * Defaults to the clock time of the first office load.
   */
  readonly startedAt?: number;
}

interface Loaded {
  readonly office: OfficeHandle;
  readonly clock: Clock;
}

export class StoryClaims {
  readonly #deps: StoryClaimsDeps;
  readonly #offices = new Map<OfficeId, Loaded>();
  #startedAt: number | undefined;

  constructor(deps: StoryClaimsDeps) {
    this.#deps = deps;
    this.#startedAt = deps.startedAt;
  }

  /**
   * Removes the office's leftover branch-read scratch directories, older than the daemon start,
   * and logs how many. Never refuses the office: a failure is logged and the load goes on.
   */
  sweepScratch(ctx: OfficeLoadContext): void {
    const git = this.#deps.git(ctx.officeId);
    if (git === undefined) return;
    this.#startedAt ??= ctx.clock.now();
    let root: string;
    try {
      root = git.worktreeRoot();
    } catch (error) {
      this.#deps.warn?.("branch-read sweep skipped", {
        office: ctx.officeId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const swept = sweepBranchReads(root, this.#startedAt);
    for (const failure of swept.failed) {
      this.#deps.warn?.("branch-read scratch directory not removed", {
        office: ctx.officeId,
        ...failure,
      });
    }
    this.#deps.info?.("branch-read scratch swept", {
      office: ctx.officeId,
      root,
      removed: swept.removed.length,
    });
  }

  /**
   * Pins the snapshot of every live claim's worktree on the office's git. Returns the reason the
   * office is refused, or null.
   */
  attach(ctx: OfficeLoadContext): string | null {
    const git = this.#deps.git(ctx.officeId);
    if (git === undefined) {
      return "the office's git is not attached; the git.version load step must run before the claims";
    }
    for (const claim of liveClaims(ctx.office)) git.pinWorktree(claim.snapshot);
    this.#offices.set(ctx.officeId, { office: ctx.office, clock: ctx.clock });
    return null;
  }

  /**
   * Rolls back every live claim of a loaded office whose setup never finished (its claim commit
   * is not recorded), and frees its slot.
   */
  async recover(officeId: OfficeId): Promise<void> {
    const loaded = this.#offices.get(officeId);
    const git = this.#deps.git(officeId);
    if (loaded === undefined || git === undefined) return;
    const deps = {
      officeId,
      office: loaded.office,
      git,
      clock: loaded.clock,
      ...(this.#deps.onChanged === undefined ? {} : { onChanged: this.#deps.onChanged }),
    };
    for (const claim of liveClaims(loaded.office)) {
      if (claim.claimSha !== null) continue;
      await rollBackInterruptedSetup(deps, claim);
      this.#deps.slots?.free(claim.worktree);
    }
  }

  /**
   * Releases a live claim whose worker did not start (see `releaseUnstarted`) and frees its slot.
   */
  async releaseUnstarted(officeId: OfficeId, claim: ClaimRecord, reason: string): Promise<void> {
    const loaded = this.#offices.get(officeId);
    const git = this.#deps.git(officeId);
    if (loaded === undefined || git === undefined) {
      throw new Error(`The office ${officeId} is not loaded.`);
    }
    await releaseUnstarted(
      {
        officeId,
        office: loaded.office,
        git,
        clock: loaded.clock,
        ...(this.#deps.onChanged === undefined ? {} : { onChanged: this.#deps.onChanged }),
      },
      claim,
      reason,
      this.#deps.warn,
    );
    this.#deps.slots?.free(claim.worktree);
  }

  /** Claims a story of a loaded office (see `claimStory`). */
  claim<S extends ClaimSetupDone = ClaimSetupDone>(
    officeId: OfficeId,
    request: ClaimRequest<S>,
  ): Promise<ClaimOutcome<S>> {
    const loaded = this.#offices.get(officeId);
    const git = this.#deps.git(officeId);
    if (loaded === undefined || git === undefined) {
      return Promise.reject(new Error(`The office ${officeId} is not loaded.`));
    }
    return claimStory(
      {
        officeId,
        office: loaded.office,
        git,
        cli: this.#deps.cli,
        clock: loaded.clock,
        disk: this.#deps.disk ?? systemDiskProbe,
        ...(this.#deps.onChanged === undefined ? {} : { onChanged: this.#deps.onChanged }),
      },
      request,
    );
  }

  /** The feature module that adds the snapshot load step. */
  get feature(): FeatureModule {
    return {
      name: "worktree/claims",
      register: (registry) => {
        registry.registerLoadStep(CLAIMS_STEP, async (ctx) => {
          const reason = this.attach(ctx);
          if (reason !== null) return { ok: false, reason };
          this.sweepScratch(ctx);
          await this.recover(ctx.officeId);
          return { ok: true };
        });
      },
    };
  }
}
