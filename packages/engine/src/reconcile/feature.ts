// Reconcile as a feature (DIPO-56, 0007 section 6, 0006 decision 7). Its office load step
// `reconcile` runs last, after the claims, the story index's load pass and the scan, and compares
// that pass with the database (`reconcileOffice`). The daemon loads every registered office in its
// `recovering` state, so reconcile of every office finishes before the daemon enters `running`
// and turns scheduling on; an office loaded later reconciles before its first command runs.
// `office.rescan` (DIPO-72) calls `reconcile` after its index pass.
//
// The office's `office.json` is checked against the office id at load (`OfficeManager`) and again
// here on every rescan: a marker that names another office refuses the office with a notice.
// Reconciles of one office run one at a time. A reconcile that fails puts a notice on the office;
// the office still loads.
//
// After the compare, reconcile looks on the code host for an open backlog PR (`dipo/backlog-*`)
// the database does not know, as after a lost database, and adopts it (DIPO-80,
// `BacklogPrs.adopt`). Adoption that fails puts its own notice on the office; the reconcile stands.

import type { Clock, OfficeId } from "@dipsaus-orchestrator/contract";

import { appendEntries } from "../changelog/log";
import type { FeatureModule } from "../commands/registry";
import type { OfficeHandle } from "../db/office";
import type { OfficeGit } from "../git/office";
import type { CodeHost, PrStateHost } from "../platform/host";
import type { Logger } from "../log/logger";
import { readMarker } from "../office/marker";
import type { IndexResult } from "../stories/index-stories";
import type { ClaimRecord } from "../worktree/records";
import type { SlotTable } from "../worktree/slots";

import {
  RECONCILE_NOTICES,
  reconcileOffice,
  type ReconcileReport,
  type ReconcileRuns,
  type ReconcileTrigger,
} from "./reconcile";

/** The load step's name in the registry. */
export const RECONCILE_STEP = "reconcile";

export interface ReconcilerDeps {
  /** The office's git, attached by the `git.version` load step. */
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  /** The story index: its load pass, and a new pass when reconcile changed a claim. */
  readonly stories: {
    indexStories(office: OfficeId): Promise<IndexResult>;
    lastPass(office: OfficeId): IndexResult | null;
  };
  /** The run control; without it runs are ended in the database only. */
  readonly runs?: ReconcileRuns;
  /** Releases a claim whose worker never started (`StoryClaims.releaseUnstarted`). */
  readonly releaseClaim?: (office: OfficeId, claim: ClaimRecord, reason: string) => Promise<void>;
  /**
   * Adopts an open backlog PR the database does not know (DIPO-80, `BacklogPrs.adopt`). It puts
   * its own notices on the office.
   */
  readonly adoptBacklogPr?: (office: OfficeId) => Promise<unknown>;
  /** Refuses a loaded office whose marker names another office (`OfficeManager.refuse`). */
  readonly refuse?: (office: OfficeId, text: string) => void;
  /** The machine-wide port slot table; the slot of a claim released as Done on the base is freed. */
  readonly slots?: SlotTable;
  /** Closes dipo's open story PR of a story Done elsewhere (DIPO-161). */
  readonly host?: Pick<CodeHost, "closePr"> | null;
  /** Where the one Done check reads the merged PR of a claim's branch (DIPO-363). */
  readonly prs?: PrStateHost | null;
  /** Checks and deletes the boxes of ended runs after a release (0021 section 6). */
  readonly finishBoxes?: () => Promise<unknown>;
  /** Reconcile appended entries outside a command; subscribers catch up. */
  readonly onOfficeChanged?: (office: OfficeId) => void;
  readonly logger?: Logger;
}

