// Waiting out a recovering daemon (0006 decision 7, DIPO-86). In `starting` and `recovering` the
// daemon answers office commands and reads with the retryable `engine.recovering` (0005 section 10),
// which ends when `daemon.status` reports another state. A session wrapped here polls
// `daemon.status` on the injected clock until then and sends the request again: a command with its
// first `requestId`, so the engine runs it at most once (0005 section 9), a read with a fresh one.
// It sets no deadline of its own: the caller's reply deadline bounds it, `close` ends the wait, and
// `daemon.status` failing three times in a row ends it with the `engine.recovering` reply.

import type { z } from "zod";

import {
  type Clock,
  type CommandDefinition,
  daemonStatus,
  type DaemonState,
  type ReadDefinition,
  type TimerHandle,
} from "@dipsaus-orchestrator/contract";

import {
  ClientError,
  type CommandOptions,
  type CommandOutcome,
  type DipoClient,
  type ReadOutcome,
  type RequestOptions,
} from "./client";
import { type RequestIds, ulidRequestIds } from "./request-id";

/** How often a waiting session asks `daemon.status` for the state. */
export const RECOVERY_POLL_MS = 250;
/** A wait longer than this calls `onWaiting`, once per session. */
export const RECOVERY_NOTICE_MS = 1_000;
/**
 * This many failed `daemon.status` polls in a row end the wait: the request returns its
 * `engine.recovering` reply instead of waiting forever when the caller has no deadline.
 */
export const STATUS_FAILURES = 3;

/** What the wrapper needs from a connected client, and what it offers in turn. */
export type RecoverySession = Pick<DipoClient, "command" | "read" | "subscribe" | "close">;

export interface RecoveryOptions {
  readonly clock: Clock;
  /** Ids for commands sent without one; ULIDs on `clock` by default. */
  readonly requestIds?: RequestIds;
  readonly pollMs?: number;
  readonly noticeAfterMs?: number;
  /** A wait has lasted `noticeAfterMs`; called at most once per session. */
  readonly onWaiting?: () => void;
  /**
   * Recovery ended in `safe` (a crash loop): office commands and reads run, but commands that
   * schedule work fail with `scheduling.off` until `daemon.resumeScheduling`. Called at most once.
   */
  readonly onSafe?: (reason: string | undefined) => void;
}

export interface RecoveringSession extends RecoverySession {
  /** True while a request waits for the daemon to leave `starting` or `recovering`. */
  readonly waiting: boolean;
}

const RECOVERING: ReadonlySet<DaemonState> = new Set(["starting", "recovering"]);

function isRecovering(outcome: { readonly ok: boolean; readonly error?: { code: string } }) {
  return !outcome.ok && outcome.error?.code === "engine.recovering";
}

/** Wraps `session` so commands and reads wait for a recovering daemon instead of failing. */
export function waitForRecovery(
  session: RecoverySession,
  options: RecoveryOptions,
): RecoveringSession {
  const clock = options.clock;
  const newId = options.requestIds ?? ulidRequestIds(clock);
  const pollMs = options.pollMs ?? RECOVERY_POLL_MS;
  const noticeAfterMs = options.noticeAfterMs ?? RECOVERY_NOTICE_MS;
  let closed = false;
  let waiters = 0;
  let noticed = false;
  let safeSaid = false;
  /** Timers and wake-ups of the waits in progress, so `close` ends them at once. */
  const sleepers = new Set<{ readonly timer: TimerHandle; readonly wake: () => void }>();

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const entry = {
        timer: clock.setTimeout(() => {
          sleepers.delete(entry);
          resolve();
        }, ms),
        wake: resolve,
      };
      sleepers.add(entry);
    });

  const ensureOpen = () => {
    if (closed) throw new ClientError("client.closed", "The client was closed.");
  };

  /**
   * Polls `daemon.status` until the daemon has left `starting` and `recovering`; false when
   * `daemon.status` itself failed `STATUS_FAILURES` times in a row, so the caller gives up.
   */
  const untilRecovered = async (): Promise<boolean> => {
    waiters += 1;
    const notice = noticed
      ? null
      : clock.setTimeout(() => {
          if (noticed || closed) return;
          noticed = true;
          options.onWaiting?.();
        }, noticeAfterMs);
    let failures = 0;
    try {
      for (;;) {
        await sleep(pollMs);
        ensureOpen();
        const status = await session.read(daemonStatus, {});
        ensureOpen();
        if (!status.ok) {
          failures += 1;
          if (failures >= STATUS_FAILURES) return false;
          continue;
        }
        failures = 0;
        if (RECOVERING.has(status.result.state)) continue;
        if (status.result.state === "safe" && !safeSaid) {
          safeSaid = true;
          options.onSafe?.(status.result.stateReason);
        }
        return true;
      }
    } finally {
      waiters -= 1;
      if (notice !== null) clock.clearTimeout(notice);
    }
  };

  return {
    get waiting() {
      return waiters > 0;
    },

    async command<A extends z.ZodType, R extends z.ZodType>(
      definition: CommandDefinition<string, A, R>,
      args: z.input<A>,
      commandOptions: CommandOptions = {},
    ): Promise<CommandOutcome<z.output<R>>> {
      // One id for every attempt: a command the engine refused never ran, and one that did run is
      // answered from the engine's idempotency record instead of running twice.
      const sent = { ...commandOptions, requestId: commandOptions.requestId ?? newId() };
      for (;;) {
        ensureOpen();
        const outcome = await session.command(definition, args, sent);
        if (!isRecovering(outcome)) return outcome;
        if (!(await untilRecovered())) return outcome;
      }
    },

    async read<A extends z.ZodType, R extends z.ZodType>(
      definition: ReadDefinition<string, A, R>,
      args: z.input<A>,
      readOptions: RequestOptions = {},
    ): Promise<ReadOutcome<z.output<R>>> {
      for (;;) {
        ensureOpen();
        const outcome = await session.read(definition, args, readOptions);
        if (!isRecovering(outcome)) return outcome;
        if (!(await untilRecovered())) return outcome;
      }
    },

    subscribe: (stream, subscribeOptions) => session.subscribe(stream, subscribeOptions),

    close() {
      if (closed) return;
      closed = true;
      for (const sleeper of sleepers) {
        clock.clearTimeout(sleeper.timer);
        sleeper.wake();
      }
      sleepers.clear();
      session.close();
    },
  };
}
