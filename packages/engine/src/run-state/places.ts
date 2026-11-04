// The office's run slots and each story's places (0002, DIPO-142): an office runs at most
// `caps.parallelRuns` stories at once (default 3). Each running story has its own worker place for
// its developer session (a first run, a fix round, a conflict hand-off or a resumed developer
// session) and its own reviewer place for its reviewer session; a story never runs both at once,
// so it holds one slot, and one story's review never waits for another story's worker.
//
// - Counting. A story holds a slot while its open story run (not ended, its claim live) has a
//   live or starting session and does not wait, while a review reopened for it waits, and while
//   the run stands open at In Review waiting for its review (`PlacesDeps.reviewing`): the story's
//   developer hands its slot to its own review. The place of a session comes from the role of the
//   run's newest agent while that agent runs, else from the role its active period is for (the
//   reviewer's in a `review` phase). Session runs hold no slot (the 2026-10-16 review finding),
//   while `activeRuns` and `hasActiveRun` still count them for `office.forget` and `dipo daemon
//   status`. A story that waits for CI, for the maintainer, for its auto-merge or in a park holds
//   none.
// - Start order. A reopened run that finds every slot taken waits for one (`runs.waiting`,
//   `waitForPlace`), and so do pending reviews: maintainer resumes (of a developer session or of a
//   review) start first, then conflict hand-offs, fix rounds and pending reviews, then new pickups
//   by `work.run`. Within a rank the oldest wait goes first. A wait whose story holds its slot (a
//   review) starts without waiting for the limit.
// - Starts paused (0020, `run/starts-paused.ts`): while the office's starts are paused, no waiting
//   session starts; it keeps waiting and starts once the pause lifted.
// - Caps. A fix round or conflict hand-off whose run already reached its caps (a done path that
//   crossed one, DIPO-205) is not started: `Places.drain` parks the story `budget-exceeded`
//   (`pre-start-caps.ts`) before the starter is called.
// - `Places.drain` starts the waiting sessions in start order while slots are free, each through
//   the starter of its kind after claiming its place in one transaction (`claimPlace`). It runs
//   after each worker exit decision, at office load, and every minute while anything waits.
// - Pickups that are starting (DIPO-314). `work.run`'s serialized step ends once its claim row is
//   committed, so its box preparation, install and launch run outside it; from that commit until
//   its run row is in, the pickup holds a slot here (`reservePickup`, in memory), so no drain,
//   resume or other pickup takes it meanwhile. Its release drains the office, so what waited
//   starts when the pickup did not.

import type { Clock, OfficeId, RunId, TimerHandle, WorkRef } from "@dipsaus-orchestrator/contract";

import type { FeatureModule } from "../commands/registry";
import { OFFICE_DEFAULTS } from "../config";
import type { OfficeHandle } from "../db/office";
import { background } from "../platform/background";
import { workRefOf } from "../views/work";

import { REVIEWER_ROLE } from "../records/caps";
import type { RunEnding } from "../run/control-types";
import { preStartEnding, reachedCaps, resolvePreStartIntent } from "./pre-start-caps";
import {
  activeRuns,
  applyRunEvent,
  findRun,
  runPhase,
  type StoredRun,
} from "../records/run-records";

/** The two session places of a running story. */
export type Place = "worker" | "reviewer";

export const PLACES: readonly Place[] = ["worker", "reviewer"];

/** What a session waits in its place as. */
export const START_KINDS = {
  /** Worker place: a maintainer resume of a developer session (0020). */
  resume: "resume",
  /** Worker place: a conflict hand-off (0002). */
  conflict: "conflict",
  /** Worker place: a fix round (0002). */
  fix: "fix",
  /** Worker place: a new pickup by `work.run`; never stored, a pickup is skipped instead. */
  pickup: "pickup",
  /** Reviewer place: a maintainer resume that starts a fresh review (0020). */
  reviewResume: "review-resume",
  /** Reviewer place: a pending review (0002). */
  review: "review",
} as const;

export type StartKind = (typeof START_KINDS)[keyof typeof START_KINDS];

/** Each kind's place and rank in the office's start order; a lower rank starts first. */
const ORDER: Readonly<Record<StartKind, { readonly place: Place; readonly rank: number }>> = {
  resume: { place: "worker", rank: 0 },
  conflict: { place: "worker", rank: 1 },
  fix: { place: "worker", rank: 1 },
  pickup: { place: "worker", rank: 2 },
  "review-resume": { place: "reviewer", rank: 0 },
  review: { place: "reviewer", rank: 1 },
};

