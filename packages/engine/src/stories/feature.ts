// The story index as a feature (DIPO-32): an office load step (DIPO-27 seam) that fetches when the
// remote answers and indexes the office's stories, and a poll that fetches every
// `polling.fetchSeconds` and indexes again when `_base` moved. `office.rescan` (DIPO-72) and
// `work.run` (DIPO-48) call `indexStories(office)`. Passes of one office run one at a time.
//
// The load step must run after the git load step (`git.version`), which attaches the office's
// git; the daemon lists this module after `EngineGit.feature`.

import {
  type Clock,
  type IdSource,
  type OfficeId,
  type TimerHandle,
} from "@dipsaus-orchestrator/contract";

import type { BacklogCli } from "../backlog/runner";
import { appendEntries } from "../changelog/log";
import type { FeatureModule } from "../commands/registry";
import { OFFICE_DEFAULTS, type OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import type { OfficeGit } from "../git/office";
import type { Logger } from "../log/logger";

import { type IndexResult, indexStories } from "./index-stories";

/** The load step's name in the registry. */
export const INDEX_STEP = "stories.index";

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

  /** The feature module that adds the `stories.index` load step. */
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

  /** Resolves once the office's running pass or poll, if any, has finished. */
  async whenIdle(office: OfficeId): Promise<void> {
    await this.#offices.get(office)?.busy;
  }

  /** Stops every poll; passes already running finish. */
  stop(): void {
    this.#stopped = true;
    for (const state of this.#offices.values()) this.#cancel(state);
  }

  #track(office: OfficeId, values: Omit<Indexed, "timer" | "sha" | "busy">): Indexed {
    const existing = this.#offices.get(office);
    if (existing !== undefined && existing.office === values.office) {
      existing.fetchSeconds = values.fetchSeconds;
      return existing;
    }
    if (existing !== undefined) this.#cancel(existing);
    const state: Indexed = { ...values, timer: null, sha: null, busy: Promise.resolve() };
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
    if (result.cursor !== undefined) this.#deps.onOfficeChanged?.(office);
    this.#deps.logger?.debug("stories indexed", { office, ...result.stats });
    return result;
  }

  /**
   * At load: fetch when the remote answers (offline, local refs serve), then index. An office
   * whose stories cannot be indexed still loads, with a notice saying why.
   */
  async #loadPass(office: OfficeId, state: Indexed): Promise<void> {
    const git = this.#git(office);
    await git.fetch();
    try {
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
      void this.#serial(state, () => this.#poll(office, state)).finally(() =>
        this.#schedule(office, state),
      );
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
    try {
      const fetched = await this.#git(office).fetch();
      if (!fetched.ok || fetched.baseWorktree === null) return;
      if (!fetched.moved && fetched.baseWorktree.sha === state.sha) return;
      await this.#pass(office, state);
    } catch (error) {
      this.#deps.logger?.warn("polling the office failed", {
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
