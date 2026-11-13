// Next up (0010, DIPO-440): how a free run slot gets its story. While a slot is free and a Ready
// story can start, dipo offers one story per free slot as a NEXT UP item on the desk, naming the
// story and one line of why. With `nextUp.autoStart: none` (the default) nothing starts until the
// maintainer confirms one; with `no-overlap` dipo starts an offer that shares no files with the
// running stories by itself (`#autoStart`), through the same start as the confirm.
//
// - Order. The Ready stories on `_base` of the earliest milestone, by milestone number, that still
//   has one, then priority, ordinal and id (`comparePickup`); a milestone without a number after the
//   numbered ones, by name, and stories without a milestone last. A story is offered only when it
//   is Ready on the base, has no live claim, no pending planning operation, every dependency Done,
//   is not declined, and its newest story PR is not recorded merged: the PR poll, or the Done poll
//   when the host answered it, records the merge before the Done poll releases the claim, and the
//   base says Done only after its next fetch.
// - Free slots. `Places.freeSlots`, which counts the slot each confirmed start holds from its
//   confirm (DIPO-456).
// - Shared files. Each offer lists the files its references share, by the prefix rule
//   (`overlappingPaths`), with the references and the changed files (`storyChangedFiles`) of every
//   story with a live claim, or says it shares none. The maintainer decides; nothing checks overlap
//   while stories run.
// - Confirm. `nextUp.confirm` starts the offered story through `work.run` with the story named, the
//   same start as `dipo run <id>`, and answers as `work.run` does, at its decision (DIPO-456): it
//   never waits for a claim, a box or an install, its own or another story's.
// - Decline. `nextUp.decline` keeps the story's hash in `next_up_declines` and offers the next story
//   at once. A declined story is offered again once its task file changes (its hash differs) or a
//   run of it started after the decline.
// - Refresh. The offers are worked out again after every change of the office, coalesced per
//   office. A cheap signature (free slots, live claims, the statuses and hashes the story index
//   mirrored from the base, the declines, the planning holds, the stories whose story PR merged,
//   and the running branches' tips, read
//   with one `git for-each-ref` at most every 30 seconds) decides whether the base is read again.
//   A confirm or decline that comes in while the base is read wins over that read: a story whose
//   start `work.run` decided is not offered until that start ended, and one whose start failed is
//   offered again. A newly offered story puts an `engine.notice`
//   on the office stream, so the TUI reads its desk again; the desk notification posts it once.

import { createHash } from "node:crypto";

import {
  type Clock,
  type IdSource,
  nextUpConfirm,
  nextUpDecline,
  type OfficeId,
  type RequestId,
  type RunId,
  StoryId,
  StoryKey,
  type workRun,
} from "@dipsaus-orchestrator/contract";
import type { z } from "zod";

import { baseRefOf, overlappingPaths, storyChangedFiles } from "../box/collisions";
import { appendEntries, type NewEntry } from "../changelog/log";
import { CommandError } from "../commands/errors";
import type {
  AsyncCommandContext,
  CommandContext,
  CommandOutcome,
  FeatureModule,
} from "../commands/registry";
import type { OfficeHandle } from "../db/office";
import type { OfficeGit } from "../git/office";
import { findRun } from "../records/run-records";
import { comparePickup, openDependencies, statusSkip } from "../records/select";
import { resolveStoryRef } from "../records/story-keys";
import { mergedStoryKeys } from "../records/story-prs";
import type { StoryStore } from "../story-store/store";
import type { PlainTask } from "../story-store/story";
import { liveClaimOf, liveClaims } from "../worktree/records";

import type { RunBase } from "./work-run";

/** The error of a confirm or decline of a story the desk does not offer now. */
export const NOT_OFFERED = "nextUp.notOffered";

/** The `engine.notice` code of a newly offered story. */
export const NEXT_UP_NOTICE = "run.nextUp";

/** The `engine.notice` code of a story dipo started by itself (`nextUp.autoStart`). */
export const NEXT_UP_STARTED_NOTICE = "run.nextUpStarted";

/** Why an offer is started by itself: the one rule. */
export const AUTO_START_WHY = "it shares no files with the running stories";

/** The office load step that works out the offers. */
export const NEXT_UP_STEP = "next-up/refresh";

type RunResult = z.input<typeof workRun.result>;
type DeclineResult = z.input<typeof nextUpDecline.result>;

