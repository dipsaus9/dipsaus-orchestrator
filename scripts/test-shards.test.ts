// The CI test shards (0016, DIPO-406): the split by recorded time, the coverage check on ci.yml as
// it is in the repository and on broken copies of it, and a real `bun test` of each shard of a
// temporary repository.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { withTempRepo } from "../packages/testkit/src/index";
import {
  checkShards,
  coverage,
  isTestFile,
  readTimings,
  SHARD_RUN,
  splitShards,
  testFiles,
  TIMINGS_PATH,
  type TimingFile,
} from "./test-shards";

const ROOT = resolve(import.meta.dir, "..");
const SCRIPT = join(import.meta.dir, "test-shards.ts");
const FLOW = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");

describe("the test files", () => {
  it("are the file names bun test takes, outside node_modules", () => {
    for (const path of ["a.test.ts", "x/b_test.tsx", "c.spec.js", "d_spec.mjs", "e.test.cts"]) {
      expect(isTestFile(path)).toBe(true);
    }
    for (const path of [
      "a.ts",
      "test.ts",
      "a.test.md",
      "node_modules/x/a.test.ts",
      "a.test.ts.snap",
    ]) {
      expect(isTestFile(path)).toBe(false);
    }
  });

  it("are every tracked test file of the repository", () => {
    const files = testFiles(ROOT);
    expect(files).toContain("scripts/test.test.ts");
    expect(files.length).toBeGreaterThan(500);
    expect(files).toEqual(files.toSorted());
  });
});

describe("splitShards", () => {
  const times = { "a.test.ts": 100, "b.test.ts": 60, "c.test.ts": 50, "d.test.ts": 10 };

  it("puts the slowest files first, each on the shard with the least time", () => {
    const shards = splitShards(Object.keys(times), times, 2);
    // a (100) and b (60) open the two shards, c (50) joins b, d (10) joins a.
    expect(shards).toEqual([
      { files: ["a.test.ts", "d.test.ts"], ms: 110 },
      { files: ["b.test.ts", "c.test.ts"], ms: 110 },
    ]);
  });

  it("gives a file missing from the times to the shard with the least time", () => {
    const files = [...Object.keys(times), "new.test.ts"];
    const shards = splitShards(files, times, 2);
    // Both shards have 110 ms, so the new file joins the first, counted at the mean of 55 ms.
    expect(shards[0]).toEqual({ files: ["a.test.ts", "d.test.ts", "new.test.ts"], ms: 165 });
    expect(shards[1]).toEqual({ files: ["b.test.ts", "c.test.ts"], ms: 110 });
    // Several new files spread over the shards instead of piling on one.
    const many = splitShards(["n1.test.ts", "n2.test.ts", "n3.test.ts"], {}, 3);
    expect(many.map((shard) => shard.files.length)).toEqual([1, 1, 1]);
  });

  it("ignores times of files that are gone and is the same for the same input", () => {
    const shards = splitShards(["b.test.ts", "a.test.ts"], { ...times, "gone.test.ts": 999 }, 3);
    expect(shards.flatMap((shard) => shard.files).toSorted()).toEqual(["a.test.ts", "b.test.ts"]);
    expect(splitShards(["b.test.ts", "a.test.ts"], times, 3)).toEqual(shards);
  });

  it("refuses a shard count that is not a positive whole number", () => {
    for (const total of [0, -1, 1.5, Number.NaN]) {
      expect(() => splitShards(["a.test.ts"], {}, total)).toThrow();
    }
  });
});

describe("coverage", () => {
  it("finds a file in no shard and a file in two", () => {
    expect(coverage(["a", "b", "c"], [["a"], ["b", "c"]])).toEqual({ missing: [], duplicated: [] });
    expect(coverage(["a", "b", "c"], [["a", "b"], ["b"]])).toEqual({
      missing: ["c"],
      duplicated: ["b"],
    });
  });
});

/** ci.yml with `from` replaced by `to`, which must be in it once. */
function edited(from: string, to: string): string {
  expect(FLOW.split(from)).toHaveLength(2);
  return FLOW.replace(from, to);
}

