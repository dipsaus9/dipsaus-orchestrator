import { describe, expect, it } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { withTempRepo } from "../packages/testkit/src/index";
import {
  assertCovered,
  CI_TEST_TIMEOUT_MS,
  LOCAL_TEST_TIMEOUT_MS,
  localTimes,
  planShards,
  shardCount,
  testArgs,
  testTimeout,
  timingKey,
} from "./test";
import { coverage, readTimings, testFiles } from "./test-shards";

const ROOT = resolve(import.meta.dir, "..");
const SCRIPT = join(import.meta.dir, "test.ts");

describe("the test runner's per-test timeout (DIPO-335)", () => {
  it("gives every test 30 s in CI and keeps Bun's 5 s elsewhere", () => {
    expect(CI_TEST_TIMEOUT_MS).toBe(30_000);
    expect(LOCAL_TEST_TIMEOUT_MS).toBe(5_000);
    expect(testTimeout({ DIPO_TEST_CI: "1" })).toBe(30_000);
    for (const value of [undefined, "", "0", "true"]) {
      expect(testTimeout({ DIPO_TEST_CI: value })).toBe(5_000);
    }
  });

  it("passes the timeout on the command line and keeps the caller's arguments", () => {
    expect(testArgs(["packages/engine"], { DIPO_TEST_CI: "1" })).toEqual([
      "test",
      "--timeout=30000",
      "packages/engine",
    ]);
    expect(testArgs([], {})).toEqual(["test", "--timeout=5000"]);
  });
});

describe("the local test shards (DIPO-337)", () => {
  it("start half the cores, rounded down, at least 2", () => {
    expect(shardCount(1)).toBe(2);
    expect(shardCount(3)).toBe(2);
    expect(shardCount(4)).toBe(2);
    expect(shardCount(14)).toBe(7);
    expect(shardCount()).toBeGreaterThanOrEqual(2);
  });

  it("take the times of the OS: macOS on darwin, Linux elsewhere", () => {
    expect(timingKey("darwin")).toBe("macOS");
    expect(timingKey("linux")).toBe("Linux");
    const files = ["a.test.ts", "b.test.ts", "c.test.ts"];
    const timings = {
      macOS: { "a.test.ts": 100, "b.test.ts": 1, "c.test.ts": 1 },
      Linux: { "a.test.ts": 1, "b.test.ts": 100, "c.test.ts": 1 },
    };
    // The slow file of the OS gets a shard of its own.
    expect(planShards(files, timings, 2, {}, "darwin")[0]?.files).toEqual(["a.test.ts"]);
    expect(planShards(files, timings, 2, {}, "linux")[0]?.files).toEqual(["b.test.ts"]);
  });

  it("split evenly by file count for an OS without times", () => {
    const files = ["a", "b", "c", "d", "e", "f"].map((name) => `${name}.test.ts`);
    const shards = planShards(files, { Linux: { "a.test.ts": 999 } }, 3, {}, "darwin");
    expect(shards.map((shard) => shard.files.length)).toEqual([2, 2, 2]);
  });

  it("count a CI-only file as no time outside CI, where it registers no test", () => {
    const times = { "a.ci.test.ts": 900, "b.test.ts": 10 };
    expect(localTimes(times, {})).toEqual({ "a.ci.test.ts": 0, "b.test.ts": 10 });
    expect(localTimes(times, { DIPO_TEST_CI: "1" })).toEqual(times);
  });

  it("hold every test file of the repository exactly once, on either OS, in or out of CI", () => {
    const files = testFiles(ROOT);
    const timings = readTimings(ROOT);
    for (const platform of ["darwin", "linux"] as const) {
      for (const env of [{}, { DIPO_TEST_CI: "1" }]) {
        const shards = planShards(files, timings, shardCount(), env, platform);
        expect(
          coverage(
            files,
            shards.map((shard) => shard.files),
          ),
        ).toEqual({ missing: [], duplicated: [] });
      }
    }
  });

  it("are refused before they start when a file is in no shard or in two", () => {
    const files = ["a.test.ts", "b.test.ts", "c.test.ts"];
    expect(() =>
      assertCovered(files, [
        { files: ["a.test.ts", "b.test.ts"], ms: 0 },
        { files: ["b.test.ts"], ms: 0 },
      ]),
    ).toThrow("c.test.ts is in no shard\nb.test.ts is in more than one shard");
    expect(() =>
      assertCovered(files, [
        { files: ["a.test.ts"], ms: 0 },
        { files: ["b.test.ts", "c.test.ts"], ms: 0 },
      ]),
    ).not.toThrow();
  });
});

