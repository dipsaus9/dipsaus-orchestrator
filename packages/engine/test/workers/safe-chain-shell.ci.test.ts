// CI only, and CI needs zsh (DIPO-103): the Safe-Chain worker shell started for real.
// Claude Code's shell snapshot runs the wrapper as `<shell> -c -l` and sources `$HOME/.zshrc` by
// path; a `compinit` there used to dump `.zcompdump` into the Safe-Chain shell directory. Here a
// stand-in home's `.zshrc` runs `compinit`, and afterwards the shell directory holds exactly the
// files dipo wrote, the home holds no dump, and the init file was read (it set ZDOTDIR).

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
const ZSH = ["/bin/zsh", "/usr/bin/zsh"].find((path) => existsSync(path));

/** The `.zshrc` of the stand-in home: what an rc with completions does (nvm, oh-my-zsh). */
const ZSHRC = 'autoload -Uz compinit && compinit -i\nprint -r -- "rc ran: $(whence -w compinit)"\n';

/** Writes the plan's shell files under `<dir>/run`, a stand-in home under `<dir>/home`. */
function setUp(dir: string, zsh: string) {
  const runDir = join(dir, "run");
  const shellDir = join(runDir, SAFE_CHAIN_SHELL_DIR);
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".zshrc"), ZSHRC);
  const launch: SafeChainLaunch = {
    root: join(home, ".safe-chain"),
    shell: zsh,
    path: process.env["PATH"] ?? "/usr/bin:/bin",
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
  const written = files.map((file) => file.name.slice(SAFE_CHAIN_SHELL_DIR.length + 1)).toSorted();
  return { shellDir, home, wrapper: safeChainShellPath(shellDir, launch), written };
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

if (CI && ZSH !== undefined) {
  const zsh = ZSH;
  describe("Safe-Chain worker shell state (DIPO-103)", () => {
    it("the snapshot's compinit writes nothing into the shell directory or the home", async () => {
      await withTempDir((dir) => {
        const { shellDir, home, wrapper, written } = setUp(dir, zsh);
        expect(written).toEqual([".zprofile", ".zshenv", "proxy.json", "zsh"]);
        const snapshot = start(wrapper, home, [
          "-c",
          "-l",
          'source "$HOME/.zshrc" < /dev/null; print -r -- "ZDOTDIR=$ZDOTDIR"',
        ]);
        expect(snapshot.code).toBe(0);
        expect(snapshot.stdout).toContain("rc ran: compinit: function");
        // Only the init file sets this, so the init file loaded.
        expect(snapshot.stdout).toContain("ZDOTDIR=/dev/null");
        expect(readdirSync(shellDir).toSorted()).toEqual(written);
        expect(readdirSync(home)).toEqual([".zshrc"]);
      });
    });

    it("worker commands, a nested zsh and an interactive start leave the directory as written", async () => {
      await withTempDir((dir) => {
        const { shellDir, home, wrapper, written } = setUp(dir, zsh);
        const command = start(wrapper, home, [
          "-c",
          "-l",
          `print -r -- "outer=$ZDOTDIR"; ${zsh} -c 'print -r -- "inner=$ZDOTDIR"'`,
        ]);
        expect(command.code).toBe(0);
        expect(command.stdout).toContain("outer=/dev/null");
        expect(command.stdout).toContain("inner=/dev/null");
        const interactive = start(wrapper, home, ["-i", "-c", 'print -r -- "i=$ZDOTDIR"']);
        expect(interactive.stdout).toContain("i=/dev/null");
        expect(readdirSync(shellDir).toSorted()).toEqual(written);
        expect(readdirSync(home)).toEqual([".zshrc"]);
      });
    });

    it("reads no later startup file from the shell directory but the login hook (DIPO-107)", async () => {
      await withTempDir((dir) => {
        const { shellDir, home, wrapper } = setUp(dir, zsh);
        // Without the init file's ZDOTDIR these would load from the shell directory. The login
        // shell reads its own .zprofile (the hook), which ends ZDOTDIR before .zlogin is due.
        for (const name of [".zshrc", ".zlogin"]) {
          writeFileSync(join(shellDir, name), `print -r -- "read ${name}"\n`);
        }
        const login = start(wrapper, home, ["-c", "-l", "print -r -- login"]);
        const interactive = start(wrapper, home, ["-i", "-l", "-c", "print -r -- interactive"]);
        expect(login.stdout).toBe("login\n");
        expect(interactive.stdout).toContain("interactive\n");
        expect(interactive.stdout).not.toContain("read .");
      });
    });
  });
} else if (CI) {
  describe("Safe-Chain worker shell state (DIPO-103)", () => {
    it("needs zsh at /bin/zsh or /usr/bin/zsh in CI", () => {
      expect(ZSH).toBeDefined();
    });
  });
}
