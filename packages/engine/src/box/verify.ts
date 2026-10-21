// One verify command in the worker's box (0021 section 9, DIPO-274): dipo runs the office's verify
// command in the box's `/work` through the box interface's exec, without AI and without the web
// route, so verify has no network, as on the Mac.
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
 * to be gone. Exit 0 when it is gone, 1 when it still runs, 3 when there is no usable pid.
 */
export function boxKillCommand(): [string, ...string[]] {
  return [
    "/bin/sh",
    "-c",
    `pid=$(cat '${BOX_VERIFY_PID_FILE}' 2>/dev/null) || exit 3
case "$pid" in ''|0|1|*[!0-9]*) exit 3 ;; esac
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
