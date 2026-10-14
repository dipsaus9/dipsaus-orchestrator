// `dipo hook <event>` as a real process (DIPO-59 AC #1): with no worker host to reach it prints
// nothing and exits 0 within 2 s, so a hook never blocks or breaks a worker. CI only.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

const CLI_MAIN = join(import.meta.dir, "..", "..", "cli", "src", "main.ts");
if (process.env["DIPO_TEST_CI"] === "1")
  describe("dipo hook process", () => {
    for (const args of [["Stop"], ["PermissionRequest", "--wait", "300"]]) {
      it(
        `${args.join(" ")} exits 0 with no output within 2 s when no host answers`,
        () =>
          withTempDir(async (dir) => {
            const started = performance.now();
            const proc = Bun.spawn([process.execPath, CLI_MAIN, "hook", ...args], {
              stdin: new TextEncoder().encode('{"hook_event_name":"Stop"}\n'),
              stdout: "pipe",
              stderr: "pipe",
              env: {
                PATH: process.env["PATH"] ?? "/usr/bin:/bin",
                HOME: dir,
                DIPO_HOST_SOCKET: join(dir, "missing.sock"),
                DIPO_RUN: "run_01JZ0000000000000000000009",
              },
            });
            const code = await proc.exited;
            const elapsed = performance.now() - started;
            expect(code).toBe(0);
            expect(await new Response(proc.stdout).text()).toBe("");
            expect(await new Response(proc.stderr).text()).toBe("");
            expect(elapsed).toBeLessThan(2000);
          }),
        10_000,
      );
    }
  });
