// The engine's watch of a new worker host (DIPO-181). `OfficeIngest.start` runs right after the
// detached host was spawned, before the host has bound its socket. The engine keeps trying until
// the host's launch deadline (DIPO-386), then falls back to the poll, and says so.

import { describe, expect, it } from "bun:test";
import { createServer } from "node:net";
import { join } from "node:path";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { EVENTS_FILE } from "../../src/host/protocol";
import type { IngestAdapter } from "../../src/ingest/ingestor";
import { HOST_CONNECT_TIMEOUT_MS, HOST_LAUNCH_DEADLINE_MS, OfficeIngest } from "../../src/run";
import type { LaunchedHost } from "../../src/records/worker-hosts";
import type { ParseState } from "../../src/workers/types";
import { ingestFixture, target } from "../ingest/helpers";

const ADAPTER: IngestAdapter = { interpret: (_line, state) => ({ events: [], state }) };

/** A host whose socket is not bound; its launch deadline is `launchDeadline`. */
function unboundHost(
  dir: string,
  run: string,
  agent: string,
  launchDeadline: number,
): LaunchedHost {
  return {
    pid: 777,
    startTimeMs: 0,
    runId: run,
    agentId: agent,
    socketPath: join(dir, "never-bound.sock"),
    protocolVersion: 2,
    runDir: dir,
    eventFile: join(dir, EVENTS_FILE),
    launchDeadline,
  };
}

async function advancePast(clock: ManualClock, ms: number): Promise<void> {
  const until = clock.now() + ms;
  while (clock.now() <= until) {
    clock.advance(25);
    await Bun.sleep(0);
  }
}

/**
 * Starts ingesting a host recorded with PID 777 that binds its socket only after the PID ask's
 * timeout, answering its handshake with `pid`; returns the frames it got and the warnings.
 */
async function lateBind(
  dir: string,
  pid: number,
): Promise<{ frames: Record<string, unknown>[]; warnings: string[] }> {
  const f = await ingestFixture(dir);
  const clock = new ManualClock();
  const warnings: string[] = [];
  const ingest = new OfficeIngest({ clock, warn: (message) => warnings.push(message) });
  const host = unboundHost(dir, f.run, f.agent, clock.now() + HOST_LAUNCH_DEADLINE_MS);
  const frames: Record<string, unknown>[] = [];
  const server = createServer((socket) => {
    let buffered = "";
    socket.on("data", (data) => {
      buffered += data.toString("utf8");
      for (let at = buffered.indexOf("\n"); at >= 0; at = buffered.indexOf("\n")) {
        const frame = JSON.parse(buffered.slice(0, at)) as Record<string, unknown>;
        buffered = buffered.slice(at + 1);
        frames.push(frame);
        const reply =
          frame["kind"] === "hello"
            ? { kind: "hello", version: 3, run: f.run, pid }
            : { kind: "reply", id: frame["id"], ok: true, result: { offset: 0 } };
        socket.write(`${JSON.stringify(reply)}\n`);
      }
    });
  });
  try {
    ingest.start(f.office, host, target(f, ADAPTER, {} as unknown as ParseState, { work: false }));
    await advancePast(clock, HOST_CONNECT_TIMEOUT_MS + 1_000);
    // The host binds late: the engine is still trying until the launch deadline.
    await new Promise<void>((resolve) => server.listen(host.socketPath, resolve));
    for (let i = 0; i < 400 && !frames.some((frame) => frame["op"] === "watch"); i += 1) {
      clock.advance(25);
      await Bun.sleep(5);
    }
    return { frames, warnings };
  } finally {
    ingest.close();
    server.close();
  }
}

describe("the engine watches a host that binds its socket after OfficeIngest.start (DIPO-181)", () => {
  it("claims a host that binds its socket after the PID ask's timeout, before its launch deadline (DIPO-386)", () =>
    withTempDir(async (dir) => {
      const { frames, warnings } = await lateBind(dir, 777);
      // The handshake, then the claim of the recorded host, then the watch.
      expect(frames.map((frame) => frame["op"] ?? frame["kind"])).toEqual([
        "hello",
        "claim",
        "watch",
      ]);
      expect(warnings).toEqual([]);
    }));

  it("does not claim a host whose handshake names another PID than the recorded one (DIPO-386)", () =>
    withTempDir(async (dir) => {
      const { frames, warnings } = await lateBind(dir, 778);
      expect(frames.map((frame) => frame["op"] ?? frame["kind"])).toEqual(["hello", "watch"]);
      expect(warnings).toEqual([
        "the worker host was not claimed; it stops its worker at its launch deadline",
      ]);
    }));

  it("warns when the host never binds its socket by its launch deadline", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      const clock = new ManualClock();
      const warnings: { message: string; fields: Readonly<Record<string, unknown>> }[] = [];
      const ingest = new OfficeIngest({
        clock,
        warn: (message, fields) => warnings.push({ message, fields }),
      });
      try {
        ingest.start(
          f.office,
          unboundHost(dir, f.run, f.agent, clock.now() + HOST_LAUNCH_DEADLINE_MS),
          target(f, ADAPTER, {} as unknown as ParseState, { work: false }),
        );
        // Past the PID ask's timeout the engine still tries: the deadline is the host's own.
        await advancePast(clock, HOST_CONNECT_TIMEOUT_MS);
        expect(warnings).toEqual([]);
        await advancePast(clock, HOST_LAUNCH_DEADLINE_MS - HOST_CONNECT_TIMEOUT_MS);
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
        warn: (message) => warnings.push(message),
      });
      ingest.start(
        f.office,
        unboundHost(dir, f.run, f.agent, clock.now() + HOST_LAUNCH_DEADLINE_MS),
        target(f, ADAPTER, {} as unknown as ParseState, { work: false }),
      );
      await Bun.sleep(0);
      ingest.close();
      await advancePast(clock, HOST_LAUNCH_DEADLINE_MS);
      expect(warnings).toEqual([]);
    }));
});
