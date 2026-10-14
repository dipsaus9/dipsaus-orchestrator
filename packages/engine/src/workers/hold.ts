// The adapter hold (0008 sections 2 and 7; owned by DIPO-43, M0 review DIPO-15). A failed launch
// check (probe, project settings, sandbox self-test) or a `startFailed` outcome from the CLI holds
// every new run on that adapter, in every office, and raises an `engine.notice`. It is a hold, not
// a park: the story stays Ready. An explicit `work.run` repeats the launch checks through
// `gateLaunch`, which lifts the hold when they pass. Adapter-neutral: nothing here names a CLI.

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

/**
 * The holds of one daemon, shared by every office. In memory: after a restart the launch checks
 * run again before the next launch (they run before every launch and resume), so a lost hold
 * cannot let an unsafe run start.
 */
export class AdapterHolds {
  readonly #holds = new Map<string, AdapterHold>();
  readonly #clock: Clock;
  readonly #notify: (notice: HoldNotice) => void;

  constructor(options: AdapterHoldsOptions) {
    this.#clock = options.clock;
    this.#notify = options.notify;
  }

  /** Holds `adapter` with the failures and raises the notice. Replaces an earlier hold. */
  hold(adapter: string, failures: readonly LaunchCheckFailure[]): AdapterHold {
    const [first] = failures;
    if (first === undefined) throw new Error("an adapter hold needs at least one failure");
    const hold: AdapterHold = {
      adapter,
      check: first.check,
      detail: first.detail,
      ...(first.file === undefined ? {} : { file: first.file }),
      ...(first.key === undefined ? {} : { key: first.key }),
      failures: [...failures],
      since: this.#clock.now(),
    };
    this.#holds.set(adapter, hold);
    this.#notify({ level: "error", code: HOLD_NOTICE_CODE, text: holdMessage(hold) });
    return hold;
  }

  /** Lifts the hold on `adapter`; true when there was one. */
  lift(adapter: string): boolean {
    if (!this.#holds.delete(adapter)) return false;
    this.#notify({
      level: "info",
      code: RELEASE_NOTICE_CODE,
      text: `The launch checks for ${adapter} passed; new runs on ${adapter} are no longer held.`,
    });
    return true;
  }

  /** The predicate DIPO-48 and DIPO-74 consume: the hold on `adapter`, or null. */
  adapterHeld(adapter: string): AdapterHold | null {
    return this.#holds.get(adapter) ?? null;
  }
}

export type LaunchGate =
  | { readonly ok: true }
  | { readonly ok: false; readonly outcome: "startFailed"; readonly hold: AdapterHold };

/**
 * Runs an adapter's launch checks before a launch or resume. A failure, or checks that throw,
 * hold the adapter and return `startFailed`; a pass lifts any hold.
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
    return { ok: true };
  }
  const failures =
    outcome.failures.length > 0
      ? outcome.failures
      : [{ check: "launch-checks", detail: "the launch checks failed without a reason" }];
  return { ok: false, outcome: "startFailed", hold: holds.hold(adapter, failures) };
}
