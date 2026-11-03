// The office's starts paused (0020, 0008): the one state for problems that belong to the office and
// not to a story. While it holds, no new session starts in the office: no pickup (`work.run`), no
// session waiting for its place (`run-state/places.ts`), no resume (`park-resume.ts`) and no scan
// fallback session. The desk shows it first, with what lifts it (`overview/desk.ts`).
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
// - `adapter`: a failed adapter check (a launch check, a start failure, the box token check) pauses
//   the starts of every office on that adapter (`AdapterPauses`) and raises an `engine.notice`
//   (`starts.paused`, then `starts.resumed` when it lifts). Its record is a `starts_paused` row with
//   reason `adapter`, the adapter and its failures, in every registered office, loaded or not
//   (`officePauseStore`), so it survives a restart and an office loaded later finds it. It lifts
//   when the check passes again (`dipo run <ID>` repeats the launch checks through
//   `AdapterPauses.gateLaunch`). The story stays where it was, so no park resumes for it.
//   Adapter-neutral: nothing here names a CLI.
//
//   A sticky check (the post-run box-token check) is the exception. Its pause is not about
//   something a launch check can see again, so a passing launch check never lifts it: only
//   `liftSticky`, or a cleared record in the sticky store, does. The store keeps it outside memory,
//   so it survives a daemon restart, and it is read again on every look, so a record cleared by
//   another process (`dipo login box`, which replaces the box token) lifts the pause without a
//   daemon call.
//
// `dipo daemon resume-starts` lifts both, in every office, but never the box token's pause. An
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

import type { PlanLimitHit } from "./outcome-types";
import { keepParkedOnLift } from "../run-state/park-records";

/** One failed launch check, with the file or key it is about when there is one. */
export interface LaunchCheckFailure {
  /** For example `probe`, `settings`, `self-test`, `start-failed`. */
  readonly check: string;
  readonly detail: string;
  readonly file?: string;
  readonly key?: string;
  /** What the maintainer can do about it, when the check knows. */
  readonly fix?: string;
}

export type LaunchCheckOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly failures: readonly LaunchCheckFailure[] };

export interface AdapterPause {
  readonly adapter: string;
  /** The first failure; `failures` lists all of them. */
  readonly check: string;
  readonly detail: string;
  readonly file?: string;
  readonly key?: string;
  readonly failures: readonly LaunchCheckFailure[];
  /** Milliseconds since the epoch, from the injected clock. */
  readonly since: number;
  /**
   * How a sticky pause is lifted, as the refusal and the notice say it; absent for a pause a
   * passing launch check lifts.
   */
  readonly liftedBy?: string;
}

/** The `engine.notice` shape (0005). */
export interface PauseNotice {
  readonly level: "info" | "warn" | "error";
  readonly code: string;
  readonly text: string;
}

/** `engine.notice` codes of an adapter's pause, on the software stream. */
export const ADAPTER_PAUSED_NOTICE = "starts.paused";
export const ADAPTER_RESUMED_NOTICE = "starts.resumed";

function describeFailure(failure: LaunchCheckFailure): string {
  const where = [
    failure.key === undefined ? null : `key ${failure.key}`,
    failure.file === undefined ? null : `in ${failure.file}`,
  ].filter((part) => part !== null);
  const fix = failure.fix === undefined ? "" : ` ${failure.fix}`;
  return `${failure.check}: ${failure.detail}${where.length === 0 ? "" : ` (${where.join(" ")})`}.${fix}`;
}

/** What failed, one sentence per failure. */
export function pauseFailures(pause: AdapterPause): string {
  return pause.failures.map(describeFailure).join(" ");
}

/** How the pause lifts, as one sentence. */
export function pauseLift(pause: AdapterPause): string {
  return (
    pause.liftedBy ??
    "Fix it, then name the story to repeat the launch checks (`dipo run <ID>`); the pause lifts when they pass."
  );
}

/** The text a refusal or the notice shows for a pause. */
export function pauseMessage(pause: AdapterPause): string {
  return `New runs on ${pause.adapter} are paused in every office: ${pauseFailures(pause)} ${pauseLift(pause)}`;
}

/** A sticky pause as its store keeps it. */
export interface StickyPauseRecord {
  readonly adapter: string;
  /** Only the sticky failures. */
  readonly failures: readonly LaunchCheckFailure[];
  readonly since: number;
}

/** Where sticky pauses live outside memory; the daemon's is a file in its state directory. */
export interface StickyPauseStore {
  /** The recorded pause, or null when none is recorded. Read again on every look. */
  read(): StickyPauseRecord | null;
  write(record: StickyPauseRecord): void;
  clear(): void;
}

