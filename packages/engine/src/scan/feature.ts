// The run profile as a feature (DIPO-72, 0013 sections 2, 4 and 5; 0007 sections 4 and 6). It
// adds the `scan.profile` office load step, which computes the fingerprint on `_base` and runs
// detection only on a mismatch, and the `office.rescan` command, which fetches, re-indexes the
// stories (DIPO-32), reconciles them (DIPO-56) and always runs detection. `work.run` (DIPO-48) calls `ensureFreshProfile`
// first and `verifyResolved` for its refusal. Scans of one office run one at a time. A scan is
// code only: no model is asked (0013 amendment of 2026-10-11).
//
// DIPO-310 adds the maintainer's side (0013 section 6 and its amendment of 2026-10-22):
// `office.infer` starts the fallback session (`fallback.ts`) only when the maintainer asks,
// `office.confirm` accepts, edits, rejects or sets a capability (`confirm-command.ts`), and
// `office.profile` lists the profile (`profile-view.ts`). A scan lays the confirmations over what
// code detected: they carry into the new profile, turn stale on a fingerprint change and are
// removed, with a diff line, once code resolves their capability (`confirm.ts`).
//
// The load step must run after the story index's (`stories.index`), which fetched the remote;
// the daemon lists this module after `StoryIndex.feature`.

import {
  type Clock,
  type OfficeId,
  officeConfirm,
  officeInfer,
  officeProfile,
  officeRescan,
  type RequestId,
} from "@dipsaus-orchestrator/contract";

import { appendEntries, type NewEntry } from "../changelog/log";
import { CommandError } from "../commands/errors";
import { OFFICE_DEFAULTS } from "../config";
import type { FeatureModule } from "../commands/registry";
import type { OfficeHandle } from "../db/office";
import type { OfficeGit } from "../git/office";
import type { Logger } from "../log/logger";
import { background } from "../platform/background";
import { createRepoFiles, type RepoFiles } from "../git/repo-files";

import { applyConfirm } from "./confirm-command";
import { effectiveProfile, mootProposals, staleLines, supersededConfirmations } from "./confirm";
import {
  detect,
  type DetectOptions,
  fingerprint,
  type Probe,
  readProbe,
  type RunProfile,
} from "./detect";
import { diffProfiles, profileScripts } from "./diff";
import { readBaseEvidence } from "./evidence-read";
import {
  endLostScanSessions,
  ScanFallback,
  type ScanFallbackDeps,
  type ScanSessionRunner,
  type ScanSessionSettings,
} from "./fallback";
import { deleteConfirmation, deleteProposal, readMarks } from "./marks";
import { profileView } from "./profile-view";
import {
  currentFingerprint,
  currentProfile,
  insertProfile,
  insertScan,
  type ScanTrigger,
  type StoredProfile,
  verifyResolved,
} from "./store";

/** The load step's name in the registry. */
export const SCAN_STEP = "scan.profile";

/** The `scan` block's defaults (0013 amendment of 2026-10-22), for an office without a config. */
export const SCAN_DEFAULTS: Omit<ScanSessionSettings, "maxTurns"> = OFFICE_DEFAULTS.scan;

