// The system side of sandboxed engine steps (DIPO-37, 0008 section 2). This is the only engine code
// that starts a sandboxed step: it spawns `dipo daemon sandbox-exec --policy <file> --cwd <dir> --
// <cmd>` from `process.execPath`, which runs the command inside the bundled `srt` library (0004
// and 0006 amendments of 2026-10-12). It also makes the step temp root `/tmp/dipo-s-<id>`, writes
// the policy file next to it, and resolves, trust-checks and probes the host programs srt runs
// outside the sandbox. `sandbox-exec` repeats the trust check and the probe before it starts srt.

import type { ChildExit, ChildProcess, Signal } from "@dipsaus-orchestrator/contract";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  trustViolations,
  writableRoots,
  type SandboxTools,
  type SrtSettings,
  type TrustedCandidate,
} from "../sandbox/policy";
import { evaluateProbe, type ProbeResult, type SandboxFacts } from "../sandbox/probe";
import { refusalPathFor, type SandboxHost } from "../sandbox/step";
import {
  passwdHome,
  readRuntimeRecord,
  resolveSoftwareDirs,
  runtimeCandidates,
  type DipoPlatform,
} from "./paths";

/** Where step temp roots live. Short, because macOS limits Unix socket paths to about 104 bytes. */
export const STEP_TEMP_PREFIX = "/tmp/dipo-s-";

/** The working directory `sandbox-exec` starts in: nothing there is writable by a step. */
export const TRUSTED_CWD = "/";

/** True when this module runs inside the compiled `dipo` binary. */
export function isCompiled(moduleUrl: string = import.meta.url): boolean {
  return new URL(moduleUrl).pathname.startsWith("/$bunfs/");
}

/**
 * The argv that runs `dipo`: the binary itself, or Bun with the CLI entry when running from
 * source (tests, development).
 */
export function dipoCommand(): string[] {
  if (isCompiled()) return [process.execPath];
  return [process.execPath, resolve(import.meta.dir, "../../../cli/src/main.ts")];
}

/**
 * The workspace a from-source `dipo` runs (the repository holding `packages/cli/src/main.ts`) and
 * its `node_modules`: when the CLI entry is given, a step may not be able to write them.
 */
export function sourceCodeRoots(mainScript: string | undefined): string[] {
  if (mainScript === undefined) return [];
  const root = resolve(mainScript, "../../../..");
  return [root, join(root, "node_modules")];
}

/**
 * dipo's own directories (0006 decision 3, DIPO-23 path rules): state, logs, the runtime directory
 * recorded in `runtime.json` and every runtime candidate, from the daemon's environment.
 */
