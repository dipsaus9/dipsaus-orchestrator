// The office's session places (0019 section 12, DIPO-142): each office has a worker place for one
// developer session (a first run, a fix round, a conflict hand-off or a resumed developer session)
// and a reviewer place for one reviewer session, so at most two Claude sessions run per office.
// Until M2, `work.run` keeps one worker per office (`maxAgents` above 1 is refused).
//
// - Counting. A place is held by an open story run (not ended, its claim live) with a live or
//   starting session: every such run that does not wait for its place. Its place comes from the
//   role of its newest agent while that agent runs, else from the role its active period is for
//   (the reviewer's in a `review` phase). A run held by a plan limit keeps its place: it resumes
//   into it after the reset. Session runs hold no place (the 2026-10-16 review finding), while
//   `activeRuns` and `hasActiveRun` still count them for `office.forget` and `dipo daemon status`.
// - Start order. A reopened run whose place is taken waits for it (`runs.waiting`, `waitForPlace`):
//   the worker place starts maintainer resumes first, then conflict hand-offs and fix rounds, then
//   new pickups by `work.run`; the reviewer place starts maintainer resumes of a review first,
//   then pending reviews, oldest In Review first. Within a rank the oldest wait goes first. A story
//   that waits for CI, for the maintainer or in the merge slot has an ended run and holds no place.
// - Plan limits pause places by scope (0008 section 7): a session or weekly hold pauses both places
//   in every office, a model-family hold pauses the place whose session uses that family, and an
//   `allowed_warning` stops new sessions of its scope. The hold is `PlanLimits.held` asked with the
//   model of the session the place would start. A run waiting under a hold carries the `plan-limit`
//   signal, so it shows health `limited`; it never parks.
// - Caps. A fix round or conflict hand-off whose run already reached its caps (a done path that
//   crossed one, DIPO-205) is not started: `Places.drain` parks the story `budget-exceeded`
//   (`pre-start-caps.ts`) before the starter is called.
// - `Places.drain` starts the first waiting session of each free, unpaused place through the
//   starter of its kind, after claiming the place in one transaction (`claimPlace`). It runs after
//   each worker exit decision, at office load, and every minute while anything waits.

import type { Clock, OfficeId, RunId, TimerHandle, WorkRef } from "@dipsaus-orchestrator/contract";

