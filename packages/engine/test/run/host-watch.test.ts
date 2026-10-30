// The engine's watch of a new worker host (DIPO-181). `OfficeIngest.start` runs right after the
// detached host was spawned, before the host has bound its socket. The engine keeps trying for a
// window and then falls back to the poll, and says so.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { EVENTS_FILE } from "../../src/host/protocol";
import type { IngestAdapter } from "../../src/ingest/ingestor";
import { OfficeIngest } from "../../src/run";
import type { LaunchedHost } from "../../src/runs/worker-hosts";
import type { ParseState } from "../../src/workers/types";
import { ingestFixture, target } from "../ingest/helpers";

const ADAPTER: IngestAdapter = { interpret: (_line, state) => ({ events: [], state }) };

/** A host that never binds within the 5 s window: the engine falls back to the poll and says so. */
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
  };
}

async function advancePast(clock: ManualClock, ms: number): Promise<void> {
  const until = clock.now() + ms;
  while (clock.now() <= until) {
    clock.advance(25);
    await Bun.sleep(0);
  }
}

describe("the engine watches a host that binds its socket after OfficeIngest.start (DIPO-181)", () => {
  it("warns when the host never binds its socket within the window", () =>
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
