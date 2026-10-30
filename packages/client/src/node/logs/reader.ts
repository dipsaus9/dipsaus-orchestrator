// The log reader behind `dipo daemon logs` (0006 decisions 5 and 13, DIPO-64). It reads
// `<logs>/daemon.log` and its rotated files directly, so it works with the daemon stopped (named
// offline maintenance, 0006 amendment of 2026-10-12), filters the JSON lines by office, run and
// level, and renders them for people. The file names the daemon's log module rotates
// (`daemon.log`, then `daemon.log.1` to `.5`) are the contract's runtime layout (DIPO-320).

import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  cleanText,
  type Clock,
  DAEMON_LOG_FILE,
  DAEMON_LOG_KEEP,
  LogLevel,
  type TimerHandle,
} from "@dipsaus-orchestrator/contract";

export { DAEMON_LOG_FILE, DAEMON_LOG_KEEP } from "@dipsaus-orchestrator/contract";
/** How often `-f` looks for new lines. */
export const FOLLOW_INTERVAL_MS = 250;

/** One parsed log line; `raw` is the line as written. */
export interface LogEntry {
  readonly raw: string;
  readonly ts: string;
  readonly level: LogLevel;
  readonly msg: string;
  readonly component: string;
  readonly office?: string;
  readonly run?: string;
  /** Every other field of the line. */
  readonly fields: Readonly<Record<string, unknown>>;
}

/** `--office`, `--run` and `--level`; `level` keeps that level and the more severe ones. */
export interface LogFilter {
  readonly office?: string;
  readonly run?: string;
  readonly level?: LogLevel;
}

const SEVERITY: readonly LogLevel[] = LogLevel.options;
const KNOWN_KEYS = new Set(["ts", "level", "msg", "component", "office", "run"]);

/** Parses one JSON log line; null for a line that is not one (a torn write, stray output). */
export function parseLogLine(raw: string): LogEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const level = LogLevel.safeParse(record["level"]);
  if (!level.success || typeof record["ts"] !== "string" || typeof record["msg"] !== "string") {
    return null;
  }
  const fields: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(record)) {
    if (!KNOWN_KEYS.has(key)) fields[key] = inner;
  }
  const office = record["office"];
  const run = record["run"];
  return {
    raw,
    ts: record["ts"],
    level: level.data,
    msg: record["msg"],
    component: typeof record["component"] === "string" ? record["component"] : "daemon",
    ...(typeof office === "string" ? { office } : {}),
    ...(typeof run === "string" ? { run } : {}),
    fields,
  };
}

function hasFilter(filter: LogFilter): boolean {
  return filter.office !== undefined || filter.run !== undefined || filter.level !== undefined;
}

/** Whether a line passes the filter. A line that is not JSON passes only an empty filter. */
export function matchesFilter(entry: LogEntry | null, filter: LogFilter): boolean {
  if (entry === null) return !hasFilter(filter);
  if (filter.office !== undefined && entry.office !== filter.office) return false;
  if (filter.run !== undefined && entry.run !== filter.run) return false;
  if (
    filter.level !== undefined &&
    SEVERITY.indexOf(entry.level) > SEVERITY.indexOf(filter.level)
  ) {
    return false;
  }
  return true;
}

function renderValue(raw: unknown): string {
  const value = typeof raw === "string" ? cleanText(raw) : raw;
  if (typeof value === "string" && value !== "" && !/[\s"=]/.test(value)) return value;
  return JSON.stringify(value) ?? String(value);
}

/**
 * Renders a line for people: time, level, component with office and run, message, then the other
 * fields as `key=value`. A line that is not JSON is printed as it is. Either way the text is
 * cleaned of terminal control characters (DIPO-313) and stays on one line.
 */
export function renderLogLine(raw: string, entry: LogEntry | null = parseLogLine(raw)): string {
  return cleanText(renderLogText(raw, entry)).replaceAll("\n", " ");
}

function renderLogText(raw: string, entry: LogEntry | null): string {
  if (entry === null) return raw;
  const where = [
    entry.component,
    ...(entry.office === undefined ? [] : [`office=${entry.office}`]),
    ...(entry.run === undefined ? [] : [`run=${entry.run}`]),
  ].join(" ");
  const fields = Object.entries(entry.fields).map(([key, value]) => `${key}=${renderValue(value)}`);
  return [entry.ts, entry.level.toUpperCase().padEnd(5), `[${where}]`, entry.msg, ...fields].join(
    " ",
  );
}

/** Renders the lines that pass the filter; the rest become nothing. */
export function renderFiltered(lines: readonly string[], filter: LogFilter): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const entry = parseLogLine(raw);
    if (matchesFilter(entry, filter)) out.push(renderLogLine(raw, entry));
  }
  return out;
}

