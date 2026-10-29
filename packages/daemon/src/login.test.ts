// `dipo login box` (DIPO-269) with a fake terminal spawn: it runs `security` to ask for the token
// itself, refuses without a terminal, and reports a failed store. No Keychain is touched. Once the
// token is stored it removes the box-token hold's record (DIPO-271); a failed store keeps it. The
// state directory is a temp folder.

import { existsSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "bun:test";

import { boxTokenHoldPath, type SpawnInteractive } from "@dipsaus-orchestrator/engine/platform";
import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

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
    const code = await withTempDir((state) =>
      runLoginForm(["box"], io, {
        spawnInteractive: spawn.spawn,
        isTerminal: () => true,
        home: () => "/Users/someone",
        stateDir: () => state,
      }),
    );
    expect(code).toBe(0);
    expect(spawn.calls).toEqual([
      {
        // `security add-generic-password` for dipo's box login, the token read from the terminal.
        cmd: [
          "/usr/bin/security",
          "add-generic-password",
          "-U",
          "-s",
          "dipo",
          "-a",
          "box-login",
          "-l",
          "dipo box login",
          "-w",
        ],
        env: { PATH: "/usr/bin:/bin", HOME: "/Users/someone" },
      },
    ]);
    expect(spawn.calls[0]?.cmd.at(-1)).toBe("-w");
    expect(err.join("\n")).toContain("claude setup-token");
    expect(out).toEqual([
      "dipo: stored the box login in the Keychain (service dipo, account box-login).",
    ]);
  });

  it("lifts the box-token hold once the token is stored, by removing its record (DIPO-271)", () =>
    withTempDir(async (state) => {
      const record = boxTokenHoldPath(state);
      writeFileSync(record, JSON.stringify({ adapter: "claude-cli", failures: [], since: 0 }));
      const { io, out } = fakeIo();
      const code = await runLoginForm(["box"], io, {
        spawnInteractive: recordingSpawn(0).spawn,
        isTerminal: () => true,
        home: () => "/Users/someone",
        stateDir: () => state,
      });
      expect(code).toBe(0);
      expect(existsSync(record)).toBe(false);
      expect(out.at(-1)).toBe("dipo: the box-token hold is lifted; new runs may start again.");
    }));

  it("keeps the box-token hold when nothing was stored (DIPO-271)", () =>
    withTempDir(async (state) => {
      const record = boxTokenHoldPath(state);
      writeFileSync(record, "{}");
      const { io } = fakeIo();
      const code = await runLoginForm(["box"], io, {
        spawnInteractive: recordingSpawn(null).spawn,
        isTerminal: () => true,
        home: () => "/Users/someone",
        stateDir: () => state,
      });
      expect(code).toBe(1);
      expect(existsSync(record)).toBe(true);
    }));

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
