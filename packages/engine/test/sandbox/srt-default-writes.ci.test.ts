// CI only (DIPO-98): srt 0.0.79 makes `<home>/.npm/_logs` and `<home>/.claude/debug` writable by
// default, and the `denyWrite` entries the worker run settings carry close them again. The policy
// below has the shape Claude Code gives the worker sandbox: the home directory read-denied (the
// read block), the toolchain path `<home>/.npm` re-opened for reading, writes to the worktree and a
// temp directory. Without the denies the convenience paths are writable (so the probe is real);
// with them every write fails. The home is a temp directory, so nothing real is touched; the shared
// `/tmp/claude` is probed on macOS only, because a deny on a missing path makes bubblewrap create a
// mount point there on Linux.

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { dipoCommand, sandboxExecArgv } from "../../src/platform/sandbox";
import { closedWritePaths } from "../../src/workers/claude-cli/plan";
import { CI } from "./helpers";

const TIMEOUT_MS = 60_000;
const PROBES = [".npm/_logs", ".claude/debug"] as const;

async function tryWrites(dir: string, closed: boolean): Promise<string[]> {
  const home = join(dir, "home");
  const worktree = join(dir, "wt");
  const tmp = join(dir, "tmp");
  for (const path of [...PROBES.map((rel) => join(home, rel)), worktree, tmp]) {
    mkdirSync(path, { recursive: true });
  }
  const denyWrite = closed
    ? closedWritePaths(home)
        .map((entry) => entry.path)
        .filter((path) => path.startsWith(`${home}/`))
    : [];
  expect(denyWrite.length).toBe(closed ? PROBES.length : 0);
  const policy = join(dir, closed ? "closed.json" : "open.json");
  writeFileSync(
    policy,
    JSON.stringify({
      network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
      filesystem: {
        denyRead: [home],
        allowRead: [join(home, ".npm")],
        allowWrite: [worktree, tmp],
        denyWrite,
      },
    }),
  );
  const targets = [...PROBES.map((rel) => join(home, rel, "probe")), join(worktree, "control")];
  const script = targets
    .map((path) => `if (echo x > '${path}') 2>/dev/null; then echo written; else echo blocked; fi`)
    .join("; ");
  const child = Bun.spawn({
    cmd: sandboxExecArgv(dipoCommand(), policy, ["/bin/sh", "-c", script], worktree),
    cwd: "/",
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: home, TMPDIR: tmp },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`sandbox-exec exited ${code}: ${err}`);
  for (const [index, rel] of PROBES.entries()) {
    const line = out.trim().split("\n")[index];
    expect(existsSync(join(home, rel, "probe"))).toBe(line === "written");
  }
  return out.trim().split("\n");
}

/**
 * macOS only: a write under the shared `/tmp/claude` (made when missing, which the deny must also
 * refuse) under the worker's denies. Returns the command's output and whether anything appeared.
 */
async function tryTmpClaude(dir: string): Promise<{ out: string; appeared: boolean }> {
  const target = `/tmp/claude/dipo-ci-${crypto.randomUUID()}`;
  const existed = existsSync("/tmp/claude");
  const worktree = join(dir, "wt");
  mkdirSync(worktree, { recursive: true });
  const policy = join(dir, "tmp-claude.json");
  writeFileSync(
    policy,
    JSON.stringify({
      network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
      filesystem: {
        denyRead: [],
        allowWrite: [worktree],
        denyWrite: closedWritePaths(join(dir, "home")).map((entry) => entry.path),
      },
    }),
  );
  const script = `mkdir -p '${target}' 2>&1 && echo x > '${target}/probe' 2>&1; echo "exit $?"`;
  const child = Bun.spawn({
    cmd: sandboxExecArgv(dipoCommand(), policy, ["/bin/sh", "-c", script], worktree),
    cwd: "/",
    // TMPDIR inside the test directory, so nothing the wrapper runs writes under /tmp/claude.
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: join(dir, "home"),
      TMPDIR: worktree,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(code).toBe(0);
  const appeared = existsSync(target) || (!existed && existsSync("/tmp/claude"));
  // Undo anything that got through, so a failing run leaves nothing behind.
  rmSync(target, { recursive: true, force: true });
  if (!existed) rmSync("/tmp/claude", { recursive: true, force: true });
  return { out, appeared };
}

if (CI && process.platform === "darwin") {
  describe("srt default write paths on macOS (DIPO-98)", () => {
    it(
      "refuses a write under /tmp/claude with the worker plan's denyWrite entries",
      () =>
        withTempDir(async (dir) => {
          const { out, appeared } = await tryTmpClaude(dir);
          expect(out).toContain("Operation not permitted");
          expect(out.trim()).not.toEndWith("exit 0");
          expect(appeared).toBe(false);
        }),
      TIMEOUT_MS,
    );
  });
}

if (CI) {
  describe("srt default write paths (DIPO-98)", () => {
    it(
      "leaves ~/.npm/_logs writable under the read block when ~/.npm is re-opened, without the deny",
      () =>
        withTempDir(async (dir) => {
          // ~/.claude/debug stays closed by the read block itself; ~/.npm/_logs does not.
          expect(await tryWrites(dir, false)).toEqual(["written", "blocked", "written"]);
        }),
      TIMEOUT_MS,
    );

    it(
      "denies writes to both with the worker plan's denyWrite entries; the worktree stays writable",
      () =>
        withTempDir(async (dir) => {
          expect(await tryWrites(dir, true)).toEqual(["blocked", "blocked", "written"]);
        }),
      TIMEOUT_MS,
    );
  });
}
