// `bun run test` (and the test step of `bun run verify`): runs `bun test` with the per-test timeout
// for where it runs. In CI (`DIPO_TEST_CI=1`) a test that sets no timeout of its own gets 30 s, since
// the CI runners (the macOS one most) are much slower than a developer machine; elsewhere Bun's own
// 5 s stays (DIPO-335). The timeout goes on the command line because a `setDefaultTimeout` in a
// preload reaches only the first test file of a run, and one in a test file only that file.
//
// With no arguments it runs every test file in parallel shards, one `bun test` per shard, split by
// `splitShards` of scripts/test-shards.ts as CI's shards are (DIPO-337, 0001). With arguments (CI's
// shard step passes `./file` paths) it runs one `bun test` on them, so a shard never shards again.

import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";

import { coverage, readTimings, type Shard, splitShards, testFiles } from "./test-shards";

/** The per-test timeout in CI, for every test that sets none of its own. */
export const CI_TEST_TIMEOUT_MS = 30_000;

/** Bun's own default per-test timeout. */
export const LOCAL_TEST_TIMEOUT_MS = 5_000;

type Env = Record<string, string | undefined>;

/** The per-test timeout `env` asks for: 30 s in CI, else Bun's 5 s. */
export function testTimeout(env: Env = process.env): number {
  return env["DIPO_TEST_CI"] === "1" ? CI_TEST_TIMEOUT_MS : LOCAL_TEST_TIMEOUT_MS;
}

/** The `bun test` arguments for `args` (the caller's own, kept) under `env`. */
export function testArgs(args: readonly string[], env: Env = process.env): string[] {
  return ["test", `--timeout=${testTimeout(env)}`, ...args];
}

/** The key of scripts/test-timings.json for `platform`: `macOS` on darwin, else `Linux`. */
export function timingKey(platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" ? "macOS" : "Linux";
}

/** How many shards a run starts: half the cores, rounded down, at least 2 (DIPO-424). */
export function shardCount(cores: number = availableParallelism()): number {
  return Math.max(2, Math.floor(cores / 2));
}

/**
 * The time of each file in `times` for a run under `env`. Outside CI a `*.ci.test.ts` file
 * registers no test (0017), so it counts as no time there, whatever CI recorded for it.
 */
export function localTimes(
  times: Readonly<Record<string, number>>,
  env: Env,
): Record<string, number> {
  if (env["DIPO_TEST_CI"] === "1") return { ...times };
  return Object.fromEntries(
    Object.entries(times).map(([file, ms]) => [file, file.endsWith(".ci.test.ts") ? 0 : ms]),
  );
}

/** Throws unless `shards` hold every file in `files` exactly once. */
export function assertCovered(files: readonly string[], shards: readonly Shard[]): void {
  const { missing, duplicated } = coverage(
    files,
    shards.map((shard) => shard.files),
  );
  if (missing.length === 0 && duplicated.length === 0) return;
  throw new Error(
    [
      ...missing.map((file) => `${file} is in no shard`),
      ...duplicated.map((file) => `${file} is in more than one shard`),
    ].join("\n"),
  );
}

/** The shards of a run of `files` under `env` on `platform`, checked to hold each file once. */
export function planShards(
  files: readonly string[],
  timings: Readonly<Record<string, Record<string, number>>>,
  total: number,
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): Shard[] {
  const shards = splitShards(files, localTimes(timings[timingKey(platform)] ?? {}, env), total);
  assertCovered(files, shards);
  return shards;
}

/** A line of `bun test` output that names a failing test. */
const FAIL_LINE = /^\(fail\) /;

interface ShardResult {
  readonly code: number;
  readonly output: string;
}

