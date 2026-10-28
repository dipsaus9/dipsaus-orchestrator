// The adapter hold (0008, 0020; owned by DIPO-43, M0 review DIPO-15): the rules of a failed
// adapter check, which pauses the starts of every office on that adapter. Its one record is the
// offices' starts paused with reason `adapter` (the daemon's store, `run/starts-paused.ts`), so it
// survives a restart. A failed launch check (probe, box, self-test) or a `startFailed` outcome from
// the CLI holds the adapter and raises an `engine.notice`. It is not a park: the story stays where
// it was. An explicit `work.run` repeats the launch checks through `gateLaunch`, which lifts the
// hold when they pass, and `dipo daemon resume-scheduling` lifts it by hand. Adapter-neutral:
// nothing here names a CLI.
//
// A sticky check (DIPO-271: the post-run box-token check of DIPO-269) is the exception. Its hold
// is not about something a launch check can see again, so a passing launch check never lifts it:
// only `liftSticky`, or a cleared record in the sticky store, does. The store keeps it outside
// memory, so it also survives a daemon restart, and it is read again on every look, so a record
// cleared by another process (`dipo login box`) lifts the hold without a daemon call.

import type { Clock } from "@dipsaus-orchestrator/contract";

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

export interface AdapterHold {
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
   * How a sticky hold is lifted, as the refusal and the notice say it; absent for a hold a
   * passing launch check lifts.
   */
  readonly liftedBy?: string;
}

/** The `engine.notice` shape (0005 section 6). */
export interface HoldNotice {
  readonly level: "info" | "warn" | "error";
  readonly code: string;
  readonly text: string;
}

export const HOLD_NOTICE_CODE = "adapter.held";
export const RELEASE_NOTICE_CODE = "adapter.released";

function describeFailure(failure: LaunchCheckFailure): string {
  const where = [
    failure.key === undefined ? null : `key ${failure.key}`,
    failure.file === undefined ? null : `in ${failure.file}`,
  ].filter((part) => part !== null);
  const fix = failure.fix === undefined ? "" : ` ${failure.fix}`;
  return `${failure.check}: ${failure.detail}${where.length === 0 ? "" : ` (${where.join(" ")})`}.${fix}`;
}

/** What failed, one sentence per failure. */
export function holdFailures(hold: AdapterHold): string {
  return hold.failures.map(describeFailure).join(" ");
}

/** How the hold lifts, as one sentence. */
export function holdLift(hold: AdapterHold): string {
  return (
    hold.liftedBy ??
    "Fix it, then name the story to repeat the launch checks (`dipo run <ID>`); the hold lifts when they pass."
  );
}

/** The text a refusal or the notice shows for a hold. */
export function holdMessage(hold: AdapterHold): string {
  return `New runs on ${hold.adapter} are held in every office: ${holdFailures(hold)} ${holdLift(hold)}`;
}

/** A sticky hold as its store keeps it. */
export interface StickyHoldRecord {
  readonly adapter: string;
  /** Only the sticky failures. */
  readonly failures: readonly LaunchCheckFailure[];
  readonly since: number;
}

/** Where sticky holds live outside memory; the daemon's is a file in its state directory. */
export interface StickyHoldStore {
  /** The recorded hold, or null when none is recorded. Read again on every look. */
  read(): StickyHoldRecord | null;
  write(record: StickyHoldRecord): void;
  clear(): void;
}

export interface StickyHolds {
  /** The checks whose hold no passing launch check lifts. */
  readonly checks: ReadonlySet<string>;
  /** How such a hold is lifted, for the refusal and the notice. */
  readonly liftedBy: string;
  /** Keeps the hold over a restart and lets another process lift it; memory only without it. */
  readonly store?: StickyHoldStore;
}

/** A hold as its store keeps it: the adapter, every failure and when the hold began. */
export interface AdapterHoldRecord {
  readonly adapter: string;
  readonly failures: readonly LaunchCheckFailure[];
  readonly since: number;
}

/**
 * Where the holds live, read again on every look. The daemon's is the offices' starts paused
 * (`starts_paused` rows with reason `adapter`, `run/starts-paused.ts`), so a hold is one record
 * that survives a restart (0020); `memoryHoldStore` keeps them in memory for a test or a tool.
 */
