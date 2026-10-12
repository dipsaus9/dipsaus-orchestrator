// A stand-in daemon for the CI-only detach test: it starts one worker host through the engine
// (detached, stdio on host.log, BUN_OPTIONS removed), writes the host's identity to
// `<dir>/host.json` and waits to be killed.

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { currentPlatform } from "../../../src/platform/paths";
import { systemProcessProbe } from "../../../src/platform/process";
import { launchWorkerHost } from "../../../src/runs/worker-hosts";

const [dir = "", runId = ""] = process.argv.slice(2);
const CLI_MAIN = resolve(import.meta.dir, "../../../../cli/src/main.ts");

const host = await launchWorkerHost({
  runId,
  agentId: "agt_01JZ0000000000000000000001",
  officeDir: join(dir, "repo", ".git", "dipo"),
  runtimeDir: join(dir, "rt"),
  plan: {
    argv: ["/bin/sh", join(dir, "stub-worker.sh")],
    env: { PATH: "/usr/bin:/bin" },
    cwd: dir,
    files: [],
    stdin: ['"first"\n'],
  },
  dipoCommand: [process.execPath, CLI_MAIN],
  env: process.env,
  probe: systemProcessProbe(currentPlatform()),
});
writeFileSync(join(dir, "host.json"), JSON.stringify({ ...host, daemonPid: process.pid }));
await Bun.sleep(600_000);
