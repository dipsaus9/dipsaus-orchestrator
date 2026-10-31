// Refreshes scripts/test-timings.json, the per-file test times the CI shards are split by
// (scripts/test-shards.ts, DIPO-406), from the logs of one CI run:
//
//   bun scripts/test-timings.ts <run id>      for example the latest green push to main:
//   gh run list --workflow ci.yml --branch main --event push --status success --limit 1
//
// In GitHub Actions `bun test` opens a log group per file when the file starts and closes it when
// the file is done, so a file's time is the time between the two log lines. The run's `verify` and
// `verify-macos` jobs (each shard, or the one job of a run from before the shards) give the times
// of their OS. Files the run has no time for keep their old time; files no longer tracked go.

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  isTestFile,
  readTimings,
  SHARDED_JOBS,
  testFiles,
  TIMINGS_PATH,
  type TimingFile,
} from "./test-shards";

const ROOT = resolve(import.meta.dir, "..");

/** A line of `gh run view --log`: job, step, then the time stamp and the text. */
const LOG_LINE = /^[^\t]*\t[^\t]*\t\uFEFF?(\d{4}-\d\d-\d\dT[\d:.]+Z) (.*)$/;

/** Each test file's time in milliseconds in the job log `log`. */
export function parseLog(log: string): Record<string, number> {
  const times: Record<string, number> = {};
  let open: { file: string; at: number } | undefined;
  for (const line of log.split("\n")) {
    const match = LOG_LINE.exec(line);
    if (match === null) continue;
    const at = Date.parse(match[1] ?? "");
    const text = match[2] ?? "";
    if (text.startsWith("##[group]")) {
      const name = text.slice("##[group]".length).replace(/:$/, "");
      open = isTestFile(name) && text.endsWith(":") ? { file: name, at } : undefined;
    } else if (text.startsWith("##[endgroup]") && open !== undefined) {
      times[open.file] = (times[open.file] ?? 0) + Math.max(0, Math.round(at - open.at));
      open = undefined;
    }
  }
  return times;
}

/** The `RUNNER_OS` of a job of ci.yml by its name: `verify (2)` or `verify` is Linux, and so on. */
export function jobOs(name: string): string | undefined {
  const id = /^(.*?)(?: \(\d+\))?$/.exec(name)?.[1] ?? name;
  return SHARDED_JOBS[id];
}

/**
 * `old` with the times of `fresh` in place, per OS, kept only for the test files in `files`, in
 * path order.
 */
export function mergeTimings(
  old: TimingFile,
  fresh: TimingFile,
  files: readonly string[],
): TimingFile {
  const current = new Set(files);
  const merged: TimingFile = {};
  for (const os of [...new Set([...Object.keys(old), ...Object.keys(fresh)])].toSorted()) {
    const times = { ...old[os], ...fresh[os] };
    merged[os] = Object.fromEntries(
      Object.keys(times)
        .filter((file) => current.has(file))
        .toSorted()
        .map((file) => [file, times[file] ?? 0]),
    );
  }
  return merged;
}

function gh(args: string[]): string {
  const run = Bun.spawnSync(["gh", ...args], { cwd: ROOT, stdout: "pipe", stderr: "inherit" });
  if (run.exitCode !== 0) throw new Error(`gh ${args.join(" ")} failed`);
  return run.stdout.toString();
}

if (import.meta.main) {
  const runId = Bun.argv[2];
  if (runId === undefined || !/^\d+$/.test(runId)) {
    console.error("usage: bun scripts/test-timings.ts <run id>");
    process.exit(2);
  }
  const { jobs } = JSON.parse(gh(["run", "view", runId, "--json", "jobs"])) as {
    jobs: { databaseId: number; name: string; conclusion: string }[];
  };
  const fresh: TimingFile = {};
  for (const job of jobs) {
    const os = jobOs(job.name);
    if (os === undefined) continue;
    if (job.conclusion !== "success") {
      console.error(`${job.name} did not succeed (${job.conclusion}); pick a green run`);
      process.exit(1);
    }
    const times = parseLog(gh(["run", "view", runId, "--job", String(job.databaseId), "--log"]));
    console.log(`${job.name}: ${Object.keys(times).length} files`);
    fresh[os] = { ...fresh[os], ...times };
  }
  if (Object.keys(fresh).length === 0) {
    console.error(`run ${runId} has no verify or verify-macos job`);
    process.exit(1);
  }
  const merged = mergeTimings(readTimings(ROOT), fresh, testFiles(ROOT));
  writeFileSync(join(ROOT, TIMINGS_PATH), `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`wrote ${TIMINGS_PATH}`);
}
