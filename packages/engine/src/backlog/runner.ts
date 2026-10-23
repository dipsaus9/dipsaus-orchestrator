// Running the Backlog.md CLI (0010 section 1). The engine runs only an allowlisted set of `backlog`
// subcommands, through the injected `Spawn`, and refuses the never-run list before spawning:
// `task complete`, `cleanup`, `task demote`, `doctor --fix`, `config set statuses` and any status
// `Draft`. The write path also refuses text holding a line of 50 `-` (it would print a fake section,
// fact 2), documentation entries holding `, ` (lists split on it), plan, notes or definition-of-done
// text ending in a `Modified files: ` line (the parser reads that line as the trailer), and any
// positional or unknown option starting with `-` (the CLI would read free text as a flag; free text
// goes after its option, which takes the next argument whatever it starts with). An edit may change
// labels only with `--add-label` and `--remove-label`, never by replacing or clearing the list
// (0010 section 3). An error is any
// non-zero exit or a `not found` line (fact 3); it carries the command and its output.
//
// Every call gets a minimal, explicit environment (`backlogEnv`), never the daemon's whole one
// (0021 section 14). The caller picks the working folder: for a story it is a folder that holds
// only dipo's own copy of the backlog, never the worktree a worker's files land in
// (`inStoryBacklog` in `worktree/claim.ts`).
//
// Before every call, in whatever folder it runs (dipo's own copy, a checkout of the base, the
// backlog lane's worktree), dipo checks the Backlog files the CLI could read there
// (`scanBacklogFiles`, DIPO-312). dipo refuses a Backlog CLI call when a task file's front matter
// is not plain YAML, or a Backlog file is not one it can check (`BacklogFileRefusedError`), and a
// status change when the configuration or a task file defines a command for the CLI to run on it
// (`BacklogStatusCommandError`). Either is refused before spawning, with an `engine.notice` to the
// CLI's `notify` naming the file (and the story, for a status change).
//
// Every call has a deadline on the engine clock (DIPO-314; `CALL_DEADLINE_MS`, 60 s, by default),
// counted from the start of the call, the scan above included. The CLI starts in its own process
// group; past the deadline the group is killed and the call throws `BacklogTimedOutError` (code
// `timedOut`, a `BacklogCommandError`, so every caller that handles a failed CLI call handles it)
// naming the command and the deadline, without waiting for the CLI's output.

