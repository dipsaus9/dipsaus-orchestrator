// CI only (0017 section 1; DIPO-37): real sandboxed steps through `dipo daemon sandbox-exec`, run
// from source. On Linux CI this exercises bubblewrap, on the maintainer's Mac Seatbelt. A step may
// not write `<main>/.git` or the `<worktree>/.git` pointer, read a (fake) `~/.ssh` file or open a
// network connection, but it can write its worktree and create a Unix socket under its temp root.
// `sandbox-exec` passes stdin, output, the exit code and signals through and stays alive while the
// command runs.

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { dipoCommand, sandboxExecArgv } from "../../src/platform/sandbox";
import { DENY_ALL_SETTINGS } from "../../src/sandbox/policy";
import { runSandboxedStep, type StepResult } from "../../src/sandbox/step";
import { CI, makeLayout, request, stepDeps } from "./helpers";

const TIMEOUT_MS = 60_000;

function exited(result: StepResult) {
  if (result.outcome !== "exited") throw new Error(`step did not run: ${result.reason}`);
  return result;
}

function start<In extends "pipe" | "ignore">(dir: string, command: string[], stdin: In) {
  const policy = join(dir, "deny-all.json");
  writeFileSync(policy, JSON.stringify(DENY_ALL_SETTINGS));
  return Bun.spawn({
    cmd: sandboxExecArgv(dipoCommand(), policy, command),
    cwd: dir,
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: dir, TMPDIR: dir },
    stdin,
    stdout: "pipe",
    stderr: "pipe",
  });
}

if (CI) {
  describe("sandboxed steps", () => {
    it(
      "runs with its own temp root as TMPDIR and DIPO_TMP, removed after the step",
      () =>
        withTempDir(async (dir) => {
          const layout = makeLayout(dir);
          const result = exited(
            await runSandboxedStep(
              stepDeps(),
              request(layout, [
                "/bin/sh",
                "-c",
                'echo "$TMPDIR"; echo "$DIPO_TMP"; echo x > "$TMPDIR/f" && echo written; echo "${GH_TOKEN:-no token}"',
              ]),
            ),
          );
          const [tmpdir, dipoTmp, written, token] = result.stdout.text.trim().split("\n");
          expect(tmpdir).toBe(dipoTmp);
          expect(tmpdir).toContain("/dipo-s-");
          expect(written).toBe("written");
          expect(token).toBe("no token");
          expect(existsSync(tmpdir ?? "")).toBe(false);
        }),
      TIMEOUT_MS,
    );

    it(
      "can write the worktree but not <main>/.git or the <worktree>/.git pointer",
      () =>
        withTempDir(async (dir) => {
          const layout = makeLayout(dir);
          const pointer = readFileSync(join(layout.worktree, ".git"), "utf8");
          const result = exited(
            await runSandboxedStep(
              stepDeps(),
              request(layout, [
                "/bin/sh",
                "-c",
                'echo ok > built.txt; echo x > "$1/.git/x"; echo "$?"; echo y > .git; echo "$?"',
                "sh",
                layout.main,
              ]),
            ),
          );
          expect(readFileSync(join(layout.worktree, "built.txt"), "utf8")).toBe("ok\n");
          expect(existsSync(join(layout.main, ".git", "x"))).toBe(false);
          expect(readFileSync(join(layout.worktree, ".git"), "utf8")).toBe(pointer);
          // Both redirections failed (the status is 1 in bash and zsh, 2 in dash).
          const statuses = result.stdout.text.trim().split("\n");
          expect(statuses).toHaveLength(2);
          for (const status of statuses) expect(status).not.toBe("0");
        }),
      TIMEOUT_MS,
    );

    it(
      "cannot read a secret under ~/.ssh or ~/.npmrc",
      () =>
        withTempDir(async (dir) => {
          const layout = makeLayout(dir);
          const result = exited(
            await runSandboxedStep(
              stepDeps(),
              request(layout, ["/bin/cat", layout.secret, layout.npmrc]),
            ),
          );
          expect(result.code).not.toBe(0);
          expect(result.stdout.text).not.toContain("not-a-real-key");
          expect(result.stdout.text).not.toContain("not-a-real-token");
        }),
      TIMEOUT_MS,
    );

    it(
      "cannot open a network connection under the verify policy",
      () =>
        withTempDir(async (dir) => {
          const layout = makeLayout(dir);
          const script = [
            "let reached = [];",
            "try { const r = await fetch('https://example.com', { signal: AbortSignal.timeout(10000) });",
            "  if (r.ok) reached.push('fetch ' + r.status); } catch {}",
            "try { const s = await Bun.connect({ hostname: '1.1.1.1', port: 443, socket: { data() {} } });",
            "  reached.push('tcp'); s.end(); } catch {}",
            "console.log(reached.length === 0 ? 'blocked' : 'reached ' + reached.join(','));",
          ].join("\n");
          const result = exited(
            await runSandboxedStep(stepDeps(), request(layout, [process.execPath, "-e", script])),
          );
          expect(result.stdout.text.trim()).toBe("blocked");
        }),
      TIMEOUT_MS,
    );

    it(
      "can create and use a Unix socket under the step temp root",
      () =>
        withTempDir(async (dir) => {
          const layout = makeLayout(dir);
          const script = [
            "const path = process.env.DIPO_TMP + '/t.sock';",
            "const server = Bun.serve({ unix: path, fetch: () => new Response('pong') });",
            "const reply = await fetch('http://dipo/', { unix: path });",
            "console.log(await reply.text());",
            "server.stop(true);",
          ].join("\n");
          const result = exited(
            await runSandboxedStep(stepDeps(), request(layout, [process.execPath, "-e", script])),
          );
          expect(result.stderr.text).toBe("");
          expect(result.stdout.text.trim()).toBe("pong");
          expect(result.code).toBe(0);
        }),
      TIMEOUT_MS,
    );
  });

  describe("dipo daemon sandbox-exec", () => {
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
      "stays alive until the command exits",
      () =>
        withTempDir(async (dir) => {
          const child = start(dir, ["/bin/sh", "-c", "sleep 1; echo done"], "ignore");
          const started = performance.now();
          const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
          expect(performance.now() - started).toBeGreaterThanOrEqual(1000);
          expect(out).toBe("done\n");
          expect(code).toBe(0);
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
          expect(code).toBe(125);
          expect(err).toContain("dipo sandbox-exec: refused: policy");
        }),
      TIMEOUT_MS,
    );
  });
}
