// A `DIPO_HOME` or `DIPO_RUNTIME_DIR` the daemon cannot use stops `dipo daemon --foreground` with a
// coded error that names the path and the reason (DIPO-316 AC #1). It never falls through: no other
// state folder is written and no other runtime candidate is created or chosen. The daemon runs in
// this process on the test's temp directory, with a fake source for uncaught errors (DIPO-117).

import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { EXIT_CONFIG } from "@dipsaus-orchestrator/contract";
import { isolatedDaemonEnv, withDaemonTempDir } from "@dipsaus-orchestrator/testkit";

import { runDaemon } from "../../src/index";

function capture(env: Record<string, string>) {
  const err: string[] = [];
  const io = {
    writeLine: () => {},
    writeError: (line: string) => err.push(line),
    env,
    execArgv: [],
    uncaughtErrors: new EventEmitter(),
  };
  return { io, err };
}

describe("dipo daemon --foreground with an unusable override", () => {
  it("refuses a DIPO_HOME that is a file, before writing anything", () =>
    withDaemonTempDir(async (dir) => {
      const env = isolatedDaemonEnv(dir);
      const home = join(dir, "state-file");
      writeFileSync(home, "");
      const { io, err } = capture({ ...env, DIPO_HOME: home });
      expect(await runDaemon(["--foreground"], io)).toBe(EXIT_CONFIG);
      const message = err.join("\n");
      expect(message).toContain("paths.stateDirUnusable");
      expect(message).toContain(home);
      expect(message).toContain("it is not a directory");
      // Nothing else was used instead.
      expect(existsSync(env.DIPO_HOME)).toBe(false);
      expect(existsSync(env.DIPO_RUNTIME_DIR)).toBe(false);
    }));

  it("refuses a relative DIPO_HOME", () =>
    withDaemonTempDir(async (dir) => {
      const { io, err } = capture({ ...isolatedDaemonEnv(dir), DIPO_HOME: "state" });
      expect(await runDaemon(["--foreground"], io)).toBe(EXIT_CONFIG);
      expect(err.join("\n")).toContain("paths.stateDirUnusable: DIPO_HOME state cannot be used");
    }));

  it("refuses a DIPO_RUNTIME_DIR it cannot use and takes no other candidate", () =>
    withDaemonTempDir(async (dir) => {
      const env = isolatedDaemonEnv(dir);
      mkdirSync(env.DIPO_RUNTIME_DIR, { mode: 0o700 });
      chmodSync(env.DIPO_RUNTIME_DIR, 0o755);
      const { io, err } = capture(env);
      expect(await runDaemon(["--foreground"], io)).toBe(1);
      const message = err.join("\n");
      expect(message).toContain("paths.runtimeDirUnusable");
      expect(message).toContain(env.DIPO_RUNTIME_DIR);
      expect(message).toContain("its mode is 0755, not 0700");
      // `$TMPDIR/dipo`, the next candidate, was never made, and no directory was chosen.
      expect(existsSync(join(env.TMPDIR, "dipo"))).toBe(false);
      expect(existsSync(join(env.DIPO_RUNTIME_DIR, "dipo.sock"))).toBe(false);
      const log = readFileSync(join(env.DIPO_HOME, "logs", "daemon.log"), "utf8");
      expect(log).not.toContain("runtime directory chosen");
    }));
});
