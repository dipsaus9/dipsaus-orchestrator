// Aikido Safe-Chain in the worker sandbox (DIPO-82). On a machine with the official install at
// `~/.safe-chain`, the worker's package managers (`bun`, `npm`, `pip`, ...) run through it, and
// nothing else the maintainer's shell loads reaches the worker.
//
// Why the worker needs this (investigation in DIPO-82's notes): Claude Code's Bash tool sources a
// snapshot of the maintainer's interactive shell (`~/.claude/shell-snapshots`) before every
// command. The snapshot keeps the shell functions but not the variables they read, so a function
// such as a company `safe-chain` wrapper that uses `$ABSOLUTE_SELF_DIR` breaks (exit 127). And a
// PATH directory whose `bun` is a symlink into a directory the sandbox cannot read leaves
// Safe-Chain without a package manager to run.
//
// What dipo does, only when `~/.safe-chain/bin/safe-chain` and its POSIX init script exist:
// - Claude Code's shell (`CLAUDE_CODE_SHELL`) is a wrapper in the run directory. It sets PATH and
//   starts zsh with `ZDOTDIR` (or bash with `BASH_ENV`) on a file that sources only the official
//   `~/.safe-chain/scripts/init-posix.sh`.
// - The snapshot directory is read-denied, so its functions never load in the sandbox.
// - The sandbox may read `~/.safe-chain/{bin,scripts,certs}` and the wrapper directory, nothing
//   more: `safe-chain` opens `certs/ca-key.pem` even for `bun test`.
// - The worker's PATH leaves out directories the sandbox cannot read, and moves to its end the
//   directories whose wrapped commands resolve to files it cannot read (the company
//   `~/.bun/bin/bun` symlink), so a real binary later on PATH wins.
// No network and no local binding are added: an install through Safe-Chain needs both, and 0008
// keeps the worker's network closed.
//
// `detectSafeChain` reads the file system (injectable); everything else here is pure.

import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { posix } from "node:path";

import { isAtOrUnder } from "../../sandbox/policy";
import { PlanError } from "../types";
import type { LaunchFile } from "../types";

/** The official install, relative to the home directory. */
export const SAFE_CHAIN_HOME_DIR = ".safe-chain";
/** The `safe-chain` binary and the POSIX init script, relative to the install. */
export const SAFE_CHAIN_BINARY = "bin/safe-chain";
export const SAFE_CHAIN_INIT = "scripts/init-posix.sh";
/** What the worker sandbox may read of the install, relative to it (DIPO-82 investigation). */
export const SAFE_CHAIN_READ_DIRS = ["bin", "scripts", "certs"] as const;
/** The run directory's subdirectory that holds the shell wrapper and its init file. */
export const SAFE_CHAIN_SHELL_DIR = "safe-chain";
/** Claude Code's shell snapshots, relative to the home directory; read-denied with Safe-Chain. */
export const SHELL_SNAPSHOTS_DIR = ".claude/shell-snapshots";

/** The commands `init-posix.sh` (Safe-Chain 1.5) wraps in shell functions. */
export const SAFE_CHAIN_COMMANDS = [
  "bun",
  "bunx",
  "npm",
  "npx",
  "pnpm",
  "pnpx",
  "yarn",
  "rush",
  "rushx",
  "pip",
  "pip3",
  "uv",
  "uvx",
  "poetry",
  "python",
  "python3",
  "pipx",
  "pdm",
] as const;

/**
 * The command the self-test runs through Safe-Chain: `bun run --version`. Measured in DIPO-82:
 * Safe-Chain passes it through like `bun test` (no proxy, no network) and it exits 0 only when
 * Safe-Chain can start in the sandbox; a plain `bun --version` starts Safe-Chain's proxy and
 * needs local binding, which the worker does not have.
 */
export const SAFE_CHAIN_PROBE = "bun run --version";

