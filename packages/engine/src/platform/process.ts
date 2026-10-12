// Process identity (0006 decisions 6 and 8): liveness is PID plus start time, never socket
// reachability. On Linux the start time comes from field 22 of `/proc/<pid>/stat`; on macOS from
// `LC_ALL=C TZ=UTC ps -o lstart=`. Both have whole-second precision, so two readings of the same
// process match within a tolerance of 2 s. A zombie counts as dead. The lock (DIPO-23), host
// liveness (DIPO-44), drain (DIPO-68) and `stop --force` (DIPO-70) share this check.

import { closeSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";

import type { ChildStdin, Signal, Spawn } from "@dipsaus-orchestrator/contract";

import type { DipoPlatform } from "./paths";

/** Two readings of one process's start time differ by at most this much. */
export const START_TIME_TOLERANCE_MS = 2000;

/** What the system says about one PID. */
export interface ProcessInfo {
  readonly pid: number;
  /** Start time in milliseconds since the Unix epoch, whole-second precision. */
  readonly startTimeMs: number;
  readonly zombie: boolean;
  /** The command line, arguments joined by spaces. */
  readonly command: string;
}

/** Reads one PID; null when no such process exists. Injectable so tests use fixtures. */
export type ProcessProbe = (pid: number) => Promise<ProcessInfo | null>;

/** The identity a record carries: PID and start time. */
export interface ProcessIdentity {
  readonly pid: number;
  readonly startTimeMs: number;
}

/** True when `info` is the live process `identity` names: same PID, start time within 2 s. */
export function isSameProcess(identity: ProcessIdentity, info: ProcessInfo | null): boolean {
  return (
    info !== null &&
    !info.zombie &&
    info.pid === identity.pid &&
    Math.abs(info.startTimeMs - identity.startTimeMs) <= START_TIME_TOLERANCE_MS
  );
}

/** True when the command line is `dipo daemon --foreground`, from the binary or from source. */
export function isDaemonCommand(command: string): boolean {
  const args = command.split(/\s+/);
  const at = args.indexOf("daemon");
  return at >= 0 && args.indexOf("--foreground", at + 1) > at;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Parses `ps -o lstart=` under `LC_ALL=C TZ=UTC`, for example `Mon Oct 12 09:52:03 2026`. */
export function parseLstart(text: string): number | null {
  const match = /^\s*\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(
    text,
  );
  if (match === null) return null;
  const [, month, day, hours, minutes, seconds, year] = match;
  const monthIndex = MONTHS.indexOf(month ?? "");
  if (monthIndex < 0) return null;
  return Date.UTC(
    Number(year),
    monthIndex,
    Number(day),
    Number(hours),
    Number(minutes),
    Number(seconds),
  );
}

/**
 * Parses one line of `ps -o stat= -o lstart= -o command=` under `LC_ALL=C TZ=UTC`: the state
 * flags, the five `lstart` fields, then the command, which may contain spaces.
 */
export function parsePsLine(pid: number, line: string): ProcessInfo | null {
  const fields = line.trim().split(/\s+/);
  if (fields.length < 6) return null;
  const [stat = "", ...rest] = fields;
  const startTimeMs = parseLstart(rest.slice(0, 5).join(" "));
  if (startTimeMs === null) return null;
  return { pid, startTimeMs, zombie: stat.startsWith("Z"), command: rest.slice(5).join(" ") };
}

/** USER_HZ, the unit of `/proc/<pid>/stat` times; 100 on every Linux ABI dipo targets. */
export const CLOCK_TICKS_PER_SECOND = 100;

/**
 * Parses `/proc/<pid>/stat`. The command name in field 2 sits in parentheses and may itself hold
 * spaces and parentheses, so fields are counted from the last `)`: field 3 is the state, field 22
 * the start time in clock ticks after boot.
 */
export function parseProcStat(text: string): { state: string; startTicks: number } | null {
  const close = text.lastIndexOf(")");
  if (close < 0) return null;
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const state = fields[0];
  const start = fields[22 - 3];
  if (state === undefined || start === undefined || !/^\d+$/.test(start)) return null;
  return { state, startTicks: Number(start) };
}

/** Reads `btime` (boot time, seconds since the epoch) from `/proc/stat`. */
export function parseBootTime(procStat: string): number | null {
  const match = /^btime\s+(\d+)\s*$/m.exec(procStat);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** Start time in ms since the epoch from boot time and start ticks. */
export function procStartTimeMs(bootTimeSeconds: number, startTicks: number): number {
  return bootTimeSeconds * 1000 + Math.round((startTicks * 1000) / CLOCK_TICKS_PER_SECOND);
}

/** True unless `kill(pid, 0)` says the PID does not exist (EPERM means it does). */
export function pidExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

async function probeLinux(pid: number): Promise<ProcessInfo | null> {
  let stat: string;
  let cmdline: string;
  let procStat: string;
  try {
    [stat, cmdline, procStat] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile(`/proc/${pid}/cmdline`, "utf8"),
      readFile("/proc/stat", "utf8"),
    ]);
  } catch {
    return null;
  }
  const parsed = parseProcStat(stat);
  const bootTime = parseBootTime(procStat);
  if (parsed === null || bootTime === null) return null;
  return {
    pid,
    startTimeMs: procStartTimeMs(bootTime, parsed.startTicks),
    zombie: parsed.state === "Z",
    command: cmdline.split("\0").filter(Boolean).join(" "),
  };
}

async function probeDarwin(pid: number): Promise<ProcessInfo | null> {
  const child = Bun.spawn({
    cmd: ["/bin/ps", "-o", "stat=", "-o", "lstart=", "-o", "command=", "-p", String(pid)],
    env: { LC_ALL: "C", TZ: "UTC", PATH: "/usr/bin:/bin" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  // ps exits 1 when the PID does not exist.
  if (code !== 0) return null;
  const line = text.split("\n").find((l) => l.trim() !== "");
  return line === undefined ? null : parsePsLine(pid, line);
}

/** The system probe for this platform. */
export function systemProcessProbe(platform: DipoPlatform): ProcessProbe {
  const read = platform === "linux" ? probeLinux : probeDarwin;
  return async (pid) => (pidExists(pid) ? read(pid) : null);
}

/** A child process the daemon started itself and must wait for before it exits (0006 decision 7). */
export interface ChildHandle {
  readonly pid: number;
  /** Settles when the process has exited. */
  readonly exited: Promise<unknown>;
}

export interface SpawnChildOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdin?: "ignore" | "pipe";
  readonly stdout?: "ignore" | "pipe";
  readonly stderr?: "ignore" | "pipe";
}

/**
 * The child processes the daemon started itself (DIPO-68). The drain waits for every one of them
 * and, at the drain cap, kills the process group of each one still running. Children are spawned
 * in their own session and process group (`detached: true`, `setsid`), so one `kill(-pid)` also
 * reaches their descendants. Worker hosts are never tracked here: they outlive the daemon
 * (0006 decision 8).
 */
export class ChildProcesses {
  readonly #children = new Map<number, ChildHandle>();
  readonly #idleWaiters: (() => void)[] = [];

  /** Spawns `cmd` in a new process group and tracks it until it exits. */
  spawn(
    cmd: readonly string[],
    options: SpawnChildOptions = {},
  ): Bun.Subprocess<"ignore" | "pipe", "ignore" | "pipe", "ignore" | "pipe"> {
    const child = Bun.spawn({
      cmd: [...cmd],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: { ...options.env } }),
      stdin: options.stdin ?? "ignore",
      stdout: options.stdout ?? "ignore",
      stderr: options.stderr ?? "ignore",
      detached: true,
    });
    this.track(child);
    return child;
  }

  /** Tracks a child started elsewhere; it should lead its own process group. */
  track(child: ChildHandle): void {
    this.#children.set(child.pid, child);
    const done = () => {
      if (this.#children.get(child.pid) !== child) return;
      this.#children.delete(child.pid);
      if (this.#children.size === 0) {
        for (const resolve of this.#idleWaiters.splice(0)) resolve();
      }
    };
    child.exited.then(done, done);
  }

  /** The PIDs of the tracked children still running. */
  pids(): number[] {
    return [...this.#children.keys()];
  }

  get size(): number {
    return this.#children.size;
  }

  /** Resolves once no tracked child is running, including children tracked while waiting. */
  waitAll(): Promise<void> {
    if (this.#children.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  /** Sends `signal` to the process group of every tracked child; returns the PIDs signalled. */
  killGroups(signal: NodeJS.Signals = "SIGKILL"): number[] {
    const signalled: number[] = [];
    for (const pid of this.#children.keys()) {
      if (killGroup(pid, signal)) signalled.push(pid);
    }
    return signalled;
  }
}

/** Signals the process group led by `pid`, or the process alone when it leads no group. */
export function killGroup(pid: number, signal: NodeJS.Signals): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Signals the process group `pgid` and nothing else. Unlike `killGroup` there is no fallback to
 * the single PID: once a worker has exited its PID may be reused, but a group ID is never reused
 * while a member of the group lives, so a group signal cannot reach an unrelated process
 * (DIPO-44). Returns false when no member of the group is left.
 */
export function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Variables that carry Bun flags into a child. A Bun started with `--no-orphans` passes it on as
 * `BUN_FEATURE_FLAG_NO_ORPHANS=1` as well as through `BUN_OPTIONS` (seen on Bun 1.4.2, DIPO-44),
 * and a child that inherits either one dies with its parent.
 */
export const BUN_FLAG_VARIABLES: readonly string[] = ["BUN_OPTIONS", "BUN_FEATURE_FLAG_NO_ORPHANS"];

/**
 * The environment of a process the daemon starts detached: `BUN_OPTIONS` and the propagated
 * `--no-orphans` flag removed (0006 decision 8).
 */
export function detachedEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !BUN_FLAG_VARIABLES.includes(name)) out[name] = value;
  }
  return out;
}

export interface DetachedSpawnOptions {
  readonly cmd: readonly [string, ...string[]];
  readonly cwd: string;
  /** The complete environment, Bun flag variables already removed (`detachedEnv`). */
  readonly env: Readonly<Record<string, string>>;
  /** Stdout and stderr are appended to this file (mode 0600); stdin is `/dev/null`. */
  readonly outputFile: string;
}

/** Starts a process that outlives the daemon; returns its PID. Injectable for tests. */
export type SpawnDetached = (options: DetachedSpawnOptions) => { readonly pid: number };

/**
 * Starts `cmd` in its own session and process group (`setsid`) with stdio on files, so it keeps
 * running when the daemon exits or is killed (0006 decision 8). It is not tracked in
 * `ChildProcesses`: a drain must leave it running.
 */
export const systemSpawnDetached: SpawnDetached = (options) => {
  const fd = openSync(options.outputFile, "a", 0o600);
  try {
    const child = Bun.spawn({
      cmd: [...options.cmd],
      cwd: options.cwd,
      env: { ...options.env },
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
      detached: true,
    });
    child.unref();
    return { pid: child.pid };
  } finally {
    closeSync(fd);
  }
};

/**
 * How this process runs `dipo` again: the compiled binary alone, or Bun with the entry script when
 * running from source.
 */
export function selfCommand(): [string, ...string[]] {
  const main = Bun.main;
  return main.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, main];
}

const textEncoder = new TextEncoder();

/**
 * The real `Spawn` (0017 section 2): `Bun.spawn` behind the contract's `ChildProcess`. Stdout and
 * stderr are always piped. With `detached` the child leads its own session and process group, so
 * `signalGroup(child.pid)` reaches its descendants too.
 */
export const systemSpawn: Spawn = (options) => {
  const child = Bun.spawn({
    cmd: [...options.cmd],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: { ...options.env } }),
    stdin: options.stdin === "pipe" ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: options.detached === true,
  });
  const sink = options.stdin === "pipe" ? (child.stdin as Bun.FileSink) : null;
  const stdin: ChildStdin | null =
    sink === null
      ? null
      : {
          write: (chunk) => {
            sink.write(typeof chunk === "string" ? textEncoder.encode(chunk) : chunk);
            void sink.flush();
          },
          end: () => {
            void sink.end();
          },
        };
  return {
    pid: child.pid,
    stdin,
    stdout: child.stdout as ReadableStream<Uint8Array>,
    stderr: child.stderr as ReadableStream<Uint8Array>,
    exited: child.exited.then(() => ({
      code: child.signalCode === null ? child.exitCode : null,
      signal: child.signalCode ?? null,
    })),
    kill: (signal: Signal = "SIGTERM") => {
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    },
  };
};
