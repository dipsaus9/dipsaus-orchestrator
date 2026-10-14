// The engine side of a worker host (DIPO-44 AC #1 and #7): it writes `launch.json`, starts
// `dipo daemon worker-host <run-id>` detached with stdio on `host.log` and `BUN_OPTIONS` removed,
// records PID, start time, socket path and protocol version in `worker_hosts`, and judges
// liveness by PID plus start time only, a zombie being dead.

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { openStateDatabase } from "../../src/db/database";
import {
  HOST_PROTOCOL_VERSION,
  hostSocketPath,
  LAUNCH_FILE,
  type HostLaunch,
} from "../../src/host/protocol";
import { currentPlatform } from "../../src/platform/paths";
import {
  systemProcessProbe,
  type DetachedSpawnOptions,
  type ProcessInfo,
  type ProcessProbe,
} from "../../src/platform/process";
import {
  hostAlive,
  HostStartError,
  launchWorkerHost,
  recordHostExit,
  runDirectory,
  startWorkerHost,
  workerHostsOf,
} from "../../src/runs/worker-hosts";
import type { LaunchPlan } from "../../src/workers/types";
import { localMounts, memoryLogger } from "../db/helpers";

const RUN = "run_01JZ0000000000000000000001";
const AGENT = "agt_01JZ0000000000000000000001";
const OFFICE = "off_01JZ0000000000000000000001" as OfficeId;
const START = 1_767_225_600_000;

const PLAN: LaunchPlan = {
  argv: ["/usr/local/bin/claude", "-p"],
  env: { PATH: "/usr/bin" },
  cwd: "/work/tree",
  files: [],
  stdin: ["task\n"],
};

const live =
  (startTimeMs: number, zombie = false): ProcessProbe =>
  async (pid) =>
    ({ pid, startTimeMs, zombie, command: "dipo daemon worker-host" }) satisfies ProcessInfo;

function launchOptions(dir: string, calls: DetachedSpawnOptions[]) {
  return {
    runId: RUN,
    agentId: AGENT,
    officeDir: join(dir, "repo", ".git", "dipo"),
    runtimeDir: join(dir, "rt"),
    plan: PLAN,
    dipoCommand: ["/opt/dipo"] as [string],
    env: {
      HOME: "/home/m",
      BUN_OPTIONS: "--no-orphans",
      BUN_FEATURE_FLAG_NO_ORPHANS: "1",
      DIPO_HOME: "/s",
    },
    probe: live(START),
    spawnDetached: (options: DetachedSpawnOptions) => {
      calls.push(options);
      return { pid: 5150 };
    },
  };
}

describe("launchWorkerHost", () => {
  it("starts the host detached with stdio on host.log and the Bun flags removed", () =>
    withTempDir(async (dir) => {
      const calls: DetachedSpawnOptions[] = [];
      const host = await launchWorkerHost(launchOptions(dir, calls));
      const runDir = runDirectory(join(dir, "repo", ".git", "dipo"), RUN);
      expect(calls).toEqual([
        {
          cmd: ["/opt/dipo", "daemon", "worker-host", RUN],
          cwd: runDir,
          env: { HOME: "/home/m", DIPO_HOME: "/s", DIPO_RUN_DIR: runDir },
          outputFile: join(runDir, "host.log"),
        },
      ]);
      expect(host).toEqual({
        pid: 5150,
        startTimeMs: START,
        runId: RUN,
        agentId: AGENT,
        socketPath: hostSocketPath(join(dir, "rt"), RUN),
        protocolVersion: HOST_PROTOCOL_VERSION,
        runDir,
        eventFile: join(runDir, "events.ndjson"),
      });
      expect(statSync(runDir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, "rt", "hosts")).mode & 0o777).toBe(0o700);
      const launchPath = join(runDir, LAUNCH_FILE);
      expect(statSync(launchPath).mode & 0o777).toBe(0o600);
      const launch = JSON.parse(readFileSync(launchPath, "utf8")) as HostLaunch;
      expect(launch).toEqual({
        version: 1,
        run: RUN,
        agent: AGENT,
        socket: host.socketPath,
        plan: PLAN,
      });
    }));

  it("fails when the host is gone at once, and refuses a bad run id", () =>
    withTempDir(async (dir) => {
      const options = { ...launchOptions(dir, []), probe: (async () => null) as ProcessProbe };
      await expect(launchWorkerHost(options)).rejects.toThrow(HostStartError);
      const launchPath = join(runDirectory(options.officeDir, RUN), LAUNCH_FILE);
      expect(existsSync(launchPath)).toBe(false);
      const throwing = {
        ...options,
        spawnDetached: () => {
          throw new Error("EAGAIN");
        },
      };
      await expect(launchWorkerHost(throwing)).rejects.toThrow("EAGAIN");
      expect(existsSync(launchPath)).toBe(false);
      await expect(launchWorkerHost({ ...options, runId: "run-0001" })).rejects.toThrow(
        "not a run id",
      );
    }));
});

describe("worker_hosts", () => {
  it("records PID, start time, socket path and protocol version, then the exit", () =>
    withTempDir(async (dir) => {
      const clock = new ManualClock();
      const state = await openStateDatabase({
        stateDir: join(dir, "state"),
        logger: memoryLogger(),
        readMounts: localMounts,
        clock,
        engineVersion: "0.0.0-test",
      });
      try {
        const db = state.connection;
        db.immediate(() =>
          db.run(
            `insert into offices (office_id, path, display_name, added_at, epoch, next_seq, replay_floor_seq)
             values ($id, '/repo', 'repo', 0, 'e', 1, 0)`,
            { id: OFFICE },
          ),
        );
        const office = state.office(OFFICE);
        const host = await startWorkerHost(office, clock, launchOptions(dir, []));
        expect(workerHostsOf(office, RUN)).toEqual([
          {
            runId: RUN,
            agentId: AGENT,
            pid: 5150,
            startTimeMs: START,
            socketPath: host.socketPath,
            protocolVersion: 2,
            runDir: host.runDir,
            eventFile: host.eventFile,
            processedOffset: 0,
            exitCode: null,
            exitSignal: null,
            finalOffset: null,
            endedAt: null,
            mode: "steer",
            startedAt: clock.now(),
          },
        ]);
        recordHostExit(office, AGENT, {
          run: RUN,
          code: 143,
          signal: null,
          finalOffset: 900,
          at: clock.now() + 5,
        });
        expect(workerHostsOf(office, RUN)[0]).toMatchObject({
          exitCode: 143,
          exitSignal: null,
          finalOffset: 900,
          endedAt: clock.now() + 5,
        });
        expect(
          workerHostsOf(state.office("off_01JZ0000000000000000000002" as OfficeId), RUN),
        ).toEqual([]);
      } finally {
        state.close();
      }
    }));
});

describe("hostAlive", () => {
  const host = { pid: 5150, startTimeMs: START };

  it("is PID plus start time: a zombie, a reused PID or no process is dead", async () => {
    expect(await hostAlive(host, live(START + 1000))).toBe(true);
    expect(await hostAlive(host, live(START, true))).toBe(false);
    expect(await hostAlive(host, live(START + 60_000))).toBe(false);
    expect(await hostAlive(host, async () => null)).toBe(false);
  });

  it("checks this process with the system probe", async () => {
    const probe = systemProcessProbe(currentPlatform());
    const self = await probe(process.pid);
    expect(self).not.toBeNull();
    expect(await hostAlive({ pid: process.pid, startTimeMs: self?.startTimeMs ?? 0 }, probe)).toBe(
      true,
    );
  });
});