/** While anything waits for a place, the office is drained again this often. */
export const PLACE_TICK_MS = 60_000;

/** The office load step that starts what waited for a place across a restart. */
export const PLACES_STEP = "places/drain";

/** `engine.notice` codes of the places. */
export const PLACE_NOTICES = {
  queued: "run.queued",
} as const;

/** One session waiting for its place. */
export interface PlaceStart {
  readonly kind: StartKind;
  /** The run the session belongs to; null for a new pickup, whose run does not exist yet. */
  readonly runId: RunId | null;
  /** When it began waiting: a reopened run's wait, a pending review's In Review time. */
  readonly since: number;
}

function isStartKind(value: string): value is StartKind {
  return Object.hasOwn(ORDER, value);
}

/** The place of an agent's role: the reviewer's for `reviewer`, else the worker's. */
export function placeOfRole(role: string): Place {
  return role === REVIEWER_ROLE ? "reviewer" : "worker";
}

/** The place a start of `kind` needs. */
export function placeOfStart(kind: StartKind): Place {
  return ORDER[kind].place;
}

/** -1 when `a` starts before `b` in the office's start order, 1 after; by rank, wait, run id. */
function compareStarts(a: PlaceStart, b: PlaceStart): number {
  const rank = ORDER[a.kind].rank - ORDER[b.kind].rank;
  if (rank !== 0) return rank;
  if (a.since !== b.since) return a.since - b.since;
  return (a.runId ?? "").localeCompare(b.runId ?? "");
}

/** `starts` in the office's start order (0002). */
export function startOrder(starts: readonly PlaceStart[]): PlaceStart[] {
  return starts.toSorted(compareStarts);
}

interface LatestAgent {
  readonly role: string;
  readonly ended_at: number | null;
}

/** The place an open story run holds: its running agent's role, else its active period's. */
export function placeOfRun(office: OfficeHandle, run: StoredRun): Place {
  const agent = office.get<LatestAgent>(
    `select role, ended_at from agents where office_id = $office_id and run_id = $run
      order by started_at desc, rowid desc limit 1`,
    { run: run.runId },
  );
  if (agent !== null && agent.ended_at === null) return placeOfRole(agent.role);
  return runPhase(office, run.runId) === "review" ? "reviewer" : placeOfRole(run.role);
}

/** The open story runs holding each place: a live or starting session, not waiting. */
export function placeHolders(office: OfficeHandle): Record<Place, StoredRun[]> {
  const holders: Record<Place, StoredRun[]> = { worker: [], reviewer: [] };
  for (const run of activeRuns(office)) {
    if (run.kind !== "story" || run.waiting != null) continue;
    holders[placeOfRun(office, run)].push(run);
  }
  return holders;
}

/** The reopened runs of the office waiting for their place, as starts. */
export function waitingStarts(office: OfficeHandle): PlaceStart[] {
  return activeRuns(office).flatMap((run): PlaceStart[] =>
    run.kind === "story" && run.waiting != null && isStartKind(run.waiting)
      ? [{ kind: run.waiting, runId: run.runId, since: run.waitingSince ?? run.startedAt }]
      : [],
  );
}

/**
 * The open story runs holding one of the office's run slots (0002), oldest first: a live or
 * starting session that does not wait, a review reopened for the story that waits, and the runs
 * in `reviewing` (open at In Review, waiting for their review).
 */
export function slotHolders(office: OfficeHandle, reviewing: readonly RunId[] = []): StoredRun[] {
  const holders = activeRuns(office).filter(
    (run) => run.kind === "story" && (run.waiting == null || run.waiting === START_KINDS.review),
  );
  const held = new Set<string>(holders.map((run) => run.runId));
  for (const runId of reviewing) {
    if (held.has(runId)) continue;
    const run = findRun(office, runId);
    if (run === null) continue;
    holders.push(run);
    held.add(runId);
  }
  return holders;
}

/** What a slot check counts besides the office's runs. */
export interface SlotUse {
  /** The office's limit, `caps.parallelRuns`. */
  readonly limit: number;
  /** Runs open at In Review waiting for their review; each holds its story's slot. */
  readonly reviewing?: readonly RunId[];
  /** The stories of pickups past their claim row and before their run row (DIPO-314). */
  readonly starting?: readonly string[];
  /** The starts waiting for a slot; the reopened runs that wait by default. */
  readonly waiting?: readonly PlaceStart[];
}

