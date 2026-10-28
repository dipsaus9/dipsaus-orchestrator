// One PR-state poll per office (DIPO-314). Every `polling.prStateSeconds` of the office
// configuration in force, one timer runs one round: the story-PR poll (`story-pr/prs.ts`) first,
// then an auto-merge round (`merge/merger.ts`) and the Done poll (`worktree/done.ts`) side by
// side, so a slow auto-merge round does not hold the Done poll back. Each consumer gets its own reads
// object for the round (`PrStateReads`), which asks the host about each PR once: the first read
// of a PR is shared with every later read of it in the same round, and the Done poll's "did this
// branch merge" question is answered from a PR of that branch the round already read. So each
// open PR is read once per interval, and its state passes from the story-PR poll to the auto-merge
// and the Done poll.
//
// Only the reads object a round hands out uses the round: an auto-merge round after a flush or a
// maintainer's decision, a sync after an In Review push, and a read after the round ended go to
// the host. A read that names the head the caller expects (`head`) is read again from the host
// when the round's copy shows another head, so a head dipo pushed during the round is never taken
// for a hand change. A PR whose auto-merge the round turned on or off is dropped from it
// (`invalidate`), so a later read in the round asks the host.
//
// A consumer that fails is logged, and the round goes on with the others. A round that is due
// while the last one still runs is skipped, and the next timer is armed once a round ends. Each
// consumer stops arming its own timer once it is subscribed here.

import type { Clock, OfficeId, TimerHandle } from "@dipsaus-orchestrator/contract";

import type { FeatureModule } from "../commands/registry";
import { OFFICE_DEFAULTS, type OfficeConfig } from "../config";
import type { Logger } from "../log/logger";

import type { CodeHost, HostPr, PrStateHost } from "./host";

/** The load step that arms the office's PR-state poll. */
export const PR_STATE_STEP = "prState.poll";

/** The consumers of the poll, in the order each round runs them. */
export const PR_STATE_CONSUMERS = ["story-pr", "merge", "done"] as const;

export type PrStateConsumer = (typeof PR_STATE_CONSUMERS)[number];

/** How a consumer reads PR state in one round (see the file comment). */
export interface PrStateReads {
  /**
   * The PR as the host reports it. With `head`, a copy of this round that shows another head of an
   * open PR is read again from the host. Throws `CodeHostError` as the host does.
   */
  viewPr(repo: string, number: number, expect?: { readonly head?: string }): Promise<HostPr>;
  /** The newest merged PR whose head is `branch`, or null (`PrStateHost.findMergedPr`). */
  findMergedPr(repo: string, branch: string): Promise<HostPr | null>;
  /** Drops what the round read of the PR, after the caller changed it (a merge). */
  invalidate?(repo: string, number: number): void;
}

/** A consumer of the poll: one round's work for the office, reading through `reads`. */
export type PrStatePollConsumer = (office: OfficeId, reads: PrStateReads) => Promise<unknown>;

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

/** Drops what `round` read of the PR: its view and the branch answers it gave. */
function forget(round: Round, repo: string, number: number): void {
  round.views.delete(`${repo}#${number}`);
  for (const [key, pr] of round.byBranch) {
    if (pr.number === number && key.startsWith(`${repo}:`)) {
      round.byBranch.delete(key);
      round.merged.delete(key);
    }
  }
}

export class PrStatePoll {
  readonly #deps: PrStatePollDeps;
  readonly #consumers = new Map<PrStateConsumer, PrStatePollConsumer>();
  readonly #offices = new Map<OfficeId, Polled>();
  #stopped = false;

  constructor(deps: PrStatePollDeps) {
    this.#deps = deps;
  }

  /** Makes `poll` part of every round, in its place in `PR_STATE_CONSUMERS`. */
  subscribe(name: PrStateConsumer, poll: PrStatePollConsumer): void {
    this.#consumers.set(name, poll);
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
    const round: Round = { views: new Map(), merged: new Map(), byBranch: new Map() };
    state.round = round;
    state.rounds += 1;
    try {
      // The story-PR poll first, so its reads pass to the others; those two side by side.
      await this.#part(office, state, round, "story-pr");
      await Promise.all([
        this.#part(office, state, round, "merge"),
        this.#part(office, state, round, "done"),
      ]);
    } finally {
      state.round = null;
    }
    return true;
  }

  /** One consumer's part of a round, with its own reads; a failure is logged. */
  async #part(office: OfficeId, state: Polled, round: Round, name: PrStateConsumer): Promise<void> {
    const poll = this.#consumers.get(name);
    if (poll === undefined) return;
    try {
      await poll(office, this.#roundReads(state, round));
    } catch (error) {
      this.#deps.logger?.warn(`the ${name} part of the PR-state poll failed`, {
        office,
        reason: messageOf(error),
      });
    }
  }

  /** Reads through `round` while it is the office's running round, else the host. */
  #roundReads(state: Polled, round: Round): PrStateReads {
    const live = () => (state.round === round ? round : null);
    return {
      viewPr: (repo, number, expect) => this.#view(live(), repo, number, expect?.head),
      findMergedPr: (repo, branch) => this.#merged(live(), repo, branch),
      invalidate: (repo, number) => forget(round, repo, number),
    };
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
    round: Round | null,
    repo: string,
    number: number,
    head: string | undefined,
  ): Promise<HostPr> {
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

  async #merged(round: Round | null, repo: string, branch: string): Promise<HostPr | null> {
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
