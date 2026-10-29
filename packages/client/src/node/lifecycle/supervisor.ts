// Optional autostart (0005, 0006 decision 15): `dipo daemon install` writes a launchd agent that
// runs `dipo daemon --foreground` and restarts it after a crash, and `uninstall` removes it. When
// installed, `dipo daemon start|stop|restart` go through `launchctl`, so launchd and the CLI never
// fight. `install` is a named offline
// maintenance operation outside the contract (0006 amendment of 2026-10-12).
//
// The agent is `~/Library/LaunchAgents/dipo.daemon.plist`, in the `gui/<uid>` domain, or
// `user/<uid>` where the GUI domain is missing (an SSH session). `KeepAlive.SuccessfulExit = false`
// restarts only after a crash; `AbandonProcessGroup` keeps worker hosts alive when the job stops;
// `ExitTimeOut = 75` is above the 60 s drain cap. dipo runs on macOS only (0004): there is no
// other supervisor.
//
// The plist carries the binary's absolute path and the installing user's `PATH`, so the daemon
// resolves the same tools as the shell (DIPO-15). Every command goes through the injected `exec`,
// so tests never touch launchctl.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { LAUNCHD_LABEL } from "@dipsaus-orchestrator/contract";

import type { Env } from "../runtime";

/** The drain cap is 60 s with `stopWorkers`; the supervisor waits longer before it kills. */
export const SUPERVISOR_STOP_TIMEOUT_S = 75;

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one `launchctl` command; injectable for tests. */
export type SupervisorExec = (cmd: readonly [string, ...string[]]) => Promise<ExecResult>;

export interface SupervisorDeps {
  /** The passwd home directory (0006 decision 3). */
  readonly home: string;
  readonly uid: number;
  readonly exec: SupervisorExec;
  /** How this binary runs itself, absolute (`selfCommand()`). */
  readonly selfCommand: readonly [string, ...string[]];
  /** The installing user's environment; its `PATH` goes into the plist. */
  readonly env: Env;
}

