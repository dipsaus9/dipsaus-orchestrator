// Test daemons never reach the maintainer's runtime directory (DIPO-109). testkit's copy of the
// runtime path limits matches the engine's, a test daemon given `isolatedDaemonEnv` chooses its
// own `DIPO_RUNTIME_DIR` for every temp root testkit accepts (and stays under its temp directory
// when that one is unusable), and every daemon or client test that starts a daemon uses the
// isolated environment and fails on another runtime directory. The runtime directory checks run
// through a guard that throws on any path outside the test's temp directory.

import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

import { chooseRuntimeDir, runtimeCandidates } from "@dipsaus-orchestrator/engine/platform";

/** What `chooseRuntimeDir` throws when no candidate is usable: `RuntimeDirError`. */
interface RuntimeDirRefusal {
  readonly name: string;
  readonly code: string;
  readonly rejected: readonly { readonly path: string; readonly reason: string }[];
}
import {
  guardRuns,
  isolatedDaemonEnv,
  LONGEST_RUNTIME_ENTRY,
  longestTestSocketBytes,
  makeTempDir,
  MAX_TEMP_ROOT_BYTES,
  RUNTIME_PATH_LIMIT,
  TEMP_DIR_TEMPLATE,
  tempRoot,
  tempRootFits,
  testRuntimeDir,
  testTmpDir,
  withTempDir,
} from "@dipsaus-orchestrator/testkit";

type RuntimeDirFs = NonNullable<Parameters<typeof chooseRuntimeDir>[0]["fs"]>;

const uid = process.getuid?.() ?? 0;

/** A file system on which every path is a usable runtime directory; nothing real is touched. */
const usableEverywhere: RuntimeDirFs = {
  lstat: () => ({ isSymbolicLink: false, isDirectory: true, uid, mode: 0o700 }),
  mkdir: () => {},
  mkdtemp: () => {
    throw new Error("no fallback in this test");
  },
};

/** The real file system, refusing any path outside `dir`, so a test can only touch its own files. */
function confinedTo(dir: string): RuntimeDirFs {
  const inside = (path: string) => {
    if (!path.startsWith(`${dir}/`)) throw new Error(`touched ${path}, outside ${dir}`);
    return path;
  };
  return {
    lstat: (path) => {
      try {
        const stat = lstatSync(inside(path));
        return {
          isSymbolicLink: stat.isSymbolicLink(),
          isDirectory: stat.isDirectory(),
          uid: stat.uid,
          mode: stat.mode & 0o777,
        };
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") return null;
        throw error;
      }
    },
    mkdir: (path) => mkdirSync(inside(path), { mode: 0o700 }),
    mkdtemp: (prefix) => mkdtempSync(inside(prefix)),
  };
}

/**
 * Whether a root of exactly `MAX_TEMP_ROOT_BYTES` fits under this suite's temp root: its
 * `dipo-XXXXXX` directory, a slash and at least one byte of padding. The tests that need it are
 * skipped, visibly, under a longer `DIPO_TMP`.
 */
const LONGEST_ROOT_FITS = guardRuns(
  "LONGEST_ROOT_FITS",
  "DIPO_TMP is too long for a root of the longest length the limit allows (DIPO-109)",
  tempRootFits(join(realpathSync(tempRoot()), TEMP_DIR_TEMPLATE, "r")),
);

/** Runs `fn` on a fresh testkit temp directory whose root is exactly as long as testkit allows. */
async function withLongestTempDir(fn: (dir: string) => void): Promise<void> {
  await withTempDir((outer) => {
    const pad = MAX_TEMP_ROOT_BYTES - Buffer.byteLength(outer) - 1;
    if (pad < 1) throw new Error(`no room for a ${MAX_TEMP_ROOT_BYTES}-byte root under ${outer}`);
    const saved = process.env["DIPO_TMP"];
    process.env["DIPO_TMP"] = join(outer, "r".repeat(pad));
    let dir: string;
    try {
      dir = makeTempDir();
    } finally {
      if (saved === undefined) delete process.env["DIPO_TMP"];
      else process.env["DIPO_TMP"] = saved;
    }
    expect(longestTestSocketBytes(dir)).toBe(RUNTIME_PATH_LIMIT);
    return fn(dir);
  });
}

/** Chooses between `path` alone and a fallback that always fails, on `usableEverywhere`. */
function choose(path: string) {
  return chooseRuntimeDir({
    candidates: [{ path, source: "DIPO_RUNTIME_DIR" }],
    uid,
    tmpBase: "/nonexistent",
    fs: usableEverywhere,
  });
}

