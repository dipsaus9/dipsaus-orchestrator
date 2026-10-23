// The daemon logger (0006 decision 13): JSON lines with `ts` (ISO 8601 UTC), `level`, `msg`,
// `component`, and `office` and `run` when known, plus fields. Secret fields (`isSecretKey`) are
// redacted at every level, at any depth. A field named `code` shows error and exit codes such as
// `engine.recovering`, but stays redacted where the contract carries the web bootstrap code under
// that name and whenever its value is not code-shaped (`showsCode`; 0006 amendment of 2026-10-15
// (DIPO-91)). The message and every string of the fields, an error's message and stack included,
// have each value of a `SECRET_PATTERNS` shape and each URL that holds user information replaced
// by `[redacted]` (`redactSecretText`, DIPO-312), so a git error that quotes a credentialed remote
// is logged without the credential. Other secrets inside text are not recognised: secret-bearing
// maps (env, headers) must still never be logged. Fields that carry prompts, worker output or
// command bodies (`DEBUG_ONLY_KEYS`) appear only in `debug` and `trace` lines; in `error`,
// `warn` and `info` lines their value is replaced, at any depth. Time comes from the injected
// clock. Sinks receive finished lines; the daemon writes them to `<logs>/daemon.log` and, in
// foreground, to stderr.

import type { Clock, LogLevel } from "@dipsaus-orchestrator/contract";

import { redactSecretText } from "../context/secrets";

export type LogFields = Readonly<Record<string, unknown>>;

export const LOG_LEVELS: readonly LogLevel[] = ["error", "warn", "info", "debug", "trace"];
export const DEFAULT_LOG_LEVEL: LogLevel = "info";
export const REDACTED = "[redacted]";
/** What a debug-only field shows in an `error`, `warn` or `info` line. */
export const DEBUG_ONLY = "[debug only]";

/**
 * Endings of secret field names (0006 amendment of 2026-10-15 (DIPO-91)): `token`,
 * `session.token`, `sessionToken`, `engineToken`, `engine_token`, `bootstrapCode`, ... Names are
 * compared lowercased with `_`, `-` and `.` removed.
 */
const SECRET_SUFFIXES: readonly string[] = [
  "token",
  "secret",
  "password",
  "passphrase",
  "apikey",
  "bootstrapcode",
  "credential",
  "credentials",
  "privatekey",
  "pat",
  "signature",
];
/** Secret field names compared whole, after the same normalisation. */
const SECRET_NAMES: ReadonlySet<string> = new Set(["authorization", "cookie", "setcookie"]);

/** Whether a field with this name never reaches a log line, at any level and depth. */
export function isSecretKey(key: string): boolean {
  const name = key.toLowerCase().replace(/[-_.]/g, "");
  return SECRET_NAMES.has(name) || SECRET_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * A code-shaped string: letter-only words joined by `.` or `-`, such as `office.refused`,
 * `git.fetchFailed`, `tooOld` or `lockfile-conflict`. A letters-only secret would match, so the
 * web bootstrap code must be generated as lowercase hex or with a prefix that holds a digit (0006
 * amendment of 2026-10-15 (DIPO-91)); that encoding rule, not this pattern, keeps it out of a line.
 */
const CODE_SHAPE = /^[a-z][A-Za-z]*(?:[.-][a-z][A-Za-z]*)*$/;
const CODE_MAX_LENGTH = 64;

/**
 * Whether the `code` field of `holder` may show `value`. The contract carries the single-use web
 * bootstrap code as `code` in the `auth` frame (`kind: "auth"`) and in the `daemon.webBootstrap`
 * result (`{ url, code }`), so a `code` next to `kind: "auth"` or a `url` stays redacted. Anything
 * else shows only when it is a number, a boolean, null or code-shaped; every other value, objects
 * included, stays redacted (0006 amendment of 2026-10-15 (DIPO-91)).
 */
function showsCode(holder: Readonly<Record<string, unknown>>, value: unknown): boolean {
  if (holder["kind"] === "auth" || "url" in holder) return false;
  if (value === null || typeof value === "number" || typeof value === "boolean") return true;
  return typeof value === "string" && value.length <= CODE_MAX_LENGTH && CODE_SHAPE.test(value);
}

/**
 * Field names for prompts, worker output and command bodies, which appear only in `debug` and
 * `trace` lines (0006 decision 13). The guard works by name only and no lint rule checks call
 * sites: later stories that log prompts, worker output or command bodies must put them in a field
 * with one of these names, or they show at every level.
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
 * become `"[cycle]"`. Every string, an error's message and stack included, is scrubbed of
 * credential-shaped values (`redactSecretText`).
 */
export function redact(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
  debugFields: boolean = true,
): unknown {
  if (typeof value === "string") return redactSecretText(value);
  if (typeof value !== "object" || value === null) return value;
  if (value instanceof Error) {
    return {
      name: redactSecretText(value.name),
      message: redactSecretText(value.message),
      stack: value.stack === undefined ? undefined : redactSecretText(value.stack),
    };
  }
  if (seen.has(value)) return "[cycle]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen, debugFields));
  const out: Record<string, unknown> = {};
  const holder = value as Readonly<Record<string, unknown>>;
  for (const [key, inner] of Object.entries(holder)) {
    if (isSecretKey(key)) out[key] = REDACTED;
    else if (key === "code") out[key] = showsCode(holder, inner) ? inner : REDACTED;
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
    msg: redactSecretText(message),
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
