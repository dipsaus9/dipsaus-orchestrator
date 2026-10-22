// One verify command in the worker's box (0021 section 9, DIPO-274): dipo runs the office's verify
// command in the box's `/work` through the box interface's exec, without AI. No web route is given
// to verify: the command gets no proxy settings.
//
// A green verify in the box is the worker's feedback loop, not the gate: the worker is root in its
// box and can change any program verify runs. The gate is CI's required checks and the reviewer.
//
// - The command runs under a small wrapper dipo writes (`boxVerifyCommand`): it records its own
//   pid in `BOX_VERIFY_PID_FILE` and becomes `timeout`, where the box has it. GNU `timeout` makes
//   itself a process group leader, so that pid names the verify's whole process group. Its own
//   limit is dipo's deadline plus `BOX_VERIFY_GRACE_SECONDS`: a second layer inside the box.
// - dipo's deadline decides. Past it, dipo kills the exec client, and since a killed exec client
//   leaves its process running in the box (DIPO-265 real-box run of 2026-10-21), it then ends the
//   command inside the box: `boxKillCommand` kills the process group the pid file names and
//   waits until the process is gone. When that does not work, dipo stops the box, which ends every
//   process in it, the worker's session included (`BoxCommandEnd`).
// - The output is untrusted text from the box: cleaned with the door's `cleanDoorText` line by
//   line, at most `BOX_VERIFY_OUTPUT_MAX` bytes go to `onOutput`, and the tail kept for the
//   feedback is cut to the same size.
// - The pid file is written in the box, which the worker controls; dipo never reads it on the Mac.
//   A wrong pid ends at most a process of the worker's own box.

import type { ChildExit, Clock, TimerHandle } from "@dipsaus-orchestrator/contract";

import type { BaseVerifyFacts } from "../prompts/base-verify";
import { failingTests, outputEnd, plainText } from "../worktree/base-verify";
import { BOX_DIPO_DIR, BOX_WORKDIR } from "./code";
import { cleanDoorText } from "./door";
import type { BoxPort } from "./port";

/** dipo's folder for verify in a box. */
export const BOX_VERIFY_DIR = `${BOX_DIPO_DIR}/verify`;
/** The pid of the running verify command, written by the wrapper in the box. */
export const BOX_VERIFY_PID_FILE = `${BOX_VERIFY_DIR}/pid`;
/** The most output bytes passed on live, and the most kept as the tail. */
export const BOX_VERIFY_OUTPUT_MAX = 4 * 1024 * 1024;
/** A line longer than this is passed on without waiting for its end. */
export const BOX_VERIFY_LINE_MAX = 64 * 1024;
/** How long after dipo's deadline the box's own `timeout` ends the command. */
export const BOX_VERIFY_GRACE_SECONDS = 30;
/** How long `timeout` in the box waits after its signal before it kills. */
export const BOX_VERIFY_KILL_AFTER_SECONDS = 10;
/** The deadline of the kill in the box. */
export const BOX_VERIFY_KILL_TIMEOUT_MS = 30_000;
/** How long the kill in the box waits for the process to be gone. */
export const BOX_VERIFY_KILL_WAIT_SECONDS = 10;
/** How long the output streams may stay open after the exec client was killed. */
export const BOX_VERIFY_DRAIN_MS = 5_000;

type Log = (message: string, fields: Readonly<Record<string, unknown>>) => void;

/**
 * The wrapper that runs `command` in the box: its pid recorded in `BOX_VERIFY_PID_FILE`, then
 * `timeout` (as a process group leader) for `seconds` where the box has it, else the command.
 */
