// The fake worker subprocess (0017 section 2): it replaces the process, not the adapter. A
// recording from `packages/engine/test/recordings/<adapter>/<scenario>/` is replayed through the
// contract `ChildProcess` type, handed out by an injected `Spawn`. Time moves only on the manual
// clock, by the recorded `t` deltas, so a 30-minute recording replays in milliseconds.
//
// Replay is pull-driven: each read of `stdout` replays up to the next stdout chunk, advancing the
// clock, writing stderr lines and handing hook payloads on the way. A test therefore decides
// exactly how far the process has run before it signals it. On SIGINT the replay jumps to the
// recorded post-interrupt tail; on SIGTERM it ends at once with exit 143 and no result.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  ChildExit,
  ChildProcess,
  ChildStdin,
  Signal,
  Spawn,
  SpawnOptions,
} from "@dipsaus-orchestrator/contract";

import type { ManualClock } from "./clock";

/** One line of `stream.jsonl` (0017 envelope). `t` is milliseconds since the capture started. */
export interface RecordedLine {
  readonly t: number;
  readonly ch: "stdout" | "stderr" | "hook" | "exit";
  readonly data: unknown;
}

/** One steering op the capture sent (`meta.steering`). */
export interface RecordedSteer {
  readonly t: number;
  readonly op: string;
  readonly signal?: string;
  readonly priority?: string;
  readonly bytes?: number;
  readonly resume?: boolean;
}

/** The fields of `meta.json` the fake and tests read; the rest is kept as is. */
export interface RecordingMeta {
  readonly scenario: string;
  readonly source: string;
  readonly expected: string;
  readonly model?: string;
  readonly steering?: readonly RecordedSteer[];
  readonly testConfig?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

export interface Recording {
  readonly name: string;
  readonly meta: RecordingMeta;
  readonly lines: readonly RecordedLine[];
}

/** Reads `<dir>/stream.jsonl` and `<dir>/meta.json`. */
export function readRecording(dir: string): Recording {
  const stream = readFileSync(join(dir, "stream.jsonl"), "utf8");
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as RecordingMeta;
  const lines = stream
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RecordedLine);
  return { name: meta.scenario, meta, lines };
}

/** The recording split into processes: each ends with its `exit` line (a resume pair has two). */
export function recordedProcesses(lines: readonly RecordedLine[]): RecordedLine[][] {
  const processes: RecordedLine[][] = [];
  let current: RecordedLine[] = [];
  for (const line of lines) {
    current.push(line);
    if (line.ch === "exit") {
      processes.push(current);
      current = [];
    }
  }
  if (current.length > 0) processes.push(current);
  return processes;
}

/** The stdout text of one recorded line: an object becomes a JSON line, a string is a partial line. */
export function stdoutText(data: unknown): string {
  return typeof data === "string" ? data : `${JSON.stringify(data)}\n`;
}

