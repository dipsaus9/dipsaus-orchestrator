// CI only (0017 section 1): real processes. A real worker host runs a scripted shell worker and is
// stopped over its socket with the stop sequence's ops (stdin close, SIGTERM, then SIGKILL), with
// short delays. exit.json, the exit line in events.ndjson and worker_hosts.exit_signal name the
// signal that ended the worker; a worker that handles SIGTERM and exits 143, as Claude Code does,
// gets the signal the host sent, marked inferred; a worker that exits on its own keeps null
// (DIPO-88).

import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { connectHost } from "../../src/host/client";
import { WorkerHost } from "../../src/host/main";
import {
  EVENTS_FILE,
  EXIT_FILE,
  hostSocketPath,
  LAUNCH_FILE,
  type HostExitFile,
  type HostLaunch,
} from "../../src/host/protocol";
import { Ingestor } from "../../src/ingest/ingestor";
import { systemClock } from "../../src/platform/clock";
import { signalGroup, systemSpawn } from "../../src/platform/process";
import { ingestFixture, target } from "../ingest/helpers";
import { scriptedWorker } from "../workers/scripts";

/** Tells the test the worker installed its traps; on stderr, so ingestion reads no event. */
const READY = "echo ready >&2";
/** Waits without reading stdin, so the stdin close of the stop does not end the worker. */
const IDLE = "while :; do sleep 0.05; done";

interface Ended {
  readonly exit: HostExitFile;
  readonly line: unknown;
  readonly row: unknown;
}

/** Runs `script` under a real host, sends the stop ops when `stop` is set, then ingests it. */
async function runWorker(dir: string, script: string, stop: boolean): Promise<Ended> {
  const f = await ingestFixture(dir);
  const runDir = dir;
  const launch: HostLaunch = {
    version: 1,
    run: f.run,
    agent: f.agent,
    socket: hostSocketPath(join(dir, "rt"), f.run),
    deadline: systemClock.now() + 60_000,
    plan: {
      argv: ["/bin/sh", "-c", script],
      env: { PATH: "/usr/bin:/bin" },
      cwd: dir,
      files: [],
      stdin: [],
    },
  };
  writeFileSync(join(runDir, LAUNCH_FILE), JSON.stringify(launch), { mode: 0o600 });
  const host = WorkerHost.start({
    runId: f.run,
    runDir,
    clock: systemClock,
    spawn: systemSpawn,
    killGroup: (pgid, signal) => {
      signalGroup(pgid, signal);
    },
    pid: process.pid,
  });
  if (stop) {
    const deadline = performance.now() + 5000;
    while (host.status().offset === 0 && performance.now() < deadline) await Bun.sleep(10);
    const connected = await connectHost(launch.socket, {
      runId: f.run,
      clock: systemClock,
      timeoutMs: 2000,
    });
    if (!connected.ok) throw new Error(`cannot connect: ${connected.reason}`);
    const client = connected.client;
    // The Claude stop sequence (encode.ts), with 100 ms and 3 s for 10 s and 30 s; the wide gap
    // keeps a loaded runner from sending SIGKILL before the worker handled SIGTERM.
    expect(await client.request({ op: "closeStdin" })).toEqual({ ok: true });
    expect(await client.request({ op: "signal", signal: "SIGTERM", afterMs: 100 })).toEqual({
      ok: true,
    });
    expect(await client.request({ op: "signal", signal: "SIGKILL", afterMs: 3000 })).toEqual({
      ok: true,
    });
  }
  const exit = await host.done;
  const lines = readFileSync(join(runDir, EVENTS_FILE), "utf8").trim().split("\n");
  const last = JSON.parse(lines.at(-1) ?? "{}") as { ch: string; data: string };
  expect(last.ch).toBe("exit");
  expect(JSON.parse(readFileSync(join(runDir, EXIT_FILE), "utf8"))).toEqual(exit);

  // Ingestion copies the exit line onto the host's row, as the daemon does.
  const adapter = scriptedWorker({ script: [] });
  const ingestor = new Ingestor({ office: f.office, clock: f.t.clock });
  expect(ingestor.track(target(f, adapter, { events: [] }, { work: false })).status).toBe("ended");
  const row = f.office.get(
    `select exit_code, exit_signal, exit_signal_inferred from worker_hosts
      where office_id = $office_id and run_id = $run`,
    { run: f.run },
  );
  f.t.state.close();
  return { exit, line: JSON.parse(last.data), row };
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("exit signal of a real worker host", () => {
    it(
      "records SIGTERM as inferred when the worker handles it and exits 143",
      () =>
        withTempDir(async (dir) => {
          const ended = await runWorker(dir, `trap 'exit 143' TERM; ${READY}; ${IDLE}`, true);
          expect(ended.exit).toMatchObject({ code: 143, signal: "SIGTERM", signalInferred: true });
          expect(ended.line).toEqual({ code: 143, signal: "SIGTERM", signalInferred: true });
          expect(ended.row).toEqual({
            exit_code: 143,
            exit_signal: "SIGTERM",
            exit_signal_inferred: 1,
          });
        }),
      20_000,
    );

    it(
      "records SIGTERM read from the process when the worker dies of it",
      () =>
        withTempDir(async (dir) => {
          const ended = await runWorker(dir, `${READY}; exec sleep 30`, true);
          expect(ended.exit).toMatchObject({ code: null, signal: "SIGTERM" });
          expect(ended.exit.signalInferred).toBeUndefined();
          expect(ended.line).toEqual({ code: null, signal: "SIGTERM" });
          expect(ended.row).toEqual({
            exit_code: null,
            exit_signal: "SIGTERM",
            exit_signal_inferred: 0,
          });
        }),
      20_000,
    );

    it(
      "records SIGKILL when the worker ignores SIGTERM and the kill step was needed",
      () =>
        withTempDir(async (dir) => {
          const ended = await runWorker(dir, `trap '' TERM; ${READY}; ${IDLE}`, true);
          expect(ended.exit).toMatchObject({ code: null, signal: "SIGKILL" });
          expect(ended.line).toEqual({ code: null, signal: "SIGKILL" });
          expect(ended.row).toEqual({
            exit_code: null,
            exit_signal: "SIGKILL",
            exit_signal_inferred: 0,
          });
        }),
      20_000,
    );

    it(
      "keeps exit_signal null for a worker that exits on its own",
      () =>
        withTempDir(async (dir) => {
          const ended = await runWorker(dir, `${READY}; exit 0`, false);
          expect(ended.exit).toMatchObject({ code: 0, signal: null });
          expect(ended.exit.signalInferred).toBeUndefined();
          expect(ended.line).toEqual({ code: 0, signal: null });
          expect(ended.row).toEqual({ exit_code: 0, exit_signal: null, exit_signal_inferred: 0 });
        }),
      20_000,
    );
  });
}
