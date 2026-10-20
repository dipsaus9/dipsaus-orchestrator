// The adapter hold (0008 sections 2 and 7; owned by DIPO-43, M0 review DIPO-15). A failed launch
// check (probe, project settings, sandbox self-test) or a `startFailed` outcome from the CLI holds
// every new run on that adapter, in every office, and raises an `engine.notice`. It is a hold, not
// a park: the story stays Ready. An explicit `work.run` repeats the launch checks through
// `gateLaunch`, which lifts the hold when they pass. Adapter-neutral: nothing here names a CLI.
//
// Two scopes (DIPO-257). A check that proved the sandbox unsafe, and every failure that is not a
// self-test that could not run, holds the adapter in every office. A self-test that could not run
// (`couldNotRun`: a missing tool, a timeout, a session that ended early, a refused approval call)
// holds only that launch kind, worker or reviewer, in that office; it is checked again with
// backoff (`HoldRechecks`) and lifts when the checks pass.

import type { Clock, TimerHandle } from "@dipsaus-orchestrator/contract";

/** One failed launch check, with the file or key it is about when there is one. */
export interface LaunchCheckFailure {
  /** For example `probe`, `settings`, `self-test`, `start-failed`. */
  readonly check: string;
  readonly detail: string;
  readonly file?: string;
  readonly key?: string;
  /** What the maintainer can do about it, when the check knows. */
  readonly fix?: string;
  /** True for a self-test that could not run; the sandbox was not shown unsafe (DIPO-257). */
  readonly couldNotRun?: true;
}

/** The launch kind a hold is scoped to: a developer session or a reviewer session. */
export type LaunchKind = "worker" | "reviewer";

/** An office's launch kind; `office` is the office's main checkout, which a launch knows. */
export interface HoldScope {
  readonly office: string;
  readonly kind: LaunchKind;
}

/** Recheck waits of a scoped hold after its 1st to 4th failed check (design choice, DIPO-257). */
export const LAUNCH_RETRY_MS: readonly number[] = [60_000, 120_000, 240_000, 480_000];
/** The wait after the fourth. */
export const LAUNCH_RETRY_LONG_MS = 30 * 60_000;

