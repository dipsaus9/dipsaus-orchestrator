// The story PR (DIPO-144; 0019 section 3). Right after an In Review push the engine looks for an
// open PR with the story branch as head (`findOpenPr`, so a crash between push and create never
// opens a second one) and creates a ready PR, not a draft, when there is none. Every later In
// Review push updates the same PR: the title and body are rebuilt by code, and written to the host
// only when the title or the body's hash changed. The PR is recorded in `story_prs`, and
// `story.pr` is emitted when it opens, changes state or gets a new head.
//
// A failed create is a `pr.openFailed` notice, put once per cause; the story stays In Review. The
// PR poll runs every `polling.prStateSeconds` of the office configuration in force: it reads each
// PR still open on the host (`viewPr`), writes the state and close time of one merged or closed
// there and emits `story.pr` with the new state, then syncs each In Review run that has no PR yet.
// Work for one office runs one piece at a time, and `sync` never throws: whatever went wrong is
// the notice.

import type { Clock, OfficeId, RunId, StoryKey, TimerHandle } from "@dipsaus-orchestrator/contract";

import { appendEntries, type NewEntry } from "../changelog/log";
import type { FeatureModule } from "../commands/registry";
import { OFFICE_DEFAULTS, type OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import type { Logger } from "../log/logger";
import { type CodeHost, CodeHostError, type HostPr, repoOfRemoteUrl } from "../platform/host";
import { findRun } from "../run/records";
import { findStoryByKey } from "../stories/keys";

import { storyPrBodyHash, storyPrBody } from "./body";
import type { StoryPrGit } from "./git";
import {
  findStoryPr,
  insertStoryPr,
  openStoryPrs,
  runsWithoutPr,
  setStoryPrState,
  type StoryPrRecord,
  type StoryPrState,
  updateStoryPr,
} from "./records";
import { storyPrTitle } from "./title";

/** `engine.notice` codes of the story PR. */
export const STORY_PR_NOTICES = {
  opened: "pr.opened",
  openFailed: "pr.openFailed",
} as const;

/** The load step's name in the registry. */
export const STORY_PR_STEP = "story-pr.poll";

export interface StoryPrsDeps {
  readonly host: CodeHost;
  readonly git: StoryPrGit;
  /** The loaded offices and the configuration in force for each next interval. */
  readonly offices: {
    get(office: OfficeId): OfficeHandle | undefined;
    config(office: OfficeId): OfficeConfig | undefined;
  };
  readonly clock: Clock;
  readonly onChanged?: (office: OfficeId) => void;
  readonly logger?: Logger;
}

interface Polled {
  readonly office: OfficeHandle;
  readonly clock: Clock;
  timer: TimerHandle | null;
  busy: Promise<unknown>;
  /** The failure last noticed for each run, so a retry that fails the same way is silent. */
  readonly told: Map<string, string>;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class StoryPrs {
  readonly #deps: StoryPrsDeps;
  readonly #offices = new Map<OfficeId, Polled>();
  #stopped = false;

  constructor(deps: StoryPrsDeps) {
    this.#deps = deps;
  }

  /** The feature module that adds the load step arming the retry poll. */
  get feature(): FeatureModule {
    return {
      name: "story-pr",
      register: (registry) => {
        registry.registerLoadStep(STORY_PR_STEP, (ctx) => {
          this.track(ctx.officeId, ctx.office, ctx.clock);
          this.#schedule(ctx.officeId, ctx.config);
          return { ok: true };
        });
      },
    };
  }

  /** Tracks a loaded office without arming its poll. */
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

  /** Stops every poll; a sync already running finishes. */
  stop(): void {
    this.#stopped = true;
    for (const state of this.#offices.values()) this.#cancel(state);
  }

  /** Opens or updates the PR of a run right after its In Review push. */
  sync(officeId: OfficeId, runId: RunId): Promise<void> {
    const state = this.#state(officeId);
    return this.#serial(state, () => this.#sync(officeId, state, runId));
  }

  /**
   * One pass of the PR poll: reads the state of each PR still open on the host, then syncs each In
   * Review run that has no PR yet. Returns the runs whose PR it tried to open.
   */
  retry(officeId: OfficeId): Promise<RunId[]> {
    const state = this.#state(officeId);
    return this.#serial(state, async () => {
      for (const stored of openStoryPrs(state.office)) await this.#poll(officeId, state, stored);
      const tried: RunId[] = [];
      for (const { runId } of runsWithoutPr(state.office)) {
        tried.push(runId);
        await this.#sync(officeId, state, runId);
      }
      return tried;
    });
  }

  async #sync(officeId: OfficeId, state: Polled, runId: RunId): Promise<void> {
    const office = state.office;
    const run = findRun(office, runId);
    if (run === null || run.key === null || run.worktree === null || run.branch === null) return;
    const key = run.key;
    try {
      const facts = await this.#deps.git.read(officeId, {
        worktree: run.worktree,
        story: run.story as string,
      });
      const repo = facts.remoteUrl === null ? null : repoOfRemoteUrl(facts.remoteUrl);
      if (repo === null) {
        throw new Error(
          `the remote (${facts.remoteUrl ?? "no URL"}) is not a GitHub repository dipo can open a PR on`,
        );
      }
      const title = storyPrTitle(facts.story);
      const body = storyPrBody(facts.story, { head: facts.head });
      const hash = storyPrBodyHash(body);
      const stored = findStoryPr(office, runId);
      if (stored === null) {
        await this.#open(officeId, state, {
          runId,
          story: run.story as string,
          key,
          repo,
          branch: run.branch,
          facts,
          title,
          body,
          hash,
        });
      } else if (stored.state === "open") {
        await this.#update(officeId, state, {
          stored,
          story: run.story as string,
          repo,
          head: facts.head,
          title,
          body,
          hash,
        });
      }
      state.told.delete(runId);
    } catch (error) {
      this.#failed(officeId, state, runId, key, error);
    }
  }

  async #open(
    officeId: OfficeId,
    state: Polled,
    input: {
      runId: RunId;
      story: string;
      key: StoryKey;
      repo: string;
      branch: string;
      facts: { head: string; base: string };
      title: string;
      body: string;
      hash: string;
    },
  ): Promise<void> {
    const host = this.#deps.host;
    let pr: HostPr | null = await host.findOpenPr(input.repo, input.branch);
    // An open PR a crash left: what it holds is not known to match, so it is written once.
    if (pr !== null) {
      await host.updatePr(input.repo, pr.number, { title: input.title, body: input.body });
    }
    pr ??= await host.createPr(input.repo, {
      base: input.facts.base,
      head: input.branch,
      title: input.title,
      body: input.body,
    });
    const opened = pr;
    const record: StoryPrRecord = {
      runId: input.runId,
      key: input.key,
      number: opened.number,
      url: opened.url,
      branch: input.branch,
      base: opened.base === "" ? input.facts.base : opened.base,
      headSha: input.facts.head,
      state: "open",
      title: input.title,
      bodyHash: input.hash,
      openedAt: this.#deps.clock.now(),
      closedAt: null,
    };
    this.#write(officeId, state, () => {
      insertStoryPr(state.office, record);
      return [
        prEntry(record, input.story),
        notice(
          "info",
          STORY_PR_NOTICES.opened,
          `dipo opened PR #${record.number} for ${input.key}: ${record.url}`,
          input.key,
          input.runId,
        ),
      ];
    });
  }

  async #update(
    officeId: OfficeId,
    state: Polled,
    input: {
      stored: StoryPrRecord;
      story: string;
      repo: string;
      head: string;
      title: string;
      body: string;
      hash: string;
    },
  ): Promise<void> {
    const { stored } = input;
    if (stored.title !== input.title || stored.bodyHash !== input.hash) {
      await this.#deps.host.updatePr(input.repo, stored.number, {
        title: input.title,
        body: input.body,
      });
    }
    if (
      stored.title === input.title &&
      stored.bodyHash === input.hash &&
      stored.headSha === input.head
    ) {
      return;
    }
    const next: StoryPrRecord = {
      ...stored,
      headSha: input.head,
      title: input.title,
      bodyHash: input.hash,
    };
    this.#write(officeId, state, () => {
      updateStoryPr(state.office, stored.runId, {
        headSha: input.head,
        title: input.title,
        bodyHash: input.hash,
      });
      // A new head is a change `story.pr` reports; a new body on the same head is not.
      return stored.headSha === input.head ? [] : [prEntry(next, input.story)];
    });
  }

  /**
   * Reads one open PR on the host (`viewPr`). A PR merged or closed there gets its state and close
   * time written and one `story.pr` with the new state; an open PR changes nothing. A failed read is
   * logged and the next poll reads again.
   */
  async #poll(officeId: OfficeId, state: Polled, stored: StoryPrRecord): Promise<void> {
    const repo = repoOfPrUrl(stored.url);
    if (repo === null) {
      this.#deps.logger?.warn("the story PR URL names no repository", {
        office: officeId,
        run: stored.runId,
        url: stored.url,
      });
      return;
    }
    let hostState: StoryPrState;
    try {
      hostState = (await this.#deps.host.viewPr(repo, stored.number)).state;
    } catch (error) {
      this.#deps.logger?.warn("reading the story PR failed", {
        office: officeId,
        run: stored.runId,
        reason: messageOf(error),
      });
      return;
    }
    if (hostState === stored.state) return;
    const closedAt = hostState === "open" ? null : this.#deps.clock.now();
    const next: StoryPrRecord = { ...stored, state: hostState, closedAt };
    const story = findStoryByKey(state.office, stored.key)?.story;
    this.#write(officeId, state, () => {
      setStoryPrState(state.office, stored.runId, { state: hostState, closedAt });
      return story === undefined ? [] : [prEntry(next, story)];
    });
  }

  #failed(officeId: OfficeId, state: Polled, runId: RunId, key: StoryKey, error: unknown): void {
    const reason =
      error instanceof CodeHostError ? `${error.code}: ${error.message}` : messageOf(error);
    this.#deps.logger?.warn("opening the story PR failed", {
      office: officeId,
      run: runId,
      reason,
    });
    if (state.told.get(runId) === reason) return;
    state.told.set(runId, reason);
    this.#write(officeId, state, () => [
      notice(
        "warn",
        STORY_PR_NOTICES.openFailed,
        `dipo could not open the PR for ${key}: ${reason}. The story stays In Review; dipo tries again.`,
        key,
        runId,
      ),
    ]);
  }

  #write(officeId: OfficeId, state: Polled, fn: () => NewEntry[]): void {
    const at = this.#deps.clock.now();
    const count = state.office.immediate(() => {
      const entries = fn();
      appendEntries(state.office, entries, { at });
      return entries.length;
    });
    if (count > 0) this.#deps.onChanged?.(officeId);
  }

  #state(officeId: OfficeId): Polled {
    const state = this.#offices.get(officeId);
    if (state !== undefined) return state;
    const office = this.#deps.offices.get(officeId);
    if (office === undefined) throw new Error(`Office ${officeId} is not loaded.`);
    this.track(officeId, office, this.#deps.clock);
    return this.#offices.get(officeId) as Polled;
  }

  #serial<T>(state: Polled, fn: () => Promise<T>): Promise<T> {
    const run = state.busy.then(fn, fn);
    state.busy = run.catch(() => undefined);
    return run;
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
      void this.retry(officeId)
        .catch((error: unknown) => {
          this.#deps.logger?.warn("the story PR retry failed", {
            office: officeId,
            reason: messageOf(error),
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

/** The `[HOST/]OWNER/REPO` of a PR URL (`https://github.com/o/r/pull/7`), or null. */
function repoOfPrUrl(url: string): string | null {
  const at = url.lastIndexOf("/pull/");
  return at <= 0 || !/^\/pull\/\d+\/?$/.test(url.slice(at))
    ? null
    : repoOfRemoteUrl(url.slice(0, at));
}

function prEntry(record: StoryPrRecord, story: string): NewEntry {
  return {
    type: "story.pr",
    key: record.key,
    run: record.runId,
    delta: {
      story,
      key: record.key,
      pr: { number: record.number, url: record.url, state: record.state },
    },
  };
}

function notice(
  level: "info" | "warn",
  code: string,
  text: string,
  key: StoryKey,
  run: RunId,
): NewEntry {
  return { type: "engine.notice", key, run, delta: { level, code, text } };
}
