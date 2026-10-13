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
//   `RestartPreventExitStatus=78` instead). `XPC_SERVICE_NAME` is inherited, and every detached
//   spawn strips it, but it is only a hint: the bootout also needs launchd as the parent and
//   `launchctl print` naming this very PID as the job's, so a `dipo daemon --foreground` started
//   by anything else can never boot out the maintainer's real job.

import { readFileSync } from "node:fs";

import {
  type Clock,
  LAUNCHD_LABEL,
  type Spawn,
  SYSTEMD_UNIT,
} from "@dipsaus-orchestrator/contract";

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

/**
 * A hint that launchd started this process as the installed agent: launchd sets `XPC_SERVICE_NAME`
 * to the label. Inherited by children, so `bootoutOwnLaunchdJob` checks the PID as well.
 */
export function underLaunchdJob(env: Readonly<Record<string, string | undefined>>): boolean {
  return env["XPC_SERVICE_NAME"] === LAUNCHD_LABEL;
}

export interface BootoutOptions {
  readonly spawn: Spawn;
  readonly uid: number;
  /** This process; the job must report it as its PID. */
  readonly pid: number;
  /** This process's parent; launchd (1) for a job it started. */
  readonly ppid: number;
  readonly clock: Clock;
  /** How long to wait for `launchctl bootout`, which may wait for this very process to exit. */
  readonly waitMs?: number;
}

async function runCommand(
  spawn: Spawn,
  cmd: [string, ...string[]],
): Promise<{ code: number | null; stdout: string }> {
  try {
    const child = spawn({ cmd });
    const stdout = new Response(child.stdout).text();
    void new Response(child.stderr).arrayBuffer();
    const { code } = await child.exited;
    return { code, stdout: await stdout };
  } catch {
    return { code: null, stdout: "" };
  }
}

/** The PID `launchctl print <target>` reports for a running job, else null. */
export function launchdJobPid(printOutput: string): number | null {
  const match = /^\s*pid = (\d+)\s*$/m.exec(printOutput);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * Boots the `dipo.daemon` job out of its launchd domain, `gui/<uid>` or, where the GUI domain is
 * missing (an SSH session), `user/<uid>`, but only when this process is that job: launchd is its
 * parent and `launchctl print` reports this PID. Waits at most `waitMs`, because launchd answers
 * the bootout by ending this process. Returns the target it booted out, or null when this process
 * is not the job (nothing is booted out).
 */
export async function bootoutOwnLaunchdJob(options: BootoutOptions): Promise<string | null> {
  if (options.ppid !== 1) return null;
  let target: string | null = null;
  for (const domain of [`gui/${options.uid}`, `user/${options.uid}`]) {
    const candidate = `${domain}/${LAUNCHD_LABEL}`;
    const printed = await runCommand(options.spawn, ["launchctl", "print", candidate]);
    if (printed.code === 0 && launchdJobPid(printed.stdout) === options.pid) {
      target = candidate;
      break;
    }
  }
  if (target === null) return null;
  const done = runCommand(options.spawn, ["launchctl", "bootout", target]);
  await new Promise<void>((resolve) => {
    const timer = options.clock.setTimeout(resolve, options.waitMs ?? 3000);
    void done.then(() => {
      options.clock.clearTimeout(timer);
      resolve();
    });
  });
  return target;
}
