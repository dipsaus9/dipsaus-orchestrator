// Safe-Chain in the worker sandbox (DIPO-82): detection at launch, the worker's PATH, and the
// shell wrapper and init file. The file system is in memory; nothing here reads the machine.

import { describe, expect, it } from "bun:test";

import {
  detectSafeChain,
  SAFE_CHAIN_PROBE,
  safeChainShellFiles,
  safeChainShellPath,
  type SafeChainFs,
  type SafeChainLaunch,
} from "../../src/workers/claude-cli/safe-chain";
import { PlanError } from "../../src/workers/types";

const HOME = "/home/maintainer";
const ROOT = `${HOME}/.safe-chain`;
const COMPANY = `${HOME}/code/company/safe-chain-symlinks`;
const READ = [`${HOME}/.bun`, `${HOME}/.npm`, `${HOME}/.cache`];
const SHELL_DIR = "/home/maintainer/code/shop/.git/dipo/runs/run-0001/safe-chain";

/** Executable files, plain files and symlinks by path; any other path resolves to itself. */
class MemorySafeChainFs implements SafeChainFs {
  readonly executables = new Set<string>([
    `${ROOT}/bin/safe-chain`,
    "/bin/zsh",
    "/bin/bash",
    "/usr/bin/git",
  ]);
  readonly files = new Set<string>([`${ROOT}/scripts/init-posix.sh`]);
  readonly links = new Map<string, string>();

  isExecutableFile(path: string): boolean {
    return this.executables.has(path);
  }
  isFile(path: string): boolean {
    return this.files.has(path) || this.executables.has(path);
  }
  realpath(path: string): string | null {
    return this.links.get(path) ?? path;
  }
}

/** The DIPO-55 machine: the real bun in `~/.bun/bin-originals`, a company symlink in `~/.bun/bin`. */
function companyMachine(): MemorySafeChainFs {
  const fs = new MemorySafeChainFs();
  fs.executables.add(`${HOME}/.bun/bin-originals/bun`);
  fs.executables.add(`${HOME}/.bun/bin/bun`);
  fs.executables.add(`${HOME}/.bun/bin/backlog`);
  fs.links.set(`${HOME}/.bun/bin/bun`, `${COMPANY}/scripts/symlinked/package-manager-wrapper.sh`);
  return fs;
}

function detect(fs: SafeChainFs, path: string, shell = "/bin/zsh"): SafeChainLaunch | null {
  return detectSafeChain({ home: HOME, env: { PATH: path, SHELL: shell }, readPaths: READ }, fs);
}

describe("(unit) Safe-Chain detection", () => {
  it("finds nothing without the official binary or its init script", () => {
    const noBinary = new MemorySafeChainFs();
    noBinary.executables.delete(`${ROOT}/bin/safe-chain`);
    expect(detect(noBinary, "/usr/bin:/bin")).toBeNull();
    const noInit = new MemorySafeChainFs();
    noInit.files.clear();
    expect(detect(noInit, "/usr/bin:/bin")).toBeNull();
  });

  it("puts the real bun first: drops unreadable entries, moves foreign wrappers to the end", () => {
    const path = [
      `${HOME}/.bun/bin`,
      `${COMPANY}/bin`,
      `${HOME}/.local/bin`,
      `${HOME}/.bun/bin-originals`,
      "/usr/bin",
      "/bin",
      `${ROOT}/bin`,
    ].join(":");
    const found = detect(companyMachine(), path);
    expect(found).toMatchObject({ root: ROOT, shell: "/bin/zsh", probe: SAFE_CHAIN_PROBE });
    expect(found?.path).toBe(
      [`${HOME}/.bun/bin-originals`, "/usr/bin", "/bin", `${ROOT}/bin`, `${HOME}/.bun/bin`].join(
        ":",
      ),
    );
    expect(found?.dropped.map((item) => item.entry)).toEqual([
      `${COMPANY}/bin`,
      `${HOME}/.local/bin`,
    ]);
    expect(found?.demoted).toEqual([
      {
        entry: `${HOME}/.bun/bin`,
        reason: `its bun resolves to ${COMPANY}/scripts/symlinked/package-manager-wrapper.sh, which the worker sandbox cannot read`,
      },
    ]);
  });

  it("keeps a PATH whose package managers the sandbox can read, in its order", () => {
    const fs = new MemorySafeChainFs();
    fs.executables.add("/opt/homebrew/bin/npm");
    fs.links.set("/opt/homebrew/bin/npm", "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js");
    const found = detect(fs, "/opt/homebrew/bin:/usr/bin:/bin");
    expect(found?.path).toBe("/opt/homebrew/bin:/usr/bin:/bin");
    expect(found?.dropped).toEqual([]);
    expect(found?.demoted).toEqual([]);
    // No bun on PATH: nothing for the self-test to run.
    expect(found?.probe).toBeNull();
  });

  it("reads a home entry through the read paths and the Safe-Chain grants", () => {
    const fs = companyMachine();
    const found = detectSafeChain(
      {
        home: HOME,
        env: { PATH: `${HOME}/tools/bin:${ROOT}/bin` },
        readPaths: [...READ, `${HOME}/tools`],
      },
      fs,
    );
    expect(found?.path).toBe(`${HOME}/tools/bin:${ROOT}/bin`);
  });

  it("starts the daemon's zsh or bash, else a system one, and refuses without either", () => {
    const fs = companyMachine();
    fs.executables.add("/opt/homebrew/bin/bash");
    expect(detect(fs, "/usr/bin", "/opt/homebrew/bin/bash")?.shell).toBe("/opt/homebrew/bin/bash");
    expect(detect(fs, "/usr/bin", "/usr/bin/fish")?.shell).toBe("/bin/zsh");
    fs.executables.delete("/bin/zsh");
    expect(detect(fs, "/usr/bin", "/usr/bin/fish")?.shell).toBe("/bin/bash");
    fs.executables.delete("/bin/bash");
    expect(() => detect(fs, "/usr/bin", "/usr/bin/fish")).toThrow(PlanError);
  });
});

