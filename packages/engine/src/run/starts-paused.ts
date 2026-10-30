// The office's starts paused (0020, 0008): the one state for problems that belong to the office and
// not to a story. While it holds, no new session starts in the office: no pickup (`work.run`), no
// session waiting for its place (`places.ts`), no resume (`park-resume.ts`) and no scan fallback
// session. The desk shows it first, with what lifts it (`views/desk.ts`).
//
// It has two reasons:
//
// - `plan-limit`: a session met the subscription's plan limit (a `rate_limit_event` `rejected`,
//   `credits_required`, or a turn ended by a 429). All offices draw from the one subscription
//   (0001), so every loaded office pauses. Each office's `starts_paused` row keeps the detail, the
//   time and when it lifts by itself, so a restart pauses again until then: two minutes after the
//   reset time the limit named, an hour after the limit when it named none (the next session finds
//   out whether it still holds), and never for `credits_required`. The session that met the limit
//   parks `worker-failed` with the detail "plan limit until <time>" and `parks.resume_on_lift` set
//   (`planLimitPause` builds both). When the office's starts paused lifts, dipo resumes exactly
//   those parks through the one resume path (`ParkResumes`), and no other park.
// - `adapter`: a failed adapter check (a launch check, a start failure, the box token check). The
//   adapter's hold rules (`workers/hold.ts`) keep their record here: a `starts_paused` row with
//   reason `adapter`, the adapter and its failures, in every registered office, loaded or not
//   (`officeHoldStore`), so it survives a restart and an office loaded later finds it. It lifts when the check passes again (`dipo run
//   <ID>` repeats the launch checks), or for the box token only when `dipo login box` replaces it.
//   The story stays where it was, so no park resumes for it.
//
// `dipo daemon resume-scheduling` lifts both, in every office, but never the box token's hold. An
// office loaded while another office is paused takes that pause over. The timers run on the
// injected clock; a lift that comes due while the daemon schedules no work is tried again a minute
// later.

import {
  type Clock,
  type OfficeId,
  StoryKey,
  type TimerHandle,
} from "@dipsaus-orchestrator/contract";

