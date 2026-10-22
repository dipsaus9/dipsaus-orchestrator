// The daemon's box workers (DIPO-271): at start the daemon sweeps the export folders a post-run
// token check left behind (criterion 9) and the part stage folders a stopped daemon left (DIPO-290),
// it finds Apple `container` on its PATH without running
// it, and a box run counts as ended only once its run ended and every worker host exited. Temp
// folders only; no `container`, no Keychain and no daemon process.

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import type { OfficeId, RunId } from "@dipsaus-orchestrator/contract";
import {
  AdapterHolds,
  BoxCollisions,
  currentPlatform,
  type DoorPart,
  TOKEN_CHECK_DIR_PREFIX,
  type OfficeHandle,
  PART_STAGE_PREFIX,
  partStageRoot,
  type WorkerHostRow,
} from "@dipsaus-orchestrator/engine";
import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import {
  boxRunEnded,
  containerOnPath,
  daemonRuns,
  type DaemonRunsOptions,
  deliverThenCheck,
  reviewHostRuns,
  sweepBoxPartStages,
  sweepBoxTokenChecks,
} from "../../src/runs";

function leftovers(dir: string): void {
  mkdirSync(join(dir, `${TOKEN_CHECK_DIR_PREFIX}a1`));
  writeFileSync(join(dir, `${TOKEN_CHECK_DIR_PREFIX}a1`, "box.tar"), "export");
  mkdirSync(join(dir, `${TOKEN_CHECK_DIR_PREFIX}b2`));
  mkdirSync(join(dir, "dipo-run-keep"));
}

/** A worker host row of `agentId` that ended at `endedAt`, or still runs. */
function agentHost(agentId: string, endedAt: number | null): WorkerHostRow {
  return { endedAt, exitCode: null, exitSignal: null, agentId } as unknown as WorkerHostRow;
}

const quiet = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

/** A worker host row that ended at `endedAt`, or still runs. */
function host(endedAt: number | null): WorkerHostRow {
  return { endedAt, exitCode: null, exitSignal: null } as unknown as WorkerHostRow;
}

