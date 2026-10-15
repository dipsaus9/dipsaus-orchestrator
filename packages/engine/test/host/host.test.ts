// The worker host's main function run in-process (DIPO-44 AC #8): an injected spawn replays a
// Claude recording through `FakeProcess` on a manual clock, so only the CI detach test needs a
// real child. Covers the event file and `exit.json`, monotonic offsets, `advanced` for a watcher
// after each append, the handshake and the op set, steering over the socket and the cancelled
// delayed signal.

import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ChildProcess, Signal, Spawn } from "@dipsaus-orchestrator/contract";
import {
  fakeSpawn,
  ManualClock,
  recordedProcesses,
  stdoutText,
  withTempDir,
  type FakeProcess,
} from "@dipsaus-orchestrator/testkit";

import { connectHost, type HostClient } from "../../src/host/client";
import { WorkerHost } from "../../src/host/main";
import {
  EVENTS_FILE,
  EXIT_FILE,
  HOST_LOG_FILE,
  hostSocketPath,
  LAUNCH_FILE,
  RESERVED_RUN_FILES,
  type HostExitFile,
  type HostLaunch,
  type HostStatus,
} from "../../src/host/protocol";
import { connectLineSocket } from "../../src/platform/line-socket";
import { systemClock } from "../../src/platform/clock";
import {
  initialState,
  interpret,
  type ClaudeParseState,
} from "../../src/workers/claude-cli/interpret";
import { result } from "../../src/workers/claude-cli/result";
import type { HostLine } from "../../src/workers/types";
import { loadRecording, plannedModel } from "../workers/replay";

const RUN = "run_01JZ0000000000000000000001";
const FIRST_LINE = '{"type":"user","message":{"role":"user","content":"task"}}\n';

interface Setup {
  readonly runDir: string;
  readonly socket: string;
  readonly launch: HostLaunch;
}

function setup(dir: string): Setup {
  const runDir = join(dir, "repo", ".git", "dipo", "runs", RUN);
  mkdirSync(runDir, { recursive: true, mode: 0o755 });
  const socket = hostSocketPath(join(dir, "rt"), RUN);
  const launch: HostLaunch = {
    version: 1,
    run: RUN,
    agent: "agt_01JZ0000000000000000000001",
    socket,
    plan: {
      argv: ["/usr/local/bin/claude", "-p"],
      env: { PATH: "/usr/bin:/bin" },
      cwd: dir,
      files: [{ name: "system.md", content: "# system\n" }],
      stdin: [FIRST_LINE],
    },
  };
  writeFileSync(join(runDir, LAUNCH_FILE), JSON.stringify(launch), { mode: 0o600 });
  return { runDir, socket, launch };
}

/** Holds the child's stdout until `open` is called, so a test can connect before the replay. */
function gated(spawn: Spawn) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const wrapped: Spawn = (options) => {
    const child = spawn(options);
    const reader = child.stdout.getReader();
    const stdout = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          await gate;
          const { done, value } = await reader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        },
      },
      { highWaterMark: 0 },
    );
    return {
      get pid() {
        return child.pid;
      },
      stdin: child.stdin,
      stdout,
      stderr: child.stderr,
      exited: child.exited,
      kill: (signal?: Signal) => child.kill(signal),
    } satisfies ChildProcess;
  };
  return { spawn: wrapped, open };
}

function readLines(runDir: string): { lines: HostLine[]; ends: number[] } {
  const bytes = readFileSync(join(runDir, EVENTS_FILE));
  const lines: HostLine[] = [];
  const ends: number[] = [];
  let start = 0;
  for (let at = bytes.indexOf(0x0a); at >= 0; at = bytes.indexOf(0x0a, start)) {
    lines.push(JSON.parse(bytes.subarray(start, at).toString("utf8")) as HostLine);
    ends.push(at + 1);
    start = at + 1;
  }
  return { lines, ends };
}

async function connect(socket: string): Promise<HostClient> {
  const connected = await connectHost(socket, { runId: RUN, clock: systemClock, timeoutMs: 2000 });
  if (!connected.ok) throw new Error(`cannot connect: ${connected.reason}`);
  return connected.client;
}

