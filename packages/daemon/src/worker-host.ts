// `dipo daemon worker-host <run-id>` (0006 decisions 2 and 8): the detached process that hosts one
// worker. The engine starts it with `DIPO_RUN_DIR` naming the run directory, stdio appended to
// `host.log` and `BUN_OPTIONS` removed; the host itself is engine code (`runWorkerHost`).

import { isAbsolute } from "node:path";

import {
  isLogLevel,
  runWorkerHost,
  RUN_DIR_ENV,
  signalGroup,
  systemSpawn,
} from "@dipsaus-orchestrator/engine";

import { noOrphansActive, type DaemonIo } from "./io";

export async function runWorkerHostForm(runId: string, io: DaemonIo): Promise<number> {
  if (noOrphansActive(io)) {
    io.writeError(
      "dipo: refusing to start a worker host with --no-orphans (in the Bun flags or BUN_OPTIONS): it would kill the worker when the daemon exits.",
    );
    return 1;
  }
  const runDir = io.env[RUN_DIR_ENV];
  if (runDir === undefined || !isAbsolute(runDir)) {
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
    io.writeError(
      `dipo: worker host failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}