import { appendEntries, type NewEntry } from "../changelog/log";
import { CommandError } from "../commands/errors";
import type { FeatureModule } from "../commands/registry";
import type { OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import type { SqlRunner } from "../platform/sqlite";
import { background } from "../platform/background";
import {
  type AdapterHold,
  type AdapterHoldRecord,
  type AdapterHoldStore,
  holdFailures,
  holdLift,
  type LaunchCheckFailure,
} from "../workers/hold";

import type { PlanLimitHit } from "./outcome-types";
import { keepParkedOnLift } from "./park-records";

/** A plan limit with a reset time lifts this long after it (0008). */
export const PLAN_LIMIT_RESUME_AFTER_MS = 2 * 60_000;
/** A plan limit that named no reset time lifts this long after it. */
export const PLAN_LIMIT_UNKNOWN_RESET_MS = 60 * 60_000;
/** A lift or resume that could not run now (scheduling off, a worker not exited) is tried again after. */
export const STARTS_PAUSED_RETRY_MS = 60_000;

/** The office load step that pauses the office again after a restart, or lifts what is due. */
export const STARTS_PAUSED_STEP = "starts-paused/recover";

/** `engine.notice` codes of the office's starts paused. */
export const STARTS_PAUSED_NOTICES = {
  paused: "office.startsPaused",
  lifted: "office.startsLifted",
  notResumed: "office.parkNotResumed",
} as const;

/** The command line that lifts the office's starts paused by hand. */
export const LIFT_COMMAND = "dipo daemon resume-scheduling";

export type StartsPausedReason = "plan-limit" | "adapter";

/** The office's starts paused, as the gates, the refusals and the desk read it. */
export interface StartsPausedState {
  readonly reason: StartsPausedReason;
  /** What paused it, one line of text. */
  readonly detail: string;
  /** When it began, on the engine clock. */
  readonly since: number;
  /** When it lifts by itself, on the engine clock; null when only a check or the command lifts it. */
  readonly until: number | null;
  /** What lifts it, as one sentence. */
  readonly lifts: string;
  /** The adapter hold behind an `adapter` pause. */
  readonly hold?: AdapterHold;
}

/** The pause a plan limit makes and the detail of the park of the session that met it. */
export interface PlanLimitPause {
  readonly detail: string;
  readonly since: number;
  readonly until: number | null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The pause of a plan limit met at `now`, and the park detail of its session: "plan limit until
 * <reset>" with a reset time (lifting two minutes after it), "plan limit: the plan needs credits"
 * for `credits_required` (lifting only by command), else a plain "plan limit" that lifts an hour
 * later.
 */
export function planLimitPause(limit: PlanLimitHit, now: number): PlanLimitPause {
  if (limit.credits) {
    return { detail: "plan limit: the plan needs credits", since: now, until: null };
  }
  const reset = limit.resetsAt === undefined ? Number.NaN : Date.parse(limit.resetsAt);
  if (Number.isFinite(reset)) {
    return {
      detail: `plan limit until ${iso(reset)}`,
      since: now,
      until: Math.max(now, reset) + PLAN_LIMIT_RESUME_AFTER_MS,
    };
  }
  return {
    detail: "plan limit (no reset time given)",
    since: now,
    until: now + PLAN_LIMIT_UNKNOWN_RESET_MS,
  };
}

/** One sentence: what lifts a plan-limit pause. */
function planLimitLifts(until: number | null): string {
  return until === null
    ? `\`${LIFT_COMMAND}\` lifts it once the plan has credits.`
    : `It lifts by itself at ${iso(until)}, or with \`${LIFT_COMMAND}\`.`;
}

/** The `run.refused` of something that would start a session while the office's starts are paused. */
export function startsPausedRefusal(
  what: string,
  state: StartsPausedState,
  details: Readonly<Record<string, unknown>> = {},
): CommandError {
  return new CommandError(
    "run.refused",
    `${what}: the office's starts are paused (${state.detail}). ${state.lifts}`,
    { ...details, check: state.reason },
  );
}

/** A park dipo resumes by itself when the office's starts paused lifts. */
export interface LiftedPark {
  readonly parkId: number;
  readonly key: StoryKey;
  readonly story: string;
}

/**
 * How the resume of a lifted park went: `resumed` (or queued for its place), `retry` (scheduling
 * off, a worker not exited yet; tried again a minute later), or `refused` with why (it stays
 * parked for the maintainer).
 */
export type LiftedResume =
  | { readonly outcome: "resumed" }
  | { readonly outcome: "retry"; readonly why: string }
  | { readonly outcome: "refused"; readonly why: string };

export interface StartsPausedDeps {
  readonly clock: Clock;
  readonly offices: {
    get(office: OfficeId): OfficeHandle | undefined;
    config(office: OfficeId): OfficeConfig | undefined;
  };
  /** The loaded offices, which a plan limit pauses together (0001); only the hit office without it. */
  readonly loaded?: () => readonly OfficeId[];
  /**
   * The daemon's worker adapter: every office runs on it (0001: one subscription, one adapter). No
   * `adapter` pause without it.
   */
  readonly adapter?: string;
  /** The adapter holds of a failed adapter check (`AdapterHolds`); no `adapter` pause without them. */
  readonly holds?: {
    adapterHeld(adapter: string): AdapterHold | null;
    lift(adapter: string, why?: string): boolean;
  };
  /** Resumes one park a plan limit made, through the one resume path (`Resumption.resumeLifted`). */
  readonly resume?: (office: OfficeId, park: LiftedPark) => Promise<LiftedResume>;
  /** Hears an office whose starts are no longer paused: what waited for a place may start. */
  readonly onLifted?: (office: OfficeId) => void;
  /** False while the daemon schedules no work; true by default. */
  readonly scheduling?: () => boolean;
  readonly onChanged?: (office: OfficeId) => void;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

interface AdapterRow {
  readonly adapter: string;
  readonly failures: string;
  readonly since: number;
}

/** The offices the adapter hold store reaches: the registered ones, and the loaded ones' handles. */
export interface HoldStoreOffices {
  /** A loaded office's handle, for its notices. */
  get(office: OfficeId): OfficeHandle | undefined;
  loaded(): readonly OfficeId[];
  /**
   * The state database's one connection, for the rows of every registered office (an adapter hold
   * is the daemon's, not one office's); null before the database opened.
   */
  connection(): (SqlRunner & { immediate<T>(fn: () => T): T }) | null;
}

/** The office's adapter pause row, or null. */
function rowOf(handle: OfficeHandle): AdapterRow | null {
  return handle.get<AdapterRow>(
    `select adapter, failures, since from starts_paused
      where office_id = $office_id and reason = 'adapter'`,
  );
}

/** The first line of a hold's failures, as the row's detail. */
function failureLine(failures: readonly LaunchCheckFailure[]): string {
  const [first] = failures;
  return first === undefined ? "" : `${first.check}: ${first.detail}`;
}

/** The registered offices, in SQL. */
const REGISTERED = "select office_id from offices where forgotten_at is null";

/**
 * The adapter holds' record (0020): a `starts_paused` row with reason `adapter` in every registered
 * office, loaded or not, since one adapter runs every office (0001). A hold is read from any of
 * them, written to all of them, with an `office.startsPaused` notice in each loaded office where it
 * is new, and cleared from all of them, with `office.startsLifted` in each loaded office that had
 * it. So a hold set while no office is loaded is kept, and a lift reaches an office that was not
 * loaded. Before the database opened nothing is stored.
 */
export function officeHoldStore(clock: Clock, offices: HoldStoreOffices): AdapterHoldStore {
  const loadedHandles = (): OfficeHandle[] =>
    offices.loaded().flatMap((id) => {
      const handle = offices.get(id);
      return handle === undefined ? [] : [handle];
    });
  const notice = (handle: OfficeHandle, code: string, text: string): void => {
    appendEntries(handle, [{ type: "engine.notice", delta: { level: "warn", code, text } }], {
      at: clock.now(),
    });
  };
  const open = () => {
    const connection = offices.connection();
    if (connection === null) throw new Error("the state database is not open yet");
    return connection;
  };
  return {
    read: (adapter) => {
      const row = offices.connection()?.get<AdapterRow>(
        `select adapter, failures, since from starts_paused
          where reason = 'adapter' and adapter = $adapter and office_id in (${REGISTERED})
          order by since desc, office_id limit 1`,
        { adapter },
      );
      if (row === null || row === undefined) return null;
      return {
        adapter,
        failures: JSON.parse(row.failures) as LaunchCheckFailure[],
        since: row.since,
      };
    },
    write: (record) => {
      const connection = open();
      // The loaded offices first, each with its notice; then every other registered office.
      for (const handle of loadedHandles()) writeHoldRow(handle, record, notice);
      connection.immediate(() =>
        connection.run(
          `insert into starts_paused (office_id, reason, detail, since, adapter, failures)
           select office_id, 'adapter', $detail, $since, $adapter, $failures from offices
            where forgotten_at is null
           on conflict (office_id, reason) do update set detail = excluded.detail,
             since = excluded.since, adapter = excluded.adapter, failures = excluded.failures`,
          {
            detail: failureLine(record.failures),
            since: record.since,
            adapter: record.adapter,
            failures: JSON.stringify(record.failures),
          },
        ),
      );
    },
    clear: (adapter) => {
      const connection = open();
      for (const handle of loadedHandles()) {
        handle.immediate(() => {
          const row = rowOf(handle);
          if (row === null || row.adapter !== adapter) return;
          handle.run(
            "delete from starts_paused where office_id = $office_id and reason = 'adapter'",
          );
          notice(
            handle,
            STARTS_PAUSED_NOTICES.lifted,
            `The office's starts paused (adapter check failed: ${failureLine(JSON.parse(row.failures) as LaunchCheckFailure[])}) lifted.`,
          );
        });
      }
      connection.immediate(() =>
        connection.run(
          "delete from starts_paused where reason = 'adapter' and adapter = $adapter",
          { adapter },
        ),
      );
    },
    adapters: () =>
      (
        offices.connection()?.all<{ adapter: string }>(
          `select distinct adapter from starts_paused
            where reason = 'adapter' and adapter is not null and office_id in (${REGISTERED})`,
        ) ?? []
      ).map((row) => row.adapter),
  };
}

/** Writes `record` as the office's adapter pause, with a notice when it is new there. */
function writeHoldRow(
  handle: OfficeHandle,
  record: AdapterHoldRecord,
  notice: (handle: OfficeHandle, code: string, text: string) => void,
): void {
  handle.immediate(() => {
    const before = handle.get<{ found: number }>(
      "select 1 as found from starts_paused where office_id = $office_id and reason = 'adapter'",
    );
    handle.run(
      `insert into starts_paused (office_id, reason, detail, since, adapter, failures)
       values ($office_id, 'adapter', $detail, $since, $adapter, $failures)
       on conflict (office_id, reason) do update set detail = excluded.detail,
         since = excluded.since, adapter = excluded.adapter, failures = excluded.failures`,
      {
        detail: failureLine(record.failures),
        since: record.since,
        adapter: record.adapter,
        failures: JSON.stringify(record.failures),
      },
    );
    if (before === null) {
      notice(
        handle,
        STARTS_PAUSED_NOTICES.paused,
        `The office's starts are paused: adapter check failed: ${failureLine(record.failures)}. No new session starts until it lifts.`,
      );
    }
  });
}

interface PausedRow {
  readonly detail: string;
  readonly since: number;
  readonly until_at: number | null;
}

interface ParkRow {
  readonly park_id: number;
  readonly key: string;
  readonly story_id: string;
}

export class StartsPaused {
  readonly #deps: StartsPausedDeps;
  /** The lift timer of each office paused by a plan limit. */
  readonly #timers = new Map<OfficeId, TimerHandle>();
  /** The retry timer of each office whose lifted parks could not all resume yet. */
  readonly #retries = new Map<OfficeId, TimerHandle>();
  /** The resume pass under way in each office, and whether another was asked for meanwhile. */
  readonly #passes = new Map<OfficeId, { again: boolean }>();
  readonly #inflight = new Set<Promise<unknown>>();
  #closed = false;

  constructor(deps: StartsPausedDeps) {
    this.#deps = deps;
  }

  /**
   * The office's starts paused, or null: its plan-limit row first, else the hold of its adapter. A
   * plan-limit row whose time passed still holds until its lift ran.
   */
  state(officeId: OfficeId): StartsPausedState | null {
    const handle = this.#deps.offices.get(officeId);
    const row = handle === undefined ? null : this.#row(handle);
    if (row !== null) {
      return {
        reason: "plan-limit",
        detail: row.detail,
        since: row.since,
        until: row.until_at,
        lifts: planLimitLifts(row.until_at),
      };
    }
    const adapter = this.#adapterOf(officeId);
    const hold = adapter === undefined ? null : (this.#deps.holds?.adapterHeld(adapter) ?? null);
    if (hold === null) return null;
    return {
      reason: "adapter",
      detail: `${hold.adapter}: ${holdFailures(hold)}`,
      since: hold.since,
      until: null,
      // The box token's hold lifts only with `dipo login box` (DIPO-271), never by the command.
      lifts:
        hold.liftedBy === undefined
          ? `${holdLift(hold)} \`${LIFT_COMMAND}\` lifts it by hand.`
          : holdLift(hold),
      hold,
    };
  }

  /**
   * A session met the plan limit (see the file comment): every loaded office pauses with `pause`,
   * and a later limit only moves the lift later. The hit office pauses even when it is not listed.
   */
  pausePlanLimit(hit: OfficeId, pause: PlanLimitPause): void {
    const offices = new Set<OfficeId>([hit, ...(this.#deps.loaded?.() ?? [])]);
    for (const officeId of offices) {
      const handle = this.#deps.offices.get(officeId);
      if (handle === undefined) continue;
      try {
        this.#pause(officeId, handle, pause);
      } catch (error) {
        this.#deps.warn?.("pausing an office's starts for a plan limit failed", {
          office: officeId,
          reason: messageOf(error),
        });
      }
    }
  }

  /**
   * Lifts the office's starts paused by hand (`daemon.resumeScheduling`): its plan-limit pause and
   * a hold of its adapter a passing check would lift. True when something lifted.
   */
  lift(officeId: OfficeId, why: string): boolean {
    let lifted = this.#liftRow(officeId, why);
    const adapter = this.#adapterOf(officeId);
    const by = `${why.charAt(0).toUpperCase()}${why.slice(1)}`;
    if (adapter !== undefined && this.#deps.holds?.lift(adapter, by) === true) lifted = true;
    this.#resumeLifted(officeId);
    return lifted;
  }

  /**
   * Resumes the parks a plan limit made in the office while its starts are not paused: after a
   * load parked runs a plan limit held before the upgrade (`outcome-restart.ts`).
   */
  resumeLifted(officeId: OfficeId): void {
    this.#resumeLifted(officeId);
  }

  /** `lift` in every loaded office; returns how many offices had something lifted. */
  liftAll(why: string): number {
    let count = 0;
    for (const officeId of this.#deps.loaded?.() ?? []) {
      if (this.lift(officeId, why)) count += 1;
    }
    return count;
  }

  /**
   * An adapter hold was lifted (a passing check, `dipo login box`): each loaded office that is no
   * longer paused resumes the parks a plan limit left (a limit that lifted while the adapter held).
   */
  adapterReleased(): void {
    for (const officeId of this.#deps.loaded?.() ?? []) this.#resumeLifted(officeId);
  }

  /**
   * After a load: a pause whose lift time passed while the daemon was down lifts now, one still
   * due is armed again, and an office not paused resumes the parks a plan limit left. Both run
   * after the load on the clock, so the office can be reached by id.
   */
  recover(officeId: OfficeId, handle: OfficeHandle): void {
    this.#takeOver(officeId, handle);
    const row = this.#row(handle);
    if (row === null) {
      this.#deps.clock.setTimeout(() => this.#resumeLifted(officeId), 0);
      return;
    }
    if (row.until_at !== null) this.#arm(officeId, row.until_at);
  }

  /** Resolves once every resume this started has finished. */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled(this.#inflight);
  }

  /** Stops every timer; the rows stay. */
  close(): void {
    this.#closed = true;
    for (const timer of [...this.#timers.values(), ...this.#retries.values()]) {
      this.#deps.clock.clearTimeout(timer);
    }
    this.#timers.clear();
    this.#retries.clear();
  }

  /** The load step that pauses an office again after a restart (`recover`). */
  get feature(): FeatureModule {
    return {
      name: "starts-paused",
      register: (registry) => {
        registry.registerLoadStep(STARTS_PAUSED_STEP, (ctx) => {
          this.recover(ctx.officeId, ctx.office);
          return { ok: true };
        });
      },
    };
  }

  /** The adapter of an office with a configuration: the daemon's one adapter. */
  #adapterOf(officeId: OfficeId): string | undefined {
    return this.#deps.offices.config(officeId) === undefined ? undefined : this.#deps.adapter;
  }

  // ---- the plan-limit pause --------------------------------------------------------------------

  #row(handle: OfficeHandle): PausedRow | null {
    return handle.get<PausedRow>(
      `select detail, since, until_at from starts_paused
        where office_id = $office_id and reason = 'plan-limit'`,
    );
  }

  /**
   * An office loaded while another is paused takes the pause over (0001: one subscription, one
   * adapter): the live plan-limit pause that lifts last, and its adapter's hold, kept for every
   * registered office.
   */
  #takeOver(officeId: OfficeId, handle: OfficeHandle): void {
    const now = this.#deps.clock.now();
    let live: PausedRow | null = null;
    const adapter = this.#adapterOf(officeId);
    const held = adapter === undefined ? null : (this.#deps.holds?.adapterHeld(adapter) ?? null);
    const hold: AdapterHoldRecord | null =
      held === null ? null : { adapter: held.adapter, failures: held.failures, since: held.since };
    for (const other of this.#deps.loaded?.() ?? []) {
      if (other === officeId) continue;
      const otherHandle = this.#deps.offices.get(other);
      if (otherHandle === undefined) continue;
      const row = this.#row(otherHandle);
      if (row !== null && (row.until_at === null || row.until_at > now)) {
        const later =
          live === null ||
          row.until_at === null ||
          (live.until_at !== null && row.until_at > live.until_at);
        if (later) live = row;
      }
    }
    if (live !== null && this.#row(handle) === null) {
      this.#pause(officeId, handle, {
        detail: live.detail,
        since: live.since,
        until: live.until_at,
      });
    }
    if (hold !== null) {
      const notice = (target: OfficeHandle, code: string, text: string): void =>
        this.#append(target, [{ type: "engine.notice", delta: { level: "warn", code, text } }]);
      writeHoldRow(handle, hold, notice);
    }
  }

  #pause(officeId: OfficeId, handle: OfficeHandle, pause: PlanLimitPause): void {
    const until = handle.immediate(() => {
      const before = this.#row(handle);
      // A pause with no lift time stays so; else the later lift wins.
      const lift =
        before === null
          ? pause.until
          : before.until_at === null || pause.until === null
            ? null
            : Math.max(before.until_at, pause.until);
      handle.run(
        `insert into starts_paused (office_id, reason, detail, since, until_at)
         values ($office_id, 'plan-limit', $detail, $since, $until)
         on conflict (office_id, reason) do update set detail = excluded.detail,
           until_at = excluded.until_at`,
        { detail: pause.detail, since: pause.since, until: lift },
      );
      if (before === null) {
        const lifts = planLimitLifts(lift);
        this.#append(handle, [
          {
            type: "engine.notice",
            delta: {
              level: "warn",
              code: STARTS_PAUSED_NOTICES.paused,
              text: `The office's starts are paused: ${pause.detail}. No new session starts until it lifts. ${lifts}`,
            },
          },
        ]);
      }
      return lift;
    });
    this.#deps.onChanged?.(officeId);
    if (until === null) {
      this.#disarm(officeId);
      return;
    }
    this.#arm(officeId, until);
  }

  /** Deletes the office's plan-limit row with a notice; true when there was one. */
  #liftRow(officeId: OfficeId, why: string): boolean {
    this.#disarm(officeId);
    const handle = this.#deps.offices.get(officeId);
    if (handle === undefined) return false;
    const lifted = handle.immediate(() => {
      const before = this.#row(handle);
      if (before === null) return false;
      handle.run(
        "delete from starts_paused where office_id = $office_id and reason = 'plan-limit'",
      );
      this.#append(handle, [
        {
          type: "engine.notice",
          delta: {
            level: "info",
            code: STARTS_PAUSED_NOTICES.lifted,
            text: `The office's starts paused (${before.detail}) lifted: ${why}.`,
          },
        },
      ]);
      return true;
    });
    if (lifted) this.#deps.onChanged?.(officeId);
    return lifted;
  }

  #arm(officeId: OfficeId, at: number): void {
    if (this.#closed) return;
    this.#disarm(officeId);
    const delay = Math.max(0, at - this.#deps.clock.now());
    this.#timers.set(
      officeId,
      this.#deps.clock.setTimeout(() => {
        this.#timers.delete(officeId);
        this.#due(officeId);
      }, delay),
    );
  }

  #disarm(officeId: OfficeId): void {
    const timer = this.#timers.get(officeId);
    if (timer !== undefined) this.#deps.clock.clearTimeout(timer);
    this.#timers.delete(officeId);
  }

  /** A plan-limit pause's lift time came: it lifts, and the office's lifted parks resume. */
  #due(officeId: OfficeId): void {
    if (this.#deps.scheduling?.() === false) {
      this.#arm(officeId, this.#deps.clock.now() + STARTS_PAUSED_RETRY_MS);
      return;
    }
    try {
      this.#liftRow(officeId, "the plan limit's reset time passed");
    } catch (error) {
      this.#deps.warn?.("lifting an office's starts paused failed", {
        office: officeId,
        reason: messageOf(error),
      });
      this.#arm(officeId, this.#deps.clock.now() + STARTS_PAUSED_RETRY_MS);
      return;
    }
    this.#resumeLifted(officeId);
  }

  // ---- the parks a plan limit made -------------------------------------------------------------

  /**
   * While the office's starts are not paused, every open park a plan limit made resumes, oldest
   * first, through the one resume path; nothing else does. A resume that cannot run yet is tried
   * again a minute later; one refused leaves the park for the maintainer, with a notice.
   */
  #resumeLifted(officeId: OfficeId): void {
    const resume = this.#deps.resume;
    const handle = this.#deps.offices.get(officeId);
    if (this.#closed || resume === undefined || handle === undefined) return;
    // One pass per office at a time; a pass asked for meanwhile runs once it finished.
    const running = this.#passes.get(officeId);
    if (running !== undefined) {
      running.again = true;
      return;
    }
    if (this.state(officeId) !== null) return;
    this.#deps.onLifted?.(officeId);
    const parks = handle.all<ParkRow>(
      `select park_id, key, story_id from parks
        where office_id = $office_id and resolved_at is null and resume_on_lift = 1
          and run_id is not null
        order by at, park_id`,
    );
    if (parks.length === 0) return;
    // The daemon schedules no work now (it recovers, or is in `safe`): a minute later.
    if (this.#deps.scheduling?.() === false) {
      this.#retry(officeId);
      return;
    }
    const pass = { again: false };
    this.#passes.set(officeId, pass);
    background(
      async () => {
        let retry = false;
        for (const park of parks) {
          if (this.state(officeId) !== null) break;
          const lifted: LiftedPark = {
            parkId: park.park_id,
            key: StoryKey.parse(park.key),
            story: park.story_id,
          };
          const outcome = await resume(officeId, lifted).catch((error: unknown): LiftedResume => ({
            outcome: "refused",
            why: messageOf(error),
          }));
          if (outcome.outcome === "retry") retry = true;
          if (outcome.outcome === "refused") this.#notResumed(handle, lifted, outcome.why);
        }
        if (retry) this.#retry(officeId);
      },
      {
        failed: "resuming the parks of a lifted plan limit failed",
        fields: { office: officeId },
        log: this.#deps.warn,
        inflight: this.#inflight,
        settled: () => {
          this.#passes.delete(officeId);
          if (pass.again) this.#resumeLifted(officeId);
        },
      },
    );
  }

  /** A refused resume: the park no longer resumes by itself, and the maintainer is told. */
  #notResumed(handle: OfficeHandle, park: LiftedPark, why: string): void {
    handle.immediate(() => {
      keepParkedOnLift(handle, park.parkId);
      this.#append(handle, [
        {
          type: "engine.notice",
          key: park.key,
          delta: {
            level: "warn",
            code: STARTS_PAUSED_NOTICES.notResumed,
            text: `${park.story} stays parked after the plan limit lifted: ${why}. \`dipo resume ${park.story}\` resumes it.`,
          },
        },
      ]);
    });
    this.#deps.onChanged?.(handle.officeId as OfficeId);
  }

  #retry(officeId: OfficeId): void {
    if (this.#closed || this.#retries.has(officeId)) return;
    this.#retries.set(
      officeId,
      this.#deps.clock.setTimeout(() => {
        this.#retries.delete(officeId);
        this.#resumeLifted(officeId);
      }, STARTS_PAUSED_RETRY_MS),
    );
  }

  #append(handle: OfficeHandle, entries: readonly NewEntry[]): void {
    appendEntries(handle, entries, { at: this.#deps.clock.now() });
  }
}
