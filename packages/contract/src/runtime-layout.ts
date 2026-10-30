// The daemon's runtime layout (0005, DIPO-320): its folders and files, the records it writes
// there, and how a process is told apart from another. The daemon (through the engine's platform
// module) writes them and every client reads them, so the rules live here once, runtime-free,
// and both sides import them; no parity test keeps two copies in line any more. What touches the
// system (`stat`, the `sysctl` and `/proc` reads, `kill(pid, 0)`, reading and writing the files)
// stays with each side and hands its raw answers to the rules here.

// Folders and files

/** An environment as a process sees it. */
export type Env = Readonly<Record<string, string | undefined>>;

/**
 * The test marker (DIPO-316): `DIPO_TEST=1`, set for every test process by the test runner's setup
 * file and in every test daemon's environment. With it, dipo refuses the real home's state, logs
 * and runtime folders instead of using them.
 */
export const TEST_MARKER = "DIPO_TEST";

/** True when one of `envs` carries the test marker. */
export function hasTestMarker(...envs: readonly Env[]): boolean {
  return envs.some((env) => env[TEST_MARKER] === "1");
}

/** Codes of the directory refusals (DIPO-316), dotted like the contract's error codes. */
export const DIR_ERROR_CODES = {
  /** `DIPO_HOME` names a folder dipo cannot use. */
  stateUnusable: "paths.stateDirUnusable",
  /** A test resolved the real home's state or logs folder. */
  realStateInTest: "paths.realStateInTest",
  /** `DIPO_RUNTIME_DIR` names a folder dipo cannot use. */
  runtimeUnusable: "paths.runtimeDirUnusable",
  /** A test would take one of the real runtime folders. */
  realRuntimeInTest: "paths.realRuntimeInTest",
  /** No runtime candidate and no fallback is usable. */
  noRuntimeDir: "paths.noRuntimeDir",
} as const;

/**
 * The daemon lock in `<state>` (0005): an exclusive SQLite lock the holder keeps for its whole life.
 * Only the engine's platform lock module opens it.
 */
export const LOCK_FILE = "dipo.lock";
/** The lock holder's record in `<state>` (0005): PID, start time, version, runtime directory. */
export const PID_FILE = "dipo.pid";
/** The record in `<state>` that names the socket, written after the lock is held. */
export const RUNTIME_FILE = "runtime.json";
/** The contract socket in the runtime directory. */
export const SOCKET_FILE = "dipo.sock";
/** The daemon's log in `<logs>` (0005). */
export const DAEMON_LOG_FILE = "daemon.log";
/** Rotated files kept next to `daemon.log`: `daemon.log.1` (newest) to `daemon.log.5`. */
export const DAEMON_LOG_KEEP = 5;

/** Longest socket path a runtime directory must hold, in bytes (0005). */
export const RUNTIME_PATH_LIMIT = 100;
/** The longest file in the runtime directory: a worker host socket. */
export const LONGEST_RUNTIME_ENTRY = `hosts/run_${"0".repeat(26)}.sock`;

/** `path` without one trailing slash, except for the root. */
export function stripSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * `path` with `.` and `..` segments resolved and runs of slashes collapsed, as `node:path`'s
 * `normalize` does for POSIX paths, without a trailing slash. `..` above the root stays at the
 * root; a relative path keeps the `..` it cannot resolve. Split on `/`, never a pattern, so a run
 * of slashes costs one pass.
 */
export function normalizePath(path: string): string {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") parts.push(part);
    else if (parts.length > 0 && parts.at(-1) !== "..") parts.pop();
    else if (!absolute) parts.push("..");
  }
  const joined = parts.join("/");
  if (absolute) return `/${joined}`;
  return joined === "" ? "." : joined;
}

/** `name` inside the folder `dir`, normalised. */
export function inDir(dir: string, name: string): string {
  return normalizePath(`${dir}/${name}`);
}