export interface StickyPauses {
  /** The checks whose pause no passing launch check lifts. */
  readonly checks: ReadonlySet<string>;
  /** How such a pause is lifted, for the refusal and the notice. */
  readonly liftedBy: string;
  /** Keeps the pause over a restart and lets another process lift it; memory only without it. */
  readonly store?: StickyPauseStore;
}

/** A pause as its store keeps it: the adapter, every failure and when the pause began. */
export interface AdapterPauseRecord {
  readonly adapter: string;
  readonly failures: readonly LaunchCheckFailure[];
  readonly since: number;
}

/**
 * Where the pauses live, read again on every look. The daemon's is the offices' starts paused
 * (`starts_paused` rows with reason `adapter` in every registered office, `officePauseStore`), so
 * a pause is one record per adapter that survives a restart (0020); `memoryPauseStore` keeps them
 * in memory for a test or a tool.
 */
export interface AdapterPauseStore {
  read(adapter: string): AdapterPauseRecord | null;
  write(record: AdapterPauseRecord): void;
  clear(adapter: string): void;
  /** The adapters with a pause. */
  adapters(): readonly string[];
}

/** A store in memory: pauses last as long as the process. */
export function memoryPauseStore(): AdapterPauseStore {
  const pauses = new Map<string, AdapterPauseRecord>();
  return {
    read: (adapter) => pauses.get(adapter) ?? null,
    write: (record) => void pauses.set(record.adapter, record),
    clear: (adapter) => void pauses.delete(adapter),
    adapters: () => [...pauses.keys()],
  };
}

export interface AdapterPausesOptions {
  readonly clock: Clock;
  /** Raises an `engine.notice`; the daemon appends it to the software stream. */
  readonly notify: (notice: PauseNotice) => void;
  /** Where the pauses live; in memory by default. */
  readonly store?: AdapterPauseStore;
  /** The sticky checks; none by default. */
  readonly sticky?: StickyPauses;
  /** Logs what the pauses could not do (a sticky record that could not be written). */
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

/** What `AdapterPauses.gateLaunch` returns: go ahead, or the pause that refuses the launch. */
export type LaunchGate =
  | { readonly ok: true }
  | { readonly ok: false; readonly outcome: "startFailed"; readonly pause: AdapterPause };

/**
 * The adapter pauses of one daemon, shared by every office, kept in their store. The sticky store
 * of a sticky check is the box token's own record, which `dipo login box` clears from another
 * process; every look brings the pause in line with it.
 */
export class AdapterPauses {
  readonly #store: AdapterPauseStore;
  readonly #clock: Clock;
  readonly #notify: (notice: PauseNotice) => void;
  readonly #sticky: StickyPauses | undefined;
  readonly #warn: AdapterPausesOptions["warn"];
  /** Adapters whose sticky pause has no record: a missing record must not lift it then. */
  readonly #unrecorded = new Set<string>();

  constructor(options: AdapterPausesOptions) {
    this.#store = options.store ?? memoryPauseStore();
    this.#clock = options.clock;
    this.#notify = options.notify;
    this.#sticky = options.sticky;
    this.#warn = options.warn;
  }

  #isSticky(failure: LaunchCheckFailure): boolean {
    return this.#sticky?.checks.has(failure.check) ?? false;
  }

  #make(adapter: string, failures: readonly LaunchCheckFailure[], since: number): AdapterPause {
    const [first] = failures;
    if (first === undefined) throw new Error("an adapter pause needs at least one failure");
    const sticky = this.#sticky !== undefined && failures.some((f) => this.#isSticky(f));
    return {
      adapter,
      check: first.check,
      detail: first.detail,
      ...(first.file === undefined ? {} : { file: first.file }),
      ...(first.key === undefined ? {} : { key: first.key }),
      failures: [...failures],
      since,
      ...(sticky ? { liftedBy: this.#sticky?.liftedBy } : {}),
    };
  }

  /** The stored pause of `adapter`, or null. */
  #get(adapter: string): AdapterPause | null {
    const record = this.#store.read(adapter);
    return record === null || record.failures.length === 0
      ? null
      : this.#make(adapter, record.failures, record.since);
  }

  /** Stores `pause`; a store that cannot write is logged, and the pause this call returns refuses. */
  #set(pause: AdapterPause): void {
    try {
      this.#store.write({ adapter: pause.adapter, failures: pause.failures, since: pause.since });
    } catch (error) {
      this.#warn?.("the adapter pause could not be stored", {
        adapter: pause.adapter,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #delete(adapter: string): void {
    this.#store.clear(adapter);
  }

