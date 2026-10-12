// The system side of sandboxed engine steps (DIPO-37, 0008 section 2). This is the only engine code
// that starts a sandboxed step: it spawns `dipo daemon sandbox-exec --policy <file> -- <cmd>` from
// `process.execPath`, which runs the command inside the bundled `srt` library (0004 and 0006
// amendments of 2026-10-12). It also gathers the probe facts, makes the step temp root
// `/tmp/dipo-s-<id>` and writes the policy file next to it.

import type { ChildExit, ChildProcess, Signal } from "@dipsaus-orchestrator/contract";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { evaluateProbe, type ProbeResult, type SandboxFacts } from "../sandbox/probe";
import type { SandboxHost } from "../sandbox/step";
import type { DipoPlatform } from "./paths";

/** Where step temp roots live. Short, because macOS limits Unix socket paths to about 104 bytes. */
export const STEP_TEMP_PREFIX = "/tmp/dipo-s-";

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

/** The argv of one sandboxed step. */
export function sandboxExecArgv(
  dipo: readonly string[],
  policyPath: string,
  command: readonly string[],
): string[] {
  return [...dipo, "daemon", "sandbox-exec", "--policy", policyPath, "--", ...command];
}

/** The policy file of a temp root: a sibling, so the step cannot rewrite it under its own root. */
export function policyPathFor(tempRoot: string): string {
  return `${tempRoot}.policy.json`;
}

async function firstLine(cmd: string[], env: Record<string, string>): Promise<string | null> {
  try {
    const child = Bun.spawn({ cmd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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

/** Gathers the probe facts of this machine with the step's PATH. */
export async function systemSandboxFacts(
  platform: DipoPlatform,
  env: Readonly<Record<string, string | undefined>>,
): Promise<SandboxFacts> {
  const PATH = env["PATH"] ?? "";
  const which = (name: string) => Bun.which(name, { PATH });
  const rg = which("rg");
  if (platform !== "linux") {
    return { platform, rg, bwrap: null, socat: null, restrictUserns: null, os: null };
  }
  const bwrapPath = which("bwrap");
  const bwrap =
    bwrapPath === null
      ? null
      : { path: bwrapPath, version: await firstLine([bwrapPath, "--version"], { PATH }) };
  const osText = await readTrimmed("/etc/os-release");
  return {
    platform,
    rg,
    bwrap,
    socat: which("socat"),
    restrictUserns: await readTrimmed("/proc/sys/kernel/apparmor_restrict_unprivileged_userns"),
    os: osText === null ? null : parseOsRelease(osText),
  };
}

/** Checks what `srt` needs on this machine (0008 section 2). */
export async function probeSandbox(
  platform: DipoPlatform,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ProbeResult> {
  return evaluateProbe(await systemSandboxFacts(platform, env));
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
  return {
    probe: (env) => probeSandbox(platform, env),
    // mkdtemp makes the directory 0700 with an unpredictable name.
    createTempRoot: () => mkdtemp(tempPrefix),
    removeTempRoot: async (tempRoot) => {
      await rm(policyPathFor(tempRoot), { force: true });
      await rm(tempRoot, { recursive: true, force: true });
    },
    writePolicy: async (tempRoot, settings) => {
      const path = policyPathFor(tempRoot);
      // `wx`: never through a file or link someone else left at that name.
      await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      return path;
    },
    start: ({ policyPath, command, cwd, env }) =>
      groupChild(
        Bun.spawn({
          cmd: sandboxExecArgv(dipo, policyPath, command),
          cwd,
          env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          detached: true,
        }),
      ),
  };
}
