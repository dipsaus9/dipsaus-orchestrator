import { describe, expect, it } from "bun:test";

import type { ChildProcess, Spawn } from "@dipsaus-orchestrator/contract";

import { ManualClock } from "./clock";
import {
  FakeProcess,
  fakeSpawn,
  type RecordedLine,
  recordedProcesses,
  type Recording,
} from "./fake-process";

const decoder = new TextDecoder();

async function readAll(child: ChildProcess): Promise<string> {
  let text = "";
  const reader = child.stdout.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += decoder.decode(value);
  }
}

const LINES: RecordedLine[] = [
  { t: 10, ch: "stdout", data: { type: "system", subtype: "init" } },
  { t: 15, ch: "stderr", data: "[redacted len:4]" },
  { t: 20, ch: "hook", data: { hook_event_name: "PermissionRequest" } },
  { t: 100, ch: "stdout", data: { type: "assistant" } },
  { t: 200, ch: "stdout", data: { type: "result", subtype: "error_during_execution" } },
  { t: 250, ch: "exit", data: { code: 0, signal: null } },
];

function recording(lines: RecordedLine[], sigint?: number): Recording {
  return {
    name: "synthetic",
    meta: {
      scenario: "synthetic",
      source: "synthetic",
      expected: "",
      steering: [
        { t: 0, op: "spawn" },
        ...(sigint === undefined ? [] : [{ t: sigint, op: "signal", signal: "SIGINT" }]),
      ],
    },
    lines,
  };
}

describe("FakeProcess", () => {
  it("is a contract ChildProcess handed out by an injected Spawn", () => {
    const clock = new ManualClock();
    const fake = fakeSpawn(recording(LINES), clock);
    const spawn: Spawn = fake.spawn;
    const child: ChildProcess = spawn({ cmd: ["claude", "-p"], stdin: "pipe" });
    expect(child).toBeInstanceOf(FakeProcess);
    expect(fake.calls).toEqual([{ cmd: ["claude", "-p"], stdin: "pipe" }]);
    expect(() => spawn({ cmd: ["claude"] })).toThrow("only 1 process");
  });

  it("replays stdout, stderr, hooks and the exit, moving the clock by recorded deltas", async () => {
    const clock = new ManualClock();
    const hooks: unknown[] = [];
    const child = fakeSpawn(recording(LINES), clock, {
      onHook: (payload) => hooks.push(payload),
    }).spawn({
      cmd: ["claude"],
    });
    const start = clock.now();
    let fired = -1;
    clock.setTimeout(() => {
      fired = clock.now() - start;
    }, 150);
    const text = await readAll(child);
    expect(
      text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown),
    ).toEqual([
      { type: "system", subtype: "init" },
      { type: "assistant" },
      { type: "result", subtype: "error_during_execution" },
    ]);
    expect(await child.exited).toEqual({ code: 0, signal: null });
    expect(clock.now() - start).toBe(250);
    expect(fired).toBe(150);
    expect(hooks).toEqual([{ hook_event_name: "PermissionRequest" }]);
    expect(await new Response(child.stderr).text()).toBe("[redacted len:4]\n");
    expect(child.stdin).toBeNull();
  });

  it("writes a partial line without a newline", async () => {
    const child = new FakeProcess({
      clock: new ManualClock(),
      lines: [
        { t: 1, ch: "stdout", data: '{"type":"res' },
        { t: 2, ch: "exit", data: { code: 1, signal: null } },
      ],
    });
    expect(await readAll(child)).toBe('{"type":"res');
    expect(await child.exited).toEqual({ code: 1, signal: null });
  });

  it("jumps to the recorded post-interrupt tail on SIGINT", async () => {
    const clock = new ManualClock();
    const child = fakeSpawn(recording(LINES, 150), clock).spawn({ cmd: ["claude"] });
    const start = clock.now();
    const reader = child.stdout.getReader();
    expect(decoder.decode((await reader.read()).value)).toContain("init");
    child.kill("SIGINT");
    expect(decoder.decode((await reader.read()).value)).toContain("error_during_execution");
    expect((await reader.read()).done).toBe(true);
    expect(await child.exited).toEqual({ code: 0, signal: null });
    // 10 ms to the init, then 50 ms of recorded tail after the signal at 150 ms.
    expect(clock.now() - start).toBe(10 + 100);
  });

  it("ends with exit 143 and no result on SIGTERM", async () => {
    const child = fakeSpawn(recording(LINES), new ManualClock()).spawn({ cmd: ["claude"] });
    const reader = child.stdout.getReader();
    await reader.read();
    child.kill("SIGTERM");
    expect((await reader.read()).done).toBe(true);
    expect(await child.exited).toEqual({ code: 143, signal: null });
    expect((child as FakeProcess).signals).toEqual(["SIGTERM"]);
  });

  it("ends by the signal on SIGKILL, and on SIGINT when no interrupt was recorded", async () => {
    const killed = new FakeProcess({ clock: new ManualClock(), lines: LINES });
    killed.kill("SIGKILL");
    expect(await killed.exited).toEqual({ code: null, signal: "SIGKILL" });
    const interrupted = new FakeProcess({ clock: new ManualClock(), lines: LINES });
    interrupted.kill("SIGINT");
    expect(await interrupted.exited).toEqual({ code: null, signal: "SIGINT" });
  });

  it("records stdin writes and the close", () => {
    const child = new FakeProcess({ clock: new ManualClock(), lines: LINES, stdin: "pipe" });
    child.stdin?.write('{"type":"user"}\n');
    child.stdin?.write(new TextEncoder().encode("second\n"));
    child.stdin?.end();
    expect(child.stdinWrites).toEqual(['{"type":"user"}\n', "second\n"]);
    expect(child.stdinClosed).toBe(true);
    expect(() => child.stdin?.write("late")).toThrow("write after stdin end");
  });

  it("splits a recording into one process per exit", () => {
    const pair = [
      ...LINES,
      { t: 300, ch: "stdout", data: {} } as RecordedLine,
      LINES[5] as RecordedLine,
    ];
    expect(recordedProcesses(pair).map((lines) => lines.length)).toEqual([6, 2]);
  });
});