/** Runs `bun <args>` in `cwd` with `env` added, and returns its exit code and output. */
async function run(
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<{ code: number; out: string }> {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd,
    env: { ...process.env, DIPO_TEST_CI: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, out: `${stdout}${stderr}` };
}

/** A test file that notes in RAN_LOG its name and its DIPO_TMP, and fails when `fail` is set. */
function testFile(name: string, fail = false): string {
  return (
    `import { expect, it } from "bun:test";\nimport { appendFileSync } from "node:fs";\n` +
    `it("${name} runs", () => {\n` +
    `  appendFileSync(process.env["RAN_LOG"] ?? "", \`${name} \${process.env["DIPO_TMP"]}\\n\`);\n` +
    `  expect(${fail ? "1" : "0"}).toBe(0);\n});\n`
  );
}

describe("bun run test on a repository", () => {
  it("runs every file once in parallel shards, each with its own DIPO_TMP, and fails with a failing shard", async () => {
    await withTempRepo(async (repo) => {
      // x/t/a.test.ts holds t/a.test.ts in its path, so a filter on file names would run it twice.
      const names = ["t/a", "t/b", "t/c", "t/d", "x/t/a", "t/bad"];
      for (const name of names) {
        await Bun.write(join(repo.dir, `${name}.test.ts`), testFile(name, name === "t/bad"));
      }
      await repo.commitAll("tests");
      // A test file not yet added to git runs too, as under a plain `bun test`.
      await Bun.write(join(repo.dir, "t/new.test.ts"), testFile("t/new"));
      const all = [...names, "t/new"];
      const log = join(repo.root, "ran.log");
      const failing = await run([SCRIPT], repo.dir, { DIPO_TMP: repo.root, RAN_LOG: log });
      expect(failing.code).not.toBe(0);
      const ran = readFileSync(log, "utf8").split("\n").filter(Boolean);
      expect(ran.map((line) => line.split(" ")[0]).toSorted()).toEqual(all.toSorted());
      // Each shard has its own DIPO_TMP, <DIPO_TMP>/s<n>, and there are at least two.
      const tmps = new Map(ran.map((line) => [line.split(" ")[0], line.split(" ")[1] ?? ""]));
      for (const tmp of tmps.values()) expect(tmp).toMatch(new RegExp(`^${repo.root}/s\\d+$`));
      expect(new Set(tmps.values()).size).toBeGreaterThanOrEqual(2);
      // The failing test is named, led by its shard.
      const shard = /\/s(\d+)$/.exec(tmps.get("t/bad") ?? "")?.[1];
      expect(failing.out).toMatch(new RegExp(`\\[shard ${shard}/\\d+\\] \\(fail\\) t/bad runs`));
      expect(failing.out).toMatch(new RegExp(`\\[shard ${shard}/\\d+\\] FAILED`));

      rmSync(join(repo.dir, "t/bad.test.ts"));
      rmSync(log);
      const passing = await run([SCRIPT], repo.dir, { DIPO_TMP: repo.root, RAN_LOG: log });
      expect(passing.code).toBe(0);
      expect(passing.out).toContain("shards passed");
      expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toHaveLength(all.length - 1);
    });
  }, 30_000);

  it("runs just the files it is given, in one bun test, never in shards", async () => {
    await withTempRepo(async (repo) => {
      for (const name of ["t/a", "t/b", "x/t/a"]) {
        await Bun.write(join(repo.dir, `${name}.test.ts`), testFile(name));
      }
      await repo.commitAll("tests");
      const log = join(repo.root, "ran.log");
      for (const args of [
        [SCRIPT, "./t/a.test.ts"],
        ["test", "./t/a.test.ts"],
      ]) {
        rmSync(log, { force: true });
        const one = await run(args, repo.dir, { DIPO_TMP: repo.root, RAN_LOG: log });
        expect(one.code).toBe(0);
        expect(one.out).not.toContain("shard");
        // The file sees the caller's DIPO_TMP, not a shard's.
        expect(readFileSync(log, "utf8")).toBe(`t/a ${repo.root}\n`);
      }
      // In CI too: a shard job's file list runs once, as given.
      rmSync(log);
      const ci = await run([SCRIPT, "./t/a.test.ts", "./t/b.test.ts"], repo.dir, {
        DIPO_TEST_CI: "1",
        DIPO_TMP: repo.root,
        RAN_LOG: log,
      });
      expect(ci.code).toBe(0);
      expect(ci.out).not.toContain("shard");
      expect(readFileSync(log, "utf8").split("\n").filter(Boolean).toSorted()).toEqual([
        `t/a ${repo.root}`,
        `t/b ${repo.root}`,
      ]);
    });
  }, 30_000);
});