/** How long to wait after `failures` failed checks (1 for the first): 1, 2, 4, 8, then 30 minutes. */
export function launchRetryMs(failures: number): number {
  return LAUNCH_RETRY_MS[Math.max(0, failures - 1)] ?? LAUNCH_RETRY_LONG_MS;
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
  /** Set for a could-not-run hold: the one launch kind and office it holds. */
  readonly scope?: HoldScope;
  /** True when dipo repeats the checks of a scoped hold by itself (a reviewer kind, DIPO-257). */
  readonly rechecks?: boolean;
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

/** The text a refusal or the notice shows for a hold. */
export function holdMessage(hold: AdapterHold): string {
  const lines = hold.failures.map(describeFailure).join(" ");
  if (hold.scope !== undefined && hold.rechecks !== true) {
    return (
      `New ${hold.scope.kind} sessions on ${hold.adapter} are held in this office; other offices and the other session kind still launch: ${lines} ` +
      "Fix it, then name the story to repeat the launch checks (`dipo run <ID>`); the hold lifts when they pass."
    );
  }
  if (hold.scope !== undefined) {
    return (
      `New ${hold.scope.kind} sessions on ${hold.adapter} are held in this office; other offices and the other session kind still launch: ${lines} ` +
      "Fix it; dipo repeats the launch checks by itself after 1, 2, 4 and 8 minutes and then every 30 minutes, and the hold lifts when they pass."
    );
  }
  return (
    `New runs on ${hold.adapter} are held in every office: ${lines} ` +
    "Fix it, then name the story to repeat the launch checks (`dipo run <ID>`); the hold lifts when they pass."
  );
}

export interface AdapterHoldsOptions {
  readonly clock: Clock;
  /** Raises an `engine.notice`; the daemon appends it to the software stream. */
  readonly notify: (notice: HoldNotice) => void;
}

interface ScopedEntry {
  hold: AdapterHold;
  /** Null: no timed recheck (a worker kind whose pickup was rolled back); the next run checks. */
  recheck: (() => Promise<LaunchCheckOutcome>) | null;
  /** Failed checks so far; the next recheck waits `launchRetryMs(attempts)`. */
  attempts: number;
}

const scopeKey = (adapter: string, scope: HoldScope): string =>
  `${adapter}\u0000${scope.office}\u0000${scope.kind}`;

/** What `HoldRechecks` needs of the holds. */
export interface ScopedHoldSource {
  /** Calls `listener` when a scoped hold is set; returns the function that stops it. */
  onScopedHold(listener: (adapter: string, scope: HoldScope) => void): () => void;
  /** Failed checks of the scoped hold so far, or null when none is held. */
  scopedAttempts(adapter: string, scope: HoldScope): number | null;
  /** Repeats the held kind's launch checks through `gateLaunch`; true when the hold is lifted. */
  recheck(adapter: string, scope: HoldScope): Promise<boolean>;
}

/**
 * The holds of one daemon, shared by every office. In memory: after a restart the launch checks
 * run again before the next launch (they run before every launch and resume), so a lost hold
 * cannot let an unsafe run start.
 */
export class AdapterHolds implements ScopedHoldSource {
  readonly #holds = new Map<string, AdapterHold>();
  readonly #scoped = new Map<string, ScopedEntry>();
  readonly #listeners = new Set<(adapter: string, scope: HoldScope) => void>();
  readonly #clock: Clock;
  readonly #notify: (notice: HoldNotice) => void;

  constructor(options: AdapterHoldsOptions) {
    this.#clock = options.clock;
    this.#notify = options.notify;
  }

  #build(
    adapter: string,
    failures: readonly LaunchCheckFailure[],
    scope?: HoldScope,
    rechecks?: boolean,
  ): AdapterHold {
    const [first] = failures;
    if (first === undefined) throw new Error("an adapter hold needs at least one failure");
    return {
      adapter,
      check: first.check,
      detail: first.detail,
      ...(first.file === undefined ? {} : { file: first.file }),
      ...(first.key === undefined ? {} : { key: first.key }),
      failures: [...failures],
      since: this.#clock.now(),
      ...(scope === undefined ? {} : { scope }),
      ...(rechecks === true ? { rechecks } : {}),
    };
  }

  /** Holds `adapter` with the failures and raises the notice. Replaces an earlier hold. */
  hold(adapter: string, failures: readonly LaunchCheckFailure[]): AdapterHold {
    const hold = this.#build(adapter, failures);
    this.#holds.set(adapter, hold);
    this.#notify({ level: "error", code: HOLD_NOTICE_CODE, text: holdMessage(hold) });
    return hold;
  }

  /**
   * Holds one launch kind in one office (a self-test that could not run). `recheck` runs that
   * kind's launch checks again with that office's launch context; null schedules none, and the
   * next launch of that kind checks again. A hold that is set again keeps its failed checks count,
   * and raises its notice only when the text changed.
   */
  holdScoped(
    adapter: string,
    scope: HoldScope,
    failures: readonly LaunchCheckFailure[],
    recheck: (() => Promise<LaunchCheckOutcome>) | null,
  ): AdapterHold {
    const hold = this.#build(adapter, failures, scope, recheck !== null);
    const key = scopeKey(adapter, scope);
    const earlier = this.#scoped.get(key);
    this.#scoped.set(key, { hold, recheck, attempts: earlier?.attempts ?? 1 });
    if (earlier === undefined || holdMessage(earlier.hold) !== holdMessage(hold)) {
      this.#notify({ level: "error", code: HOLD_NOTICE_CODE, text: holdMessage(hold) });
    }
    for (const listener of this.#listeners) listener(adapter, scope);
    return hold;
  }

  /** Lifts the hold on `adapter` (and `scope`'s, when given); true when there was one. */
  lift(adapter: string, scope?: HoldScope): boolean {
    const global = this.#holds.delete(adapter);
    const scoped = scope !== undefined && this.#scoped.delete(scopeKey(adapter, scope));
    if (!global && !scoped) return false;
    this.#notify({
      level: "info",
      code: RELEASE_NOTICE_CODE,
      text: `The launch checks for ${adapter} passed; new runs on ${adapter} are no longer held.`,
    });
    return true;
  }

  /** Lifts only the scoped hold of `scope`; true when there was one. */
  liftScoped(adapter: string, scope: HoldScope): boolean {
    if (!this.#scoped.delete(scopeKey(adapter, scope))) return false;
    this.#notify({
      level: "info",
      code: RELEASE_NOTICE_CODE,
      text: `The launch checks for ${scope.kind} sessions on ${adapter} passed; they are no longer held.`,
    });
    return true;
  }

  /**
   * The predicate DIPO-48 and DIPO-74 consume: the hold on `adapter`, or null. A hold of every
   * office wins; with `scope` the hold of that office's launch kind counts too, and without one
   * any scoped hold does.
   */
  adapterHeld(adapter: string, scope?: HoldScope): AdapterHold | null {
    const global = this.#holds.get(adapter);
    if (global !== undefined) return global;
    if (scope !== undefined) return this.#scoped.get(scopeKey(adapter, scope))?.hold ?? null;
    // Without a scope any hold on the adapter counts (information; the launch paths pass one).
    for (const entry of this.#scoped.values()) {
      if (entry.hold.adapter === adapter) return entry.hold;
    }
    return null;
  }

  onScopedHold(listener: (adapter: string, scope: HoldScope) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  scopedAttempts(adapter: string, scope: HoldScope): number | null {
    const entry = this.#scoped.get(scopeKey(adapter, scope));
    // A hold with no timed recheck is never armed (DIPO-257).
    return entry === undefined || entry.recheck === null ? null : entry.attempts;
  }

  async recheck(adapter: string, scope: HoldScope): Promise<boolean> {
    const key = scopeKey(adapter, scope);
    const entry = this.#scoped.get(key);
    if (entry === undefined || entry.recheck === null) return entry === undefined;
    // Checks that throw are no could-not-run verdict: gateLaunch holds every office for them, as
    // on a first launch, so the scoped hold fails closed.
    const gate = await gateLaunch(adapter, this, entry.recheck, {
      scope,
      recheck: entry.recheck,
      liftsGlobal: false,
    });
    if (gate.ok) return true;
    // Widened to every office: the scoped hold and its schedule end; the next run checks again.
    if (gate.hold.scope === undefined) {
      this.#scoped.delete(key);
      return false;
    }
    const current = this.#scoped.get(key);
    if (current !== undefined) current.attempts += 1;
    return false;
  }
}

