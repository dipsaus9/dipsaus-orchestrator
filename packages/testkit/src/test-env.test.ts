// DIPO-316 AC #2: the test runner's setup file gives this test process the test marker and fresh
// state, log and runtime folders under the temp root, before any test runs.

import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { TEST_MARKER, testRuntimeDir, testStateDir } from "./runtime";
import { tempRoot } from "./temp";
import { isolateTestProcess, MACOS_GIT_SHIM, skipGitShim } from "./test-env";

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

/** The stdout of `cmd` run with only `PATH`. */
function run(cmd: string[], PATH: string): string {
  return Bun.spawnSync(cmd, { env: { PATH }, stdout: "pipe" }).stdout.toString();
}

describe("the direct git of the test process (DIPO-225)", () => {
  it("leaves PATH alone off macOS", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
    expect(skipGitShim(env, "linux")).toBeNull();
    expect(env).toEqual({ PATH: "/usr/bin:/bin" });
  });

  it("leaves PATH alone when the git on it is not the shim", () => {
    const root = realpathSync(mkdtempSync(join(tempRoot(), "dipo-")));
    try {
      writeFileSync(join(root, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const env: NodeJS.ProcessEnv = { PATH: `${root}:/usr/bin:/bin` };
      expect(skipGitShim(env, "darwin")).toBeNull();
      expect(env).toEqual({ PATH: `${root}:/usr/bin:/bin` });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("puts the real git's folder first on PATH when git is the macOS shim", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
    const bin = skipGitShim(env, "darwin");
    if (process.platform !== "darwin" || !existsSync(MACOS_GIT_SHIM)) {
      expect(bin).toBeNull();
      return;
    }
    expect(bin).not.toBeNull();
    expect(bin).not.toBe(dirname(MACOS_GIT_SHIM));
    expect(env["PATH"]).toBe(`${bin}:/usr/bin:/bin`);
    expect(Bun.which("git", { PATH: env["PATH"] ?? "" })).toBe(join(bin ?? "", "git"));
    // The same git answers on the new PATH as through the shim, and the test process has it.
    expect(run(["git", "--version"], env["PATH"] ?? "")).toBe(
      run([MACOS_GIT_SHIM, "--version"], "/usr/bin:/bin"),
    );
    expect(process.env["PATH"]?.startsWith(`${bin}:`)).toBe(true);
  });
});
