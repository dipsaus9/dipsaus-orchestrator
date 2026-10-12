// `bun run recordings:status` (0017 section 2, "Storage and refresh"): compares the local
// `claude --version` with each recording's `claude_code_version` and lists the stale ones, so the
// maintainer sees when a refresh is due. A dev script, not a test: tests must not depend on an
// installed `claude`.

import type { Recording } from "./format";
import { readAllRecordings } from "./format";

/** `2.1.296` from `2.1.296 (Claude Code)`; null when the output holds no version. */
export function parseClaudeVersion(output: string): string | null {
  return /\b(\d+\.\d+\.\d+)\b/.exec(output)?.[1] ?? null;
}

export interface StaleRecording {
  readonly name: string;
  readonly recorded: string | null;
}

/** Recordings whose `claude_code_version` differs from `local`. */
export function staleRecordings(
  local: string,
  recordings: readonly Pick<Recording, "name" | "meta">[],
): StaleRecording[] {
  return recordings
    .filter((recording) => recording.meta.claude_code_version !== local)
    .map((recording) => ({ name: recording.name, recorded: recording.meta.claude_code_version }));
}

if (import.meta.main) {
  const proc = Bun.spawn(["claude", "--version"], { stdout: "pipe", stderr: "ignore" });
  const local = parseClaudeVersion(await new Response(proc.stdout).text());
  await proc.exited;
  if (local === null) {
    console.error("recordings:status: could not read `claude --version`");
    process.exit(1);
  }
  const recordings = readAllRecordings();
  const stale = staleRecordings(local, recordings);
  console.log(`local claude ${local}; ${recordings.length} recordings, ${stale.length} stale`);
  for (const { name, recorded } of stale) {
    console.log(`  ${name}: recorded with ${recorded ?? "unknown"}`);
  }
}
