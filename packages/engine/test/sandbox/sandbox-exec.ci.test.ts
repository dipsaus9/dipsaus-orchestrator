// CI only (0017 section 1; DIPO-37, DIPO-240): `dipo daemon sandbox-exec` run from source on the
// Safe-Chain proxy's own policy (`safeChainProxyPolicy`), the one policy it runs now that the
// engine's install and verify steps went with the Mac worker path. It passes stdin, output, the
// exit code and SIGTERM through, refuses an invalid policy with 125, and refuses a PATH directory
// the policy makes writable through the refusal file, never running a program planted there.
// CI only: each case starts srt (Seatbelt on macOS, bubblewrap on Linux) for real.

import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { currentPlatform } from "../../src/platform/paths";
import { dipoCommand, sandboxExecArgv } from "../../src/platform/sandbox";
import { safeChainProxyLayout, safeChainProxyPolicy } from "../../src/sandbox/safe-chain-proxy";
import { refusalPathFor, SANDBOX_REFUSED_EXIT_CODE } from "../../src/sandbox/step";

const CI = process.env["DIPO_TEST_CI"] === "1";
const TIMEOUT_MS = 60_000;
const PLANTED = process.platform === "linux" ? ["rg", "bwrap", "socat"] : ["rg"];

/** A proxy directory under `dir` with its folders, and its policy file written beside it. */
function proxyAt(dir: string) {
  const layout = safeChainProxyLayout(join(dir, "AbC123"));
  for (const path of [
    layout.install,
    layout.holders,
    layout.tmp,
    layout.home,
    layout.reports,
    layout.sockets,
  ]) {
    mkdirSync(path, { recursive: true });
  }
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const policy = safeChainProxyPolicy({
    platform: currentPlatform(),
    home,
    uid: process.getuid?.() ?? 0,
    layout,
    dipoReads: dipoCommand(),
    dipoDirs: [join(dir, "dipo-state"), join(dir, "dipo-run")],
  });
  writeFileSync(layout.policy, JSON.stringify(policy));
  return { layout, home };
}

function start<In extends "pipe" | "ignore">(dir: string, command: string[], stdin: In) {
  const { layout, home } = proxyAt(dir);
  return Bun.spawn({
    cmd: sandboxExecArgv(dipoCommand(), layout.policy, command),
    cwd: dir,
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: home, TMPDIR: layout.tmp },
    stdin,
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** Writes an executable shell script that records that it ran in `<dir>/<name>-ran`. */
function plantFake(binDir: string, name: string, dir: string): string {
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, name);
  writeFileSync(path, `#!/bin/sh\necho ran > '${join(dir, `${name}-ran`)}'\n`);
  chmodSync(path, 0o755);
  return join(dir, `${name}-ran`);
}

if (CI) {
  describe("dipo daemon sandbox-exec on the Safe-Chain proxy's policy", () => {
    it(
      "passes stdin and output through and exits with the command's code",
      () =>
        withTempDir(async (dir) => {
          const cat = start(dir, ["/bin/sh", "-c", "cat; echo err >&2; exit 7"], "pipe");
          cat.stdin.write("hello sandbox\n");
          await cat.stdin.end();
          const [out, err, code] = await Promise.all([
            new Response(cat.stdout).text(),
            new Response(cat.stderr).text(),
            cat.exited,
          ]);
          expect(out).toBe("hello sandbox\n");
          expect(err).toBe("err\n");
          expect(code).toBe(7);
        }),
      TIMEOUT_MS,
    );

    it(
      "forwards SIGTERM to the command",
      () =>
        withTempDir(async (dir) => {
          const child = start(dir, ["/bin/sh", "-c", "echo ready; exec sleep 30"], "ignore");
          const reader = child.stdout.getReader();
          const first = await reader.read();
          expect(new TextDecoder().decode(first.value)).toBe("ready\n");
          const started = performance.now();
          child.kill("SIGTERM");
          const code = await child.exited;
          expect(performance.now() - started).toBeLessThan(10_000);
          expect(code).toBe(143);
        }),
      TIMEOUT_MS,
    );

    it(
      "refuses with 125 when the policy is not a valid srt settings file",
      () =>
        withTempDir(async (dir) => {
          const policy = join(dir, "bad.json");
          writeFileSync(policy, JSON.stringify({ network: {} }));
          const child = Bun.spawn({
            cmd: sandboxExecArgv(dipoCommand(), policy, ["/usr/bin/true"]),
            cwd: dir,
            env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: dir },
            stdout: "pipe",
            stderr: "pipe",
          });
          const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
          expect(code).toBe(SANDBOX_REFUSED_EXIT_CODE);
          expect(err).toContain("dipo sandbox-exec: refused: policy");
        }),
      TIMEOUT_MS,
    );

    it(
      "refuses a PATH directory the proxy may write, through the refusal file, and runs nothing planted there",
      () =>
        withTempDir(async (dir) => {
          const { layout, home } = proxyAt(dir);
          // The proxy's TMPDIR is writable inside its sandbox: a program there is untrusted.
          const bin = join(layout.tmp, "bin");
          const markers = PLANTED.map((name) => plantFake(bin, name, dir));
          const child = Bun.spawn({
            cmd: sandboxExecArgv(dipoCommand(), layout.policy, ["/usr/bin/true"], dir),
            cwd: "/",
            env: {
              PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
              HOME: home,
              TMPDIR: layout.tmp,
            },
            stdout: "pipe",
            stderr: "pipe",
          });
          const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
          expect(code).toBe(SANDBOX_REFUSED_EXIT_CODE);
          expect(err).toContain("untrusted paths");
          expect(await Bun.file(refusalPathFor(layout.policy)).text()).toContain(bin);
          for (const marker of markers) expect(existsSync(marker)).toBe(false);
        }),
      TIMEOUT_MS,
    );
  });
}
