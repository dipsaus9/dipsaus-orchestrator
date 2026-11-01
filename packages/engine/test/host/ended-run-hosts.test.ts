// `stopHostsOfEndedRun` against real processes (DIPO-411, 0005): a worker host still alive for a
// run the engine recorded as ended gets one SIGTERM, and only when its PID and start time match its
// `worker_hosts` row and it passes the verified-signal check. The stand-in host is a real Bun
// process in the host's source form (`lateHostScript`), so the process table is read for real; a
// reused PID, another command, a run that has not ended and a check that throws send nothing.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { type RunId, StoryKey } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../../src/db/office";
import { currentPlatform } from "../../src/platform/paths";
import {
  pidExists,
  type ProcessProbe,
  type SignalProcess,
  signalProcess,
  systemProcessProbe,
} from "../../src/platform/process";
import { insertRun } from "../../src/records/run-records";
import {
  liveRunHostsText,
  recordWorkerHost,
  stopHostsOfEndedRun,
} from "../../src/records/worker-hosts";
import { addOffice, openTestState, type TestState } from "../commands/helpers";
import { lateHostScript } from "./fixtures/late-host-script";

const RUN = "run_01JZ0000000000000000000001" as RunId;
const AGENT = "agt_01JZ0000000000000000000001";
const HOUR = 3_600_000;
const probe = systemProcessProbe(currentPlatform());

let dir = "";
let standIn = "";
let t: TestState;
let office: OfficeHandle;
const children: Bun.Subprocess[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "ended-hosts-"));
  standIn = lateHostScript(dir);
  t = await openTestState(dir);
  office = addOffice(t);
  office.immediate(() =>
    insertRun(office, {
      runId: RUN,
      kind: "story",
      key: StoryKey.parse(t.ids.next("sto")),
      story: "DIPO-1",
      tier: "M",
      role: "developer",
      model: "haiku",
      startSha: "b".repeat(40),
      branch: "DIPO-1/add-a-greeting",
      budgetUnit: "tokens",
      budgetLimit: 100_000,
      loopCap: 3,
      reviewRoundCap: null,
      configHash: "h",
      overrideKeys: null,
      runProfileId: null,
      startedAt: t.clock.now(),
    }),
  );
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  t.state.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Starts a real process; resolves once the process table shows it with its command line. */
async function start(argv: string[]): Promise<{ pid: number; startTimeMs: number }> {
  const child = Bun.spawn(argv, { stdio: ["ignore", "ignore", "ignore"] });
  children.push(child);
  for (let i = 0; i < 200; i += 1) {
    const info = await probe(child.pid);
    if (info !== null && info.command.endsWith(RUN)) return info;
    await Bun.sleep(10);
  }
  throw new Error(`the child ${argv.join(" ")} did not come up`);
}

/** The run's recorded host row for `pid`, with `startTimeMs` as its recorded start time. */
function record(pid: number, startTimeMs: number): void {
  recordWorkerHost(
    office,
    {
      pid,
      startTimeMs,
      runId: RUN,
      agentId: AGENT,
      socketPath: join(dir, "host.sock"),
      protocolVersion: 3,
      runDir: dir,
      eventFile: join(dir, "events.ndjson"),
      launchDeadline: t.clock.now() + HOUR,
    },
    t.clock,
  );
}

function endRun(): void {
  office.immediate(() =>
    office.run(
      "update runs set ended_at = $at, end_kind = 'parked' where office_id = $office_id and run_id = $run",
      { at: t.clock.now(), run: RUN },
    ),
  );
}

/** Every signal sent, passed on to the real one. */
function recording(): { readonly sent: [number, string][]; readonly signal: SignalProcess } {
  const sent: [number, string][] = [];
  return {
    sent,
    signal: (pid, signal) => {
      sent.push([pid, signal]);
      return signalProcess(pid, signal);
    },
  };
}