describe("worker host in-process", () => {
  it("replays a recording into events.ndjson and exit.json, telling a watcher each offset", () =>
    withTempDir(async (dir) => {
      const { runDir, socket } = setup(dir);
      const recording = loadRecording("success-single");
      const clock = new ManualClock();
      const fake = fakeSpawn(recording, clock);
      const { spawn, open } = gated(fake.spawn);
      const kills: [number, Signal][] = [];
      const host = WorkerHost.start({
        runId: RUN,
        runDir,
        clock,
        spawn,
        killGroup: (pgid, signal) => kills.push([pgid, signal]),
        pid: 777,
      });
      expect(host.socketPath).toBe(socket);

      const client = await connect(socket);
      expect(client.version).toBe(2);
      expect(client.hostPid).toBe(777);
      const advanced: number[] = [];
      expect(await client.watch((offset) => advanced.push(offset))).toBe(0);
      open();
      const exit = await host.done;
      await client.closed;

      // The worker got the first stdin line and the run's files.
      const child = fake.processes[0] as FakeProcess;
      expect(child.stdinWrites).toEqual([FIRST_LINE]);
      expect(fake.calls[0]?.detached).toBe(true);
      expect(fake.calls[0]?.cmd).toEqual(["/usr/local/bin/claude", "-p"]);
      expect(readFileSync(join(runDir, "system.md"), "utf8")).toBe("# system\n");
      expect(statSync(join(runDir, "system.md")).mode & 0o777).toBe(0o600);
      expect(statSync(runDir).mode & 0o777).toBe(0o700);
      expect(existsSync(join(runDir, LAUNCH_FILE))).toBe(false);
      expect(existsSync(join(runDir, HOST_LOG_FILE))).toBe(true);
      expect(existsSync(socket)).toBe(false);

      // Every stdout line, then the exit, with offsets that only grow.
      const { lines, ends } = readLines(runDir);
      const recorded = (recordedProcesses(recording.lines)[0] ?? [])
        .filter((line) => line.ch === "stdout")
        .map((line) => stdoutText(line.data));
      expect(lines.filter((l) => l.ch === "stdout").map((l) => l.data)).toEqual(recorded);
      expect(lines.at(-1)).toMatchObject({ ch: "exit", data: '{"code":0,"signal":null}' });
      expect(lines.map((l) => l.t)).toEqual(lines.map((l) => l.t).toSorted((a, b) => a - b));
      expect(advanced).toEqual(ends);
      expect(ends.every((end, i) => i === 0 || end > (ends[i - 1] ?? 0))).toBe(true);

      // exit.json: code, signal, final offset and time.
      const file = JSON.parse(readFileSync(join(runDir, EXIT_FILE), "utf8")) as HostExitFile;
      expect(file).toEqual(exit);
      expect(file).toEqual({
        run: RUN,
        code: 0,
        signal: null,
        finalOffset: statSync(join(runDir, EVENTS_FILE)).size,
        at: clock.now(),
      });
      // The worker's process group is killed once it has exited.
      expect(kills).toEqual([[child.pid, "SIGKILL"]]);

      // The engine's parser reads the file to the same result as a direct replay.
      let state: ClaudeParseState = initialState({ plannedModel: plannedModel(recording) });
      for (const line of lines) state = interpret(line, state).state as ClaudeParseState;
      expect(result(state, { code: 0, signal: null }).outcome).toBe("done");
    }));

  it("steers over the socket, refuses unknown ops and cancels a delayed signal at exit", () =>
    withTempDir(async (dir) => {
      const { runDir, socket } = setup(dir);
      const clock = new ManualClock();
      const fake = fakeSpawn(loadRecording("success-single"), clock);
      const { spawn, open } = gated(fake.spawn);
      const host = WorkerHost.start({
        runId: RUN,
        runDir,
        clock,
        spawn,
        killGroup: () => {},
        pid: 778,
      });
      const client = await connect(socket);
      const child = fake.processes[0] as FakeProcess;
      const advanced: number[] = [];
      await client.watch((offset) => advanced.push(offset));

      expect(await client.request({ op: "write", data: "steer\n" })).toEqual({ ok: true });
      expect(child.stdinWrites).toEqual([FIRST_LINE, "steer\n"]);
      const status = (await client.status()) as HostStatus;
      expect(status).toMatchObject({
        run: RUN,
        hostPid: 778,
        workerPid: child.pid,
        state: "running",
        stdinOpen: true,
        offset: 0,
        exit: null,
      });

      const unknown = await client.request({ op: "kill" } as never);
      expect(unknown).toEqual({
        ok: false,
        error: { code: "op.unknown", message: 'Unknown op "kill".' },
      });

      host.relayHook({ hook_event_name: "Stop" });
      // Frames arrive in order, so the reply to a later request follows the `advanced` frame.
      const after = (await client.status()) as HostStatus;
      expect(advanced).toEqual([after.offset]);

      expect(await client.request({ op: "closeStdin" })).toEqual({ ok: true });
      expect(child.stdinClosed).toBe(true);
      expect(await client.request({ op: "write", data: "late\n" })).toMatchObject({
        ok: false,
        error: { code: "stdin.closed" },
      });
      expect(await client.request({ op: "signal", signal: "SIGKILL", afterMs: 30_000 })).toEqual({
        ok: true,
      });
      expect(await client.request({ op: "signal", signal: "SIGTERM" })).toEqual({ ok: true });
      open();
      const exit = await host.done;
      expect(exit).toMatchObject({ code: 143, signal: null });
      // The delayed SIGKILL was cancelled when the worker exited.
      clock.advance(60_000);
      expect(child.signals).toEqual(["SIGTERM"]);

      const { lines } = readLines(runDir);
      expect(lines[0]).toEqual({ t: 0, ch: "hook", data: '{"hook_event_name":"Stop"}' });
      expect(lines.at(-1)?.ch).toBe("exit");
    }));

  it("accepts only a hello for its own run in a protocol it speaks", () =>
    withTempDir(async (dir) => {
      const { runDir, socket } = setup(dir);
      const clock = new ManualClock();
      const { spawn, open } = gated(fakeSpawn(loadRecording("success-single"), clock).spawn);
      const host = WorkerHost.start({
        runId: RUN,
        runDir,
        clock,
        spawn,
        killGroup: () => {},
        pid: 779,
      });
      const other = await connectHost(socket, {
        runId: "run_01JZ0000000000000000000002",
        clock: systemClock,
        timeoutMs: 2000,
      });
      expect(other).toMatchObject({
        ok: false,
        reason: "refused",
        error: { code: "run.mismatch" },
      });
      const newer = await connectHost(socket, {
        runId: RUN,
        clock: systemClock,
        timeoutMs: 2000,
        versions: [7, 9],
      });
      expect(newer).toMatchObject({
        ok: false,
        reason: "refused",
        error: { code: "protocol.unsupported" },
      });
      const mixed = await connectHost(socket, {
        runId: RUN,
        clock: systemClock,
        timeoutMs: 2000,
        versions: [1, 3],
      });
      expect(mixed.ok && mixed.client.version).toBe(1);
      if (mixed.ok) mixed.client.close();

      const frames: string[] = [];
      let closed!: () => void;
      const gone = new Promise<void>((resolve) => {
        closed = resolve;
      });
      const raw = await connectLineSocket(socket, { line: (t) => frames.push(t), closed });
      raw?.send(JSON.stringify({ kind: "op", id: 1, op: "status" }));
      await gone;
      expect(JSON.parse(frames[0] ?? "{}")).toMatchObject({
        kind: "refused",
        error: { code: "frame.invalid" },
        versions: [1, 2],
      });
      open();
      await host.done;
    }));

  it("writes exit.json with the start error when the worker cannot be spawned", () =>
    withTempDir(async (dir) => {
      const { runDir } = setup(dir);
      const clock = new ManualClock();
      const host = WorkerHost.start({
        runId: RUN,
        runDir,
        clock,
        spawn: () => {
          throw new Error("ENOENT: claude");
        },
        killGroup: () => {},
        pid: 780,
      });
      const exit = await host.done;
      expect(exit).toEqual({
        run: RUN,
        code: null,
        signal: null,
        finalOffset: statSync(join(runDir, EVENTS_FILE)).size,
        at: clock.now(),
        startError: "cannot start the worker: ENOENT: claude",
      });
      expect(readLines(runDir).lines).toEqual([
        { t: 0, ch: "exit", data: '{"code":null,"signal":null}' },
      ]);
    }));

  it("writes a plan file one directory deep, executable when the plan says so (DIPO-82)", () =>
    withTempDir(async (dir) => {
      const { runDir, launch } = setup(dir);
      const files = [
        ...launch.plan.files,
        { name: "safe-chain/zsh", content: "#!/bin/sh\n", executable: true },
        { name: "safe-chain/.zshenv", content: ". init\n" },
      ];
      writeFileSync(
        join(runDir, LAUNCH_FILE),
        JSON.stringify({ ...launch, plan: { ...launch.plan, files } }),
      );
      const host = WorkerHost.start({
        runId: RUN,
        runDir,
        clock: new ManualClock(),
        spawn: () => {
          throw new Error("ENOENT: claude");
        },
        killGroup: () => {},
        pid: 783,
      });
      await host.done;
      expect(readFileSync(join(runDir, "safe-chain/zsh"), "utf8")).toBe("#!/bin/sh\n");
      expect(statSync(join(runDir, "safe-chain/zsh")).mode & 0o777).toBe(0o700);
      expect(statSync(join(runDir, "safe-chain/.zshenv")).mode & 0o777).toBe(0o600);
      expect(statSync(join(runDir, "safe-chain")).mode & 0o777).toBe(0o700);
    }));

  it("refuses plan file names deeper than one directory or leaving the run directory", () =>
    withTempDir((dir) => {
      const { runDir, launch } = setup(dir);
      for (const name of ["a/b/c", "../x", "safe-chain/..", "/abs", "a//b"]) {
        const bad = { ...launch, plan: { ...launch.plan, files: [{ name, content: "x" }] } };
        writeFileSync(join(runDir, LAUNCH_FILE), JSON.stringify(bad));
        expect(() =>
          WorkerHost.start({
            runId: RUN,
            runDir,
            clock: new ManualClock(),
            spawn: () => {
              throw new Error("not reached");
            },
            killGroup: () => {},
            pid: 784,
          }),
        ).toThrow("at most one directory deep");
      }
    }));

  it("refuses plan files that would replace a file the host writes", () =>
    withTempDir((dir) => {
      const { runDir, launch } = setup(dir);
      for (const name of RESERVED_RUN_FILES) {
        const bad = { ...launch, plan: { ...launch.plan, files: [{ name, content: "x" }] } };
        writeFileSync(join(runDir, LAUNCH_FILE), JSON.stringify(bad));
        expect(() =>
          WorkerHost.start({
            runId: RUN,
            runDir,
            clock: new ManualClock(),
            spawn: () => {
              throw new Error("not reached");
            },
            killGroup: () => {},
            pid: 782,
          }),
        ).toThrow("may not replace a file the host writes");
        expect(existsSync(join(runDir, LAUNCH_FILE))).toBe(false);
      }
      expect([...RESERVED_RUN_FILES].toSorted()).toEqual([
        "events.ndjson",
        "exit.json",
        "exit.json.tmp",
        "host.log",
        "launch.json",
        "launch.json.tmp",
      ]);
    }));

  it("makes the hosts directory 0700 even when it exists with a wider mode", () =>
    withTempDir(async (dir) => {
      const { runDir, socket } = setup(dir);
      mkdirSync(dirname(socket), { recursive: true });
      chmodSync(dirname(socket), 0o755);
      const host = WorkerHost.start({
        runId: RUN,
        runDir,
        clock: new ManualClock(),
        spawn: () => {
          throw new Error("ENOENT");
        },
        killGroup: () => {},
        pid: 783,
      });
      await host.done;
      expect(statSync(dirname(socket)).mode & 0o777).toBe(0o700);
    }));

  it("writes exit.json with the start error when the socket cannot be prepared or bound", () =>
    withTempDir(async (dir) => {
      const { runDir, launch } = setup(dir);
      // A directory where the socket should be: the leftover cannot be removed and nothing binds.
      const socket = join(dir, "rt", "hosts", `${RUN}.sock`);
      mkdirSync(join(socket, "inside"), { recursive: true });
      writeFileSync(join(runDir, LAUNCH_FILE), JSON.stringify({ ...launch, socket }));
      let spawned = false;
      const host = WorkerHost.start({
        runId: RUN,
        runDir,
        clock: new ManualClock(),
        spawn: () => {
          spawned = true;
          throw new Error("not reached");
        },
        killGroup: () => {},
        pid: 784,
      });
      const exit = await host.done;
      expect(spawned).toBe(false);
      expect(exit.startError).toStartWith("cannot prepare the host socket");
      expect(JSON.parse(readFileSync(join(runDir, EXIT_FILE), "utf8"))).toEqual(exit);
    }));

  it("refuses a launch file for another run and removes it", () =>
    withTempDir((dir) => {
      const { runDir } = setup(dir);
      expect(() =>
        WorkerHost.start({
          runId: "run_01JZ0000000000000000000009",
          runDir,
          clock: new ManualClock(),
          spawn: () => {
            throw new Error("not reached");
          },
          killGroup: () => {},
          pid: 781,
        }),
      ).toThrow("not run_01JZ0000000000000000000009");
      expect(existsSync(join(runDir, LAUNCH_FILE))).toBe(false);
      expect(readFileSync(join(runDir, HOST_LOG_FILE), "utf8")).toContain(
        "cannot read the launch file",
      );
    }));
});
