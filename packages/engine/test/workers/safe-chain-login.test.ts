// macOS only (DIPO-107): the Safe-Chain worker shell started for real as a login shell. On macOS
// `/etc/zprofile` and `/etc/profile` run `path_helper`, which moves `/usr/local/bin` back in front
// of PATH; the plan's login hook must put the planned PATH back, so a demoted entry stays last.
// Plain *.test.ts, not CI-only, so the local verify on macOS runs it.

import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import {
  SAFE_CHAIN_PROBE,
  SAFE_CHAIN_SHELL_DIR,
  safeChainShellFiles,
  safeChainShellPath,
  type SafeChainLaunch,
} from "../../src/workers/claude-cli/safe-chain";

/** The system directories `path_helper` puts in front; `/usr/local/bin` is demoted below. */
const SYSTEM = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const DEMOTED = "/usr/local/bin";

/** Writes the plan's shell files under `<dir>/run` with the planned PATH; returns the wrapper. */
function setUp(dir: string, shell: string) {
  const runDir = join(dir, "run");
  const shellDir = join(runDir, SAFE_CHAIN_SHELL_DIR);
  const home = join(dir, "home");
  const kept = join(dir, "tools");
  mkdirSync(home, { recursive: true });
  mkdirSync(kept, { recursive: true });
  const launch: SafeChainLaunch = {
    root: join(home, ".safe-chain"),
    shell,
    path: [kept, ...SYSTEM, DEMOTED].join(":"),
    demoted: [{ entry: DEMOTED, reason: "its bun resolves where the sandbox cannot read" }],
    dropped: [],
    probe: SAFE_CHAIN_PROBE,
  };
  const files = safeChainShellFiles(launch, shellDir, {
    tmpDir: join(dir, "tmp"),
    route: { port: 0, dir: join(dir, "proxy") },
  });
  for (const file of files) {
    const path = join(runDir, file.name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content);
    if (file.executable === true) chmodSync(path, 0o755);
  }
  return { home, wrapper: safeChainShellPath(shellDir, launch), planned: launch.path };
}

/** Runs the wrapper with the given arguments and returns the PATH it printed. */
function pathFrom(wrapper: string, home: string, args: string[]): string {
  const result = Bun.spawnSync([wrapper, ...args], {
    env: { HOME: home, PATH: "/usr/bin:/bin", TERM: "dumb" },
    cwd: home,
    stdin: "ignore",
  });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trimEnd();
}

describe.skipIf(process.platform !== "darwin")(
  "Safe-Chain login shells keep the planned PATH (DIPO-107)",
  () => {
    for (const shell of ["/bin/zsh", "/bin/bash"]) {
      const name = shell.slice("/bin/".length);

      it(`a ${name} login shell keeps the planned PATH after path_helper, demoted entry last`, async () => {
        await withTempDir((dir) => {
          const { home, wrapper, planned } = setUp(dir, shell);
          const login = pathFrom(wrapper, home, ["-c", "-l", 'printf "%s\\n" "$PATH"']);
          expect(login).toBe(planned);
          expect(login.split(":").at(-1)).toBe(DEMOTED);
        });
      });

      it(`a ${name} non-login shell keeps the planned PATH too`, async () => {
        await withTempDir((dir) => {
          const { home, wrapper, planned } = setUp(dir, shell);
          expect(pathFrom(wrapper, home, ["-c", 'printf "%s\\n" "$PATH"'])).toBe(planned);
        });
      });
    }
  },
);
