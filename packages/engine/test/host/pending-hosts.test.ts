// The host row is written pending before the spawn (DIPO-93) and a restart records the PID of the
// host it stands for (0005); a host whose socket does not answer after a restart is signalled only
// after its PID, start time and command are verified, and then with one SIGTERM to its PID alone.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { HOST_LAUNCH_DEADLINE_MS } from "../../src/run/hosts";
import type { OfficeHandle } from "../../src/db/office";
import { EXIT_FILE } from "../../src/host/protocol";
import type { DetachedSpawnOptions, ProcessInfo, ProcessProbe } from "../../src/platform/process";
import {
  recordPendingHost,
  recordPendingPid,
  recordWorkerHost,
  runDirectory,
  signalVerifiedHost,
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

/** A probe reading `info` over the host's; the arguments are the command's words (no spaces). */
const probeOf =
  (info: Partial<ProcessInfo> | null): ProcessProbe =>
  async (pid) => {
    if (info === null) return null;
    const read = { pid, startTimeMs: t.clock.now(), zombie: false, command: HOST_COMMAND, ...info };
    return { ...read, argv: read.argv ?? read.command.split(" ") };
  };

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
      startedAt: t.clock.now(),
      launchDeadline: t.clock.now() + HOST_LAUNCH_DEADLINE_MS,
    },
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
    startedAt: t.clock.now(),
    launchDeadline: t.clock.now() + HOST_LAUNCH_DEADLINE_MS,
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

describe("recordPendingPid after a restart (0005)", () => {
  it("records the PID and start time of the host a pending row stands for", () => {
    const row = pendingRow();
    recordPendingPid(office, row, 6001, 1_234);
    expect(workerHostsOf(office, RUN)[0]).toMatchObject({
      pending: false,
      pid: 6001,
      startTimeMs: 1_234,
    });
  });

  it("changes nothing on a row that is no longer pending", () => {
    const row = pendingRow();
    recordPendingPid(office, row, 6001, 1_234);
    recordPendingPid(office, row, 6002, 5_678);
    expect(workerHostsOf(office, RUN)[0]).toMatchObject({ pid: 6001, startTimeMs: 1_234 });
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
      launchDeadline: t.clock.now() + HOST_LAUNCH_DEADLINE_MS,
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

describe("verifyHostForSignal (0005)", () => {
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

describe("signalVerifiedHost (0005)", () => {
  it("sends exactly one SIGTERM to the verified host PID", async () => {
    const sent: [number, string][] = [];
    const signal = (pid: number, name: string) => {
      sent.push([pid, name]);
      return true;
    };
    expect(await signalVerifiedHost(recorded(), same(), signal)).toBeNull();
    expect(sent).toEqual([[7001, "SIGTERM"]]);
  });

  it("never signals a PID it cannot verify: gone, reused, a zombie, another command or an older host", async () => {
    for (const [row, probe] of [
      [recorded(), probeOf(null)],
      [recorded(), same({ startTimeMs: START + 60_000 })],
      [recorded(), same({ zombie: true })],
      [recorded(), same({ command: "/usr/bin/vim" })],
      [recorded({ signalStop: false }), same()],
    ] as const) {
      const sent: number[] = [];
      const why = await signalVerifiedHost(row, probe, (pid) => {
        sent.push(pid);
        return true;
      });
      expect(why).not.toBeNull();
      expect(sent).toEqual([]);
    }
  });

  it("says when the signal was refused", async () => {
    expect(await signalVerifiedHost(recorded(), same(), () => false)).toContain("refused");
  });
});
