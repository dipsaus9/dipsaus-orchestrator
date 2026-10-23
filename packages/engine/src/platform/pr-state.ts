// One PR-state poll per office (DIPO-314). Every `polling.prStateSeconds` of the office
// configuration in force, one timer runs one round: the story-PR poll (`story-pr/prs.ts`), then a
// merge slot tick (`merge-slot/slot.ts`), then the Done poll (`worktree/done.ts`), one after the
// other. Within a round each of them reads PR state through `reads(office)`, which asks the host
// about each PR once: the first read of a PR is shared with every later read of it in the same
// round, and the Done poll's "did this branch merge" question is answered from a PR of that branch
// the round already read. So each open PR is read once per interval, and its state passes from
// the story-PR poll to the merge slot and the Done poll.
//
// A read outside a round (a merge slot tick after a flush or a maintainer's decision, a sync after
// an In Review push) goes to the host, and is not kept. A read that names the head the caller
// expects (`head`) is read again from the host when the round's copy shows another head, so a
// head dipo pushed during the round is never taken for a hand change. Reads that must see the
// host's state after a step of their own (after a merge attempt) go to the host directly and do
// not use this poll.
//
// A consumer that fails is logged, and the round goes on with the next. A round that is due while
// the last one still runs is skipped, and the next timer is armed once a round ends. Each consumer
// stops arming its own timer once it is subscribed here.

import type { Clock, OfficeId, TimerHandle } from "@dipsaus-orchestrator/contract";

import type { FeatureModule } from "../commands/registry";
import { OFFICE_DEFAULTS, type OfficeConfig } from "../config";
import type { Logger } from "../log/logger";

import type { CodeHost, HostPr, PrStateHost } from "./host";

/** The load step that arms the office's PR-state poll. */
export const PR_STATE_STEP = "prState.poll";

/** The consumers of the poll, in the order each round runs them. */
export const PR_STATE_CONSUMERS = ["story-pr", "merge-slot", "done"] as const;

export type PrStateConsumer = (typeof PR_STATE_CONSUMERS)[number];

/** How a consumer reads PR state: through the office's round while one runs, else the host. */
export interface PrStateReads {
  /**
   * The PR as the host reports it. With `head`, a copy of this round that shows another head of an
   * open PR is read again from the host. Throws `CodeHostError` as the host does.
   */
  viewPr(repo: string, number: number, expect?: { readonly head?: string }): Promise<HostPr>;
  /** The newest merged PR whose head is `branch`, or null (`PrStateHost.findMergedPr`). */
  findMergedPr(repo: string, branch: string): Promise<HostPr | null>;
}

export interface PrStatePollDeps {
  readonly host: Pick<CodeHost, "viewPr"> & PrStateHost;
  /** The loaded offices and the configuration in force for each next interval. */
  readonly offices: {
    get(office: OfficeId): unknown;
    config(office: OfficeId): OfficeConfig | undefined;
  };
  readonly clock: Clock;
  readonly logger?: Logger;
}

/** What one round read, by PR and by branch. */
interface Round {
  readonly views: Map<string, Promise<HostPr>>;
  readonly merged: Map<string, Promise<HostPr | null>>;
  /** The newest PR read for each `<repo>:<branch>` in this round. */
  readonly byBranch: Map<string, HostPr>;
}

interface Polled {
  clock: Clock;
  timer: TimerHandle | null;
  round: Round | null;
  /** Rounds run so far, for tests and logs. */
  rounds: number;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class PrStatePoll {
  readonly #deps: PrStatePollDeps;
  readonly #consumers = new Map<PrStateConsumer, (office: OfficeId) => Promise<unknown>>();
  readonly #offices = new Map<OfficeId, Polled>();
  #stopped = false;

  constructor(deps: PrStatePollDeps) {
    this.#deps = deps;
  }

  /** Makes `poll` part of every round, in its place in `PR_STATE_CONSUMERS`. */
  subscribe(name: PrStateConsumer, poll: (office: OfficeId) => Promise<unknown>): void {
    this.#consumers.set(name, poll);
  }

  /** How the office's consumers read PR state (see the file comment). */
  reads(office: OfficeId): PrStateReads {
    return {
      viewPr: (repo, number, expect) => this.#view(office, repo, number, expect?.head),
      findMergedPr: (repo, branch) => this.#merged(office, repo, branch),
    };
  }

  /** True while a round of the office runs. */
  inRound(office: OfficeId): boolean {
    return (this.#offices.get(office)?.round ?? null) !== null;
  }

  /** How many rounds of the office ran. */
  rounds(office: OfficeId): number {
    return this.#offices.get(office)?.rounds ?? 0;
  }

  /**
   * One round now: every subscribed consumer in order, each reading through the round. False when
   * a round of the office still runs, which this one then skips.
   */
  async round(office: OfficeId): Promise<boolean> {
    const state = this.#state(office);
    if (state.round !== null) {
      this.#deps.logger?.debug("PR-state poll skipped: a round still runs", { office });
      return false;
    }
    state.round = { views: new Map(), merged: new Map(), byBranch: new Map() };
    state.rounds += 1;
    try {
      for (const name of PR_STATE_CONSUMERS) {
        const poll = this.#consumers.get(name);
        if (poll === undefined) continue;
        try {
          await poll(office);
        } catch (error) {
          this.#deps.logger?.warn(`the ${name} part of the PR-state poll failed`, {
            office,
            reason: messageOf(error),
          });
        }
      }
    } finally {
      state.round = null;
    }
    return true;
  }