export interface RunProfilesDeps {
  /** The office's git once the git load step attached it. */
  readonly git: { forOffice(office: OfficeId): OfficeGit | undefined };
  /** The story index, which `office.rescan` runs again. */
  readonly stories?: { indexStories(office: OfficeId): Promise<unknown> };
  /** Reconcile (DIPO-56), which `office.rescan` runs after a successful index pass. */
  readonly reconcile?: (office: OfficeId) => Promise<unknown>;
  /** Reads the configuration again when `.dipo/office.yaml` changed on the base (DIPO-303). */
  readonly reloadConfig?: (office: OfficeId) => Promise<unknown>;
  /** The file facts of a checkout; git-backed by default. */
  readonly files?: (dir: string) => RepoFiles;
  /** Detection; the pure DIPO-33 `detect` by default. Tests count its calls. */
  readonly detect?: (probe: Probe, options?: DetectOptions) => RunProfile;
  /**
   * The fallback session's runner (DIPO-310): the Claude one of `run/session-run.ts` in the
   * daemon. Without it `office.infer` reports that no session can run.
   */
  readonly fallback?: () => ScanSessionRunner | undefined;
  /** The office's `scan` block in force; the defaults without one. */
  readonly scanSettings?: (office: OfficeId) => Omit<ScanSessionSettings, "maxTurns"> | undefined;
  /** Why no new session starts in the office now (its starts paused, 0020); null when it may. */
  readonly startsPaused?: (office: OfficeId) => string | null;
  /** A fallback session met the plan limit: the office's starts pause until `resetsAt` (ms). */
  readonly pausePlanLimit?: ScanFallbackDeps["pausePlanLimit"];
  /** How long a waiting fallback session waits before it looks again; a test seam. */
  readonly fallbackPollMs?: number;
  /** A scan outside a command appended entries; subscribers catch up. */
  readonly onOfficeChanged?: (office: OfficeId) => void;
  readonly logger?: Logger;
}

/** What one scan did. */
export interface ScanOutcome {
  /** The current profile after the scan. */
  readonly profile: StoredProfile;
  /** False when the fingerprint matched and no detection ran. */
  readonly detected: boolean;
  /** The facts that changed against the previous profile; empty when nothing changed. */
  readonly diff: readonly string[];
}

interface Tracked {
  readonly office: OfficeHandle;
  readonly clock: Clock;
  /** The main checkout, where env file presence is checked (0013 section 4). */
  readonly path: string;
  /** The scan running now; the next one starts after it. */
  busy: Promise<unknown>;
}

interface ScanOptions {
  readonly trigger: ScanTrigger;
  /** Run detection even when the fingerprint matches (`office.rescan`). */
  readonly force: boolean;
  /** Warnings gathered before the scan, reported with it. */
  readonly warnings?: readonly string[];
  /** The `office.rescan` request that started it. */
  readonly causedBy?: RequestId;
}

