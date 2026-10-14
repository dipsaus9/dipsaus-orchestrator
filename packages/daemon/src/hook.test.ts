// `dipo hook <event> [--wait <seconds>]` (DIPO-59 AC #1): the hidden form reads the payload, relays
// it over the host protocol's handshake, prints only the host's answer, and exits 0 silently on
// every failure. A small line-socket server stands in for the worker host.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { listenLineSocket, systemClock } from "@dipsaus-orchestrator/engine";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { parseHookArgs, runHookForm } from "./hook";
import { defaultIo, type DaemonIo } from "./io";

const RUN = "run_01JZ0000000000000000000009";

function io(env: Record<string, string>, input: string | null, out: string[]): DaemonIo {
  return {
    ...defaultIo,
    env,
    clock: systemClock,
    writeLine: (line) => out.push(`line:${line}`),
    writeError: (line) => out.push(`err:${line}`),
    write: (text) => out.push(text),
    readInput: async () => input,
  };
}

/** A host that answers the handshake with version 2 and every hook op with `output`. */
function fakeHost(path: string, output: string, frames: unknown[]) {
  return listenLineSocket(path, (connection) => ({
    line: (text) => {
      const frame = JSON.parse(text) as Record<string, unknown>;
      frames.push(frame);
      if (frame["kind"] === "hello") {
        connection.send(JSON.stringify({ kind: "hello", version: 2, run: RUN, pid: 1 }));
      } else {
        connection.send(
          JSON.stringify({ kind: "reply", id: frame["id"], ok: true, result: { output } }),
        );
      }
    },
    closed: () => undefined,
  }));
}

describe("dipo hook", () => {
  it("parses the event and an optional --wait in seconds", () => {
    expect(parseHookArgs(["Stop"])).toEqual({ event: "Stop" });
    expect(parseHookArgs(["PermissionRequest", "--wait", "300"])).toEqual({
      event: "PermissionRequest",
      waitMs: 300_000,
    });
    expect(parseHookArgs([])).toBeNull();
    expect(parseHookArgs(["Stop", "--wait", "0"])).toBeNull();
    expect(parseHookArgs(["Stop", "--wait", "99999"])).toBeNull();
    expect(parseHookArgs(["bad name"])).toBeNull();
  });

  it("exits 0 and prints nothing without a host socket, with bad arguments or an unreachable host", () =>
    withTempDir(async (dir) => {
      const out: string[] = [];
      expect(await runHookForm(["Stop"], io({}, "{}", out))).toBe(0);
      const env = { DIPO_HOST_SOCKET: join(dir, "none.sock"), DIPO_RUN: RUN };
      expect(await runHookForm([], io(env, "{}", out))).toBe(0);
      expect(await runHookForm(["Stop"], io(env, "{}", out))).toBe(0);
      expect(await runHookForm(["Stop"], io(env, null, out))).toBe(0);
      expect(out).toEqual([]);
    }));

  it("relays the payload with the hook versions and prints the host's answer as is", () =>
    withTempDir(async (dir) => {
      const socket = join(dir, "h.sock");
      const frames: unknown[] = [];
      const server = fakeHost(socket, '{"decision":"x"}', frames);
      try {
        const out: string[] = [];
        const env = { DIPO_HOST_SOCKET: socket, DIPO_RUN: RUN };
        const code = await runHookForm(
          ["PermissionRequest", "--wait", "5"],
          io(env, '{"hook_event_name":"PermissionRequest"}\n', out),
        );
        expect(code).toBe(0);
        expect(out).toEqual(['{"decision":"x"}']);
        expect(frames).toEqual([
          { kind: "hello", versions: [2], run: RUN },
          {
            kind: "op",
            id: 1,
            op: "hook",
            payload: '{"hook_event_name":"PermissionRequest"}\n',
            waitMs: 5000,
          },
        ]);
      } finally {
        await server.stop();
      }
    }));
});
