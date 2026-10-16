// The plan-limit schedule (DIPO-61; 0008 section 7, 0006 decision 7). Plan limits are not the
// story's fault, so a held run always waits for the reset and never parks; nothing here falls back
// to another model and no wait has a maximum.
//
// - A rejected limit writes a wait fact on the run (DIPO-51, `openWait`) and tells the schedule
//   (`waiting`). With `resetsAt` the run is resumed two minutes after it; without it a resume probe
//   runs once an hour from the fact's `since`. Both are the cheapest resume: the native session
//   continues with "continue" (`RunOutcomes.resumeWait`), and when the plan is still limited the
//   worker meets the limit again and writes a new fact. `credits` has no reset coming: no timer;
//   `work.resume` on the held run lifts it.
// - While a fact is open, scheduling is held: scopes `session`, `weekly` and `unknown` hold new runs
//   in every office, `model:<family>` holds only runs whose model is of that family, `credits`
//   holds new runs on the run's adapter in every office (`held`).
// - An `allowed_warning` (`warned`) lets its run go on and holds new runs on its scope the same way
//   until `resetsAt`, or for an hour without one, with an `engine.notice` when the hold begins. Like
//   a rejected wait it holds every adapter. It is stored in `plan_limit_warnings` with its scope,
//   adapter (information only) and until time (DIPO-92); the row is deleted when the hold ends. A
//   forgotten office's holds leave memory and come back from their rows if it is opened again.
// - Recovery (0006 decision 7): the office load step reads every open wait fact back and arms it
//   again, so a restart between the reject and the reset resumes at the same time; a reset that
//   passed while the daemon was down resumes at once. It arms the office's stored warning holds
//   again too, without a new notice, and deletes those whose time passed while the daemon was down.
// - The timers run on the injected clock. A resume that comes due while scheduling is off (the
//   daemon in `safe`) or while the held worker has not exited yet is tried again a minute later.
// - `work.resume { story, note? }` (implemented here for held runs only): a story whose active run
//   holds an open wait is resumed at once, a `credits` hold on the adapter is lifted, and the
//   result names the run. A story with no held run fails `story.notPausedOrParked`; a held worker
//   that has not exited yet fails the retryable `run.hostAlive`.

import {
  type Clock,
  type Lifecycle,
  type OfficeId,
  type RunId,
  type TimerHandle,
  workResume,
} from "@dipsaus-orchestrator/contract";
import type { z } from "zod";