export interface AdapterHoldStore {
  read(adapter: string): AdapterHoldRecord | null;
  write(record: AdapterHoldRecord): void;
  clear(adapter: string): void;
  /** The adapters with a hold. */
  adapters(): readonly string[];
}

/** A store in memory: holds last as long as the process. */
export function memoryHoldStore(): AdapterHoldStore {
  const holds = new Map<string, AdapterHoldRecord>();
  return {
    read: (adapter) => holds.get(adapter) ?? null,
    write: (record) => void holds.set(record.adapter, record),
    clear: (adapter) => void holds.delete(adapter),
    adapters: () => [...holds.keys()],
  };
}

export interface AdapterHoldsOptions {
  readonly clock: Clock;
  /** Raises an `engine.notice`; the daemon appends it to the software stream. */
  readonly notify: (notice: HoldNotice) => void;
  /** Where the holds live; in memory by default. */
  readonly store?: AdapterHoldStore;
  /** The sticky checks (DIPO-271); none by default. */
  readonly sticky?: StickyHolds;
  /** Logs what the holds could not do (a sticky record that could not be written). */
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

/**
 * The holds of one daemon, shared by every office, kept in their store. The sticky store of a
 * sticky check is the box token's own record, which `dipo login box` clears from another process;
 * every look brings the hold in line with it.
 */
export class AdapterHolds {
  readonly #store: AdapterHoldStore;
  readonly #clock: Clock;
  readonly #notify: (notice: HoldNotice) => void;
  readonly #sticky: StickyHolds | undefined;
  readonly #warn: AdapterHoldsOptions["warn"];
  /** Adapters whose sticky hold has no record: a missing record must not lift it then. */
  readonly #unrecorded = new Set<string>();

  constructor(options: AdapterHoldsOptions) {
    this.#store = options.store ?? memoryHoldStore();
    this.#clock = options.clock;
    this.#notify = options.notify;
    this.#sticky = options.sticky;
    this.#warn = options.warn;
  }

  #isSticky(failure: LaunchCheckFailure): boolean {
    return this.#sticky?.checks.has(failure.check) ?? false;
  }

  #make(adapter: string, failures: readonly LaunchCheckFailure[], since: number): AdapterHold {
    const [first] = failures;
    if (first === undefined) throw new Error("an adapter hold needs at least one failure");
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

