// Next up (0010, DIPO-440): how a free run slot gets its story. While a slot is free and a Ready
// story can start, dipo offers one story per free slot as a NEXT UP item on the desk, naming the
// story and one line of why. Nothing starts until the maintainer confirms one.
//
// - Order. The Ready stories on `_base` of the earliest milestone, by milestone number, that still
//   has one, then priority, ordinal and id (`comparePickup`); a milestone without a number after the
//   numbered ones, by name, and stories without a milestone last. A story is offered only when it
//   is Ready on the base, has no live claim, no pending planning operation, every dependency Done,
//   is not declined, and its newest story PR is not recorded merged: the PR poll records the merge
//   before the Done poll releases the claim, and the base says Done only after its next fetch.
// - Free slots. `Places.freeSlots`, less the confirms whose story has no claim yet.
// - Shared files. Each offer lists the files its references share, by the prefix rule
//   (`overlappingPaths`), with the references and the changed files (`storyChangedFiles`) of every
//   story with a live claim, or says it shares none. The maintainer decides; nothing checks overlap
//   while stories run.
// - Confirm. `nextUp.confirm` starts the offered story through `work.run` with the story named, the
//   same start as `dipo run <id>`. Each confirm is its own command: it never waits for another
//   story's box preparation.
// - Decline. `nextUp.decline` keeps the story's hash in `next_up_declines` and offers the next story
//   at once. A declined story is offered again once its task file changes (its hash differs) or a
//   run of it started after the decline.
// - Refresh. The offers are worked out again after every change of the office, coalesced per
//   office. A cheap signature (free slots, live claims, the statuses and hashes the story index
//   mirrored from the base, the declines, the planning holds, the stories whose story PR merged,
//   and the running branches' tips, read
//   with one `git for-each-ref` at most every 30 seconds) decides whether the base is read again.
//   A confirm or decline that comes in while the base is read wins over that read, and a confirm
//   whose start fails offers the story again. A newly offered story puts an `engine.notice`
//   on the office stream, so the TUI reads its desk again; the desk notification posts it once.

import { createHash } from "node:crypto";

import {
  type Clock,
  nextUpConfirm,
  nextUpDecline,
  type OfficeId,
  type RunId,
  StoryId,
  StoryKey,
  type workRun,
} from "@dipsaus-orchestrator/contract";
import type { z } from "zod";

import { baseRefOf, overlappingPaths, storyChangedFiles } from "../box/collisions";
import { appendEntries } from "../changelog/log";
import { CommandError } from "../commands/errors";
import type { AsyncCommandContext, CommandOutcome, FeatureModule } from "../commands/registry";
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
  /** Starts the story through `work.run` with it named. */
  readonly start: (ctx: AsyncCommandContext, key: StoryKey) => Promise<CommandOutcome<RunResult>>;
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
  readonly onChanged?: (office: OfficeId) => void;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

interface OfficeOffers {
  offers: NextUpOffer[];
  signature: string | null;
  running: Promise<void> | null;
  again: boolean;
  /** The keys of the stories a confirm is starting. */
  readonly confirming: Set<string>;
  /** The running branches' tips as last read, the runs they were read for, and when. */
  tips: { readonly runs: string; readonly tips: string; readonly at: number } | null;
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

  constructor(deps: NextUpDeps) {
    this.#deps = deps;
  }