import { CommandError } from "../commands/errors";
import type { AsyncCommandContext, CommandOutcome, FeatureModule } from "../commands/registry";
import type { OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import type { AdapterHold, HoldNotice } from "../workers/hold";

import {
  openWait,
  type PlanLimitWaits,
  type PlanLimitWarning,
  type WaitFact,
  type WaitScope,
} from "./outcomes";
import { activeRuns, findRun } from "./records";

/** A run with `resetsAt` resumes this long after it (0008 section 7). */
export const PLAN_LIMIT_RESUME_AFTER_MS = 2 * 60_000;
/** Without `resetsAt` a resume probe runs this often (0008 section 7). */
export const PLAN_LIMIT_PROBE_MS = 60 * 60_000;
/** A resume that could not run now (scheduling off, worker not exited) is tried again after. */
export const PLAN_LIMIT_RETRY_MS = 60_000;

/** The office load step that reads open wait facts back after a restart. */
export const PLAN_LIMIT_STEP = "plan-limits/recover";
/** `work.resume` on a story with no held run (0005 section 4). */
export const NOT_PAUSED_OR_PARKED = "story.notPausedOrParked";
/** `work.resume` while the held worker has not exited (0005 section 10, retryable). */
export const RUN_HOST_ALIVE = "run.hostAlive";

/** `engine.notice` codes of the schedule. */
export const PLAN_LIMIT_NOTICES = {
  warning: "run.planLimitWarning",
} as const;

/** The resume `why` of a reset, a probe and `work.resume`. */
const WHY = {
  reset: "the plan limit reset",
  probe: "an hourly plan-limit probe",
  command: "work.resume of the held run",
} as const;

/**
 * True when `model` belongs to `family`: the family is one of the model name's words, so `opus`
 * matches `opus` and `claude-opus-5`.
 */
export function inFamily(model: string, family: string): boolean {
  return model
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .includes(family.toLowerCase());
}

/**
 * True when a hold of `scope` keeps a new run on `model` from starting. With `model` null only
 * the holds of every model count. `credits` holds an adapter, not a scope (see `held`).
 */
export function scopeHolds(scope: WaitScope, model: string | null): boolean {
  if (scope === "credits") return false;
  if (scope.startsWith("model:")) return model !== null && inFamily(model, scope.slice(6));
  return true;
}

/**
 * When the schedule resumes a held run, on the engine clock: two minutes after `resetsAt`, else at
 * the first whole hour after `since` that is not past `now`; null for `credits`, which waits for
 * `work.resume`.
 */
export function wakeAt(fact: WaitFact, now: number): number | null {
  if (fact.scope === "credits") return null;
  const reset = fact.resetsAt === undefined ? Number.NaN : Date.parse(fact.resetsAt);
  if (Number.isFinite(reset)) return reset + PLAN_LIMIT_RESUME_AFTER_MS;
  const hours = Math.max(1, Math.ceil((now - fact.since) / PLAN_LIMIT_PROBE_MS));
  return fact.since + hours * PLAN_LIMIT_PROBE_MS;
}

function describeScope(scope: WaitScope): string {
  if (scope === "credits") return "the plan needs credits";
  if (scope === "unknown") return "a plan limit (scope unknown, held as the session limit)";
  if (scope.startsWith("model:")) return `the ${scope.slice(6)} limit`;
  return `the ${scope} limit`;
}

/** What `resumeWait` answers (`RunOutcomes.resumeWait`). */
export type ResumeWaitOutcome = "started" | "failed" | "notHeld" | "busy";

export interface PlanLimitsDeps {
  readonly clock: Clock;
  readonly offices: {
    get(office: OfficeId): OfficeHandle | undefined;
    config(office: OfficeId): OfficeConfig | undefined;
  };
  /** Resumes a held run (`RunOutcomes.resumeWait`). */
  readonly resume: (office: OfficeId, run: RunId, why: string) => Promise<ResumeWaitOutcome>;
  /** False while the daemon schedules no work (`safe`); true by default. */
  readonly scheduling?: () => boolean;
  /** DIPO-43's adapter holds: a `credits` hold is lifted by `work.resume`. */
  readonly holds?: {
    adapterHeld(adapter: string): AdapterHold | null;
    lift(adapter: string): boolean;
  };
  /** Raises an `engine.notice` on the software stream (a warning holds every office). */
  readonly notify?: (notice: HoldNotice) => void;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

interface Wait {
  readonly office: OfficeId;
  readonly runId: RunId;
  readonly fact: WaitFact;
  readonly model: string;
  readonly adapter: string | null;
  timer: TimerHandle | null;
}

interface Warning {
  /** The office whose run warned: its row in `plan_limit_warnings` holds the warning. */
  readonly office: OfficeId;
  /** The adapter the warning run ran on; null when the office has no configuration. */
  readonly adapter: string | null;
  readonly scope: WaitScope;
  readonly until: number;
}

/** A stored warning hold (`plan_limit_warnings`, migration 26). */
interface WarningRow {
  readonly adapter: string;
  readonly scope: string;
  readonly until_at: number;
}

function warningKey(office: OfficeId, adapter: string | null, scope: WaitScope): string {
  return `${office}\u0000${adapter ?? ""}\u0000${scope}`;
}

/** The scopes a warning holds; `credits` is never a warning. */
function isWarningScope(scope: string): scope is WaitScope {
  return (
    scope === "session" || scope === "weekly" || scope === "unknown" || scope.startsWith("model:")
  );
}

type ResumeArgs = z.output<typeof workResume.args>;
type ResumeResult = z.input<typeof workResume.result>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PlanLimits implements PlanLimitWaits {
  readonly #deps: PlanLimitsDeps;
  /** Open waits by run. */
  readonly #waits = new Map<string, Wait>();
  /** Warnings by office, adapter and scope (`warningKey`), as `plan_limit_warnings` keeps them. */
  readonly #warnings = new Map<string, Warning>();
  readonly #inflight = new Set<Promise<unknown>>();

  constructor(deps: PlanLimitsDeps) {
    this.#deps = deps;
  }

  /** A wait fact was written on the run: hold its scope and arm its resume. */
  waiting(office: OfficeId, runId: RunId, fact: WaitFact): void {
    const handle = this.#deps.offices.get(office);
    if (handle === undefined) return;
    this.#register(handle, office, runId, fact);
  }

  /**
   * An `allowed_warning`: new runs on its scope wait until the reset, an hour without one. The
   * hold is stored with the adapter as information, so it survives a restart (DIPO-92).
   */
  warned(office: OfficeId, warning: PlanLimitWarning): void {
    const now = this.#deps.clock.now();
    const scope: WaitScope = warning.scope ?? "unknown";
    const reset = warning.resetsAt === undefined ? Number.NaN : Date.parse(warning.resetsAt);
    const until = Number.isFinite(reset) ? reset : now + PLAN_LIMIT_PROBE_MS;
    if (until <= now) return;
    const adapter = this.#deps.offices.config(office)?.worker.adapter ?? null;
    this.#store(office, adapter, scope, until);
    const key = warningKey(office, adapter, scope);
    const previous = this.#warnings.get(key);
    if (previous !== undefined && previous.until >= until) return;
    // One notice per hold: none while another warning already holds this scope.
    const announced = [...this.#warnings.values()].some(
      (other) => other.scope === scope && other.until > now,
    );
    this.#warnings.set(key, { office, adapter, scope, until });
    if (announced) return;
    this.#deps.notify?.({
      level: "warn",
      code: PLAN_LIMIT_NOTICES.warning,
      text: `The plan warned that ${describeScope(scope)} is near; dipo starts no new runs on it until ${new Date(until).toISOString()}. Running workers go on.`,
    });
  }

  /**
   * Why a new run on `adapter` with `model` must wait, or null. With `model` null only the holds
   * of every model count (`work.run` before it knows the story's tier).
   */
  held(adapter: string, model: string | null): string | null {
    const now = this.#deps.clock.now();
    for (const wait of this.#waits.values()) {
      if (!this.#stillOpen(wait)) continue;
      const story = this.#storyOf(wait);
      if (wait.fact.scope === "credits") {
        if (wait.adapter === null || wait.adapter === adapter) {
          return `New runs on ${adapter} are held in every office: the plan needs credits (${story} waits). Deal with the plan, then send work.resume for ${story}.`;
        }
        continue;
      }
      if (!scopeHolds(wait.fact.scope, model)) continue;
      const until = wait.fact.resetsAt === undefined ? "" : ` until ${wait.fact.resetsAt}`;
      return `New runs wait for ${describeScope(wait.fact.scope)}${until}: ${story} is held by it and resumes after the reset.`;
    }
    for (const [key, warning] of this.#warnings) {
      if (warning.until <= now) {
        this.#warnings.delete(key);
        this.#unstore(warning);
        continue;
      }
      // The office was forgotten: its hold goes from memory; its row is armed again if it reopens.
      if (this.#deps.offices.get(warning.office) === undefined) {
        this.#warnings.delete(key);
        continue;
      }
      if (!scopeHolds(warning.scope, model)) continue;
      return `New runs wait until ${new Date(warning.until).toISOString()}: the plan warned that ${describeScope(warning.scope)} is near.`;
    }
    return null;
  }

  /**
   * Resumes a held run now (`work.resume`): its timer stops, a `credits` hold on the adapter is
   * lifted, and the session continues.
   */
  async resumeNow(office: OfficeId, runId: RunId): Promise<ResumeWaitOutcome> {
    const wait = this.#waits.get(runId);
    if (wait !== undefined) this.#drop(wait);
    const config = this.#deps.offices.config(office);
    const adapter = wait?.adapter ?? config?.worker.adapter ?? null;
    const holds = this.#deps.holds;
    if (adapter !== null && holds?.adapterHeld(adapter)?.check === "credits") holds.lift(adapter);
    const outcome = await this.#deps.resume(office, runId, WHY.command);
    // The old worker has not exited: the wait stays as it was.
    if (outcome === "busy" && wait !== undefined) this.#rearm(wait);
    return outcome;
  }

  /**
   * Reads the office's open wait facts and stored warning holds back after a load (0006 decision
   * 7); answers how many it armed.
   */
  recover(office: OfficeId, handle: OfficeHandle): number {
    let count = 0;
    for (const run of activeRuns(handle)) {
      if (run.kind !== "story") continue;
      const fact = openWait(handle, run.runId);
      if (fact === null) continue;
      this.#register(handle, office, run.runId, fact);
      count += 1;
    }
    return count + this.#recoverWarnings(office, handle);
  }

  /** Resolves once every resume this schedule started has finished. */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled(this.#inflight);
  }

  /** Stops every timer; the wait facts stay in the database. */
  close(): void {
    for (const wait of this.#waits.values()) {
      if (wait.timer !== null) this.#deps.clock.clearTimeout(wait.timer);
    }
    this.#waits.clear();
    this.#warnings.clear();
  }

  /** The load step that recovers waits, and `work.resume` for held runs. */
  get feature(): FeatureModule {
    return {
      name: "plan-limits",
      register: (registry) => {
        registry.registerLoadStep(PLAN_LIMIT_STEP, (ctx) => {
          this.recover(ctx.officeId, ctx.office);
          return { ok: true };
        });
        registry.addAsyncOfficeCommand({
          definition: workResume,
          handle: (ctx, args) => this.resumeCommand(ctx, args),
        });
      },
    };
  }

  /** `work.resume`: see the file comment. */
  async resumeCommand(
    ctx: AsyncCommandContext,
    args: ResumeArgs,
  ): Promise<CommandOutcome<ResumeResult>> {
    const handle = ctx.office;
    const identity = ctx.stories.get(args.story);
    if (identity === undefined) throw new Error(`${args.story} was not resolved`);
    const run = activeRuns(handle).find(
      (candidate) => candidate.kind === "story" && candidate.key === identity.key,
    );
    const notHeld = () =>
      new CommandError(
        NOT_PAUSED_OR_PARKED,
        `${identity.story} has no run held by a plan limit; work.resume continues only those for now.`,
        { story: identity.story },
      );
    if (run === undefined || openWait(handle, run.runId) === null) throw notHeld();
    const outcome = await this.resumeNow(handle.officeId, run.runId);
    switch (outcome) {
      case "notHeld":
        throw notHeld();
      case "busy":
        throw new CommandError(
          RUN_HOST_ALIVE,
          `${identity.story}'s held worker has not exited yet; send work.resume again in a moment.`,
          { story: identity.story, run: run.runId },
        );
      case "started":
        return {
          result: {
            story: identity.story,
            key: identity.key,
            to: "In Progress",
            run: run.runId,
          },
        };
      case "failed":
        return {
          result: {
            story: identity.story,
            key: identity.key,
            to: this.#afterFailure(handle, run.runId),
          },
        };
    }
  }

  // ---- warnings --------------------------------------------------------------------------------

  /** Stores a warning hold; a later warning on the same scope moves its time forward, never back. */
  #store(office: OfficeId, adapter: string | null, scope: WaitScope, until: number): void {
    const handle = this.#deps.offices.get(office);
    if (handle === undefined) return;
    if (adapter === null) {
      // The hold still applies in memory; a restart would forget it.
      this.#deps.warn?.("a plan-limit warning was not stored: the office has no adapter", {
        office,
        scope,
      });
      return;
    }
    try {
      handle.immediate(() =>
        handle.run(
          `insert into plan_limit_warnings (office_id, adapter, scope, until_at, warned_at)
           values ($office_id, $adapter, $scope, $until, $now)
           on conflict (office_id, adapter, scope) do update
             set until_at = max(until_at, excluded.until_at), warned_at = excluded.warned_at`,
          { adapter, scope, until, now: this.#deps.clock.now() },
        ),
      );
    } catch (error) {
      // The hold still applies in memory; only a restart would forget it.
      this.#deps.warn?.("storing a plan-limit warning failed", {
        office,
        scope,
        reason: messageOf(error),
      });
    }
  }

  /** Deletes the stored row of a hold that ended, unless a later warning moved it forward. */
  #unstore(warning: Warning): void {
    const handle = this.#deps.offices.get(warning.office);
    if (handle === undefined || warning.adapter === null) return;
    const adapter = warning.adapter;
    try {
      handle.immediate(() =>
        handle.run(
          `delete from plan_limit_warnings
           where office_id = $office_id and adapter = $adapter and scope = $scope
             and until_at <= $now`,
          { adapter, scope: warning.scope, now: this.#deps.clock.now() },
        ),
      );
    } catch (error) {
      this.#deps.warn?.("deleting an ended plan-limit warning failed", {
        office: warning.office,
        scope: warning.scope,
        reason: messageOf(error),
      });
    }
  }

  /**
   * Arms the office's stored warning holds again, without a notice: the hold was announced when it
   * began. A hold whose time passed while the daemon was down is deleted.
   */
  #recoverWarnings(office: OfficeId, handle: OfficeHandle): number {
    const now = this.#deps.clock.now();
    let rows: WarningRow[];
    try {
      handle.immediate(() =>
        handle.run(
          "delete from plan_limit_warnings where office_id = $office_id and until_at <= $now",
          { now },
        ),
      );
      rows = handle.all<WarningRow>(
        `select adapter, scope, until_at from plan_limit_warnings where office_id = $office_id
         order by adapter, scope`,
      );
    } catch (error) {
      // The waits are armed already; a warning hold lost here only lets new runs start sooner.
      this.#deps.warn?.("reading stored plan-limit warnings failed", {
        office,
        reason: messageOf(error),
      });
      return 0;
    }
    let count = 0;
    for (const row of rows) {
      if (!isWarningScope(row.scope)) continue;
      const key = warningKey(office, row.adapter, row.scope);
      const previous = this.#warnings.get(key);
      count += 1;
      if (previous !== undefined && previous.until >= row.until_at) continue;
      this.#warnings.set(key, {
        office,
        adapter: row.adapter,
        scope: row.scope,
        until: row.until_at,
      });
    }
    return count;
  }

  // ---- waits -----------------------------------------------------------------------------------

  #register(handle: OfficeHandle, office: OfficeId, runId: RunId, fact: WaitFact): void {
    const run = findRun(handle, runId);
    if (run === null || run.endedAt !== null) return;
    const previous = this.#waits.get(runId);
    if (previous?.timer != null) this.#deps.clock.clearTimeout(previous.timer);
    const wait: Wait = {
      office,
      runId,
      fact,
      model: run.model,
      adapter: this.#deps.offices.config(office)?.worker.adapter ?? null,
      timer: null,
    };
    this.#waits.set(runId, wait);
    const at = wakeAt(fact, this.#deps.clock.now());
    if (at !== null) this.#arm(wait, at);
  }

  #arm(wait: Wait, at: number): void {
    const delay = Math.max(0, at - this.#deps.clock.now());
    wait.timer = this.#deps.clock.setTimeout(() => {
      wait.timer = null;
      this.#wake(wait);
    }, delay);
  }

  /** Tries the resume again a minute from now, as long as the wait is still this one. */
  #rearm(wait: Wait): void {
    const current = this.#waits.get(wait.runId);
    if (current !== undefined && current !== wait) return;
    this.#waits.set(wait.runId, wait);
    if (wait.timer !== null) this.#deps.clock.clearTimeout(wait.timer);
    if (wait.fact.scope === "credits") return;
    this.#arm(wait, this.#deps.clock.now() + PLAN_LIMIT_RETRY_MS);
  }

  #wake(wait: Wait): void {
    if (this.#waits.get(wait.runId) !== wait) return;
    if (!this.#stillOpen(wait)) return;
    if (this.#deps.scheduling?.() === false) {
      this.#rearm(wait);
      return;
    }
    // Dropped before the resume: a limit the new session meets writes a new wait.
    this.#drop(wait);
    const why = wait.fact.resetsAt === undefined ? WHY.probe : WHY.reset;
    const job = this.#deps
      .resume(wait.office, wait.runId, why)
      .then((outcome) => {
        if (outcome === "busy") this.#rearm(wait);
      })
      .catch((error: unknown) => {
        this.#deps.warn?.("resuming a run held by a plan limit failed", {
          run: wait.runId,
          reason: messageOf(error),
        });
      });
    this.#inflight.add(job);
    void job.finally(() => this.#inflight.delete(job));
  }

  /** True while the wait's run is active and its fact open; a closed one is dropped. */
  #stillOpen(wait: Wait): boolean {
    const handle = this.#deps.offices.get(wait.office);
    const run = handle === undefined ? null : findRun(handle, wait.runId);
    if (
      handle !== undefined &&
      run !== null &&
      run.endedAt === null &&
      openWait(handle, wait.runId) !== null
    ) {
      return true;
    }
    this.#drop(wait);
    return false;
  }

  #drop(wait: Wait): void {
    if (wait.timer !== null) this.#deps.clock.clearTimeout(wait.timer);
    wait.timer = null;
    if (this.#waits.get(wait.runId) === wait) this.#waits.delete(wait.runId);
  }

  #storyOf(wait: Wait): string {
    const handle = this.#deps.offices.get(wait.office);
    return (handle === undefined ? null : findRun(handle, wait.runId)?.story) ?? wait.runId;
  }

  /** Where the story is after a resume that did not start: parked, else released to Ready. */
  #afterFailure(handle: OfficeHandle, runId: RunId): Lifecycle {
    const parked = handle.get(
      "select 1 as found from parks where office_id = $office_id and run_id = $run",
      { run: runId },
    );
    return parked === null ? "Ready" : "Parked";
  }
}
