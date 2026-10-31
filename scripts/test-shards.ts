// CI runs `bun test` in parallel shards (0016, DIPO-406): the `verify` and `verify-macos` jobs are
// matrices whose every shard runs one list of test files, split here by the per-file times in
// scripts/test-timings.json (refreshed by scripts/test-timings.ts). Locally `bun run verify` still
// runs every file in one `bun test`.
//
//   bun scripts/test-shards.ts run <os> <shard> <total>   runs shard <shard> of <total> for <os>
//   bun scripts/test-shards.ts check                      the coverage check of the test-shards job
//
// Both run on the repository in the working directory.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Where the per-file times live, relative to the repository root. */
export const TIMINGS_PATH = "scripts/test-timings.json";

/** Per OS (`RUNNER_OS`: `Linux`, `macOS`), each test file's time in milliseconds. */
export type TimingFile = Record<string, Record<string, number>>;

/** The sharded jobs of ci.yml and the `RUNNER_OS` each runs on. */
export const SHARDED_JOBS: Readonly<Record<string, string>> = {
  verify: "Linux",
  "verify-macos": "macOS",
};

/** The file names `bun test` takes as test files. */
const TEST_FILE = /(\.test|_test|\.spec|_spec)\.[cm]?[jt]sx?$/;

/** Whether `bun test` takes the repository path `path` as a test file. */
export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path) && !path.split("/").includes("node_modules");
}

/** Every tracked test file under `root`, sorted. */
export function testFiles(root: string): string[] {
  const listed = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root, stdout: "pipe" });
  if (listed.exitCode !== 0) throw new Error("git ls-files failed");
  return listed.stdout
    .toString()
    .split("\0")
    .filter((path) => path !== "" && isTestFile(path))
    .toSorted();
}

