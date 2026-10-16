// Aikido Safe-Chain for the worker (DIPO-82, DIPO-84). On a machine with the official install at
// `~/.safe-chain`, every package download of the worker goes through dipo's Safe-Chain checking
// proxy (`sandbox/safe-chain-proxy.ts`, maintainer decision 2026-10-15, option B), and nothing
// the maintainer's shell loads reaches the worker.
//
// Why the shell wrapper (investigation in DIPO-82's notes): Claude Code's Bash tool sources a
// snapshot of the maintainer's interactive shell (`~/.claude/shell-snapshots`) before every
// command. The snapshot keeps the shell functions but not the variables they read, so a function
// such as a company `safe-chain` wrapper that uses `$ABSOLUTE_SELF_DIR` breaks (exit 127). And a
// PATH directory whose `bun` is a symlink into a directory the sandbox cannot read leaves the
// worker without a package manager.
//
// What dipo does, only when `~/.safe-chain/bin/safe-chain` and its POSIX init script exist:
// - Claude Code's shell (`CLAUDE_CODE_SHELL`) is a wrapper in the run directory. It sets PATH,
//   the install caches (all in the run temp directory) and the CA bundle of the run's proxy, and
//   starts zsh with `ZDOTDIR` (or bash with `BASH_ENV`) on a file that loads nothing else. The
//   zsh file then points `ZDOTDIR` at `/dev/null`, so zsh keeps no state there (DIPO-103). A
//   login shell is the exception: its `.zprofile` runs after `/etc/zprofile` (path_helper), and
//   restores the planned PATH there, so the demoted entries stay last (DIPO-107). bash's
//   `BASH_ENV` file runs after a login shell's system and user profiles, and does the same.
// - The snapshot directory is read-denied, so its functions never load in the sandbox.
// - The package managers run as they are, not through Safe-Chain's shell functions: Safe-Chain
//   in the sandbox would have to listen on 127.0.0.1, which needs local binding (DIPO-84). Their
//   traffic leaves the sandbox only through Claude Code's `httpProxyPort`, which is dipo's
//   proxy: the gate passes only the registries Safe-Chain checks, and Safe-Chain refuses malware.
// - The worker reads nothing of `~/.safe-chain`, and cannot read the proxy's directory.
// - The worker's PATH leaves out directories the sandbox cannot read, and moves to its end the
//   directories whose package managers resolve to files it cannot read (the company
//   `~/.bun/bin/bun` symlink), so a real binary later on PATH wins.
//
// `detectSafeChain` reads the file system (injectable); everything else here is pure.

import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { posix } from "node:path";

import { isAtOrUnder } from "../../sandbox/policy";
import {
  SAFE_CHAIN_CA_FILE,
  SAFE_CHAIN_PROXY_HOSTS,
  SAFE_CHAIN_PROXY_ROOT,
  SAFE_CHAIN_REGISTRY_HOSTS,
  safeChainProxyLayout,
  workerCacheEnv,
  workerCaEnv,
} from "../../sandbox/safe-chain-proxy";
import { PlanError } from "../types";
import type { LaunchFile } from "../types";

/** The official install, relative to the home directory. */
export const SAFE_CHAIN_HOME_DIR = ".safe-chain";
/** The `safe-chain` binary and the POSIX init script, relative to the install. */
export const SAFE_CHAIN_BINARY = "bin/safe-chain";
export const SAFE_CHAIN_INIT = "scripts/init-posix.sh";
/** The run directory's subdirectory: the shell wrapper, its init file, the proxy's CA bundle. */
export const SAFE_CHAIN_SHELL_DIR = "safe-chain";
/** Claude Code's shell snapshots, relative to the home directory; read-denied with Safe-Chain. */
export const SHELL_SNAPSHOTS_DIR = ".claude/shell-snapshots";

/** The package managers Safe-Chain 1.5 wraps; PATH entries are judged by them. */
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
 * The package manager the self-test installs with (DIPO-84): inside the worker sandbox it adds
 * `SAFE_CHAIN_PROBE_PACKAGE`, which must succeed, and Safe-Chain's test malware
 * `SAFE_CHAIN_BLOCKED_PACKAGE`, which Safe-Chain must refuse.
 */
export const SAFE_CHAIN_PROBE = "bun";
export const SAFE_CHAIN_PROBE_PACKAGE = "is-number@7.0.0";
export const SAFE_CHAIN_BLOCKED_PACKAGE = "safe-chain-test";

/** Shells the wrapper starts; the daemon's `SHELL` first, then these. */
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
  /** The package manager the self-test installs with (`SAFE_CHAIN_PROBE`), null without `bun`. */
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

/**
 * Finds the official Safe-Chain install and plans the worker's PATH and shell. Null when it is
 * not installed, so the launch is exactly as without this story. Throws `PlanError` when it is
 * installed but no zsh or bash exists for the worker shell.
 */
