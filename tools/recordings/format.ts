// The recording format of 0017 section 2: one directory per scenario under
// `packages/engine/test/recordings/claude-cli/<scenario>/` with `stream.jsonl` (one envelope per
// observed item, in arrival order) and `meta.json` (how it was made and what it should cause).

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dir, "..", "..");
export const RECORDINGS_DIR = join(REPO_ROOT, "packages/engine/test/recordings/claude-cli");
export const FIXTURE_REPOS_DIR = join(REPO_ROOT, "packages/engine/test/fixtures/repos");
export const STREAM_FILE = "stream.jsonl";
export const META_FILE = "meta.json";

export type Channel = "stdout" | "stderr" | "hook" | "exit";

/** One line of `stream.jsonl`. `t` is milliseconds since the capture started. */
export interface Envelope {
  readonly t: number;
  readonly ch: Channel;
  readonly data: unknown;
}

/** One write, signal or stdin close the capture sent to the worker, for the replay fake. */
export interface SteerRecord {
  readonly t: number;
  readonly op: "user" | "signal" | "closeStdin" | "spawn";
  readonly priority?: string;
  readonly signal?: string;
  readonly bytes?: number;
  readonly resume?: boolean;
}

/** `meta.json`. Every field is safe to commit: no prompt text, no real path. */
export interface Meta {
  readonly scenario: string;
  readonly source: "live" | "derived" | "synthetic";
  readonly claude_code_version: string | null;
  readonly captured_at: string;
  readonly expected: string;
  /** sha256 over the usage numbers of the stream, taken from the raw stream at capture. */
  readonly usage_checksum: string;
  readonly fixture?: string;
  readonly fixture_sha256?: string;
  readonly model?: string;
  readonly flags?: readonly string[];
  readonly prompt_bytes?: number;
  readonly prompt_sha256?: string;
  readonly processes?: number;
  readonly steering?: readonly SteerRecord[];
  /** Message types or hook events the allowlist did not know; redacted whole. */
  readonly unknown_types?: readonly string[];
  /** Findings the capture checked on disk or in the stream (AC #9 live checks). */
  readonly checks?: Readonly<Record<string, unknown>>;
  readonly derivedFrom?: string;
  readonly transform?: string;
  readonly synthetic?: boolean;
  readonly cites?: readonly string[];
  /** Engine test configuration the scenario needs, for example a low tier budget. */
  readonly testConfig?: Readonly<Record<string, unknown>>;
}

export interface Recording {
  readonly name: string;
  readonly meta: Meta;
  readonly lines: readonly Envelope[];
  /** The exact file contents, for the secret scan. */
  readonly streamText: string;
  readonly metaText: string;
}

export function serializeStream(lines: readonly Envelope[]): string {
  return lines.map((line) => `${JSON.stringify(line)}\n`).join("");
}

export function serializeMeta(meta: Meta): string {
  return `${JSON.stringify(meta, null, 2)}\n`;
}

export function parseStream(text: string): Envelope[] {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Envelope);
}

export function recordingNames(dir: string = RECORDINGS_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, META_FILE)))
    .map((entry) => entry.name)
    .toSorted();
}

export function readRecording(name: string, dir: string = RECORDINGS_DIR): Recording {
  const streamText = readFileSync(join(dir, name, STREAM_FILE), "utf8");
  const metaText = readFileSync(join(dir, name, META_FILE), "utf8");
  return {
    name,
    meta: JSON.parse(metaText) as Meta,
    lines: parseStream(streamText),
    streamText,
    metaText,
  };
}

export function readAllRecordings(dir: string = RECORDINGS_DIR): Recording[] {
  return recordingNames(dir).map((name) => readRecording(name, dir));
}

/** Writes both files; callers run the secret guard over both texts first. */
export function writeRecording(
  name: string,
  streamText: string,
  metaText: string,
  dir: string = RECORDINGS_DIR,
): string {
  const target = join(dir, name);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, STREAM_FILE), streamText);
  writeFileSync(join(target, META_FILE), metaText);
  return target;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