/**
 * True when `path` is `dir` or inside it, both normalised first: `<dir>/../x` is not inside
 * `<dir>`, and `<dir>/./x` is.
 */
export function isWithin(path: string, dir: string): boolean {
  const p = normalizePath(path);
  const d = normalizePath(dir);
  return p === d || p.startsWith(d === "/" ? "/" : `${d}/`);
}

/** The default state and logs folders of the passwd home `home` (0005). */
export function defaultSoftwareDirs(home: string): {
  readonly state: string;
  readonly logs: string;
} {
  return {
    state: inDir(home, "Library/Application Support/dipo"),
    logs: inDir(home, "Library/Logs/dipo"),
  };
}

/**
 * `<state>` and `<logs>` (0005): `~/Library/Application Support/dipo` and `~/Library/Logs/dipo` of
 * the passwd home, never of `$HOME` or `TMPDIR`. `DIPO_HOME` replaces the anchor, for tests only;
 * its logs go to `<DIPO_HOME>/logs`. `override` is that `DIPO_HOME`, which the caller checks.
 */
export function softwareDirsOf(
  env: Env,
  home: string,
): { readonly state: string; readonly logs: string; readonly override: string | null } {
  const override = env["DIPO_HOME"];
  if (override !== undefined && override !== "") {
    return { state: override, logs: inDir(override, "logs"), override };
  }
  return { ...defaultSoftwareDirs(home), override: null };
}

/** The refusal text of a `DIPO_HOME` dipo cannot use. */
export function stateUnusableMessage(path: string, reason: string): string {
  return `${DIR_ERROR_CODES.stateUnusable}: DIPO_HOME ${path} cannot be used: ${reason}. Fix or unset DIPO_HOME; dipo does not fall back to another state folder.`;
}

/** The refusal text of the real home's state or logs folder in a test. */
export function realStateInTestMessage(path: string): string {
  return `${DIR_ERROR_CODES.realStateInTest}: refusing ${path} with ${TEST_MARKER}=1: it is the real home's dipo folder. Set DIPO_HOME to a folder under DIPO_TMP.`;
}

/** The refusal text of a `DIPO_RUNTIME_DIR` dipo cannot use. */
export function runtimeUnusableMessage(path: string, reason: string): string {
  return `${DIR_ERROR_CODES.runtimeUnusable}: DIPO_RUNTIME_DIR ${path} cannot be used: ${reason}. Fix or unset DIPO_RUNTIME_DIR; dipo does not fall back to another runtime directory.`;
}

/** What `stat` or `lstat` saw of a folder, reduced to what the checks need. */
export interface DirStat {
  readonly isSymbolicLink: boolean;
  readonly isDirectory: boolean;
  readonly uid: number;
  /** The permission bits. */
  readonly mode: number;
}

/**
 * Why an existing `DIPO_HOME` cannot be used, or null: it must be a directory `uid` owns. A
 * negative `uid` (unknown) skips the owner check. A path that is not absolute is refused before
 * any `stat`; a missing one is created by the daemon.
 */
export function stateDirReason(stat: Pick<DirStat, "isDirectory" | "uid">, uid: number) {
  if (!stat.isDirectory) return "it is not a directory";
  if (uid >= 0 && stat.uid !== uid) return `it is owned by uid ${stat.uid}, not ${uid}`;
  return null;
}

/** Byte length of the longest path the runtime directory `dir` must hold. */
export function longestRuntimePathBytes(dir: string): number {
  return new TextEncoder().encode(inDir(dir, LONGEST_RUNTIME_ENTRY)).byteLength;
}

/** Why `dir` is too long for every socket path, or null. */
export function runtimePathReason(dir: string): string | null {
  const bytes = longestRuntimePathBytes(dir);
  return bytes > RUNTIME_PATH_LIMIT
    ? `socket paths would be ${bytes} bytes, over the ${RUNTIME_PATH_LIMIT}-byte limit`
    : null;
}

