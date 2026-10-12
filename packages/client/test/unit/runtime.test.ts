import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { readRuntimeInfo, RUNTIME_FILE, stateDir } from "../../src/node/index";

const RECORD = {
  runtimeDir: "/tmp/dipo-501",
  socket: "/tmp/dipo-501/dipo.sock",
  pid: 4242,
  startTimeMs: 1_767_225_600_000,
  version: "0.0.0-dev",
};

describe("stateDir", () => {
  it("uses DIPO_HOME when set, else the platform path under the passwd home", () => {
    expect(stateDir({ DIPO_HOME: "/x/state" }, "darwin", "/Users/me")).toBe("/x/state");
    expect(stateDir({ DIPO_HOME: "" }, "darwin", "/Users/me")).toBe(
      "/Users/me/Library/Application Support/dipo",
    );
    expect(stateDir({ HOME: "/elsewhere" }, "linux", "/home/me")).toBe(
      "/home/me/.local/state/dipo",
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