/** The message of a start that finds the office's slots taken; it names the limit and its key. */
export function slotsFullText(
  limit: number,
  running: readonly string[],
  ahead: readonly string[],
): string {
  const runs = running.length === 0 ? "" : `; running: ${running.join(", ")}`;
  const waits = ahead.length === 0 ? "" : `; waiting first: ${ahead.join(", ")}`;
  return `the office runs at most ${limit} ${limit === 1 ? "story" : "stories"} at once (caps.parallelRuns in .dipo/office.yaml)${runs}${waits}`;
}

/**
 * Why `start` cannot start now, or null: the office's slots are all held, by running stories,
 * starting pickups and starts that go before it in the start order. A start whose story holds its
 * slot already (a review) never waits for the limit. Starts paused is not asked here.
 */
export function placeTaken(office: OfficeHandle, start: PlaceStart, use: SlotUse): string | null {
  const holders = slotHolders(office, use.reviewing);
  const own = holders.find((run) => run.runId === start.runId);
  if (
    own !== undefined &&
    (own.waiting === START_KINDS.review || (use.reviewing ?? []).includes(own.runId))
  ) {
    return null;
  }
  const held = new Set<string>(holders.map((run) => run.runId));
  const running = [
    ...holders.filter((run) => run !== own).map((run) => run.story ?? run.runId),
    ...(use.starting ?? []),
  ];
  const ahead = (use.waiting ?? waitingStarts(office)).filter(
    (other) =>
      other.runId !== start.runId &&
      (other.runId === null || !held.has(other.runId)) &&
      compareStarts(other, start) < 0,
  );
  if (running.length + ahead.length < use.limit) return null;
  const names = ahead.map((other) => {
    const run = other.runId === null ? null : findRun(office, other.runId);
    return run?.story ?? other.runId ?? "another story";
  });
  return slotsFullText(use.limit, running, names);
}

/**
 * Inside the caller's transaction: the reopened run `runId` waits for its place as `kind` from
 * `at`. It holds no place while it waits.
 */
export function waitForPlace(
  office: OfficeHandle,
  runId: RunId,
  kind: StartKind,
  at: number,
): void {
  applyRunEvent(office, runId, { kind: "wait", as: kind, since: at });
}

/**
 * Inside the caller's transaction: the waiting run `runId` takes its place at `at`, so it holds it
 * while its session starts. The time a developer session waited is added to `parked_ms`, so the
 * developer's minute cap leaves it out; a review's wait is left out with the review's own time
 * when the review ends (`endReviewPeriod`). False when the run was not waiting.
 */
export function claimPlace(office: OfficeHandle, runId: RunId, at: number): boolean {
  const run = findRun(office, runId);
  if (run === null || run.waiting == null) return false;
  const worker = isStartKind(run.waiting) ? placeOfStart(run.waiting) === "worker" : true;
  return applyRunEvent(office, runId, { kind: "take-place", at, counted: worker }) !== null;
}

/**
 * Starts the session a waiting run waits for; true when it started. A start that did not happen
 * either ended the run (parked or released it) or left it as it was, and then it waits again.
 */
export type PlaceStarter = (
  office: OfficeId,
  run: StoredRun,
  start: PlaceStart,
) => Promise<boolean>;

