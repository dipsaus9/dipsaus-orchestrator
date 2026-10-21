// The daemon's box workers (DIPO-271): at start the daemon sweeps the export folders a post-run
// token check left behind (criterion 9), it finds Apple `container` on its PATH without running
// it, and a box run counts as ended only once its run ended and every worker host exited. Temp
// folders only; no `container`, no Keychain and no daemon process.

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import type { OfficeId, RunId } from "@dipsaus-orchestrator/contract";
import {
  AdapterHolds,
  currentPlatform,
  TOKEN_CHECK_DIR_PREFIX,
  type OfficeHandle,
  type WorkerHostRow,
} from "@dipsaus-orchestrator/engine";
import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import {
  boxRunEnded,
  containerOnPath,
  daemonRuns,
  type DaemonRunsOptions,
  sweepBoxTokenChecks,
} from "../../src/runs";

function leftovers(dir: string): void {
  mkdirSync(join(dir, `${TOKEN_CHECK_DIR_PREFIX}a1`));
  writeFileSync(join(dir, `${TOKEN_CHECK_DIR_PREFIX}a1`, "box.tar"), "export");
  mkdirSync(join(dir, `${TOKEN_CHECK_DIR_PREFIX}b2`));
  mkdirSync(join(dir, "dipo-run-keep"));
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

  it("sweeps them when the daemon's run services start", () =>
    withTempDir(async (dir) => {
      leftovers(dir);
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
});