  /** Runs a round every `polling.prStateSeconds` of the office until it is forgotten. */
  watch(office: OfficeId, clock: Clock, config: OfficeConfig | undefined): void {
    const state = this.#state(office);
    state.clock = clock;
    this.#schedule(office, state, config);
  }

  /** Stops every timer; a round already running finishes. */
  stop(): void {
    this.#stopped = true;
    for (const state of this.#offices.values()) this.#cancel(state);
  }

  /** The feature module whose load step arms the office's poll; register it after its consumers. */
  get feature(): FeatureModule {
    return {
      name: "pr-state",
      register: (registry) => {
        registry.registerLoadStep(PR_STATE_STEP, (ctx) => {
          this.watch(ctx.officeId, ctx.clock, ctx.config);
          return { ok: true };
        });
      },
    };
  }

  // ---- reads -----------------------------------------------------------------------------------

  async #view(
    office: OfficeId,
    repo: string,
    number: number,
    head: string | undefined,
  ): Promise<HostPr> {
    const round = this.#offices.get(office)?.round ?? null;
    if (round === null) return this.#deps.host.viewPr(repo, number);
    const key = `${repo}#${number}`;
    let read = round.views.get(key);
    if (read === undefined) {
      read = this.#readView(round, repo, number);
      round.views.set(key, read);
    }
    const pr = await read;
    if (head === undefined || pr.state !== "open" || pr.headSha === "" || pr.headSha === head) {
      return pr;
    }
    // The round's copy predates a head pushed since: read it again, and keep the new copy.
    const again = this.#readView(round, repo, number);
    round.views.set(key, again);
    return again;
  }

  #readView(round: Round, repo: string, number: number): Promise<HostPr> {
    const read = this.#deps.host.viewPr(repo, number).then((pr) => {
      round.byBranch.set(`${repo}:${pr.head}`, pr);
      return pr;
    });
    // A failed read is the round's answer for that PR; each caller gets the error when it awaits.
    read.catch(() => undefined);
    return read;
  }

  async #merged(office: OfficeId, repo: string, branch: string): Promise<HostPr | null> {
    const round = this.#offices.get(office)?.round ?? null;
    if (round === null) return this.#deps.host.findMergedPr(repo, branch);
    const key = `${repo}:${branch}`;
    // A PR of the branch this round read answers it: merged is the answer, and an open PR of the
    // branch means it has not merged.
    const viewed = round.byBranch.get(key);
    if (viewed?.state === "merged") return viewed;
    if (viewed?.state === "open") return null;
    let read = round.merged.get(key);
    if (read === undefined) {
      read = this.#deps.host.findMergedPr(repo, branch);
      read.catch(() => undefined);
      round.merged.set(key, read);
    }
    return read;
  }

  // ---- the timer -------------------------------------------------------------------------------

  #state(office: OfficeId): Polled {
    let state = this.#offices.get(office);
    if (state === undefined) {
      state = { clock: this.#deps.clock, timer: null, round: null, rounds: 0 };
      this.#offices.set(office, state);
    }
    return state;
  }

  #schedule(office: OfficeId, state: Polled, config: OfficeConfig | undefined): void {
    if (this.#stopped || state.timer !== null || this.#offices.get(office) !== state) return;
    const seconds = (config ?? OFFICE_DEFAULTS).polling.prStateSeconds;
    if (seconds <= 0) return;
    state.timer = state.clock.setTimeout(() => {
      state.timer = null;
      if (this.#offices.get(office) !== state) return;
      if (this.#deps.offices.get(office) === undefined) {
        // A forgotten office: its poll ends.
        this.#offices.delete(office);
        return;
      }
      void this.round(office)
        .catch((error: unknown) => {
          this.#deps.logger?.warn("the PR-state poll failed", { office, reason: messageOf(error) });
        })
        .finally(() => {
          let next: OfficeConfig | undefined;
          try {
            next = this.#deps.offices.config(office);
          } catch {
            next = undefined;
          }
          this.#schedule(office, state, next);
        });
    }, seconds * 1000);
  }

  #cancel(state: Polled): void {
    if (state.timer !== null) state.clock.clearTimeout(state.timer);
    state.timer = null;
  }
}