export interface PlacesDeps {
  readonly clock: Clock;
  readonly offices: { get(office: OfficeId): OfficeHandle | undefined };
  /** Why no new session starts in the office now (its starts paused, 0020), or null. */
  readonly startsPaused?: (office: OfficeId) => string | null;
  /** False while the daemon schedules no work (recovering, draining); true by default. */
  readonly scheduling?: () => boolean;
  /**
   * Pending reviews of the office, oldest In Review first: stories at In Review whose code tree has
   * no verdict (`pendingReviews`, DIPO-219, as `composeRuns` wires it); none by default.
   */
  readonly pending?: (office: OfficeHandle) => readonly PlaceStart[];
  /**
   * The runs open at In Review waiting for their review, pushed or not (`reviewingRuns`): each
   * holds its story's slot. The pending reviews' runs by default.
   */
  readonly reviewing?: (office: OfficeHandle) => readonly RunId[];
  /** How many stories the office runs at once (`caps.parallelRuns`); its default without it. */
  readonly limit?: (office: OfficeId) => number;
  /**
   * Parks a waiting run before its session starts (`RunControl.park`); without it the pre-start
   * cap check of a fix or conflict wait is skipped.
   */
  readonly park?: (
    office: OfficeHandle,
    run: StoredRun,
    work: WorkRef | undefined,
    ending: RunEnding,
  ) => Promise<unknown>;
  /** The session start of each kind; a kind with none waits until one is given. */
  readonly starters: Partial<Record<StartKind, PlaceStarter>>;
  readonly onChanged?: (office: OfficeId) => void;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

interface Drained {
  busy: Promise<unknown>;
  timer: TimerHandle | null;
  /** Pickups past their claim row and before their run row, by run, with their story. */
  readonly starting: Map<RunId, string>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Places {
  readonly #deps: PlacesDeps;
  readonly #offices = new Map<OfficeId, Drained>();
  readonly #inflight = new Set<Promise<unknown>>();
  #closed = false;

  constructor(deps: PlacesDeps) {
    this.#deps = deps;
  }

  /**
   * Why a new session of `start` must wait now, or null: the office's slots are taken
   * (`slotTaken`), or its starts are paused.
   */
  blocked(officeId: OfficeId, start: PlaceStart): string | null {
    return this.slotTaken(officeId, start) ?? this.#deps.startsPaused?.(officeId) ?? null;
  }

  /**
   * Why `start` finds no free slot in the office now, or null (`placeTaken`, with the office's
   * limit, the runs waiting for their review, the pending reviews and the pickups starting).
   */
  slotTaken(officeId: OfficeId, start: PlaceStart): string | null {
    const office = this.#deps.offices.get(officeId);
    if (office === undefined) return null;
    return this.#slotTaken(officeId, office, start);
  }

  #slotTaken(officeId: OfficeId, office: OfficeHandle, start: PlaceStart): string | null {
    const pending = this.#deps.pending?.(office) ?? [];
    const reviewing =
      this.#deps.reviewing?.(office) ??
      pending.flatMap((other) => (other.runId === null ? [] : [other.runId]));
    const starting = this.#offices.get(officeId)?.starting ?? new Map<RunId, string>();
    return placeTaken(office, start, {
      limit: this.limit(officeId),
      reviewing,
      starting: [...starting].flatMap(([runId, story]) => (runId === start.runId ? [] : [story])),
      waiting: [...waitingStarts(office), ...pending],
    });
  }

  /** How many stories the office runs at once (`caps.parallelRuns`). */
  limit(officeId: OfficeId): number {
    return this.#deps.limit?.(officeId) ?? OFFICE_DEFAULTS.caps.parallelRuns;
  }

  /**
   * Holds one of the office's slots for a pickup between its claim row and its run row
   * (DIPO-314). Returns the release, which drains the office in the background; calling it again
   * does nothing.
   */
  reservePickup(officeId: OfficeId, runId: RunId, story: string): () => void {
    const state = this.#state(officeId);
    state.starting.set(runId, story);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (state.starting.get(runId) === story) state.starting.delete(runId);
      if (!this.#closed) this.#background(officeId);
    };
  }