/** Runs one shard's files in one `bun test`, its output (stdout and stderr in order) in `log`. */
async function runShard(
  files: readonly string[],
  tmp: string,
  log: string,
  env: Env,
  root: string,
): Promise<ShardResult> {
  mkdirSync(tmp, { recursive: true });
  const fd = openSync(log, "w");
  try {
    // A leading ./ makes each argument one file, never a filter on file names.
    const child = Bun.spawn(
      [
        process.execPath,
        ...testArgs(
          files.map((file) => `./${file}`),
          env,
        ),
      ],
      { cwd: root, env: { ...env, DIPO_TMP: tmp }, stdin: "ignore", stdout: fd, stderr: fd },
    );
    const code = await child.exited;
    return { code: child.signalCode === null ? code : 1, output: readFileSync(log, "utf8") };
  } finally {
    closeSync(fd);
  }
}

/** `lines` joined, each led by `prefix`. */
function prefixed(prefix: string, lines: readonly string[]): string {
  return lines.map((line) => `${prefix}${line}`).join("\n");
}

/**
 * Runs every test file of the repository at `root` in `total` parallel shards, each with its own
 * `DIPO_TMP` (`<DIPO_TMP>/s<n>`), and returns 0 when every shard passed. Each shard prints its
 * whole output once it is done, each line led by the shard's number, and the failing tests are
 * named again at the end.
 */
export async function runShards(
  root: string,
  env: Env = process.env,
  total: number = shardCount(),
): Promise<number> {
  const files = testFiles(root);
  const shards = planShards(
    files,
    readTimings(root),
    Math.min(total, Math.max(2, files.length)),
    env,
  );
  const configured = env["DIPO_TMP"];
  // Without a DIPO_TMP of the caller's, the shards' folders go in a fresh one under /tmp.
  const base = configured !== undefined && configured !== "" ? configured : mkdtempSync("/tmp/d.");
  mkdirSync(base, { recursive: true });
  const keep = env["DIPO_TEST_KEEP"] === "1";
  const started = performance.now();
  console.log(`bun run test: ${files.length} files in ${shards.length} parallel shards`);
  const results = await Promise.all(
    shards.map(async (shard, i) => {
      const n = i + 1;
      const tag = `[shard ${n}/${shards.length}] `;
      // `bun test` with no path runs every file, so an empty shard runs nothing.
      if (shard.files.length === 0) return { n, tag, code: 0, fails: [] as string[] };
      const tmp = join(base, `s${n}`);
      const log = join(base, `s${n}.log`);
      const at = performance.now();
      const { code, output } = await runShard(shard.files, tmp, log, env, root);
      const seconds = ((performance.now() - at) / 1000).toFixed(1);
      const lines = output.replace(/\n$/, "").split("\n");
      const status = code === 0 ? "passed" : `FAILED (exit ${code})`;
      console.log(`${tag}${status}: ${shard.files.length} files in ${seconds} s`);
      console.log(prefixed(tag, lines));
      if (!keep) rmSync(tmp, { recursive: true, force: true });
      if (!keep) rmSync(log, { force: true });
      return { n, tag, code, fails: lines.filter((line) => FAIL_LINE.test(line)) };
    }),
  );
  if (!keep && base !== configured) rmSync(base, { recursive: true, force: true });
  const failed = results.filter((result) => result.code !== 0);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  if (failed.length === 0) {
    console.log(`bun run test: all ${shards.length} shards passed in ${seconds} s`);
    return 0;
  }
  console.log(
    `bun run test: ${failed.length} of ${shards.length} shards failed in ${seconds} s (${failed.map((result) => result.n).join(", ")})`,
  );
  for (const result of failed)
    if (result.fails.length > 0) console.log(prefixed(result.tag, result.fails));
  return 1;
}

/** The CLI: `args` given, one `bun test` on them; none, every test file in parallel shards. */
export async function main(
  args: readonly string[],
  root: string = process.cwd(),
  env: Env = process.env,
): Promise<number> {
  if (args.length === 0) return runShards(root, env);
  const child = Bun.spawn([process.execPath, ...testArgs(args, env)], {
    cwd: root,
    env,
    stdio: ["inherit", "inherit", "inherit"],
  });
  return await child.exited;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
