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
  HOST_LOG_FILE,
  hostSocketPath,
  LAUNCH_FILE,
  type HostLaunch,
} from "../../src/host/protocol";
import { relayHookPayload } from "../../src/host/relay";
import { systemClock } from "../../src/platform/clock";

const RUN = "run_01JZ0000000000000000000009";
const PAYLOAD = JSON.stringify({ hook_event_name: "PermissionRequest", tool_name: "Bash" });

/** A worker that runs until `end` is called. */
function heldWorker(holdOutput = false): { spawn: Spawn; end: () => void; release: () => void } {
  let end!: () => void;
  let release!: () => void;
  const exited = new Promise<ChildExit>((resolve) => {
    end = () => resolve({ code: 0, signal: null });
  });
  // With `holdOutput` the output stays open after the exit until `release`: the host is "exiting".
  const outputDone = holdOutput
    ? new Promise<void>((resolve) => {
        release = resolve;
      })
    : exited.then(() => undefined);
  if (!holdOutput) release = () => undefined;
  const closed = () =>
    new ReadableStream<Uint8Array>({
      async start(controller) {
        await outputDone;
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
  return { spawn: () => child, end, release };
}

async function withHost(
  fn: (ctx: {
    host: WorkerHost;
    socket: string;
    runDir: string;
    worker: ReturnType<typeof heldWorker>;
  }) => Promise<void>,
  token?: string,
  holdOutput = false,
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
      ...(token === undefined ? {} : { token }),
    };
    writeFileSync(join(runDir, LAUNCH_FILE), JSON.stringify(launch), { mode: 0o600 });
    const worker = heldWorker(holdOutput);
    const host = WorkerHost.start({
      runId: RUN,
      runDir,
      clock: systemClock,
      spawn: worker.spawn,
      killGroup: () => undefined,
      pid: 777,
    });
    try {
      await fn({ host, socket, runDir, worker });
    } finally {
      worker.end();
      worker.release();
      await host.done;
    }
  });
}

async function engine(socket: string, token?: string): Promise<HostClient> {
  const connected = await connectHost(socket, {
    runId: RUN,
    clock: systemClock,
    timeoutMs: 2000,
    ...(token === undefined ? {} : { token }),
  });
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

describe("only the engine answers a hook call (DIPO-59 review)", () => {
  const TOKEN = "a".repeat(64);

  it("refuses hookReply from a connection without the engine's token, and does not count it as watching", () =>
    withHost(async ({ host, socket }) => {
      const stranger = await engine(socket);
      await stranger.watch(() => undefined);
      // A watcher without the token is not the engine: with no engine watching, no call is held.
      expect(await relay(socket, { waitMs: 5000 })).toBe("");

      const real = await engine(socket, TOKEN);
      await real.watch(() => undefined);
      const call = relay(socket, { waitMs: 5000 });
      for (let i = 0; i < 100 && host.pendingHooks.length === 0; i++) await Bun.sleep(5);
      const [hook] = host.pendingHooks;
      expect(
        await stranger.request({
          op: "hookReply",
          hook: hook ?? 0,
          output: '{"hookSpecificOutput":{"decision":{"behavior":"allow"}}}',
        }),
      ).toMatchObject({ ok: false, error: { code: "not.permitted" } });
      expect(host.pendingHooks).toEqual([hook ?? -1]);
      // A wrong token is no better.
      const guess = await engine(socket, "b".repeat(64));
      expect(await guess.request({ op: "hookReply", hook: hook ?? 0, output: "x" })).toMatchObject({
        ok: false,
        error: { code: "not.permitted" },
      });
      expect(await real.request({ op: "hookReply", hook: hook ?? 0, output: "ok" })).toEqual({
        ok: true,
        result: undefined,
      });
      expect(await call).toBe("ok");
      for (const client of [stranger, real, guess]) client.close();
    }, TOKEN));
});

/** The `host.log` lines about a call answered early, as `{ reason, hook, waitMs }`. */
function earlyLines(runDir: string): { reason: string; hook: number | null; waitMs: number }[] {
  return readFileSync(join(runDir, HOST_LOG_FILE), "utf8")
    .split("\n")
    .filter((line) => line.includes("answered early with no output"))
    .map((line) => {
      const fields = JSON.parse(line) as { reason: string; hook: number | null; waitMs: number };
      return { reason: fields.reason, hook: fields.hook, waitMs: fields.waitMs };
    });
}

describe("a waiting call answered early is logged (DIPO-181)", () => {
  it("holds a later waiting call in the same session and answers it the same way", () =>
    withHost(async ({ host, socket, runDir }) => {
      const client = await engine(socket);
      await client.watch(() => undefined);
      for (const output of ['{"first":1}', '{"second":2}']) {
        const call = relay(socket, { waitMs: 5000 });
        for (let i = 0; i < 100 && host.pendingHooks.length === 0; i++) await Bun.sleep(5);
        const [hook] = host.pendingHooks;
        expect(await client.request({ op: "hookReply", hook: hook ?? 0, output })).toEqual({
          ok: true,
          result: undefined,
        });
        expect(await call).toBe(output);
      }
      expect(earlyLines(runDir)).toEqual([]);
      client.close();
    }));

  it("logs no engine watching, with the hook id and waitMs", () =>
    withHost(async ({ socket, runDir }) => {
      expect(await relay(socket, { waitMs: 5000 })).toBe("");
      const [line] = hookLines(runDir);
      expect(earlyLines(runDir)).toEqual([
        { reason: "no-engine-watching", hook: line?.end ?? -1, waitMs: 5000 },
      ]);
    }));

  it("logs the engine's connection closing", () =>
    withHost(async ({ host, socket, runDir }) => {
      const client = await engine(socket);
      await client.watch(() => undefined);
      const call = relay(socket, { waitMs: 4000 });
      for (let i = 0; i < 100 && host.pendingHooks.length === 0; i++) await Bun.sleep(5);
      const [hook] = host.pendingHooks;
      client.close();
      expect(await call).toBe("");
      expect(earlyLines(runDir)).toEqual([
        { reason: "engine-connection-closed", hook: hook ?? -1, waitMs: 4000 },
      ]);
    }));

  it("logs the worker exiting", () =>
    withHost(async ({ host, socket, runDir, worker }) => {
      const client = await engine(socket);
      await client.watch(() => undefined);
      const call = relay(socket, { waitMs: 3000 });
      for (let i = 0; i < 100 && host.pendingHooks.length === 0; i++) await Bun.sleep(5);
      const [hook] = host.pendingHooks;
      worker.end();
      expect(await call).toBe("");
      await host.done;
      expect(earlyLines(runDir)).toEqual([
        { reason: "worker-exited", hook: hook ?? -1, waitMs: 3000 },
      ]);
    }));

  it("logs a call that reaches a host that is no longer running", () =>
    withHost(
      async ({ socket, runDir, worker }) => {
        const client = await engine(socket);
        await client.watch(() => undefined);
        // The worker exited but its output is still open: the host is exiting, not running.
        worker.end();
        await Bun.sleep(50);
        expect(await relay(socket, { waitMs: 2000 })).toBe("");
        const [line] = hookLines(runDir);
        expect(earlyLines(runDir)).toEqual([
          { reason: "host-not-running", hook: line?.end ?? -1, waitMs: 2000 },
        ]);
        client.close();
      },
      undefined,
      true,
    ));

  it("logs nothing for a call that does not wait", () =>
    withHost(async ({ socket, runDir }) => {
      expect(await relay(socket)).toBe("");
      expect(earlyLines(runDir)).toEqual([]);
    }));
});
