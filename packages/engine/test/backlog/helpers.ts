// Shared paths and helpers for the Backlog.md tests: the pinned CLI (the root devDependency
// `backlog.md@1.53.0`, started through Bun so no `node` is needed), the fixture project, the
// recorded `--plain` outputs, and a stub `Spawn` that answers from text.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ChildProcess, Spawn, SpawnOptions } from "@dipsaus-orchestrator/contract";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

/** The pinned CLI: Bun running the package's launcher, which starts the platform binary. */
export const BACKLOG_CLI: readonly [string, ...string[]] = [
  process.execPath,
  join(REPO_ROOT, "node_modules", "backlog.md", "cli.js"),
];

/** The Backlog.md fixture project (DIPO-18). */
export const BACKLOG_FIXTURE = join(import.meta.dir, "..", "fixtures", "backlog");

/** Output recorded from Backlog.md 1.53.0 by `record-plain.ts`. */
export const PLAIN_FIXTURES = join(import.meta.dir, "..", "fixtures", "backlog-plain");

export interface PlainRecording {
  readonly name: string;
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stderr: string;
}

export interface PlainManifest {
  readonly backlog: string;
  readonly recordings: readonly PlainRecording[];
}

export function readManifest(): PlainManifest {
  return JSON.parse(readFileSync(join(PLAIN_FIXTURES, "recordings.json"), "utf8")) as PlainManifest;
}

/** The recorded stdout of one recording. */
export function recorded(name: string): string {
  return readFileSync(join(PLAIN_FIXTURES, `${name}.stdout.txt`), "utf8");
}

function stream(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body ?? new ReadableStream();
}

export interface StubSpawn {
  readonly spawn: Spawn;
  readonly calls: SpawnOptions[];
}

/** A `Spawn` whose children print `stdout` and `stderr` and exit with `code`. */
export function stubSpawn(stdout: string, stderr = "", code = 0): StubSpawn {
  const calls: SpawnOptions[] = [];
  const spawn: Spawn = (options) => {
    calls.push(options);
    const child: ChildProcess = {
      pid: 4242,
      stdin: null,
      stdout: stream(stdout),
      stderr: stream(stderr),
      exited: Promise.resolve({ code, signal: null }),
      kill: () => {},
    };
    return child;
  };
  return { spawn, calls };
}