export interface HoldRechecksOptions {
  readonly clock: Clock;
  readonly holds: ScopedHoldSource;
  /** False while the daemon schedules no work (`safe`): the recheck waits a minute more. */
  readonly scheduling?: () => boolean;
  /** Runs after a recheck lifted a hold, so what waited for it can start. */
  readonly onLifted?: () => void;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

/**
 * The recheck schedule of the scoped holds (DIPO-257), on the engine clock like the plan-limit
 * schedule: a scoped hold is checked again after 1, 2, 4 and 8 minutes and then every 30, until
 * its checks pass.
 */
export class HoldRechecks {
  readonly #options: HoldRechecksOptions;
  readonly #timers = new Map<string, TimerHandle>();
  readonly #running = new Set<string>();
  readonly #stop: () => void;
  #closed = false;

  constructor(options: HoldRechecksOptions) {
    this.#options = options;
    this.#stop = options.holds.onScopedHold((adapter, scope) => this.#arm(adapter, scope));
  }

  /** Stops the listener and every timer. */
  close(): void {
    this.#closed = true;
    this.#stop();
    for (const timer of this.#timers.values()) this.#options.clock.clearTimeout(timer);
    this.#timers.clear();
  }

  #arm(adapter: string, scope: HoldScope, delay?: number): void {
    const key = scopeKey(adapter, scope);
    if (this.#closed || this.#running.has(key) || this.#timers.has(key)) return;
    const attempts = this.#options.holds.scopedAttempts(adapter, scope);
    if (attempts === null) return;
    this.#timers.set(
      key,
      this.#options.clock.setTimeout(
        () => {
          this.#timers.delete(key);
          void this.#fire(adapter, scope, key);
        },
        delay ?? launchRetryMs(attempts),
      ),
    );
  }

  async #fire(adapter: string, scope: HoldScope, key: string): Promise<void> {
    if (this.#options.holds.scopedAttempts(adapter, scope) === null) return;
    if (this.#options.scheduling?.() === false) {
      this.#arm(adapter, scope, LAUNCH_RETRY_MS[0]);
      return;
    }
    this.#running.add(key);
    try {
      if (await this.#options.holds.recheck(adapter, scope)) this.#options.onLifted?.();
    } catch (error) {
      this.#options.warn?.("repeating the launch checks of a held launch kind failed", {
        adapter,
        office: scope.office,
        kind: scope.kind,
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.#running.delete(key);
    }
    this.#arm(adapter, scope);
  }
}

export type LaunchGate =
  | { readonly ok: true }
  | { readonly ok: false; readonly outcome: "startFailed"; readonly hold: AdapterHold };

/** Where a launch is held when its checks only could not run (DIPO-257). */
export interface GateScope {
  readonly scope: HoldScope;
  /** What checks that kind again; the checks themselves by default; null for no timed recheck. */
  readonly recheck?: (() => Promise<LaunchCheckOutcome>) | null;
  /** False: a pass lifts only the scoped hold, not an adapter-wide one (a recheck). */
  readonly liftsGlobal?: boolean;
}

/**
 * Runs an adapter's launch checks before a launch or resume. A failure, or checks that throw,
 * hold the adapter and return `startFailed`; a pass lifts any hold. With `gate`, failures that
 * all are `couldNotRun` hold only `gate.scope` instead of every office.
 */
export async function gateLaunch(
  adapter: string,
  holds: AdapterHolds,
  checks: () => Promise<LaunchCheckOutcome>,
  gate?: GateScope,
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
    if (gate?.liftsGlobal === false) holds.liftScoped(adapter, gate.scope);
    else holds.lift(adapter, gate?.scope);
    return { ok: true };
  }
  const failures =
    outcome.failures.length > 0
      ? outcome.failures
      : [{ check: "launch-checks", detail: "the launch checks failed without a reason" }];
  if (gate !== undefined && failures.every((failure) => failure.couldNotRun === true)) {
    const recheck = gate.recheck === undefined ? checks : gate.recheck;
    const hold = holds.holdScoped(adapter, gate.scope, failures, recheck);
    return { ok: false, outcome: "startFailed", hold };
  }
  return { ok: false, outcome: "startFailed", hold: holds.hold(adapter, failures) };
}
