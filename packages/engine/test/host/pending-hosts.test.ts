// DIPO-93: the host row is written pending before the spawn, a restart settles a pending row by
// the host's claimed launch or PID marker (or revokes the launch), and a follow-only host is
// signalled only after its PID, start time and command are verified.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { OfficeHandle } from "../../src/db/office";
import { claimedLaunchName, EXIT_FILE, hostMarkerName, LAUNCH_FILE } from "../../src/host/protocol";
import type { DetachedSpawnOptions, ProcessInfo, ProcessProbe } from "../../src/platform/process";
import {
  recordPendingHost,
  recordWorkerHost,
  resolvePendingHost,
  runDirectory,
  SPAWN_WINDOW_MS,
  startWorkerHost,
  verifyHostForSignal,
  type WorkerHostRow,
  workerHostsOf,
} from "../../src/runs/worker-hosts";
import { addOffice, openTestState, type TestState } from "../commands/helpers";

const RUN = "run_01JZ0000000000000000000001";
const AGENT = "agt_01JZ0000000000000000000001";
const HOST_COMMAND = `/opt/dipo daemon worker-host ${RUN}`;

let dir = "";
let t: TestState;
let office: OfficeHandle;
let runDir = "";

beforeEach(async () => {
  dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "pending-hosts-"));
  t = await openTestState(dir);
  office = addOffice(t);
  runDir = runDirectory(join(dir, "repo", ".git", "dipo"), RUN);
  mkdirSync(runDir, { recursive: true });
});

afterEach(() => {
  t.state.close();
  rmSync(dir, { recursive: true, force: true });
});

const probeOf =
  (info: Partial<ProcessInfo> | null): ProcessProbe =>
  async (pid) =>
    info === null
      ? null
      : { pid, startTimeMs: t.clock.now(), zombie: false, command: HOST_COMMAND, ...info };

function pendingRow(): WorkerHostRow {
  recordPendingHost(
    office,
    {
      runId: RUN,
      agentId: AGENT,
      socketPath: join(dir, "rt", "hosts", `${RUN}.sock`),
      protocolVersion: 2,
      runDir,
      eventFile: join(runDir, "events.ndjson"),
    },
    t.clock,
    120,
  );
  const row = workerHostsOf(office, RUN)[0];
  if (row === undefined) throw new Error("no row");
  return row;
}

function launchOptions(spawn: (options: DetachedSpawnOptions) => { pid: number }) {
  return {
    runId: RUN,
    agentId: AGENT,
    officeDir: join(dir, "repo", ".git", "dipo"),
    runtimeDir: join(dir, "rt"),
    plan: { argv: ["/bin/true"] as [string], env: {}, cwd: dir, files: [], stdin: [] },
    dipoCommand: ["/opt/dipo"] as [string],
    env: {},
    probe: probeOf({}),
    spawnDetached: spawn,
  };
}

describe("the pending host row (AC #3)", () => {
  it("is written before the spawn and completed after it", async () => {
    let atSpawn: WorkerHostRow[] = [];
    await startWorkerHost(
      office,
      t.clock,
      launchOptions(() => {
        atSpawn = workerHostsOf(office, RUN);
        return { pid: 5150 };
      }),
      { processedOffset: 64 },
    );
    expect(atSpawn).toHaveLength(1);
    expect(atSpawn[0]).toMatchObject({
      pending: true,
      pid: 0,
      startTimeMs: 0,
      processedOffset: 64,
      signalStop: true,
    });
    const rows = workerHostsOf(office, RUN);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pending: false,
      pid: 5150,
      startTimeMs: t.clock.now(),
      processedOffset: 64,
      startedAt: atSpawn[0]?.startedAt ?? -1,
    });
  });

  it("is removed when the host does not start", async () => {
    await expect(
      startWorkerHost(
        office,
        t.clock,
        launchOptions(() => {
          throw new Error("EAGAIN");
        }),
      ),
    ).rejects.toThrow("EAGAIN");
    expect(workerHostsOf(office, RUN)).toEqual([]);
  });
});

