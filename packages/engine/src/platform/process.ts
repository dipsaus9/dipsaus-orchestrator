// Process identity (0006 decisions 6 and 8): liveness is PID plus start time, never socket
// reachability. On Linux the start time comes from field 22 of `/proc/<pid>/stat`; on macOS from
// the `kern.proc.pid.<pid>` sysctl, the same `struct kinfo_proc` that `ps -o lstart=` reads, and
// the command line from `kern.procargs2` (DIPO-114). The setuid `/bin/ps` is not used: Seatbelt
// refuses to exec it inside the sandbox, and this probe must work there too. Both have
// whole-second precision, so two readings of the same process match within a tolerance of 2 s. A
// zombie counts as dead. The lock (DIPO-23), host liveness (DIPO-44), drain (DIPO-68) and
// `stop --force` (DIPO-70) share this check.

import { dlopen, FFIType, ptr } from "bun:ffi";
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

/**
 * True when the command line is `dipo daemon worker-host <runId>`, from the binary or from source
 * (DIPO-93). The last three arguments are compared, so a binary path with spaces still matches,
 * and the run id must be the last argument exactly.
 */
export function isWorkerHostCommand(command: string, runId: string): boolean {
  const args = command.trim().split(/\s+/);
  return (
    args.length >= 4 &&
    args.at(-1) === runId &&
    args.at(-2) === "worker-host" &&
    args.at(-3) === "daemon"
  );
}

/**
 * `sizeof(struct kinfo_proc)` on macOS arm64 and x86_64 (both LP64). The sysctl returns fewer
 * bytes, zero, when no process has the PID.
 */
export const KINFO_PROC_SIZE = 648;
// Offsets into `struct kinfo_proc`, whose first member is `struct extern_proc` (<sys/sysctl.h>,
// <sys/proc.h>): `p_starttime.tv_sec` (int64), `p_stat` (char), `p_comm` (char[MAXCOMLEN + 1]).
const KINFO_START_SECONDS = 0;
const KINFO_STAT = 36;
const KINFO_COMM = 243;
const MAXCOMLEN = 16;
/** `p_stat` of a zombie (<sys/proc.h>). */
const SZOMB = 5;

/** What `kern.proc.pid.<pid>` says about one process. */
export interface KinfoProc {
  /** `p_starttime.tv_sec`: whole seconds, as `ps -o lstart=` shows it. */
  readonly startSeconds: number;
  readonly zombie: boolean;
  /** `p_comm`: the executable name, cut at 16 bytes. */
  readonly comm: string;
}

const textDecoder = new TextDecoder();

function cString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return textDecoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
}

/** Parses the `struct kinfo_proc` of `kern.proc.pid.<pid>`; null when the buffer is too short. */
export function parseKinfoProc(buffer: Uint8Array): KinfoProc | null {
  if (buffer.byteLength < KINFO_PROC_SIZE) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const startSeconds = Number(view.getBigInt64(KINFO_START_SECONDS, true));
  if (startSeconds <= 0) return null;
  return {
    startSeconds,
    zombie: buffer[KINFO_STAT] === SZOMB,
    comm: cString(buffer.subarray(KINFO_COMM, KINFO_COMM + MAXCOMLEN + 1)),
  };
}

/**
 * Parses `kern.procargs2.<pid>`: `argc` as an int32, the executable path, NUL padding, then the
 * `argc` arguments, each NUL-terminated, then the environment. Returns the arguments joined by
 * spaces, as `ps -o command=` shows them; null when the buffer is malformed.
 */
export function parseProcArgs(buffer: Uint8Array): string | null {
  if (buffer.byteLength < 4) return null;
  const argc = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getInt32(0, true);
  if (argc <= 0) return null;
  let at = buffer.indexOf(0, 4);
  if (at < 0) return null;
  while (at < buffer.byteLength && buffer[at] === 0) at++;
  const args: string[] = [];
  while (args.length < argc && at < buffer.byteLength) {
    const end = buffer.indexOf(0, at);
    const stop = end < 0 ? buffer.byteLength : end;
    args.push(textDecoder.decode(buffer.subarray(at, stop)));
    at = stop + 1;
  }
  return args.length === argc ? args.join(" ") : null;
}

/**
 * One process from its `kinfo_proc` and, when readable, its arguments. The command follows
 * `ps -o command=`: `<defunct>` for a zombie, `(comm)` when the arguments cannot be read.
 */
export function darwinProcessInfo(pid: number, kinfo: KinfoProc, args: string | null): ProcessInfo {
  const command = kinfo.zombie ? "<defunct>" : (args ?? `(${kinfo.comm})`);
  return { pid, startTimeMs: kinfo.startSeconds * 1000, zombie: kinfo.zombie, command };
}

