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

// `struct kinfo_proc` (macOS): `p_starttime` at 0, `p_stat` at 36, `p_comm` at 243 (DIPO-114).
function kinfo(startSeconds: number, stat: number, comm: string): Uint8Array {
  const buffer = new Uint8Array(engineProcess.KINFO_PROC_SIZE);
  new DataView(buffer.buffer).setBigInt64(0, BigInt(startSeconds), true);
  buffer[36] = stat;
  buffer.set(new TextEncoder().encode(comm).subarray(0, 16), 243);
  return buffer;
}

// `kern.procargs2`: argc, the executable path, NUL padding, the arguments, the environment.
function procArgs(argc: number, text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  const buffer = new Uint8Array(4 + bytes.byteLength);
  new DataView(buffer.buffer).setInt32(0, argc, true);
  buffer.set(bytes, 4);
  return buffer;
}

const KINFOS = [
  kinfo(1_791_535_923, 2, "dipo"),
  kinfo(1_791_535_923, 5, "dipo"),
  kinfo(1_791_535_923, 2, "a-very-long-command-name"),
  kinfo(0, 2, "dipo"),
  new Uint8Array(0),
  new Uint8Array(100),
];

const PROC_ARGS = [
  procArgs(3, "/usr/local/bin/dipo\0\0\0/usr/local/bin/dipo\0daemon\0--foreground\0HOME=/h\0"),
  procArgs(2, "/b\0/Users/m/My Tools/dipo\0daemon\0"),
  procArgs(5, "/b\0one\0two\0"),
  procArgs(0, "/b\0"),
  new Uint8Array(2),
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

/** The value `fn` returns or the message it throws, so two copies compare on both. */
function outcome(fn: () => unknown): { value: unknown } | { error: string } {
  try {
    return { value: fn() };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

describe("client lifecycle and engine agree", () => {
  it("parse dipo.pid the same way", () => {
    for (const raw of PID_RECORDS) {
      expect(clientFiles.parsePidRecord(raw)).toEqual(engineLock.parsePidRecord(raw));
    }
    expect(clientFiles.PID_FILE).toBe(engineLock.PID_FILE);
  });

  it("parse process start times and commands the same way", () => {
    for (const buffer of KINFOS) {
      const fromEngine = engineProcess.parseKinfoProc(buffer);
      expect(clientProcess.parseKinfoProc(buffer)).toEqual(fromEngine);
      if (fromEngine === null) continue;
      for (const args of ["a b", null]) {
        expect(clientProcess.darwinProcessInfo(7, fromEngine, args)).toEqual(
          engineProcess.darwinProcessInfo(7, fromEngine, args),
        );
      }
    }
    for (const buffer of PROC_ARGS) {
      expect(clientProcess.parseProcArgs(buffer)).toEqual(engineProcess.parseProcArgs(buffer));
    }
    expect(clientProcess.KINFO_PROC_SIZE).toBe(engineProcess.KINFO_PROC_SIZE);
    // A failed or malformed kern.proc.pid read is unknown in both copies, never dead.
    for (const [code, buffer] of [
      [0, new Uint8Array(0)],
      [0, KINFOS[0] ?? new Uint8Array(0)],
      [0, new Uint8Array(100)],
      [-1, new Uint8Array(engineProcess.KINFO_PROC_SIZE)],
    ] as const) {
      expect(outcome(() => clientProcess.kinfoOutcome(7, code, buffer))).toEqual(
        outcome(() => engineProcess.kinfoOutcome(7, code, buffer)),
      );
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

  it("probe this process and a child the same way", async () => {
    const platform = process.platform === "linux" ? "linux" : "darwin";
    const child = Bun.spawn({ cmd: ["/bin/sleep", "30"], stdout: "ignore", stderr: "ignore" });
    try {
      for (const pid of [process.pid, child.pid]) {
        const fromClient = await clientProcess.systemProcessProbe(platform)(pid);
        const fromEngine = await engineProcess.systemProcessProbe(platform)(pid);
        expect(fromClient).not.toBeNull();
        expect(fromClient).toEqual(fromEngine);
      }
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
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
