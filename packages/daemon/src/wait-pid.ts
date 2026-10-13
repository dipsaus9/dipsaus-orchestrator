// `dipo daemon wait-pid <pid>` (0006 decision 12): waits until the process is gone, then exits 0.
// On Linux the daemon runs it under `systemd-inhibit`, whose lock lasts as long as this command,
// so the lock ends with the daemon even after a crash.

import { waitForPidExit } from "@dipsaus-orchestrator/engine";

import type { DaemonIo } from "./io";

export async function runWaitPidForm(
  pid: number,
  io: DaemonIo,
  exists?: (pid: number) => boolean,
): Promise<number> {
  await waitForPidExit(pid, io.clock, exists);
  return 0;
}