/** A process table that cannot be read. */
const throwing: ProcessProbe = async () => {
  throw new Error("ps failed");
};

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 300 && pidExists(pid); i += 1) await Bun.sleep(10);
  return !pidExists(pid);
}

describe("stopHostsOfEndedRun on real processes (DIPO-411)", () => {
  it("sends one SIGTERM to the live host of an ended run, which exits", async () => {
    const host = await start([process.execPath, standIn, "daemon", "worker-host", RUN]);
    record(host.pid, host.startTimeMs);
    endRun();
    const { sent, signal } = recording();
    const found = await stopHostsOfEndedRun(office, RUN, probe, signal);
    expect(found).toEqual([{ pid: host.pid, refused: null }]);
    expect(sent).toEqual([[host.pid, "SIGTERM"]]);
    expect(await gone(host.pid)).toBe(true);
    expect(liveRunHostsText(found)).toBe(
      `its worker host (pid ${host.pid}) still ran, so dipo sent it SIGTERM to stop its worker`,
    );
    // Once it is gone nothing runs, so a resume or a drop goes on.
    expect(await stopHostsOfEndedRun(office, RUN, probe, signal)).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it("sends nothing to a reused PID: the live process started an hour after the recorded host", async () => {
    const other = await start([process.execPath, standIn, "daemon", "worker-host", RUN]);
    record(other.pid, other.startTimeMs - HOUR);
    endRun();
    const { sent, signal } = recording();
    // The recorded host is gone; the process on its PID is another one and keeps running.
    expect(await stopHostsOfEndedRun(office, RUN, probe, signal)).toEqual([]);
    expect(sent).toEqual([]);
    await Bun.sleep(100);
    expect(pidExists(other.pid)).toBe(true);
  });

  it("sends nothing to a process with the row's PID and start time that does not run the host", async () => {
    // Bun running the stand-in with other words: its identity check fails, so no signal.
    const other = await start([process.execPath, standIn, "logs", RUN]);
    record(other.pid, other.startTimeMs);
    endRun();
    const { sent, signal } = recording();
    const found = await stopHostsOfEndedRun(office, RUN, probe, signal);
    expect(found).toEqual([
      { pid: other.pid, refused: expect.stringContaining("does not run") as unknown as string },
    ]);
    expect(sent).toEqual([]);
    expect(liveRunHostsText(found)).toContain("dipo sent it no signal, because");
    expect(pidExists(other.pid)).toBe(true);
  });

  it("sends nothing to the host of a run that has not ended", async () => {
    const host = await start([process.execPath, standIn, "daemon", "worker-host", RUN]);
    record(host.pid, host.startTimeMs);
    const { sent, signal } = recording();
    expect(await stopHostsOfEndedRun(office, RUN, probe, signal)).toEqual([
      { pid: host.pid, refused: "its run has not ended" },
    ]);
    expect(sent).toEqual([]);
    expect(pidExists(host.pid)).toBe(true);
  });

  it("sends nothing and says so when the check cannot be made", async () => {
    const host = await start([process.execPath, standIn, "daemon", "worker-host", RUN]);
    record(host.pid, host.startTimeMs);
    endRun();
    const { sent, signal } = recording();
    // The liveness check answers once, then the process table cannot be read.
    let calls = 0;
    const failing: ProcessProbe = async (pid) => {
      calls += 1;
      if (calls > 1) throw new Error("ps failed");
      return probe(pid);
    };
    expect(await stopHostsOfEndedRun(office, RUN, failing, signal)).toEqual([
      { pid: host.pid, refused: "checking it failed (ps failed)" },
    ]);
    expect(await stopHostsOfEndedRun(office, RUN, throwing, signal)).toEqual([
      { pid: host.pid, refused: "checking it failed (ps failed)" },
    ]);
    expect(sent).toEqual([]);
    expect(pidExists(host.pid)).toBe(true);
  });
});