interface Tracked {
  readonly office: OfficeHandle;
  readonly clock: Clock;
  readonly commonDir: string;
  busy: Promise<unknown>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Reconciler {
  readonly #deps: ReconcilerDeps;
  readonly #offices = new Map<OfficeId, Tracked>();

  constructor(deps: ReconcilerDeps) {
    this.#deps = deps;
  }

  /** The feature module with the `reconcile` load step; register it after every other one. */
  get feature(): FeatureModule {
    return {
      name: "reconcile",
      register: (registry) => {
        registry.registerLoadStep(RECONCILE_STEP, async (ctx) => {
          const state: Tracked = {
            office: ctx.office,
            clock: ctx.clock,
            commonDir: ctx.commonDir,
            busy: this.#offices.get(ctx.officeId)?.busy ?? Promise.resolve(),
          };
          this.#offices.set(ctx.officeId, state);
          await this.#serial(state, () => this.#run(ctx.officeId, state, "start"));
          return { ok: true };
        });
      },
    };
  }

  /**
   * Reconciles a loaded office again (`office.rescan`), after any reconcile already running.
   * Resolves to null when the office is not loaded, or was refused because its `office.json`
   * names another office.
   */
  reconcile(office: OfficeId): Promise<ReconcileReport | null> {
    const state = this.#offices.get(office);
    if (state === undefined) return Promise.resolve(null);
    return this.#serial(state, async () => {
      const marker = readMarker(state.commonDir);
      const named = marker.kind === "marker" ? marker.marker.officeId : null;
      if (named !== office) {
        const found =
          named !== null
            ? `names office ${named}`
            : marker.kind === "none"
              ? "is missing"
              : "is not a valid marker";
        this.#notice(
          office,
          state,
          RECONCILE_NOTICES.markerMismatch,
          `The repository's office.json ${found}, not this office (${office}); dipo refused the office. Run \`dipo office open\` there to register it again.`,
          "error",
        );
        this.#offices.delete(office);
        this.#deps.refuse?.(
          office,
          `Office ${office} was refused: its office.json ${found}. Run \`dipo office open\` in the repository to register it again.`,
        );
        return null;
      }
      return this.#run(office, state, "rescan");
    });
  }

  /** Resolves once the office's running reconcile, if any, has finished. */
  async whenIdle(office: OfficeId): Promise<void> {
    await this.#offices.get(office)?.busy;
  }

  #serial<T>(state: Tracked, fn: () => Promise<T>): Promise<T> {
    const run = state.busy.then(fn, fn);
    state.busy = run.catch(() => undefined);
    return run;
  }

  async #run(
    office: OfficeId,
    state: Tracked,
    trigger: ReconcileTrigger,
  ): Promise<ReconcileReport | null> {
    try {
      const git = this.#deps.git(office);
      if (git === undefined) throw new Error("the office's git is not attached");
      // The load pass, or the rescan's pass, ran just before; a missing one runs now.
      const pass =
        this.#deps.stories.lastPass(office) ?? (await this.#deps.stories.indexStories(office));
      const releaseClaim = this.#deps.releaseClaim;
      const report = await reconcileOffice(
        {
          officeId: office,
          office: state.office,
          git,
          clock: state.clock,
          ...(this.#deps.runs === undefined ? {} : { runs: this.#deps.runs }),
          ...(this.#deps.slots === undefined ? {} : { slots: this.#deps.slots }),
          ...(this.#deps.host === undefined ? {} : { host: this.#deps.host }),
          ...(this.#deps.prs === undefined ? {} : { prs: this.#deps.prs }),
          ...(this.#deps.finishBoxes === undefined ? {} : { finishBoxes: this.#deps.finishBoxes }),
          ...(releaseClaim === undefined
            ? {}
            : { releaseClaim: (claim, reason) => releaseClaim(office, claim, reason) }),
        },
        { trigger, pass, reindex: () => this.#deps.stories.indexStories(office) },
      );
      if (report.findings.length > 0) this.#deps.onOfficeChanged?.(office);
      await this.#adopt(office, state, trigger);
      this.#deps.logger?.info("office reconciled", {
        office,
        trigger,
        findings: report.findings.map((finding) => finding.code),
      });
      return report;
    } catch (error) {
      const reason = messageOf(error);
      this.#deps.logger?.warn("reconcile failed", { office, trigger, reason });
      this.#notice(
        office,
        state,
        RECONCILE_NOTICES.failed,
        `dipo could not reconcile its database with Backlog.md and git: ${reason}`,
        "warn",
      );
      return null;
    }
  }

  /** Adopts an unknown open backlog PR; a failure is a notice and leaves the reconcile standing. */
  async #adopt(office: OfficeId, state: Tracked, trigger: ReconcileTrigger): Promise<void> {
    const adopt = this.#deps.adoptBacklogPr;
    if (adopt === undefined) return;
    try {
      await adopt(office);
    } catch (error) {
      const reason = messageOf(error);
      this.#deps.logger?.warn("adopting the backlog PR failed", { office, trigger, reason });
      this.#notice(
        office,
        state,
        RECONCILE_NOTICES.adoptFailed,
        `dipo could not look for an open backlog PR to adopt: ${reason}. It looks again at the next rescan.`,
        "warn",
      );
    }
  }

  #notice(
    office: OfficeId,
    state: Tracked,
    code: string,
    text: string,
    level: "warn" | "error",
  ): void {
    state.office.immediate(() =>
      appendEntries(state.office, [{ type: "engine.notice", delta: { level, code, text } }], {
        at: state.clock.now(),
      }),
    );
    this.#deps.onOfficeChanged?.(office);
  }
}