/** Shells `init-posix.sh` supports; the daemon's `SHELL` first, then these. */
export const SAFE_CHAIN_SHELLS = ["/bin/zsh", "/bin/bash", "/usr/bin/zsh", "/usr/bin/bash"];

/** What a launch knows about Safe-Chain on this machine. Every path is absolute. */
export interface SafeChainLaunch {
  /** The official install, `~/.safe-chain`. */
  readonly root: string;
  /** The real zsh or bash the wrapper starts. */
  readonly shell: string;
  /** The worker's PATH: the daemon's, without `dropped` and with `demoted` moved to the end. */
  readonly path: string;
  /** PATH entries moved to the end: a wrapped command in them points where the sandbox cannot read. */
  readonly demoted: readonly { readonly entry: string; readonly reason: string }[];
  /** PATH entries left out: the worker sandbox cannot read them at all. */
  readonly dropped: readonly { readonly entry: string; readonly reason: string }[];
  /** The command the self-test runs (`SAFE_CHAIN_PROBE`), or null when PATH holds no `bun`. */
  readonly probe: string | null;
}

/** File system facts detection needs. */
export interface SafeChainFs {
  /** True when the path (symlinks followed) is a regular file the daemon may execute. */
  isExecutableFile(path: string): boolean;
  /** True when the path (symlinks followed) is a regular file. */
  isFile(path: string): boolean;
  /** The path with symlinks resolved, or null when it does not exist. */
  realpath(path: string): string | null;
}

