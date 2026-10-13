// Keep-awake processes (0006 decision 12): no FFI, so the assertion is a child process whose
// lifetime is the lock. macOS runs `caffeinate -i -w <daemon-pid>`: `-i` prevents idle system
// sleep, `-w` ends the assertion when the daemon dies. Linux runs `systemd-inhibit
// --what=idle:sleep --mode=block ... dipo daemon wait-pid <daemon-pid>`: the lock lasts as long as
// the wrapped command, and `wait-pid` exits with the daemon. Either way a crash cannot leak it.
//
// This module builds the commands and starts them; the decision when to hold the assertion is the
// engine's (`keepawake/`). Tests replace `SpawnKeepAwake`, so no real assertion is ever taken.

import type { Clock } from "@dipsaus-orchestrator/contract";

import type { DipoPlatform } from "./paths";
import { pidExists } from "./process";

/** `block` keeps the machine awake; `delay` only delays sleep briefly (systemd-inhibit(1)). */
export type InhibitMode = "block" | "delay";

export interface KeepAwakeCommandOptions {
  readonly platform: DipoPlatform;
  readonly daemonPid: number;
  /** How to run `dipo` (`selfCommand()`); Linux wraps `dipo daemon wait-pid <pid>`. */
  readonly dipoCommand: readonly [string, ...string[]];
  /** Shown by `systemd-inhibit --list`, for example "2 runs active". */
  readonly why: string;
  readonly mode: InhibitMode;
}

/** The command that holds the assertion for as long as it runs. */
export function keepAwakeCommand(options: KeepAwakeCommandOptions): [string, ...string[]] {
  const pid = String(options.daemonPid);
  if (options.platform === "darwin") return ["caffeinate", "-i", "-w", pid];
  return [
    "systemd-inhibit",
    "--what=idle:sleep",
    `--mode=${options.mode}`,
    "--who=dipo",
    `--why=${options.why}`,
    ...options.dipoCommand,
    "daemon",
    "wait-pid",
    pid,
  ];
}

export interface KeepAwakeExit {
  readonly code: number | null;
  readonly signal: string | null;
  /** What the process wrote to stderr, for example polkit's refusal. */
  readonly stderr: string;
}

/** A running keep-awake process. */
export interface KeepAwakeProcess {
  readonly pid: number;
  readonly exited: Promise<KeepAwakeExit>;
  /** Ends the process, which releases the assertion. */
  kill(): void;
}

/** Thrown by `SpawnKeepAwake` when the program does not exist. */
export class KeepAwakeMissingError extends Error {
  constructor(readonly program: string) {
    super(`${program} not found`);
    this.name = "KeepAwakeMissingError";
  }
}

/** Starts a keep-awake process; injectable so tests take no real assertion. */
export type SpawnKeepAwake = (
  cmd: readonly [string, ...string[]],
  env: Readonly<Record<string, string>>,
) => KeepAwakeProcess;

/**
 * Starts the process in its own process group (so a terminal's Ctrl-C does not reach it), stdin
 * and stdout ignored, stderr kept to explain a refusal. It is not a `ChildProcesses` child: the
 * drain must not wait for it, and the daemon releases it on exit.
 */
export const systemSpawnKeepAwake: SpawnKeepAwake = (cmd, env) => {
  let child: Bun.Subprocess<"ignore", "ignore", "pipe">;
  try {
    child = Bun.spawn({
      cmd: [...cmd],
      env: { ...env },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      detached: true,
    });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT" || /ENOENT|not found|No such file/i.test(String(error))) {
      throw new KeepAwakeMissingError(cmd[0]);
    }
    throw error;
  }
  child.unref();
  const exited = Promise.all([new Response(child.stderr).text(), child.exited]).then(
    ([stderr]) => ({
      code: child.signalCode === null ? child.exitCode : null,
      signal: child.signalCode ?? null,
      stderr,
    }),
  );
  return {
    pid: child.pid,
    exited,
    kill: () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Gone already.
      }
    },
  };
};

/** How often `wait-pid` looks at the PID. */
export const WAIT_PID_POLL_MS = 1000;

/**
 * Resolves once `pid` no longer exists: the body of `dipo daemon wait-pid <pid>`, which
 * `systemd-inhibit` wraps so its lock ends with the daemon.
 */
export function waitForPidExit(
  pid: number,
  clock: Clock,
  exists: (pid: number) => boolean = pidExists,
  pollMs: number = WAIT_PID_POLL_MS,
): Promise<void> {
  return new Promise((resolve) => {
    const look = () => {
      if (!exists(pid)) {
        resolve();
        return;
      }
      clock.setTimeout(look, pollMs);
    };
    look();
  });
}
