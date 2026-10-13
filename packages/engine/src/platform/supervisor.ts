// The daemon's view of its supervisor (0006 decisions 8 and 15). `dipo daemon install` writes a
// launchd agent labelled `dipo.daemon` or a systemd user unit `dipo.service` (client `lifecycle`).
// Inside the daemon two things depend on it:
//
// - Under systemd, each worker host starts in its own transient scope (`systemd-run --user --scope
//   --unit=dipo-run-<run-id>`), so stopping the daemon's unit, with the default
//   `KillMode=control-group`, does not kill the hosts. `systemd-run --scope` execs the command
//   after creating the scope, so the host keeps the PID the engine records.
// - Under launchd, a daemon that refuses its `config.yaml` (exit 78) boots its own job out before
//   it exits, so launchd does not restart it in a loop (the systemd unit has
//   `RestartPreventExitStatus=78` instead).

import { readFileSync } from "node:fs";

import type { Clock, Spawn } from "@dipsaus-orchestrator/contract";

/** The launchd label of the installed agent (0006 decision 15). */
export const LAUNCHD_LABEL = "dipo.daemon";
/** The systemd user unit of the installed daemon (0006 decision 15). */
export const SYSTEMD_UNIT = "dipo.service";

/** Reads this process's cgroup file; injectable for tests. */
export type ReadCgroup = () => string | null;

export const systemReadCgroup: ReadCgroup = () => {
  try {
    return readFileSync("/proc/self/cgroup", "utf8");
  } catch {
    return null;
  }
};

/** True when this process runs inside the `dipo.service` user unit. */
export function underSystemdUnit(readCgroup: ReadCgroup = systemReadCgroup): boolean {
  const text = readCgroup();
  if (text === null) return false;
  return text.split("\n").some((line) => line.trim().split("/").includes(SYSTEMD_UNIT));
}

/** `cmd` wrapped in its own transient systemd scope `dipo-run-<run-id>.scope`. */
export function systemdScopeCommand(
  runId: string,
  cmd: readonly [string, ...string[]],
): [string, ...string[]] {
  return ["systemd-run", "--user", "--scope", "--quiet", `--unit=dipo-run-${runId}`, ...cmd];
}

/** True when launchd started this process as the installed agent (it sets `XPC_SERVICE_NAME`). */
export function underLaunchdJob(env: Readonly<Record<string, string | undefined>>): boolean {
  return env["XPC_SERVICE_NAME"] === LAUNCHD_LABEL;
}

export interface BootoutOptions {
  readonly spawn: Spawn;
  readonly uid: number;
  readonly clock: Clock;
  /** How long to wait for `launchctl bootout`, which may wait for this very process to exit. */
  readonly waitMs?: number;
}

async function exitCode(spawn: Spawn, cmd: [string, ...string[]]): Promise<number | null> {
  try {
    const child = spawn({ cmd });
    void new Response(child.stdout).arrayBuffer();
    void new Response(child.stderr).arrayBuffer();
    return (await child.exited).code;
  } catch {
    return null;
  }
}

/**
 * Boots the `dipo.daemon` job out of its launchd domain: `gui/<uid>`, or `user/<uid>` where the GUI
 * domain is missing (an SSH session). Waits at most `waitMs`, because launchd answers the bootout
 * by ending this process, and returns the target it named.
 */
export async function bootoutOwnLaunchdJob(options: BootoutOptions): Promise<string> {
  const gui = `gui/${options.uid}`;
  const domain =
    (await exitCode(options.spawn, ["launchctl", "print", gui])) === 0
      ? gui
      : `user/${options.uid}`;
  const target = `${domain}/${LAUNCHD_LABEL}`;
  const done = exitCode(options.spawn, ["launchctl", "bootout", target]);
  await new Promise<void>((resolve) => {
    const timer = options.clock.setTimeout(resolve, options.waitMs ?? 3000);
    void done.then(() => {
      options.clock.clearTimeout(timer);
      resolve();
    });
  });
  return target;
}
