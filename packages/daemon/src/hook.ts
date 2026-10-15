// The hidden form `dipo hook <event> [--wait <seconds> | --nudge]` (0008 section 5; 0004 and 0006
// amendments of 2026-10-12, DIPO-59). A worker's run settings file registers it as a command hook
// with the binary's own path, so it needs no `PATH`. It reads the hook payload on stdin and relays
// it to the worker host named by `DIPO_HOST_SOCKET` over the host protocol's versioned handshake.
// It prints only what the host answers for a waiting call (a decision or a nudge the adapter
// encoded), never anything else, exits 0 and is silent on every failure: no socket, a refused
// version, no answer. A call without `--wait` ends within 2 s; with `--nudge` it waits for the
// engine's 0014 section 8 nudge only as long as that limit allows (DIPO-60); with `--wait` it
// waits at most that long plus a grace.

import { relayHookPayload } from "@dipsaus-orchestrator/engine";

import { type DaemonIo, readProcessInput } from "./io";

/** How long a call that does not wait may take, from start to exit. */
export const HOOK_DEADLINE_MS = 1_800;
/** How long the payload may take to arrive on stdin. */
export const HOOK_STDIN_MS = 1_000;
/** The largest `--wait` accepted: two hours (the engine waits at most one, plus a margin). */
export const MAX_HOOK_WAIT_SECONDS = 7_200;
/** The largest payload read from stdin (1 MiB); a larger one is not relayed. */
export const MAX_HOOK_STDIN = 1024 * 1024;
/**
 * A `--nudge` call asks the host to hold it for what is left of `HOOK_DEADLINE_MS` minus this, and
 * waits this much longer for the host's answer, so the host's own empty answer still arrives.
 */
export const NUDGE_REPLY_MARGIN_MS = 300;

const EVENT_NAME = /^[A-Za-z][A-Za-z0-9]*$/;

export interface HookArgs {
  readonly event: string;
  /** Milliseconds the call may wait for the engine's reply; absent for a call that does not wait. */
  readonly waitMs?: number;
  /** True for a call that waits for a nudge within `HOOK_DEADLINE_MS` (DIPO-60). */
  readonly nudge?: true;
}

/** The longest string field a call that does not wait keeps; a longer one is cut to this. */
export const MAX_KEPT_STRING = 1024;

/** The `tool_input` keys a call that does not wait keeps: the file a write tool wrote (DIPO-60). */
export const KEPT_INPUT_KEYS: readonly string[] = ["file_path", "notebook_path"];

function scalars(value: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (typeof field === "number" || typeof field === "boolean" || field === null)
      kept[key] = field;
    else if (typeof field === "string") kept[key] = field.slice(0, MAX_KEPT_STRING);
  }
  return kept;
}

/**
 * The payload as relayed. A call that waits (a permission request) keeps it whole, since its input
 * is what the maintainer is asked about. Any other call keeps only its top-level numbers, booleans
 * and strings, each string cut to `MAX_KEPT_STRING` characters (so a `StopFailure` error survives),
 * and of `tool_input` only the written file's path (`KEPT_INPUT_KEYS`, for the scope and context
 * nudges): other tool inputs and responses (`PostToolUse` carries the whole tool result) are
 * dropped, so the event file stays small. A payload that is not a JSON object is relayed as given.
 */
export function trimPayload(payload: string, waits: boolean): string {
  if (waits) return payload;
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return payload;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return payload;
  const kept = scalars(value as Record<string, unknown>);
  const input = (value as Record<string, unknown>)["tool_input"];
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const paths = Object.fromEntries(
      Object.entries(scalars(input as Record<string, unknown>)).filter(
        ([key, field]) => KEPT_INPUT_KEYS.includes(key) && typeof field === "string",
      ),
    );
    if (Object.keys(paths).length > 0) kept["tool_input"] = paths;
  }
  return JSON.stringify(kept);
}

/** `<event> [--wait <seconds> | --nudge]`; null when the arguments do not match. */
export function parseHookArgs(args: readonly string[]): HookArgs | null {
  const [event, flag, seconds, ...rest] = args;
  if (event === undefined || !EVENT_NAME.test(event) || rest.length > 0) return null;
  if (flag === undefined) return { event };
  if (flag === "--nudge") return seconds === undefined ? { event, nudge: true } : null;
  if (flag !== "--wait" || seconds === undefined || !/^[1-9]\d*$/.test(seconds)) return null;
  const value = Number(seconds);
  if (value > MAX_HOOK_WAIT_SECONDS) return null;
  return { event, waitMs: value * 1000 };
}

/** Runs the relay; always resolves to 0, so a failure never blocks or breaks the worker. */
export async function runHookForm(args: readonly string[], io: DaemonIo): Promise<number> {
  try {
    const parsed = parseHookArgs(args);
    const socketPath = io.env["DIPO_HOST_SOCKET"];
    const runId = io.env["DIPO_RUN"];
    if (parsed === null || !socketPath?.startsWith("/") || runId === undefined || runId === "") {
      return 0;
    }
    const started = io.clock.now();
    const readInput = io.readInput ?? ((max, ms) => readProcessInput(io.clock, max, ms));
    const payload = await readInput(MAX_HOOK_STDIN, HOOK_STDIN_MS);
    if (payload === null || payload.trim() === "") return 0;
    const left = HOOK_DEADLINE_MS - (io.clock.now() - started);
    if (left <= 0) return 0;
    const nudgeWaitMs = left - NUDGE_REPLY_MARGIN_MS;
    if (parsed.nudge === true && nudgeWaitMs <= 0) return 0;
    const relay = relayHookPayload({
      socketPath,
      runId,
      payload: trimPayload(payload, parsed.waitMs !== undefined),
      clock: io.clock,
      timeoutMs: left,
      ...(parsed.waitMs === undefined ? {} : { waitMs: parsed.waitMs }),
      ...(parsed.nudge === true ? { waitMs: nudgeWaitMs, graceMs: NUDGE_REPLY_MARGIN_MS } : {}),
    });
    const output = parsed.nudge === true ? await withinDeadline(relay, left, io) : await relay;
    if (output !== null && output !== "")
      (io.write ?? ((text) => process.stdout.write(text)))(output);
  } catch {
    // Silent on every failure (0008 section 5): no output means no decision.
  }
  return 0;
}

/** The relay's answer, or null once `ms` passed: a nudge call never outlives `HOOK_DEADLINE_MS`. */
function withinDeadline(
  relay: Promise<string | null>,
  ms: number,
  io: DaemonIo,
): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = io.clock.setTimeout(() => resolve(null), ms);
    void relay.then(
      (output) => {
        io.clock.clearTimeout(timer);
        resolve(output);
      },
      () => {
        io.clock.clearTimeout(timer);
        resolve(null);
      },
    );
  });
}