export interface FakeProcessOptions {
  readonly lines: readonly RecordedLine[];
  readonly clock: ManualClock;
  readonly pid?: number;
  readonly stdin?: "pipe" | "ignore";
  /** Recorded time this process started; the first delta is measured from it. Default 0. */
  readonly startT?: number;
  /** Recorded time of the capture's SIGINT; lines after it are the post-interrupt tail. */
  readonly sigintAt?: number;
  /** Receives each recorded hook payload as the replay passes it. */
  readonly onHook?: (payload: unknown) => void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class FakeProcess implements ChildProcess {
  readonly pid: number;
  readonly stdin: ChildStdin | null;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<ChildExit>;
  /** Every stdin write, decoded, in order. */
  readonly stdinWrites: string[] = [];
  /** Signals received, in order. */
  readonly signals: Signal[] = [];

  readonly #lines: readonly RecordedLine[];
  readonly #clock: ManualClock;
  readonly #sigintAt: number | undefined;
  readonly #onHook: ((payload: unknown) => void) | undefined;
  #position = 0;
  #lastT: number;
  #stdinClosed = false;
  #exit: ChildExit | null = null;
  #resolveExit!: (exit: ChildExit) => void;
  #stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  #stderrController!: ReadableStreamDefaultController<Uint8Array>;

  constructor(options: FakeProcessOptions) {
    this.pid = options.pid ?? 4242;
    this.#lines = options.lines;
    this.#clock = options.clock;
    this.#sigintAt = options.sigintAt;
    this.#onHook = options.onHook;
    this.#lastT = options.startT ?? 0;
    this.exited = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });
    this.stdout = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.#stdoutController = controller;
        },
        pull: () => this.#step(),
      },
      { highWaterMark: 0 },
    );
    this.stderr = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#stderrController = controller;
      },
    });
    this.stdin =
      options.stdin === "pipe"
        ? {
            write: (chunk) => {
              if (this.#stdinClosed) throw new Error("FakeProcess: write after stdin end");
              this.stdinWrites.push(typeof chunk === "string" ? chunk : decoder.decode(chunk));
            },
            end: () => {
              this.#stdinClosed = true;
            },
          }
        : null;
  }

  /** True once stdin was ended. */
  get stdinClosed(): boolean {
    return this.#stdinClosed;
  }

  /** The exit once the process has ended, else null. */
  get exit(): ChildExit | null {
    return this.#exit;
  }

  kill(signal: Signal = "SIGTERM"): void {
    if (this.#exit !== null) return;
    this.signals.push(signal);
    switch (signal) {
      case "SIGINT": {
        const tail =
          this.#sigintAt === undefined
            ? -1
            : this.#lines.findIndex((line) => line.t > (this.#sigintAt ?? 0));
        if (tail < 0) {
          this.#finish({ code: null, signal: "SIGINT" });
          return;
        }
        if (this.#position < tail) this.#position = tail;
        this.#lastT = Math.max(this.#lastT, this.#sigintAt ?? 0);
        return;
      }
      case "SIGTERM":
        // Claude Code leaves the turn unfinished: no result, exit 143 (0008 "Exit and resume").
        this.#finish({ code: 143, signal: null });
        return;
      default:
        this.#finish({ code: null, signal });
    }
  }

  /** Replays up to and including the next stdout chunk, or to the exit. */
  #step(): void {
    while (this.#exit === null) {
      const line = this.#lines[this.#position];
      if (line === undefined) {
        this.#finish({ code: 0, signal: null });
        return;
      }
      this.#position += 1;
      if (line.t > this.#lastT) {
        this.#clock.advance(line.t - this.#lastT);
        this.#lastT = line.t;
      }
      switch (line.ch) {
        case "stdout":
          this.#stdoutController.enqueue(encoder.encode(stdoutText(line.data)));
          return;
        case "stderr":
          this.#stderrController.enqueue(encoder.encode(`${String(line.data)}\n`));
          break;
        case "hook":
          this.#onHook?.(line.data);
          break;
        case "exit": {
          const data = line.data as Partial<ChildExit>;
          this.#finish({ code: data.code ?? null, signal: data.signal ?? null });
          return;
        }
      }
    }
  }

  #finish(exit: ChildExit): void {
    if (this.#exit !== null) return;
    this.#exit = exit;
    this.#stdoutController.close();
    this.#stderrController.close();
    this.#resolveExit(exit);
  }
}

export interface FakeSpawn {
  /** The injected `Spawn`: each call starts the recording's next process. */
  readonly spawn: Spawn;
  /** Options of every spawn call, in order. */
  readonly calls: SpawnOptions[];
  /** Every process started, in order. */
  readonly processes: FakeProcess[];
}

export interface FakeSpawnOptions {
  readonly onHook?: (payload: unknown) => void;
}

/** A `Spawn` that replays `recording` one recorded process per call, on `clock`. */
export function fakeSpawn(
  recording: Recording,
  clock: ManualClock,
  options: FakeSpawnOptions = {},
): FakeSpawn {
  const segments = recordedProcesses(recording.lines);
  const steering = recording.meta.steering ?? [];
  const spawns = steering.filter((steer) => steer.op === "spawn").map((steer) => steer.t);
  const sigints = steering
    .filter((steer) => steer.op === "signal" && steer.signal === "SIGINT")
    .map((steer) => steer.t);
  const calls: SpawnOptions[] = [];
  const processes: FakeProcess[] = [];
  const spawn: Spawn = (spawnOptions) => {
    const index = processes.length;
    const lines = segments[index];
    if (lines === undefined) {
      throw new Error(`FakeSpawn: ${recording.name} has only ${segments.length} process(es)`);
    }
    const startT = spawns[index] ?? 0;
    const endT = lines[lines.length - 1]?.t ?? startT;
    const sigintAt = sigints.find((t) => t >= startT && t <= endT);
    calls.push(spawnOptions);
    const child = new FakeProcess({
      lines,
      clock,
      pid: 4242 + index,
      startT,
      ...(spawnOptions.stdin === undefined ? {} : { stdin: spawnOptions.stdin }),
      ...(sigintAt === undefined ? {} : { sigintAt }),
      ...(options.onHook === undefined ? {} : { onHook: options.onHook }),
    });
    processes.push(child);
    return child;
  };
  return { spawn, calls, processes };
}
