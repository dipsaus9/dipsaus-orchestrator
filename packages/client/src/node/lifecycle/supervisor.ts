// Optional autostart (0006 decision 15): `dipo daemon install` writes a launchd agent or a systemd
// user unit that runs `dipo daemon --foreground` and restarts it after a crash, and `uninstall`
// removes it. When installed, `dipo daemon start|stop|restart` go through `launchctl` or
// `systemctl --user`, so the supervisor and the CLI never fight. `install` is a named offline
// maintenance operation outside the contract (0006 amendment of 2026-10-12).
//
// - macOS: `~/Library/LaunchAgents/dipo.daemon.plist`, in the `gui/<uid>` domain, or `user/<uid>`
//   where the GUI domain is missing (an SSH session). `KeepAlive.SuccessfulExit = false` restarts
//   only after a crash; `AbandonProcessGroup` keeps worker hosts alive when the job stops;
//   `ExitTimeOut = 75` is above the 60 s drain cap.
// - Linux: `~/.config/systemd/user/dipo.service` with `Restart=on-failure`, `TimeoutStopSec=75`
//   and `RestartPreventExitStatus=78`, so a daemon that refuses its `config.yaml` (EXIT_CONFIG,
//   DIPO-69) is not restarted in a loop. Without lingering the user manager stops at logout, which
//   ends the daemon and every worker host; `install` and `status` warn and explain
//   `loginctl enable-linger`, but never run it.
//
// Both carry the binary's absolute path and the installing user's `PATH`, so the daemon resolves
// the same tools as the shell (DIPO-15). Every command goes through the injected `exec`, so tests
// never touch launchctl, systemctl or loginctl.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { EXIT_CONFIG, LAUNCHD_LABEL, SYSTEMD_UNIT } from "@dipsaus-orchestrator/contract";

import type { Env } from "../runtime";

/** The drain cap is 60 s with `stopWorkers`; the supervisor waits longer before it kills. */
export const SUPERVISOR_STOP_TIMEOUT_S = 75;

export type SupervisorKind = "launchd" | "systemd";

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one supervisor command (`launchctl`, `systemctl`, `loginctl`); injectable for tests. */
export type SupervisorExec = (cmd: readonly [string, ...string[]]) => Promise<ExecResult>;

