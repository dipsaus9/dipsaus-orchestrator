// Claims per office (DIPO-38), and their office load step (DIPO-27 seam): when an office loads,
// the run-start snapshot of every live claim's worktree is pinned on the office's git again, so
// the refusal of git calls in a tampered worktree (0008 section 2) survives a daemon restart. The
// step must run after `git.version`, which attaches the office's git, so the daemon registers
// this feature right after `EngineGit.feature`. `work.run` (DIPO-48) calls `claim`.

import type { Clock, OfficeId } from "@dipsaus-orchestrator/contract";

import type { BacklogCli } from "../backlog/runner";
import type { FeatureModule } from "../commands/registry";
import type { OfficeHandle } from "../db/office";
import type { OfficeGit } from "../git/office";
import type { OfficeLoadContext } from "../office/steps";
import { type DiskProbe, systemDiskProbe } from "../platform/disk";

import { claimStory, type ClaimOutcome, type ClaimRequest, type ClaimSetupDone } from "./claim";
import { liveClaims } from "./records";

/** The load step's name in the registry. */
export const CLAIMS_STEP = "worktree.claims";

export interface StoryClaimsDeps {
  /** The office's git, attached by the `git.version` load step (DIPO-31). */
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  /** How the Backlog CLI starts in a story worktree. */
  readonly cli: BacklogCli;
  /** The free-space probe; the real `statfs` by default. */
  readonly disk?: DiskProbe;
  readonly onChanged?: (office: OfficeId) => void;
}

interface Loaded {
  readonly office: OfficeHandle;
  readonly clock: Clock;
}

export class StoryClaims {
  readonly #deps: StoryClaimsDeps;
  readonly #offices = new Map<OfficeId, Loaded>();

  constructor(deps: StoryClaimsDeps) {
    this.#deps = deps;
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
        registry.registerLoadStep(CLAIMS_STEP, (ctx) => {
          const reason = this.attach(ctx);
          return reason === null ? { ok: true } : { ok: false, reason };
        });
      },
    };
  }
}