/** A story with a live claim, as the shared files read it. */
export interface RunningStory {
  readonly runId: RunId;
  readonly story: string;
  readonly branch: string;
  readonly startSha: string;
  /** The references the run started with. */
  readonly scope: readonly string[];
}

/** One NEXT UP item. */
export interface NextUpOffer {
  readonly story: StoryId;
  readonly key: StoryKey;
  readonly title: string;
  /** One line of why this story is next. */
  readonly why: string;
  /** The files its references share with each running story; empty when it shares none. */
  readonly shared: readonly { readonly story: string; readonly paths: readonly string[] }[];
  /** The hash of the story as it was read; a decline keeps it. */
  readonly hash: string;
  /** When it was first offered, in ms. */
  readonly since: number;
  /** Why its last start did not go on (DIPO-488); absent when it never failed. */
  readonly failed?: string;
}

export interface NextUpDeps {
  readonly clock: Clock;
  readonly offices: {
    get(office: OfficeId): OfficeHandle | undefined;
    /** Why new runs are refused for the office's configuration; empty when none. */
    configBlocksRuns(office: OfficeId): readonly unknown[];
  };
  readonly base: Pick<RunBase, "read" | "planningHold">;
  /** How many slots a new pickup could take now (`Places.freeSlots`). */
  readonly freeSlots: (office: OfficeId) => number;
  /** The office's starts paused (0020), or null; no offer while it holds. */
  readonly startsPaused?: (office: OfficeId) => unknown;
  /** False while the daemon schedules no work; true by default. */
  readonly scheduling?: () => boolean;
  /** Starts the story through `work.run` with it named; answers at the decision (DIPO-456). */
  readonly start: (ctx: CommandContext, key: StoryKey) => CommandOutcome<RunResult>;
  /**
   * The keys of the stories whose start `work.run` decided and that have not ended
   * (`WorkRun.starting`): they are not offered meanwhile. None without it.
   */
  readonly starting?: (office: OfficeId) => readonly string[];
  /** Why the story's last start did not go on (`WorkRun.startFailure`); none without it. */
  readonly startFailure?: (office: OfficeId, key: string) => string | undefined;
  /** The changed files of each running story, by run; none without it. */
  readonly changedFiles?: (
    office: OfficeId,
    runs: readonly RunningStory[],
  ) => Promise<ReadonlyMap<string, readonly string[]>>;
  /**
   * The tip of each running story's branch, by run, so a commit there recomputes the shared files;
   * none without it. Read at most every `TIP_READ_MS` while the running stories stay the same.
   */
  readonly branchTips?: (
    office: OfficeId,
    runs: readonly RunningStory[],
  ) => Promise<ReadonlyMap<string, string>>;
  /** `nextUp.autoStart` of the office's configuration; `none` without it. */
  readonly autoStart?: (office: OfficeId) => "none" | "no-overlap";
  /** True while dipo updates itself or the desk offers `dipo update`: nothing starts by itself. */
  readonly updatePending?: (office: OfficeId) => boolean;
  /** A new request id for a start dipo makes itself (`autoStart`). */
  readonly requestId?: () => RequestId;
  readonly ids?: IdSource;
  readonly onChanged?: (office: OfficeId) => void;
  readonly info?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

/** What one read of the base found: the offers, and what the auto start decides from. */
interface Found {
  readonly offers: NextUpOffer[];
  readonly running: readonly RunningStory[];
  /** The changed files of each running story; null when they are not all known. */
  readonly changed: ReadonlyMap<string, readonly string[]> | null;
  /** The references of each story on the base, by key. */
  readonly references: ReadonlyMap<
    string,
    { readonly story: string; readonly paths: readonly string[] }
  >;
}

interface OfficeOffers {
  offers: NextUpOffer[];
  signature: string | null;
  running: Promise<void> | null;
  again: boolean;
  /** The running branches' tips as last read, the runs they were read for, and when. */
  tips: { readonly runs: string; readonly tips: string; readonly at: number } | null;
  /**
   * The offers dipo tried to start by itself, by key: the story's hash and the next-up signature
   * at the try, and why it did not go on. Such an offer is not tried again until either changes.
   */
  tried: Map<
    string,
    { readonly hash: string; readonly signature: string | null; readonly why: string }
  >;
  /** True after a pass that could not tell whether the offers overlap; tried again after a while. */
  retryAuto: boolean;
  autoAt: number;
}

/** The running branches' tips are read again at most this often while the same stories run. */
export const TIP_READ_MS = 30_000;

/** The number in a milestone such as `m-2`, or null. */
export function milestoneNumber(milestone: string | undefined): number | null {
  const found = /\d+/.exec(milestone ?? "");
  return found === null ? null : Number(found[0]);
}

function compareMilestones(a: string | undefined, b: string | undefined): number {
  const rank = (m: string | undefined) =>
    m === undefined || m === "" ? 2 : milestoneNumber(m) === null ? 1 : 0;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  const na = milestoneNumber(a) ?? 0;
  const nb = milestoneNumber(b) ?? 0;
  if (na !== nb) return na - nb;
  return (a ?? "").localeCompare(b ?? "");
}

/** `tasks` in next-up order: milestone (numbered, then named, then none), then the pickup order. */
export function nextUpOrder<T extends Pick<PlainTask, "id" | "priority" | "ordinal" | "milestone">>(
  tasks: readonly T[],
): T[] {
  return tasks.toSorted(
    (a, b) => compareMilestones(a.milestone, b.milestone) || comparePickup(a, b),
  );
}

/** The one line of why a story is next, from its milestone and priority. */
export function whyNext(task: Pick<PlainTask, "milestone" | "priority">, first: boolean): string {
  const priority = `priority ${task.priority?.toLowerCase() ?? "none"}`;
  if (task.milestone === undefined || task.milestone === "") {
    return `no milestone has a Ready story that can start before it; ${priority}`;
  }
  const where = first
    ? `${task.milestone} is the earliest milestone with a Ready story that can start`
    : `next Ready story by milestone (${task.milestone})`;
  return `${where}; ${priority}`;
}

/**
 * The hash of a story as read, without where its file lies and without what other task files hold
 * (its dependencies' statuses and titles, its parent's title, its subtasks): it changes when its
 * own task file does.
 */
export function storyHash(view: PlainTask): string {
  const { file: _file, subtasks: _subtasks, parent, ...own } = view;
  const dependencies = view.dependencies.map((dependency) => dependency.id);
  return createHash("sha256")
    .update(JSON.stringify({ ...own, dependencies, parent: parent?.id ?? null }))
    .digest("hex");
}

interface DeclineRow {
  key: string;
  view_hash: string;
  declined_at: number;
}

/** True when the maintainer declined `key` at this hash and no run of it started since. */
function declined(office: OfficeHandle, key: string, hash: string): boolean {
  const row = office.get<DeclineRow>(
    "select key, view_hash, declined_at from next_up_declines where office_id = $office_id and key = $key",
    { key },
  );
  if (row === null) return false;
  const started = office.get<{ found: number }>(
    `select 1 as found from runs where office_id = $office_id and key = $key
      and kind = 'story' and started_at >= $at limit 1`,
    { key, at: row.declined_at },
  );
  return row.view_hash === hash && started === null;
}

/** Inside the caller's transaction: the decline of `key` at `hash`, replacing an earlier one. */
export function recordDecline(office: OfficeHandle, key: string, hash: string, at: number): void {
  office.run(
    `insert into next_up_declines (office_id, key, view_hash, declined_at)
     values ($office_id, $key, $hash, $at)
     on conflict (office_id, key) do update set view_hash = excluded.view_hash,
       declined_at = excluded.declined_at`,
    { key, hash, at },
  );
}

/** The stories with a live claim, with the references their run started with. */
export function runningStories(office: OfficeHandle): RunningStory[] {
  return liveClaims(office).map((claim) => ({
    runId: claim.runId,
    story: claim.story,
    branch: claim.branch,
    startSha: claim.startSha,
    scope: findRun(office, claim.runId)?.scope ?? [],
  }));
}

/** A path as the prefix rule compares it: without a leading `./` or trailing slashes. */
function plainPath(path: string): string {
  return path.trim().replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * The files `references` share with each running story's references and changed files, by the
 * prefix rule (a folder shares every file below it).
 */
export function sharedFiles(
  references: readonly string[],
  running: readonly RunningStory[],
  changed: ReadonlyMap<string, readonly string[]>,
): { readonly story: string; readonly paths: readonly string[] }[] {
  const mine = references.map(plainPath).filter((path) => path !== "");
  return running.flatMap((run) => {
    const theirs = [...run.scope, ...(changed.get(run.runId) ?? [])].map(plainPath);
    const paths = overlappingPaths(mine, theirs);
    return paths.length === 0 ? [] : [{ story: run.story, paths }];
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class NextUp {
  readonly #deps: NextUpDeps;
  readonly #offices = new Map<OfficeId, OfficeOffers>();
  #updateOffer: ((office: OfficeId) => unknown) | null = null;

  constructor(deps: NextUpDeps) {
    this.#deps = deps;
  }

  /**
   * The update the desk offers (`SelfUpdate.offer`): while one is offered nothing starts by itself,
   * so an idle office can update. Set once the update service exists.
   */
  holdForUpdate(offer: (office: OfficeId) => unknown): void {
    this.#updateOffer = offer;
  }

  /** The office's NEXT UP items now, in order. */
  offers(officeId: OfficeId): readonly NextUpOffer[] {
    const failure = this.#deps.startFailure;
    return (this.#offices.get(officeId)?.offers ?? []).map((offer) => {
      const failed = failure?.(officeId, offer.key);
      return failed === undefined ? offer : { ...offer, failed };
    });
  }

  /**
   * Works the office's offers out again, after any refresh under way; calls while one runs are
   * coalesced into one more. Never throws.
   */
  refresh(officeId: OfficeId): Promise<void> {
    const state = this.#state(officeId);
    state.again = true;
    if (state.running === null) {
      state.running = (async () => {
        // After the caller's own transaction: a change is told synchronously, inside its writer.
        await Promise.resolve();
        try {
          while (state.again) {
            state.again = false;
            await this.#compute(officeId, state).catch((error: unknown) => {
              this.#deps.warn?.("working out the next-up stories failed", {
                office: officeId,
                reason: messageOf(error),
              });
            });
          }
        } finally {
          state.running = null;
        }
      })();
    }
    return state.running;
  }