  /**
   * Pauses `adapter` with the failures and raises the notice. Replaces an earlier pause. A sticky
   * record that cannot be written is logged and tried again at the next look; a missing record
   * does not lift the pause then (`liftSticky` does).
   */
  pause(adapter: string, failures: readonly LaunchCheckFailure[]): AdapterPause {
    const sticky = failures.filter((failure) => this.#isSticky(failure));
    // A new pause without a sticky failure keeps the sticky ones of the pause it replaces, so a
    // later non-sticky pause can never replace a sticky pause and be lifted by a passing check.
    const carried =
      sticky.length > 0
        ? []
        : (this.#get(adapter)?.failures ?? []).filter((failure) => this.#isSticky(failure));
    const pause = this.#make(adapter, [...carried, ...failures], this.#clock.now());
    this.#set(pause);
    if (sticky.length > 0) this.#record(adapter, sticky, pause.since);
    this.#notify({ level: "error", code: ADAPTER_PAUSED_NOTICE, text: pauseMessage(pause) });
    return pause;
  }

  /** Writes the sticky record; a failed write is logged and retried at the next look. */
  #record(adapter: string, failures: readonly LaunchCheckFailure[], since: number): void {
    try {
      this.#sticky?.store?.write({ adapter, failures, since });
      this.#unrecorded.delete(adapter);
    } catch (error) {
      this.#unrecorded.add(adapter);
      this.#warn?.("the sticky pause record could not be written; the pause stays", {
        adapter,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Lifts the pause on `adapter`; true when there was one and it is gone. `why` starts the
   * `starts.resumed` notice: a passing launch check by default. A sticky failure stays: the pause
   * is kept with only the sticky failures, and the call returns false.
   */
  lift(adapter: string, why = `The launch checks for ${adapter} passed`): boolean {
    this.#sync();
    const pause = this.#get(adapter);
    if (pause === null) return false;
    const sticky = pause.failures.filter((failure) => this.#isSticky(failure));
    if (sticky.length > 0) {
      if (sticky.length < pause.failures.length) {
        this.#set(this.#make(adapter, sticky, pause.since));
      }
      return false;
    }
    this.#delete(adapter);
    this.#resumed(adapter, why);
    return true;
  }

  /**
   * Lifts the sticky failures of `adapter`'s pause and clears its record (the box login was
   * replaced). True when a pause was lifted or narrowed.
   */
  liftSticky(adapter: string): boolean {
    const record = this.#sticky?.store?.read() ?? null;
    if (record !== null && record.adapter === adapter) this.#sticky?.store?.clear();
    this.#unrecorded.delete(adapter);
    return this.#dropSticky(adapter, "The sticky pause was lifted");
  }

  /** The pause on `adapter`, or null. */
  adapterPaused(adapter: string): AdapterPause | null {
    this.#sync();
    return this.#get(adapter);
  }

  /** The text a refusal or the notice shows for `pause` (`pauseMessage`). */
  message(pause: AdapterPause): string {
    return pauseMessage(pause);
  }

  /**
   * Runs an adapter's launch checks before a launch or resume. A failure, or checks that throw,
   * pause the adapter and return `startFailed`; a pass lifts any pause but a sticky one, which
   * still returns `startFailed`.
   */
  async gateLaunch(
    adapter: string,
    checks: () => Promise<LaunchCheckOutcome>,
  ): Promise<LaunchGate> {
    let outcome: LaunchCheckOutcome;
    try {
      outcome = await checks();
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      outcome = {
        ok: false,
        failures: [{ check: "launch-checks", detail: `the launch checks could not run: ${why}` }],
      };
    }
    if (outcome.ok) {
      this.lift(adapter);
      const still = this.adapterPaused(adapter);
      return still === null ? { ok: true } : { ok: false, outcome: "startFailed", pause: still };
    }
    const failures =
      outcome.failures.length > 0
        ? outcome.failures
        : [{ check: "launch-checks", detail: "the launch checks failed without a reason" }];
    return { ok: false, outcome: "startFailed", pause: this.pause(adapter, failures) };
  }

  #resumed(adapter: string, why: string): void {
    this.#notify({
      level: "info",
      code: ADAPTER_RESUMED_NOTICE,
      text: `${why}; new runs on ${adapter} are no longer paused.`,
    });
  }

  /** Drops the sticky failures of `adapter`'s pause; true when it changed. */
  #dropSticky(adapter: string, why: string): boolean {
    const pause = this.#get(adapter);
    if (pause === null) return false;
    const rest = pause.failures.filter((failure) => !this.#isSticky(failure));
    if (rest.length === pause.failures.length) return false;
    if (rest.length === 0) {
      this.#delete(adapter);
      this.#resumed(adapter, why);
    } else {
      this.#set(this.#make(adapter, rest, pause.since));
    }
    return true;
  }

  /**
   * Brings the stored pauses in line with the sticky store: a recorded pause the store lacks is
   * paused again, and a sticky failure whose record is gone (cleared by `dipo login box`) is
   * lifted.
   */
  #sync(): void {
    const store = this.#sticky?.store;
    if (store === undefined) return;
    // A record that could not be written is tried again first.
    for (const adapter of this.#unrecorded) {
      const paused = this.#get(adapter);
      const sticky = paused?.failures.filter((failure) => this.#isSticky(failure)) ?? [];
      if (paused === null || sticky.length === 0) this.#unrecorded.delete(adapter);
      else this.#record(adapter, sticky, paused.since);
    }
    const record = store.read();
    for (const adapter of this.#store.adapters()) {
      if (record?.adapter !== adapter && !this.#unrecorded.has(adapter)) {
        this.#dropSticky(adapter, "The box login was replaced");
      }
    }
    if (record === null || record.failures.length === 0) return;
    const paused = this.#get(record.adapter);
    if (paused?.failures.some((failure) => this.#isSticky(failure)) === true) return;
    const pause = this.#make(
      record.adapter,
      [...record.failures, ...(paused?.failures ?? [])],
      record.since,
    );
    this.#set(pause);
    this.#notify({ level: "error", code: ADAPTER_PAUSED_NOTICE, text: pauseMessage(pause) });
  }
}

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
  lifted: "office.startsResumed",
  notResumed: "office.parkNotResumed",
} as const;

/** The command line that lifts the office's starts paused by hand. */
export const LIFT_COMMAND = "dipo daemon resume-starts";

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
  /** The adapter's pause behind an `adapter` reason. */
  readonly pause?: AdapterPause;
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
  /** The adapter pauses of a failed adapter check (`AdapterPauses`); no `adapter` pause without them. */
  readonly holds?: {
    adapterPaused(adapter: string): AdapterPause | null;
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

/** The offices the adapter pause store reaches: the registered ones, and the loaded ones' handles. */
export interface PauseStoreOffices {
  /** A loaded office's handle, for its notices. */
  get(office: OfficeId): OfficeHandle | undefined;
  loaded(): readonly OfficeId[];
  /**
   * The state database's one connection, for the rows of every registered office (an adapter pause
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

/** The first line of a pause's failures, as the row's detail. */
function failureLine(failures: readonly LaunchCheckFailure[]): string {
  const [first] = failures;
  return first === undefined ? "" : `${first.check}: ${first.detail}`;
}

/** The registered offices, in SQL. */
const REGISTERED = "select office_id from offices where forgotten_at is null";

/**
 * The adapter pauses' record (0020): a `starts_paused` row with reason `adapter` in every registered
 * office, loaded or not, since one adapter runs every office (0001). A pause is read from any of
 * them, written to all of them, with an `office.startsPaused` notice in each loaded office where it
 * is new, and cleared from all of them, with `office.startsResumed` in each loaded office that had
 * it. So a pause set while no office is loaded is kept, and a lift reaches an office that was not
 * loaded. A pause written before the database opened, or while no office is registered, is kept in
 * memory and written to the rows at the next look once an office is registered.
 */
export function officePauseStore(clock: Clock, offices: PauseStoreOffices): AdapterPauseStore {
  /** Pauses not in the rows yet: written before the database opened or any office registered. */
  const pending = new Map<string, AdapterPauseRecord>();
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
  /** The connection when at least one office is registered, else null. */
  const rows = () => {
    const connection = offices.connection();
    if (connection === null) return null;
    const registered = connection.get<{ n: number }>(
      `select count(*) as n from offices where forgotten_at is null`,
    );
    return (registered?.n ?? 0) > 0 ? connection : null;
  };
  const writeRows = (connection: PauseConnection, record: AdapterPauseRecord): void =>
    writePauseRows(connection, loadedHandles(), record, notice);
  /** Writes the kept pauses to the rows once an office is registered. */
  const flush = (): void => {
    if (pending.size === 0) return;
    const connection = rows();
    if (connection === null) return;
    for (const record of pending.values()) writeRows(connection, record);
    pending.clear();
  };
  return {
    read: (adapter) => {
      flush();
      const kept = pending.get(adapter);
      if (kept !== undefined) return kept;
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
      const connection = rows();
      if (connection === null) {
        pending.set(record.adapter, record);
        return;
      }
      pending.delete(record.adapter);
      writeRows(connection, record);
    },
    clear: (adapter) => {
      pending.delete(adapter);
      const connection = offices.connection();
      if (connection !== null) clearPauseRows(connection, loadedHandles(), adapter, notice);
    },
    adapters: () => {
      flush();
      const stored = (
        offices.connection()?.all<{ adapter: string }>(
          `select distinct adapter from starts_paused
            where reason = 'adapter' and adapter is not null and office_id in (${REGISTERED})`,
        ) ?? []
      ).map((row) => row.adapter);
      return [...new Set([...pending.keys(), ...stored])];
    },
  };
}

type PauseConnection = NonNullable<ReturnType<PauseStoreOffices["connection"]>>;
type PauseNoticeWriter = (handle: OfficeHandle, code: string, text: string) => void;

/**
 * Writes `record` as the adapter pause of every registered office: the loaded offices first, each
 * with its notice, then every other one.
 */
function writePauseRows(
  connection: PauseConnection,
  loaded: readonly OfficeHandle[],
  record: AdapterPauseRecord,
  notice: PauseNoticeWriter,
): void {
  for (const handle of loaded) writePauseRow(handle, record, notice);
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
}

/** Clears `adapter`'s pause from every office, with a notice in each loaded office that had it. */
function clearPauseRows(
  connection: PauseConnection,
  loaded: readonly OfficeHandle[],
  adapter: string,
  notice: PauseNoticeWriter,
): void {
  for (const handle of loaded) {
    handle.immediate(() => {
      const row = rowOf(handle);
      if (row === null || row.adapter !== adapter) return;
      handle.run("delete from starts_paused where office_id = $office_id and reason = 'adapter'");
      notice(
        handle,
        STARTS_PAUSED_NOTICES.lifted,
        `The office's starts paused (adapter check failed: ${failureLine(JSON.parse(row.failures) as LaunchCheckFailure[])}) lifted.`,
      );
    });
  }
  connection.immediate(() =>
    connection.run("delete from starts_paused where reason = 'adapter' and adapter = $adapter", {
      adapter,
    }),
  );
}

/** Writes `record` as the office's adapter pause, with a notice when it is new there. */
function writePauseRow(
  handle: OfficeHandle,
  record: AdapterPauseRecord,
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
   * The office's starts paused, or null: its plan-limit row first, else the pause of its adapter. A
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
    const pause = adapter === undefined ? null : (this.#deps.holds?.adapterPaused(adapter) ?? null);
    if (pause === null) return null;
    return {
      reason: "adapter",
      detail: `${pause.adapter}: ${pauseFailures(pause)}`,
      since: pause.since,
      until: null,
      // The box token's pause lifts only with `dipo login box`, never by the command (0020).
      lifts:
        pause.liftedBy === undefined
          ? `${pauseLift(pause)} \`${LIFT_COMMAND}\` lifts it by hand.`
          : pauseLift(pause),
      pause,
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
   * Lifts the office's starts paused by hand (`daemon.resumeStarts`): its plan-limit pause and
   * a pause of its adapter a passing check would lift. True when something lifted.
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
   * park that resumes when the pause lifts (`control-endings.ts`).
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
   * An adapter pause was lifted (a passing check, `dipo login box`): each loaded office that is no
   * longer paused resumes the parks a plan limit left (a limit that lifted while the adapter was paused).
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
      name: "run",
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
   * adapter): the live plan-limit pause that lifts last, and its adapter's pause, kept for every
   * registered office.
   */
  #takeOver(officeId: OfficeId, handle: OfficeHandle): void {
    const now = this.#deps.clock.now();
    let live: PausedRow | null = null;
    const adapter = this.#adapterOf(officeId);
    const paused =
      adapter === undefined ? null : (this.#deps.holds?.adapterPaused(adapter) ?? null);
    const pause: AdapterPauseRecord | null =
      paused === null
        ? null
        : { adapter: paused.adapter, failures: paused.failures, since: paused.since };
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
    if (pause !== null) {
      const notice = (target: OfficeHandle, code: string, text: string): void =>
        this.#append(target, [{ type: "engine.notice", delta: { level: "warn", code, text } }]);
      writePauseRow(handle, pause, notice);
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
    // The daemon schedules no work now (it recovers, or drains): a minute later.
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
