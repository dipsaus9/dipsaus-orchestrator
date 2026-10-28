// The office's auto-merge poll (0002, 0010). dipo merges nothing itself: it turns GitHub's
// auto-merge on for a story PR whose merge gate was approved (`stories.ts`) and for a backlog PR
// whose structural check passed (`backlog.ts`), and GitHub merges once its own required checks pass
// on the head dipo named. Each round reads every open PR again and turns auto-merge off when
// something stops the merge. Nothing of it is kept in the state database: whether auto-merge is on
// is GitHub's fact, read with the PR (`HostPr.autoMerge`).
//
// With the office's PR-state poll (`prState`) the auto-merge runs as part of each of its rounds,
// after the story-PR poll, and reads PR state through the reads the round gave it; without it, it
// runs on a timer of its own every `polling.prStateSeconds`. A kick (a maintainer's decision, a
// lane flush) runs a round at once, reading the host. Rounds of one office run one at a time. A
// notice that would repeat on every round is shown once per subject, code and head or cause.

import type { Clock, OfficeId, RunId, TimerHandle } from "@dipsaus-orchestrator/contract";

import type { OfficeLane } from "../backlog/lane/lane";
import { appendEntries, type NewEntry } from "../changelog/log";
import type { FeatureModule } from "../commands/registry";
import { OFFICE_DEFAULTS, type OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import type { Logger } from "../log/logger";
import type { AutoMergeHost, CodeHost, PrReviewHost } from "../platform/host";
import type { PrStatePoll, PrStateReads } from "../platform/pr-state";

import { BacklogMerges } from "./backlog";
import { type BacklogMergeGit, laneMergeGit } from "./backlog-git";
import type { StoredMergeGate } from "./gates";
import { type StoryMergeContext, type StoryMergeDeps, StoryMerges } from "./stories";

/** The load step that starts the office's auto-merge poll. */
export const AUTO_MERGE_STEP = "merge.watch";

/** The `engine.notice` code of a round that failed. */
export const AUTO_MERGE_FAILED = "merge.failed";

export interface AutoMergeDeps {
  /** Reads PRs and their required checks, and turns auto-merge on and off. */
  readonly host: Pick<CodeHost, "viewPr" | "requiredChecks"> &
    Pick<AutoMergeHost, "enableAutoMerge" | "disableAutoMerge">;
  /** The office's planning lane once the office loaded; no backlog PRs without it. */
  readonly lane: (office: OfficeId) => OfficeLane | undefined;
  readonly offices: {
    get(office: OfficeId): OfficeHandle | undefined;
    config?(office: OfficeId): OfficeConfig | undefined;
  };
  readonly clock: Clock;
  /** A backlog PR's labels; without it a backlog PR's labels are not read (tests). */
  readonly labels?: Pick<PrReviewHost, "prLabels">;
  /** Story PRs; without them only backlog PRs get auto-merge. */
  readonly stories?: Omit<StoryMergeDeps, "host">;
  /** The backlog git of a lane; the real `laneMergeGit` by default. */
  readonly backlogGit?: (lane: OfficeLane) => BacklogMergeGit;
  readonly onChanged?: (office: OfficeId) => void;
  readonly logger?: Logger;
  /** The office's one PR-state poll: the auto-merge runs in its rounds instead of its own timer. */
  readonly prState?: Pick<PrStatePoll, "subscribe">;
}

interface OfficeState {
  busy: Promise<unknown>;
  /** Rounds queued or running. */
  pending: number;
  /** The notice last given for each `<subject>:<code>`, with its head or cause. */
  readonly noticed: Map<string, string>;
  /** The backlog PRs with auto-merge on, by number: the lane holds their branches. */
  readonly armed: Set<number>;
  /**
   * The backlog PRs whose auto-merge state a round read from GitHub. Until a PR is in it (after a
   * daemon start) the lane holds its branch too, as auto-merge may be on.
   */
  readonly seen: Set<number>;
  clock: Clock;
  seconds: number;
  timer: TimerHandle | null;
  /** The reads of the PR-state round the running round belongs to, or null. */
  reads: PrStateReads | null;
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class AutoMerge {
  readonly #deps: AutoMergeDeps;
  readonly #offices = new Map<OfficeId, OfficeState>();
  readonly #stories: StoryMerges | null;
  readonly #backlog: BacklogMerges;
  #stopped = false;

  constructor(deps: AutoMergeDeps) {
    this.#deps = deps;
    this.#stories =
      deps.stories === undefined ? null : new StoryMerges({ ...deps.stories, host: deps.host });
    this.#backlog = new BacklogMerges({
      host: deps.host,
      ...(deps.labels === undefined ? {} : { labels: deps.labels }),
    });
    deps.prState?.subscribe("merge", async (office, reads) => {
      const state = this.#offices.get(office);
      if (state === undefined || this.#deps.offices.get(office) === undefined) return;
      // A round that comes while one still runs is skipped.
      if (state.pending === 0) await this.tick(office, reads);
    });
  }

  /**
   * The branch of the office's open backlog PR with auto-merge on, or whose auto-merge state no
   * round has read yet (after a daemon start), or null: the lane holds new operations meanwhile,
   * so the head GitHub merges is the one the structural check passed on.
   */
  holding(office: OfficeId): string | null {
    const handle = this.#deps.offices.get(office);
    if (handle === undefined) return null;
    const state = this.#stateOf(office);
    const open = handle.all<{ pr_number: number; branch: string }>(
      `select pr_number, branch from backlog_prs where office_id = $office_id and state = 'open'
        order by pr_number`,
    );
    const held = open.find((pr) => state.armed.has(pr.pr_number) || !state.seen.has(pr.pr_number));
    return held?.branch ?? null;
  }

  /**
   * Runs `write` to the story branch `branch` with auto-merge off for its open PR (`guard.ts`): in
   * the office's round queue, after any round that runs, so no round turns auto-merge on between
   * the two. Throws, writing nothing, when auto-merge cannot be turned off. Never call it from
   * inside a round: it would wait for that round.
   */
  guarded<T>(office: OfficeId, branch: string, write: () => Promise<T>): Promise<T> {
    const handle = this.#deps.offices.get(office);
    const stories = this.#stories;
    if (handle === undefined || stories === null) return write();
    const state = this.#stateOf(office);
    const step = async (): Promise<T> => {
      // The host's state now, never a round's copy.
      const ctx = { ...this.#context(office, state, handle), reads: this.#deps.host };
      await stories.offFor(ctx, branch);
      return write();
    };
    const run = state.busy.then(step, step);
    state.busy = run.catch(() => undefined);
    return run;
  }

  /**
   * True when the merge gate `gate` holds for the PR head `head`: its own head, or one its verdict
   * carried to (`StoryMerges.gateHolds`); only its own head without story PRs.
   */
  async gateHolds(office: OfficeHandle, gate: StoredMergeGate, head: string): Promise<boolean> {
    if (gate.head === head) return true;
    if (this.#stories === null) return false;
    return this.#stories.gateHolds(office.officeId as OfficeId, office, gate, head);
  }

  /**
   * A story resumed to wait In Review again: its PR is first updated to the head its park and lift
   * pushed, so the next round compares GitHub's head with the one dipo pushed; then a round runs.
   */
  async reenter(office: OfficeId, run: { readonly runId: string }): Promise<void> {
    await this.#stories?.prSynced(office, run.runId as RunId).catch((error: unknown) => {
      this.#deps.logger?.warn("updating a resumed story's PR to its head failed", {
        office,
        run: run.runId,
        reason: reasonOf(error),
      });
    });
    this.kick(office);
  }

  /** One round of the office's auto-merge, after any round already running. */
  tick(office: OfficeId, reads?: PrStateReads): Promise<void> {
    const state = this.#stateOf(office);
    state.pending += 1;
    const step = async () => {
      state.reads = reads ?? null;
      try {
        await this.#round(office, state);
      } finally {
        state.reads = null;
        state.pending -= 1;
      }
    };
    const run = state.busy.then(step, step);
    state.busy = run.catch(() => undefined);
    return run;
  }

  /** Resolves once the office's running round, if any, has finished. */
  async whenIdle(office: OfficeId): Promise<void> {
    await this.#offices.get(office)?.busy;
  }

  /** Starts a round without waiting for it (after a flush, or a maintainer's merge decision). */
  kick(office: OfficeId): void {
    void this.tick(office).catch((error: unknown) => {
      this.#deps.logger?.warn("the auto-merge round failed", { office, reason: reasonOf(error) });
    });
  }

  /** Runs a round every `seconds` (its `polling.prStateSeconds`) until the office is forgotten. */
  watch(office: OfficeId, clock: Clock, seconds: number): void {
    const state = this.#stateOf(office);
    state.clock = clock;
    state.seconds = seconds;
    this.#schedule(office, state);
  }

  /** Stops every timer; rounds already running finish. */
  stop(): void {
    this.#stopped = true;
    for (const state of this.#offices.values()) this.#cancel(state);
  }

  /** The feature module whose load step starts the office's poll. */
  get feature(): FeatureModule {
    return {
      name: "merge",
      register: (registry) => {
        registry.registerLoadStep(AUTO_MERGE_STEP, (ctx) => {
          // With the PR-state poll the rounds come from it; the office only needs its state.
          if (this.#deps.prState === undefined) {
            this.watch(ctx.officeId, ctx.clock, secondsOf(ctx.config));
          } else this.#stateOf(ctx.officeId);
          return { ok: true };
        });
      },
    };
  }

  // ---- the timer --------------------------------------------------------------------------------

  #schedule(office: OfficeId, state: OfficeState): void {
    if (this.#stopped || state.timer !== null || state.seconds <= 0) return;
    if (this.#offices.get(office) !== state) return;
    state.timer = state.clock.setTimeout(() => {
      state.timer = null;
      try {
        const { offices } = this.#deps;
        if (offices.config !== undefined) state.seconds = secondsOf(offices.config(office));
        if (state.pending === 0) this.kick(office);
      } finally {
        this.#schedule(office, state);
      }
    }, state.seconds * 1000);
  }

  #cancel(state: OfficeState): void {
    if (state.timer !== null) state.clock.clearTimeout(state.timer);
    state.timer = null;
  }

  #stateOf(office: OfficeId): OfficeState {
    let state = this.#offices.get(office);
    if (state === undefined) {
      state = {
        busy: Promise.resolve(),
        pending: 0,
        noticed: new Map(),
        armed: new Set(),
        seen: new Set(),
        clock: this.#deps.clock,
        seconds: 0,
        timer: null,
        reads: null,
      };
      this.#offices.set(office, state);
    }
    return state;
  }

  // ---- one round --------------------------------------------------------------------------------

  async #round(office: OfficeId, state: OfficeState): Promise<void> {
    const handle = this.#deps.offices.get(office);
    if (handle === undefined) {
      // A forgotten office: its poll ends.
      this.#cancel(state);
      state.seconds = 0;
      if (this.#offices.get(office) === state) this.#offices.delete(office);
      return;
    }
    const ctx = this.#context(office, state, handle);
    try {
      if (this.#stories !== null) await this.#stories.tick(ctx);
      const lane = this.#deps.lane(office);
      if (lane !== undefined) {
        const git = (this.#deps.backlogGit ?? laneMergeGit)(lane);
        await this.#backlog.tick({
          ...ctx,
          lane,
          git,
          now: () => this.#deps.clock.now(),
          armed: state.armed,
          seen: state.seen,
        });
      }
    } catch (error) {
      const reason = reasonOf(error);
      ctx.once("office", AUTO_MERGE_FAILED, reason, () => ({
        type: "engine.notice",
        delta: {
          level: "error",
          code: AUTO_MERGE_FAILED,
          text: `The auto-merge poll failed: ${reason}. dipo tries again at the next poll.`,
        },
      }));
    }
  }

  #context(office: OfficeId, state: OfficeState, handle: OfficeHandle): StoryMergeContext {
    return {
      officeId: office,
      office: handle,
      reads: state.reads ?? this.#deps.host,
      clock: this.#deps.clock,
      config: this.#deps.offices.config?.(office) ?? OFFICE_DEFAULTS,
      once: (subject, code, value, make) => {
        const key = `${subject}:${code}`;
        if (state.noticed.get(key) === value) return;
        state.noticed.set(key, value);
        this.#write(office, handle, () => [make()]);
      },
      write: (fn) => this.#write(office, handle, () => [...fn()]),
      ...(this.#deps.logger === undefined ? {} : { logger: this.#deps.logger }),
    };
  }

  #write(office: OfficeId, handle: OfficeHandle, fn: () => NewEntry[]): void {
    const now = this.#deps.clock.now();
    const count = handle.immediate(() => {
      const entries = fn();
      appendEntries(handle, entries, { at: now });
      return entries.length;
    });
    if (count > 0) this.#deps.onChanged?.(office);
  }
}

function secondsOf(config: OfficeConfig | undefined): number {
  return (config ?? OFFICE_DEFAULTS).polling.prStateSeconds;
}
