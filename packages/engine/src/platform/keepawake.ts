// Keep-awake processes (0005, 0006): no FFI, so the assertion is a child process whose lifetime is
// the lock: `caffeinate -i -w <daemon-pid>`. `-i` prevents idle system sleep, `-w`
// ends the assertion when the daemon dies, so a crash cannot leak it. dipo runs on macOS only
// (0004); where `caffeinate` is missing (the Linux CI test host) the assertion is not held.
//
// This module builds the commands and starts them; the decision when to hold the assertion is the
// engine's (`keepawake/`). Tests replace `SpawnKeepAwake`, so no real assertion is ever taken.

/** The command that holds the assertion for as long as it runs. */
export function keepAwakeCommand(daemonPid: number): [string, ...string[]] {
  return ["caffeinate", "-i", "-w", String(daemonPid)];
}

export interface KeepAwakeExit {
  readonly code: number | null;
  readonly signal: string | null;
  /** What the process wrote to stderr. */
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
