// The run profile as a feature (DIPO-72, 0013 sections 2, 4 and 5; 0007 sections 4 and 6). It
// adds the `scan.profile` office load step, which computes the fingerprint on `_base` and runs
// detection only on a mismatch, and the `office.rescan` command, which fetches, re-indexes the
// stories (DIPO-32) and always runs detection. `work.run` (DIPO-48) calls `ensureFreshProfile`
// first and `verifyResolved` for its refusal. Scans of one office run one at a time. M0 scans
// are code only: no model is asked (0013 amendment of 2026-10-11).
//
// The load step must run after the story index's (`stories.index`), which fetched the remote;
// the daemon lists this module after `StoryIndex.feature`.

import {
  type Clock,
  type OfficeId,
  officeRescan,
  type RequestId,
} from "@dipsaus-orchestrator/contract";

import { appendEntries, type NewEntry } from "../changelog/log";
import { CommandError } from "../commands/errors";
import type { FeatureModule } from "../commands/registry";
import type { OfficeHandle } from "../db/office";
import type { OfficeGit } from "../git/office";
import type { Logger } from "../log/logger";
import { createRepoFiles, type RepoFiles } from "../platform/repo-files";

import { detect, fingerprint, type Probe, readProbe, type RunProfile } from "./detect";
import { diffProfiles, profileScripts } from "./diff";
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

export interface RunProfilesDeps {
  /** The office's git once the git load step attached it. */
  readonly git: { forOffice(office: OfficeId): OfficeGit | undefined };
  /** The story index, which `office.rescan` runs again. */
  readonly stories?: { indexStories(office: OfficeId): Promise<unknown> };
  /** The file facts of a checkout; git-backed by default. */
  readonly files?: (dir: string) => RepoFiles;
  /** Detection; the pure DIPO-33 `detect` by default. Tests count its calls. */
  readonly detect?: (probe: Probe) => RunProfile;
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

  constructor(deps: RunProfilesDeps) {
    this.#deps = deps;
  }

  /** The feature module with the `scan.profile` load step and `office.rescan`. */
  get feature(): FeatureModule {
    return {
      name: "scan",
      register: (registry) => {
        registry.registerLoadStep(SCAN_STEP, async (ctx) => {
          const state = this.#track(ctx.officeId, ctx.office, ctx.clock, ctx.path);
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
            void this.#serial(state, () => this.#rescan(office, state, ctx.requestId)).finally(
              () => {
                this.#rescanning.delete(office);
              },
            );
            return { result: { scan: "started" as const }, changed: false };
          },
        });
      },
    };
  }

  /**
   * Before each `work.run` (DIPO-48): computes the fingerprint on `_base` and, when it differs
   * from the current profile's, runs detection and stores the new profile with its diff. An
   * unchanged fingerprint runs no detection. Throws when the office has not loaded or the scan
   * fails (no base, for example); the failure is recorded as a scan.
   */
  ensureFreshProfile(office: OfficeId): Promise<ScanOutcome> {
    const state = this.#offices.get(office);
    if (state === undefined) {
      return Promise.reject(new Error(`Office ${office} has not loaded; it has no run profile.`));
    }
    return this.#serial(state, () =>
      this.#scanOrRecord(office, state, { trigger: "run", force: false }),
    );
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
        await this.#deps.stories
          .indexStories(office)
          .catch((error: unknown) =>
            warnings.push(`The stories were not indexed again: ${reasonOf(error)}`),
          );
      }
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

    const profile = (this.#deps.detect ?? detect)(await this.#withMainPresence(state, probe));
    const at = state.clock.now();
    const outcome = state.office.immediate((): ScanOutcome => {
      const previous = currentProfile(state.office);
      const diff = diffProfiles(previous?.profile ?? null, profile);
      const unchanged =
        previous !== null &&
        diff.length === 0 &&
        previous.profile.fingerprint === profile.fingerprint;
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
          scripts: profileScripts(profile),
          warnings: [
            ...(options.warnings ?? []),
            ...profile.conformance.deviations.map((d) => d.message),
          ],
          trigger: options.trigger,
          level: profile.conformance.level,
          deviations: profile.conformance.deviations.map((d) => d.message),
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
