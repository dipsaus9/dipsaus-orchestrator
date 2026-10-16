// A daemon that refuses its `config.yaml` exits 78 (DIPO-69). Under launchd it first boots its own
// job out, so `KeepAlive.SuccessfulExit = false` does not restart it in a loop (DIPO-63 AC #7).
// In-process, with a fake `launchctl`; outside launchd nothing is spawned. State, runtime and temp
// directories stay under the test's temp directory (DIPO-109).

import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type ChildProcess, EXIT_CONFIG, type Spawn } from "@dipsaus-orchestrator/contract";
import { systemClock } from "@dipsaus-orchestrator/engine";
import { isolatedDaemonEnv, withDaemonTempDir } from "@dipsaus-orchestrator/testkit";

import { runForeground } from "./foreground";
import type { DaemonIo } from "./io";

/** A stream that holds `text` and is closed. */
const textStream = (text = "") =>
  new ReadableStream<Uint8Array>({
    start: (c) => {
      if (text !== "") c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });

function io(env: Record<string, string>, err: string[]): DaemonIo {
  return {
    writeLine: () => {},
    writeError: (line) => err.push(line),
    env,
    execArgv: [],
    version: "0.0.0-test",
    onShutdownSignal: () => () => {},
    clock: systemClock,
    // No listener for uncaught errors on the test runner's own process (DIPO-117).
    uncaughtErrors: new EventEmitter(),
  };
}

/** A fake `launchctl` whose `print` reports `jobPid` as the job's PID. */
function recordingSpawn(calls: (readonly string[])[], jobPid: number = process.pid): Spawn {
  return (options): ChildProcess => {
    calls.push(options.cmd);
    return {
      pid: 1,
      stdin: null,
      stdout: textStream(
        options.cmd[1] === "print" ? `\tstate = running\n\tpid = ${jobPid}\n` : "",
      ),
      stderr: textStream(),
      exited: Promise.resolve({ code: 0, signal: null }),
      kill: () => {},
    };
  };
}

describe("refused config.yaml under a supervisor", () => {
  it("boots its own launchd job out before exiting 78", () =>
    withDaemonTempDir(async (dir) => {
      const state = join(dir, "state");
      mkdirSync(state, { recursive: true });
      writeFileSync(join(state, "config.yaml"), "version: 1\ndaemon:\n  autostrat: false\n");
      const calls: (readonly string[])[] = [];
      const err: string[] = [];
      const code = await runForeground(
        [],
        io({ ...isolatedDaemonEnv(dir), XPC_SERVICE_NAME: "dipo.daemon" }, err),
        { supervisorSpawn: recordingSpawn(calls), parentPid: 1 },
      );
      expect(code).toBe(EXIT_CONFIG);
      const uid = process.getuid?.() ?? -1;
      expect(calls).toEqual([
        ["launchctl", "print", `gui/${uid}/dipo.daemon`],
        ["launchctl", "bootout", `gui/${uid}/dipo.daemon`],
      ]);
      expect(err.join("\n")).toContain("daemon.autostrat: unknown key");
    }));

  it("boots nothing out when XPC_SERVICE_NAME is only inherited (launchd is not the parent)", () =>
    withDaemonTempDir(async (dir) => {
      const state = join(dir, "state");
      mkdirSync(state, { recursive: true });
      writeFileSync(join(state, "config.yaml"), "version: 2\n");
      const calls: (readonly string[])[] = [];
      const code = await runForeground(
        [],
        io({ ...isolatedDaemonEnv(dir), XPC_SERVICE_NAME: "dipo.daemon" }, []),
        { supervisorSpawn: recordingSpawn(calls), parentPid: 4242 },
      );
      expect(code).toBe(EXIT_CONFIG);
      expect(calls).toEqual([]);
    }));

  it("boots nothing out when the installed job runs another PID", () =>
    withDaemonTempDir(async (dir) => {
      const state = join(dir, "state");
      mkdirSync(state, { recursive: true });
      writeFileSync(join(state, "config.yaml"), "version: 2\n");
      const calls: (readonly string[])[] = [];
      const code = await runForeground(
        [],
        io({ ...isolatedDaemonEnv(dir), XPC_SERVICE_NAME: "dipo.daemon" }, []),
        { supervisorSpawn: recordingSpawn(calls, process.pid + 1), parentPid: 1 },
      );
      expect(code).toBe(EXIT_CONFIG);
      expect(calls.every((cmd) => cmd[1] === "print")).toBe(true);
    }));

  it("spawns nothing outside launchd", () =>
    withDaemonTempDir(async (dir) => {
      const state = join(dir, "state");
      mkdirSync(state, { recursive: true });
      writeFileSync(join(state, "config.yaml"), "version: 2\n");
      const calls: (readonly string[])[] = [];
      const code = await runForeground([], io(isolatedDaemonEnv(dir), []), {
        supervisorSpawn: recordingSpawn(calls),
      });
      expect(code).toBe(EXIT_CONFIG);
      expect(calls).toEqual([]);
    }));
});