/** Reads the timing file, or `{}` when there is none. */
export function readTimings(root: string): TimingFile {
  try {
    return JSON.parse(readFileSync(join(root, TIMINGS_PATH), "utf8")) as TimingFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

/** The index of the smallest load, the first on a tie. */
function lightest(loads: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < loads.length; i++) if ((loads[i] ?? 0) < (loads[best] ?? 0)) best = i;
  return best;
}

export interface Shard {
  /** The files of the shard, sorted. */
  readonly files: string[];
  /** Their expected time in milliseconds. */
  readonly ms: number;
}

/**
 * Splits `files` into `total` shards of about equal time: the files with a time, slowest first,
 * each go to the shard with the least time so far; then each file missing from `times` goes to the
 * shard with the least time, counted at the mean time of the known files.
 */
export function splitShards(
  files: readonly string[],
  times: Readonly<Record<string, number>>,
  total: number,
): Shard[] {
  if (!Number.isInteger(total) || total < 1) throw new Error(`bad shard count ${total}`);
  const known = files.filter((file) => Object.hasOwn(times, file));
  const unknown = files.filter((file) => !Object.hasOwn(times, file)).toSorted();
  known.sort((a, b) => (times[b] ?? 0) - (times[a] ?? 0) || (a < b ? -1 : a > b ? 1 : 0));
  const sum = known.reduce((acc, file) => acc + (times[file] ?? 0), 0);
  const estimate = known.length === 0 ? 1000 : sum / known.length;
  const lists: string[][] = Array.from({ length: total }, () => []);
  const loads: number[] = Array.from({ length: total }, () => 0);
  const queue = [
    ...known.map((name) => [name, times[name] ?? 0] as const),
    ...unknown.map((name) => [name, estimate] as const),
  ];
  for (const [file, ms] of queue) {
    const i = lightest(loads);
    lists[i]?.push(file);
    loads[i] = (loads[i] ?? 0) + ms;
  }
  return lists.map((list, i) => ({ files: list.toSorted(), ms: Math.round(loads[i] ?? 0) }));
}

/** The files in no shard and the files in more than one. */
export function coverage(
  files: readonly string[],
  shards: readonly (readonly string[])[],
): { missing: string[]; duplicated: string[] } {
  const seen = new Map<string, number>();
  for (const shard of shards) for (const file of shard) seen.set(file, (seen.get(file) ?? 0) + 1);
  return {
    missing: files.filter((file) => !seen.has(file)),
    duplicated: [...seen].filter(([, count]) => count > 1).map(([file]) => file),
  };
}

interface Job {
  "runs-on"?: string;
  strategy?: { matrix?: { shard?: unknown } };
  steps?: { run?: string; env?: Record<string, unknown> }[];
}

/** The command every shard runs, on its own OS. */
export const SHARD_RUN = 'bun scripts/test-shards.ts run "$RUNNER_OS" "$SHARD" "$SHARDS"';

/** The environment of that step: the shard's matrix value and the matrix size. */
export const SHARD_ENV = { SHARD: "${{ matrix.shard }}", SHARDS: "${{ strategy.job-total }}" };

/**
 * Checks the sharded jobs of the workflow text `flowText`: each has a matrix of at least three
 * `shard` values and a step that runs `SHARD_RUN` with `SHARD_ENV`, and the shards its matrix runs
 * hold every test file in `files` exactly once. Returns the problems (none when it holds) and a
 * line per shard.
 */
export function checkShards(
  flowText: string,
  files: readonly string[],
  timings: TimingFile,
): { problems: string[]; report: string[] } {
  const flow = Bun.YAML.parse(flowText) as { jobs?: Record<string, Job> };
  const problems: string[] = [];
  const report: string[] = [];
  for (const [id, os] of Object.entries(SHARDED_JOBS)) {
    const job = flow.jobs?.[id];
    if (job === undefined) {
      problems.push(`${id}: no such job`);
      continue;
    }
    const values: unknown[] = Array.isArray(job.strategy?.matrix?.shard)
      ? (job.strategy?.matrix?.shard as unknown[])
      : [];
    // Each shard runs the shard of its matrix value out of as many as the matrix has.
    const total = values.length;
    if (total < 3) problems.push(`${id}: matrix.shard has ${total} shards, fewer than 3`);
    const step = (job.steps ?? []).find((each) => each.run === SHARD_RUN);
    if (step === undefined || !Bun.deepEquals(step.env, SHARD_ENV)) {
      problems.push(`${id}: no step runs ${SHARD_RUN} with SHARD and SHARDS from the matrix`);
    }
    if (total === 0) continue;
    const times = timings[os] ?? {};
    const split = splitShards(files, times, total);
    const shards = values.map((value) =>
      typeof value === "number" ? (split[value - 1] ?? { files: [], ms: 0 }) : { files: [], ms: 0 },
    );
    const { missing, duplicated } = coverage(
      files,
      shards.map((shard) => shard.files),
    );
    for (const file of missing) problems.push(`${id}: ${file} is in no shard`);
    for (const file of duplicated) problems.push(`${id}: ${file} is in more than one shard`);
    const untimed = files.filter((file) => !Object.hasOwn(times, file)).length;
    report.push(`${id} (${os}): ${files.length} files, ${untimed} without a time`);
    shards.forEach((shard, i) => {
      report.push(
        `  shard ${String(values[i])}/${total}: ${shard.files.length} files, ${(shard.ms / 1000).toFixed(0)} s`,
      );
    });
  }
  return { problems, report };
}

/** The CLI, on the repository at `root` (the working directory). */
export async function main(args: string[], root: string = process.cwd()): Promise<number> {
  const [command, ...rest] = args;
  if (command === "check") {
    const flowText = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    const { problems, report } = checkShards(flowText, testFiles(root), readTimings(root));
    for (const line of report) console.log(line);
    for (const line of problems) console.error(line);
    return problems.length === 0 ? 0 : 1;
  }
  if (command === "run" && rest.length === 3) {
    const [os = "", shardText = "", totalText = ""] = rest;
    const shard = Number(shardText);
    const total = Number(totalText);
    if (!Number.isInteger(shard) || shard < 1 || shard > total) {
      console.error(`bad shard ${shardText} of ${totalText}`);
      return 2;
    }
    const picked = splitShards(testFiles(root), readTimings(root)[os] ?? {}, total)[shard - 1];
    const files = picked?.files ?? [];
    console.log(
      `${os} shard ${shard}/${total}: ${files.length} files, ${((picked?.ms ?? 0) / 1000).toFixed(0)} s expected`,
    );
    // `bun test` with no path runs every file, so an empty shard runs nothing.
    if (files.length === 0) return 0;
    // Through `bun run test`, the test step of `bun run verify`: its CI timeout, and the PATH of
    // `bun run`, which holds the repository's own CLIs (Backlog's among them). A leading ./ makes
    // each argument one file, never a filter on file names.
    const paths = files.map((file) => `./${file}`);
    const child = Bun.spawn([process.execPath, "run", "test", ...paths], {
      cwd: root,
      stdio: ["inherit", "inherit", "inherit"],
    });
    return await child.exited;
  }
  console.error(
    "usage: bun scripts/test-shards.ts run <os> <shard> <total> | bun scripts/test-shards.ts check",
  );
  return 2;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
