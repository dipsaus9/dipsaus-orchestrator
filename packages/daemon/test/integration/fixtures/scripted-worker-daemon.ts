// A real daemon process for the re-attach test (DIPO-316): `dipo daemon --foreground` whose worker
// port plans a scripted worker (`scripted-worker.ts`) instead of Claude, so no model is reached.
// The daemon starts each worker host as `<bun> <this file> daemon worker-host <run>`, which runs
// the daemon's own worker-host form here.
//
// Every developer runs in its box (0021, DIPO-240). This test daemon has no box backend (its PATH
// has no `container`), so the plan records the run directory as a box run's, as the box workers do
// when they make the box; re-attach then follows the host as it follows a box run's host, instead
// of stopping it as a session on the Mac. Usage: bun scripted-worker-daemon.ts [daemon <form> ...]

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type {
  LaunchPlan,
  RunLaunchPaths,
  WorkerPort,
  WorkerSpec,
} from "@dipsaus-orchestrator/engine";

import { runForeground } from "../../../src/foreground";
import { runDaemon } from "../../../src/index";
import { defaultIo } from "../../../src/io";

const WORKER = resolve(import.meta.dir, "scripted-worker.ts");
/** The engine's `BOX_RUN_FILE` (`box/workers.ts`), which re-attach checks by its presence. */
const BOX_RUN_FILE = "box-run.json";

function scriptedPlan(spec: WorkerSpec, paths: RunLaunchPaths): LaunchPlan {
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(paths.runDir, BOX_RUN_FILE), "{}\n", { mode: 0o600 });
  return {
    argv: [process.execPath, WORKER],
    env: {
      PATH: "/usr/bin:/bin",
      SCRIPTED_SESSION: spec.session.id,
      SCRIPTED_MODEL: spec.model,
    },
    cwd: spec.workdir,
    files: [],
    stdin: [],
  };
}

function scripted(port: WorkerPort): WorkerPort {
  return {
    ...port,
    adapter: (paths, config) => ({
      ...port.adapter(paths, config),
      plan: (spec: WorkerSpec) => scriptedPlan(spec, paths),
    }),
    prepare: async (spec, paths) => ({ ok: true, plan: scriptedPlan(spec, paths) }),
  };
}

const argv = process.argv.slice(2);
if (argv[0] === "daemon" && argv[1] !== "--foreground") {
  process.exit(await runDaemon(argv.slice(1)));
}

/** A keep-awake process that takes no assertion on the machine running the test. */
function noKeepAwake() {
  const exit = Promise.withResolvers<{ code: number; signal: null; stderr: string }>();
  return {
    pid: 0,
    exited: exit.promise,
    kill: () => exit.resolve({ code: 0, signal: null, stderr: "" }),
  };
}

const code = await runForeground(
  [],
  { ...defaultIo, version: "0.0.0-test" },
  {
    workerPort: scripted,
    spawnKeepAwake: noKeepAwake,
  },
);
process.exit(code);