export async function systemDipoDirs(
  platform: DipoPlatform,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string[]> {
  const dirs = resolveSoftwareDirs({ platform, env, home: passwdHome() });
  const record = await readRuntimeRecord(dirs.state);
  const candidates = runtimeCandidates({
    platform,
    env,
    uid: process.getuid?.() ?? 0,
    lingering: true,
  }).map((candidate) => candidate.path);
  return [
    ...new Set([
      dirs.state,
      dirs.logs,
      ...(record === null ? [] : [record.runtimeDir]),
      ...candidates,
    ]),
  ];
}

/** The argv of one sandboxed step. */
export function sandboxExecArgv(
  dipo: readonly string[],
  policyPath: string,
  command: readonly string[],
  cwd?: string,
): string[] {
  return [
    ...dipo,
    "daemon",
    "sandbox-exec",
    "--policy",
    policyPath,
    ...(cwd === undefined ? [] : ["--cwd", cwd]),
    "--",
    ...command,
  ];
}

/** The policy file of a temp root: a sibling, so the step cannot rewrite it under its own root. */
export function policyPathFor(tempRoot: string): string {
  return `${tempRoot}.policy.json`;
}

/** The entries of a PATH value, empty entries included (an empty entry means the cwd). */
export function pathEntries(PATH: string | undefined): string[] {
  return PATH === undefined || PATH === "" ? [] : PATH.split(":");
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** The first `name` on the absolute entries of PATH; relative entries are never searched. */
export async function whichAbsolute(
  name: string,
  PATH: string | undefined,
): Promise<string | null> {
  for (const entry of pathEntries(PATH)) {
    if (!entry.startsWith("/")) continue;
    const candidate = join(entry, name);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/** Resolves the host programs srt runs: `rg` everywhere, `bwrap` and `socat` on Linux. Runs nothing. */
export async function resolveTools(
  platform: DipoPlatform,
  PATH: string | undefined,
): Promise<SandboxTools> {
  return {
    rg: await whichAbsolute("rg", PATH),
    bwrap: platform === "linux" ? await whichAbsolute("bwrap", PATH) : null,
    socat: platform === "linux" ? await whichAbsolute("socat", PATH) : null,
  };
}

/**
 * The spellings of a path: as given, and with symlinks resolved on its longest existing prefix
 * (so `/tmp/x` on macOS is also `/private/tmp/x`, even before `x` exists).
 */
export async function spellings(path: string): Promise<string[]> {
  let head = path;
  let rest = "";
  for (;;) {
    try {
      const real = await realpath(head);
      const full = rest === "" ? real : join(real, rest);
      return full === path ? [path] : [path, full];
    } catch {
      const parent = dirname(head);
      if (parent === head) return [path];
      rest =
        rest === "" ? head.slice(parent.length + 1) : join(head.slice(parent.length + 1), rest);
      head = parent;
    }
  }
}

/**
 * Why a step under `settings` may not run: a relative PATH entry, or a pinned program, the dipo
 * binary or a PATH directory at or under a path the step can write (its `allowWrite` entries and
 * srt's default write paths). Runs nothing.
 */
export async function checkTrust(input: {
  readonly settings: SrtSettings;
  readonly homes: readonly string[];
  readonly PATH: string | undefined;
  readonly tools: SandboxTools;
  readonly binary: string;
  /** Source code a from-source dipo runs (`sourceCodeRoots`); empty for the binary. */
  readonly code: readonly string[];
}): Promise<string[]> {
  const writable = await Promise.all(
    writableRoots(input.settings, input.homes).map(async (root) => ({
      source: root.source,
      spellings: await spellings(root.path),
    })),
  );
  const named: [string, string | null][] = [
    ["rg", input.tools.rg],
    ["bwrap", input.tools.bwrap],
    ["socat", input.tools.socat],
    ["the dipo binary", input.binary],
  ];
  const candidates: TrustedCandidate[] = [];
  for (const [label, path] of named) {
    if (path !== null) candidates.push({ label, spellings: await spellings(path) });
  }
  for (const path of input.code) {
    candidates.push({ label: "the dipo source", spellings: await spellings(path) });
  }
  const entries = pathEntries(input.PATH);
  for (const entry of entries) {
    if (entry.startsWith("/")) {
      candidates.push({ label: "PATH directory", spellings: await spellings(entry) });
    }
  }
  return trustViolations({ writable, candidates, pathEntries: entries });
}

async function firstLine(cmd: string[]): Promise<string | null> {
  try {
    const child = Bun.spawn({
      cmd,
      env: { PATH: "/usr/bin:/bin" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) return null;
    return `${out}\n${err}`.trim().split("\n")[0] ?? null;
  } catch {
    return null;
  }
}

async function readTrimmed(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return null;
  }
}

/** Parses `ID` and `VERSION_ID` from `/etc/os-release`. */
export function parseOsRelease(text: string): { id: string; versionId: string } | null {
  const field = (name: string): string | null => {
    const match = new RegExp(`^${name}=(.*)$`, "m").exec(text);
    if (match?.[1] === undefined) return null;
    return match[1].trim().replace(/^["']|["']$/g, "");
  };
  const id = field("ID");
  if (id === null) return null;
  return { id, versionId: field("VERSION_ID") ?? "" };
}

/** Gathers the probe facts for pinned programs; runs `bwrap --version` on Linux. */
export async function systemSandboxFacts(
  platform: DipoPlatform,
  tools: SandboxTools,
): Promise<SandboxFacts> {
  if (platform !== "linux") {
    return { platform, rg: tools.rg, bwrap: null, socat: null, restrictUserns: null, os: null };
  }
  const bwrap =
    tools.bwrap === null
      ? null
      : { path: tools.bwrap, version: await firstLine([tools.bwrap, "--version"]) };
  const osText = await readTrimmed("/etc/os-release");
  return {
    platform,
    rg: tools.rg,
    bwrap,
    socat: tools.socat,
    restrictUserns: await readTrimmed("/proc/sys/kernel/apparmor_restrict_unprivileged_userns"),
    os: osText === null ? null : parseOsRelease(osText),
  };
}

/** Checks what `srt` needs on this machine (0008 section 2), for already trusted programs. */
export async function probeSandbox(
  platform: DipoPlatform,
  tools: SandboxTools,
): Promise<ProbeResult> {
  return evaluateProbe(await systemSandboxFacts(platform, tools));
}

/** Wraps a Bun subprocess started in its own process group as a contract `ChildProcess`. */
function groupChild(child: Bun.Subprocess<"ignore", "pipe", "pipe">): ChildProcess {
  const exited: Promise<ChildExit> = child.exited.then(() => ({
    code: child.signalCode === null ? child.exitCode : null,
    signal: child.signalCode,
  }));
  return {
    pid: child.pid,
    stdin: null,
    stdout: child.stdout,
    stderr: child.stderr,
    exited,
    kill(signal: Signal = "SIGTERM") {
      // The whole group: sandbox-exec, the sandbox wrapper and the step's own processes.
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    },
  };
}

/** The real `SandboxHost`. */
export function systemSandboxHost(
  platform: DipoPlatform,
  dipo: readonly string[] = dipoCommand(),
  // Tests pass a prefix under DIPO_TMP (0017 section 3).
  tempPrefix: string = STEP_TEMP_PREFIX,
): SandboxHost {
  const binary = dipo[0] ?? process.execPath;
  return {
    // mkdtemp makes the directory 0700 with an unpredictable name.
    createTempRoot: () => mkdtemp(tempPrefix),
    removeTempRoot: async (tempRoot) => {
      const policy = policyPathFor(tempRoot);
      await rm(refusalPathFor(policy), { force: true });
      await rm(policy, { force: true });
      await rm(tempRoot, { recursive: true, force: true });
    },
    resolveTools: (env) => resolveTools(platform, env["PATH"]),
    trustCheck: ({ settings, home, env }) =>
      checkTrust({
        settings,
        homes: [home, env["HOME"] ?? home, passwdHome()],
        PATH: env["PATH"],
        tools: {
          rg: settings.ripgrep?.command ?? null,
          bwrap: settings.bwrapPath ?? null,
          socat: settings.socatPath ?? null,
        },
        binary,
        code: sourceCodeRoots(dipo[1]),
      }),
    dipoDirs: (env) => systemDipoDirs(platform, env),
    probe: (tools) => probeSandbox(platform, tools),
    writePolicy: async (tempRoot, settings) => {
      const path = policyPathFor(tempRoot);
      // `wx`: never through a file or link someone else left at that name.
      await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      return path;
    },
    start: ({ policyPath, command, cwd, env }) =>
      groupChild(
        Bun.spawn({
          cmd: sandboxExecArgv(dipo, policyPath, command, cwd),
          // Never the worktree: Bun would load its bunfig.toml and .env before srt starts.
          cwd: TRUSTED_CWD,
          env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          detached: true,
        }),
      ),
    readRefusal: async (policyPath) => {
      try {
        return (await readFile(refusalPathFor(policyPath), "utf8")).trim();
      } catch (error) {
        // No file: sandbox-exec did not refuse. Any other error is an unreadable refusal.
        if ((error as { code?: string }).code === "ENOENT") return null;
        throw error;
      }
    },
  };
}
