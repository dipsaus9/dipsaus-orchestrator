// CI only (DIPO-118): the run's short temp root under the worker's sandbox policy. The policy is the
// `sandbox` block of a real claude-cli plan, run through `dipo daemon sandbox-exec` (srt, the same
// runtime Claude Code's Bash sandbox uses): its `allowWrite`, `denyWrite`, `denyRead`, `allowRead`
// and network block, with `DIPO_TMP` and `TMPDIR` from the plan's environment. The read block of
// `blockReadsOutsideWorkingDirectories` is left out: `sandbox-exec` refuses a read deny over its
// working directory, and this checkout lies under the home directory on macOS. It is read-only
// here: the plan's worktree is a scratch directory.
//
// Both platforms: the short temp root and the run temp directory are writable, a sibling in `/tmp`
// is not. macOS only: a testkit test that starts a real daemon passes with the plan's `DIPO_TMP`
// (its socket under the short temp root opens through `allowUnixSockets`), and fails without that
// entry. On Linux srt cannot filter Unix sockets by path and blocks them all unless every socket is
// allowed, so a test daemon cannot bind there (0008 amendment proposed with DIPO-118).

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { MAX_TEMP_ROOT_BYTES, tempRoot, withTempDir } from "@dipsaus-orchestrator/testkit";

import { OFFICE_DEFAULTS } from "../../src/config";
import { dipoCommand, sandboxExecArgv } from "../../src/platform/sandbox";
import {
  prepareRunTempDirs,
  removeShortTempDir,
  runTempDir,
  shortTempDir,
} from "../../src/run/temp-dirs";
import { plan, SETTINGS_FILE } from "../../src/workers/claude-cli/plan";
import type { LaunchPlan } from "../../src/workers/types";
import { spec } from "./launch-fixtures";

const CI = process.env["DIPO_TEST_CI"] === "1";
const REPO = resolve(import.meta.dir, "../../../..");
const DAEMON_TEST = "packages/client/test/integration/daemon.test.ts";
const TIMEOUT_MS = 180_000;

// Binds a Unix socket at each path in $SOCKETS (colon-separated) and prints one line per path.
const BIND = `for (const path of (process.env.SOCKETS ?? "").split(":")) {
  try {
    const server = Bun.listen({ unix: path, socket: { data() {} } });
    server.stop(true);
    console.log("bound");
  } catch (error) {
    console.log(\`refused \${error.code ?? error.message}\`);
  }
}`;

interface Sandboxed {
  readonly launch: LaunchPlan;
  readonly policy: string;
  readonly shortTmp: string;
  readonly tmp: string;
}

/** A real plan for a run whose temp directories sit under the real temp root. */
function sandboxed(dir: string, run: string, sockets: boolean): Sandboxed {
  const tmpRoot = realpathSync(tempRoot());
  const tmp = runTempDir(tmpRoot, run);
  const shortTmp = shortTempDir(tmpRoot, run);
  prepareRunTempDirs({ tmpDir: tmp, shortTmpDir: shortTmp }, run, undefined);
  const workdir = join(dir, "wt");
  const main = join(dir, "main");
  mkdirSync(workdir, { recursive: true });
  const launch = plan(spec({ run, workdir, systemFile: join(dir, "run", "system.md") }), {
    claudePath: "/usr/local/bin/claude",
    home: homedir(),
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", TMPDIR: tmp },
    toolVariables: [],
    mainCheckout: main,
    runDir: join(dir, "run"),
    hostSocket: join(dir, "host.sock"),
    tmpDir: tmp,
    shortTmpDir: shortTmp,
    sandbox: OFFICE_DEFAULTS.sandbox,
  });
  const file = launch.files.find((entry) => entry.name === SETTINGS_FILE);
  if (file === undefined) throw new Error("no settings file");
  const { sandbox } = JSON.parse(file.content) as {
    sandbox: {
      filesystem: {
        allowWrite: string[];
        denyWrite: string[];
        denyRead: string[];
        allowRead: string[];
      };
      network: {
        allowedDomains: string[];
        allowLocalBinding: boolean;
        allowUnixSockets?: string[];
      };
    };
  };
  const policy = join(dir, `policy-${sockets ? "sockets" : "closed"}.json`);
  writeFileSync(
    policy,
    JSON.stringify({
      network: {
        allowedDomains: sandbox.network.allowedDomains,
        deniedDomains: [],
        strictAllowlist: true,
        allowLocalBinding: sandbox.network.allowLocalBinding,
        ...(sockets ? { allowUnixSockets: sandbox.network.allowUnixSockets } : {}),
      },
      filesystem: {
        denyRead: sandbox.filesystem.denyRead,
        allowRead: sandbox.filesystem.allowRead,
        allowWrite: sandbox.filesystem.allowWrite,
        denyWrite: sandbox.filesystem.denyWrite,
      },
    }),
  );
  return { launch, policy, shortTmp, tmp };
}

