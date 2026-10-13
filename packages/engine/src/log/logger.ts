// The daemon logger (0006 decision 13): JSON lines with `ts` (ISO 8601 UTC), `level`, `msg`,
// `component`, and `office` and `run` when known, plus fields. Fields named `code` or `token` (so
// also `session.token`) are redacted at every level, at any depth. Fields that carry prompts, worker
// output or command bodies (`DEBUG_ONLY_KEYS`) appear only in `debug` and `trace` lines; in
// `error`, `warn` and `info` lines their value is replaced, at any depth. Time comes from the
// injected clock. Sinks receive finished lines; the daemon writes them to `<logs>/daemon.log` and, in
// foreground, to stderr.

import type { Clock, LogLevel } from "@dipsaus-orchestrator/contract";

export type LogFields = Readonly<Record<string, unknown>>;

export const LOG_LEVELS: readonly LogLevel[] = ["error", "warn", "info", "debug", "trace"];
export const DEFAULT_LOG_LEVEL: LogLevel = "info";
export const REDACTED = "[redacted]";
/** What a debug-only field shows in an `error`, `warn` or `info` line. */
export const DEBUG_ONLY = "[debug only]";

/** Field names whose values never reach a log line (0006 decision 13). */
const REDACTED_KEYS = new Set(["code", "token", "session.token"]);

/**
 * Field names for prompts, worker output and command bodies, which appear only in `debug` and
 * `trace` lines (0006 decision 13). Code that logs such content uses one of these names.
 */
export const DEBUG_ONLY_KEYS: ReadonlySet<string> = new Set([
  "prompt",
  "output",
  "stdout",
  "stderr",
  "body",
  "args",
]);

/** Whether a line at `level` may carry debug-only fields. */
function showsDebugFields(level: LogLevel): boolean {
  return level === "debug" || level === "trace";
}

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

export interface Logger {
  error(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  trace(message: string, fields?: LogFields): void;
  /** A logger for another component, office or run, sharing level and sinks. */
  child(context: LogContext): Logger;
  /** Changes the level of this logger and every child (`daemon.setLogLevel`). */
  setLevel(level: LogLevel): void;
  level(): LogLevel;
}

export interface LogContext {
  readonly component?: string;
  readonly office?: string;
  readonly run?: string;
}

/** Receives one finished JSON line without the newline. */
export type LogSink = (line: string) => void;

export interface CreateLoggerOptions {
  readonly clock: Clock;
  readonly sinks: readonly LogSink[];
  readonly level?: LogLevel;
  readonly component: string;
}

/**
 * Replaces redacted fields at any depth, and debug-only fields too unless `debugFields`; cycles
 * become `"[cycle]"`.
 */
export function redact(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
  debugFields: boolean = true,
): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (seen.has(value)) return "[cycle]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen, debugFields));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (REDACTED_KEYS.has(key)) out[key] = REDACTED;
    else if (!debugFields && DEBUG_ONLY_KEYS.has(key)) out[key] = DEBUG_ONLY;
    else out[key] = redact(inner, seen, debugFields);
  }
  return out;
}

/** Builds one log line. Context keys win over fields of the same name. */
export function formatLogLine(
  ts: number,
  level: LogLevel,
  message: string,
  context: LogContext,
  fields: LogFields | undefined,
): string {
  const line: Record<string, unknown> = {
    ts: new Date(ts).toISOString(),
    level,
    msg: message,
    component: context.component ?? "daemon",
  };
  if (context.office !== undefined) line["office"] = context.office;
  if (context.run !== undefined) line["run"] = context.run;
  if (fields !== undefined) {
    const clean = redact(fields, new WeakSet(), showsDebugFields(level)) as Record<string, unknown>;
    for (const [key, value] of Object.entries(clean)) {
      if (!(key in line)) line[key] = value;
    }
  }
  return JSON.stringify(line);
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const state = { level: options.level ?? DEFAULT_LOG_LEVEL };
  return makeLogger(options.clock, options.sinks, state, { component: options.component });
}

function makeLogger(
  clock: Clock,
  sinks: readonly LogSink[],
  state: { level: LogLevel },
  context: LogContext,
): Logger {
  const write = (level: LogLevel, message: string, fields?: LogFields) => {
    if (LOG_LEVELS.indexOf(level) > LOG_LEVELS.indexOf(state.level)) return;
    const line = formatLogLine(clock.now(), level, message, context, fields);
    for (const sink of sinks) {
      try {
        sink(line);
      } catch {
        // A failing sink (full disk, closed stderr) must not stop the daemon.
      }
    }
  };
  return {
    error: (message, fields) => write("error", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    info: (message, fields) => write("info", message, fields),
    debug: (message, fields) => write("debug", message, fields),
    trace: (message, fields) => write("trace", message, fields),
    child: (more) => makeLogger(clock, sinks, state, { ...context, ...more }),
    setLevel: (level) => {
      state.level = level;
    },
    level: () => state.level,
  };
}
