// DIPO-316 AC #2: the test runner's setup file gives this test process the test marker and fresh
// state, log and runtime folders under the temp root, before any test runs.

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { TEST_MARKER, testRuntimeDir, testStateDir } from "./runtime";
import { tempRoot } from "./temp";
import { CI_TEST_TIMEOUT_MS, defaultTestTimeout, isolateTestProcess } from "./test-env";

const mode = (path: string) => statSync(path).mode & 0o777;

describe("the test runner's setup file", () => {
  it("set the marker and private state, log and runtime folders under the temp root", () => {
    expect(process.env[TEST_MARKER]).toBe("1");
    const state = process.env["DIPO_HOME"] ?? "";
    const runtime = process.env["DIPO_RUNTIME_DIR"] ?? "";
    const root = dirname(state);
    expect(dirname(root)).toBe(realpathSync(tempRoot()));
    expect(state).toBe(testStateDir(root));
    expect(runtime).toBe(testRuntimeDir(root));
    for (const dir of [state, join(state, "logs"), runtime]) {
      expect(statSync(dir).isDirectory()).toBe(true);
      expect(mode(dir)).toBe(0o700);
    }
  });

  it("gives every test 30 s in CI and leaves Bun's 5 s locally", () => {
    expect(CI_TEST_TIMEOUT_MS).toBe(30_000);
    expect(defaultTestTimeout({ DIPO_TEST_CI: "1" })).toBe(30_000);
    for (const env of [{}, { DIPO_TEST_CI: "0" }, { DIPO_TEST_CI: "" }, { DIPO_TEST_CI: "true" }]) {
      expect(defaultTestTimeout(env)).toBeNull();
    }
    // This process follows its own environment.
    expect(defaultTestTimeout()).toBe(process.env["DIPO_TEST_CI"] === "1" ? 30_000 : null);
  });

  it("gives each call fresh folders and leaves the real ones alone", () => {
    const env: NodeJS.ProcessEnv = {};
    const first = isolateTestProcess(env);
    const second = isolateTestProcess({});
    try {
      expect(env).toEqual({
        [TEST_MARKER]: "1",
        DIPO_HOME: first.state,
        DIPO_RUNTIME_DIR: first.runtime,
      });
      expect(second.root).not.toBe(first.root);
      expect(readdirSync(first.state)).toEqual(["logs"]);
      expect(readdirSync(first.runtime)).toEqual([]);
      expect(existsSync(first.logs)).toBe(true);
    } finally {
      rmSync(first.root, { recursive: true, force: true });
      rmSync(second.root, { recursive: true, force: true });
    }
  });
});