async function inSandbox(
  box: Sandboxed,
  command: readonly string[],
  cwd: string,
  extra: Readonly<Record<string, string>> = {},
): Promise<{ out: string; code: number }> {
  const child = Bun.spawn({
    cmd: sandboxExecArgv(dipoCommand(), box.policy, command, cwd),
    cwd: "/",
    env: {
      PATH: box.launch.env["PATH"] ?? "/usr/bin:/bin",
      HOME: box.launch.env["HOME"] ?? homedir(),
      TMPDIR: box.launch.env["TMPDIR"] ?? box.tmp,
      DIPO_TMP: box.launch.env["DIPO_TMP"] ?? "",
      ...extra,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { out: `${out}${err}`, code };
}

async function withRun<T>(fn: (dir: string, run: string) => Promise<T>): Promise<T> {
  return withTempDir(async (dir) => {
    const run = `run_ci_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const tmpRoot = realpathSync(tempRoot());
    try {
      return await fn(dir, run);
    } finally {
      rmSync(runTempDir(tmpRoot, run), { recursive: true, force: true });
      removeShortTempDir(tmpRoot, run);
    }
  });
}

if (CI) {
  describe("the short temp root under the worker's sandbox policy (DIPO-118)", () => {
    it(
      "is the plan's DIPO_TMP and writable, as is the run temp directory; a sibling in /tmp is not",
      () =>
        withRun(async (dir, run) => {
          const box = sandboxed(dir, run, true);
          expect(box.launch.env["DIPO_TMP"]).toBe(box.shortTmp);
          expect(Buffer.byteLength(box.shortTmp)).toBeLessThanOrEqual(MAX_TEMP_ROOT_BYTES);
          const sibling = `/tmp/dipo-ci-${crypto.randomUUID()}`;
          const targets = [join(box.shortTmp, "probe"), join(box.tmp, "probe"), sibling];
          const script = targets
            .map(
              (path) =>
                `if (echo x > '${path}') 2>/dev/null; then echo written; else echo blocked; fi`,
            )
            .join("; ");
          try {
            const { out, code } = await inSandbox(box, ["/bin/sh", "-c", script], join(dir, "wt"));
            expect(code).toBe(0);
            expect(out.trim().split("\n").slice(-3)).toEqual(["written", "written", "blocked"]);
            expect(existsSync(sibling)).toBe(false);
          } finally {
            rmSync(sibling, { force: true });
          }
        }),
      TIMEOUT_MS,
    );
  });
}

if (CI && process.platform === "darwin") {
  describe("a testkit daemon test under the worker's sandbox policy on macOS (DIPO-118)", () => {
    it(
      "passes with the plan's DIPO_TMP and its Unix socket entry",
      () =>
        withRun(async (dir, run) => {
          const box = sandboxed(dir, run, true);
          const { out, code } = await inSandbox(box, [process.execPath, "test", DAEMON_TEST], REPO);
          expect({ code, out: code === 0 ? "" : out }).toEqual({ code: 0, out: "" });
          expect(out).toContain(" 0 fail");
        }),
      TIMEOUT_MS,
    );

    it(
      "opens Unix sockets only under the short temp root, and none without the entry",
      () =>
        withRun(async (dir, run) => {
          const binds = async (sockets: boolean) => {
            const box = sandboxed(dir, run, sockets);
            const paths = [join(box.shortTmp, "a.sock"), join(box.tmp, "b.sock")];
            const { out, code } = await inSandbox(box, [process.execPath, "-e", BIND], dir, {
              SOCKETS: paths.join(":"),
            });
            expect(code).toBe(0);
            return out.trim().split("\n").slice(-2);
          };
          expect(await binds(true)).toEqual(["bound", "refused EPERM"]);
          expect(await binds(false)).toEqual(["refused EPERM", "refused EPERM"]);
        }),
      TIMEOUT_MS,
    );

    it(
      "fails the daemon test without the Unix socket entry",
      () =>
        withRun(async (dir, run) => {
          const box = sandboxed(dir, run, false);
          const { code } = await inSandbox(box, [process.execPath, "test", DAEMON_TEST], REPO);
          expect(code).not.toBe(0);
        }),
      TIMEOUT_MS,
    );
  });
}