  /** Refreshes every office seen so far (scheduling turned on). */
  refreshAll(): void {
    for (const officeId of this.#offices.keys()) void this.refresh(officeId);
  }

  /**
   * `nextUp.confirm`: starts the offered story through `work.run` and answers with its decision;
   * the claim and the box follow after the answer (DIPO-456).
   */
  confirm(
    ctx: CommandContext,
    args: z.output<typeof nextUpConfirm.args>,
  ): CommandOutcome<RunResult> {
    const officeId = ctx.office.officeId;
    const state = this.#state(officeId);
    const offer = this.#offered(ctx, args.story);
    return this.#launch(ctx, state, offer.key);
  }

  /**
   * The one start of an offered story, for the confirm and for `nextUp.autoStart`: through
   * `work.run`, then worked out again from the base, so a story it skipped, or whose start fails
   * later, is offered again.
   */
  #launch(ctx: CommandContext, state: OfficeOffers, key: StoryKey): CommandOutcome<RunResult> {
    try {
      return this.#deps.start(ctx, key);
    } finally {
      state.signature = null;
      void this.refresh(ctx.office.officeId);
    }
  }

  /** `nextUp.decline`: keeps the decline, then offers the next story at once. */
  async decline(
    ctx: AsyncCommandContext,
    args: z.output<typeof nextUpDecline.args>,
  ): Promise<CommandOutcome<DeclineResult>> {
    const officeId = ctx.office.officeId;
    const state = this.#state(officeId);
    const offer = this.#offered(ctx, args.story);
    ctx.commit(() => recordDecline(ctx.office, offer.key, offer.hash, ctx.clock.now()));
    state.signature = null;
    this.#publish(
      officeId,
      state,
      state.offers.filter((other) => other.key !== offer.key),
    );
    await this.refresh(officeId);
    return {
      result: {
        story: offer.story,
        key: offer.key,
        offered: this.offers(officeId).map((other) => other.story),
      },
      changed: true,
    };
  }

  /** The commands and the load step that works out the offers once the office loaded. */
  get feature(): FeatureModule {
    return {
      name: "run",
      register: (registry) => {
        // Not a waiting command: it answers at `work.run`'s decision (DIPO-456).
        registry.addOfficeCommand({
          definition: nextUpConfirm,
          handle: (ctx, args) => this.confirm(ctx, args),
        });
        registry.addAsyncOfficeCommand({
          definition: nextUpDecline,
          handle: (ctx, args) => this.decline(ctx, args),
        });
        registry.registerLoadStep(NEXT_UP_STEP, (ctx) => {
          void this.refresh(ctx.officeId);
          return { ok: true };
        });
      },
    };
  }

  /** The offer of the story `ref` resolves to; `nextUp.notOffered` without one. */
  #offered(ctx: CommandContext | AsyncCommandContext, ref: string): NextUpOffer {
    const story = ctx.stories.get(ref);
    const offer = this.offers(ctx.office.officeId).find((other) => other.key === story?.key);
    if (offer !== undefined) return offer;
    const name = story?.story ?? ref;
    throw new CommandError(
      NOT_OFFERED,
      `${name} is not offered as next up now; \`dipo desk\` lists the stories that are`,
      { office: ctx.office.officeId, story: name },
    );
  }

  #state(officeId: OfficeId): OfficeOffers {
    let state = this.#offices.get(officeId);
    if (state === undefined) {
      state = {
        offers: [],
        signature: null,
        running: null,
        again: false,
        tips: null,
        tried: new Map(),
        retryAuto: false,
        autoAt: 0,
      };
      this.#offices.set(officeId, state);
    }
    return state;
  }

  /**
   * How many slots the offers may fill now: 0 while no new run may start. A confirmed start holds
   * its slot in the places from its decision (DIPO-456).
   */
  #slots(officeId: OfficeId): number {
    const deps = this.#deps;
    if (deps.scheduling?.() === false) return 0;
    if (deps.offices.configBlocksRuns(officeId).length > 0) return 0;
    if ((deps.startsPaused?.(officeId) ?? null) !== null) return 0;
    return Math.max(0, deps.freeSlots(officeId));
  }

  /** The keys of the stories whose start `work.run` decided and that have not ended. */
  #starting(officeId: OfficeId): ReadonlySet<string> {
    return new Set(this.#deps.starting?.(officeId) ?? []);
  }

  /** What decides whether the offers can have changed, besides the base's own content. */
  #signature(office: OfficeHandle, free: number, tips: string): string {
    const mirror = office.get<{ digest: string | null }>(
      `select group_concat(key || ':' || status || ':' || content_hash, ',') as digest
         from (select key, status, content_hash from backlog_mirror
                where office_id = $office_id and kind = 'task' order by key)`,
    );
    const declines = office.get<{ digest: string | null }>(
      `select group_concat(key || ':' || view_hash || ':' || declined_at, ',') as digest
         from (select key, view_hash, declined_at from next_up_declines
                where office_id = $office_id order by key)`,
    );
    // A pending planning operation holds its story from pickup (0010), as the StoryStore says.
    const ready = office.all<{ key: string }>(
      `select key from backlog_mirror where office_id = $office_id and kind = 'task'
          and status = 'Ready' order by key`,
    );
    const held = ready
      .filter((row) => this.#deps.base.planningHold(office, StoryKey.parse(row.key)) !== null)
      .map((row) => row.key);
    const claims = liveClaims(office).map((claim) => claim.runId);
    return JSON.stringify([
      free,
      claims,
      [...this.#starting(office.officeId)].toSorted(),
      mirror?.digest ?? "",
      declines?.digest ?? "",
      held,
      mergedStoryKeys(office),
      tips,
    ]);
  }

  async #compute(officeId: OfficeId, state: OfficeOffers): Promise<void> {
    const office = this.#deps.offices.get(officeId);
    if (office === undefined) {
      this.#offices.delete(officeId);
      return;
    }
    const free = this.#slots(officeId);
    if (free === 0) {
      state.signature = null;
      this.#publish(officeId, state, []);
      return;
    }
    const tips = await this.#tips(officeId, office, state);
    const signature = this.#signature(office, free, tips);
    // A pass that could not read the running stories' changed files is tried again, not too soon.
    const retry = state.retryAuto && this.#deps.clock.now() - state.autoAt >= TIP_READ_MS;
    if (signature === state.signature && !retry) return;
    const found = await this.#offersFor(officeId, office, state, free);
    state.signature = signature;
    // A confirm or decline that came in while the base or git was read wins over this read.
    const now = this.#slots(officeId);
    const merged = new Set(mergedStoryKeys(office));
    const starting = this.#starting(officeId);
    const offers = found.offers
      .filter((offer) => !starting.has(offer.key))
      .filter((offer) => liveClaimOf(office, offer.key) === null)
      .filter((offer) => !merged.has(offer.key))
      .filter((offer) => !declined(office, offer.key, offer.hash))
      .slice(0, now);
    // Before the publish: a story dipo starts at once is never announced as offered.
    const left =
      this.#deps.autoStart?.(officeId) === "no-overlap"
        ? this.#autoStart(officeId, office, state, offers, found)
        : offers;
    this.#publish(officeId, state, left);
  }

  /**
   * `nextUp.autoStart: no-overlap`: starts the offers, in order and one at a time while slots stay
   * free, that share no files with the running stories, the stories still starting and the ones
   * started in this pass. Anything unknown (a changed-files read that failed, references that are
   * missing) starts nothing. An offer it does not start keeps its reason in its why; one it tried
   * is not tried again until its task file or the next-up signature changes. Returns the offers
   * left on the desk.
   */
  #autoStart(
    officeId: OfficeId,
    office: OfficeHandle,
    state: OfficeOffers,
    offers: readonly NextUpOffer[],
    found: Found,
  ): NextUpOffer[] {
    const deps = this.#deps;
    state.retryAuto = false;
    // A start nulls `state.signature` (`#launch`); the tries are compared with this pass's.
    const signature = state.signature;
    if (offers.length === 0) return [...offers];
    const held = (offer: NextUpOffer, why: string): NextUpOffer => ({
      ...offer,
      why: `${offer.why}; not started by itself: ${why}`,
    });
    if (
      deps.updatePending?.(officeId) === true ||
      (this.#updateOffer?.(officeId) ?? null) !== null
    ) {
      return [...offers];
    }
    if (found.changed === null) {
      state.retryAuto = true;
      state.autoAt = deps.clock.now();
      return offers.map((offer) =>
        held(offer, "the changed files of the running stories could not be read"),
      );
    }
    const changed = found.changed;
    const others: RunningStory[] = [];
    for (const key of this.#starting(officeId)) {
      const mine = found.references.get(key);
      if (mine === undefined) {
        return offers.map((offer) =>
          held(offer, `the references of ${key}, which is starting, are not known`),
        );
      }
      others.push({
        runId: `starting:${key}` as RunId,
        story: mine.story,
        branch: "",
        startSha: "",
        scope: mine.paths,
      });
    }
    const left: NextUpOffer[] = [];
    for (const offer of offers) {
      const tried = state.tried.get(offer.key);
      if (tried?.hash === offer.hash && tried.signature === signature) {
        left.push(held(offer, tried.why));
        continue;
      }
      if (this.#slots(officeId) <= 0) {
        left.push(offer);
        continue;
      }
      const references = found.references.get(offer.key)?.paths ?? [];
      if (references.length === 0) {
        left.push(held(offer, "it has no references, so what it touches is not known"));
        continue;
      }
      const shared = sharedFiles(references, [...found.running, ...others], changed);
      if (shared.length > 0) {
        const each = shared.map((other) => `${other.paths.join(", ")} with ${other.story}`);
        left.push({ ...held(offer, `shares ${each.join("; ")}`), shared });
        continue;
      }
      const why = this.#startByItself(officeId, office, state, offer, signature);
      if (why === null) {
        others.push({
          runId: `started:${offer.key}` as RunId,
          story: offer.story,
          branch: "",
          startSha: "",
          scope: references,
        });
        continue;
      }
      state.tried.set(offer.key, { hash: offer.hash, signature, why });
      left.push(held(offer, why));
    }
    return left;
  }

  /**
   * Starts `offer` through the confirm's start, in a request dipo makes itself (origin `other`, as
   * `resumeLifted` makes one), and puts the notice. Null when it started, else why it did not.
   */
  #startByItself(
    officeId: OfficeId,
    office: OfficeHandle,
    state: OfficeOffers,
    offer: NextUpOffer,
    signature: string | null,
  ): string | null {
    const deps = this.#deps;
    const { ids, requestId } = deps;
    if (ids === undefined || requestId === undefined)
      return "dipo has no way to make its own request";
    const attempt = {
      hash: offer.hash,
      signature,
      why: "dipo started it by itself and the start did not go on",
    };
    // Set first: a start that fails after its decision must not be tried again.
    state.tried.set(offer.key, attempt);
    try {
      const outcome = office.immediate((): RunResult => {
        const entries: NewEntry[] = [];
        const now = deps.clock.now();
        const id = requestId();
        const ctx: CommandContext = {
          office,
          clock: deps.clock,
          ids,
          requestId: id,
          origin: "other",
          now,
          stories: new Map([[offer.key, { key: offer.key, story: offer.story }]]),
          emit: (entry) => {
            entries.push(entry);
          },
        };
        const result = this.#launch(ctx, state, offer.key).result;
        if (result.started.some((started) => started.key === offer.key)) {
          entries.push({
            type: "engine.notice",
            key: offer.key,
            delta: {
              level: "info",
              code: NEXT_UP_STARTED_NOTICE,
              text: `started ${offer.story} by itself: it shares no files with the running stories`,
            },
          });
        }
        appendEntries(office, entries, { at: now, causedBy: id });
        return result;
      });
      const skipped = outcome.skipped.find((skip) => skip.key === offer.key);
      if (skipped !== undefined) {
        return `work.run skipped it: ${[skipped.reason, ...(skipped.detail ?? [])].join(": ")}`;
      }
      if (!outcome.started.some((started) => started.key === offer.key)) {
        return "work.run started nothing";
      }
      deps.info?.("started a story by itself", {
        office: officeId,
        story: offer.story,
        why: `${offer.why}; ${AUTO_START_WHY}`,
      });
      return null;
    } catch (error) {
      const why = `its start failed: ${messageOf(error)}`;
      deps.warn?.("starting a next-up story by itself failed", {
        office: officeId,
        story: offer.story,
        reason: messageOf(error),
      });
      return why;
    }
  }

  /** The running branches' tips, read through git at most every `TIP_READ_MS` for the same runs. */
  async #tips(officeId: OfficeId, office: OfficeHandle, state: OfficeOffers): Promise<string> {
    const read = this.#deps.branchTips;
    if (read === undefined) return "";
    const running = runningStories(office);
    const runs = running.map((run) => run.runId).join(",");
    const now = this.#deps.clock.now();
    const kept = state.tips;
    if (kept !== null && kept.runs === runs && now - kept.at < TIP_READ_MS) return kept.tips;
    if (running.length === 0) {
      state.tips = { runs, tips: "", at: now };
      return "";
    }
    const tips = await read(officeId, running).catch(() => new Map<string, string>());
    const digest = running.map((run) => `${run.runId}:${tips.get(run.runId) ?? ""}`).join(",");
    state.tips = { runs, tips: digest, at: now };
    return digest;
  }

  /** The first `free` stories that can start, in next-up order, with their shared files. */
  async #offersFor(
    officeId: OfficeId,
    office: OfficeHandle,
    state: OfficeOffers,
    free: number,
  ): Promise<Found> {
    const read = await this.#deps.base.read(officeId, null);
    const merged = new Set(mergedStoryKeys(office));
    const starting = this.#starting(officeId);
    const startable = read.views.filter((view) => {
      const status = read.statuses.get(view.id);
      if (status === undefined || statusSkip(status) !== null) return false;
      if (openDependencies(view).length > 0) return false;
      const resolved = resolveStoryRef(office, view.id);
      if (!resolved.ok || starting.has(resolved.key)) return false;
      if (liveClaimOf(office, resolved.key) !== null || merged.has(resolved.key)) return false;
      if (this.#deps.base.planningHold(office, resolved.key) !== null) return false;
      return !declined(office, resolved.key, storyHash(view));
    });
    const running = runningStories(office);
    const references = new Map<string, { story: string; paths: readonly string[] }>();
    for (const view of read.views) {
      const resolved = resolveStoryRef(office, view.id);
      if (resolved.ok) {
        references.set(resolved.key, { story: view.id, paths: view.references });
      }
    }
    const chosen = nextUpOrder(startable).slice(0, free);
    if (chosen.length === 0) return { offers: [], running, changed: null, references };
    // Null: not every running story's changed files were read, so overlap is not known.
    const reading = await this.#readChanged(officeId, running);
    const shownChanged = reading.files;
    const changed = reading.known ? reading.files : null;
    const before = new Map(state.offers.map((offer) => [offer.key, offer.since]));
    const now = this.#deps.clock.now();
    const offers = chosen.flatMap((view, at): NextUpOffer[] => {
      const resolved = resolveStoryRef(office, view.id);
      if (!resolved.ok) return [];
      return [
        {
          story: StoryId.parse(resolved.story),
          key: StoryKey.parse(resolved.key),
          title: view.title,
          why: whyNext(view, at === 0),
          shared: sharedFiles(view.references, running, shownChanged),
          hash: storyHash(view),
          since: before.get(resolved.key) ?? now,
        },
      ];
    });
    return { offers, running, changed, references };
  }

  /**
   * The changed files of the running stories as far as they were read, and whether every one was:
   * a read that failed, or left a story out, leaves the overlap unknown.
   */
  async #readChanged(
    officeId: OfficeId,
    running: readonly RunningStory[],
  ): Promise<{ files: ReadonlyMap<string, readonly string[]>; known: boolean }> {
    const none = new Map<string, readonly string[]>();
    if (running.length === 0) return { files: none, known: true };
    const read = this.#deps.changedFiles;
    if (read === undefined) return { files: none, known: false };
    try {
      const files = await read(officeId, running);
      return { files, known: running.every((run) => files.has(run.runId)) };
    } catch {
      return { files: none, known: false };
    }
  }

  /**
   * Sets the office's offers. A newly offered story puts a notice on the office stream; any change
   * tells the office's subscribers, so the desk is read again.
   */
  #publish(officeId: OfficeId, state: OfficeOffers, offers: NextUpOffer[]): void {
    const before = new Set(state.offers.map((offer) => offer.key));
    const same =
      offers.length === state.offers.length &&
      offers.every((offer, at) => {
        const old = state.offers[at];
        return old?.key === offer.key && JSON.stringify(old) === JSON.stringify(offer);
      });
    state.offers = offers;
    if (same) return;
    const added = offers.filter((offer) => !before.has(offer.key));
    const office = this.#deps.offices.get(officeId);
    if (office !== undefined && added.length > 0) {
      office.immediate(() =>
        appendEntries(
          office,
          added.map((offer) => ({
            type: "engine.notice",
            key: offer.key,
            delta: {
              level: "info",
              code: NEXT_UP_NOTICE,
              text: `Next up for a free run slot: ${offer.story}; \`dipo next confirm ${offer.story}\` starts it, \`dipo next decline ${offer.story}\` offers another`,
            },
          })),
          { at: this.#deps.clock.now() },
        ),
      );
    }
    this.#deps.onChanged?.(officeId);
  }
}

