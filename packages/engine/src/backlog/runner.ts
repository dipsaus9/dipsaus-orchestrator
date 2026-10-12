// Running the Backlog.md CLI (0010 section 1). The engine runs only an allowlisted set of `backlog`
// subcommands, through the injected `Spawn`, and refuses the never-run list before spawning:
// `task complete`, `cleanup`, `task demote`, `doctor --fix`, `config set statuses` and any status
// `Draft`. The write path also refuses text holding a line of 50 `-` (it would print a fake section,
// fact 2) and documentation entries holding `, ` (lists split on it). An error is any non-zero exit
// or a `not found` line (fact 3); it carries the command and its output.

import type { Spawn } from "@dipsaus-orchestrator/contract";

import { hasSectionRule } from "./plain";

/** How the engine starts the CLI. */
export interface BacklogCli {
  readonly spawn: Spawn;
  /** The program and any leading arguments; `["backlog"]` (found on `PATH`) by default. */
  readonly command?: readonly [string, ...string[]];
  /** The complete environment of the CLI; inherited when absent. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface BacklogOutput {
  readonly stdout: string;
  readonly stderr: string;
}

/** A command the runner refused; nothing was spawned. */
export class BacklogRefusedError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly reason: string,
  ) {
    super(`refused \`backlog ${args.join(" ")}\`: ${reason}`);
    this.name = "BacklogRefusedError";
  }
}

/** The CLI failed: a non-zero exit, a `not found` line, or it could not start. */
export class BacklogCommandError extends Error {
  constructor(
    readonly command: readonly string[],
    readonly exitCode: number | null,
    readonly stdout: string,
    readonly stderr: string,
    reason: string,
  ) {
    const output = [stderr.trim(), stdout.trim()].filter((text) => text !== "").join("\n");
    super(`\`${command.join(" ")}\` ${reason}${output === "" ? "" : `: ${output}`}`);
    this.name = "BacklogCommandError";
  }
}

/** The subcommands the engine may run; anything else is refused. */
const ALLOWED: Readonly<Record<string, readonly string[] | null>> = {
  task: ["view", "list", "create", "edit", "archive"],
  draft: ["view", "list", "create", "edit", "archive", "promote"],
  config: ["get", "set"],
  // `doctor` runs at reconcile, never with `--fix`.
  doctor: null,
};

/** The `config set` keys the engine may write (0010 section 6); `statuses` is never set. */
const CONFIG_SET_KEYS: ReadonlySet<string> = new Set([
  "defaultStatus",
  "checkActiveBranches",
  "remoteOperations",
  "autoCommit",
]);

const NEVER_RUN: readonly (readonly [string, string])[] = [
  ["task", "complete"],
  ["task", "demote"],
];

/** The value of every `-s` / `--status` option in `args`. */
function statusValues(args: readonly string[]): string[] {
  const values: string[] = [];
  for (const [i, arg] of args.entries()) {
    if (arg === "-s" || arg === "--status") {
      const value = args[i + 1];
      if (value !== undefined) values.push(value);
    } else if (arg.startsWith("--status=")) {
      values.push(arg.slice("--status=".length));
    } else if (arg.startsWith("-s") && !arg.startsWith("--") && arg.length > 2) {
      values.push(arg.slice(2));
    }
  }
  return values;
}

/** The values of `--doc` / `--documentation` options. */
function docValues(args: readonly string[]): string[] {
  const values: string[] = [];
  for (const [i, arg] of args.entries()) {
    if (arg === "--doc" || arg === "--documentation") {
      const value = args[i + 1];
      if (value !== undefined) values.push(value);
    } else if (arg.startsWith("--doc=") || arg.startsWith("--documentation=")) {
      values.push(arg.slice(arg.indexOf("=") + 1));
    }
  }
  return values;
}

/** Why the engine must not run `backlog <args>`, or null when it may. */
export function refusal(args: readonly string[]): string | null {
  const [group, sub] = args;
  if (group === undefined) return "no subcommand";
  if (args.length === 1 && group === "--version") return null;
  if (group === "cleanup") return "`cleanup` is never run (0010 section 1)";
  for (const [g, s] of NEVER_RUN) {
    if (group === g && sub === s) return `\`${g} ${s}\` is never run (0010 section 1)`;
  }
  if (group === "doctor" && args.includes("--fix")) {
    return "`doctor --fix` is never run (0010 section 1)";
  }
  if (group === "config" && sub === "set") {
    const key = args[2];
    if (key === "statuses") return "`config set statuses` is never run (0010 section 1)";
    if (key === undefined || !CONFIG_SET_KEYS.has(key)) {
      return `\`config set ${key ?? ""}\` is not a key the engine sets`;
    }
  }
  if (!Object.hasOwn(ALLOWED, group)) return `\`${group}\` is not an allowed subcommand`;
  const subs = ALLOWED[group];
  if (subs !== null && subs !== undefined && (sub === undefined || !subs.includes(sub))) {
    return `\`${group} ${sub ?? ""}\` is not an allowed subcommand`;
  }
  if (statusValues(args).some((value) => value.trim().toLowerCase() === "draft")) {
    return "status `Draft` is never set (0010 section 1)";
  }
  if (args.some((arg) => hasSectionRule(arg))) {
    return "the text holds a line of 50 `-`, which Backlog.md would print as a section";
  }
  if (docValues(args).some((value) => value.includes(", "))) {
    return "a documentation entry holds `, `, which the parser splits lists on";
  }
  return null;
}

/** True when the output reports an unknown id (fact 3): 1.53 prints it on stderr. */
function notFoundLine(stdout: string, stderr: string): string | undefined {
  const fromStderr = stderr.split("\n").find((line) => /\bnot found\b/i.test(line));
  if (fromStderr !== undefined) return fromStderr;
  // A view's text is the task's own; only a bare message counts there.
  if (stdout.startsWith("File: ")) return undefined;
  return stdout.split("\n").find((line) => /^\S.*\bnot found\b/i.test(line));
}

/**
 * Runs `backlog <args>` in `cwd` and returns its output. Throws `BacklogRefusedError` before
 * spawning a refused command and `BacklogCommandError` when the CLI fails.
 */
export async function runBacklog(
  cli: BacklogCli,
  cwd: string,
  args: readonly string[],
): Promise<BacklogOutput> {
  const reason = refusal(args);
  if (reason !== null) throw new BacklogRefusedError(args, reason);
  const command: [string, ...string[]] = [...(cli.command ?? ["backlog"]), ...args];
  let child;
  try {
    child = cli.spawn({ cmd: command, cwd, ...(cli.env === undefined ? {} : { env: cli.env }) });
  } catch (error) {
    throw new BacklogCommandError(
      command,
      null,
      "",
      "",
      `could not start: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit.code !== 0) {
    const how =
      exit.code === null ? `was killed by ${exit.signal ?? "a signal"}` : `exited ${exit.code}`;
    throw new BacklogCommandError(command, exit.code, stdout, stderr, how);
  }
  const notFound = notFoundLine(stdout, stderr);
  if (notFound !== undefined) {
    throw new BacklogCommandError(command, exit.code, stdout, stderr, "reported `not found`");
  }
  return { stdout, stderr };
}