/**
 * What one `kern.proc.pid.<pid>` call says. Only a call that succeeds with no bytes means "no such
 * process" (null). A failed call (EPERM from a sandbox denial, EINVAL, ENOMEM) or a malformed
 * `kinfo_proc` is unknown, never dead: it throws, as a probe that cannot run does, so no caller
 * breaks a live PID record on it.
 */
export function kinfoOutcome(pid: number, code: number, buffer: Uint8Array): KinfoProc | null {
  if (code !== 0)
    throw new Error(`cannot read process ${pid}: sysctl kern.proc.pid returned ${code}`);
  if (buffer.byteLength === 0) return null;
  const kinfo = parseKinfoProc(buffer);
  if (kinfo === null) {
    throw new Error(
      `cannot read process ${pid}: malformed kinfo_proc (${buffer.byteLength} bytes)`,
    );
  }
  return kinfo;
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

// <sys/sysctl.h>: CTL_KERN, KERN_PROC with KERN_PROC_PID, KERN_PROCARGS2.
const CTL_KERN = 1;
const KERN_PROC = 14;
const KERN_PROC_PID = 1;
const KERN_PROCARGS2 = 49;

function openLibSystem() {
  return dlopen("/usr/lib/libSystem.B.dylib", {
    // int sysctl(int *name, u_int namelen, void *oldp, size_t *oldlenp, void *newp, size_t newlen)
    sysctl: {
      args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
      returns: FFIType.i32,
    },
  });
}

let libSystem: ReturnType<typeof openLibSystem> | null = null;

/** Reads one sysctl into a buffer of at most `size` bytes: the return code and the bytes read. */
function readSysctl(mib: readonly number[], size: number): { code: number; buffer: Uint8Array } {
  libSystem ??= openLibSystem();
  const name = Int32Array.from(mib);
  const buffer = new Uint8Array(size);
  const length = BigUint64Array.of(BigInt(size));
  const code = libSystem.symbols.sysctl(ptr(name), name.length, ptr(buffer), ptr(length), null, 0n);
  return { code, buffer: code === 0 ? buffer.subarray(0, Number(length[0] ?? 0n)) : buffer };
}

/** The size `kern.procargs2.<pid>` needs; null when the arguments cannot be read. */
function procArgsSize(pid: number): number | null {
  libSystem ??= openLibSystem();
  const name = Int32Array.of(CTL_KERN, KERN_PROCARGS2, pid);
  const length = BigUint64Array.of(0n);
  const code = libSystem.symbols.sysctl(ptr(name), name.length, null, ptr(length), null, 0n);
  const needed = length[0] ?? 0n;
  return code === 0 && needed > 0n ? Number(needed) : null;
}

async function probeDarwin(pid: number): Promise<ProcessInfo | null> {
  const raw = readSysctl([CTL_KERN, KERN_PROC, KERN_PROC_PID, pid], KINFO_PROC_SIZE);
  const kinfo = kinfoOutcome(pid, raw.code, raw.buffer);
  if (kinfo === null) return null;
  let args: string | null = null;
  if (!kinfo.zombie) {
    // A zombie has no arguments left. Another user's process, or one outside this process's
    // sandbox, refuses them too, and the command falls back to `(comm)`. Here this probe differs
    // from the setuid `ps`, which could read another user's arguments.
    const size = procArgsSize(pid);
    const read = size === null ? null : readSysctl([CTL_KERN, KERN_PROCARGS2, pid], size);
    args = read === null || read.code !== 0 ? null : parseProcArgs(read.buffer);
  }
  return darwinProcessInfo(pid, kinfo, args);
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
 * Variables a supervisor sets for its own job and a child must not inherit: launchd's
 * `XPC_SERVICE_NAME` names the job, and a child carrying `dipo.daemon` would look like the
 * installed agent (DIPO-63).
 */
export const SUPERVISOR_VARIABLES: readonly string[] = ["XPC_SERVICE_NAME"];

/** Sends one signal to one process; injectable so tests record the call (DIPO-93). */
export type SignalProcess = (pid: number, signal: NodeJS.Signals) => boolean;

/**
 * Signals the one process `pid` and nothing else: never a group, never PID 1 and never this
 * process (DIPO-93). The caller verified the PID and its start time just before. False when the
 * process is gone or the signal was refused.
 */
export const signalProcess: SignalProcess = (pid, signal) => {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
};

/**
 * The environment of a process the daemon starts detached: `BUN_OPTIONS` and the propagated
 * `--no-orphans` flag removed (0006 decision 8).
 */
export function detachedEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (
      value !== undefined &&
      !BUN_FLAG_VARIABLES.includes(name) &&
      !SUPERVISOR_VARIABLES.includes(name)
    )
      out[name] = value;
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
