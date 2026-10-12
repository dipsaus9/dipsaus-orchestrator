// Running the Backlog.md CLI (0010 section 1). The engine runs only an allowlisted set of `backlog`
// subcommands, through the injected `Spawn`, and refuses the never-run list before spawning:
// `task complete`, `cleanup`, `task demote`, `doctor --fix`, `config set statuses` and any status
// `Draft`. The write path also refuses text holding a line of 50 `-` (it would print a fake section,
// fact 2), documentation entries holding `, ` (lists split on it), plan, notes or definition-of-done
// text ending in a `Modified files: ` line (the parser reads that line as the trailer), and any
// positional or unknown option starting with `-` (the CLI would read free text as a flag; free text
// goes after its option, which takes the next argument whatever it starts with). An error is any
// non-zero exit or a `not found` line (fact 3); it carries the command and its output.

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

/** Options of the allowed subcommands that take no value (from 1.53's `--help`). */
const FLAG_OPTIONS: ReadonlySet<string> = new Set([
  "--plain",
  "--json",
  "--draft",
  "--no-dod-defaults",
  "--clear-due-date",
  "--clear-milestone",
  "--clear-labels",
  "--clear-ac",
  "--clear-final-summary",
  "--clear-deps",
  "--clear-refs",
  "--clear-docs",
  "--unassigned",
  "--ready",
  "--count",
  "--fix",
  "--yes",
]);

/** Options of the allowed subcommands that take one value (from 1.53's `--help`). */
const VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-t",
  "--title",
  "-d",
  "--description",
  "--desc",
  "-a",
  "--assignee",
  "-s",
  "--status",
  "--exclude-status",
  "-l",
  "--labels",
  "--label",
  "--add-label",
  "--remove-label",
  "--priority",
  "--type",
  "--project",
  "--due-date",
  "--ordinal",
  "-m",
  "--milestone",
  "-p",
  "--parent",
  "--ac",
  "--acceptance-criteria",
  "--remove-ac",
  "--check-ac",
  "--uncheck-ac",
  "--dod",
  "--remove-dod",
  "--check-dod",
  "--uncheck-dod",
  "--plan",
  "--append-plan",
  "--notes",
  "--append-notes",
  "--comment",
  "--comment-author",
  "--final-summary",
  "--append-final-summary",
  "--depends-on",
  "--dep",
  "--ref",
  "--add-ref",
  "--remove-ref",
  "--modified-file",
  "--doc",
  "--documentation",
  "--search",
  "--limit",
  "--sort",
  "--max-count",
  "--skip",
]);

/** The texts printed before the `Modified files:` trailer line (see `plain.ts`). */
const BEFORE_TRAILER: ReadonlySet<string> = new Set([
  "--dod",
  "--plan",
  "--append-plan",
  "--notes",
  "--append-notes",
]);

interface ReadArgs {
  readonly options: readonly { readonly name: string; readonly value: string | undefined }[];
  /** A positional or unknown option that starts with `-`, which the CLI would read as a flag. */
  readonly dashed: string | undefined;
}

/**
 * Splits the arguments after the subcommand into options and positionals the way the CLI's
 * option parser does: a value option takes the next argument whatever it starts with, or its
 * value after `=` (or after a short name, `-sReady`).
 */
function readArgs(args: readonly string[]): ReadArgs {
  const options: { name: string; value: string | undefined }[] = [];
  let dashed: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (!arg.startsWith("-")) continue;
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name =
      eq > 0 ? arg.slice(0, eq) : !arg.startsWith("--") && arg.length > 2 ? arg.slice(0, 2) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : name !== arg ? arg.slice(2) : undefined;
    if (FLAG_OPTIONS.has(name) && inline === undefined) {
      options.push({ name, value: undefined });
    } else if (VALUE_OPTIONS.has(name)) {
      if (inline === undefined) i++;
      options.push({ name, value: inline ?? args[i] });
    } else {
      dashed ??= arg;
    }
  }
  return { options, dashed };
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
  const { options, dashed } = readArgs(args.slice(subs === null ? 1 : 2));
  const values = (names: readonly string[]) =>
    options.filter((o) => names.includes(o.name)).map((o) => o.value ?? "");
  if (values(["-s", "--status"]).some((value) => value.trim().toLowerCase() === "draft")) {
    return "status `Draft` is never set (0010 section 1)";
  }
  if (dashed !== undefined) {
    return `\`${dashed}\` starts with \`-\` but is no option the engine passes; the CLI would read it as a flag`;
  }
  if (args.some((arg) => hasSectionRule(arg))) {
    return "the text holds a line of 50 `-`, which Backlog.md would print as a section";
  }
  if (values(["--doc", "--documentation"]).some((value) => value.includes(", "))) {
    return "a documentation entry holds `, `, which the parser splits lists on";
  }
  const trailer = options.find(
    (o) =>
      BEFORE_TRAILER.has(o.name) &&
      (o.value ?? "")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .at(-1)
        ?.trimStart()
        .startsWith("Modified files: "),
  );
  if (trailer !== undefined) {
    return `the ${trailer.name} text ends with a \`Modified files: \` line, which the parser reads as the modified-files trailer`;
  }
  return null;
}

/** The 1.53 messages for an unknown id on stderr (fact 3). */
const NOT_FOUND_STDERR = /^(Task|Draft) \S+ not found/i;

/** The line reporting an unknown id (fact 3): 1.53 prints it on stderr, 1.48 on stdout. */
function notFoundLine(stdout: string, stderr: string): string | undefined {
  const fromStderr = stderr.split("\n").find((line) => NOT_FOUND_STDERR.test(line));
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
