// Waiting out a recovering daemon (0006 decision 7, DIPO-86). In `starting` and `recovering` the
// daemon answers office commands and reads with the retryable `engine.recovering` (0005 section 10),
// which ends when `daemon.status` reports another state. A session wrapped here polls
// `daemon.status` on the injected clock and sends the request again after every answered poll: a
// command with its first `requestId`, so the engine runs it at most once (0005 section 9), a read
// with a fresh one. It sends again also while the daemon is still `starting` or `recovering`,
// because a daemon whose state database turned out unusable stays in `recovering` for good and
// answers the non-retryable `database.unavailable` instead (DIPO-111): the wait ends with that
// answer. It sets no deadline of its own: the caller's reply deadline bounds it, `close` ends the
// wait, and `daemon.status` failing three times in a row ends it with the `engine.recovering`
// reply. A subscription refused with `engine.recovering` is sent again the same way, from its last
// cursor (DIPO-325), so a stream that is opened while the daemon starts is not ended by the wait.

import type { z } from "zod";

import {
  type Clock,
  type CommandDefinition,
  daemonStatus,
  type ReadDefinition,
  type StreamName,
  type TimerHandle,
} from "@dipsaus-orchestrator/contract";

import {
  ClientError,
  type CommandOptions,
  type CommandOutcome,
  type DipoClient,
  type ReadOutcome,
  type RequestOptions,
  type SubscribeOptions,
  type Subscription,
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
   * Subscribes, and when the daemon refuses the subscription with `engine.recovering` (DIPO-325),
   * sends it again after every `pollMs` from the last cursor, until it is accepted, another error
   * ends it (`onEnded` gets that one), or the subscription or the session is closed.
   */
  const subscribeWhenReady = (stream: StreamName, subscribed: SubscribeOptions): Subscription => {
    let cursor = subscribed.after;
    let current: Subscription | null = null;
    let unsubscribed = false;
    const start = (): void => {
      const subscription = session.subscribe(stream, {
        ...subscribed,
        ...(cursor === undefined ? {} : { after: cursor }),
        onEnded: (error) => {
          if (error.code !== "engine.recovering" || closed || unsubscribed) {
            subscribed.onEnded?.(error);
            return;
          }
          cursor = subscription.cursor;
          void sleep(pollMs).then(() => {
            if (!closed && !unsubscribed) start();
          });
        },
      });
      current = subscription;
    };
    start();
    return {
      stream,
      get cursor() {
        return current?.cursor ?? cursor;
      },
      unsubscribe() {
        unsubscribed = true;
        current?.unsubscribe();
      },
    };
  };

  /**
   * Polls `daemon.status` and sends the request again (`attempt`) after every answered poll, until
   * an answer is no longer `engine.recovering`; returns that answer. Returns `first`, the last
   * `engine.recovering` answer, when `daemon.status` itself failed `STATUS_FAILURES` times in a
   * row, so the caller gives up.
   */
  const untilAnswered = async <
    O extends { readonly ok: boolean; readonly error?: { code: string } },
  >(
    first: O,
    attempt: () => Promise<O>,
  ): Promise<O> => {
    let last = first;
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
          if (failures >= STATUS_FAILURES) return last;
          continue;
        }
        failures = 0;
        if (status.result.state === "safe" && !safeSaid) {
          safeSaid = true;
          options.onSafe?.(status.result.stateReason);
        }
        // Sent again also while still recovering: a daemon held without its database answers
        // `database.unavailable` and never leaves `recovering` (DIPO-111).
        last = await attempt();
        ensureOpen();
        if (!isRecovering(last)) return last;
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
      ensureOpen();
      const send = () => session.command(definition, args, sent);
      const outcome = await send();
      return isRecovering(outcome) ? untilAnswered(outcome, send) : outcome;
    },

    async read<A extends z.ZodType, R extends z.ZodType>(
      definition: ReadDefinition<string, A, R>,
      args: z.input<A>,
      readOptions: RequestOptions = {},
    ): Promise<ReadOutcome<z.output<R>>> {
      ensureOpen();
      const send = () => session.read(definition, args, readOptions);
      const outcome = await send();
      return isRecovering(outcome) ? untilAnswered(outcome, send) : outcome;
    },

    subscribe: (stream, subscribeOptions) => subscribeWhenReady(stream, subscribeOptions),

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
