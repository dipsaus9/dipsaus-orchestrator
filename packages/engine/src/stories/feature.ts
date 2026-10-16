// The story index as a feature (DIPO-32): an office load step (DIPO-27 seam) that fetches when the
// remote answers and indexes the office's stories, and a poll that fetches every
// `polling.fetchSeconds` and indexes again when `_base` moved. `office.rescan` (DIPO-72) and
// `work.run` (DIPO-48) call `indexStories(office)`. An office command that names a story the office
// does not know fetches and indexes at once through the registered story refresh (DIPO-104), so a
// story merged to the base since the last poll resolves. Passes of one office run one at a time.
//
// The load step must run after the git load step (`git.version`), which attaches the office's
// git; the daemon lists this module after `EngineGit.feature`.

import {
  type Clock,
  type Cursor,
  type IdSource,
  type OfficeId,
  type StoryKey,
  type TimerHandle,
} from "@dipsaus-orchestrator/contract";

import type { BacklogCli } from "../backlog/runner";
import { appendEntries } from "../changelog/log";
import type { FeatureModule } from "../commands/registry";
import { OFFICE_DEFAULTS, type OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import type { OfficeGit } from "../git/office";
import type { Logger } from "../log/logger";
import { background } from "../platform/background";

import { type IndexResult, indexStories, refreshStory, type RefreshOptions } from "./index-stories";

/** The load step's name in the registry. */
export const INDEX_STEP = "stories.index";

/**
 * A refresh does not fetch again when an earlier refresh fetched less than this long ago (DIPO-104),
 * so a client looping on an unknown id fetches at most this often.
 */
export const REFRESH_FETCH_FRESH_MS = 2_000;

export interface StoryIndexDeps {
  /** The office's git once the git load step attached it. */
  readonly git: { forOffice(office: OfficeId): OfficeGit | undefined };
  readonly cli: BacklogCli;
  /**
   * The loaded offices: a poll stops once its office is no longer loaded (forgotten) and reads the
   * configuration in force for its next interval. Without it the poll uses the load's values.
   */
  readonly offices?: {
    get(office: OfficeId): OfficeHandle | undefined;
    config(office: OfficeId): OfficeConfig | undefined;
  };
  /** A pass outside a command appended entries; subscribers catch up. */
  readonly onOfficeChanged?: (office: OfficeId) => void;
  /** Called after each poll whose fetch succeeded (DIPO-35 looks for merged backlog PRs). */
  readonly onPolled?: (office: OfficeId) => void;
  readonly logger?: Logger;
}

interface Indexed {
  readonly office: OfficeHandle;
  readonly clock: Clock;
  readonly ids: IdSource;
  fetchSeconds: number;
  timer: TimerHandle | null;
  /** The `_base` commit the last pass read. */
  sha: string | null;
  /** The last pass that succeeded, for reconcile right after the load pass (DIPO-56). */
  last: IndexResult | null;
  /** The refresh queued or running now, shared by every caller (DIPO-104). */
  refreshing: Promise<void> | null;
  /** When the last refresh that fetched successfully started, or null (DIPO-104). */
  refreshFetchedAt: number | null;
  /** The pass or poll running now; the next one starts after it. */
  busy: Promise<unknown>;
}

export class StoryIndex {
  readonly #deps: StoryIndexDeps;
  readonly #offices = new Map<OfficeId, Indexed>();
  #stopped = false;

  constructor(deps: StoryIndexDeps) {
    this.#deps = deps;
  }

  /** The feature module that adds the `stories.index` load step and story refresh. */
  get feature(): FeatureModule {
    return {
      name: "stories",
      register: (registry) => {
        registry.registerLoadStep(INDEX_STEP, async (ctx) => {
          const state = this.#track(ctx.officeId, {
            office: ctx.office,
            clock: ctx.clock,
            ids: ctx.ids,
            fetchSeconds: fetchSecondsOf(ctx.config),
          });
          await this.#serial(state, () => this.#loadPass(ctx.officeId, state));
          this.#schedule(ctx.officeId, state);
          return { ok: true };
        });
        registry.registerStoryRefresh(INDEX_STEP, (office) => this.refresh(office));
      },
    };
  }

  /**
   * One index pass of a loaded office (for `office.rescan` and `work.run`), after any pass already
   * running. Throws when the office has not loaded, has no base, or the Backlog CLI fails.
   */
  indexStories(office: OfficeId): Promise<IndexResult> {
    const state = this.#offices.get(office);
    if (state === undefined) {
      return Promise.reject(
        new Error(`Office ${office} has not loaded; its stories are not indexed.`),
      );
    }
    return this.#serial(state, () => this.#pass(office, state));
  }

  /**
   * Reads one story of a loaded office again, after any pass already running (DIPO-56): on its
   * branch while claimed, else on `_base`. Called right after the claim commit and a park commit,
   * so the views read the new status at once. Throws when the office has not loaded or the read
   * fails.
   */
  refreshStory(
    office: OfficeId,
    key: StoryKey,
    options: RefreshOptions = {},
  ): Promise<Cursor | undefined> {
    const state = this.#offices.get(office);
    if (state === undefined) {
      return Promise.reject(
        new Error(`Office ${office} has not loaded; its stories are not indexed.`),
      );
    }
    return this.#serial(state, async () => {
      const cursor = await refreshStory(
        {
          office: state.office,
          git: this.#git(office),
          cli: this.#deps.cli,
          clock: state.clock,
          ids: state.ids,
        },
        key,
        options,
      );
      if (cursor !== undefined) this.#deps.onOfficeChanged?.(office);
      return cursor;
    });
  }

  /** The last pass of a loaded office that succeeded, or null (DIPO-56). */
  lastPass(office: OfficeId): IndexResult | null {
    return this.#offices.get(office)?.last ?? null;
  }

  /** Resolves once the office's running pass or poll, if any, has finished. */
  async whenIdle(office: OfficeId): Promise<void> {
    await this.#offices.get(office)?.busy;
  }

  /** Stops every poll; passes already running finish. */
  stop(): void {
    this.#stopped = true;
    for (const state of this.#offices.values()) this.#cancel(state);
  }

  #track(
    office: OfficeId,
    values: Omit<Indexed, "timer" | "sha" | "last" | "refreshing" | "refreshFetchedAt" | "busy">,
  ): Indexed {
    const existing = this.#offices.get(office);
    if (existing !== undefined && existing.office === values.office) {
      existing.fetchSeconds = values.fetchSeconds;
      return existing;
    }
    if (existing !== undefined) this.#cancel(existing);
    const state: Indexed = {
      ...values,
      timer: null,
      sha: null,
      last: null,
      refreshing: null,
      refreshFetchedAt: null,
      busy: Promise.resolve(),
    };
    this.#offices.set(office, state);
    return state;
  }

  #git(office: OfficeId): OfficeGit {
    const git = this.#deps.git.forOffice(office);
    if (git === undefined) {
      throw new Error(`the office's git is not attached; ${INDEX_STEP} runs after git.version`);
    }
    return git;
  }

  #serial<T>(state: Indexed, fn: () => Promise<T>): Promise<T> {
    const run = state.busy.then(fn, fn);
    state.busy = run.catch(() => undefined);
    return run;
  }

  async #pass(office: OfficeId, state: Indexed): Promise<IndexResult> {
    const result = await indexStories({
      office: state.office,
      git: this.#git(office),
      cli: this.#deps.cli,
      clock: state.clock,
      ids: state.ids,
    });
    state.sha = result.sha;
    state.last = result;
    if (result.cursor !== undefined) this.#deps.onOfficeChanged?.(office);
    this.#deps.logger?.debug("stories indexed", { office, ...result.stats });
    for (const unread of result.branchUnread) {
      this.#deps.logger?.warn("a claimed story was read on the base, not its branch", {
        office,
        ...unread,
      });
    }
    return result;
  }

  /**
   * At load: fetch when the remote answers (offline, local refs serve), then index. An office
   * whose stories cannot be indexed still loads, with a notice saying why.
   */
  async #loadPass(office: OfficeId, state: Indexed): Promise<void> {
    try {
      await this.#git(office).fetch();
      await this.#pass(office, state);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.#deps.logger?.warn("stories not indexed", { office, reason });
      state.office.immediate(() =>
        appendEntries(
          state.office,
          [
            {
              type: "engine.notice",
              delta: {
                level: "warn",
                code: "stories.notIndexed",
                text: `dipo could not read the office's stories: ${reason}`,
              },
            },
          ],
          { at: state.clock.now() },
        ),
      );
      this.#deps.onOfficeChanged?.(office);
    }
  }

  #schedule(office: OfficeId, state: Indexed): void {
    if (this.#stopped || state.timer !== null || state.fetchSeconds <= 0) return;
    // An office loaded again since has a new state with its own poll.
    if (this.#offices.get(office) !== state) return;
    state.timer = state.clock.setTimeout(() => {
      state.timer = null;
      background(() => this.#serial(state, () => this.#poll(office, state)), {
        failed: "polling the office failed",
        fields: { office },
        log: (message, fields) => this.#deps.logger?.warn(message, fields),
        settled: () => this.#schedule(office, state),
      });
    }, state.fetchSeconds * 1000);
  }

  /** One poll: fetch, then index when `_base` is at a commit no pass has read yet. */
  async #poll(office: OfficeId, state: Indexed): Promise<void> {
    const offices = this.#deps.offices;
    if (offices !== undefined) {
      if (offices.get(office) === undefined) {
        this.#forget(office, state);
        return;
      }
      state.fetchSeconds = fetchSecondsOf(offices.config(office));
    }
    await this.#fetchAndIndex(office, state, "polling the office failed", () =>
      this.#deps.onPolled?.(office),
    );
  }

  /**
   * The story refresh (DIPO-104): an office command named a story the office does not know, so
   * fetch and index now, after any pass already running, instead of waiting for the next poll.
   * A refresh already queued or running is shared. A fetch that an earlier refresh started less
   * than `REFRESH_FETCH_FRESH_MS` ago is not repeated (polls and the load fetch do not count, so a
   * merge right after a poll is seen); `_base` is still read when no pass has read its
   * commit. Never throws; an office that has not loaded is left alone.
   */
  refresh(office: OfficeId): Promise<void> {
    const state = this.#offices.get(office);
    if (state === undefined) return Promise.resolve();
    if (state.refreshing !== null) return state.refreshing;
    const run = this.#serial(state, () => this.#refresh(office, state)).finally(() => {
      state.refreshing = null;
    });
    state.refreshing = run;
    return run;
  }

  async #refresh(office: OfficeId, state: Indexed): Promise<void> {
    const failed = "refreshing the office's stories failed";
    try {
      const startedAt = state.clock.now();
      const recent = state.refreshFetchedAt;
      if (recent === null || startedAt - recent >= REFRESH_FETCH_FRESH_MS) {
        await this.#fetchAndIndex(office, state, failed, () => {
          state.refreshFetchedAt = startedAt;
        });
        return;
      }
      const base = await this.#git(office).ensureBaseWorktree();
      if (base.sha !== state.sha) await this.#pass(office, state);
    } catch (error) {
      this.#deps.logger?.warn(failed, {
        office,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Fetch, then index when `_base` is at a commit no pass has read yet. `fetched` runs after a
   * fetch that succeeded. A failure is logged, never thrown.
   */
  async #fetchAndIndex(
    office: OfficeId,
    state: Indexed,
    failed: string,
    fetched?: () => void,
  ): Promise<void> {
    try {
      const outcome = await this.#git(office).fetch();
      if (outcome.ok) fetched?.();
      if (!outcome.ok || outcome.baseWorktree === null) return;
      if (!outcome.moved && outcome.baseWorktree.sha === state.sha) return;
      await this.#pass(office, state);
    } catch (error) {
      this.#deps.logger?.warn(failed, {
        office,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #forget(office: OfficeId, state: Indexed): void {
    this.#cancel(state);
    state.fetchSeconds = 0;
    if (this.#offices.get(office) === state) this.#offices.delete(office);
  }

  #cancel(state: Indexed): void {
    if (state.timer !== null) state.clock.clearTimeout(state.timer);
    state.timer = null;
  }
}

function fetchSecondsOf(config: OfficeConfig | undefined): number {
  return (config ?? OFFICE_DEFAULTS).polling.fetchSeconds;
}
