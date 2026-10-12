// CI only (0017 section 1; DIPO-37 review): the sandbox cannot be escaped through the host side.
// A planted `rg` (and on Linux `bwrap` and `socat`) in a writable PATH directory refuses the step
// and never runs; a faked refusal line is an ordinary failure; a `bunfig.toml` in the worktree is
// not loaded by `sandbox-exec`; dipo's own sockets and the ssh-agent socket are out of reach; and
// srt's bridge sockets stay out of the step's temp root.

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { dipoCommand, sandboxExecArgv } from "../../src/platform/sandbox";
import { runSandboxedStep, type StepResult } from "../../src/sandbox/step";
import { CI, makeLayout, plantFake, request, stepDeps } from "./helpers";

const TIMEOUT_MS = 60_000;
const PLANTED = process.platform === "linux" ? ["rg", "bwrap", "socat"] : ["rg"];

function exited(result: StepResult) {
  if (result.outcome !== "exited") throw new Error(`step did not run: ${result.reason}`);
  return result;
}

/** A Unix socket server outside the sandbox; the caller stops it. */
function serve(path: string) {
  return Bun.serve({ unix: path, fetch: () => new Response("reached") });
}

const TRY_CONNECT = [
  "const paths = JSON.parse(process.argv[1]);",
  "for (const path of paths) {",
  "  try { const r = await fetch('http://dipo/', { unix: path }); console.log('reached ' + path + ' ' + (await r.text())); }",
  "  catch { console.log('blocked'); }",
  "}",
].join("\n");

