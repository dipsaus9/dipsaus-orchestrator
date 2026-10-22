// The commands dipo runs in a box (DIPO-274, DIPO-294): one command of dipo's in the box's
// `/work` through the box interface's exec, without AI, to its end within dipo's deadline
// (`runBoxCommand`), and the office's install before the worker starts (`runBoxInstall`), which
// runs through it. dipo runs no verify in the box at done (0021 amendment of 2026-10-22,
// DIPO-299): the worker runs the office's verify itself, and CI on the story PR is the verify.
//
// - The command runs under a small wrapper dipo writes (`boxCommand`): it records its own
//   pid in `BOX_COMMAND_PID_FILE` and becomes `timeout`, where the box has it. GNU `timeout` makes
//   itself a process group leader, so that pid names the command's whole process group. Its own
//   limit is dipo's deadline plus `BOX_COMMAND_GRACE_SECONDS`: a second layer inside the box.
// - dipo's deadline decides. Past it, dipo kills the exec client, and since a killed exec client
//   leaves its process running in the box (DIPO-265 real-box run of 2026-10-21), it then ends the
//   command inside the box: `boxKillCommand` kills the process group the pid file names and
//   waits until the process is gone. When that does not work, dipo stops the box, which ends every
//   process in it, the worker's session included (`BoxCommandEnd`).
// - The output is untrusted text from the box: cleaned with the door's `cleanDoorText` line by
//   line, at most `BOX_COMMAND_OUTPUT_MAX` bytes go to `onOutput`, and the tail kept for the
//   caller is cut to the same size.
// - The pid file is written in the box, which the worker controls; dipo never reads it on the Mac.
//   A wrong pid ends at most a process of the worker's own box.

import type { ChildExit, Clock, TimerHandle } from "@dipsaus-orchestrator/contract";

import { BOX_DIPO_DIR, BOX_WORKDIR } from "./code";
import { cleanDoorText } from "./door";
import type { BoxPort } from "./port";

/** dipo's folder for the commands it runs in a box. */
export const BOX_COMMAND_DIR = `${BOX_DIPO_DIR}/command`;
/** The pid of the running command, written by the wrapper in the box. */
export const BOX_COMMAND_PID_FILE = `${BOX_COMMAND_DIR}/pid`;
/** The most output bytes passed on live, and the most kept as the tail. */
export const BOX_COMMAND_OUTPUT_MAX = 4 * 1024 * 1024;
/** A line longer than this is passed on without waiting for its end. */
export const BOX_COMMAND_LINE_MAX = 64 * 1024;
/** How long after dipo's deadline the box's own `timeout` ends the command. */
export const BOX_COMMAND_GRACE_SECONDS = 30;
/** How long `timeout` in the box waits after its signal before it kills. */
export const BOX_COMMAND_KILL_AFTER_SECONDS = 10;
/** The deadline of the kill in the box. */
export const BOX_COMMAND_KILL_TIMEOUT_MS = 30_000;
/** How long the kill in the box waits for the process to be gone. */
export const BOX_COMMAND_KILL_WAIT_SECONDS = 10;
/** How long the output streams may stay open after the exec client was killed. */
export const BOX_COMMAND_DRAIN_MS = 5_000;

type Log = (message: string, fields: Readonly<Record<string, unknown>>) => void;

/**
 * The wrapper that runs `command` in the box: its pid recorded in `BOX_COMMAND_PID_FILE`, then
 * `timeout` (as a process group leader) for `seconds` where the box has it, else the command.
 */
export function boxCommand(
  command: readonly [string, ...string[]],
  seconds: number,
): [string, ...string[]] {
  const limit = Math.max(1, Math.ceil(seconds));
  return [
    "/bin/sh",
    "-c",
    `{ mkdir -p '${BOX_COMMAND_DIR}' && rm -f '${BOX_COMMAND_PID_FILE}' && echo "$$" > '${BOX_COMMAND_PID_FILE}'; } 2>/dev/null
if command -v timeout >/dev/null 2>&1; then exec timeout -k ${BOX_COMMAND_KILL_AFTER_SECONDS} ${limit} "$@"; fi
exec "$@"`,
    "dipo-command",
    ...command,
  ];
}

/**
 * The kill in the box: the process group the pid file names (the process alone when it leads
 * none) gets SIGKILL, then the command waits up to `BOX_COMMAND_KILL_WAIT_SECONDS` for the process
 * to be gone. Exit 0 when it is gone, 1 when it still runs, 3 when there is no usable pid: none, not
 * digits, init, one with a leading zero, or one of no running process (stale or forged). dipo then
 * stops the box.
 */
