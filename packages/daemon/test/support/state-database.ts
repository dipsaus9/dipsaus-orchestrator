// A state database migrated to this binary's head, made the way the daemon makes it: `createEngine`
// recovers, its first recovery step opens and migrates `<state>/dipo.db`, and it closes cleanly (no
// `-wal` or `-shm`). Every other process concern is a fake that never runs (DIPO-318).

import { join } from "node:path";

import { SOFTWARE_CONFIG_DEFAULTS } from "@dipsaus-orchestrator/contract";
import { createEngine } from "@dipsaus-orchestrator/engine";
import { createLogger } from "@dipsaus-orchestrator/engine/platform";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

function never(what: string): never {
  throw new Error(`no ${what} starts while a state database is made`);
}

/** Migrates `<stateDir>/dipo.db` and returns its path; `root` holds the run and temp folders. */
export async function migratedDatabase(stateDir: string, root: string): Promise<string> {
  const clock = new ManualClock();
  const engine = createEngine({
    clock,
    logger: createLogger({ clock, sinks: [], component: "test" }),
    spawn: () => never("process"),
    probe: async () => null,
    spawnKeepAwake: () => never("keep-awake"),
    hosts: { start: async () => never("worker host") },
    forwarders: { forward: async () => never("forwarder"), reach: async () => false },
    listenHttp: () => never("listener"),
    env: {},
    paths: { stateDir, runtimeDir: join(root, "run"), tmpRoot: join(root, "tmp"), home: root },
    tools: {},
    settings: SOFTWARE_CONFIG_DEFAULTS,
    daemon: {
      pid: process.pid,
      uid: -1,
      version: "0.0.0-test",
      startedAt: clock.now(),
      socket: join(root, "run", "dipo.sock"),
      upgradePending: () => false,
      requestStop: () => {},
    },
  });
  try {
    await engine.recover();
    if (engine.state() !== "running") throw new Error(`the engine is ${engine.state()}`);
  } finally {
    await engine.stop();
    engine.closeDatabase();
  }
  return join(stateDir, "dipo.db");
}
