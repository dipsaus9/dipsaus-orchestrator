// Process identity for the client's `lifecycle` module (0006 decisions 2 and 6): liveness is PID
// plus start time, never socket reachability. `client` may not import `engine` (0004), so the
// rules of `engine/src/platform/process.ts` (DIPO-23) are repeated here: Linux reads field 22 of
// `/proc/<pid>/stat`, macOS `LC_ALL=C TZ=UTC ps -o lstart=`, both to the second, so two readings
// match within 2 s, and a zombie counts as dead. `test/lifecycle-parity` runs both copies on the
// same inputs.

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

/** Parses one line of `ps -o stat= -o lstart= -o command=` under `LC_ALL=C TZ=UTC`. */
export function parsePsLine(pid: number, line: string): ProcessInfo | null {
  const fields = line.trim().split(/\s+/);
  if (fields.length < 6) return null;
  const [stat = "", ...rest] = fields;
  const startTimeMs = parseLstart(rest.slice(0, 5).join(" "));
  if (startTimeMs === null) return null;
  return { pid, startTimeMs, zombie: stat.startsWith("Z"), command: rest.slice(5).join(" ") };
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

async function probeDarwin(pid: number): Promise<ProcessInfo | null> {
  const child = Bun.spawn({
    cmd: ["/bin/ps", "-o", "stat=", "-o", "lstart=", "-o", "command=", "-p", String(pid)],
    env: { LC_ALL: "C", TZ: "UTC", PATH: "/usr/bin:/bin" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) return null;
  const line = text.split("\n").find((l) => l.trim() !== "");
  return line === undefined ? null : parsePsLine(pid, line);
}

/** The system probe for this platform (macOS or Linux, 0004). */
export function systemProcessProbe(platform: string = process.platform): ProcessProbe {
  const read = platform === "linux" ? probeLinux : probeDarwin;
  return async (pid) => (pidExists(pid) ? read(pid) : null);
}