describe("the daemon's box workers", () => {
  it("sweeps the token check's leftover exports at start", () =>
    withTempDir(async (dir) => {
      leftovers(dir);
      const lines: unknown[] = [];
      expect(await sweepBoxTokenChecks(dir, { info: (...line) => lines.push(line) })).toBe(2);
      expect(readdirSync(dir)).toEqual(["dipo-run-keep"]);
      expect(lines).toHaveLength(1);
    }));

  it("sweeps the part stage folders it left at start, only in its own folder of stages", () =>
    withTempDir(async (dir) => {
      const own = partStageRoot(join(dir, "state"));
      // A hand-test daemon with another DIPO_HOME has its own folder of stages.
      const other = partStageRoot(join(dir, "other-home"));
      mkdirSync(join(own, `${PART_STAGE_PREFIX}a1`, "files"), { recursive: true });
      writeFileSync(join(own, `${PART_STAGE_PREFIX}a1`, "files", "a.ts"), "box files\n");
      mkdirSync(join(other, `${PART_STAGE_PREFIX}live`), { recursive: true });
      const lines: unknown[] = [];
      expect(await sweepBoxPartStages(own, null, { info: (...line) => lines.push(line) })).toBe(1);
      expect(readdirSync(own)).toEqual([]);
      expect(readdirSync(other)).toEqual([`${PART_STAGE_PREFIX}live`]);
      expect(lines).toHaveLength(1);
      // With the box backend, the delivery's own sweep runs, which leaves the stages it uses.
      const used = { sweepStages: async () => 0 };
      expect(await sweepBoxPartStages(own, used, { info: () => {} })).toBe(0);
    }));

  it("sweeps them when the daemon's run services start", () =>
    withTempDir(async (dir) => {
      leftovers(dir);
      const stages = partStageRoot(join(dir, "state"));
      mkdirSync(join(stages, `${PART_STAGE_PREFIX}c3`), { recursive: true });
      const clock = new ManualClock();
      const options = {
        tools: {},
        platform: currentPlatform(),
        clock,
        ids: { next: () => "x" },
        env: { PATH: "/usr/bin:/bin" },
        home: dir,
        uid: process.getuid?.() ?? 0,
        runtimeDir: join(dir, "rt"),
        tmpRoot: dir,
        stateDir: join(dir, "state"),
        holds: new AdapterHolds({ clock, notify: () => {} }),
        engineGit: { forOffice: () => undefined },
        claims: {},
        offices: { config: () => undefined, get: () => undefined, loadedOffices: () => [] },
        slots: {},
        base: {},
        database: () => null,
        onChanged: () => {},
        logger: { ...quiet, child: () => quiet },
        cli: {},
        implemented: () => false,
        safeChainRoot: join(dir, "p"),
        // No box backend: the sweep still runs, since a crash may have left an export behind.
        boxes: null,
      } as unknown as DaemonRunsOptions;
      const runs = daemonRuns(options);
      expect(runs.boxes).toBeNull();
      for (
        let i = 0;
        i < 50 && readdirSync(dir).some((n) => n.startsWith(TOKEN_CHECK_DIR_PREFIX));
        i++
      ) {
        await Bun.sleep(5);
      }
      expect(readdirSync(dir).filter((n) => n.startsWith(TOKEN_CHECK_DIR_PREFIX))).toEqual([]);
      for (let i = 0; i < 50 && readdirSync(stages).length > 0; i++) await Bun.sleep(5);
      expect(readdirSync(stages)).toEqual([]);
      await runs.finishEndedBoxes();
      runs.control.close();
    }));

  it("finds container on the PATH by absolute path only, without running it", () => {
    const executable = new Set(["/opt/tools/bin/container"]);
    const isExecutable = (path: string) => executable.has(path);
    expect(containerOnPath("relative/bin:/usr/bin:/opt/tools/bin", isExecutable)).toBe(
      "/opt/tools/bin/container",
    );
    expect(containerOnPath("/usr/bin", isExecutable)).toBeUndefined();
    expect(containerOnPath(undefined, isExecutable)).toBeUndefined();
  });

  it("counts a box run as ended only once the run ended and its hosts exited", () => {
    const office = "off_1" as OfficeId;
    const rows: Record<string, { endedAt: number | null; hosts: WorkerHostRow[] }> = {
      run_live: { endedAt: null, hosts: [host(null)] },
      run_ending: { endedAt: 5, hosts: [host(null)] },
      run_done: { endedAt: 5, hosts: [host(6)] },
    };
    const offices = {
      loadedOffices: () => [office],
      get: () => ({}) as OfficeHandle,
    };
    const read = {
      run: (_handle: OfficeHandle, runId: RunId) => rows[runId] ?? null,
      hosts: (_handle: OfficeHandle, runId: string) => rows[runId]?.hosts ?? [],
    };
    expect(boxRunEnded(offices, "run_live", read)).toBe(false);
    expect(boxRunEnded(offices, "run_ending", read)).toBe(false);
    expect(boxRunEnded(offices, "run_done", read)).toBe(true);
    expect(boxRunEnded(offices, "run_unknown", read)).toBeNull();
  });

  it("keeps a reviewer's read-only copy only while a host of that agent still runs (DIPO-276)", () => {
    const office = "off_1" as OfficeId;
    const rows: Record<string, WorkerHostRow[]> = {
      run_1: [agentHost("agt_dev", null), agentHost("agt_old", 4), agentHost("agt_live", null)],
    };
    const offices = { loadedOffices: () => [office], get: () => ({}) as OfficeHandle };
    const hosts = (_handle: OfficeHandle, runId: string) => rows[runId] ?? [];
    expect(reviewHostRuns(offices, "run_1", "agt_live", hosts)).toBe(true);
    expect(reviewHostRuns(offices, "run_1", "agt_old", hosts)).toBe(false);
    expect(reviewHostRuns(offices, "run_1", "agt_gone", hosts)).toBe(false);
    expect(reviewHostRuns(offices, "run_unknown", "agt_live", hosts)).toBe(false);
  });
});

describe("the daemon's collision check of box runs (DIPO-277)", () => {
  const part: DoorPart = {
    runId: "run_1",
    box: "dipo-run_1",
    n: 1,
    name: "1700000000-1.part",
    message: "A part",
    at: 0,
  };

  it("starts a collision check once a part was delivered, and none for a part left queued", async () => {
    const clock = new ManualClock();
    let passes = 0;
    const collisions = new BoxCollisions({
      boxes: {
        copyIn: async () => {},
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      },
      code: { spawn: () => Promise.reject(new Error("no tar here")) as never, clock },
      tmpRoot: "/nonexistent",
      runs: () => {
        passes += 1;
        return [];
      },
      git: () => undefined,
      live: () => true,
      parts: {
        deliverLast: async () => ({ kind: "empty" }),
        deliverInTurn: async () => ({ kind: "empty" }),
        inTurn: (_runId, fn) => fn(),
      },
      park: () => true,
      tell: async () => {},
      notice: () => {},
    });
    const delivered: string[] = [];
    const onPart = deliverThenCheck(
      async (p) => {
        delivered.push(p.message);
      },
      () => void collisions.check(),
    );
    await onPart(part);
    expect(delivered).toEqual(["A part"]);
    // The delivered part started one pass over the box runs.
    expect(passes).toBe(1);
    const after = passes;
    const queued = deliverThenCheck(
      () => Promise.reject(new Error("the run is not going on")),
      () => void collisions.check(),
    );
    await expect(queued(part)).rejects.toThrow("not going on");
    expect(passes).toBe(after);
    collisions.stop();
  });
});