export function boxKillCommand(): [string, ...string[]] {
  return [
    "/bin/sh",
    "-c",
    `pid=$(cat '${BOX_COMMAND_PID_FILE}' 2>/dev/null) || exit 3
case "$pid" in ''|0*|1|*[!0-9]*) exit 3 ;; esac
[ -d "/proc/$pid" ] || exit 3
kill -s KILL -- "-$pid" 2>/dev/null || kill -s KILL "$pid" 2>/dev/null
i=0
while [ -e "/proc/$pid/status" ] && ! grep -q '^State:[[:space:]]*[ZX]' "/proc/$pid/status" 2>/dev/null; do
  if [ "$i" -ge ${BOX_COMMAND_KILL_WAIT_SECONDS} ]; then exit 1; fi
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
    if (pending.length > BOX_COMMAND_LINE_MAX) {
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
    boxCommand(request.command, request.timeoutMs / 1000 + BOX_COMMAND_GRACE_SECONDS),
    { cwd: BOX_WORKDIR, env: request.env },
  );
  child.stdin.end();
  const output = new BoxOutput(request.maxOutputBytes ?? BOX_COMMAND_OUTPUT_MAX, request.onOutput);
  const cancels: (() => void)[] = [];
  let timedOut = false;
  let drain: TimerHandle | undefined;
  const timer = deps.clock.setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
    // The client is gone; streams it left open are closed after a short drain.
    drain = deps.clock.setTimeout(() => {
      for (const cancel of cancels) cancel();
    }, BOX_COMMAND_DRAIN_MS);
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
    const code = await boundedExec(deps, box, boxKillCommand(), BOX_COMMAND_KILL_TIMEOUT_MS);
    if (code === 0) return "killed";
    deps.warn?.("the timed-out command could not be killed inside the box; stopping the box", {
      box,
      code,
    });
  } catch (error) {
    deps.warn?.("the kill of the timed-out command failed; stopping the box", {
      box,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    await deps.boxes.stop(box);
    return "stopped";
  } catch (error) {
    deps.warn?.("the box of a timed-out command could not be stopped", {
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

// ---- the install before the worker (DIPO-294) ---------------------------------------------------
//
// Before the worker's first session, dipo runs the office's install in the box at the start
// commit, each command list through `runBoxCommand` in `/work` (the wrapper, dipo's
// deadline, the end in the box), with the environment the caller gives: the run environment and
// the box's web route (`BoxWorkers.install`). The reason of a failure names the command, the exit
// and the deadline, never the box's output; the cleaned tail of the output is kept apart, for the
// daemon's log.

/** The most characters of a failed install's output kept for the daemon's log. */
export const BOX_INSTALL_OUTPUT_TAIL = 2000;

export interface BoxInstallDeps extends BoxCommandDeps {
  readonly boxes: Pick<BoxPort, "execLive" | "stop" | "list">;
}

export interface BoxInstallRequest {
  readonly box: string;
  /** The install command lists of the run profile, run in order until one fails. */
  readonly commands: readonly (readonly string[])[];
  /** The environment set in the box: the run environment and the box's web route. */
  readonly env: Readonly<Record<string, string>>;
  /** The office's install deadline, for each command list. */
  readonly timeoutMs: number;
}

export type BoxInstallResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** Why, with no box output in it: the command and its exit, deadline or signal. */
      readonly reason: string;
      /** The cleaned tail of the failed command's output, for the daemon's log only. */
      readonly output: string;
      /** Set when the command passed the deadline: how it was ended in the box. */
      readonly ended: BoxCommandEnd | null;
      /** True when the box was found stopped after the command failed. */
      readonly boxStopped?: true;
    };

async function boxRuns(deps: BoxInstallDeps, box: string): Promise<boolean> {
  try {
    return (await deps.boxes.list()).some((info) => info.name === box && info.state === "running");
  } catch {
    return false;
  }
}

function minutesOf(ms: number): string {
  const minutes = ms / 60_000;
  return Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(2);
}

/** Runs the office's install in the box (see the section comment). Never throws. */
export async function runBoxInstall(
  deps: BoxInstallDeps,
  request: BoxInstallRequest,
): Promise<BoxInstallResult> {
  for (const command of request.commands) {
    const [program, ...args] = command;
    if (program === undefined) continue;
    const shown = command.join(" ");
    let result: BoxCommandResult;
    try {
      result = await runBoxCommand(deps, {
        box: request.box,
        command: [program, ...args],
        env: request.env,
        timeoutMs: request.timeoutMs,
      });
    } catch (error) {
      // Only the code: the message may quote the box.
      const code = (error as { code?: unknown } | null)?.code;
      return {
        ok: false,
        reason: `the install (${shown}) could not start in the box (${typeof code === "string" ? code : "error"})`,
        output: "",
        ended: null,
      };
    }
    const output = result.output.slice(-BOX_INSTALL_OUTPUT_TAIL);
    if (result.timedOut) {
      const how =
        result.ended === "failed"
          ? ", and could be ended neither inside the box nor by stopping it"
          : result.ended === "stopped"
            ? ", so dipo stopped the box"
            : "";
      return {
        ok: false,
        reason: `the install (${shown}) timed out after ${minutesOf(request.timeoutMs)} min in the box${how}`,
        output,
        ended: result.ended,
      };
    }
    if (result.code !== 0) {
      const how =
        result.code === null
          ? `was ended by ${result.signal ?? "a signal"}`
          : `exited ${result.code}`;
      const stopped = !(await boxRuns(deps, request.box));
      return {
        ok: false,
        reason: stopped
          ? `the box stopped while the install (${shown}) ran`
          : `the install (${shown}) ${how} in the box`,
        output,
        ended: null,
        ...(stopped ? { boxStopped: true as const } : {}),
      };
    }
  }
  return { ok: true };
}
