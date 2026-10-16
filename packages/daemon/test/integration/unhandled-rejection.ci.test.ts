// CI only (0017 section 1): a real daemon process, started as the `dipo` binary starts it (a
// top-level await that sets the exit code), meets an unhandled rejection (DIPO-110). The daemon
// logs the error once with its code, and the listener does not swallow it: Bun still reports it as
// uncaught and keeps running, the crash counter does not count it, and the process exits 1 at its
// next stop where a clean stop exits 0. That is the path Bun 1.4.2 takes without the listener too;
// how the daemon should react to one is decided in a follow-up story. State, runtime and temp
// files stay under the test's temp directory, and the process is stopped in a `finally`.

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { cleanEnv, withTempDir } from "@dipsaus-orchestrator/testkit";

const FIXTURE = resolve(import.meta.dir, "fixtures/rejecting-daemon.ts");
const TIMEOUT_MS = 30_000;
const FAILURE = "an unhandled rejection reached the daemon";

type Line = { msg: string; level: string; errorCode?: string; error?: { message?: string } };

function readLog(dir: string): Line[] {
  const path = join(dir, "state", "logs", "daemon.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Line);
}

async function waitForFailure(dir: string, daemon: Bun.Subprocess): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    if (daemon.exitCode !== null) throw new Error(`daemon exited with ${daemon.exitCode}`);
    if (readLog(dir).some((line) => line.msg === FAILURE)) return;
    await Bun.sleep(50);
  }
  throw new Error("the daemon logged no unhandled rejection within 10 s");
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("an unhandled rejection in a real daemon process", () => {
    it(
      "is logged once with its code and still reported as uncaught; the process exits 1",
      () =>
        withTempDir(async (dir) => {
          const env = cleanEnv();
          delete env["BUN_OPTIONS"];
          delete env["DIPO_LOG"];
          const daemon = Bun.spawn({
            cmd: [process.execPath, FIXTURE],
            env: {
              ...env,
              DIPO_HOME: join(dir, "state"),
              DIPO_RUNTIME_DIR: join(dir, "run"),
              DIPO_TMP: dir,
            },
            stdin: "ignore",
            stdout: "ignore",
            stderr: "pipe",
          });
          try {
            await waitForFailure(dir, daemon);
            daemon.kill("SIGTERM");
            expect(await daemon.exited).toBe(1);
            const log = readLog(dir);
            expect(log.map((line) => line.msg)).toContain("unguarded job started");
            const failures = log.filter((line) => line.msg === FAILURE);
            expect(failures).toHaveLength(1);
            expect(failures[0]).toMatchObject({
              level: "error",
              errorCode: "SQLITE_IOERR",
              error: { message: "disk I/O error" },
            });
            // Not swallowed: Bun's own uncaught report follows the log line.
            const stderr = await new Response(daemon.stderr).text();
            expect(stderr).toMatch(/^error: disk I\/O error$/m);
          } finally {
            if (daemon.exitCode === null && daemon.signalCode === null) {
              daemon.kill("SIGKILL");
              await daemon.exited;
            }
          }
        }),
      TIMEOUT_MS,
    );
  });
}