export const nodeSafeChainFs: SafeChainFs = {
  isExecutableFile: (path) => {
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  isFile: (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  realpath: (path) => {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  },
};

export interface SafeChainInput {
  readonly home: string;
  /** The daemon's environment (`PATH`, `SHELL`). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Absolute paths the worker sandbox may read under home (toolchain and `allowRead`). */
  readonly readPaths: readonly string[];
}

/** The read paths a Safe-Chain launch adds to the worker sandbox. */
export function safeChainReadPaths(root: string): string[] {
  return SAFE_CHAIN_READ_DIRS.map((dir) => `${root}/${dir}`);
}

/**
 * Finds the official Safe-Chain install and plans the worker's PATH and shell. Null when it is
 * not installed, so the launch is exactly as without this story. Throws `PlanError` when it is
 * installed but no zsh or bash exists for its init script.
 */
export function detectSafeChain(
  input: SafeChainInput,
  fs: SafeChainFs = nodeSafeChainFs,
): SafeChainLaunch | null {
  const home = input.home;
  const root = `${home}/${SAFE_CHAIN_HOME_DIR}`;
  if (!fs.isExecutableFile(`${root}/${SAFE_CHAIN_BINARY}`)) return null;
  if (!fs.isFile(`${root}/${SAFE_CHAIN_INIT}`)) return null;

  const readRoots = [...input.readPaths, ...safeChainReadPaths(root)];
  const readable = (path: string) =>
    !isAtOrUnder(path, home) || readRoots.some((r) => isAtOrUnder(path, r));

  const kept: string[] = [];
  const demoted: { entry: string; reason: string }[] = [];
  const dropped: { entry: string; reason: string }[] = [];
  for (const entry of (input.env["PATH"] ?? "").split(":")) {
    // A relative or empty entry is kept: the self-test's PATH check refuses it, as before.
    if (!entry.startsWith("/")) {
      kept.push(entry);
      continue;
    }
    const real = fs.realpath(entry) ?? entry;
    if (!readable(entry) || !readable(real)) {
      dropped.push({ entry, reason: "the worker sandbox cannot read it" });
      continue;
    }
    const foreign = SAFE_CHAIN_COMMANDS.map((name) => {
      const target = fs.isExecutableFile(`${entry}/${name}`)
        ? fs.realpath(`${entry}/${name}`)
        : null;
      return target !== null && !readable(target) ? { name, target } : null;
    }).find((hit) => hit !== null);
    // Its other programs stay reachable; only a later directory's package managers win.
    if (foreign !== undefined && foreign !== null) {
      demoted.push({
        entry,
        reason: `its ${foreign.name} resolves to ${foreign.target}, which the worker sandbox cannot read`,
      });
      continue;
    }
    kept.push(entry);
  }
  const path = [...kept, ...demoted.map((item) => item.entry)];
  const absolute = path.filter((entry) => entry.startsWith("/"));
  const probe = absolute.some((entry) => fs.isExecutableFile(`${entry}/bun`))
    ? SAFE_CHAIN_PROBE
    : null;

  const declared = input.env["SHELL"];
  const shells = [
    ...(declared !== undefined && /^\/.*\/(?:zsh|bash)$/.test(declared) ? [declared] : []),
    ...SAFE_CHAIN_SHELLS,
  ];
  const shell = shells.find((candidate) => fs.isExecutableFile(candidate));
  if (shell === undefined) {
    throw new PlanError(
      `Safe-Chain is installed at ${root}, but neither zsh nor bash was found for its init script (${SAFE_CHAIN_SHELLS.join(", ")})`,
    );
  }
  return { root, shell, path: path.join(":"), demoted, dropped, probe };
}

/** `zsh` or `bash`: the wrapper's file name, which Claude Code reads to pick the shell family. */
export function shellFamily(shell: string): "zsh" | "bash" {
  return posix.basename(shell) === "zsh" ? "zsh" : "bash";
}

function quote(label: string, value: string): string {
  if (value.includes("'") || [...value].some((c) => c.charCodeAt(0) < 0x20 || c === "\u007f")) {
    throw new PlanError(`${label} cannot be quoted for the Safe-Chain shell: ${value}`, {
      path: value,
    });
  }
  return `'${value}'`;
}

/** The wrapper Claude Code runs as its shell: absolute, in the run directory. */
export function safeChainShellPath(shellDir: string, safeChain: SafeChainLaunch): string {
  return `${shellDir}/${shellFamily(safeChain.shell)}`;
}

/**
 * Pure: the wrapper and its init file, named relative to the run directory. The wrapper is the
 * only executable file of a plan.
 */
export function safeChainShellFiles(safeChain: SafeChainLaunch, shellDir: string): LaunchFile[] {
  const family = shellFamily(safeChain.shell);
  const initName = family === "zsh" ? ".zshenv" : "bash-env.sh";
  const init = `${shellDir}/${initName}`;
  const startup =
    family === "zsh"
      ? `export ZDOTDIR=${quote("the Safe-Chain shell directory", shellDir)}`
      : `export BASH_ENV=${quote("the Safe-Chain init file", init)}`;
  const wrapper = [
    "#!/bin/sh",
    "# dipo (DIPO-82): the worker's Bash tool shell. It reads only the init file next to it, which",
    "# loads the official Safe-Chain functions; the maintainer's shell setup is not loaded.",
    ...safeChain.dropped.map(
      (item) => `# PATH leaves out ${JSON.stringify(item.entry)}: ${JSON.stringify(item.reason)}`,
    ),
    ...safeChain.demoted.map(
      (item) =>
        `# PATH moves to its end ${JSON.stringify(item.entry)}: ${JSON.stringify(item.reason)}`,
    ),
    `export PATH=${quote("the worker PATH", safeChain.path)}`,
    startup,
    `exec ${quote("the shell", safeChain.shell)} "$@"`,
    "",
  ].join("\n");
  const initText = [
    "# dipo (DIPO-82): only the official Safe-Chain shell functions.",
    `. ${quote("the Safe-Chain init script", `${safeChain.root}/${SAFE_CHAIN_INIT}`)}`,
    "",
  ].join("\n");
  return [
    { name: `${SAFE_CHAIN_SHELL_DIR}/${family}`, content: wrapper, executable: true },
    { name: `${SAFE_CHAIN_SHELL_DIR}/${initName}`, content: initText },
  ];
}
