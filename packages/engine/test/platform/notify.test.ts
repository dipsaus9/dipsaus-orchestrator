// The desk notification's platform port (DIPO-357): the AppleScript text is escaped, one line, and
// a failed `osascript` is an error for the caller to log. A fake `Spawn` stands in for the process.

import { describe, expect, it } from "bun:test";

import type { ChildProcess, Spawn } from "@dipsaus-orchestrator/contract";

import { systemClock } from "../../src/platform/clock";
import {
  appleScriptString,
  notificationScript,
  systemPostNotification,
} from "../../src/platform/notify";

function fakeSpawn(code: number): { spawn: Spawn; cmds: (readonly string[])[] } {
  const cmds: (readonly string[])[] = [];
  const spawn: Spawn = (options) => {
    cmds.push(options.cmd);
    const child: ChildProcess = {
      pid: 1,
      stdin: null,
      stdout: new ReadableStream<Uint8Array>(),
      stderr: new ReadableStream<Uint8Array>(),
      exited: Promise.resolve({ code, signal: null }),
      kill: () => {},
    };
    return child;
  };
  return { spawn, cmds };
}

describe("desk notification platform port", () => {
  it("escapes quotes and backslashes and keeps the text on one line", () => {
    expect(appleScriptString('a "quoted" \\ word\nnext\tline')).toBe(
      '"a \\"quoted\\" \\\\ word next line"',
    );
  });

  it("builds a display notification with the body and the title", () => {
    expect(notificationScript({ title: "dipo: Acme", body: "DIPO-2 · MERGE" })).toBe(
      'display notification "DIPO-2 · MERGE" with title "dipo: Acme"',
    );
  });

  it("runs osascript with the script and resolves on exit 0", async () => {
    const { spawn, cmds } = fakeSpawn(0);
    const post = systemPostNotification(spawn, systemClock);
    await post({ title: "t", body: "b" });
    expect(cmds).toEqual([["osascript", "-e", 'display notification "b" with title "t"']]);
  });

  it("rejects when osascript exits with an error", async () => {
    const { spawn } = fakeSpawn(1);
    const post = systemPostNotification(spawn, systemClock);
    await expect(post({ title: "t", body: "b" })).rejects.toThrow("osascript exited with code 1");
  });
});