/**
 * Why an existing runtime directory cannot be used, or null: a real directory (no symlink) that
 * `uid` owns, with mode 0700 (0005). The sockets' only guard is this folder, so a negative `uid`
 * (this process cannot tell its user, which no macOS or Linux process sees) refuses it.
 */
export function runtimeDirReason(stat: DirStat, uid: number): string | null {
  if (stat.isSymbolicLink) return "it is a symlink";
  if (!stat.isDirectory) return "it is not a directory";
  if (uid < 0) return "this process cannot tell its user id, so it cannot check the owner";
  if (stat.uid !== uid) return `it is owned by uid ${stat.uid}, not ${uid}`;
  if (stat.mode !== 0o700) return `its mode is ${stat.mode.toString(8).padStart(4, "0")}, not 0700`;
  return null;
}

// Records

/** `<state>/runtime.json`, which clients read to find the socket (0005). */
export interface RuntimeRecord {
  readonly runtimeDir: string;
  readonly socket: string;
  readonly pid: number;
  readonly startTimeMs: number;
  readonly version: string;
}

/** A parsed `runtime.json`; null when it is not a runtime record. */
export function parseRuntimeRecord(value: unknown): RuntimeRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Partial<Record<keyof RuntimeRecord, unknown>>;
  if (
    typeof record.socket !== "string" ||
    !record.socket.startsWith("/") ||
    typeof record.runtimeDir !== "string" ||
    typeof record.pid !== "number" ||
    typeof record.startTimeMs !== "number" ||
    typeof record.version !== "string"
  ) {
    return null;
  }
  return {
    runtimeDir: record.runtimeDir,
    socket: record.socket,
    pid: record.pid,
    startTimeMs: record.startTimeMs,
    version: record.version,
  };
}

/** The content of `dipo.pid` (0005). */
export interface PidRecord {
  readonly pid: number;
  /** Start time as the process probe reads it, ms since the epoch. */
  readonly startTimeMs: number;
  readonly version: string;
  /** The runtime directory in use; null until the holder has chosen it. */
  readonly runtimeDir: string | null;
}

/** A parsed `dipo.pid`; null for damage or another shape. */
export function parsePidRecord(raw: string): PidRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<PidRecord>;
    if (
      typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.startTimeMs === "number" &&
      typeof value.version === "string" &&
      (value.runtimeDir === null || typeof value.runtimeDir === "string")
    ) {
      return {
        pid: value.pid,
        startTimeMs: value.startTimeMs,
        version: value.version,
        runtimeDir: value.runtimeDir,
      };
    }
  } catch {
    // Not JSON: damage. The caller decides.
  }
  return null;
}

export function formatPidRecord(record: PidRecord): string {
  return `${JSON.stringify(record)}\n`;
}

// Process identity: liveness is PID plus start time, never socket reachability (0005). On Linux the
// start time comes from field 22 of `/proc/<pid>/stat`; on macOS from the `kern.proc.pid.<pid>`
// sysctl, the same `struct kinfo_proc` that `ps -o lstart=` reads, and the command line from
// `kern.procargs2` (DIPO-114). Both have whole-second precision, so two readings of the same
// process match within 2 s. A zombie counts as dead.

/** Two readings of one process's start time differ by at most this much. */
export const START_TIME_TOLERANCE_MS = 2000;