export function boxVerifyCommand(
  command: readonly [string, ...string[]],
  seconds: number,
): [string, ...string[]] {
  const limit = Math.max(1, Math.ceil(seconds));
  return [
    "/bin/sh",
    "-c",
    `{ mkdir -p '${BOX_VERIFY_DIR}' && rm -f '${BOX_VERIFY_PID_FILE}' && echo "$$" > '${BOX_VERIFY_PID_FILE}'; } 2>/dev/null
if command -v timeout >/dev/null 2>&1; then exec timeout -k ${BOX_VERIFY_KILL_AFTER_SECONDS} ${limit} "$@"; fi
exec "$@"`,
    "dipo-verify",
    ...command,
  ];
}

/**
 * The kill in the box: the process group the pid file names (the process alone when it leads
 * none) gets SIGKILL, then the command waits up to `BOX_VERIFY_KILL_WAIT_SECONDS` for the process
 * to be gone. Exit 0 when it is gone, 1 when it still runs, 3 when there is no usable pid: none, not
 * digits, init, one with a leading zero, or one of no running process (stale or forged). dipo then
 * stops the box.
 */
export function boxKillCommand(): [string, ...string[]] {
  return [
    "/bin/sh",
    "-c",
    `pid=$(cat '${BOX_VERIFY_PID_FILE}' 2>/dev/null) || exit 3
case "$pid" in ''|0*|1|*[!0-9]*) exit 3 ;; esac
[ -d "/proc/$pid" ] || exit 3
kill -s KILL -- "-$pid" 2>/dev/null || kill -s KILL "$pid" 2>/dev/null
i=0
while [ -e "/proc/$pid/status" ] && ! grep -q '^State:[[:space:]]*[ZX]' "/proc/$pid/status" 2>/dev/null; do
  if [ "$i" -ge ${BOX_VERIFY_KILL_WAIT_SECONDS} ]; then exit 1; fi
  sleep 1
  i=$((i + 1))
done
exit 0`,
  ];
}

export interface BoxCommandDeps {
  readonly boxes: Pick<BoxPort, "execLive" | "stop">;
  readonly clock: Clock;
  readonly warn?: Log;
}

export interface BoxCommandRequest {
  readonly box: string;
  readonly command: readonly [string, ...string[]];
  /** The command's environment, set in the box; nothing of the Mac's. */
  readonly env: Readonly<Record<string, string>>;
  /** dipo's deadline. */
  readonly timeoutMs: number;
  /** Each cleaned piece of output as it arrives, at most `maxOutputBytes` in all. */
  readonly onOutput?: (text: string) => void;
  readonly maxOutputBytes?: number;
}

/**
 * How a command past dipo's deadline was ended in the box: its process group killed there, the
 * box stopped (which ends the worker too), or neither worked.
 */
export type BoxCommandEnd = "killed" | "stopped" | "failed";

export interface BoxCommandResult {
  /** The command's exit code; null when dipo ended it. */
  readonly code: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  /** The output's cleaned tail, stdout and stderr as they arrived. */
  readonly output: string;
  /** True when the head of the output was dropped. */
  readonly truncated: boolean;
  /** Set when the command passed the deadline. */
  readonly ended: BoxCommandEnd | null;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** The cleaned output of one command: passed on live up to the cap, and its tail kept. */
class BoxOutput {
  readonly #max: number;
  readonly #onOutput: ((text: string) => void) | undefined;
  #passed = 0;
  #cut = false;
  #tail: string[] = [];
  #tailBytes = 0;
  truncated = false;

  constructor(max: number, onOutput: ((text: string) => void) | undefined) {
    this.#max = max;
    this.#onOutput = onOutput;
  }

  add(raw: string): void {
    const text = cleanDoorText(raw);
    if (text === "") return;
    const bytes = byteLength(text);
    if (!this.#cut) {
      if (this.#passed + bytes <= this.#max) {
        this.#passed += bytes;
        this.#onOutput?.(text);
      } else {
        this.#cut = true;
        this.#onOutput?.(
          `\n[dipo: the output passed ${this.#max} bytes; the rest is not shown, only its last ${this.#max} bytes are kept]\n`,
        );
      }
    }
    this.#tail.push(text);
    this.#tailBytes += bytes;
    if (this.#tailBytes > 2 * this.#max) this.#compact();
  }