describe("testkit's runtime path limits", () => {
  it("are the engine's: a directory at the limit is taken, one byte more is refused", () => {
    // `/aaa…` whose longest socket path by testkit's numbers is exactly the limit.
    const atLimit = `/${"a".repeat(RUNTIME_PATH_LIMIT - Buffer.byteLength(LONGEST_RUNTIME_ENTRY) - 2)}`;
    expect(Buffer.byteLength(join(atLimit, LONGEST_RUNTIME_ENTRY))).toBe(RUNTIME_PATH_LIMIT);
    expect(choose(atLimit)).toMatchObject({ path: atLimit, source: "DIPO_RUNTIME_DIR" });

    const over = `${atLimit}a`;
    let error: unknown;
    try {
      choose(over);
    } catch (thrown) {
      error = thrown;
    }
    expect((error as RuntimeDirRefusal).name).toBe("RuntimeDirError");
    // The engine's reason names its own byte count and limit: both must be testkit's.
    expect((error as RuntimeDirRefusal).rejected[0]).toEqual({
      path: over,
      reason: `socket paths would be ${RUNTIME_PATH_LIMIT + 1} bytes, over the ${RUNTIME_PATH_LIMIT}-byte limit`,
    });
  });
});

describe("a test daemon's runtime directory", () => {
  it.skipIf(!LONGEST_ROOT_FITS)(
    "is its DIPO_RUNTIME_DIR for the longest temp root testkit accepts",
    () =>
      withLongestTempDir((dir) => {
        const candidates = runtimeCandidates({ env: isolatedDaemonEnv(dir), uid });
        // Everything but the engine's fixed last resort is under the test's temp directory.
        expect(candidates.slice(0, -1).every((c) => c.path.startsWith(`${dir}/`))).toBe(true);
        expect(candidates.at(-1)).toEqual({ path: `/tmp/dipo-${uid}`, source: "tmp" });

        const choice = chooseRuntimeDir({ candidates, uid, tmpBase: dir, fs: confinedTo(dir) });
        expect(choice).toMatchObject({
          path: testRuntimeDir(dir),
          source: "DIPO_RUNTIME_DIR",
          rejected: [],
        });
      }),
  );

  // DIPO-316: an unusable DIPO_RUNTIME_DIR stops the daemon; it never falls through to another
  // candidate, which outside a test can be the live daemon's runtime directory.
  it.skipIf(!LONGEST_ROOT_FITS)(
    "stops with a coded error, and takes no other candidate, when DIPO_RUNTIME_DIR is unusable",
    () =>
      withLongestTempDir((dir) => {
        mkdirSync(testRuntimeDir(dir), { mode: 0o700 });
        chmodSync(testRuntimeDir(dir), 0o755);
        const env = isolatedDaemonEnv(dir);
        const candidates = runtimeCandidates({ env, uid });
        let error: unknown;
        try {
          chooseRuntimeDir({ candidates, uid, tmpBase: dir, fs: confinedTo(dir), env });
        } catch (thrown) {
          error = thrown;
        }
        expect((error as RuntimeDirRefusal).name).toBe("RuntimeDirError");
        expect((error as RuntimeDirRefusal).code).toBe("paths.runtimeDirUnusable");
        expect((error as RuntimeDirRefusal).rejected).toEqual([
          { path: testRuntimeDir(dir), reason: "its mode is 0755, not 0700" },
        ]);
        expect(existsSync(join(dir, "tmp", "dipo"))).toBe(false);
      }),
  );

  it("keeps the longest root's runtime candidates in the limit, on computed paths (DIPO-191)", () => {
    // The temp directory under a root of exactly MAX_TEMP_ROOT_BYTES, computed and never created,
    // so it runs under any DIPO_TMP, the worker's 30-byte one too.
    const dir = join(`/${"c".repeat(MAX_TEMP_ROOT_BYTES - 1)}`, TEMP_DIR_TEMPLATE);
    expect(longestTestSocketBytes(dir)).toBe(RUNTIME_PATH_LIMIT);
    const env = { DIPO_RUNTIME_DIR: testRuntimeDir(dir), TMPDIR: testTmpDir(dir) };
    const candidates = runtimeCandidates({ env, uid });
    const choice = chooseRuntimeDir({ candidates, uid, tmpBase: dir, fs: usableEverywhere });
    expect(choice).toMatchObject({
      path: testRuntimeDir(dir),
      source: "DIPO_RUNTIME_DIR",
      rejected: [],
    });
  });
});