/**
 * The changed files of each running story, read from git as the collisions pass reads them
 * (`storyChangedFiles`); a branch that cannot be read is left out.
 */
export function gitChangedFiles(deps: {
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  readonly stories: Pick<StoryStore, "storyFolders">;
}): NonNullable<NextUpDeps["changedFiles"]> {
  return async (officeId, runs) => {
    const out = new Map<string, readonly string[]>();
    const git = deps.git(officeId);
    if (git === undefined) return out;
    await git.run(async (session) => {
      const base = await baseRefOf(git, session);
      for (const run of runs) {
        const changed = await storyChangedFiles(session, {
          branch: run.branch,
          startSha: run.startSha,
          baseRef: base?.ref ?? null,
          stories: deps.stories,
        }).catch(() => null);
        if (changed !== null) out.set(run.runId, changed.files);
      }
    });
    return out;
  };
}

/** The tip of each running story's branch, read with one `git for-each-ref` of their refs. */
export function gitBranchTips(
  git: (office: OfficeId) => OfficeGit | undefined,
): NonNullable<NextUpDeps["branchTips"]> {
  return async (officeId, runs) => {
    const out = new Map<string, string>();
    const office = git(officeId);
    if (office === undefined) return out;
    const refs = runs.map((run) => `refs/heads/${run.branch}`);
    const listed = await office.run((session) =>
      session.step(session.repository, [
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        ...refs,
      ]),
    );
    if (listed.code !== 0) return out;
    const byRef = new Map(
      listed.stdout
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => line.split(" ") as [string, string]),
    );
    for (const run of runs) out.set(run.runId, byRef.get(`refs/heads/${run.branch}`) ?? "");
    return out;
  };
}