  #compact(): void {
    if (this.#tailBytes <= this.#max) return;
    this.truncated = true;
    const bytes = Buffer.from(this.#tail.join(""), "utf8");
    const kept = bytes
      .subarray(bytes.length - this.#max)
      .toString("utf8")
      .toWellFormed();
    this.#tail = [kept];
    this.#tailBytes = byteLength(kept);
  }

  get tail(): string {
    this.#compact();
    return this.#tail.join("");
  }
}

/** One output stream, passed on whole lines at a time so cleaning sees whole escape sequences. */
async function readLines(
  stream: ReadableStream<Uint8Array>,
  output: BoxOutput,
  cancels: (() => void)[],
): Promise<void> {
  const reader = stream.getReader();
  cancels.push(() => {
    reader.cancel().catch(() => {});
  });
  const decoder = new TextDecoder();
  let pending = "";
  const flush = (all: boolean) => {
    const end = all ? pending.length : pending.lastIndexOf("\n") + 1;
    if (end > 0) {
      output.add(pending.slice(0, end));
      pending = pending.slice(end);
    }
    if (pending.length > BOX_VERIFY_LINE_MAX) {
      output.add(pending);
      pending = "";
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      flush(false);
    }
  } catch {
    // A stream cancelled after the deadline, or one that broke: what arrived is kept.
  }
  pending += decoder.decode();
  flush(true);
}

/**
 * Runs `command` in a running box to its end within dipo's deadline (see the file comment).
 * Throws only when the exec cannot start.
 */
export async function runBoxCommand(
  deps: BoxCommandDeps,
  request: BoxCommandRequest,
): Promise<BoxCommandResult> {
  const child = deps.boxes.execLive(
    request.box,
    boxVerifyCommand(request.command, request.timeoutMs / 1000 + BOX_VERIFY_GRACE_SECONDS),
    { cwd: BOX_WORKDIR, env: request.env },
  );
  child.stdin.end();
  const output = new BoxOutput(request.maxOutputBytes ?? BOX_VERIFY_OUTPUT_MAX, request.onOutput);
  const cancels: (() => void)[] = [];
  let timedOut = false;
  let drain: TimerHandle | undefined;
  const timer = deps.clock.setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
    // The client is gone; streams it left open are closed after a short drain.
    drain = deps.clock.setTimeout(() => {
      for (const cancel of cancels) cancel();
    }, BOX_VERIFY_DRAIN_MS);
  }, request.timeoutMs);
  let exit: ChildExit;
  try {
    [, , exit] = await Promise.all([
      readLines(child.stdout, output, cancels),
      readLines(child.stderr, output, cancels),
      child.exited,
    ]);
  } finally {
    deps.clock.clearTimeout(timer);
    if (drain !== undefined) deps.clock.clearTimeout(drain);
  }
  const ended = timedOut ? await endInBox(deps, request.box) : null;
  return {
    code: timedOut ? null : exit.code,
    signal: timedOut ? null : exit.signal,
    timedOut,
    output: output.tail,
    truncated: output.truncated,
    ended,
  };
}

/** Ends the timed-out command inside the box: its process group killed, else the box stopped. */
async function endInBox(deps: BoxCommandDeps, box: string): Promise<BoxCommandEnd> {
  try {
    const code = await boundedExec(deps, box, boxKillCommand(), BOX_VERIFY_KILL_TIMEOUT_MS);
    if (code === 0) return "killed";
    deps.warn?.("the timed-out verify could not be killed inside the box; stopping the box", {
      box,
      code,
    });
  } catch (error) {
    deps.warn?.("the kill of the timed-out verify failed; stopping the box", {
      box,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    await deps.boxes.stop(box);
    return "stopped";
  } catch (error) {
    deps.warn?.("the box of a timed-out verify could not be stopped", {
      box,
      reason: error instanceof Error ? error.message : String(error),
    });
    return "failed";
  }
}

/** Runs a fixed command of dipo's in the box and returns its exit code, within `timeoutMs`. */
async function boundedExec(
  deps: BoxCommandDeps,
  box: string,
  command: readonly [string, ...string[]],
  timeoutMs: number,
): Promise<number | null> {
  const child = deps.boxes.execLive(box, command);
  child.stdin.end();
  // Drained so the command never blocks on its output; nothing of it is kept.
  child.stdout.pipeTo(new WritableStream()).catch(() => {});
  child.stderr.pipeTo(new WritableStream()).catch(() => {});
  let timer: TimerHandle | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = deps.clock.setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("the kill in the box passed its deadline."));
    }, timeoutMs);
  });
  deadline.catch(() => {});
  try {
    return (await Promise.race([child.exited, deadline])).code;
  } finally {
    if (timer !== undefined) deps.clock.clearTimeout(timer);
  }
}

