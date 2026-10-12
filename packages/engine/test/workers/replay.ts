// Replays a committed Claude recording through the fake process and the real adapter parser, the
// way the worker host and the engine will: spawn through the injected `Spawn`, read stdout as it
// comes, turn each chunk into a host line, run `interpret`, and call `result` at the exit.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { ChildExit } from "@dipsaus-orchestrator/contract";
import {
  type FakeProcess,
  type FakeSpawn,
  fakeSpawn,
  ManualClock,
  readRecording,
  recordedProcesses,
  type Recording,
} from "@dipsaus-orchestrator/testkit";

import {
  type ClaudeParseState,
  initialState,
  interpret,
} from "../../src/workers/claude-cli/interpret";
import { result } from "../../src/workers/claude-cli/result";
import type { HostLine, WorkerEvent, WorkerResult } from "../../src/workers/types";

export const RECORDINGS_DIR = join(import.meta.dir, "..", "recordings", "claude-cli");

export function recordingNames(): string[] {
  return readdirSync(RECORDINGS_DIR, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(join(RECORDINGS_DIR, entry.name, "meta.json")),
    )
    .map((entry) => entry.name)
    .toSorted();
}

export function loadRecording(name: string): Recording {
  return readRecording(join(RECORDINGS_DIR, name));
}

/** The model the capture planned: from the recording, or from the live one it was derived from. */
export function plannedModel(recording: Recording): string {
  if (typeof recording.meta.model === "string") return recording.meta.model;
  const from = recording.meta["derivedFrom"];
  if (typeof from === "string") return plannedModel(loadRecording(from));
  throw new Error(`${recording.name}: no planned model`);
}

export interface Replay {
  readonly events: WorkerEvent[];
  readonly lines: HostLine[];
  readonly state: ClaudeParseState;
  readonly exit: ChildExit;
  readonly result: WorkerResult;
  readonly clock: ManualClock;
  /** Milliseconds the manual clock moved during the replay. */
  readonly elapsed: number;
  readonly fake: FakeSpawn;
}

export interface ReplayOptions {
  /** Called before each stdout read with the process and the chunks it gave so far. */
  readonly beforeRead?: (child: FakeProcess, chunks: number) => void;
  readonly state?: ClaudeParseState;
  /** The manual clock to replay on; a fresh one by default. */
  readonly clock?: ManualClock;
}

const decoder = new TextDecoder();

export async function replay(recording: Recording, options: ReplayOptions = {}): Promise<Replay> {
  const clock = options.clock ?? new ManualClock();
  const start = clock.now();
  const events: WorkerEvent[] = [];
  const lines: HostLine[] = [];
  let state = options.state ?? initialState({ plannedModel: plannedModel(recording) });
  const feed = (line: HostLine) => {
    lines.push(line);
    const step = interpret(line, state);
    events.push(...step.events);
    state = step.state as ClaudeParseState;
  };
  const fake = fakeSpawn(recording, clock, {
    onHook: (payload) =>
      feed({ t: clock.now() - start, ch: "hook", data: JSON.stringify(payload) }),
  });

  let exit: ChildExit = { code: null, signal: null };
  const processes = recordedProcesses(recording.lines).length;
  for (let index = 0; index < processes; index++) {
    const child = fake.spawn({ cmd: ["claude", "-p"], stdin: "pipe" }) as FakeProcess;
    const reader = child.stdout.getReader();
    for (let chunks = 0; ; chunks++) {
      options.beforeRead?.(child, chunks);
      const { done, value } = await reader.read();
      if (done) break;
      feed({ t: clock.now() - start, ch: "stdout", data: decoder.decode(value) });
    }
    exit = await child.exited;
    feed({ t: clock.now() - start, ch: "exit", data: JSON.stringify(exit) });
  }
  return {
    events,
    lines,
    state,
    exit,
    result: result(state, exit),
    clock,
    elapsed: clock.now() - start,
    fake,
  };
}