  /** The stored hold of `adapter`, or null. */
  #get(adapter: string): AdapterHold | null {
    const record = this.#store.read(adapter);
    return record === null || record.failures.length === 0
      ? null
      : this.#make(adapter, record.failures, record.since);
  }

  /** Stores `hold`; a store that cannot write is logged, and the hold this call returns refuses. */
  #set(hold: AdapterHold): void {
    try {
      this.#store.write({ adapter: hold.adapter, failures: hold.failures, since: hold.since });
    } catch (error) {
      this.#warn?.("the adapter hold could not be stored", {
        adapter: hold.adapter,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #delete(adapter: string): void {
    this.#store.clear(adapter);
  }

  /**
   * Holds `adapter` with the failures and raises the notice. Replaces an earlier hold. A sticky
   * record that cannot be written is logged and tried again at the next look; a missing record
   * does not lift the hold then (`liftSticky` does).
   */
  hold(adapter: string, failures: readonly LaunchCheckFailure[]): AdapterHold {
    const sticky = failures.filter((failure) => this.#isSticky(failure));
    // A new hold without a sticky failure keeps the sticky ones of the hold it replaces, so a
    // later non-sticky hold can never replace a sticky hold and be lifted by a passing check.
    const carried =
      sticky.length > 0
        ? []
        : (this.#get(adapter)?.failures ?? []).filter((failure) => this.#isSticky(failure));
    const hold = this.#make(adapter, [...carried, ...failures], this.#clock.now());
    this.#set(hold);
    if (sticky.length > 0) this.#record(adapter, sticky, hold.since);
    this.#notify({ level: "error", code: HOLD_NOTICE_CODE, text: holdMessage(hold) });
    return hold;
  }

  /** Writes the sticky record; a failed write is logged and retried at the next look. */
  #record(adapter: string, failures: readonly LaunchCheckFailure[], since: number): void {
    try {
      this.#sticky?.store?.write({ adapter, failures, since });
      this.#unrecorded.delete(adapter);
    } catch (error) {
      this.#unrecorded.add(adapter);
      this.#warn?.("the sticky hold record could not be written; the hold stays", {
        adapter,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Lifts the hold on `adapter`; true when there was one and it is gone. `why` starts the release
   * notice: a passing launch check by default. A sticky failure stays: the hold is kept with only
   * the sticky failures, and the call returns false.
   */
  lift(adapter: string, why = `The launch checks for ${adapter} passed`): boolean {
    this.#sync();
    const hold = this.#get(adapter);
    if (hold === null) return false;
    const sticky = hold.failures.filter((failure) => this.#isSticky(failure));
    if (sticky.length > 0) {
      if (sticky.length < hold.failures.length) this.#set(this.#make(adapter, sticky, hold.since));
      return false;
    }
    this.#delete(adapter);
    this.#released(adapter, why);
    return true;
  }

  /**
   * Lifts the sticky failures of `adapter`'s hold and clears its record (DIPO-271: the box login
   * was replaced). True when a hold was lifted or narrowed.
   */
  liftSticky(adapter: string): boolean {
    const record = this.#sticky?.store?.read() ?? null;
    if (record !== null && record.adapter === adapter) this.#sticky?.store?.clear();
    this.#unrecorded.delete(adapter);
    return this.#dropSticky(adapter, "The sticky hold was lifted");
  }

  /** The predicate DIPO-48 and DIPO-74 consume: the hold on `adapter`, or null. */
  adapterHeld(adapter: string): AdapterHold | null {
    this.#sync();
    return this.#get(adapter);
  }

  #released(adapter: string, why: string): void {
    this.#notify({
      level: "info",
      code: RELEASE_NOTICE_CODE,
      text: `${why}; new runs on ${adapter} are no longer held.`,
    });
  }

  /** Drops the sticky failures of `adapter`'s hold; true when it changed. */
  #dropSticky(adapter: string, why: string): boolean {
    const hold = this.#get(adapter);
    if (hold === null) return false;
    const rest = hold.failures.filter((failure) => !this.#isSticky(failure));
    if (rest.length === hold.failures.length) return false;
    if (rest.length === 0) {
      this.#delete(adapter);
      this.#released(adapter, why);
    } else {
      this.#set(this.#make(adapter, rest, hold.since));
    }
    return true;
  }

  /**
   * Brings the stored holds in line with the sticky store: a recorded hold the store lacks is held
   * again, and a sticky failure whose record is gone (cleared by `dipo login box`) is lifted.
   */
  #sync(): void {
    const store = this.#sticky?.store;
    if (store === undefined) return;
    // A record that could not be written is tried again first.
    for (const adapter of this.#unrecorded) {
      const held = this.#get(adapter);
      const sticky = held?.failures.filter((failure) => this.#isSticky(failure)) ?? [];
      if (held === null || sticky.length === 0) this.#unrecorded.delete(adapter);
      else this.#record(adapter, sticky, held.since);
    }
    const record = store.read();
    for (const adapter of this.#store.adapters()) {
      if (record?.adapter !== adapter && !this.#unrecorded.has(adapter)) {
        this.#dropSticky(adapter, "The box login was replaced");
      }
    }
    if (record === null || record.failures.length === 0) return;
    const held = this.#get(record.adapter);
    if (held?.failures.some((failure) => this.#isSticky(failure)) === true) return;
    const hold = this.#make(
      record.adapter,
      [...record.failures, ...(held?.failures ?? [])],
      record.since,
    );
    this.#set(hold);
    this.#notify({ level: "error", code: HOLD_NOTICE_CODE, text: holdMessage(hold) });
  }
}

export type LaunchGate =
  | { readonly ok: true }
  | { readonly ok: false; readonly outcome: "startFailed"; readonly hold: AdapterHold };

/**
 * Runs an adapter's launch checks before a launch or resume. A failure, or checks that throw,
 * hold the adapter and return `startFailed`; a pass lifts any hold but a sticky one, which still
 * returns `startFailed`.
 */
export async function gateLaunch(
  adapter: string,
  holds: AdapterHolds,
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
    holds.lift(adapter);
    const still = holds.adapterHeld(adapter);
    return still === null ? { ok: true } : { ok: false, outcome: "startFailed", hold: still };
  }
  const failures =
    outcome.failures.length > 0
      ? outcome.failures
      : [{ check: "launch-checks", detail: "the launch checks failed without a reason" }];
  return { ok: false, outcome: "startFailed", hold: holds.hold(adapter, failures) };
}