import { appendEntries, type NewEntry } from "../changelog/log";
import type { FeatureModule } from "../commands/registry";
import type { OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import { background } from "../platform/background";
import { withWorkViews, workRefOf } from "../views/work";

import { REVIEWER_ROLE } from "./caps";
import type { RunEnding } from "./control-types";
import { openWait } from "./outcome-types";
import { preStartEnding, reachedCaps, resolvePreStartIntent } from "./pre-start-caps";
import { activeRuns, findRun, type StoredRun } from "./records";
import { clearSignals, raiseSignal, type StoredSignal } from "./signals";

/** The two session places of an office. */
export type Place = "worker" | "reviewer";

export const PLACES: readonly Place[] = ["worker", "reviewer"];

/** What a session waits in its place as. */
export const START_KINDS = {
  /** Worker place: a maintainer resume of a developer session (0020 section 1). */
  resume: "resume",
  /** Worker place: a conflict hand-off (0019 section 10). */
  conflict: "conflict",
  /** Worker place: a fix round (0019 section 8). */
  fix: "fix",
  /** Worker place: a new pickup by `work.run`; never stored, a pickup is skipped instead. */
  pickup: "pickup",
  /** Reviewer place: a maintainer resume that starts a fresh review (0020 section 2). */
  reviewResume: "review-resume",
  /** Reviewer place: a pending review (0019 section 6). */
  review: "review",
} as const;

export type StartKind = (typeof START_KINDS)[keyof typeof START_KINDS];

/** Each kind's place and rank in that place's start order; a lower rank starts first. */
const ORDER: Readonly<Record<StartKind, { readonly place: Place; readonly rank: number }>> = {
  resume: { place: "worker", rank: 0 },
  conflict: { place: "worker", rank: 1 },
  fix: { place: "worker", rank: 1 },
  pickup: { place: "worker", rank: 2 },
  "review-resume": { place: "reviewer", rank: 0 },
  review: { place: "reviewer", rank: 1 },
};

/** The reviewer's model when the office names none (0019 section 4: `review.model` is opus). */
export const DEFAULT_REVIEW_MODEL = "opus";

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

/** -1 when `a` starts before `b` in their place's start order, 1 after; by rank, wait, run id. */
function compareStarts(a: PlaceStart, b: PlaceStart): number {
  const rank = ORDER[a.kind].rank - ORDER[b.kind].rank;
  if (rank !== 0) return rank;
  if (a.since !== b.since) return a.since - b.since;
  return (a.runId ?? "").localeCompare(b.runId ?? "");
}

/** `starts` in their places' start order (0019 section 12). */
export function startOrder(starts: readonly PlaceStart[]): PlaceStart[] {
  return starts.toSorted(compareStarts);
}

interface LatestAgent {
  readonly role: string;
  readonly ended_at: number | null;
}

function phaseOf(office: OfficeHandle, runId: string): string | null {
  return (
    office.get<{ value: string }>(
      `select value from run_steps where office_id = $office_id and run_id = $run
        and kind = 'phase' order by step desc limit 1`,
      { run: runId },
    )?.value ?? null
  );
}

/** The place an open story run holds: its running agent's role, else its active period's. */
export function placeOfRun(office: OfficeHandle, run: StoredRun): Place {
  const agent = office.get<LatestAgent>(
    `select role, ended_at from agents where office_id = $office_id and run_id = $run
      order by started_at desc, rowid desc limit 1`,
    { run: run.runId },
  );
  if (agent !== null && agent.ended_at === null) return placeOfRole(agent.role);
  return phaseOf(office, run.runId) === "review" ? "reviewer" : placeOfRole(run.role);
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
 * Why `start` cannot take its place now, or null: another run holds the place, or a start that
 * goes before it in the place's start order waits already. Plan-limit holds are not asked here.
 */
export function placeTaken(
  office: OfficeHandle,
  start: PlaceStart,
  waiting: readonly PlaceStart[] = waitingStarts(office),
): string | null {
  const place = placeOfStart(start.kind);
  const holder = placeHolders(office)[place].find((run) => run.runId !== start.runId);
  if (holder !== undefined) {
    return `the office's ${place} place is held by ${holder.story ?? holder.runId}`;
  }
  const ahead = waiting.find(
    (other) =>
      other.runId !== start.runId &&
      placeOfStart(other.kind) === place &&
      compareStarts(other, start) < 0,
  );
  if (ahead === undefined) return null;
  const run = ahead.runId === null ? null : findRun(office, ahead.runId);
  return `${run?.story ?? ahead.runId ?? "another story"} waits for the office's ${place} place first`;
}

/**
 * Which places a plan-limit hold pauses now (0019 section 12): each place asked with the model its
 * next session uses; null for a place no hold pauses. `held` is `PlanLimits.held` on the office's
 * adapter: with a model it answers the holds of every model and of that model's family.
 */
export function pausedPlaces(
  held: (model: string | null) => string | null,
  models: Readonly<Record<Place, string | null>>,
): Record<Place, string | null> {
  return { worker: held(models.worker), reviewer: held(models.reviewer) };
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
  office.run(
    `update runs set waiting = $kind, waiting_since = $at
      where office_id = $office_id and run_id = $run and ended_at is null`,
    { run: runId, kind, at },
  );
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
  office.run(
    `update runs set parked_ms = parked_ms + $waited, waiting = null, waiting_since = null
      where office_id = $office_id and run_id = $run`,
    { run: runId, waited: worker ? Math.max(0, at - (run.waitingSince ?? at)) : 0 },
  );
  return true;
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
  readonly offices: {
    get(office: OfficeId): OfficeHandle | undefined;
    config(office: OfficeId): OfficeConfig | undefined;
  };
  /** `PlanLimits.held`: why a new session on the adapter and model must wait, or null. */
  readonly held?: (adapter: string, model: string | null) => string | null;
  /** False while the daemon schedules no work (`safe`); true by default. */
  readonly scheduling?: () => boolean;
  /** The reviewer's model in the office; by default the office config's `review.model`. */
  readonly reviewModel?: (office: OfficeId) => string;
  /** Pending reviews of the office, oldest In Review first (0019 story G); none by default. */
  readonly pending?: (office: OfficeHandle) => readonly PlaceStart[];
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
   * Why a new session of `start` must wait now, or null: its place is taken (`placeTaken`), or a
   * plan-limit hold pauses the place for `model`, the model the session would use.
   */
  blocked(officeId: OfficeId, start: PlaceStart, model: string | null): string | null {
    const office = this.#deps.offices.get(officeId);
    if (office === undefined) return null;
    return placeTaken(office, start) ?? this.#paused(officeId, model);
  }

  /**
   * The model the next session of `place` uses for `run`: the reviewer's is `reviewModel`, else
   * the office config's `review.model` in force, else `DEFAULT_REVIEW_MODEL`.
   */
  modelOf(officeId: OfficeId, place: Place, run: StoredRun): string {
    return place === "reviewer"
      ? (this.#deps.reviewModel?.(officeId) ??
          this.#deps.offices.config(officeId)?.review.model ??
          DEFAULT_REVIEW_MODEL)
      : run.model;
  }

  /** Starts what waits for a free place in the office, once any drain under way finished. */
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
      name: "places",
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
      state = { busy: Promise.resolve(), timer: null };
      this.#offices.set(officeId, state);
    }
    return state;
  }

  #paused(officeId: OfficeId, model: string | null): string | null {
    const adapter = this.#deps.offices.config(officeId)?.worker.adapter;
    if (adapter === undefined || this.#deps.held === undefined) return null;
    return this.#deps.held(adapter, model);
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
    const holders = placeHolders(office);
    const starts = startOrder([...waitingStarts(office), ...(this.#deps.pending?.(office) ?? [])]);
    let waiting = false;
    let started = 0;
    for (const place of PLACES) {
      const first = starts.find((start) => placeOfStart(start.kind) === place);
      if (first === undefined) continue;
      waiting = true;
      if (holders[place].length > 0) continue;
      const run = first.runId === null ? null : findRun(office, first.runId);
      if (run === null) continue;
      const starter = this.#deps.starters[first.kind];
      if (starter === undefined) continue;
      if (await this.#parkedForCaps(office, run, first)) continue;
      const paused = this.#paused(officeId, this.modelOf(officeId, place, run));
      if (paused !== null) {
        this.#limited(office, run, paused);
        continue;
      }
      const claimedAt = this.#deps.clock.now();
      this.#write(office, () => {
        const at = claimedAt;
        claimPlace(office, run.runId, at);
        // The hold that paused its place is over; a run held by its own wait keeps its signal.
        if (openWait(office, run.runId) !== null) return [];
        return observed(office, run, clearSignals(office, run.runId, ["plan-limit"], at), at);
      });
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
      office.run(
        `update runs set waiting = $kind, waiting_since = $since,
           parked_ms = max(0, parked_ms - $counted)
          where office_id = $office_id and run_id = $run and ended_at is null`,
        { run: runId, kind: start.kind, since: start.since, counted },
      ),
    );
  }

  /** A waiting run whose place a plan limit pauses shows `limited` (the `plan-limit` signal). */
  #limited(office: OfficeHandle, run: StoredRun, why: string): void {
    this.#write(office, () => {
      const at = this.#deps.clock.now();
      const raised = raiseSignal(office, run.runId, "plan-limit", at);
      if (raised === null) return [];
      this.#deps.warn?.("a session waits for its place under a plan limit", {
        run: run.runId,
        why,
      });
      return observed(office, run, [raised], at);
    });
  }

  #write(office: OfficeHandle, fn: () => readonly NewEntry[]): void {
    const at = this.#deps.clock.now();
    const appended = office.immediate(() => {
      const entries = withWorkViews(office, fn());
      appendEntries(office, entries, { at });
      return entries.length;
    });
    if (appended > 0) this.#deps.onChanged?.(office.officeId as OfficeId);
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

/** The `work.observed` entries of signals raised or cleared on a story run. */
function observed(
  office: OfficeHandle,
  run: StoredRun,
  signals: readonly StoredSignal[],
  at: number,
): NewEntry[] {
  const work: WorkRef | null = workRefOf(office, run.runId);
  if (work === null || signals.length === 0) return [];
  return signals.map((signal) => ({
    type: "work.observed",
    key: work.key,
    run: run.runId,
    delta: {
      work,
      signal: signal.signal,
      since: new Date(signal.since).toISOString(),
      ...(signal.clearedAt === null ? {} : { clearedAt: new Date(at).toISOString() }),
    },
  }));
}