export const systemSupervisorExec: SupervisorExec = async (cmd) => {
  try {
    const child = Bun.spawn({
      cmd: [...cmd],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  } catch (error) {
    return {
      code: 127,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
};

/** Where `install` writes the plist. */
export function supervisorFile(deps: Pick<SupervisorDeps, "home">): string {
  return join(deps.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export function isInstalled(deps: Pick<SupervisorDeps, "home">): boolean {
  return existsSync(supervisorFile(deps));
}

/** The command the supervisor runs: this binary's `daemon --foreground`. */
export function daemonProgram(selfCommand: readonly [string, ...string[]]): [string, ...string[]] {
  return [...selfCommand, "daemon", "--foreground"];
}

function xml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export interface UnitOptions {
  /** Absolute program and arguments. */
  readonly program: readonly [string, ...string[]];
  /** The installing user's `PATH`. */
  readonly path: string;
}

/** The launchd agent (0006 decision 15). */
export function launchdPlist(options: UnitOptions): string {
  const args = options.program.map((arg) => `\t\t<string>${xml(arg)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${LAUNCHD_LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
${args}
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>${xml(options.path)}</string>
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
\t<key>AbandonProcessGroup</key>
\t<true/>
\t<key>ExitTimeOut</key>
\t<integer>${SUPERVISOR_STOP_TIMEOUT_S}</integer>
</dict>
</plist>
`;
}

/** The binary an installed plist runs, read back for the "path is gone" warning. */
export function installedProgram(text: string): string | null {
  const plist = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(text);
  if (plist?.[1] === undefined) return null;
  return plist[1]
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

/** `gui/<uid>`, or `user/<uid>` when the GUI domain is missing (an SSH session). */
export async function launchdDomain(deps: SupervisorDeps): Promise<string> {
  const gui = `gui/${deps.uid}`;
  const probe = await deps.exec(["launchctl", "print", gui]);
  return probe.code === 0 ? gui : `user/${deps.uid}`;
}

export type SupervisorStepResult =
  | { readonly ok: true; readonly commands: readonly string[] }
  | { readonly ok: false; readonly commands: readonly string[]; readonly message: string };

async function run(
  deps: SupervisorDeps,
  steps: readonly (readonly [string, ...string[]])[],
  tolerate: (index: number) => boolean = () => false,
): Promise<SupervisorStepResult> {
  const commands: string[] = [];
  for (const [index, step] of steps.entries()) {
    commands.push(step.join(" "));
    const result = await deps.exec(step);
    if (result.code !== 0 && !tolerate(index)) {
      const detail = (result.stderr.trim() || result.stdout.trim()).split("\n").at(-1) ?? "";
      return {
        ok: false,
        commands,
        message: `\`${step.join(" ")}\` failed (exit ${result.code})${detail === "" ? "" : `: ${detail}`}`,
      };
    }
  }
  return { ok: true, commands };
}

/** Writes the plist for this binary and the caller's `PATH`; returns its path. */
export function writeSupervisorFile(deps: SupervisorDeps): string {
  const file = supervisorFile(deps);
  const options: UnitOptions = {
    program: daemonProgram(deps.selfCommand),
    path: deps.env["PATH"] ?? "/usr/bin:/bin",
  };
  mkdirSync(dirname(file), { recursive: true });
  // Write, then rename, so launchd never reads half a file.
  writeFileSync(`${file}.tmp`, launchdPlist(options), { mode: 0o644 });
  renameSync(`${file}.tmp`, file);
  return file;
}

/** Loads and starts the installed job: `launchctl bootstrap`. */
export async function supervisorEnable(deps: SupervisorDeps): Promise<SupervisorStepResult> {
  const domain = await launchdDomain(deps);
  return run(deps, [["launchctl", "bootstrap", domain, supervisorFile(deps)]]);
}

/** Stops and unloads the job and removes the file. */
export async function supervisorRemove(deps: SupervisorDeps): Promise<SupervisorStepResult> {
  // Not loaded is fine: the file is removed either way.
  const domain = await launchdDomain(deps);
  const result = await run(
    deps,
    [["launchctl", "bootout", `${domain}/${LAUNCHD_LABEL}`]],
    () => true,
  );
  rmSync(supervisorFile(deps), { force: true });
  return result;
}

/**
 * Starts the installed daemon: `kickstart` when the job is loaded, else `bootstrap` (which starts
 * it through `RunAtLoad`).
 */
export async function supervisorStart(deps: SupervisorDeps): Promise<SupervisorStepResult> {
  const domain = await launchdDomain(deps);
  const target = `${domain}/${LAUNCHD_LABEL}`;
  const loaded = (await deps.exec(["launchctl", "print", target])).code === 0;
  return run(deps, [
    loaded
      ? ["launchctl", "kickstart", target]
      : ["launchctl", "bootstrap", domain, supervisorFile(deps)],
  ]);
}

/**
 * Stops the installed daemon: `bootout`, which sends SIGTERM (the drain), SIGKILL after
 * `ExitTimeOut`, and does not restart it; the next start bootstraps it again.
 */
export async function supervisorStop(deps: SupervisorDeps): Promise<SupervisorStepResult> {
  const domain = await launchdDomain(deps);
  // Not loaded means not running under launchd: nothing to stop there.
  return run(deps, [["launchctl", "bootout", `${domain}/${LAUNCHD_LABEL}`]], () => true);
}

/** What `status` reports about autostart. */
export interface AutostartReport {
  readonly installed: boolean;
  readonly file: string;
  /** The binary the installed file runs; null when not installed or unreadable. */
  readonly program: string | null;
  /** The installed binary no longer exists: run `install` again. */
  readonly programMissing: boolean;
}

export async function autostartReport(deps: SupervisorDeps): Promise<AutostartReport> {
  const file = supervisorFile(deps);
  let program: string | null = null;
  const installed = existsSync(file);
  if (installed) {
    try {
      program = installedProgram(readFileSync(file, "utf8"));
    } catch {
      program = null;
    }
  }
  return {
    installed,
    file,
    program,
    programMissing: program !== null && !existsSync(program),
  };
}
