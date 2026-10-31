// Claims per office (DIPO-38), and their office load step (DIPO-27 seam). The step must run after
// `git.version`, which attaches the office's git, so the daemon registers this feature right after
// `EngineGit.feature`. `work.run` (DIPO-48) calls `claim`.
//
// The step rolls back every live claim whose setup never finished (no recorded claim commit), for
// example because the daemon stopped during setup (DIPO-39): its branch is restored and its row
// ended as `setup-failed`.
//
// Before the rollback, the step sweeps the `_branch-read-*` scratch directories a killed or
// crashed daemon left under the worktree root (DIPO-90, see `sweep.ts`), and removes the clean
// story worktrees an earlier binary left there, listing the others on the desk (DIPO-349,
// `leftovers.ts`). The story index's load step, which runs branch reads, follows this one.

import type { Clock, OfficeId } from "@dipsaus-orchestrator/contract";

import type { FeatureModule } from "../commands/registry";
import type { OfficeHandle } from "../db/office";
import type { OfficeGit } from "../git/office";
import { OFFICE_DEFAULTS } from "../config";
import type { OfficeLoadContext } from "../office/steps";
import type { StoryStore } from "../story-store/store";

import {
  claimStory,
  type ClaimOutcome,
  type ClaimRequest,
  type ClaimSetupDone,
  releaseUnstarted,
  rollBackInterruptedSetup,
} from "./claim";
import { recordKeptWorktrees, sweepLeftoverWorktrees } from "./leftovers";
import { type ClaimRecord, liveClaims } from "./records";
import { sweepBranchReads } from "./sweep";

/** The load step's name in the registry. */
export const CLAIMS_STEP = "worktree.claims";

export interface StoryClaimsDeps {
  /** The office's git, attached by the `git.version` load step (DIPO-31). */
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  /** The story store; the claim commit is one story lane edit. */
  readonly stories: StoryStore;
  readonly onChanged?: (office: OfficeId) => void;
  /** Logs a release step that failed (the daemon's logger); nothing by default. */
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
  /** Logs the branch-read sweep at office load (the daemon's logger); nothing by default. */
  readonly info?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
  /**
   * The daemon start as wall-clock time (epoch ms, from its clock), compared with file mtimes:
   * scratch directories older than this, less `SWEEP_MARGIN_MS`, are swept. Defaults to the
   * clock time of the first office load.
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
      // The root itself when it could not be listed, else one scratch directory.
      this.#deps.warn?.("branch-read sweep failed", {
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
   * Removes the clean story worktrees an earlier binary left and lists the others on the desk
   * (`leftovers.ts`), and logs what it did. Never refuses the office: a failure is logged and the
   * load goes on.
   */
  async sweepLeftovers(ctx: OfficeLoadContext): Promise<void> {
    const git = this.#deps.git(ctx.officeId);
    if (git === undefined) return;
    try {
      // Without a valid configuration the defaults decide: they name only build caches.
      const rebuildable = ctx.config?.worktree.rebuildable ?? OFFICE_DEFAULTS.worktree.rebuildable;
      const swept = await sweepLeftoverWorktrees(git, rebuildable);
      recordKeptWorktrees(ctx.office, swept.kept, ctx.clock);
      if (swept.removed.length > 0 || swept.kept.length > 0) {
        this.#deps.info?.("leftover story worktrees swept", {
          office: ctx.officeId,
          removed: swept.removed,
          kept: swept.kept.map((worktree) => worktree.path),
        });
      }
    } catch (error) {
      this.#deps.warn?.("leftover worktree sweep failed", {
        office: ctx.officeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Attaches a loaded office. Returns the reason the office is refused, or null. */
  attach(ctx: OfficeLoadContext): string | null {
    const git = this.#deps.git(ctx.officeId);
    if (git === undefined) {
      return "the office's git is not attached; the git.version load step must run before the claims";
    }
    this.#offices.set(ctx.officeId, { office: ctx.office, clock: ctx.clock });
    return null;
  }

  /**
   * Rolls back every live claim of a loaded office whose setup never finished (its claim commit
   * is not recorded).
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
    }
  }

  /** Releases a live claim whose worker did not start (see `releaseUnstarted`). */
  releaseUnstarted(officeId: OfficeId, claim: ClaimRecord, reason: string): Promise<void> {
    const loaded = this.#offices.get(officeId);
    const git = this.#deps.git(officeId);
    if (loaded === undefined || git === undefined) {
      return Promise.reject(new Error(`The office ${officeId} is not loaded.`));
    }
    releaseUnstarted(
      {
        officeId,
        office: loaded.office,
        git,
        clock: loaded.clock,
        ...(this.#deps.onChanged === undefined ? {} : { onChanged: this.#deps.onChanged }),
      },
      claim,
      reason,
    );
    return Promise.resolve();
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
        stories: this.#deps.stories,
        clock: loaded.clock,
        ...(this.#deps.onChanged === undefined ? {} : { onChanged: this.#deps.onChanged }),
      },
      request,
    );
  }

  /** The feature module that adds the claims load step. */
  get feature(): FeatureModule {
    return {
      name: "worktree",
      register: (registry) => {
        registry.registerLoadStep(CLAIMS_STEP, async (ctx) => {
          const reason = this.attach(ctx);
          if (reason !== null) return { ok: false, reason };
          this.sweepScratch(ctx);
          await this.sweepLeftovers(ctx);
          await this.recover(ctx.officeId);
          return { ok: true };
        });
      },
    };
  }
}
