import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import {
  dirRefusal,
  DirRefusedError,
  readRuntimeInfo,
  RUNTIME_FILE,
  stateDir,
  TEST_MARKER,
} from "../../src/node/index";

const RECORD = {
  runtimeDir: "/tmp/dipo-501",
  socket: "/tmp/dipo-501/dipo.sock",
  pid: 4242,
  startTimeMs: 1_767_225_600_000,
  version: "0.0.0-dev",
};

describe("stateDir", () => {
  it("uses DIPO_HOME when set, else the Library path under the passwd home", () => {
    expect(stateDir({ DIPO_HOME: "/x/state" }, "/Users/me")).toBe("/x/state");
    expect(stateDir({ DIPO_HOME: "" }, "/Users/me")).toBe(
      "/Users/me/Library/Application Support/dipo",
    );
    // There is no Linux folder (0004): any home gets the Library path.
    expect(stateDir({ HOME: "/elsewhere" }, "/home/me")).toBe(
      "/home/me/Library/Application Support/dipo",
    );
  });
});

describe("readRuntimeInfo", () => {
  it("reads the record the daemon writes", () =>
    withTempDir((dir) => {
      writeFileSync(join(dir, RUNTIME_FILE), `${JSON.stringify(RECORD)}\n`);
      expect(readRuntimeInfo(dir)).toEqual(RECORD);
    }));

  it("is null for a missing, broken or incomplete record", () =>
    withTempDir((dir) => {
      expect(readRuntimeInfo(dir)).toBeNull();
      writeFileSync(join(dir, RUNTIME_FILE), "{not json");
      expect(readRuntimeInfo(dir)).toBeNull();
      writeFileSync(join(dir, RUNTIME_FILE), JSON.stringify({ ...RECORD, socket: "dipo.sock" }));
      expect(readRuntimeInfo(dir)).toBeNull();
      const { pid: _pid, ...withoutPid } = RECORD;
      writeFileSync(join(dir, RUNTIME_FILE), JSON.stringify(withoutPid));
      expect(readRuntimeInfo(dir)).toBeNull();
      mkdirSync(join(dir, "nested"));
      expect(readRuntimeInfo(join(dir, "nested", "missing"))).toBeNull();
    }));
});

const code = (env: Record<string, string>) => dirRefusal(env, "/Users/me")?.code;

// DIPO-316: the client refuses what the daemon refuses, with the same codes.
describe("dirRefusal", () => {
  it("accepts usable overrides and none", () =>
    withTempDir((dir) => {
      const run = join(dir, "run");
      mkdirSync(run, { mode: 0o700 });
      chmodSync(run, 0o700);
      expect(code({})).toBeUndefined();
      expect(code({ DIPO_HOME: dir, DIPO_RUNTIME_DIR: run })).toBeUndefined();
      expect(code({ DIPO_HOME: join(dir, "missing"), DIPO_RUNTIME_DIR: join(dir, "new") })).toBe(
        undefined,
      );
    }));

  it("refuses a DIPO_HOME it cannot use, naming the path and the reason", () =>
    withTempDir((dir) => {
      const file = join(dir, "file");
      writeFileSync(file, "");
      for (const home of ["state", file, join(file, "state")]) {
        const refusal = dirRefusal({ DIPO_HOME: home }, "/Users/me");
        expect(refusal).toBeInstanceOf(DirRefusedError);
        expect(refusal?.code).toBe("paths.stateDirUnusable");
        expect(refusal?.message).toContain(home);
        expect(() => stateDir({ DIPO_HOME: home }, "/Users/me")).toThrow("paths.stateDirUnusable");
      }
    }));

  it("refuses a DIPO_RUNTIME_DIR that is relative, too long, a symlink or open", () =>
    withTempDir((dir) => {
      const link = join(dir, "link");
      mkdirSync(join(dir, "target"), { mode: 0o700 });
      symlinkSync(join(dir, "target"), link);
      const open = join(dir, "open");
      mkdirSync(open);
      chmodSync(open, 0o755);
      const cases: [string, string][] = [
        ["run", "it is not an absolute path"],
        [join(dir, "x".repeat(100)), "100-byte limit"],
        [link, "it is a symlink"],
        [open, "its mode is 0755, not 0700"],
      ];
      for (const [path, reason] of cases) {
        const refusal = dirRefusal({ DIPO_RUNTIME_DIR: path }, "/Users/me");
        expect(refusal?.code).toBe("paths.runtimeDirUnusable");
        expect(refusal?.path).toBe(path);
        expect(refusal?.message).toContain(reason);
      }
    }));

  it("refuses the real home's state folder under the test marker", () => {
    expect(process.env[TEST_MARKER]).toBe("1");
    expect(dirRefusal({}, userInfo().homedir)?.code).toBe("paths.realStateInTest");
  });
});