  /** The stories of the pickups holding a slot of the office while they start. */
  pickupsStarting(officeId: OfficeId): string[] {
    return [...(this.#offices.get(officeId)?.starting.values() ?? [])];
  }

  /** Starts what waits for a free slot in the office, once any drain under way finished. */
  drain(officeId: OfficeId): Promise<number> {
    return this.serialized(officeId, () => this.#drain(officeId, this.#state(officeId)));
  }

  /**
   * Runs `fn` once every drain and every earlier serialized step of the office finished, and before
   * any later one starts (DIPO-208). A step that decides on or takes a worker place runs here, so a
   * queued start and a new pickup cannot both take it. A step must never await `drain` or
   * `serialized` of the same office: it would wait on itself. Fire a drain with `void` instead.
   */
  serialized<T>(officeId: OfficeId, fn: () => Promise<T>): Promise<T> {
    const state = this.#state(officeId);
    const run = state.busy.then(fn, fn);
    state.busy = run.catch(() => undefined);
    return run;
  }

  /** Drains every office seen so far, in the background (after a worker exit decision). */
  drainAll(): void {
    for (const officeId of this.#offices.keys()) this.#background(officeId);
  }

  /** Resolves once every drain started in the background finished. */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled(this.#inflight);
  }

  /** Stops every tick. */
  close(): void {
    this.#closed = true;
    for (const state of this.#offices.values()) this.#disarm(state);
  }

  /** The load step that starts what waited for a place when the daemon stopped. */
  get feature(): FeatureModule {
    return {
      name: "run-state",
      register: (registry) => {
        registry.registerLoadStep(PLACES_STEP, (ctx) => {
          this.#background(ctx.officeId);
          return { ok: true };
        });
      },
    };
  }

  #background(officeId: OfficeId): void {
    background(() => this.drain(officeId), {
      failed: "starting a session that waited for its place failed",
      fields: { office: officeId },
      log: this.#deps.warn,
      inflight: this.#inflight,
    });
  }

  #state(officeId: OfficeId): Drained {
    let state = this.#offices.get(officeId);
    if (state === undefined) {
      state = { busy: Promise.resolve(), timer: null, starting: new Map() };
      this.#offices.set(officeId, state);
    }
    return state;
  }

  async #drain(officeId: OfficeId, state: Drained): Promise<number> {
    const office = this.#deps.offices.get(officeId);
    if (office === undefined) {
      this.#disarm(state);
      this.#offices.delete(officeId);
      return 0;
    }
    if (this.#deps.scheduling?.() === false) {
      this.#arm(officeId, state);
      return 0;
    }
    const starts = startOrder([...waitingStarts(office), ...(this.#deps.pending?.(office) ?? [])]);
    const waiting = starts.length > 0;
    let started = 0;
    for (const first of starts) {
      // Every slot is held, or a start ahead of this one waits for the free one (0002).
      if (this.#slotTaken(officeId, office, first) !== null) continue;
      const run = first.runId === null ? null : findRun(office, first.runId);
      if (run === null) continue;
      const starter = this.#deps.starters[first.kind];
      if (starter === undefined) continue;
      if (await this.#parkedForCaps(office, run, first)) continue;
      // The office's starts paused: the session keeps waiting (0020).
      if (this.#deps.startsPaused?.(officeId) != null) break;
      const claimedAt = this.#deps.clock.now();
      office.immediate(() => claimPlace(office, run.runId, claimedAt));
      let ok = false;
      try {
        ok = await starter(officeId, findRun(office, run.runId) ?? run, first);
      } catch (error) {
        this.#deps.warn?.("starting a session that waited for its place failed", {
          office: officeId,
          run: run.runId,
          kind: first.kind,
          reason: messageOf(error),
        });
      }
      if (ok) started += 1;
      else this.#requeue(office, run.runId, first, claimedAt);
    }
    if (waiting) this.#arm(officeId, state);
    else this.#disarm(state);
    return started;
  }

  /**
   * The shared pre-start cap check (DIPO-205): a fix or conflict wait whose run reached its caps
   * parks `budget-exceeded` and starts nothing; true when it parked.
   */
  async #parkedForCaps(office: OfficeHandle, run: StoredRun, start: PlaceStart): Promise<boolean> {
    const park = this.#deps.park;
    if (park === undefined) return false;
    if (start.kind !== START_KINDS.fix && start.kind !== START_KINDS.conflict) return false;
    const fired = reachedCaps(office, run, this.#deps.clock.now());
    if (fired === null) return false;
    try {
      await park(office, run, workRefOf(office, run.runId) ?? undefined, preStartEnding(fired));
      resolvePreStartIntent(office, run, this.#deps.clock.now());
    } catch (error) {
      this.#deps.warn?.("parking a run that reached its caps before its session failed", {
        run: run.runId,
        kind: start.kind,
        reason: messageOf(error),
      });
    }
    return true;
  }

  /**
   * A start that did not happen and left its run open with no session after the claim: the run
   * waits again as it did, so the place is not held by a run with no session.
   */
  #requeue(office: OfficeHandle, runId: RunId, start: PlaceStart, claimedAt: number): void {
    const run = findRun(office, runId);
    if (run === null || run.endedAt !== null || run.waiting != null) return;
    const session = office.get<{ found: number }>(
      `select 1 as found from agents where office_id = $office_id and run_id = $run
        and started_at >= $at limit 1`,
      { run: runId, at: claimedAt },
    );
    if (session !== null) return;
    // In line again where it was: the wait `claimPlace` counted is taken back.
    const counted =
      placeOfStart(start.kind) === "worker" ? Math.max(0, claimedAt - start.since) : 0;
    office.immediate(() =>
      applyRunEvent(office, runId, {
        kind: "requeue",
        as: start.kind,
        since: start.since,
        counted,
      }),
    );
  }

  #arm(officeId: OfficeId, state: Drained): void {
    if (this.#closed || state.timer !== null) return;
    state.timer = this.#deps.clock.setTimeout(() => {
      state.timer = null;
      if (this.#offices.get(officeId) === state) this.#background(officeId);
    }, PLACE_TICK_MS);
  }

  #disarm(state: Drained): void {
    if (state.timer !== null) this.#deps.clock.clearTimeout(state.timer);
    state.timer = null;
  }
}