/** The rotated files, oldest first: `daemon.log.5` to `daemon.log.1`. */
export function rotatedLogPaths(logsDir: string): string[] {
  const paths: string[] = [];
  for (let index = DAEMON_LOG_KEEP; index >= 1; index -= 1) {
    paths.push(join(logsDir, `${DAEMON_LOG_FILE}.${index}`));
  }
  return paths;
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Every line of the rotated files, oldest first; missing files are skipped. */
export function readRotatedLines(logsDir: string): string[] {
  const lines: string[] = [];
  for (const path of rotatedLogPaths(logsDir)) {
    const text = readIfPresent(path);
    if (text !== null) lines.push(...splitLines(text));
  }
  return lines;
}

export interface ReadLogsResult {
  /** The lines of every log file, oldest first. */
  readonly lines: readonly string[];
  /** Whether any log file exists. */
  readonly found: boolean;
}

/** Reads `daemon.log.5` to `daemon.log.1`, then `daemon.log`. */
export function readLogs(logsDir: string): ReadLogsResult {
  const lines: string[] = [];
  let found = false;
  for (const path of [...rotatedLogPaths(logsDir), join(logsDir, DAEMON_LOG_FILE)]) {
    const text = readIfPresent(path);
    if (text === null) continue;
    found = true;
    lines.push(...splitLines(text));
  }
  return { lines, found };
}

function inodeOf(path: string): number | null {
  try {
    return statSync(path).ino;
  } catch {
    return null;
  }
}

/** Reads `path` from `offset` to its current end. */
function readFrom(path: string, offset: number): { bytes: Buffer; size: number } | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    if (size <= offset) return { bytes: Buffer.alloc(0), size };
    const bytes = Buffer.alloc(size - offset);
    let read = 0;
    while (read < bytes.byteLength) {
      const n = readSync(fd, bytes, read, bytes.byteLength - read, offset + read);
      if (n === 0) break;
      read += n;
    }
    return { bytes: bytes.subarray(0, read), size: offset + read };
  } finally {
    closeSync(fd);
  }
}

/**
 * Tails `daemon.log` across rotations. Each `poll` returns the complete lines written since the
 * last one. When the daemon has rotated the file, the follower first finishes the old file under
 * its new name (found by inode among `daemon.log.1` to `.5`), then reads every file rotated after
 * it, oldest first, then the new `daemon.log` from its start.
 */
export class LogFollower {
  readonly #path: string;
  readonly #logsDir: string;
  #inode: number | null;
  #offset = 0;
  #partial: Buffer = Buffer.alloc(0);

  /** Starts at the beginning of the current `daemon.log`, or of the first one to appear. */
  constructor(logsDir: string) {
    this.#logsDir = logsDir;
    this.#path = join(logsDir, DAEMON_LOG_FILE);
    this.#inode = inodeOf(this.#path);
  }

  poll(): string[] {
    const lines: string[] = [];
    const current = inodeOf(this.#path);
    if (this.#inode !== null && current !== this.#inode) {
      // Rotated (or removed): finish the old file wherever it went, read every file rotated after
      // it in full, oldest first, then start the new one.
      const newestFirst = rotatedLogPaths(this.#logsDir).toReversed();
      const moved = newestFirst.findIndex((path) => inodeOf(path) === this.#inode);
      for (let index = moved; index >= 0; index -= 1) {
        const path = newestFirst[index];
        if (path !== undefined) this.#take(path, lines);
        if (this.#partial.byteLength > 0) lines.push(this.#partial.toString("utf8"));
        this.#partial = Buffer.alloc(0);
        this.#offset = 0;
      }
      this.#partial = Buffer.alloc(0);
      this.#inode = current;
      this.#offset = 0;
    } else if (this.#inode === null) {
      this.#inode = current;
      this.#offset = 0;
    }
    if (this.#inode !== null) this.#take(this.#path, lines);
    return lines;
  }

  #take(path: string, lines: string[]): void {
    const chunk = readFrom(path, this.#offset);
    if (chunk === null) return;
    if (chunk.size < this.#offset) {
      // Truncated in place: start over.
      this.#offset = 0;
      this.#partial = Buffer.alloc(0);
      this.#take(path, lines);
      return;
    }
    this.#offset = chunk.size;
    let data = Buffer.concat([this.#partial, chunk.bytes]);
    let newline = data.indexOf(0x0a);
    while (newline >= 0) {
      lines.push(data.subarray(0, newline).toString("utf8"));
      data = data.subarray(newline + 1);
      newline = data.indexOf(0x0a);
    }
    this.#partial = Buffer.from(data);
  }
}

export interface FollowLogsOptions {
  readonly logsDir: string;
  readonly filter: LogFilter;
  readonly clock: Clock;
  /** Receives each rendered line that passes the filter. */
  readonly write: (line: string) => void;
  /** Ends the follow; without it the follow runs until the process ends. */
  readonly signal?: AbortSignal;
  readonly intervalMs?: number;
}

/**
 * `dipo daemon logs -f`: prints the rotated files and the current `daemon.log`, then keeps
 * printing new lines, across rotations, until `signal` aborts.
 */
export function followLogs(options: FollowLogsOptions): Promise<void> {
  const { clock, filter, write } = options;
  const interval = options.intervalMs ?? FOLLOW_INTERVAL_MS;
  const follower = new LogFollower(options.logsDir);
  for (const line of renderFiltered(readRotatedLines(options.logsDir), filter)) write(line);
  return new Promise<void>((resolve, reject) => {
    let timer: TimerHandle | null = null;
    const finish = () => {
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
      resolve();
    };
    const tick = () => {
      timer = null;
      if (options.signal?.aborted === true) return finish();
      try {
        for (const line of renderFiltered(follower.poll(), filter)) write(line);
      } catch (error) {
        options.signal?.removeEventListener("abort", finish);
        reject(error);
        return;
      }
      timer = clock.setTimeout(tick, interval);
    };
    options.signal?.addEventListener("abort", finish, { once: true });
    tick();
  });
}