describe("resolvePendingHost after a restart (AC #3)", () => {
  it("accepts a host that started inside the spawn window, up to its far end", async () => {
    const row = pendingRow();
    writeFileSync(
      join(runDir, hostMarkerName(AGENT)),
      JSON.stringify({ run: RUN, agent: AGENT, pid: 6006 }),
    );
    const late = row.startedAt + SPAWN_WINDOW_MS + 1_000;
    expect(await resolvePendingHost(office, row, probeOf({ startTimeMs: late }))).toEqual({
      kind: "recorded",
      pid: 6006,
      alive: true,
    });
    expect(workerHostsOf(office, RUN)[0]?.startTimeMs).toBe(late);
  });

  it("takes the PID from the host's marker and records its start time when it is the host", async () => {
    const row = pendingRow();
    writeFileSync(
      join(runDir, hostMarkerName(AGENT)),
      JSON.stringify({ run: RUN, agent: AGENT, pid: 6001 }),
    );
    t.clock.advance(1_000);
    const started = t.clock.now();
    expect(await resolvePendingHost(office, row, probeOf({ startTimeMs: started }))).toEqual({
      kind: "recorded",
      pid: 6001,
      alive: true,
    });
    expect(workerHostsOf(office, RUN)[0]).toMatchObject({
      pending: false,
      pid: 6001,
      startTimeMs: started,
    });
  });

  it("revokes a launch no host claimed: nothing ran and the row is removed", async () => {
    const row = pendingRow();
    writeFileSync(join(runDir, LAUNCH_FILE), JSON.stringify({ run: RUN, agent: AGENT }));
    writeFileSync(join(runDir, `${LAUNCH_FILE}.tmp`), "{}");
    expect(await resolvePendingHost(office, row, probeOf({}))).toEqual({ kind: "revoked" });
    expect(workerHostsOf(office, RUN)).toEqual([]);
    // The task message never stays: no launch file of any kind is left.
    expect(readdirSync(runDir)).toEqual([]);
  });

  it("finds a host that claimed the launch but died before its marker, and closes it out as dead", async () => {
    const row = pendingRow();
    writeFileSync(
      join(runDir, claimedLaunchName(6002)),
      JSON.stringify({ run: RUN, agent: AGENT }),
    );
    expect(await resolvePendingHost(office, row, probeOf(null))).toEqual({
      kind: "recorded",
      pid: 6002,
      alive: false,
    });
    // Start time 0 never matches a living process: re-attach closes it out (exit.json or lost).
    expect(workerHostsOf(office, RUN)[0]).toMatchObject({
      pending: false,
      pid: 6002,
      startTimeMs: 0,
    });
    expect(existsSync(join(runDir, claimedLaunchName(6002)))).toBe(false);
  });

  it("ignores another agent's claimed launch and marker", async () => {
    const row = pendingRow();
    writeFileSync(
      join(runDir, claimedLaunchName(6003)),
      JSON.stringify({ run: RUN, agent: "agt_other" }),
    );
    writeFileSync(
      join(runDir, hostMarkerName("agt_other")),
      JSON.stringify({ run: RUN, agent: "agt_other", pid: 6004 }),
    );
    expect(await resolvePendingHost(office, row, probeOf({}))).toEqual({ kind: "revoked" });
  });

  it("does not take a reused PID for the host: another command, or a start before the row", async () => {
    for (const info of [
      { command: "/usr/bin/vim notes.txt" },
      { command: "/opt/dipo daemon worker-host run_01JZ0000000000000000000009" },
      { startTimeMs: 1 },
      // Started after the spawn window: a later process that reused the PID.
      { startTimeMs: t.clock.now() + SPAWN_WINDOW_MS + 3_000 },
      { zombie: true },
    ]) {
      office.immediate(() => office.run("delete from worker_hosts where office_id = $office_id"));
      const row = pendingRow();
      writeFileSync(
        join(runDir, hostMarkerName(AGENT)),
        JSON.stringify({ run: RUN, agent: AGENT, pid: 6005 }),
      );
      expect(await resolvePendingHost(office, row, probeOf(info))).toEqual({
        kind: "recorded",
        pid: 6005,
        alive: false,
      });
      expect(workerHostsOf(office, RUN)[0]?.startTimeMs).toBe(0);
    }
  });
});

const START = 1_767_225_600_000;

const same = (info: Partial<ProcessInfo> = {}): ProcessProbe =>
  probeOf({ startTimeMs: START, ...info });

async function reasons(row: WorkerHostRow, probe: ProcessProbe): Promise<string> {
  const check = await verifyHostForSignal(row, probe);
  return check.ok ? "ok" : check.reason;
}

function pendingRowFresh(): WorkerHostRow {
  office.immediate(() => office.run("delete from worker_hosts where office_id = $office_id"));
  return pendingRow();
}

/** A recorded host row, alone in the table. */
function recorded(overrides: Partial<{ signalStop: boolean }> = {}): WorkerHostRow {
  office.immediate(() => office.run("delete from worker_hosts where office_id = $office_id"));
  recordWorkerHost(
    office,
    {
      pid: 7001,
      startTimeMs: START,
      runId: RUN,
      agentId: AGENT,
      socketPath: join(dir, "host.sock"),
      protocolVersion: 2,
      runDir,
      eventFile: join(runDir, "events.ndjson"),
    },
    t.clock,
  );
  if (overrides.signalStop === false) {
    office.immediate(() =>
      office.run("update worker_hosts set signal_stop = 0 where office_id = $office_id"),
    );
  }
  const row = workerHostsOf(office, RUN)[0];
  if (row === undefined) throw new Error("no row");
  return row;
}

describe("verifyHostForSignal (AC #1)", () => {
  it("passes only for the recorded process running this run's worker host", async () => {
    expect(await verifyHostForSignal(recorded(), same())).toEqual({ ok: true });
    // Within the start-time tolerance of the platform reading.
    expect(await verifyHostForSignal(recorded(), same({ startTimeMs: START + 1_500 }))).toEqual({
      ok: true,
    });
  });

  it("refuses every doubt, so an unverified PID is never signalled", async () => {
    expect(await reasons(recorded(), probeOf(null))).toContain("gone");
    expect(await reasons(recorded(), same({ startTimeMs: START + 60_000 }))).toContain(
      "PID may have been reused",
    );
    expect(await reasons(recorded(), same({ zombie: true }))).toContain("zombie");
    expect(await reasons(recorded(), same({ command: "/usr/bin/vim" }))).toContain("does not run");
    expect(
      await reasons(
        recorded(),
        same({ command: "/opt/dipo daemon worker-host run_01JZ0000000000000000000009" }),
      ),
    ).toContain("does not run");
    expect(await reasons(recorded({ signalStop: false }), same())).toContain("older dipo");
    expect(await reasons(pendingRowFresh(), same())).toContain("pending");
    const ended = recorded();
    expect(await reasons({ ...ended, endedAt: 5 }, same())).toContain("ended");
    writeFileSync(
      join(runDir, EXIT_FILE),
      JSON.stringify({ run: RUN, code: 0, signal: null, finalOffset: 10, at: 1 }),
    );
    expect(await reasons(recorded(), same())).toContain("exit.json");
  });
});