// A daemon started in process, in any test; or as a process, in any test outside `test/unit`
// (whose tests only name `dipo daemon --foreground` in fake processes and supervisor files).
const STARTS_IN_PROCESS = [/\brunForeground\(/, /\brunDaemon\(\s*\[\s*"--foreground"/];
const STARTS_A_PROCESS = [
  /"daemon",\s*"(--foreground|start|restart)"/,
  /fixtures\/drain-daemon\.ts/,
  /fixtures\/uncaught-daemon\.ts/,
  /fixtures\/scripted-worker-daemon\.ts/,
];
const ISOLATED_ENV = /\b(daemonTestEnv|isolatedDaemonEnv)\(/;
const CHECKS_RUNTIME = /\b(withDaemonTempDir|assertTestRuntimeDir)\(/;
/** A fake source for errors no code caught, so no listener lands on the test runner (DIPO-117). */
const FAKE_UNCAUGHT = /\buncaughtErrors:\s*new EventEmitter\(\)|\buncaughtErrors:\s*uncaught\b/;

function testFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".test.ts"))
    .map((path) => join(root, path));
}

describe("tests that start a daemon", () => {
  it("all use the isolated environment and fail on another runtime directory", () => {
    const packages = resolve(import.meta.dir, "../../..");
    const files = [
      ...testFiles(join(packages, "daemon", "test")),
      ...testFiles(join(packages, "daemon", "src")),
      ...testFiles(join(packages, "client", "test")),
      ...testFiles(join(packages, "client", "src")),
    ].filter((file) => file !== import.meta.path);
    const starting = files.filter((file) => {
      const source = readFileSync(file, "utf8");
      // One daemon start in a file is enough to require the isolation.
      const patterns = file.includes("/test/unit/")
        ? STARTS_IN_PROCESS
        : [...STARTS_IN_PROCESS, ...STARTS_A_PROCESS];
      return patterns.some((pattern) => pattern.test(source));
    });
    const names = starting.map((file) => relative(packages, file));
    // The scan sees the known daemon tests, so a pattern that stopped matching shows up here.
    expect(names).toEqual(
      expect.arrayContaining([
        "client/test/integration/daemon.test.ts",
        "client/test/integration/lifecycle.ci.test.ts",
        "daemon/test/integration/crash-loop.test.ts",
        "daemon/test/integration/db-close.ci.test.ts",
        "daemon/test/integration/drain.ci.test.ts",
        "daemon/test/integration/foreground.ci.test.ts",
        "daemon/test/integration/reattach-kill.ci.test.ts",
        "daemon/test/integration/reconcile.ci.test.ts",
        "daemon/test/integration/upgrade-restart.test.ts",
        "daemon/src/foreground-bootout.test.ts",
        "daemon/src/index.test.ts",
      ]),
    );
    const unisolated = starting.filter((file) => {
      const source = readFileSync(file, "utf8");
      return !ISOLATED_ENV.test(source) || !CHECKS_RUNTIME.test(source);
    });
    expect(unisolated.map((file) => relative(packages, file))).toEqual([]);
  });

  it("in this process all pass a fake source for uncaught errors", () => {
    const packages = resolve(import.meta.dir, "../../..");
    const files = ["daemon", "client", "cli"]
      .flatMap((name) => [join(packages, name, "test"), join(packages, name, "src")])
      .filter((root) => existsSync(root))
      .flatMap((root) => testFiles(root))
      .filter((file) => file !== import.meta.path);
    const inProcess = files.filter((file) => {
      const source = readFileSync(file, "utf8");
      return STARTS_IN_PROCESS.some((pattern) => pattern.test(source));
    });
    const names = inProcess.map((file) => relative(packages, file));
    expect(names).toEqual(
      expect.arrayContaining([
        "daemon/test/integration/crash-loop.test.ts",
        "daemon/test/integration/uncaught-error.test.ts",
        "daemon/test/integration/upgrade-restart.test.ts",
        "daemon/src/foreground-bootout.test.ts",
        "daemon/src/index.test.ts",
      ]),
    );
    const listening = inProcess.filter((file) => !FAKE_UNCAUGHT.test(readFileSync(file, "utf8")));
    expect(listening.map((file) => relative(packages, file))).toEqual([]);
  });
});