// ---- the base in the box and the verdict (DIPO-294) ---------------------------------------------
//
// Before the box worker starts, the office's verify runs once at the story's start commit in the
// story's own box (same image, command and environment as the verify at done), and its failing
// tests are stored keyed by start commit, image and verify configuration (`boxBaseVerifyOf`). A
// box verify at done then passes when every failing test it names also failed there
// (`boxVerifyVerdict`); a failure the box itself causes, such as a test that needs git, does not
// count against the story, while any new failure still does. CI on the PR runs the full suite.

/** The most new failing test names a verdict note lists; the rest are counted. */
export const BOX_VERDICT_MAX_NAMES = 20;

/** The exit code of a test runner whose only failures are failing tests. */
export const TEST_FAILURE_EXIT = 1;

/** What a failed command in the box counts as. */
export type BoxVerifyVerdict =
  /** Every failing test also fails on the base in the box: the command counts as passed. */
  | { readonly counts: false; readonly baseFailures: readonly string[] }
  /** The failure counts against the story; `note` says why, for the worker's feedback. */
  | { readonly counts: true; readonly note: string | null };

/** The test runner's own count of errors outside a named test (bun's `N error` summary line). */
function runnerErrors(output: string): number {
  let errors = 0;
  for (const line of plainText(output).split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+errors?\s*$/.exec(line);
    if (match !== null) errors = Math.max(errors, Number(match[1]));
    if (/^#\s*Unhandled error/i.test(line.trim())) errors = Math.max(errors, 1);
  }
  return errors;
}

function namesNote(names: readonly string[]): string {
  const shown = names.slice(0, BOX_VERDICT_MAX_NAMES).map((name) => `- ${name}`);
  const rest = names.length - shown.length;
  if (rest > 0) shown.push(`[dipo: ${rest} more new failing tests are not listed.]`);
  return shown.join("\n");
}

/**
 * Pure: what one failed verify command in the box counts as, against the base result measured in
 * the box. It passes only when it exited with the test runner's failure code, named at least one
 * failing test, reported no error outside a test, and every test it names also failed on the base.
 * Anything else counts: a new failing test, a failure without a test name (a lint, format or
 * typecheck failure, a crash), a timeout or a kill, and an unknown base.
 */
export function boxVerifyVerdict(input: {
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly output: string;
  readonly base: BaseVerifyFacts;
}): BoxVerifyVerdict {
  if (input.timedOut) return { counts: true, note: null };
  if (input.code === null) {
    return { counts: true, note: "[dipo: verify was ended by a signal, so the failure counts.]" };
  }
  if (input.base.kind === "unknown") {
    return {
      counts: true,
      note: `[dipo: the verify result of the start commit in this box is not known (${input.base.reason}), so every failure counts.]`,
    };
  }
  const failing = failingTests(input.output);
  if (failing.length === 0) {
    return {
      counts: true,
      note: "[dipo: verify failed without a failing test name dipo can read (for example a lint, format or typecheck failure, or a crash), so the failure counts.]",
    };
  }
  if (input.code !== TEST_FAILURE_EXIT) {
    return {
      counts: true,
      note: `[dipo: verify exited with ${input.code}, not the test runner's ${TEST_FAILURE_EXIT} for failing tests, so the failure counts.]`,
    };
  }
  const errors = runnerErrors(input.output);
  if (errors > 0) {
    return {
      counts: true,
      note: `[dipo: the test runner reported ${errors} ${errors === 1 ? "error" : "errors"} outside a named test, so the failure counts.]`,
    };
  }
  const known = new Set(input.base.kind === "red" ? input.base.failing : []);
  const fresh = failing.filter((name) => !known.has(name));
  if (fresh.length > 0) {
    return {
      counts: true,
      note: `[dipo: ${fresh.length === 1 ? "this failing test does" : "these failing tests do"} not fail at the start commit in this box, so ${fresh.length === 1 ? "it counts" : "they count"}:]\n${namesNote(fresh)}`,
    };
  }
  return { counts: false, baseFailures: failing };
}

export interface BoxBaseVerifyDeps extends BoxCommandDeps {
  readonly boxes: Pick<BoxPort, "execLive" | "stop" | "list">;
}

export interface BoxBaseVerifyRequest {
  readonly box: string;
  /** The verify command lists, run in order until one fails. */
  readonly commands: readonly (readonly string[])[];
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface BoxBaseVerifyResult {
  /** Green, red with the failing tests, or not known (never stored). */
  readonly facts: BaseVerifyFacts;
  /** Set when a command passed dipo's deadline: how it was ended in the box. */
  readonly ended: BoxCommandEnd | null;
}

const notKnown = (reason: string): BaseVerifyFacts => ({ kind: "unknown", reason });

async function stillRunning(deps: BoxBaseVerifyDeps, box: string): Promise<boolean> {
  try {
    return (await deps.boxes.list()).some((info) => info.name === box && info.state === "running");
  } catch {
    return false;
  }
}

/**
 * Runs the office's verify at the start commit in the box (`runBoxCommand` per command list, as
 * the verify at done does) and reads its failing tests. A command that could not start, timed
 * out, was ended by a signal, or failed while the box stopped under it (a daemon stop ends every
 * box process) gives a not-known result, which is never stored.
 */
export async function runBoxBaseVerify(
  deps: BoxBaseVerifyDeps,
  request: BoxBaseVerifyRequest,
): Promise<BoxBaseVerifyResult> {
  let ran = false;
  for (const command of request.commands) {
    const [program, ...args] = command;
    if (program === undefined) continue;
    let result: BoxCommandResult;
    try {
      result = await runBoxCommand(deps, {
        box: request.box,
        command: [program, ...args],
        env: request.env,
        timeoutMs: request.timeoutMs,
      });
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      return {
        facts: notKnown(
          `verify could not start in the box (${typeof code === "string" ? code : "error"})`,
        ),
        ended: null,
      };
    }
    if (result.timedOut) {
      const minutes = Math.round(request.timeoutMs / 60_000);
      return { facts: notKnown(`verify timed out after ${minutes} min`), ended: result.ended };
    }
    if (result.code === null) {
      return { facts: notKnown(`verify ended by ${result.signal ?? "a signal"}`), ended: null };
    }
    ran = true;
    if (result.code !== 0) {
      if (!(await stillRunning(deps, request.box))) {
        return { facts: notKnown("the box stopped while verify ran"), ended: null };
      }
      const failing = failingTests(result.output);
      return {
        facts: { kind: "red", failing, tail: failing.length > 0 ? null : outputEnd(result.output) },
        ended: null,
      };
    }
  }
  return {
    facts: ran ? { kind: "green" } : notKnown("the run profile's verify has no command"),
    ended: null,
  };
}
