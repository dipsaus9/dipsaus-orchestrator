// The engine's watch of a new worker host (DIPO-181). `OfficeIngest.start` runs right after the
// detached host was spawned, before the host has bound its socket. The engine must keep trying
// until the socket exists: a host nobody watches answers every waiting PermissionRequest call at
// once with no decision, and the CLI then denies the call on its own.

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ChildExit, ChildProcess, Spawn } from "@dipsaus-orchestrator/contract";
import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { connectHost } from "../../src/host/client";
import { WorkerHost } from "../../src/host/main";
import { EVENTS_FILE, hostSocketPath, LAUNCH_FILE, type HostLaunch } from "../../src/host/protocol";
import { relayHookPayload } from "../../src/host/relay";
import type { IngestAdapter } from "../../src/ingest/ingestor";
import { systemClock } from "../../src/platform/clock";
import { OfficeIngest } from "../../src/run";
import type { LaunchedHost } from "../../src/runs/worker-hosts";
import type { ParseState } from "../../src/workers/types";
import { ingestFixture, target } from "../ingest/helpers";

const TOKEN = "c".repeat(64);
const PAYLOAD = JSON.stringify({ hook_event_name: "PermissionRequest", tool_name: "Bash" });
const ADAPTER: IngestAdapter = { interpret: (_line, state) => ({ events: [], state }) };

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

describe("the engine watches a host that binds its socket after OfficeIngest.start (DIPO-181)", () => {
  it("holds a waiting hook call until the engine's hookReply", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      const runDir = join(dir, "run");
      mkdirSync(runDir, { recursive: true });
      const socket = hostSocketPath(join(dir, "rt"), f.run);
      const launched: LaunchedHost = {
        pid: 777,
        startTimeMs: 0,
        runId: f.run,
        agentId: f.agent,
        socketPath: socket,
        protocolVersion: 2,
        runDir,
        eventFile: join(runDir, EVENTS_FILE),
        engineToken: TOKEN,
      };
      const ingest = new OfficeIngest({ clock: systemClock, pricing: () => null });
      const worker = heldWorker();
      let host: WorkerHost | null = null;
      try {
        // The engine starts watching first: the socket does not exist yet.
        ingest.start(
          f.office,
          launched,
          target(f, ADAPTER, {} as unknown as ParseState, { work: false }),
        );
        await Bun.sleep(150);
        const launch: HostLaunch = {
          version: 1,
          run: f.run,
          agent: f.agent,
          socket,
          plan: { argv: ["/usr/local/bin/claude", "-p"], env: {}, cwd: dir, files: [], stdin: [] },
          token: TOKEN,
        };
        writeFileSync(join(runDir, LAUNCH_FILE), JSON.stringify(launch), { mode: 0o600 });
        host = WorkerHost.start({
          runId: f.run,
          runDir,
          clock: systemClock,
          spawn: worker.spawn,
          killGroup: () => undefined,
          pid: 777,
        });
        // Give the engine's next attempt time to reach the now bound socket and send `watch`.
        await Bun.sleep(300);

        const call = relayHookPayload({
          socketPath: socket,
          runId: f.run,
          payload: `${PAYLOAD}\n`,
          clock: systemClock,
          timeoutMs: 1500,
          waitMs: 310_000,
        });
        for (let i = 0; i < 100 && host.pendingHooks.length === 0; i++) await Bun.sleep(5);
        // Held, not answered at once with no decision.
        expect(host.pendingHooks).toHaveLength(1);
        const [hook] = host.pendingHooks;
        const connected = await connectHost(socket, {
          runId: f.run,
          clock: systemClock,
          timeoutMs: 2000,
          token: TOKEN,
        });
        if (!connected.ok) throw new Error(`cannot connect: ${connected.reason}`);
        expect(
          await connected.client.request({ op: "hookReply", hook: hook ?? 0, output: '{"a":1}' }),
        ).toEqual({ ok: true, result: undefined });
        expect(await call).toBe('{"a":1}');
        connected.client.close();
      } finally {
        worker.end();
        await host?.done;
        ingest.close();
      }
    }));

  // A host that never binds within the 5 s window: the engine falls back to the poll and says so.
  function unboundHost(dir: string, run: string, agent: string): LaunchedHost {
    return {
      pid: 777,
      startTimeMs: 0,
      runId: run,
      agentId: agent,
      socketPath: join(dir, "never-bound.sock"),
      protocolVersion: 2,
      runDir: dir,
      eventFile: join(dir, EVENTS_FILE),
      engineToken: TOKEN,
    };
  }

  async function advancePast(clock: ManualClock, ms: number): Promise<void> {
    const until = clock.now() + ms;
    while (clock.now() <= until) {
      clock.advance(25);
      await Bun.sleep(0);
    }
  }

  it("warns when the host never binds its socket within the window", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      const clock = new ManualClock();
      const warnings: { message: string; fields: Readonly<Record<string, unknown>> }[] = [];
      const ingest = new OfficeIngest({
        clock,
        pricing: () => null,
        warn: (message, fields) => warnings.push({ message, fields }),
      });
      try {
        ingest.start(
          f.office,
          unboundHost(dir, f.run, f.agent),
          target(f, ADAPTER, {} as unknown as ParseState, { work: false }),
        );
        await advancePast(clock, 5_000);
        expect(warnings).toEqual([
          {
            message:
              "the engine does not watch the worker host; waiting hook calls get no decision",
            fields: { run: f.run, reason: "unreachable" },
          },
        ]);
      } finally {
        ingest.close();
      }
    }));

  it("stops trying and warns nothing once the ingest is closed", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      const clock = new ManualClock();
      const warnings: string[] = [];
      const ingest = new OfficeIngest({
        clock,
        pricing: () => null,
        warn: (message) => warnings.push(message),
      });
      ingest.start(
        f.office,
        unboundHost(dir, f.run, f.agent),
        target(f, ADAPTER, {} as unknown as ParseState, { work: false }),
      );
      await Bun.sleep(0);
      ingest.close();
      await advancePast(clock, 5_000);
      expect(warnings).toEqual([]);
    }));
});