describe("the coverage check of the test-shards job", () => {
  const files = testFiles(ROOT);
  const timings = readTimings(ROOT);

  it("passes ci.yml as it is, with every test file in exactly one shard per OS", () => {
    const { problems, report } = checkShards(FLOW, files, timings);
    expect(problems).toEqual([]);
    expect(report.join("\n")).toContain("verify (Linux)");
    expect(report.join("\n")).toContain("verify-macos (macOS)");
  });

  it("has a time for most files on both OS", () => {
    for (const os of ["Linux", "macOS"]) {
      const timed = files.filter((file) => Object.hasOwn(timings[os] ?? {}, file));
      expect(timed.length).toBeGreaterThan(files.length * 0.9);
    }
  });

  it("fails when a shard runs twice or not at all", () => {
    const twice = checkShards(edited("shard: [1, 2, 3]\n", "shard: [1, 2, 2]\n"), files, timings);
    expect(twice.problems.some((line) => line.endsWith("is in no shard"))).toBe(true);
    expect(twice.problems.some((line) => line.endsWith("is in more than one shard"))).toBe(true);
    const beyond = checkShards(
      edited("shard: [1, 2, 3, 4]\n", "shard: [1, 2, 3, 5]\n"),
      files,
      timings,
    );
    expect(beyond.problems.some((line) => line.startsWith("verify-macos: "))).toBe(true);
    expect(beyond.problems.some((line) => line.endsWith("is in no shard"))).toBe(true);
  });

  it("fails on fewer than three shards", () => {
    const { problems } = checkShards(
      edited("shard: [1, 2, 3]\n", "shard: [1, 2]\n"),
      files,
      timings,
    );
    expect(problems).toContain("verify: matrix.shard has 2 shards, fewer than 3");
  });

  it("fails when a sharded job runs something else or loses its shard numbers", () => {
    const flow = Bun.YAML.parse(FLOW) as {
      jobs: Record<string, { steps: { run?: string; env?: Record<string, string> }[] }>;
    };
    for (const id of ["verify", "verify-macos"]) {
      const step = flow.jobs[id]?.steps.find((each) => each.run === SHARD_RUN);
      expect(step?.env).toEqual({
        SHARD: "${{ matrix.shard }}",
        SHARDS: "${{ strategy.job-total }}",
      });
    }
    const other = checkShards(FLOW.replaceAll(SHARD_RUN, "bun test"), files, timings);
    expect(other.problems).toHaveLength(2);
    const lost = checkShards(
      FLOW.replaceAll("SHARDS: ${{ strategy.job-total }}", "SHARDS: 3"),
      files,
      timings,
    );
    expect(lost.problems).toHaveLength(2);
  });

  it("fails when a sharded job is gone", () => {
    const { problems } = checkShards("jobs: {}\n", files, timings);
    expect(problems).toEqual(["verify: no such job", "verify-macos: no such job"]);
  });
});

describe("a shard's bun test", () => {
  it("runs exactly its own files, and the shards together run each file once", async () => {
    await withTempRepo(async (repo) => {
      // Each file notes in RAN_LOG that it ran. x/t/a.test.ts holds t/a.test.ts in its path, so a
      // filter on file names would run it twice.
      const names = ["t/a", "t/b", "t/c", "t/d", "t/e", "x/t/a"];
      for (const name of names) {
        await Bun.write(
          join(repo.dir, `${name}.test.ts`),
          `import { it } from "bun:test";\nimport { appendFileSync } from "node:fs";\n` +
            `it("runs", () => appendFileSync(process.env["RAN_LOG"] ?? "", "${name}\\n"));\n`,
        );
      }
      const log = join(repo.root, "ran.log");
      const timings: TimingFile = { Linux: { "t/a.test.ts": 50, "t/b.test.ts": 40 } };
      await Bun.write(join(repo.dir, TIMINGS_PATH), JSON.stringify(timings));
      await repo.commitAll("tests");
      for (const shard of ["1", "2", "3"]) {
        const child = Bun.spawn([process.execPath, SCRIPT, "run", "Linux", shard, "3"], {
          cwd: repo.dir,
          env: { ...process.env, DIPO_TEST_CI: "", RAN_LOG: log },
          stdout: "pipe",
          stderr: "pipe",
        });
        const out = `${await new Response(child.stdout).text()}${await new Response(child.stderr).text()}`;
        expect(await child.exited).toBe(0);
        expect(out).toContain(`Linux shard ${shard}/3: 2 files`);
      }
      const ran = readFileSync(log, "utf8").split("\n").filter(Boolean);
      expect(ran.toSorted()).toEqual(names.toSorted());
    });
  }, 30_000);

  it("refuses a shard outside 1..total", async () => {
    for (const args of [
      ["0", "3"],
      ["4", "3"],
      ["x", "3"],
    ]) {
      const child = Bun.spawn([process.execPath, SCRIPT, "run", "Linux", ...args], {
        cwd: ROOT,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await child.exited).toBe(2);
    }
  });
});
