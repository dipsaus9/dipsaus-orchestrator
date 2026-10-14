// The hook relay through the worker host (0008 section 5, DIPO-59 AC #1 and #2), in-process: a
// host on a hand-held worker that runs until the test ends it, and `relayHookPayload`, the client
// `dipo hook <event>` uses. Covers the versioned handshake (a newer binary relays to an older host,
// an unknown version is refused silently), the `hook` line and its offset, a waiting call answered
// by the engine's `hookReply`, and every way a waiting call ends with no decision: no engine
// watching, the engine gone, the wait passed, the worker exited.

import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ChildExit, ChildProcess, Spawn } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { connectHost, type HostClient } from "../../src/host/client";
import { WorkerHost } from "../../src/host/main";
import {
  EVENTS_FILE,
  HOOK_PROTOCOL_VERSIONS,
  hostSocketPath,
  LAUNCH_FILE,
  type HostLaunch,
} from "../../src/host/protocol";
import { relayHookPayload } from "../../src/host/relay";
import { systemClock } from "../../src/platform/clock";

const RUN = "run_01JZ0000000000000000000009";
const PAYLOAD = JSON.stringify({ hook_event_name: "PermissionRequest", tool_name: "Bash" });

/** A worker that runs until `end` is called. */
function heldWorker(): { spawn: Spawn; end: () => void } {
  let end!: () => void;
  const exited = new Promise<ChildExit>((resolve) => {
    end = () => resolve({ code: 0, signal: null });
  });
  const closed = () =>
    new ReadableStream<Uint8Array>({
      async start(controller) {
        await exited;
        controller.close();
      },
    });
  const child: ChildProcess = {
    pid: 4242,
    stdin: { write: () => 0, end: () => undefined } as unknown as ChildProcess["stdin"],
    stdout: closed(),
    stderr: closed(),
    exited,
    kill: () => undefined,
  };
  return { spawn: () => child, end };
}

async function withHost(
  fn: (ctx: { host: WorkerHost; socket: string; runDir: string }) => Promise<void>,
): Promise<void> {
  await withTempDir(async (dir) => {
    const runDir = join(dir, "run");
    mkdirSync(runDir, { recursive: true });
    const socket = hostSocketPath(join(dir, "rt"), RUN);
    const launch: HostLaunch = {
      version: 1,
      run: RUN,
      agent: "agt_01JZ0000000000000000000009",
      socket,
      plan: { argv: ["/usr/local/bin/claude", "-p"], env: {}, cwd: dir, files: [], stdin: [] },
    };
    writeFileSync(join(runDir, LAUNCH_FILE), JSON.stringify(launch), { mode: 0o600 });
    const worker = heldWorker();
    const host = WorkerHost.start({
      runId: RUN,
      runDir,
      clock: systemClock,
      spawn: worker.spawn,
      killGroup: () => undefined,
      pid: 777,
    });
    try {
      await fn({ host, socket, runDir });
    } finally {
      worker.end();
      await host.done;
    }
  });
}

async function engine(socket: string): Promise<HostClient> {
  const connected = await connectHost(socket, { runId: RUN, clock: systemClock, timeoutMs: 2000 });
  if (!connected.ok) throw new Error(`cannot connect: ${connected.reason}`);
  return connected.client;
}

function relay(socket: string, options: { waitMs?: number; versions?: number[] } = {}) {
  return relayHookPayload({
    socketPath: socket,
    runId: RUN,
    payload: `${PAYLOAD}\n`,
    clock: systemClock,
    timeoutMs: 1500,
    ...options,
  });
}

function hookLines(runDir: string): { data: string; end: number }[] {
  const text = readFileSync(join(runDir, EVENTS_FILE), "utf8");
  const out: { data: string; end: number }[] = [];
  let end = 0;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    end += Buffer.byteLength(line) + 1;
    const parsed = JSON.parse(line) as { ch: string; data: string };
    if (parsed.ch === "hook") out.push({ data: parsed.data, end });
  }
  return out;
}

describe("hook relay (DIPO-59)", () => {
  it("appends the payload as a hook line and answers a call that does not wait at once", () =>
    withHost(async ({ socket, runDir }) => {
      expect(await relay(socket)).toBe("");
      expect(hookLines(runDir).map((line) => line.data)).toEqual([PAYLOAD]);
    }));

  it("accepts a newer binary's offer that includes a version it speaks, and refuses an unknown one silently", () =>
    withHost(async ({ socket, runDir }) => {
      // A newer binary offers its own version next to the older ones (HOOK_PROTOCOL_VERSIONS).
      expect(await relay(socket, { versions: [...HOOK_PROTOCOL_VERSIONS, 9] })).toBe("");
      // An offer this host does not speak: the relay gets nothing and stays silent.
      expect(await relay(socket, { versions: [9] })).toBeNull();
      // A version-1 connection has no hook op.
      expect(await relay(socket, { versions: [1] })).toBeNull();
      expect(hookLines(runDir)).toHaveLength(1);
    }));

  it("is silent when no host listens", () =>
    withTempDir(async (dir) => {
      expect(await relay(join(dir, "none.sock"))).toBeNull();
    }));

  it("holds a waiting call for the engine's hookReply under the line's end offset", () =>
    withHost(async ({ host, socket, runDir }) => {
      const client = await engine(socket);
      await client.watch(() => undefined);
      const call = relay(socket, { waitMs: 5000 });
      for (let i = 0; i < 100 && host.pendingHooks.length === 0; i++) await Bun.sleep(5);
      const [line] = hookLines(runDir);
      expect(host.pendingHooks).toEqual([line?.end ?? -1]);
      expect(
        await client.request({ op: "hookReply", hook: (line?.end ?? 0) + 1, output: "x" }),
      ).toMatchObject({ ok: false, error: { code: "hook.unknown" } });
      expect(
        await client.request({ op: "hookReply", hook: line?.end ?? 0, output: '{"allow":1}' }),
      ).toEqual({ ok: true, result: undefined });
      expect(await call).toBe('{"allow":1}');
      expect(host.pendingHooks).toEqual([]);
      client.close();
    }));

  it("answers a waiting call with no decision when no engine watches, the engine goes, or the wait passes", () =>
    withHost(async ({ host, socket }) => {
      // The daemon is down: nobody watches, so the call is not held.
      expect(await relay(socket, { waitMs: 5000 })).toBe("");

      const client = await engine(socket);
      await client.watch(() => undefined);
      const call = relay(socket, { waitMs: 5000 });
      for (let i = 0; i < 100 && host.pendingHooks.length === 0; i++) await Bun.sleep(5);
      expect(host.pendingHooks).toHaveLength(1);
      client.close();
      expect(await call).toBe("");

      const again = await engine(socket);
      await again.watch(() => undefined);
      expect(await relay(socket, { waitMs: 30 })).toBe("");
      again.close();
    }));

  it("answers a waiting call with no decision when the worker exits", async () => {
    let pending: Promise<string | null> | null = null;
    await withHost(async ({ host, socket }) => {
      const client = await engine(socket);
      await client.watch(() => undefined);
      pending = relay(socket, { waitMs: 5000 });
      for (let i = 0; i < 100 && host.pendingHooks.length === 0; i++) await Bun.sleep(5);
      expect(host.pendingHooks).toHaveLength(1);
    });
    expect(await (pending as unknown as Promise<string | null>)).toBe("");
  });
});