/** What the system says about one PID. */
export interface ProcessInfo {
  readonly pid: number;
  /** Start time in milliseconds since the Unix epoch, whole-second precision. */
  readonly startTimeMs: number;
  readonly zombie: boolean;
  /** The command line, arguments joined by spaces: for display, and for checks on its words. */
  readonly command: string;
  /**
   * The arguments as the system keeps them, one string each, so an argument with spaces stays one
   * (DIPO-386). Absent when they cannot be read: a zombie, or a read the system refused.
   */
  readonly argv?: readonly string[];
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

/** What `kern.proc.pid.<pid>` says about a process: its start time, state and name. */
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
 * `argc` arguments, each NUL-terminated, then the environment. Returns the arguments, one string
 * each; null when the buffer is malformed.
 */
export function parseProcArgs(buffer: Uint8Array): string[] | null {
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
  return args.length === argc ? args : null;
}

/**
 * One process from its `kinfo_proc` and, when readable, its arguments. The command follows
 * `ps -o command=`: `<defunct>` for a zombie, `(comm)` when the arguments cannot be read; `argv`
 * is there only when they can.
 */
export function darwinProcessInfo(
  pid: number,
  kinfo: KinfoProc,
  args: readonly string[] | null,
): ProcessInfo {
  const base = { pid, startTimeMs: kinfo.startSeconds * 1000, zombie: kinfo.zombie };
  if (kinfo.zombie) return { ...base, command: "<defunct>" };
  if (args === null) return { ...base, command: `(${kinfo.comm})` };
  return { ...base, command: args.join(" "), argv: args };
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

// <sys/sysctl.h>: CTL_KERN, KERN_PROC with KERN_PROC_PID, KERN_PROCARGS2.
const CTL_KERN = 1;
const KERN_PROC = 14;
const KERN_PROC_PID = 1;
const KERN_PROCARGS2 = 49;

/** The `sysctl` calls the macOS probe makes; each side binds them to libSystem itself. */
export interface Sysctl {
  /** Reads `mib` into a buffer of at most `size` bytes: the return code and the bytes read. */
  read(
    mib: readonly number[],
    size: number,
  ): { readonly code: number; readonly buffer: Uint8Array };
  /** The size `mib` needs; null when the call fails or needs no bytes. */
  size(mib: readonly number[]): number | null;
}

/** One process on macOS through `sysctl`; null when no process has the PID. */
export function darwinProcess(sysctl: Sysctl, pid: number): ProcessInfo | null {
  const raw = sysctl.read([CTL_KERN, KERN_PROC, KERN_PROC_PID, pid], KINFO_PROC_SIZE);
  const kinfo = kinfoOutcome(pid, raw.code, raw.buffer);
  if (kinfo === null) return null;
  let args: string[] | null = null;
  if (!kinfo.zombie) {
    // A zombie has no arguments left. Another user's process, or one outside this process's
    // sandbox, refuses them too, and the command falls back to `(comm)`. Here this probe differs
    // from the setuid `ps`, which could read another user's arguments.
    const mib = [CTL_KERN, KERN_PROCARGS2, pid];
    const size = sysctl.size(mib);
    const read = size === null ? null : sysctl.read(mib, size);
    args = read === null || read.code !== 0 ? null : parseProcArgs(read.buffer);
  }
  return darwinProcessInfo(pid, kinfo, args);
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

/**
 * One process on Linux from `/proc/<pid>/stat`, `/proc/<pid>/cmdline` and `/proc/stat`; null when
 * they do not parse.
 */
export function linuxProcess(
  pid: number,
  stat: string,
  cmdline: string,
  procStat: string,
): ProcessInfo | null {
  const parsed = parseProcStat(stat);
  const bootTime = parseBootTime(procStat);
  if (parsed === null || bootTime === null) return null;
  // Each argument ends in a NUL; a zombie's cmdline is empty.
  const argv = cmdline.split("\0");
  if (argv.at(-1) === "") argv.pop();
  const zombie = parsed.state === "Z";
  return {
    pid,
    startTimeMs: procStartTimeMs(bootTime, parsed.startTicks),
    zombie,
    command: argv.filter(Boolean).join(" "),
    ...(zombie || argv.length === 0 ? {} : { argv }),
  };
}

// The environment of a process dipo starts detached (0005)

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

/**
 * The environment of a process started detached, the daemon or a worker host: the caller's,
 * `PATH` included, without the Bun flag and supervisor variables.
 */
export function detachedEnv(env: Env): Record<string, string> {
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