describe("(unit) Safe-Chain shell files", () => {
  const launch: SafeChainLaunch = {
    root: ROOT,
    shell: "/bin/zsh",
    path: `${HOME}/.bun/bin-originals:/usr/bin:/bin`,
    demoted: [{ entry: `${HOME}/.bun/bin`, reason: "its bun resolves elsewhere" }],
    dropped: [{ entry: `${HOME}/.local/bin`, reason: "the worker sandbox cannot read it" }],
    probe: SAFE_CHAIN_PROBE,
  };

  it("writes a zsh wrapper that sets PATH and ZDOTDIR and a .zshenv with only the official init", () => {
    const [wrapper, init] = safeChainShellFiles(launch, SHELL_DIR);
    expect(wrapper).toMatchObject({ name: "safe-chain/zsh", executable: true });
    expect(wrapper?.content).toStartWith("#!/bin/sh\n");
    expect(wrapper?.content).toContain(`export PATH='${launch.path}'\n`);
    expect(wrapper?.content).toContain(`export ZDOTDIR='${SHELL_DIR}'\n`);
    expect(wrapper?.content).toEndWith(`exec '/bin/zsh' "$@"\n`);
    expect(wrapper?.content).toContain(`# PATH leaves out "${HOME}/.local/bin"`);
    expect(wrapper?.content).toContain(`# PATH moves to its end "${HOME}/.bun/bin"`);
    expect(init).toEqual({
      name: "safe-chain/.zshenv",
      content: `# dipo (DIPO-82): only the official Safe-Chain shell functions.\n. '${ROOT}/scripts/init-posix.sh'\n`,
    });
    expect(safeChainShellPath(SHELL_DIR, launch)).toBe(`${SHELL_DIR}/zsh`);
  });

  it("writes a bash wrapper with BASH_ENV for bash", () => {
    const bash = { ...launch, shell: "/bin/bash" };
    const [wrapper, init] = safeChainShellFiles(bash, SHELL_DIR);
    expect(wrapper?.name).toBe("safe-chain/bash");
    expect(wrapper?.content).toContain(`export BASH_ENV='${SHELL_DIR}/bash-env.sh'\n`);
    expect(init?.name).toBe("safe-chain/bash-env.sh");
    expect(init?.content).toContain(`. '${ROOT}/scripts/init-posix.sh'`);
    expect(safeChainShellPath(SHELL_DIR, bash)).toBe(`${SHELL_DIR}/bash`);
  });

  it("refuses a value it cannot quote", () => {
    expect(() => safeChainShellFiles({ ...launch, path: "/usr/bin:/it's" }, SHELL_DIR)).toThrow(
      PlanError,
    );
    expect(() => safeChainShellFiles(launch, "/tmp/a\nb")).toThrow(PlanError);
  });
});