if (CI) {
  describe("sandbox hardening", () => {
    it(
      "refuses a step whose rg, bwrap or socat would come from a writable PATH directory, and never runs it",
      () =>
        withTempDir(async (dir) => {
          const layout = makeLayout(dir);
          const bin = join(layout.worktree, "bin");
          const markers = PLANTED.map((name) => plantFake(bin, name, dir));
          const result = await runSandboxedStep(
            stepDeps(),
            request(layout, ["/usr/bin/true"], "verify", {
              PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
            }),
          );
          expect(result.outcome).toBe("startFailed");
          if (result.outcome === "startFailed") {
            expect(result.reason).toContain("sandbox refused untrusted paths");
            expect(result.reason).toContain(`${bin}/rg`);
          }
          for (const marker of markers) expect(existsSync(marker)).toBe(false);
        }),
      TIMEOUT_MS,
    );

    it(
      "makes sandbox-exec itself refuse a writable PATH directory, through the refusal file",
      () =>
        withTempDir(async (dir) => {
          const writable = join(dir, "w");
          const bin = join(writable, "bin");
          const markers = PLANTED.map((name) => plantFake(bin, name, dir));
          const policy = join(dir, "p.json");
          writeFileSync(
            policy,
            JSON.stringify({
              network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
              filesystem: { denyRead: [], allowWrite: [writable], denyWrite: [] },
            }),
          );
          const child = Bun.spawn({
            cmd: sandboxExecArgv(dipoCommand(), policy, ["/usr/bin/true"], dir),
            cwd: "/",
            env: { PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`, HOME: dir },
            stdout: "pipe",
            stderr: "pipe",
          });
          const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
          expect(code).toBe(125);
          expect(err).toContain("untrusted paths");
          expect(await Bun.file(`${policy}.refused`).text()).toContain(`${bin}`);
          for (const marker of markers) expect(existsSync(marker)).toBe(false);
        }),
      TIMEOUT_MS,
    );

    it(
      "treats a command that prints the refusal line and exits 125 as an ordinary failure",
      () =>
        withTempDir(async (dir) => {
          const layout = makeLayout(dir);
          const result = exited(
            await runSandboxedStep(
              stepDeps(),
              request(layout, [
                "/bin/sh",
                "-c",
                "echo 'dipo sandbox-exec: refused: faked' >&2; exit 125",
              ]),
            ),
          );
          expect(result.code).toBe(125);
          expect(result.stderr.text).toContain("refused: faked");
        }),
      TIMEOUT_MS,
    );

    it(
      "starts sandbox-exec outside the worktree, so a planted bunfig.toml is never loaded",
      () =>
        withTempDir(async (dir) => {
          const layout = makeLayout(dir);
          const marker = join(dir, "preloaded");
          writeFileSync(join(layout.worktree, "bunfig.toml"), 'preload = ["./planted.ts"]\n');
          writeFileSync(
            join(layout.worktree, "planted.ts"),
            `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "1");\n`,
          );
          writeFileSync(join(layout.worktree, ".env"), "BUN_OPTIONS=--preload ./planted.ts\n");
          const result = exited(await runSandboxedStep(stepDeps(), request(layout, ["/bin/pwd"])));
          expect(result.code).toBe(0);
          expect(realpathSync(result.stdout.text.trim())).toBe(realpathSync(layout.worktree));
          expect(existsSync(marker)).toBe(false);
        }),
      TIMEOUT_MS,
    );

    it(
      "cannot reach dipo's own sockets or the ssh-agent socket",
      () =>
        withTempDir(async (dir) => {
          const layout = makeLayout(dir);
          const agentDir = join(dir, "agent");
          mkdirSync(agentDir);
          // The runtime directory comes from DIPO_RUNTIME_DIR through the DIPO-23 path rules.
          const dipoSocket = join(layout.dipoRuntime, "dipo.sock");
          const agentSocket = join(agentDir, "agent.sock");
          const servers = [serve(dipoSocket), serve(agentSocket)];
          try {
            const result = exited(
              await runSandboxedStep(
                stepDeps(),
                request(
                  layout,
                  [process.execPath, "-e", TRY_CONNECT, JSON.stringify([dipoSocket, agentSocket])],
                  "verify",
                  { SSH_AUTH_SOCK: agentSocket },
                ),
              ),
            );
            expect(result.stdout.text.trim().split("\n")).toEqual(["blocked", "blocked"]);
          } finally {
            for (const server of servers) await server.stop(true);
          }
        }),
      TIMEOUT_MS,
    );

    it(
      "refuses, through the refusal file, when a dipo directory would hide the worktree",
      () =>
        withTempDir(async (dir) => {
          const layout = makeLayout(dir);
          const result = await runSandboxedStep(
            stepDeps(),
            request(layout, ["/usr/bin/true"], "verify", { DIPO_RUNTIME_DIR: layout.dir }),
          );
          expect(result.outcome).toBe("startFailed");
          if (result.outcome === "startFailed") {
            expect(result.reason).toContain("sandbox refused to start: read denies hide the step");
            expect(result.reason).toContain(`denyRead ${layout.dir} covers the working directory`);
          }
        }),
      TIMEOUT_MS,
    );

    it(
      "refuses a step that could write the source code a from-source dipo runs",
      () =>
        withTempDir(async (dir) => {
          const layout = makeLayout(dir);
          const repo = resolve(import.meta.dir, "../../../..");
          const result = await runSandboxedStep(stepDeps(), {
            ...request(layout, ["/usr/bin/true"]),
            worktree: repo,
            mainCheckout: repo,
          });
          expect(result.outcome).toBe("startFailed");
          if (result.outcome === "startFailed") {
            expect(result.reason).toContain(`the dipo source ${repo} is writable by the step`);
          }
        }),
      TIMEOUT_MS,
    );

    it(
      "keeps srt's own sockets and files out of the step temp root",
      () =>
        withTempDir(async (dir) => {
          const layout = makeLayout(dir);
          const result = exited(
            await runSandboxedStep(
              stepDeps(),
              request(layout, ["/bin/sh", "-c", 'ls -A "$TMPDIR"; echo end']),
            ),
          );
          expect(result.stdout.text).toBe("end\n");
        }),
      TIMEOUT_MS,
    );
  });
}
