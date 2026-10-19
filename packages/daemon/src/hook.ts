// The hidden form `dipo hook <event> [--wait <seconds> | --nudge]` (0008 section 5; 0004 and 0006
// amendments of 2026-10-12, DIPO-59). A worker's run settings file registers it as a command hook
// with the binary's own path, so it needs no `PATH`. It reads the hook payload on stdin and relays
// it to the worker host named by `DIPO_HOST_SOCKET` over the host protocol's versioned handshake.
// It prints only what the host answers for a waiting call (a decision or a nudge the adapter
// encoded), never anything else, exits 0 and is silent on every failure: no socket, a refused
// version, no answer. A call without `--wait` ends within 2 s; with `--nudge` it waits for the
// engine's 0014 section 8 nudge only as long as that limit allows (DIPO-60); with `--wait` it
// waits at most that long plus a grace. A `--gate` call (the `PreToolUse` check of a web tool,
// 0020 section 11b, DIPO-164) waits like a nudge call but fails closed: only the engine's marker
// that carries no decision lets the call proceed, as empty output and exit 0, so Claude's own
// permission rules decide it; every failure, an empty answer and no answer within the limit print
// Claude's deny, and a gate that cannot print exits 2, so the call never proceeds unchecked.

import {
  claudeGateOutput,
  encodeClaudeOp,
  refusedTempVariable,
  relayHookPayload,
  tempVariableRefusal,
} from "@dipsaus-orchestrator/engine";

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

/** Told to the worker when a gate call got no answer within `HOOK_DEADLINE_MS`. */
export const GATE_NO_ANSWER_REASON =
  "dipo could not check this web call in time, so it was refused; try again.";

/** Claude's `PreToolUse` deny, as the adapter encodes the engine's refusal (`toolGate`). */
export function gateDenyOutput(reason: string): string {
  const [op] = encodeClaudeOp({ kind: "toolGate", reply: { hook: 0, decision: "deny", reason } });
  return op !== undefined && "output" in op ? op.output : "";
}

const EVENT_NAME = /^[A-Za-z][A-Za-z0-9]*$/;

export interface HookArgs {
  readonly event: string;
  /** Milliseconds the call may wait for the engine's reply; absent for a call that does not wait. */
  readonly waitMs?: number;
  /** True for a call that waits for a nudge within `HOOK_DEADLINE_MS` (DIPO-60). */
  readonly nudge?: true;
  /** True for a fail-closed call that waits within `HOOK_DEADLINE_MS` for the engine's check. */
  readonly gate?: true;
  /** True for the Bash check, decided in this process without the worker host (DIPO-194). */
  readonly bash?: true;
}

/** The longest string field a call that does not wait keeps; a longer one is cut to this. */
export const MAX_KEPT_STRING = 1024;

/** The `tool_input` keys a `--gate` call keeps whole: a web tool's URL or query. */
export const GATE_INPUT_KEYS: readonly string[] = ["url", "query"];

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
 * dropped, so the event file stays small. A `gate` call also keeps the `url` or `query` of
 * `tool_input` whole, never cut, since the engine checks all of it. A payload that is not a JSON
 * object is relayed as given.
 */
export function trimPayload(payload: string, waits: boolean, gate = false): string {
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
    if (gate) {
      for (const key of GATE_INPUT_KEYS) {
        const field = (input as Record<string, unknown>)[key];
        if (typeof field === "string") paths[key] = field;
      }
    }
    if (Object.keys(paths).length > 0) kept["tool_input"] = paths;
  }
  return JSON.stringify(kept);
}

/** `<event> [--wait <seconds> | --nudge | --gate | --bash]`; null when the arguments do not match. */
export function parseHookArgs(args: readonly string[]): HookArgs | null {
  const [event, flag, seconds, ...rest] = args;
  if (event === undefined || !EVENT_NAME.test(event) || rest.length > 0) return null;
  if (flag === undefined) return { event };
  if (flag === "--nudge") return seconds === undefined ? { event, nudge: true } : null;
  if (flag === "--gate") return seconds === undefined ? { event, gate: true } : null;
  if (flag === "--bash") return seconds === undefined ? { event, bash: true } : null;
  if (flag !== "--wait" || seconds === undefined || !/^[1-9]\d*$/.test(seconds)) return null;
  const value = Number(seconds);
  if (value > MAX_HOOK_WAIT_SECONDS) return null;
  return { event, waitMs: value * 1000 };
}

/**
 * Runs the relay. Resolves to 0, so a failure never blocks or breaks the worker, except for a gate
 * call that could not print its decision (see `runGate`).
 */
