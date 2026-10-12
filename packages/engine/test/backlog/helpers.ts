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

export interface ScriptedReply {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
}

/** A `Spawn` that answers each call with `reply(args)`, where `args` follow the CLI command. */
export function scriptedSpawn(
  reply: (args: readonly string[]) => ScriptedReply,
  command: readonly string[] = ["backlog"],
): StubSpawn {
  const calls: SpawnOptions[] = [];
  const spawn: Spawn = (options) => {
    calls.push(options);
    const { stdout = "", stderr = "", code = 0 } = reply(options.cmd.slice(command.length));
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

/** A minimal `task view --plain` output with this description and these labels. */
export function viewOutput(
  id: string,
  description: string,
  labels: readonly string[] = [],
): string {
  return [
    `File: /office/backlog/tasks/${id.toLowerCase()} - Story.md`,
    "",
    `Task ${id} - Story`,
    "=".repeat(50),
    "",
    "Status: ○ Ready",
    "Created: 2026-10-12 11:28 (UTC)",
    ...(labels.length > 0 ? [`Labels: ${labels.join(", ")}`] : []),
    "",
    "Description:",
    "-".repeat(50),
    description === "" ? "No description provided" : description,
    "",
    "Acceptance Criteria:",
    "-".repeat(50),
    "No acceptance criteria defined",
    "",
  ].join("\n");
}
