// `dipo test shell <id>` (DIPO-309), daemon side, with a fake terminal spawn: it opens an
// interactive shell with a terminal in a test box only, contained as the box user in `/work`, and
// refuses another box's name, a missing terminal and a PATH without Apple container.

import { describe, expect, it } from "bun:test";

import { type SpawnInteractive, testShellArgs } from "@dipsaus-orchestrator/engine";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import type { DaemonIo } from "./io";
import { runTestShellForm } from "./test-shell";

const BOX = "dipo-tst_01J9ZK5Q8W3V4X6Y7Z8A9B0C7K";

function fakeIo(): { io: DaemonIo; err: string[] } {
  const err: string[] = [];
  return {
    err,
    io: {
      writeLine: () => {},
      writeError: (line) => err.push(line),
      env: { PATH: "/usr/local/bin:/usr/bin" },
      execArgv: [],
      version: "test",
      onShutdownSignal: () => () => {},
      clock: new ManualClock(),
    },
  };
}

function recording(): { spawn: SpawnInteractive; calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = [];
  return {
    calls,
    spawn: async (options) => {
      calls.push(options.cmd);
      return { code: 0, signal: null };
    },
  };
}

describe("the test shell form", () => {
  it("runs container exec with a terminal into the test box, contained in /work", async () => {
    const { io } = fakeIo();
    const { spawn, calls } = recording();
    const code = await runTestShellForm([BOX], io, {
      spawnInteractive: spawn,
      isTerminal: () => true,
      container: "/usr/local/bin/container",
      home: () => "/Users/me",
    });
    expect(code).toBe(0);
    expect(calls).toEqual([["/usr/local/bin/container", ...testShellArgs(BOX)]]);
    const args = testShellArgs(BOX);
    expect(args.slice(0, 5)).toEqual(["exec", "--interactive", "--tty", "--workdir", "/work"]);
    expect(args).toContain(BOX);
    // Contained: the shell runs through setpriv as the box user, never as root.
    expect(args.join(" ")).toContain("--reuid=1000");
    expect(args.slice(-2)).toEqual(["/bin/bash", "-l"]);
  });

  it("refuses a box that is not a test box, no terminal, and no container on the PATH", async () => {
    for (const [args, options, expected] of [
      [["dipo-run_01J9ZK5Q8W3V4X6Y7Z8A9B0C7K"], { isTerminal: () => true }, 2],
      [[BOX], { isTerminal: () => false }, 2],
      [[BOX, "extra"], { isTerminal: () => true }, 2],
    ] as const) {
      const { io } = fakeIo();
      const { spawn, calls } = recording();
      expect(await runTestShellForm(args, io, { ...options, spawnInteractive: spawn })).toBe(
        expected,
      );
      expect(calls).toEqual([]);
    }
    const { io, err } = fakeIo();
    const { spawn, calls } = recording();
    const code = await runTestShellForm(
      [BOX],
      { ...io, env: { PATH: "/nowhere" } },
      {
        spawnInteractive: spawn,
        isTerminal: () => true,
      },
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("not on the PATH");
    expect(calls).toEqual([]);
  });
});