export async function runHookForm(
  args: readonly string[],
  io: DaemonIo,
  bashCheck: (command: string) => string | null = refusedTempVariable,
): Promise<number> {
  const parsed = parseHookArgs(args);
  const write = io.write ?? ((text: string) => process.stdout.write(text));
  if (parsed?.bash === true) return runBash(io, write, bashCheck);
  // A gate call fails closed even when its arguments do not parse.
  if (parsed?.gate === true || args.includes("--gate")) return runGate(parsed, io, write);
  let output: string | null = null;
  try {
    output = await relayCall(parsed, io);
  } catch {
    // Silent on every failure (0008 section 5): no output means no decision.
  }
  if (output !== null && output !== "") {
    try {
      write(output);
    } catch {
      // The worker sees no output either way.
    }
  }
  return 0;
}

/**
 * A `--bash` call (DIPO-194; 0008 amendment of 2026-10-19): decides the command in this process,
 * never contacting the worker host. A command that sets or clears DIPO_TMP or TMPDIR prints
 * Claude's deny with the reason; anything else, a payload that does not parse and a check that
 * throws print nothing. It always exits 0 (fails open), so a broken check never blocks Bash.
 */
async function runBash(
  io: DaemonIo,
  write: (text: string) => void,
  check: (command: string) => string | null,
): Promise<number> {
  try {
    const readInput = io.readInput ?? ((max, ms) => readProcessInput(io.clock, max, ms));
    const payload = await readInput(MAX_HOOK_STDIN, HOOK_STDIN_MS);
    if (payload === null) return 0;
    const input = (JSON.parse(payload) as { tool_input?: { command?: unknown } } | null)
      ?.tool_input;
    const command = input?.command;
    if (typeof command !== "string") return 0;
    const variable = check(command);
    if (variable !== null) write(gateDenyOutput(tempVariableRefusal(variable)));
  } catch {
    // Fails open: no output means no decision.
  }
  return 0;
}

/** Told to the worker on stderr when a gate call could not print its decision (exit 2). */
export const GATE_FAILED_REASON = "dipo could not check this web call, so it was refused.";

/**
 * A `--gate` call (0020 section 11b): prints nothing for the engine's marker that carries no
 * decision (Claude's permission rules then decide the call), the engine's deny as it is, and a deny
 * for anything else: no answer within the limit, the worker host's empty answer (no engine
 * watching, the wait passed, the host stopped), an explicit allow or any other text. When a deny
 * cannot be printed, it exits 2 with the reason on stderr, which blocks a `PreToolUse` call (hooks
 * reference, exit code 2).
 */
async function runGate(
  parsed: HookArgs | null,
  io: DaemonIo,
  write: (text: string) => void,
): Promise<number> {
  let answer: string | null = null;
  try {
    answer = parsed?.gate === true ? await relayCall(parsed, io) : null;
  } catch {
    answer = null;
  }
  try {
    const output = claudeGateOutput(answer, GATE_NO_ANSWER_REASON);
    // Empty for the engine's pass: the call goes on to Claude's permission rules.
    if (output !== "") write(output);
    return 0;
  } catch {
    try {
      io.writeError(GATE_FAILED_REASON);
    } catch {
      // Exit 2 blocks the call without a reason too.
    }
    return 2;
  }
}

/** The relay's output for one call, or null when there is none. */
async function relayCall(parsed: HookArgs | null, io: DaemonIo): Promise<string | null> {
  const socketPath = io.env["DIPO_HOST_SOCKET"];
  const runId = io.env["DIPO_RUN"];
  if (parsed === null || !socketPath?.startsWith("/") || runId === undefined || runId === "") {
    return null;
  }
  const started = io.clock.now();
  const readInput = io.readInput ?? ((max, ms) => readProcessInput(io.clock, max, ms));
  const payload = await readInput(MAX_HOOK_STDIN, HOOK_STDIN_MS);
  if (payload === null || payload.trim() === "") return null;
  const left = HOOK_DEADLINE_MS - (io.clock.now() - started);
  if (left <= 0) return null;
  const nudgeWaitMs = left - NUDGE_REPLY_MARGIN_MS;
  const bounded = parsed.nudge === true || parsed.gate === true;
  if (bounded && nudgeWaitMs <= 0) return null;
  const relay = relayHookPayload({
    socketPath,
    runId,
    payload: trimPayload(payload, parsed.waitMs !== undefined, parsed.gate === true),
    clock: io.clock,
    timeoutMs: left,
    ...(parsed.waitMs === undefined ? {} : { waitMs: parsed.waitMs }),
    ...(bounded ? { waitMs: nudgeWaitMs, graceMs: NUDGE_REPLY_MARGIN_MS } : {}),
  });
  return bounded ? await withinDeadline(relay, left, io) : await relay;
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
