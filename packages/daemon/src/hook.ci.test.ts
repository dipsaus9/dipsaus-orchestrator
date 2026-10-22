// `dipo hook <event>` as a real process (DIPO-59 AC #1): with no worker host to reach it prints
// nothing and exits 0 within 2 s, so a hook never blocks or breaks a worker. CI only.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { listenLineSocket, systemClock } from "@dipsaus-orchestrator/engine";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { HOOK_DEADLINE_MS, runHookForm } from "./hook";
import { defaultIo } from "./io";

const RUN = "run_01JZ0000000000000000000009";
const CLI_MAIN = join(import.meta.dir, "..", "..", "cli", "src", "main.ts");
if (process.env["DIPO_TEST_CI"] === "1")
  describe("dipo hook process", () => {
    for (const args of [["Stop"], ["PostToolUse", "--nudge"]]) {
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

// One deadline end to end (DIPO-59 review): a host that answers the handshake but never the call.
if (process.env["DIPO_TEST_CI"] === "1") {
  describe("dipo hook deadline", () => {
    it("ends a call that does not wait within the deadline when the host never answers it", () =>
      withTempDir(async (dir) => {
        const socket = join(dir, "s.sock");
        const server = listenLineSocket(socket, (connection) => ({
          line: (text) => {
            if ((JSON.parse(text) as { kind?: string }).kind === "hello") {
              connection.send(JSON.stringify({ kind: "hello", version: 2, run: RUN, pid: 1 }));
            }
          },
          closed: () => undefined,
        }));
        try {
          const out: string[] = [];
          const started = performance.now();
          const code = await runHookForm(["Stop"], {
            ...defaultIo,
            env: { DIPO_HOST_SOCKET: socket, DIPO_RUN: RUN },
            clock: systemClock,
            write: (text) => out.push(text),
            readInput: async () => '{"hook_event_name":"Stop"}',
          });
          expect(code).toBe(0);
          expect(out).toEqual([]);
          expect(performance.now() - started).toBeLessThan(HOOK_DEADLINE_MS + 150);
        } finally {
          await server.stop();
        }
      }));
  });
}

// The Bash check as a real process (DIPO-194 AC #7): decided in its own process, no worker host.
if (process.env["DIPO_TEST_CI"] === "1") {
  describe("dipo hook PreToolUse --bash process", () => {
    for (const [command, denied] of [
      ["export DIPO_TMP=$TMPDIR && bun run verify", true],
      ["bun run verify", false],
    ] as const) {
      it(
        `${denied ? "denies" : "passes"} ${command} with exit 0 within 2 s and no host`,
        () =>
          withTempDir(async (dir) => {
            const started = performance.now();
            const payload = JSON.stringify({
              hook_event_name: "PreToolUse",
              tool_name: "Bash",
              tool_input: { command },
            });
            const proc = Bun.spawn([process.execPath, CLI_MAIN, "hook", "PreToolUse", "--bash"], {
              stdin: new TextEncoder().encode(`${payload}\n`),
              stdout: "pipe",
              stderr: "pipe",
              env: {
                PATH: process.env["PATH"] ?? "/usr/bin:/bin",
                HOME: dir,
                DIPO_HOST_SOCKET: join(dir, "missing.sock"),
                DIPO_RUN: RUN,
              },
            });
            const code = await proc.exited;
            const stdout = await new Response(proc.stdout).text();
            expect(code).toBe(0);
            if (denied) {
              const output = JSON.parse(stdout) as {
                hookSpecificOutput: {
                  permissionDecision: string;
                  permissionDecisionReason: string;
                };
              };
              expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
              expect(output.hookSpecificOutput.permissionDecisionReason).toContain("DIPO_TMP");
            } else {
              expect(stdout).toBe("");
            }
            expect(performance.now() - started).toBeLessThan(2000);
          }),
        10_000,
      );
    }
  });
}
