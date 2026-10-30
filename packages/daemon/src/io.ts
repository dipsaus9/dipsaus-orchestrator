// What the daemon forms need from their process, injectable so tests run them in-process.

import type { Clock } from "@dipsaus-orchestrator/contract";
import { systemClock } from "@dipsaus-orchestrator/engine/platform";

/** The process events of an error no code caught (DIPO-117). */
export type UncaughtEvent = "unhandledRejection" | "uncaughtException";

/** Where the daemon hears of errors no code caught; `process` in the binary. */
export interface UncaughtSource {
  on(event: UncaughtEvent, listener: (error: unknown) => void): unknown;
  off(event: UncaughtEvent, listener: (error: unknown) => void): unknown;
}

export type DaemonIo = {
  readonly writeLine: (line: string) => void;
  readonly writeError: (line: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Bun's own flags for this process, checked for `--no-orphans` (0006 decision 8). */
  readonly execArgv: readonly string[];
  /** The binary version, recorded in `dipo.pid`, `runtime.json` and the database. */
  readonly version: string;
  /** The commit the binary was built from, `-dirty` for a dirty tree; absent from source (DIPO-198). */
  readonly buildCommit?: string;
  /** Calls `handler` once on SIGTERM or SIGINT; returns a function that removes the handler. */
  readonly onShutdownSignal: (handler: (signal: string) => void) => () => void;
  /** Time and timers for the daemon: the drain cap and the upgrade check. */
  readonly clock: Clock;
  /**
   * Where `--foreground` hears of errors no code caught (DIPO-117); `process` by default. Tests
   * that run the daemon in this process pass a fake, so no listener lands on the test runner.
   */
  readonly uncaughtErrors?: UncaughtSource;
};

export const defaultIo: DaemonIo = {
  writeLine: (line) => process.stdout.write(`${line}\n`),
  writeError: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
  execArgv: process.execArgv,
  version: "dev",
  onShutdownSignal: (handler) => {
    const listener = (signal: string) => handler(signal);
    process.once("SIGTERM", listener);
    process.once("SIGINT", listener);
    return () => {
      process.off("SIGTERM", listener);
      process.off("SIGINT", listener);
    };
  },
  clock: systemClock,
  uncaughtErrors: process,
};

/**
 * True when `--no-orphans` is active (0006 decision 8): in this process's Bun flags or in
 * `BUN_OPTIONS`, or inherited from a parent Bun as `BUN_FEATURE_FLAG_NO_ORPHANS` (DIPO-44). It would
 * end the daemon with the starting client and SIGKILL every worker host on a clean exit.
 */
export function noOrphansActive(io: Pick<DaemonIo, "env" | "execArgv">): boolean {
  const flag = io.env["BUN_FEATURE_FLAG_NO_ORPHANS"];
  if (flag !== undefined && flag !== "" && flag !== "0" && flag !== "false") return true;
  if (io.execArgv.some((arg) => arg === "--no-orphans" || arg.startsWith("--no-orphans="))) {
    return true;
  }
  const options = io.env["BUN_OPTIONS"] ?? "";
  return options
    .split(/\s+/)
    .some((arg) => arg === "--no-orphans" || arg.startsWith("--no-orphans="));
}