export interface SupervisorDeps {
  readonly platform: "darwin" | "linux";
  /** The passwd home directory (0006 decision 3). */
  readonly home: string;
  readonly uid: number;
  readonly user: string;
  readonly exec: SupervisorExec;
  /** How this binary runs itself, absolute (`selfCommand()`). */
  readonly selfCommand: readonly [string, ...string[]];
  /** The installing user's environment; its `PATH` goes into the plist or unit. */
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

export function supervisorKind(deps: Pick<SupervisorDeps, "platform">): SupervisorKind {
  return deps.platform === "darwin" ? "launchd" : "systemd";
}

/** Where `install` writes the plist or unit. */
export function supervisorFile(deps: Pick<SupervisorDeps, "platform" | "home">): string {
  return deps.platform === "darwin"
    ? join(deps.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`)
    : join(deps.home, ".config", "systemd", "user", SYSTEMD_UNIT);
}

export function isInstalled(deps: Pick<SupervisorDeps, "platform" | "home">): boolean {
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

/** One systemd word: `%` and `$` escaped, quoted when it holds whitespace, quotes or `\`. */
function systemdWord(word: string): string {
  const escaped = word.replaceAll("%", "%%").replaceAll("$", "$$$$");
  if (!/[\s"'\\]/.test(escaped)) return escaped;
  return `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** The systemd user unit (0006 decision 15). */
export function systemdUnit(options: UnitOptions): string {
  const env = `PATH=${options.path.replaceAll("%", "%%")}`;
  const envLine = /[\s"'\\]/.test(env)
    ? `"${env.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : env;
  return `[Unit]
Description=dipo daemon

[Service]
Type=simple
ExecStart=${options.program.map(systemdWord).join(" ")}
Environment=${envLine}
Restart=on-failure
RestartPreventExitStatus=${EXIT_CONFIG}
TimeoutStopSec=${SUPERVISOR_STOP_TIMEOUT_S}

[Install]
WantedBy=default.target
`;
}

/** The binary an installed plist or unit runs, read back for the "path is gone" warning. */
export function installedProgram(text: string): string | null {
  const plist = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(text);
  if (plist?.[1] !== undefined) {
    return plist[1]
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&apos;", "'")
      .replaceAll("&amp;", "&");
  }
  const unit = /^ExecStart=("((?:[^"\\]|\\.)*)"|\S+)/m.exec(text);
  if (unit === null) return null;
  const word = unit[2] !== undefined ? unit[2].replace(/\\(.)/g, "$1") : (unit[1] ?? "");
  return word.replaceAll("%%", "%").replaceAll("$$", "$");
}

/** `gui/<uid>`, or `user/<uid>` when the GUI domain is missing (an SSH session). */
export async function launchdDomain(deps: SupervisorDeps): Promise<string> {
  const gui = `gui/${deps.uid}`;
  const probe = await deps.exec(["launchctl", "print", gui]);
  return probe.code === 0 ? gui : `user/${deps.uid}`;
}

/** Lingering for this user (`loginctl show-user`); null when it cannot be read. */
export async function lingeringOn(deps: SupervisorDeps): Promise<boolean | null> {
  const result = await deps.exec(["loginctl", "show-user", deps.user, "--property=Linger"]);
  if (result.code !== 0) return null;
  const match = /^Linger=(yes|no)\s*$/m.exec(result.stdout);
  return match === null ? null : match[1] === "yes";
}

/** The warning `install` and `status` print on Linux when lingering is off. */
export function lingerWarning(user: string): string {
  return `lingering is off for ${user}: systemd stops your user manager at logout, which ends the daemon and every running worker. To keep them running, run \`loginctl enable-linger ${user}\` (dipo does not run it for you).`;
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

/** Writes the plist or unit for this binary and the caller's `PATH`; returns its path. */
export function writeSupervisorFile(deps: SupervisorDeps): string {
  const file = supervisorFile(deps);
  const options: UnitOptions = {
    program: daemonProgram(deps.selfCommand),
    path: deps.env["PATH"] ?? "/usr/bin:/bin",
  };
  const text = deps.platform === "darwin" ? launchdPlist(options) : systemdUnit(options);
  mkdirSync(dirname(file), { recursive: true });
  // Write, then rename, so launchd or systemd never reads half a file.
  writeFileSync(`${file}.tmp`, text, { mode: 0o644 });
  renameSync(`${file}.tmp`, file);
  return file;
}

/** Loads and starts the installed job: `launchctl bootstrap` or `systemctl --user enable --now`. */
export async function supervisorEnable(deps: SupervisorDeps): Promise<SupervisorStepResult> {
  if (deps.platform === "darwin") {
    const domain = await launchdDomain(deps);
    return run(deps, [["launchctl", "bootstrap", domain, supervisorFile(deps)]]);
  }
  return run(deps, [
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT],
  ]);
}

/** Stops and unloads the job and removes the file. */
export async function supervisorRemove(deps: SupervisorDeps): Promise<SupervisorStepResult> {
  // Not loaded or not enabled is fine: the file is removed either way.
  if (deps.platform === "darwin") {
    const domain = await launchdDomain(deps);
    const result = await run(
      deps,
      [["launchctl", "bootout", `${domain}/${LAUNCHD_LABEL}`]],
      () => true,
    );
    rmSync(supervisorFile(deps), { force: true });
    return result;
  }
  const disable = await run(
    deps,
    [["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT]],
    () => true,
  );
  rmSync(supervisorFile(deps), { force: true });
  const reload = await run(deps, [["systemctl", "--user", "daemon-reload"]]);
  const commands = [...disable.commands, ...reload.commands];
  return reload.ok ? { ok: true, commands } : { ok: false, commands, message: reload.message };
}

/**
 * Starts the installed daemon. launchd: `kickstart` when the job is loaded, else `bootstrap`
 * (which starts it through `RunAtLoad`). systemd: `systemctl --user start`.
 */
export async function supervisorStart(deps: SupervisorDeps): Promise<SupervisorStepResult> {
  if (deps.platform === "darwin") {
    const domain = await launchdDomain(deps);
    const target = `${domain}/${LAUNCHD_LABEL}`;
    const loaded = (await deps.exec(["launchctl", "print", target])).code === 0;
    return run(deps, [
      loaded
        ? ["launchctl", "kickstart", target]
        : ["launchctl", "bootstrap", domain, supervisorFile(deps)],
    ]);
  }
  return run(deps, [["systemctl", "--user", "start", SYSTEMD_UNIT]]);
}

/**
 * Stops the installed daemon. launchd: `bootout`, which sends SIGTERM (the drain), SIGKILL after
 * `ExitTimeOut`, and does not restart it; the next start bootstraps it again. systemd:
 * `systemctl --user stop`, the same with `TimeoutStopSec`.
 */
export async function supervisorStop(deps: SupervisorDeps): Promise<SupervisorStepResult> {
  if (deps.platform === "darwin") {
    const domain = await launchdDomain(deps);
    // Not loaded means not running under launchd: nothing to stop there.
    return run(deps, [["launchctl", "bootout", `${domain}/${LAUNCHD_LABEL}`]], () => true);
  }
  return run(deps, [["systemctl", "--user", "stop", SYSTEMD_UNIT]]);
}

/** What `status` reports about autostart. */
export interface AutostartReport {
  readonly supervisor: SupervisorKind;
  readonly installed: boolean;
  readonly file: string;
  /** The binary the installed file runs; null when not installed or unreadable. */
  readonly program: string | null;
  /** The installed binary no longer exists: run `install` again. */
  readonly programMissing: boolean;
  /** Linux only; null on macOS or when `loginctl` cannot say. */
  readonly lingering: boolean | null;
  /** The user lingering is about. */
  readonly user: string;
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
    supervisor: supervisorKind(deps),
    installed,
    file,
    program,
    programMissing: program !== null && !existsSync(program),
    lingering: deps.platform === "linux" ? await lingeringOn(deps) : null,
    user: deps.user,
  };
}