export function detectSafeChain(
  input: SafeChainInput,
  fs: SafeChainFs = nodeSafeChainFs,
): SafeChainLaunch | null {
  const home = input.home;
  const root = `${home}/${SAFE_CHAIN_HOME_DIR}`;
  if (!fs.isExecutableFile(`${root}/${SAFE_CHAIN_BINARY}`)) return null;
  if (!fs.isFile(`${root}/${SAFE_CHAIN_INIT}`)) return null;

  // The worker reads nothing of `~/.safe-chain` (DIPO-84): only the toolchain and `allowRead`.
  const readRoots = input.readPaths;
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
      `Safe-Chain is installed at ${root}, but neither zsh nor bash was found for the worker shell (${SAFE_CHAIN_SHELLS.join(", ")})`,
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

/** The run's proxy as the plan names it; the port and directory are placeholders in a dry run. */
export interface SafeChainRoute {
  /** dipo's local port that forwards to the gate: the worker sandbox's `httpProxyPort`. */
  readonly port: number;
  /** The proxy directory (`/tmp/dipo-p/<random>`); the worker reads none under its parent. */
  readonly dir: string;
}

/** What the dry run shows until a real run starts its proxy. */
export const PREVIEW_SAFE_CHAIN_ROUTE: SafeChainRoute = {
  port: 0,
  dir: `${SAFE_CHAIN_PROXY_ROOT}/<started-with-the-run>`,
};

/** The CA bundle of the run's proxy, which the worker's package managers trust. */
export function safeChainCaFile(shellDir: string): string {
  return `${shellDir}/${SAFE_CHAIN_CA_FILE}`;
}

/**
 * Pure: the wrapper, its init file and the proxy description, named relative to the run
 * directory. The wrapper is the only executable file of a plan.
 */
export function safeChainShellFiles(
  safeChain: SafeChainLaunch,
  shellDir: string,
  run: { readonly tmpDir: string; readonly route: SafeChainRoute },
): LaunchFile[] {
  const family = shellFamily(safeChain.shell);
  const initName = family === "zsh" ? ".zshenv" : "bash-env.sh";
  const init = `${shellDir}/${initName}`;
  const startup =
    family === "zsh"
      ? `export ZDOTDIR=${quote("the Safe-Chain shell directory", shellDir)}`
      : `export BASH_ENV=${quote("the Safe-Chain init file", init)}`;
  const caFile = safeChainCaFile(shellDir);
  const caches = workerCacheEnv(run.tmpDir);
  const pathExport = `export PATH=${quote("the worker PATH", safeChain.path)}`;
  const exports = [
    pathExport,
    ...Object.entries(caches).map(([name, value]) => `export ${name}=${quote(name, value)}`),
    ...Object.entries(workerCaEnv(caFile)).map(
      ([name, value]) => `export ${name}=${quote(name, value)}`,
    ),
  ];
  const wrapper = [
    "#!/bin/sh",
    "# dipo (DIPO-84): the worker's Bash tool shell. It reads only the init file next to it; the",
    "# maintainer's shell setup and the Safe-Chain shell functions are not loaded.",
    `# Reason: Safe-Chain installs. Package downloads leave the sandbox only through dipo's`,
    `# Safe-Chain proxy on 127.0.0.1:${run.route.port} (httpProxyPort), which passes only`,
    `# ${SAFE_CHAIN_REGISTRY_HOSTS.join(", ")} to Safe-Chain;`,
    "# local binding stays off. Install caches go to the run temp directory, and the package",
    "# managers trust the proxy's CA bundle.",
    ...safeChain.dropped.map(
      (item) => `# PATH leaves out ${JSON.stringify(item.entry)}: ${JSON.stringify(item.reason)}`,
    ),
    ...safeChain.demoted.map(
      (item) =>
        `# PATH moves to its end ${JSON.stringify(item.entry)}: ${JSON.stringify(item.reason)}`,
    ),
    ...exports,
    startup,
    `exec ${quote("the shell", safeChain.shell)} "$@"`,
    "",
  ].join("\n");
  const initText = [
    "# dipo (DIPO-84): nothing else loads; the wrapper set the environment.",
    ...(family === "zsh" ? ZSH_STATE_NOWHERE : bashLoginLines(pathExport)),
    "",
  ].join("\n");
  return [
    { name: `${SAFE_CHAIN_SHELL_DIR}/${family}`, content: wrapper, executable: true },
    { name: `${SAFE_CHAIN_SHELL_DIR}/${initName}`, content: initText },
    ...(family === "zsh"
      ? [{ name: `${SAFE_CHAIN_SHELL_DIR}/.zprofile`, content: zshLoginText(pathExport) }]
      : []),
    {
      name: `${SAFE_CHAIN_SHELL_DIR}/${SAFE_CHAIN_PROXY_FILE}`,
      content: `${JSON.stringify(proxyDescription(safeChain, caFile, caches, run.route), null, 2)}\n`,
    },
  ];
}

/**
 * The end of the zsh init file (DIPO-103). Claude Code's shell snapshot runs the wrapper outside
 * the sandbox and sources `$HOME/.zshrc` by path, whatever `ZDOTDIR` says; a `compinit` there
 * dumps to `${ZDOTDIR:-$HOME}/.zcompdump`, which was the shell directory. Once zsh has read this
 * file, `ZDOTDIR` points under `/dev/null`, which is no directory: zsh reads no further startup
 * file and nothing writes zsh state anywhere. Not the run temp directory: the worker can write
 * there, and `compinit` sources an existing dump outside the sandbox at the next snapshot.
 *
 * A login shell keeps `ZDOTDIR` on the shell directory (DIPO-107): zsh reads its `.zprofile`
 * from there after `/etc/zprofile`, which ends `ZDOTDIR` itself (see `zshLoginText`).
 */
export const ZSH_STATE_NOWHERE = [
  "# dipo (DIPO-103): later startup files and zsh state (.zcompdump) go nowhere.",
  "# dipo (DIPO-107): a login shell reads .zprofile from here, after /etc/zprofile.",
  "if [[ ! -o login ]]; then export ZDOTDIR=/dev/null; fi",
];

/**
 * The zsh login hook (DIPO-107). `/etc/zprofile` runs `path_helper`, which puts the system
 * directories back in front of PATH; this file runs after it and restores the planned PATH, then
 * ends `ZDOTDIR` as the init file does for the other shells (DIPO-103).
 */
export function zshLoginText(pathExport: string): string {
  return [
    "# dipo (DIPO-107): /etc/zprofile (path_helper) has run; the planned PATH comes back, so a",
    "# demoted entry stays last. Then zsh state goes nowhere (DIPO-103).",
    pathExport,
    "export ZDOTDIR=/dev/null",
    "",
  ].join("\n");
}

/**
 * The bash login hook (DIPO-107): bash runs `BASH_ENV` after a login shell's `/etc/profile` and
 * `~/.profile`-style files, so the planned PATH is restored here for login shells only.
 */
export function bashLoginLines(pathExport: string): string[] {
  return [
    "# dipo (DIPO-107): after the login files (path_helper), the planned PATH goes back.",
    "if shopt -q login_shell; then",
    `  ${pathExport}`,
    "fi",
  ];
}

/** The proxy description file of the run directory, for `dipo run --dry-run` and people. */
export const SAFE_CHAIN_PROXY_FILE = "proxy.json";

function proxyDescription(
  safeChain: SafeChainLaunch,
  caFile: string,
  caches: Record<string, string>,
  route: SafeChainRoute,
) {
  const layout = safeChainProxyLayout(route.dir);
  return {
    reason:
      "Safe-Chain installs (DIPO-84): the official Safe-Chain is installed, so every package download of the worker goes through dipo's Safe-Chain checking proxy, which refuses known malware.",
    install: safeChain.root,
    worker: {
      httpProxyPort: route.port,
      reaches: [...SAFE_CHAIN_REGISTRY_HOSTS],
      allowLocalBinding: false,
      caBundle: caFile,
      caches,
    },
    proxy: {
      dir: route.dir,
      sandbox: {
        network: [...SAFE_CHAIN_PROXY_HOSTS],
        allowLocalBinding: true,
        allowLocalBindingReason:
          "Safe-Chain listens on 127.0.0.1; no worker code runs in this sandbox, and its gate passes only CONNECT to the registries above",
        reads: `everything but the home directory, except the dipo binary; ${safeChain.root} is never read inside it`,
        writes: [layout.install, layout.tmp, layout.home, layout.reports, layout.sockets],
      },
      copiedFromInstall: `${safeChain.root}/bin/safe-chain (read-only; Safe-Chain makes a fresh CA in ${layout.install}/certs)`,
    },
  };
}

/**
 * True when a run directory holds a Safe-Chain proxy description: its worker was launched with
 * `httpProxyPort` on a dipo Safe-Chain proxy (DIPO-84). Re-attach uses it after a daemon restart.
 */
export function launchedThroughSafeChain(
  runDir: string,
  isFile: (path: string) => boolean = nodeSafeChainFs.isFile,
): boolean {
  return isFile(`${runDir}/${SAFE_CHAIN_SHELL_DIR}/${SAFE_CHAIN_PROXY_FILE}`);
}

/** The park detail of a re-attached run whose Safe-Chain proxy ended with the previous daemon. */
export function safeChainProxyGoneText(story: string): string {
  return `${story} was stopped: its worker was launched through a Safe-Chain proxy that ended with the previous daemon, so its package downloads had no checking proxy any more. Start the run again; it gets a new proxy.`;
}
