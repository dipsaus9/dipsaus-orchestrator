// Process identity for the client's `lifecycle` module (0006 decisions 2 and 6): liveness is PID
// plus start time, never socket reachability. `client` may not import `engine` (0004), so the
// rules of `engine/src/platform/process.ts` (DIPO-23) are repeated here: Linux reads field 22 of
// `/proc/<pid>/stat`, macOS the `kern.proc.pid.<pid>` and `kern.procargs2` sysctls through
// `bun:ffi` (DIPO-114; the setuid `/bin/ps` is refused inside the sandbox), both to the second, so
// two readings match within 2 s, and a zombie counts as dead. `test/lifecycle-parity` runs both
// copies on the same inputs.

import { dlopen, FFIType, ptr } from "bun:ffi";
import { readFile } from "node:fs/promises";

/** Two readings of one process's start time differ by at most this much. */
export const START_TIME_TOLERANCE_MS = 2000;

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

/** USER_HZ, the unit of `/proc/<pid>/stat` times. */
const CLOCK_TICKS_PER_SECOND = 100;

/** Parses `/proc/<pid>/stat`: field 3 is the state, field 22 the start time in ticks after boot. */
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
    startTimeMs: bootTime * 1000 + Math.round((parsed.startTicks * 1000) / CLOCK_TICKS_PER_SECOND),
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

/** The system probe for this platform (macOS or Linux, 0004). */
export function systemProcessProbe(platform: string = process.platform): ProcessProbe {
  const read = platform === "linux" ? probeLinux : probeDarwin;
  return async (pid) => (pidExists(pid) ? read(pid) : null);
}