const logOptions = (at: number, options: ScanOptions) =>
  options.causedBy === undefined ? { at } : { at, causedBy: options.causedBy };

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class RunProfiles {
  readonly #deps: RunProfilesDeps;
  readonly #offices = new Map<OfficeId, Tracked>();
  /** Offices with an `office.rescan` running; kept by id, so a reload of the office keeps it. */
  readonly #rescanning = new Set<OfficeId>();
  readonly #fallback: ScanFallback;

  constructor(deps: RunProfilesDeps) {
    this.#deps = deps;
    this.#fallback = new ScanFallback({
      ...(deps.fallback === undefined ? {} : { runner: deps.fallback }),
      settings: (office) => deps.scanSettings?.(office) ?? SCAN_DEFAULTS,
      ...(deps.startsPaused === undefined ? {} : { startsPaused: deps.startsPaused }),
      ...(deps.pausePlanLimit === undefined ? {} : { pausePlanLimit: deps.pausePlanLimit }),
      readBase: (office) => this.#readBase(office),
      ...(deps.onOfficeChanged === undefined ? {} : { onOfficeChanged: deps.onOfficeChanged }),
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
      ...(deps.fallbackPollMs === undefined ? {} : { pollMs: deps.fallbackPollMs }),
    });
  }

  /** The fallback sessions (DIPO-310). */
  get fallback(): ScanFallback {
    return this.#fallback;
  }

  /** At daemon stop: stops the fallback's waits and its running sessions. Never rejects. */
  close(): Promise<void> {
    return this.#fallback.close();
  }

  /** The feature module with the `scan.profile` load step and `office.rescan`. */
  get feature(): FeatureModule {
    return {
      name: "scan",
      register: (registry) => {
        registry.registerLoadStep(SCAN_STEP, async (ctx) => {
          const state = this.#track(ctx.officeId, ctx.office, ctx.clock, ctx.path);
          // A fallback session a stopped daemon left open would keep the office busy (DIPO-310).
          if (!this.#fallback.inferring(ctx.officeId)) {
            const lost = endLostScanSessions(ctx.office, ctx.clock.now());
            if (lost.length > 0) {
              this.#deps.logger?.info("ended scan sessions a stopped daemon left", {
                office: ctx.officeId,
                runs: lost,
              });
            }
          }
          await this.#serial(state, () => this.#loadScan(ctx.officeId, state));
          return { ok: true };
        });
        registry.addOfficeCommand({
          definition: officeRescan,
          handle: (ctx) => {
            const office = ctx.office.officeId;
            const state = this.#offices.get(office);
            if (state === undefined) throw new Error(`Office ${office} has not loaded its scan.`);
            if (this.#rescanning.has(office)) {
              throw new CommandError(
                "scan.running",
                "A rescan of this office is already running; its result arrives as scan.finished.",
              );
            }
            this.#rescanning.add(office);
            // The scan starts once this command's transaction has committed and replied.
            background(
              () => this.#serial(state, () => this.#rescan(office, state, ctx.requestId)),
              {
                failed: "rescanning the office failed",
                fields: { office },
                log: (message, fields) => this.#deps.logger?.warn(message, fields),
                settled: () => this.#rescanning.delete(office),
              },
            );
            return { result: { scan: "started" as const }, changed: false };
          },
        });
        // The fallback starts only here, when the maintainer asks (0013 amendment of 2026-10-22).
        registry.addOfficeCommand({
          definition: officeInfer,
          handle: (ctx) => ({
            result: this.#fallback.infer(ctx.office.officeId, ctx.office, ctx.clock),
            changed: false,
          }),
        });
        registry.addOfficeCommand({
          definition: officeConfirm,
          handle: (ctx, args) => {
            const outcome = applyConfirm(ctx.office, args, ctx.now);
            ctx.emit(outcome.entry);
            return { result: outcome.result, changed: true };
          },
        });
        registry.addRead({
          definition: officeProfile,
          handle: (ctx, args) => {
            if (ctx.office === undefined) throw new Error("office.profile runs with its office");
            return profileView(args.office, ctx.office, this.#fallback.inferring(args.office));
          },
        });
      },
    };
  }

  /** dipo's base copy of the office: its file list and evidence texts (0021 amendment, DIPO-310). */
  async #readBase(office: OfficeId) {
    const git = this.#git(office);
    const base = await git.ensureBaseWorktree();
    // One queue item, so no fetch moves `_base` while it is read.
    return git.run(async () => readBaseEvidence(base.path, this.#files(base.path)));
  }

  /**
   * Before each `work.run` (DIPO-48) and each `test.start` (DIPO-309, trigger `test`): computes the
   * fingerprint on `_base` and, when it differs from the current profile's, runs detection and
   * stores the new profile with its diff. An unchanged fingerprint runs no detection. Throws when
   * the office has not loaded or the scan fails (no base, for example); the failure is recorded as
   * a scan.
   */
  ensureFreshProfile(office: OfficeId, trigger: "run" | "test" = "run"): Promise<ScanOutcome> {
    const state = this.#offices.get(office);
    if (state === undefined) {
      return Promise.reject(new Error(`Office ${office} has not loaded; it has no run profile.`));
    }
    return this.#serial(state, () => this.#scanOrRecord(office, state, { trigger, force: false }));
  }

  /**
   * The refusal `work.run` gives when the office's verify is unresolved, naming the script to
   * add; null when verify resolved (0013 section 2). Reads the stored profile only.
   */
  verifyResolved(office: OfficeHandle): string | null {
    return verifyResolved(office);
  }

  /** Resolves once the office's running scan, if any, has finished. */
  async whenIdle(office: OfficeId): Promise<void> {
    await this.#offices.get(office)?.busy;
  }

  #track(office: OfficeId, handle: OfficeHandle, clock: Clock, path: string): Tracked {
    const existing = this.#offices.get(office);
    if (existing !== undefined && existing.office === handle && existing.path === path) {
      return existing;
    }
    const state: Tracked = {
      office: handle,
      clock,
      path,
      busy: existing?.busy ?? Promise.resolve(),
    };
    this.#offices.set(office, state);
    return state;
  }

  #serial<T>(state: Tracked, fn: () => Promise<T>): Promise<T> {
    const run = state.busy.then(fn, fn);
    state.busy = run.catch(() => undefined);
    return run;
  }

  #git(office: OfficeId): OfficeGit {
    const git = this.#deps.git.forOffice(office);
    if (git === undefined) {
      throw new Error(`the office's git is not attached; ${SCAN_STEP} runs after git.version`);
    }
    return git;
  }

  #files(dir: string): RepoFiles {
    return (this.#deps.files ?? createRepoFiles)(dir);
  }

  /** At load: an office whose profile cannot be scanned still loads, with a notice saying why. */
  async #loadScan(office: OfficeId, state: Tracked): Promise<void> {
    try {
      await this.#scanOrRecord(office, state, { trigger: "start", force: false });
    } catch (error) {
      this.#notice(
        office,
        state,
        `dipo could not scan the office's run profile: ${reasonOf(error)}`,
      );
    }
  }

  /** `office.rescan`: fetch, re-index the stories, then scan with detection forced. */
  async #rescan(office: OfficeId, state: Tracked, causedBy: RequestId): Promise<void> {
    const warnings: string[] = [];
    try {
      const fetched = await this.#git(office).fetch();
      if (!fetched.ok) warnings.push(`${fetched.error.message} The scan used local refs.`);
      if (this.#deps.stories !== undefined) {
        const indexed = await this.#deps.stories.indexStories(office).then(
          () => true,
          (error: unknown) => {
            warnings.push(`The stories were not indexed again: ${reasonOf(error)}`);
            return false;
          },
        );
        // Reconcile compares that pass with the database; it reports its own failure.
        if (indexed) await this.#deps.reconcile?.(office);
      }
      await this.#deps.reloadConfig?.(office);
    } catch (error) {
      warnings.push(reasonOf(error));
    }
    // A failed scan is recorded and reported as `scan.finished` with `error`.
    await this.#scanOrRecord(office, state, {
      trigger: "rescan",
      force: true,
      warnings,
      causedBy,
    }).catch((error: unknown) => {
      this.#deps.logger?.warn("rescan failed", { office, reason: reasonOf(error) });
    });
  }

  /** One scan; a failure is recorded in `scans` (and reported by a rescan) and thrown. */
  async #scanOrRecord(
    office: OfficeId,
    state: Tracked,
    options: ScanOptions,
  ): Promise<ScanOutcome> {
    const startedAt = state.clock.now();
    try {
      return await this.#scan(office, state, options, startedAt);
    } catch (error) {
      const reason = reasonOf(error);
      const at = state.clock.now();
      state.office.immediate(() => {
        insertScan(state.office, {
          trigger: options.trigger,
          startedAt,
          finishedAt: at,
          fingerprint: null,
          commit: null,
          result: "failed",
          profileId: null,
          diff: null,
          error: reason,
        });
        if (options.trigger === "rescan") {
          appendEntries(
            state.office,
            [
              {
                type: "scan.finished",
                delta: {
                  scripts: {},
                  warnings: [...(options.warnings ?? [])],
                  trigger: options.trigger,
                  error: reason,
                },
              },
            ],
            logOptions(at, options),
          );
        }
      });
      if (options.trigger === "rescan") this.#deps.onOfficeChanged?.(office);
      throw error;
    }
  }

  async #scan(
    office: OfficeId,
    state: Tracked,
    options: ScanOptions,
    startedAt: number,
  ): Promise<ScanOutcome> {
    const git = this.#git(office);
    const base = await git.ensureBaseWorktree();
    // One queue item, so no fetch moves `_base` while it is read.
    const { commit, probe } = await git.run(async (session) => {
      const location = git.worktreeLocation(base.path);
      const sha = (await session.ok(location, ["rev-parse", "--verify", "HEAD"])).trim();
      return { commit: sha, probe: await readProbe(base.path, this.#files(base.path)) };
    });
    const print = fingerprint(probe);
    if (!options.force && currentFingerprint(state.office) === print) {
      const current = currentProfile(state.office);
      if (current !== null) return { profile: current, detected: false, diff: [] };
    }

    const nothingToStart = readMarks(state.office).nothingToStart;
    const profile = (this.#deps.detect ?? detect)(await this.#withMainPresence(state, probe), {
      nothingToStart,
    });
    const at = state.clock.now();
    const outcome = state.office.immediate((): ScanOutcome => {
      const previous = currentProfile(state.office);
      // The confirmations lay over the new profile (DIPO-310): one whose capability code now
      // resolves is removed with a diff line, and one made at another fingerprint turns stale.
      const marks = readMarks(state.office);
      const superseded = supersededConfirmations(profile, marks);
      for (const { capability } of superseded) deleteConfirmation(state.office, capability);
      for (const capability of mootProposals(profile, marks))
        deleteProposal(state.office, capability);
      const stale = staleLines(previous?.code.fingerprint ?? null, profile.fingerprint, marks);
      const effective = effectiveProfile(profile, readMarks(state.office)).profile;
      const codeDiff = diffProfiles(previous?.code ?? null, profile);
      const diff = [
        ...diffProfiles(previous?.profile ?? null, effective),
        ...superseded.map((s) => s.line),
        ...stale,
      ];
      const unchanged =
        previous !== null &&
        codeDiff.length === 0 &&
        diff.length === 0 &&
        previous.code.fingerprint === profile.fingerprint;
      const profileId = unchanged
        ? previous.profileId
        : insertProfile(state.office, profile, { scannedAt: at, commit });
      insertScan(state.office, {
        trigger: options.trigger,
        startedAt,
        finishedAt: at,
        fingerprint: profile.fingerprint,
        commit,
        result: unchanged ? "unchanged" : "stored",
        profileId,
        diff,
        error: null,
      });
      const entry: NewEntry = {
        type: "scan.finished",
        delta: {
          scripts: profileScripts(effective),
          warnings: [
            ...(options.warnings ?? []),
            ...effective.conformance.deviations.map((d) => d.message),
          ],
          trigger: options.trigger,
          level: effective.conformance.level,
          deviations: effective.conformance.deviations.map((d) => d.message),
          diff,
        },
      };
      appendEntries(state.office, [entry], logOptions(at, options));
      const stored = unchanged ? previous : currentProfile(state.office);
      if (stored === null) throw new Error("the stored run profile could not be read back");
      return { profile: stored, detected: true, diff };
    });
    this.#deps.onOfficeChanged?.(office);
    this.#deps.logger?.debug("run profile scanned", {
      office,
      trigger: options.trigger,
      level: profile.conformance.level,
      changes: outcome.diff.length,
    });
    return outcome;
  }

  /**
   * Env file presence is a fact of the main checkout (0013 section 4): `_base` holds no
   * gitignored file. Presence is not part of the fingerprint.
   */
  async #withMainPresence(state: Tracked, probe: Probe): Promise<Probe> {
    const main = this.#files(state.path);
    const envFiles = [];
    for (const file of probe.envFiles) {
      envFiles.push({ ...file, present: await main.exists(file.path) });
    }
    return { ...probe, envFiles };
  }

  #notice(office: OfficeId, state: Tracked, text: string): void {
    this.#deps.logger?.warn("run profile not scanned", { office, reason: text });
    state.office.immediate(() =>
      appendEntries(
        state.office,
        [{ type: "engine.notice", delta: { level: "warn", code: "scan.failed", text } }],
        { at: state.clock.now() },
      ),
    );
    this.#deps.onOfficeChanged?.(office);
  }
}
