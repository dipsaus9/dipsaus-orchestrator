// CI only (DIPO-178): the Safe-Chain worker shell started for real as a bash login shell. A
// stand-in home holds the three profile files a login shell reads (~/.bash_profile, ~/.bash_login,
// ~/.profile), each writing a marker; none may run, and the planned PATH must come back intact.

import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import {
  SAFE_CHAIN_PROBE,
  SAFE_CHAIN_SHELL_DIR,
  safeChainShellFiles,
  safeChainShellPath,
  type SafeChainLaunch,
} from "../../src/workers/claude-cli/safe-chain";

const CI = process.env["DIPO_TEST_CI"] === "1";
const BASH = ["/bin/bash", "/usr/bin/bash"].find((path) => existsSync(path));

const PROFILES = [".bash_profile", ".bash_login", ".profile"];

/** Writes the plan's shell files under `<dir>/run` and a stand-in home holding the profiles. */
function setUp(dir: string, bash: string) {
  const runDir = join(dir, "run");
  const shellDir = join(runDir, SAFE_CHAIN_SHELL_DIR);
  const home = join(dir, "home");
  const kept = join(dir, "tools");
  mkdirSync(home, { recursive: true });
  mkdirSync(kept, { recursive: true });
  for (const name of PROFILES) {
    writeFileSync(join(home, name), `: > "$HOME/marker-${name}"\n`);
  }
  const launch: SafeChainLaunch = {
    root: join(home, ".safe-chain"),
    shell: bash,
    path: [kept, "/usr/bin", "/bin"].join(":"),
    demoted: [],
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

/** Runs the wrapper as Claude Code does, with only the stand-in home and the daemon's PATH. */
function start(wrapper: string, home: string, args: string[]) {
  const result = Bun.spawnSync([wrapper, ...args], {
    env: { HOME: home, PATH: process.env["PATH"] ?? "/usr/bin:/bin", TERM: "dumb" },
    cwd: home,
    stdin: "ignore",
  });
  return { code: result.exitCode, stdout: result.stdout.toString() };
}

if (CI && BASH !== undefined) {
  const bash = BASH;
  describe("Safe-Chain bash login shell (DIPO-178)", () => {
    it("a login shell reads none of the maintainer's profile files and keeps the planned PATH", async () => {
      await withTempDir((dir) => {
        const { home, wrapper, planned } = setUp(dir, bash);
        const login = start(wrapper, home, ["-c", "-l", 'printf "%s\\n" "$PATH"']);
        expect(login.code).toBe(0);
        expect(login.stdout.trimEnd()).toBe(planned);
        // Only the three profile files are in the home: no marker was written.
        expect(readdirSync(home).toSorted()).toEqual(PROFILES.toSorted());
        for (const name of PROFILES) {
          expect(existsSync(join(home, `marker-${name}`))).toBe(false);
        }
      });
    });
  });
} else if (CI) {
  describe("Safe-Chain bash login shell (DIPO-178)", () => {
    it("needs bash at /bin/bash or /usr/bin/bash in CI", () => {
      expect(BASH).toBeDefined();
    });
  });
}
