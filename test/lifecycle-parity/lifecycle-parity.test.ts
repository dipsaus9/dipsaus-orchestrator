// The client's `lifecycle` module and the daemon must judge the same files and processes the same
// way (0006 decision 6): `client` may not import `engine` (0004), so `client/node` repeats the PID
// record parser, the process probe parsers, the Bun flag variables and the logs directory. This
// test sits outside both packages, where neither boundary applies, and runs both copies on the
// same inputs. It imports the source files by path because the repository root has no package
// links.

import { describe, expect, it } from "bun:test";

import * as clientFiles from "../../packages/client/src/node/lifecycle/files";
import * as clientProcess from "../../packages/client/src/node/lifecycle/process";
import * as clientSpawn from "../../packages/client/src/node/lifecycle/spawn";
import { logsDir } from "../../packages/client/src/node/runtime";
import * as engineLock from "../../packages/engine/src/platform/lock";
import { resolveSoftwareDirs } from "../../packages/engine/src/platform/paths";
import * as engineProcess from "../../packages/engine/src/platform/process";

const PID_RECORDS = [
  '{"pid":4242,"startTimeMs":1767000000000,"version":"0.0.0-dev","runtimeDir":"/run"}',
  '{"pid":4242,"startTimeMs":1767000000000,"version":"0.0.0-dev","runtimeDir":null}',
  '{"pid":0,"startTimeMs":1,"version":"x","runtimeDir":null}',
  '{"pid":1.5,"startTimeMs":1,"version":"x","runtimeDir":null}',
  '{"pid":4242,"startTimeMs":"1","version":"x","runtimeDir":null}',
  '{"pid":4242,"startTimeMs":1,"version":"x"}',
  "",
  "{",
  "null",
];

const PS_LINES = [
  "Ss   Mon Oct 12 09:52:03 2026     /usr/local/bin/dipo daemon --foreground",
  "S    Fri Oct  2 23:05:09 2026     /usr/local/bin/dipo daemon --foreground",
  "Z+   Mon Oct 12 09:52:03 2026     (dipo)",
  "S    Mon Foo 12 09:52:03 2026     x",
  "garbage",
];

const PROC_STATS = [
  "4242 (dipo) S 1 4242 4242 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 123456 0 0",
  "4242 (dipo (x) y) Z 1 4242 4242 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 99 0 0",
  "4242 (dipo) S 1",
];

const COMMANDS = [
  "/usr/local/bin/dipo daemon --foreground",
  "/opt/bun /repo/packages/cli/src/main.ts daemon --foreground --log-level debug",
  "/usr/local/bin/dipo daemon start",
  "/usr/local/bin/dipo --foreground daemon",
];

describe("client lifecycle and engine agree", () => {
  it("parse dipo.pid the same way", () => {
    for (const raw of PID_RECORDS) {
      expect(clientFiles.parsePidRecord(raw)).toEqual(engineLock.parsePidRecord(raw));
    }
    expect(clientFiles.PID_FILE).toBe(engineLock.PID_FILE);
  });

  it("parse process start times and commands the same way", () => {
    for (const line of PS_LINES) {
      expect(clientProcess.parsePsLine(7, line)).toEqual(engineProcess.parsePsLine(7, line));
    }
    for (const text of PROC_STATS) {
      expect(clientProcess.parseProcStat(text)).toEqual(engineProcess.parseProcStat(text));
    }
    for (const command of COMMANDS) {
      expect(clientProcess.isDaemonCommand(command)).toBe(engineProcess.isDaemonCommand(command));
    }
    expect(clientProcess.START_TIME_TOLERANCE_MS).toBe(engineProcess.START_TIME_TOLERANCE_MS);
  });

  it("judge the same identity the same way", () => {
    const info = { pid: 1, startTimeMs: 10_000, zombie: false, command: "dipo" };
    for (const startTimeMs of [10_000, 12_000, 12_001, 7_999, 8_000]) {
      expect(clientProcess.isSameProcess({ pid: 1, startTimeMs }, info)).toBe(
        engineProcess.isSameProcess({ pid: 1, startTimeMs }, info),
      );
    }
  });

  it("probe this process the same way", async () => {
    const platform = process.platform === "linux" ? "linux" : "darwin";
    const fromClient = await clientProcess.systemProcessProbe(platform)(process.pid);
    const fromEngine = await engineProcess.systemProcessProbe(platform)(process.pid);
    expect(fromClient).not.toBeNull();
    expect(fromClient).toEqual(fromEngine);
  });

  it("remove the same Bun flag variables", () => {
    const env = { PATH: "/bin", BUN_OPTIONS: "x", BUN_FEATURE_FLAG_NO_ORPHANS: "1", HOME: "/h" };
    expect(clientSpawn.BUN_FLAG_VARIABLES).toEqual(engineProcess.BUN_FLAG_VARIABLES);
    expect(clientSpawn.daemonEnv(env)).toEqual(engineProcess.detachedEnv(env));
  });

  it("find the same logs directory", () => {
    for (const [env, platform, home] of [
      [{ DIPO_HOME: "/tmp/x/state" }, "darwin", "/Users/me"],
      [{ DIPO_HOME: "/tmp/x/state" }, "linux", "/home/me"],
      [{}, "darwin", "/Users/me"],
      [{}, "linux", "/home/me"],
    ] as const) {
      expect(logsDir(env, platform, home)).toBe(resolveSoftwareDirs({ platform, env, home }).logs);
    }
  });
});
