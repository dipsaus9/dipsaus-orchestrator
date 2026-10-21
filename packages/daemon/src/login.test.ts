// `dipo login box` (DIPO-269) with a fake terminal spawn: it runs `security` to ask for the token
// itself, refuses without a terminal, and reports a failed store. No Keychain is touched.

import { describe, expect, it } from "bun:test";

import { SECURITY_CLI, type SpawnInteractive, storeTokenArgs } from "@dipsaus-orchestrator/engine";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import type { DaemonIo } from "./io";
import { runLoginForm } from "./login";

function fakeIo(): { io: DaemonIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      writeLine: (line) => out.push(line),
      writeError: (line) => err.push(line),
      env: {},
      execArgv: [],
      version: "test",
      onShutdownSignal: () => () => {},
      clock: new ManualClock(),
    },
  };
}

function recordingSpawn(code: number | null): {
  spawn: SpawnInteractive;
  calls: Parameters<SpawnInteractive>[0][];
} {
  const calls: Parameters<SpawnInteractive>[0][] = [];
  return {
    calls,
    spawn: async (options) => {
      calls.push(options);
      return { code, signal: code === null ? "SIGINT" : null };
    },
  };
}

describe("dipo login box", () => {
  it("runs security on the terminal, with -w last, and reports the stored entry", async () => {
    const { io, out, err } = fakeIo();
    const spawn = recordingSpawn(0);
    const code = await runLoginForm(["box"], io, {
      spawnInteractive: spawn.spawn,
      isTerminal: () => true,
      home: () => "/Users/someone",
    });
    expect(code).toBe(0);
    expect(spawn.calls).toEqual([
      {
        cmd: [SECURITY_CLI, ...storeTokenArgs()],
        env: { PATH: "/usr/bin:/bin", HOME: "/Users/someone" },
      },
    ]);
    expect(spawn.calls[0]?.cmd.at(-1)).toBe("-w");
    expect(err.join("\n")).toContain("claude setup-token");
    expect(out).toEqual([
      "dipo: stored the box login in the Keychain (service dipo, account box-login).",
    ]);
  });

  it("refuses without a terminal and runs nothing", async () => {
    const { io, err } = fakeIo();
    const spawn = recordingSpawn(0);
    expect(
      await runLoginForm(["box"], io, { spawnInteractive: spawn.spawn, isTerminal: () => false }),
    ).toBe(2);
    expect(spawn.calls).toEqual([]);
    expect(err.join("\n")).toContain("needs a terminal");
  });

  it("prints the usage for anything but box", async () => {
    for (const args of [[], ["github"], ["box", "token"], ["box", "--token=x"]]) {
      const { io, err } = fakeIo();
      const spawn = recordingSpawn(0);
      expect(
        await runLoginForm(args, io, { spawnInteractive: spawn.spawn, isTerminal: () => true }),
      ).toBe(2);
      expect(spawn.calls).toEqual([]);
      expect(err.join("\n")).toContain("usage: dipo login box");
    }
  });

  it("exits 1 when security stores nothing", async () => {
    const { io, out, err } = fakeIo();
    const spawn = recordingSpawn(null);
    expect(
      await runLoginForm(["box"], io, {
        spawnInteractive: spawn.spawn,
        isTerminal: () => true,
        home: () => "/Users/someone",
      }),
    ).toBe(1);
    expect(out).toEqual([]);
    expect(err.at(-1)).toBe("dipo: security ended by SIGINT; nothing was stored.");
  });
});
