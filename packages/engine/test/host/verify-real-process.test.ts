// verifyHostForSignal on real processes (DIPO-386): the PID check reads the live process table,
// so a process that is not this run's worker host is refused whatever its PID or start time.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { currentPlatform } from "../../src/platform/paths";
import { systemProcessProbe } from "../../src/platform/process";
import { type WorkerHostRow, verifyHostForSignal } from "../../src/runs/worker-hosts";

const RUN = "run_01JZ0000000000000000000001";
const AGENT = "agt_01JZ0000000000000000000001";
const STAND_IN = resolve(import.meta.dir, "../run/fixtures/stand-in-host.ts");
const probe = systemProcessProbe(currentPlatform());

let dir = "";
const children: { kill(): void }[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "verify-real-"));
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  rmSync(dir, { recursive: true, force: true });
});

/** A recorded row for `pid` with the start time the caller gives. */
function rowFor(pid: number, startTimeMs: number): WorkerHostRow {
  return {
    pid,
    startTimeMs,
    runId: RUN,
    agentId: AGENT,
    socketPath: join(dir, "host.sock"),
    protocolVersion: 2,
    runDir: dir,
    eventFile: join(dir, "events.ndjson"),
    processedOffset: 0,
    exitCode: null,
    exitSignal: null,
    exitSignalInferred: false,
    finalOffset: null,
    endedAt: null,
    startedAt: startTimeMs,
    pending: false,
    signalStop: true,
  };
}

/** Starts a real child process and returns its row as the engine would have recorded it. */
async function started(argv: string[], env: Record<string, string> = {}): Promise<WorkerHostRow> {
  const child = Bun.spawn(argv, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "ignore"],
  });
  children.push(child);
  const info = await probe(child.pid);
  if (info === null) throw new Error("the child is not in the process table");
  return rowFor(child.pid, info.startTimeMs);
}

describe("verifyHostForSignal on real processes (DIPO-386)", () => {
  it("passes for this run's worker host, a Bun process running the host's entry form", async () => {
    const row = await started([process.execPath, STAND_IN, "daemon", "worker-host", RUN], {
      STAND_IN_SOCKET: join(dir, "host.sock"),
      STAND_IN_GATE: join(dir, "never"),
    });
    expect(await verifyHostForSignal(row, probe)).toEqual({ ok: true });
  });

  it("refuses a wrapper that runs the words of the host command, as sh -c does", async () => {
    const row = await started(["/bin/sh", "-c", "sleep 600", "daemon", "worker-host", RUN]);
    expect(await verifyHostForSignal(row, probe)).toMatchObject({ ok: false });
  });

  it("refuses a process that is not a worker host at all", async () => {
    const row = await started(["/bin/sleep", "600"]);
    expect(await verifyHostForSignal(row, probe)).toMatchObject({ ok: false });
  });

  it("refuses a reused PID: a live process whose start time is not the recorded one", async () => {
    const live = await started([process.execPath, STAND_IN, "daemon", "worker-host", RUN], {
      STAND_IN_SOCKET: join(dir, "host.sock"),
      STAND_IN_GATE: join(dir, "never"),
    });
    const reused = rowFor(live.pid, live.startTimeMs - 3_600_000);
    expect(await verifyHostForSignal(reused, probe)).toMatchObject({ ok: false });
  });

  it("refuses a PID whose process is gone", async () => {
    const row = await started(["/bin/sleep", "0"]);
    await Bun.sleep(200);
    expect(await verifyHostForSignal(row, probe)).toMatchObject({ ok: false });
  });
});