import { createHash } from "node:crypto";
import { type Dirent, readdirSync, readFileSync, type Stats, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

import type { Clock, Spawn } from "@dipsaus-orchestrator/contract";

import { systemClock } from "../platform/clock";
import { CALL_DEADLINE_MS, TIMED_OUT, timedOutText, withDeadline } from "../platform/deadline";
import { parseYamlDocument } from "../platform/yaml";

import { hasSectionRule } from "./plain";

/** How the engine starts the CLI. */
export interface BacklogCli {
  readonly spawn: Spawn;
  /** The program and any leading arguments; `["backlog"]` (found on `PATH`) by default. */
  readonly command?: readonly [string, ...string[]];
  /**
   * The environment the CLI's variables are taken from; the process's own when absent. Only
   * `BACKLOG_ENV_KEYS` are taken (0021 section 14), so nothing else of it reaches the CLI.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Receives the `engine.notice` of a refused status change (DIPO-312). */
  readonly notify?: (notice: BacklogNotice) => void;
  /** The engine clock each call's deadline runs on; the system clock when absent. */
  readonly clock?: Clock;
  /** How long one call may run before it is killed (DIPO-314); `CALL_DEADLINE_MS` by default. */
  readonly deadlineMs?: number;
}

/** An `engine.notice` the runner raises. */
export interface BacklogNotice {
  readonly level: "error";
  readonly code: string;
  readonly text: string;
}

/**
 * The only variables a Backlog CLI call gets (0021 section 14): `PATH` to find its runtime and
 * `HOME` for its user settings. The daemon's other variables never reach it.
 */
export const BACKLOG_ENV_KEYS: readonly string[] = ["PATH", "HOME"];

/** The minimal, explicit environment of a Backlog CLI call, taken from `source`. */
export function backlogEnv(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BACKLOG_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
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

/**
 * The CLI did not finish within its deadline (DIPO-314): it and its process group were killed.
 * A `BacklogCommandError` with code `timedOut`, the command and the deadline.
 */
export class BacklogTimedOutError extends BacklogCommandError {
  readonly code = TIMED_OUT;

  constructor(
    command: readonly string[],
    readonly deadlineMs: number,
  ) {
    super(command, null, "", "", "");
    this.message = timedOutText(command, deadlineMs);
    this.name = "BacklogTimedOutError";
  }
}

/** True when `error` is a Backlog CLI call killed at its deadline. */
export function isBacklogTimedOut(error: unknown): error is BacklogTimedOutError {
  return error instanceof BacklogTimedOutError;
}

/** One file that stops a status change, with why (a fixed text). */
export type StatusCommandFile = BacklogFileHit;

/** The `engine.notice` code of a refused status change. */
export const STATUS_COMMAND_NOTICE = "backlog.statusCommand";

/**
 * A status change dipo refused before spawning (DIPO-312): the Backlog configuration or a task file
 * the call runs with defines a command for the CLI to run, or cannot be checked.
 */
export class BacklogStatusCommandError extends BacklogRefusedError {
  constructor(
    args: readonly string[],
    readonly story: string,
    readonly files: readonly StatusCommandFile[],
  ) {
    super(args, statusCommandText(story, files));
    this.name = "BacklogStatusCommandError";
  }

  /** The `engine.notice` of the refusal. */
  notice(): BacklogNotice {
    return { level: "error", code: STATUS_COMMAND_NOTICE, text: this.reason };
  }
}

/**
 * A call dipo refused before spawning (DIPO-312): a Backlog file the CLI could read in its folder
 * has a front matter block that is not plain YAML, or is not a file dipo can check.
 */
export class BacklogFileRefusedError extends BacklogRefusedError {
  constructor(
    args: readonly string[],
    readonly files: readonly BacklogFileHit[],
  ) {
    super(args, backlogFileText(files));
    this.name = "BacklogFileRefusedError";
  }

  /** The `engine.notice` of the refusal. */
  notice(): BacklogNotice {
    return { level: "error", code: BACKLOG_FILE_NOTICE, text: this.reason };
  }
}

/** The fixed text of a call refused for its Backlog files: each file with its reason. */
export function backlogFileText(files: readonly BacklogFileHit[]): string {
  const named = files.map((file) => `${file.path} ${file.reason}`).join("; ");
  return `dipo refused a Backlog CLI call: ${named}. dipo runs the Backlog CLI only on Backlog files whose front matter is plain YAML; nothing was run`;
}

/** The fixed text of a refused status change: the story and each file with its reason. */
export function statusCommandText(story: string, files: readonly StatusCommandFile[]): string {
  const named = files.map((file) => `${file.path} ${file.reason}`).join("; ");
  return `dipo refused to change the status of ${story === "" ? "a story" : story} with the Backlog CLI: ${named}. dipo runs no command a Backlog file defines; nothing was changed`;
}

/** The subcommands the engine may run; anything else is refused. */
const ALLOWED: Readonly<Record<string, readonly string[] | null>> = {
  task: ["view", "list", "create", "edit", "archive"],
  draft: ["view", "list", "create", "edit", "archive", "promote"],
  config: ["get", "set"],
  // The Ready gate reads which milestones exist (R07, DIPO-71).
  milestone: ["list"],
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
  "--show-completed",
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

/** Edit options that replace or clear the whole label list. */
const REPLACING_LABEL_OPTIONS: ReadonlySet<string> = new Set([
  "-l",
  "--label",
  "--labels",
  "--clear-labels",
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
  const labelOption = options.find((o) => REPLACING_LABEL_OPTIONS.has(o.name));
  if (sub === "edit" && labelOption !== undefined) {
    return `\`${labelOption.name}\` replaces the labels; an edit changes labels only with --add-label and --remove-label (0010 section 3)`;
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
 * spawning a refused command (`BacklogFileRefusedError` for a folder whose Backlog files dipo cannot
 * check, `BacklogStatusCommandError` for a status change the folder's Backlog files would attach a
 * command to, each with a notice to `cli.notify`) and
 * `BacklogCommandError` when the CLI fails (`BacklogTimedOutError` past the call's deadline).
 */
export async function runBacklog(
  cli: BacklogCli,
  cwd: string,
  args: readonly string[],
): Promise<BacklogOutput> {
  const clock = cli.clock ?? systemClock;
  const deadlineMs = cli.deadlineMs ?? CALL_DEADLINE_MS;
  const startedAt = clock.now();
  const reason = refusal(args);
  if (reason !== null) throw new BacklogRefusedError(args, reason);
  // `backlog --version` prints the CLI's version and reads no project.
  const project = !(args.length === 1 && args[0] === "--version");
  const scan = scanBacklogFiles(cwd, VERDICTS, { project });
  if (scan.refused.length > 0) {
    const refused = new BacklogFileRefusedError(args, scan.refused);
    tellOnce(cli.notify, noticeKeys(scan, scan.refused), () => refused.notice());
    throw refused;
  }
  const story = statusChangeOf(args);
  if (story !== null && scan.statusCommands.length > 0) {
    const refused = new BacklogStatusCommandError(args, story, scan.statusCommands);
    tellOnce(cli.notify, noticeKeys(scan, scan.statusCommands, story), () => refused.notice());
    throw refused;
  }
  const command: [string, ...string[]] = [...(cli.command ?? ["backlog"]), ...args];
  // The deadline counts from the start of the call, the scan above included.
  const left = deadlineMs - (clock.now() - startedAt);
  if (left <= 0) throw new BacklogTimedOutError(command, deadlineMs);
  let child;
  try {
    child = cli.spawn({
      cmd: command,
      cwd,
      env: backlogEnv(cli.env ?? process.env),
      // Its own process group, so the deadline kills what it started too (DIPO-314).
      detached: true,
    });
  } catch (error) {
    throw new BacklogCommandError(
      command,
      null,
      "",
      "",
      `could not start: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const [stdout, stderr, exit] = await withDeadline(
    child,
    Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]),
    { clock, deadlineMs: left, timedOut: () => new BacklogTimedOutError(command, deadlineMs) },
  );
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

// ---- the Backlog files a call runs with (DIPO-312, 0021 section 14) ----------------------------
//
// Before every call, dipo checks the Backlog files the CLI could read in the folder the call runs
// in (`scanBacklogFiles`): every place Backlog.md 1.53 takes its configuration from
// (`backlog.config.yml`, `config.yml` and `config.yaml` in `backlog/`, in `.backlog/` and in the
// folder `backlog.config.yml` names), and every Markdown file in those backlog folders, at any
// depth (tasks, drafts, completed and archived stories, documents, decisions, milestones).
//
// dipo refuses a Backlog CLI call when a task file's front matter is not plain YAML
// (`BacklogFileRefusedError`): a Markdown file whose front matter block names a language
// (`---js`, `--- yaml`, in any case, after any number of byte order marks) or does not parse
// (read as 1.53 reads it, which quotes a hand-written `due_date`, `assignee` or `reporter` value
// first), a Backlog file that is not a plain file dipo can read whole (a special file, or larger
// than `BACKLOG_CHECK_MAX`), a `backlog.config.yml` that names a backlog folder dipo cannot
// resolve inside the folder the call runs in, or a folder with no project configuration of its own
// (a `backlog.config.yml` with a project name, or `config.yml` or `config.yaml` in `backlog/` or
// `.backlog/`), where the CLI would look for one in the folders above.
//
// Before a status change (`task edit` or `draft edit` with `--status`), dipo also refuses when the
// configuration or a task file defines a command for the CLI to run on that change
// (`BacklogStatusCommandError`): Backlog.md 1.53 runs a shell command after a status change when
// the task's front matter or the project configuration sets `onStatusChange` (or
// `on_status_change`). The name is compared without case after a compatibility fold: in a
// configuration file anywhere, in a task file within its front matter, as text and as a parsed key
// (a merge key counts as one). A task file is any Markdown file in a folder that is, by its
// identity on disk (device and inode), the `tasks/` or `completed/` folder of a backlog folder, so
// a folder name in another case or a link to the folder counts as the folder itself.
//
// A missing file defines nothing. Each file's verdict is kept per path with the file's identity
// and change times (`VerdictCache`, least recently used paths dropped first), so a pass over an
// unchanged backlog reads no file again: one directory read per folder and one `stat` per file. A
// refusal raises an `engine.notice` through the CLI's `notify` once per file, by its path in the
// folder and its content (and the story, for a status change), so neither an unchanged file nor
// dipo's per-call copy of a story's backlog repeats it on every call.

/** The most bytes of one Backlog file dipo reads to check it; a larger file is refused. */
export const BACKLOG_CHECK_MAX = 1024 * 1024;

/** How deep below a backlog folder dipo looks for Markdown files; deeper folders are refused. */
export const BACKLOG_CHECK_DEPTH = 8;

/** The `engine.notice` code of a call refused for a Backlog file dipo cannot check. */
export const BACKLOG_FILE_NOTICE = "backlog.fileRefused";

/** The configuration files of Backlog.md 1.53 in a backlog folder. */
const FOLDER_CONFIGS: readonly string[] = ["config.yml", "config.yaml"];

/** The root configuration file of Backlog.md 1.53. */
const ROOT_CONFIG = "backlog.config.yml";

/** The folders 1.53 loads a task from, inside a backlog folder. */
const TASK_FOLDERS: readonly string[] = ["tasks", "completed"];

const STATUS_COMMAND_KEYS: readonly string[] = ["onstatuschange", "on_status_change"];

const DEFINES_COMMAND = "defines a command for the Backlog CLI to run on a status change";
const NOT_PLAIN_YAML =
  "opens a front matter block that is not plain YAML, which dipo does not let the Backlog CLI read";
const DOES_NOT_PARSE = "holds a front matter block that does not parse, so dipo cannot check it";
const NO_PROJECT_CONFIG =
  "holds no Backlog project configuration (backlog.config.yml with a project name, or config.yml in backlog/ or .backlog/), so dipo does not run the Backlog CLI there";
const UNRESOLVED_FOLDER =
  "names a backlog folder dipo cannot resolve inside the repository, so dipo cannot check it";

/** `text` folded for the key search: compatibility forms, combining marks dropped, lower case. */
function foldKey(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

function namesStatusCommand(text: string): boolean {
  const folded = foldKey(text);
  return STATUS_COMMAND_KEYS.some((key) => folded.includes(key));
}

/**
 * The story whose status `args` change (`task edit <id>` or `draft edit <id>` with `-s` or
 * `--status`), "" when such a call names no id, or null for any other call.
 */
export function statusChangeOf(args: readonly string[]): string | null {
  const [group, sub, id] = args;
  if ((group !== "task" && group !== "draft") || sub !== "edit") return null;
  const { options } = readArgs(args.slice(2));
  if (!options.some((option) => option.name === "-s" || option.name === "--status")) return null;
  return id === undefined || id.startsWith("-") ? "" : id;
}

/**
 * Pure: why the Backlog configuration `text` stops a status change, or null: it names
 * `onStatusChange` or `on_status_change` anywhere.
 */
export function configStatusCommand(text: string): string | null {
  return namesStatusCommand(text) ? DEFINES_COMMAND : null;
}

/** What `backlog.config.yml` says about the backlog folder. */
export type BacklogPointer =
  | { readonly kind: "none" }
  | { readonly kind: "folder"; readonly folder: string }
  | { readonly kind: "unresolved" };

/**
 * Pure: the backlog folder the root configuration `text` names, read as 1.53 reads it: the last
 * `backlog_directory` (or `backlogDirectory`) line wins, enclosing quotes are dropped, and
 * backslashes become `/`. A value that is empty, absolute, `.`, or that leaves the folder the CLI
 * runs in is `unresolved`.
 */
export function backlogPointer(text: string): BacklogPointer {
  let value: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    if (key !== "backlog_directory" && key !== "backlogDirectory") continue;
    value = line
      .slice(colon + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "")
      .trim();
  }
  if (value === null) return { kind: "none" };
  if (value === "" || /^(?:[a-zA-Z]:)?[\\/]/.test(value)) return { kind: "unresolved" };
  const folder = normalize(normalize(value).replace(/\\/g, "/")).replace(/\/+$/, "");
  if (folder === "" || folder === "." || folder === ".." || folder.startsWith("../")) {
    return { kind: "unresolved" };
  }
  if (isAbsolute(folder)) return { kind: "unresolved" };
  return { kind: "folder", folder };
}

/**
 * Pure: true when the root configuration `text` names a project (`project_name` or
 * `projectName` with a value), which 1.53 needs to take it as the project's root.
 */
export function hasProjectName(text: string): boolean {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line
      .slice(colon + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    if ((key === "project_name" || key === "projectName") && value !== "") return true;
  }
  return false;
}

/** What dipo found in one Markdown file's front matter. */
interface FrontMatterVerdict {
  /** Why no Backlog CLI call may read the file, or null. */
  readonly refusal: string | null;
  /** True when the front matter names a command for a status change. */
  readonly statusCommand: boolean;
}

/** A YAML double-quoted scalar of `text`. */
function quoted(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Pure: a front matter `block` as Backlog.md 1.53 prepares it before it parses it: an unquoted
 * `due_date` value is quoted (a trailing comment kept), and so is an unquoted `assignee` or
 * `reporter` value, or each item of their `[...]` list that starts with `@`.
 */
export function preparedFrontMatter(block: string): string {
  return block
    .split(/\r?\n/)
    .map((line) => {
      const due = /^(\s*(?:due_date|"due_date"|'due_date')\s*:\s*)(.*)$/.exec(line);
      if (due !== null) {
        const [, head = "", rest = ""] = due;
        const split = /^(.*?)(\s+#.*)?$/.exec(rest);
        const value = (split?.[1] ?? rest).trim();
        const comment = split?.[2] ?? "";
        const empty = /^(?:null|~)$/i.test(value);
        if (value !== "" && !empty && !value.startsWith("'") && !value.startsWith('"')) {
          return `${head}${quoted(value)}${comment}`;
        }
      }
      const person = /^(\s*(?:assignee|reporter):\s*)(.*)$/.exec(line);
      if (person === null) return line;
      const [, head = "", rest = ""] = person;
      const value = rest.trim();
      const list = /^\[(.*)\]\s*(#.*)?$/.exec(value);
      if (list !== null) {
        const items = (list[1] ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
          .map((item) =>
            item.startsWith("'") || item.startsWith('"') || !item.startsWith("@")
              ? item
              : quoted(item),
          );
        return `${head}[${items.join(", ")}]${list[2] === undefined ? "" : ` ${list[2]}`}`;
      }
      const plain =
        value !== "" &&
        !value.startsWith("[") &&
        !value.startsWith("'") &&
        !value.startsWith('"') &&
        !value.startsWith("-");
      return plain ? `${head}${quoted(value)}` : line;
    })
    .join("\n");
}

/**
 * Pure: the front matter of the Markdown `text`, found as Backlog.md finds it (a first line that
 * starts with `---`, up to the next line that starts with `---`), after every leading byte order
 * mark. A file that does not open with `---` has none.
 */
function frontMatterVerdict(text: string): FrontMatterVerdict {
  const body = text.replace(/^\ufeff+/, "");
  if (!body.startsWith("---")) return { refusal: null, statusCommand: false };
  const firstEnd = body.indexOf("\n");
  const first = (firstEnd < 0 ? body : body.slice(0, firstEnd)).replace(/\r$/, "");
  if (first.slice(3).trim() !== "") return { refusal: NOT_PLAIN_YAML, statusCommand: false };
  if (firstEnd < 0) return { refusal: null, statusCommand: false };
  const close = body.indexOf("\n---", firstEnd);
  const block = (close < 0 ? body.slice(firstEnd + 1) : body.slice(firstEnd + 1, close)).replace(
    /\r$/,
    "",
  );
  const named = namesStatusCommand(block);
  const parsed = parseYamlDocument(preparedFrontMatter(block));
  if (!parsed.ok) return { refusal: DOES_NOT_PARSE, statusCommand: named };
  const value = parsed.value;
  const keyed =
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).some((key) => key === "<<" || namesStatusCommand(key));
  return { refusal: null, statusCommand: named || keyed };
}

/**
 * Pure: why no Backlog CLI call may read the Markdown file `text`, or null: its front matter block
 * is not plain YAML (it names a language, or it does not parse).
 */
export function frontMatterRefusal(text: string): string | null {
  return frontMatterVerdict(text).refusal;
}

/**
 * Pure: why the task file `text` stops a status change, or null: its front matter is not plain
 * YAML (`frontMatterRefusal`), or it defines a command for the CLI to run on a status change.
 */
export function taskStatusCommand(text: string): string | null {
  const verdict = frontMatterVerdict(text);
  if (verdict.refusal !== null) return verdict.refusal;
  return verdict.statusCommand ? DEFINES_COMMAND : null;
}

/** The verdict on one file: why no call may read it, whether it names a status command. */
interface FileVerdict {
  readonly refusal: string | null;
  readonly statusCommand: boolean;
  /** A hash of the content the verdict was found on. */
  readonly content: string;
}

interface CachedVerdict {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly verdict: FileVerdict;
}

/**
 * Verdicts by absolute path, each kept with the file's device, inode, size, and change and
 * modification times: any write to the file, or a new file at the path, changes one of them, so
 * the file is read again. At most `max` paths are kept; past that the least recently used goes
 * first, so the paths of short-lived copies leave as they stop being used.
 */
export class VerdictCache {
  readonly #entries = new Map<string, CachedVerdict>();

  constructor(readonly max = 20_000) {}

  get(path: string, stat: Stats): FileVerdict | undefined {
    const entry = this.#entries.get(path);
    if (entry === undefined) return undefined;
    const same =
      entry.dev === stat.dev &&
      entry.ino === stat.ino &&
      entry.size === stat.size &&
      entry.mtimeMs === stat.mtimeMs &&
      entry.ctimeMs === stat.ctimeMs;
    if (!same) return undefined;
    this.#entries.delete(path);
    this.#entries.set(path, entry);
    return entry.verdict;
  }

  set(path: string, stat: Stats, verdict: FileVerdict): void {
    this.#entries.delete(path);
    while (this.#entries.size >= this.max) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
    }
    const { dev, ino, size, mtimeMs, ctimeMs } = stat;
    this.#entries.set(path, { dev, ino, size, mtimeMs, ctimeMs, verdict });
  }

  get size(): number {
    return this.#entries.size;
  }
}

/** The daemon's one cache of Backlog file verdicts. */
const VERDICTS = new VerdictCache();

/**
 * The refusals already told to each `notify`, by key (see `scanBacklogFiles`); at most
 * `NOTICED_MAX` for each, the oldest dropped first.
 */
const NOTICED = new WeakMap<object, Set<string>>();
const NOTICED_MAX = 10_000;

/** Tells `notify` the notice when one of `keys` was not told to it before, and remembers them. */
function tellOnce(
  notify: ((notice: BacklogNotice) => void) | undefined,
  keys: readonly string[],
  notice: () => BacklogNotice,
): void {
  if (notify === undefined) return;
  let told = NOTICED.get(notify);
  if (told === undefined) {
    told = new Set();
    NOTICED.set(notify, told);
  }
  const unseen = keys.filter((key) => !told.has(key));
  for (const key of unseen) {
    while (told.size >= NOTICED_MAX) {
      const oldest = told.values().next();
      if (oldest.done === true) break;
      told.delete(oldest.value);
    }
    told.add(key);
  }
  if (unseen.length > 0) notify(notice());
}

/** One Backlog file a call may not run with, with why (a fixed text). */
export interface BacklogFileHit {
  /** Relative to the folder the call runs in. */
  readonly path: string;
  readonly reason: string;
}

/** What a scan of the Backlog files of one folder found. */
export interface BacklogScan {
  /** Files no call may run with. */
  readonly refused: readonly BacklogFileHit[];
  /** Configuration and task files that define a command for a status change. */
  readonly statusCommands: readonly BacklogFileHit[];
  /** The notice key of each hit, by the hit: its path, its reason and its content. */
  readonly keys: ReadonlyMap<BacklogFileHit, string>;
  /** The paths whose verdict was found in this scan rather than kept from an earlier one. */
  readonly fresh: ReadonlySet<string>;
  /** How many files the scan read (verdicts not kept). */
  readonly read: number;
  /** How many files the scan looked at. */
  readonly files: number;
}

/** `stat` following a link; undefined when there is no file, or a dangling link. */
function statOf(path: string): Stats | undefined | "unreadable" {
  try {
    return statSync(path, { throwIfNoEntry: false });
  } catch {
    return "unreadable";
  }
}

function identityOf(stat: Stats): string {
  return `${stat.dev}:${stat.ino}`;
}

/**
 * Scans the Backlog files of `cwd` (see the section above). Configuration files come first, then
 * the Markdown files of the task folders, then the rest of each backlog folder by path. `cache`
 * keeps the verdicts between scans. With `project: false` (a call that reads no project, such as
 * `--version`), a folder without a project configuration is not refused.
 */
export function scanBacklogFiles(
  cwd: string,
  cache: VerdictCache = VERDICTS,
  options: { readonly project?: boolean } = {},
): BacklogScan {
  const refused: BacklogFileHit[] = [];
  const statusCommands: BacklogFileHit[] = [];
  const keys = new Map<BacklogFileHit, string>();
  const fresh = new Set<string>();
  let read = 0;
  let files = 0;

  const refuse = (path: string, reason: string, content = ""): void => {
    const hit = { path, reason };
    refused.push(hit);
    keys.set(hit, `${path}\u0000${reason}\u0000${content}`);
  };

  /** The verdict on the plain file at `path`, read or kept; null when it cannot be read. */
  const verdictOf = (
    path: string,
    stat: Stats,
    judge: (text: string) => Omit<FileVerdict, "content">,
  ): FileVerdict | null => {
    const absolute = join(cwd, path);
    const kept = cache.get(absolute, stat);
    if (kept !== undefined) return kept;
    let text: string;
    try {
      text = readFileSync(absolute, "utf8");
    } catch {
      return null;
    }
    read++;
    const verdict = {
      ...judge(text),
      content: createHash("sha256").update(text).digest("base64url"),
    };
    cache.set(absolute, stat, verdict);
    fresh.add(path);
    return verdict;
  };

  const check = (path: string, kind: "config" | "markdown", stat: Stats, task: boolean): void => {
    files++;
    if (!stat.isFile()) return refuse(path, "is not a plain file dipo can check", String(stat.ino));
    if (stat.size > BACKLOG_CHECK_MAX) {
      return refuse(path, "is too large for dipo to check", String(stat.size));
    }
    const verdict = verdictOf(path, stat, (text) =>
      kind === "config"
        ? { refusal: null, statusCommand: configStatusCommand(text) !== null }
        : frontMatterVerdict(text),
    );
    if (verdict === null) return refuse(path, "cannot be read, so dipo cannot check it");
    if (verdict.refusal !== null) refuse(path, verdict.refusal, verdict.content);
    if (verdict.statusCommand && (kind === "config" || task)) {
      const hit = { path, reason: DEFINES_COMMAND };
      statusCommands.push(hit);
      keys.set(hit, `${path}\u0000${DEFINES_COMMAND}\u0000${verdict.content}`);
    }
  };

  /** Checks the configuration file at `path` when there is one. */
  const checkConfig = (path: string): Stats | undefined => {
    const stat = statOf(join(cwd, path));
    if (stat === undefined) return undefined;
    if (stat === "unreadable") {
      refuse(path, "cannot be read, so dipo cannot check it");
      return undefined;
    }
    if (stat.isDirectory()) return undefined;
    check(path, "config", stat, false);
    return stat;
  };

  // The root configuration, and the folder it names.
  const folders = ["backlog", ".backlog"];
  let rooted = false;
  const rootStat = checkConfig(ROOT_CONFIG);
  if (rootStat !== undefined && rootStat.isFile() && rootStat.size <= BACKLOG_CHECK_MAX) {
    let pointer: BacklogPointer = { kind: "unresolved" };
    try {
      const rootText = readFileSync(join(cwd, ROOT_CONFIG), "utf8");
      pointer = backlogPointer(rootText);
      rooted = hasProjectName(rootText);
    } catch {
      // An unreadable root configuration is refused as unresolved.
    }
    if (pointer.kind === "unresolved") refuse(ROOT_CONFIG, UNRESOLVED_FOLDER);
    if (pointer.kind === "folder" && !folders.includes(pointer.folder)) {
      folders.push(pointer.folder);
    }
  }
  for (const folder of folders) {
    for (const name of FOLDER_CONFIGS) {
      const stat = checkConfig(`${folder}/${name}`);
      if (stat?.isFile() === true && (folder === "backlog" || folder === ".backlog")) rooted = true;
    }
  }
  // Without a project configuration here, the CLI looks for one in the folders above, which dipo
  // does not check. A folder that does not exist is left alone: the CLI cannot start in it.
  const here = statOf(cwd);
  if (options.project !== false && !rooted && here !== undefined) refuse(".", NO_PROJECT_CONFIG);

  // The task folders by their identity: the folder the CLI opens under each name.
  const taskFolders = new Set<string>();
  const taskPaths: string[] = [];
  for (const folder of folders) {
    for (const sub of TASK_FOLDERS) {
      const stat = statOf(join(cwd, folder, sub));
      if (stat === undefined || stat === "unreadable" || !stat.isDirectory()) continue;
      taskFolders.add(identityOf(stat));
      taskPaths.push(`${folder}/${sub}`);
    }
  }

  const seen = new Set<string>();
  const walk = (folder: string, depth: number): void => {
    const absolute = join(cwd, folder);
    const self = statOf(absolute);
    if (self === undefined || self === "unreadable" || !self.isDirectory()) return;
    const identity = identityOf(self);
    if (seen.has(identity)) return;
    seen.add(identity);
    if (depth > BACKLOG_CHECK_DEPTH) return refuse(folder, "lies too deep for dipo to check");
    const task = taskFolders.has(identity);
    let entries: Dirent[];
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch {
      return refuse(folder, "cannot be read, so dipo cannot check it");
    }
    for (const entry of entries.toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = `${folder}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }
      const markdown = entry.name.toLowerCase().endsWith(".md");
      if (!markdown && !entry.isSymbolicLink()) continue;
      const stat = statOf(join(cwd, path));
      if (stat === undefined) continue;
      if (stat === "unreadable") {
        refuse(path, "cannot be read, so dipo cannot check it");
      } else if (stat.isDirectory()) {
        walk(path, depth + 1);
      } else if (markdown) {
        check(path, "markdown", stat, task);
      }
    }
  };
  for (const path of taskPaths) walk(path, 1);
  for (const folder of folders) walk(folder, 0);
  return { refused, statusCommands, keys, fresh, read, files };
}

/** The notice keys of `hits` in `scan`, each with `extra` (the story of a status change). */
function noticeKeys(scan: BacklogScan, hits: readonly BacklogFileHit[], extra = ""): string[] {
  return hits.map((hit) => `${scan.keys.get(hit) ?? hit.path}\u0000${extra}`);
}

/**
 * The Backlog files in `cwd` that stop a status change there, in a fixed order: the files no call
 * may run with, then those that define a command for the change.
 */
export function statusCommandFiles(cwd: string, cache?: VerdictCache): BacklogFileHit[] {
  const scan = scanBacklogFiles(cwd, cache);
  return [...scan.refused, ...scan.statusCommands];
}

// ---- the story's task file (0021 section 14) ---------------------------------------------------

/** The folder that holds the Backlog task files, relative to the repository root. */
export const TASKS_DIR = "backlog/tasks";

/** The `GitError` code when dipo cannot make its copy of a story's backlog or commit from it. */
export const BACKLOG_FOLDER_ERROR = "story.backlogFolder";

/**
 * The `GitError` code when the story's task file holds a front matter field dipo does not know;
 * the operation is refused, and a story in a run parks `scope-violation`.
 */
export const TASK_FIELD_ERROR = "story.unknownTaskField";

/** True when `name` is the task file of `id`: `<id> - <title>.md`, any case. */
export function isTaskFileOf(name: string, id: string): boolean {
  return name.toLowerCase().startsWith(`${id.toLowerCase()} - `) && name.endsWith(".md");
}

/**
 * Pure: why `path` (repo-relative, as git lists it) is not a task file path dipo accepts, or null:
 * its folder must be exactly `backlog/tasks`, with no `.` or `..` segment and a plain file name.
 */
export function taskFilePathRefusal(path: string): string | null {
  const segments = path.split("/");
  const name = segments.at(-1) ?? "";
  const plain =
    segments.length === 3 &&
    segments.slice(0, 2).join("/") === TASKS_DIR &&
    name !== "" &&
    name !== "." &&
    name !== ".." &&
    !name.includes("\\") &&
    !hasForbiddenCharacter(name, "");
  return plain ? null : `${JSON.stringify(path)} is not a plain file directly in ${TASKS_DIR}`;
}

/**
 * The front matter fields of a Backlog.md task that dipo knows (1.53). A task file holding any
 * other field is refused before the CLI reads it (0021 section 14).
 */
export const KNOWN_TASK_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "title",
  "status",
  "assignee",
  "reporter",
  "created_date",
  "updated_date",
  "due_date",
  "labels",
  "milestone",
  "dependencies",
  "references",
  "documentation",
  "modified_files",
  "parent_task_id",
  "subtasks",
  "priority",
  "type",
  "project",
  "ordinal",
]);

/** How Backlog.md 1.53 finds a task file's front matter block (without the carriage returns). */
const FRONT_MATTER = /^---\n([\s\S]*?)\n---/;

/**
 * True when `text` holds a control character not in `allowed`, or a line or paragraph separator.
 */
function hasForbiddenCharacter(text: string, allowed: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 && !allowed.includes(char)) return true;
    if ((code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

/** A top-level field line: a plain lower-case name, a colon, then nothing or a space and a value. */
const FIELD_LINE = /^([a-z_]+):(?:$| (.*)$)/;

/**
 * True when a value, list item or key on `line` starts with an anchor, an alias or a tag. Quoted
 * text and text after the first token are not looked at.
 */
function startsWithNodeProperty(line: string): boolean {
  let rest = line.trimStart();
  while (rest.startsWith("- ")) rest = rest.slice(2).trimStart();
  const keyed = /^[^\s'"[{&*!][^:]*:\s+(.*)$/.exec(rest);
  if (keyed !== null) rest = keyed[1] ?? "";
  return /^[&*!]/.test(rest);
}

/**
 * The strict shape (layer one of `taskFieldRefusal`): why the text may not reach the CLI, or the
 * front matter block and its top-level field names in order.
 */
function strictShape(
  text: string,
): { readonly refusal: string } | { readonly block: string; readonly names: readonly string[] } {
  if (text.includes("\r")) return { refusal: "it holds a carriage return" };
  if (text.includes("\ufeff")) return { refusal: "it holds a byte order mark" };
  if (hasForbiddenCharacter(text, "\n\t")) {
    return { refusal: "it holds a control character or a line or paragraph separator" };
  }
  const lines = text.split("\n");
  if (lines[0] !== "---") return { refusal: "it does not open with a front matter block" };
  const end = lines.findIndex((line, i) => i > 0 && line.startsWith("---"));
  if (end < 0 || lines[end] !== "---") {
    return { refusal: "its front matter block does not close on a plain `---` line" };
  }
  const names: string[] = [];
  const unknown: string[] = [];
  let field: string | null = null;
  for (const line of lines.slice(1, end)) {
    if (line.trim() === "") continue;
    if (line.startsWith("\t")) return { refusal: "its front matter indents with a tab" };
    if (line.startsWith("...")) return { refusal: "its front matter holds a document marker" };
    if (startsWithNodeProperty(line)) {
      return { refusal: "its front matter holds an anchor, an alias or a tag" };
    }
    if (line.startsWith(" ")) {
      if (field === null) {
        return { refusal: "its front matter holds an indented line before any field it knows" };
      }
      continue;
    }
    const match = FIELD_LINE.exec(line);
    const name = match?.[1];
    if (name === undefined || !KNOWN_TASK_FIELDS.has(name)) {
      unknown.push(JSON.stringify(line.slice(0, 40)));
      field = null;
      continue;
    }
    if (names.includes(name)) return { refusal: `its front matter holds \`${name}\` twice` };
    if ((match?.[2] ?? "").trimStart().startsWith("{")) {
      return { refusal: `its front matter holds a flow mapping at \`${name}\`` };
    }
    names.push(name);
    field = name;
  }
  if (unknown.length > 0) {
    return { refusal: `its front matter holds fields dipo does not know: ${unknown.join(", ")}` };
  }
  return { block: lines.slice(1, end).join("\n"), names };
}

/**
 * Pure: why the task file `text` may not reach the Backlog CLI, or null when it may. Two layers
 * must agree, and anything either cannot account for is refused:
 *
 * 1. A strict shape: no carriage return, byte order mark, control character (other than LF and
 *    tab) or line or paragraph separator; a front matter block that opens on the first line and
 *    closes on a plain `---` line; every top-level line a plain `name:` field in
 *    `KNOWN_TASK_FIELDS`, each once, none holding a flow mapping; no indented line before the first
 *    field; no document marker, anchor, alias or tag.
 * 2. A parse: the block found the way Backlog.md finds it is parsed as YAML, and must be a plain
 *    mapping whose keys are exactly the names the strict shape found.
 */
export function taskFieldRefusal(text: string): string | null {
  const shape = strictShape(text);
  if ("refusal" in shape) return shape.refusal;
  const found = FRONT_MATTER.exec(text)?.[1];
  if (found !== shape.block) {
    return "its front matter block is not the one the Backlog CLI would read";
  }
  const result = parseYamlDocument(found);
  if (!result.ok) return `its front matter does not parse: ${result.message}`;
  const parsed = result.value;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    (Object.getPrototypeOf(parsed) !== Object.prototype && Object.getPrototypeOf(parsed) !== null)
  ) {
    return "its front matter is not a plain mapping";
  }
  const keys = Object.keys(parsed);
  const agree =
    keys.length === shape.names.length &&
    keys.every((key) => KNOWN_TASK_FIELDS.has(key) && shape.names.includes(key));
  return agree ? null : "its front matter parses to fields other than those dipo read in it";
}
