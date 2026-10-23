import { describe, expect, it } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";

import {
  assertTestRuntimeDir,
  isolatedDaemonEnv,
  longestTestSocketBytes,
  MAX_TEMP_ROOT_BYTES,
  RUNTIME_PATH_LIMIT,
  runtimeChoices,
  testRuntimeCandidates,
} from "./runtime";
import { withTempDir } from "./temp";

const chosen = (path: string, source: string) =>
  JSON.stringify({ level: "info", msg: "runtime directory chosen", path, source });

describe("isolatedDaemonEnv", () => {
  it("puts state, runtime and temp directories under the test directory", () =>
    withTempDir((dir) => {
      expect(isolatedDaemonEnv(dir)).toEqual({
        DIPO_TEST: "1",
        DIPO_HOME: join(dir, "state"),
        DIPO_RUNTIME_DIR: join(dir, "run"),
        TMPDIR: join(dir, "tmp"),
        XDG_RUNTIME_DIR: join(dir, "tmp"),
        DIPO_TMP: dir,
      });
      // `$TMPDIR/dipo` must be creatable, or the daemon would pass on to `/tmp/dipo-<uid>`.
      expect(statSync(join(dir, "tmp")).isDirectory()).toBe(true);
      expect(testRuntimeCandidates(dir)).toEqual([join(dir, "run"), join(dir, "tmp", "dipo")]);
    }));

  it("sizes the temp root limit by the longest candidate's socket path", () => {
    // The README names this number.
    expect(MAX_TEMP_ROOT_BYTES).toBe(37);
    const root = `/${"r".repeat(MAX_TEMP_ROOT_BYTES - 1)}`;
    expect(longestTestSocketBytes(join(root, "dipo-XXXXXX"))).toBe(RUNTIME_PATH_LIMIT);
  });
});

describe("assertTestRuntimeDir", () => {
  const dir = "/tmp/dipo-abcdef";

  it("reads the runtime choices from the JSON log lines and skips the rest", () => {
    const log = ["not json runtime directory chosen", chosen("/a", "TMPDIR"), "{}"].join("\n");
    expect(runtimeChoices(log)).toEqual([{ path: "/a", source: "TMPDIR" }]);
  });

  it("counts the choices of DIPO_RUNTIME_DIR and fails on any other source or path", () => {
    expect(assertTestRuntimeDir(dir, "")).toBe(0);
    const good = chosen(join(dir, "run"), "DIPO_RUNTIME_DIR");
    expect(assertTestRuntimeDir(dir, `${good}\n${good}\n`)).toBe(2);
    expect(() => assertTestRuntimeDir(dir, chosen(join(dir, "tmp", "dipo"), "TMPDIR"))).toThrow(
      "(source TMPDIR)",
    );
    expect(() => assertTestRuntimeDir(dir, chosen("/elsewhere/run", "DIPO_RUNTIME_DIR"))).toThrow(
      "chose runtime directory /elsewhere/run",
    );
    expect(() => assertTestRuntimeDir(dir, `${good}\n${chosen("/tmp/dipo-501", "tmp")}`)).toThrow(
      "it may have removed a real daemon's socket there",
    );
  });
});
