// `dipo daemon worker-host <run-id>` (0006 decisions 2 and 8): the detached process that hosts one
// worker. The engine starts it with `DIPO_RUN_DIR` naming the run directory, stdio appended to
// `host.log` and the Bun flag variables removed; the host itself is engine code (`runWorkerHost`).
// `launch.json` holds the task message, so every refusal removes it before returning.

import { rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import {
  isLogLevel,
  LAUNCH_FILE,
  runWorkerHost,
  RUN_DIR_ENV,
  signalGroup,
  systemSpawn,
} from "@dipsaus-orchestrator/engine";

import { noOrphansActive, type DaemonIo } from "./io";

function removeLaunch(runDir: string | null): void {
  if (runDir === null) return;
  try {
    rmSync(join(runDir, LAUNCH_FILE), { force: true });
  } catch {
    // Nothing to remove, or no access; the host never read it either way.
  }
}

export async function runWorkerHostForm(runId: string, io: DaemonIo): Promise<number> {
  const given = io.env[RUN_DIR_ENV];
  const runDir = given !== undefined && isAbsolute(given) ? given : null;
  if (noOrphansActive(io)) {
    removeLaunch(runDir);
    io.writeError(
      "dipo: refusing to start a worker host with --no-orphans (in the Bun flags or BUN_OPTIONS): it would kill the worker when the daemon exits.",
    );
    return 1;
  }
  if (runDir === null) {
    io.writeError(`dipo: worker-host needs ${RUN_DIR_ENV}, the absolute run directory`);
    return 2;
  }
  const level = io.env["DIPO_LOG"];
  try {
    return await runWorkerHost({
      runId,
      runDir,
      clock: io.clock,
      spawn: systemSpawn,
      killGroup: (pgid, signal) => {
        signalGroup(pgid, signal);
      },
      pid: process.pid,
      ...(level !== undefined && isLogLevel(level) ? { logLevel: level } : {}),
    });
  } catch (error) {
    removeLaunch(runDir);
    io.writeError(
      `dipo: worker host failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}