  /** The office's NEXT UP items now, in order. */
  offers(officeId: OfficeId): readonly NextUpOffer[] {
    return this.#offices.get(officeId)?.offers ?? [];
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

  /** `nextUp.confirm`: starts the offered story through `work.run`. */
  async confirm(
    ctx: AsyncCommandContext,
    args: z.output<typeof nextUpConfirm.args>,
  ): Promise<CommandOutcome<RunResult>> {
    const officeId = ctx.office.officeId;
    const state = this.#state(officeId);
    const offer = this.#offered(ctx, args.story);
    state.confirming.add(offer.key);
    this.#publish(
      officeId,
      state,
      state.offers.filter((other) => other.key !== offer.key),
    );
    try {
      return await this.#deps.start(ctx, offer.key);
    } finally {
      state.confirming.delete(offer.key);
      // Worked out again from the base: a start that failed offers the story again.
      state.signature = null;
      void this.refresh(officeId);
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
        registry.addAsyncOfficeCommand({
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
  #offered(ctx: AsyncCommandContext, ref: string): NextUpOffer {
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
        confirming: new Set(),
        tips: null,
      };
      this.#offices.set(officeId, state);
    }
    return state;
  }

  /** How many slots the offers may fill now: 0 while no new run may start. */
  #slots(officeId: OfficeId, office: OfficeHandle, state: OfficeOffers): number {
    const deps = this.#deps;
    if (deps.scheduling?.() === false) return 0;
    if (deps.offices.configBlocksRuns(officeId).length > 0) return 0;
    if ((deps.startsPaused?.(officeId) ?? null) !== null) return 0;
    // A confirm holds its slot from the confirm; from its claim on, the places count it.
    const confirming = [...state.confirming].filter(
      (key) => liveClaimOf(office, StoryKey.parse(key)) === null,
    ).length;
    return Math.max(0, deps.freeSlots(officeId) - confirming);
  }

  /** What decides whether the offers can have changed, besides the base's own content. */
  #signature(office: OfficeHandle, free: number, state: OfficeOffers, tips: string): string {
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
      [...state.confirming].toSorted(),
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
    const free = this.#slots(officeId, office, state);
    if (free === 0) {
      state.signature = null;
      this.#publish(officeId, state, []);
      return;
    }
    const tips = await this.#tips(officeId, office, state);
    const signature = this.#signature(office, free, state, tips);
    if (signature === state.signature) return;
    const offers = await this.#offersFor(officeId, office, state, free);
    state.signature = signature;
    // A confirm or decline that came in while the base or git was read wins over this read.
    const now = this.#slots(officeId, office, state);
    const merged = new Set(mergedStoryKeys(office));
    this.#publish(
      officeId,
      state,
      offers
        .filter((offer) => !state.confirming.has(offer.key))
        .filter((offer) => liveClaimOf(office, offer.key) === null)
        .filter((offer) => !merged.has(offer.key))
        .filter((offer) => !declined(office, offer.key, offer.hash))
        .slice(0, now),
    );
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
  ): Promise<NextUpOffer[]> {
    const read = await this.#deps.base.read(officeId, null);
    const merged = new Set(mergedStoryKeys(office));
    const startable = read.views.filter((view) => {
      const status = read.statuses.get(view.id);
      if (status === undefined || statusSkip(status) !== null) return false;
      if (openDependencies(view).length > 0) return false;
      const resolved = resolveStoryRef(office, view.id);
      if (!resolved.ok || state.confirming.has(resolved.key)) return false;
      if (liveClaimOf(office, resolved.key) !== null || merged.has(resolved.key)) return false;
      if (this.#deps.base.planningHold(office, resolved.key) !== null) return false;
      return !declined(office, resolved.key, storyHash(view));
    });
    const chosen = nextUpOrder(startable).slice(0, free);
    if (chosen.length === 0) return [];
    const running = runningStories(office);
    const changed =
      running.length === 0 || this.#deps.changedFiles === undefined
        ? new Map<string, readonly string[]>()
        : await this.#deps
            .changedFiles(officeId, running)
            .catch(() => new Map<string, readonly string[]>());
    const before = new Map(state.offers.map((offer) => [offer.key, offer.since]));
    const now = this.#deps.clock.now();
    return chosen.flatMap((view, at): NextUpOffer[] => {
      const resolved = resolveStoryRef(office, view.id);
      if (!resolved.ok) return [];
      return [
        {
          story: StoryId.parse(resolved.story),
          key: StoryKey.parse(resolved.key),
          title: view.title,
          why: whyNext(view, at === 0),
          shared: sharedFiles(view.references, running, changed),
          hash: storyHash(view),
          since: before.get(resolved.key) ?? now,
        },
      ];
    });
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
