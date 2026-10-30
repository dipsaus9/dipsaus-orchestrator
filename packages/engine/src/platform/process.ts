// Process identity (0006 decisions 6 and 8): liveness is PID plus start time, never socket
// reachability. On Linux the start time comes from field 22 of `/proc/<pid>/stat`; on macOS from
// the `kern.proc.pid.<pid>` sysctl, the same `struct kinfo_proc` that `ps -o lstart=` reads, and
// the command line from `kern.procargs2` (DIPO-114). The setuid `/bin/ps` is not used: Seatbelt
// refuses to exec it inside the sandbox, and this probe must work there too. Both have
// whole-second precision, so two readings of the same process match within a tolerance of 2 s. A
// zombie counts as dead. The lock (DIPO-23), host liveness (DIPO-44), drain (DIPO-68) and
// `stop --force` (DIPO-70) share this check. The parsers and the identity rule are the contract's
// runtime layout, which the client's probe uses too (DIPO-320); this module makes the system calls.

import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";

import {
  type ChildStdin,
  darwinProcess,
  linuxProcess,
  type ProcessInfo,
  type ProcessProbe,
  type Signal,
  type Spawn,
  type SpawnOutputFile,
  type Sysctl,
} from "@dipsaus-orchestrator/contract";

import { ignoreRejection } from "./background";
import {
  closeOutputFiles,
  type OutputFiles,
  openOutputFiles,
  readOutputFiles,
} from "./output-files";
import type { DipoPlatform } from "./paths";

export {
  BUN_FLAG_VARIABLES,
  CLOCK_TICKS_PER_SECOND,
  darwinProcessInfo,
  detachedEnv,
  isDaemonCommand,
  isSameProcess,
  KINFO_PROC_SIZE,
  type KinfoProc,
  kinfoOutcome,
  parseBootTime,
  parseKinfoProc,
  parseProcArgs,
  parseProcStat,
  type ProcessIdentity,
  type ProcessInfo,
  type ProcessProbe,
  procStartTimeMs,
  START_TIME_TOLERANCE_MS,
  SUPERVISOR_VARIABLES,
} from "@dipsaus-orchestrator/contract";

/** Programs that run another command: a process behind one of them is not the worker host (DIPO-386). */
const WRAPPER_PROGRAMS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "env",
  "exec",
  "nohup",
  "sudo",
  "timeout",
]);

/**
 * True when the command line is `dipo daemon worker-host <runId>`, from the binary or from source
 * (DIPO-93). The last three arguments are compared, and the run id must be the last argument
 * exactly. What runs before them is the binary, whose path may hold spaces, or Bun and its entry
 * script; a wrapper such as `sh -c` or `env` in front of them is refused (DIPO-386).
 */
export function isWorkerHostCommand(command: string, runId: string): boolean {
  const args = command.trim().split(/\s+/);
  if (
    args.length < 4 ||
    args.at(-1) !== runId ||
    args.at(-2) !== "worker-host" ||
    args.at(-3) !== "daemon"
  ) {
    return false;
  }
  const program = args.slice(0, -3);
  if (program.some((arg) => arg === "-c" || WRAPPER_PROGRAMS.has(arg.split("/").at(-1) ?? ""))) {
    return false;
  }
  const programText = program.join(" ");
  return /(^|\/)dipo$/.test(programText) || /^\S*\/bun(\.exe)? \S+$/.test(programText);
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
  return linuxProcess(pid, stat, cmdline, procStat);
}

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

/** `sysctl` through libSystem, for the macOS probe. */
const systemSysctl: Sysctl = {
  read(mib, size) {
    libSystem ??= openLibSystem();
    const name = Int32Array.from(mib);
    const buffer = new Uint8Array(size);
    const length = BigUint64Array.of(BigInt(size));
    const code = libSystem.symbols.sysctl(
      ptr(name),
      name.length,
      ptr(buffer),
      ptr(length),
      null,
      0n,
    );
    return { code, buffer: code === 0 ? buffer.subarray(0, Number(length[0] ?? 0n)) : buffer };
  },
  size(mib) {
    libSystem ??= openLibSystem();
    const name = Int32Array.from(mib);
    const length = BigUint64Array.of(0n);
    const code = libSystem.symbols.sysctl(ptr(name), name.length, null, ptr(length), null, 0n);
    const needed = length[0] ?? 0n;
    return code === 0 && needed > 0n ? Number(needed) : null;
  },
};

async function probeDarwin(pid: number): Promise<ProcessInfo | null> {
  return darwinProcess(systemSysctl, pid);
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

/** A stream of the one chunk `bytes` settles to; a failed read errors the stream. */
function streamOf(bytes: Promise<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const chunk = await bytes;
        if (chunk.byteLength > 0) controller.enqueue(chunk);
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

/** `Bun.spawn` with the contract's options, stdout and stderr on `files` or on pipes. */
function bunSpawn(options: Parameters<Spawn>[0], files: OutputFiles | null) {
  return Bun.spawn({
    cmd: [...options.cmd],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: { ...options.env } }),
    stdin: options.stdin === "pipe" ? "pipe" : "ignore",
    stdout: files === null ? "pipe" : files.stdout,
    stderr: files === null ? "pipe" : files.stderr,
    detached: options.detached === true,
  });
}

/**
 * Spawns with `options.output` files. dipo keeps its descriptors of the files to read them after
 * the exit; on a failed start they are closed and the folder goes too.
 */
function spawnWithFiles(options: Parameters<Spawn>[0], output: SpawnOutputFile) {
  const files = openOutputFiles(output);
  try {
    return { child: bunSpawn(options, files), files };
  } catch (error) {
    closeOutputFiles(files);
    throw error;
  }
}

/**
 * The real `Spawn` (0017 section 2): `Bun.spawn` behind the contract's `ChildProcess`. Stdout and
 * stderr are piped, or with `output` written to regular files that are read once the child has
 * exited (DIPO-333). With `detached` the child leads its own session and process group, so
 * `signalGroup(child.pid)`, and the child's `killGroup`, reach its descendants too.
 */
export const systemSpawn: Spawn = (options) => {
  const started =
    options.output === undefined
      ? { child: bunSpawn(options, null), files: null }
      : spawnWithFiles(options, options.output);
  const { child } = started;
  const files = started.files === null ? null : readOutputFiles(started.files, child.exited);
  // An output nobody reads must not fail as an unhandled rejection (DIPO-117).
  ignoreRejection(files);
  const sink = options.stdin === "pipe" ? (child.stdin as Bun.FileSink) : null;
  const stdin: ChildStdin | null =
    sink === null
      ? null
      : {
          write: (chunk) => {
            sink.write(typeof chunk === "string" ? textEncoder.encode(chunk) : chunk);
            // A flush or end that rejects once the child exited must not reach the daemon as an
            // unhandled rejection, which is a crash (DIPO-117); a sync throw still reaches the caller.
            ignoreRejection(sink.flush());
          },
          end: () => {
            ignoreRejection(sink.end());
          },
        };
  return {
    pid: child.pid,
    stdin,
    stdout:
      files === null
        ? (child.stdout as ReadableStream<Uint8Array>)
        : streamOf(files.then(([stdout]) => stdout)),
    stderr:
      files === null
        ? (child.stderr as ReadableStream<Uint8Array>)
        : streamOf(files.then(([, stderr]) => stderr)),
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
    // A detached child leads its own group; only then does a group signal reach just its own.
    ...(options.detached === true
      ? { killGroup: (signal: Signal) => void signalGroup(child.pid, signal) }
      : {}),
  };
};
