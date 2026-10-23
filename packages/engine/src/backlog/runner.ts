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
// Before a call that changes a story's status (`task edit` or `draft edit` with `--status`), in
// whatever folder it runs (dipo's own copy, a checkout of the base, the backlog lane's worktree),
// dipo reads the Backlog configuration and the task files the call runs with
// (`statusCommandFiles`, DIPO-312). When one of them defines a command for the CLI to run on a
// status change, or cannot be checked, the call is refused before spawning
// (`BacklogStatusCommandError`) and the CLI's `notify` gets an `engine.notice` naming the story
// and the file.

import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

import type { Spawn } from "@dipsaus-orchestrator/contract";

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

/** One file that stops a status change, with why (a fixed text). */
export interface StatusCommandFile {
  /** Relative to the folder the call runs in. */
  readonly path: string;
  readonly reason: string;
}

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
 * spawning a refused command (`BacklogStatusCommandError` for a status change the folder's
 * Backlog files would attach a command to, with a notice to `cli.notify`) and
 * `BacklogCommandError` when the CLI fails.
 */
export async function runBacklog(
  cli: BacklogCli,
  cwd: string,
  args: readonly string[],
): Promise<BacklogOutput> {
  const reason = refusal(args);
  if (reason !== null) throw new BacklogRefusedError(args, reason);
  const story = statusChangeOf(args);
  if (story !== null) {
    const files = statusCommandFiles(cwd);
    if (files.length > 0) {
      const refused = new BacklogStatusCommandError(args, story, files);
      cli.notify?.(refused.notice());
      throw refused;
    }
  }
  const command: [string, ...string[]] = [...(cli.command ?? ["backlog"]), ...args];
  let child;
  try {
    child = cli.spawn({ cmd: command, cwd, env: backlogEnv(cli.env ?? process.env) });
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

// ---- commands on a status change (DIPO-312, 0021 section 14) -----------------------------------
//
// Backlog.md 1.53 runs a shell command after a task's status changes when the task's front matter
// sets `onStatusChange` or the project configuration sets `onStatusChange` (or
// `on_status_change`). dipo never lets it: before a status change it reads, in the folder the call
// runs in, every place 1.53 takes its configuration from (`backlog.config.yml`, `config.yml` and
// `config.yaml` in `backlog/`, in `.backlog/` and in the folder `backlog.config.yml` names) and
// every task file the CLI loads a task from (`tasks/` and `completed/` of each of those folders).
// It refuses the call when one of them:
//
// - names `onStatusChange` or `on_status_change`, compared without case after a compatibility
//   fold (in a configuration file anywhere; in a task file within its front matter, as text and
//   as a parsed key, a merge key counting as one);
// - is a task file whose front matter names a language (`---js`), or does not parse as YAML;
// - is not a plain file dipo can read whole (a special file, over `STATUS_CHECK_MAX`).
//
// A missing file defines nothing. The check runs on every such call, whatever the folder.

/** The most bytes of one Backlog file the status check reads; a larger file is refused. */
export const STATUS_CHECK_MAX = 1024 * 1024;

/** The configuration files of Backlog.md 1.53, relative to the folder the CLI runs in. */
const CONFIG_PLACES: readonly string[] = [
  "backlog.config.yml",
  "backlog/config.yml",
  "backlog/config.yaml",
  ".backlog/config.yml",
  ".backlog/config.yaml",
];

/** The folders 1.53 loads a task from, inside a backlog folder. */
const TASK_FOLDERS: readonly string[] = ["tasks", "completed"];

const STATUS_COMMAND_KEYS: readonly string[] = ["onstatuschange", "on_status_change"];

const DEFINES_COMMAND = "defines a command for the Backlog CLI to run on a status change";

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

/**
 * Pure: why the task file `text` stops a status change, or null. Its front matter is found as
 * Backlog.md finds it (a first line `---`, up to the next line that starts with `---`), after a
 * byte order mark; a file that does not open with `---` has none.
 */
export function taskStatusCommand(text: string): string | null {
  const body = text.startsWith("﻿") ? text.slice(1) : text;
  if (!body.startsWith("---")) return null;
  const firstEnd = body.indexOf("\n");
  const first = (firstEnd < 0 ? body : body.slice(0, firstEnd)).replace(/\r$/, "");
  if (first.slice(3).trim() !== "") {
    return "opens a front matter block in a language other than YAML, which dipo does not let the Backlog CLI read";
  }
  if (firstEnd < 0) return null;
  const close = body.indexOf("\n---", firstEnd);
  const block = (close < 0 ? body.slice(firstEnd + 1) : body.slice(firstEnd + 1, close)).replace(
    /\r$/,
    "",
  );
  if (namesStatusCommand(block)) return DEFINES_COMMAND;
  const parsed = parseYamlDocument(block.replaceAll("\r\n", "\n"));
  if (!parsed.ok) return "holds a front matter block that does not parse, so dipo cannot check it";
  const value = parsed.value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    if (Object.keys(value).some((key) => key === "<<" || namesStatusCommand(key))) {
      return DEFINES_COMMAND;
    }
  }
  return null;
}

type BacklogFile =
  | { readonly kind: "absent" }
  | { readonly kind: "folder" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "refused"; readonly reason: string };

/** Reads `path` as the CLI would, following a link; no file, or a dangling link, is absent. */
function readBacklogFile(path: string): BacklogFile {
  try {
    if (lstatSync(path, { throwIfNoEntry: false }) === undefined) return { kind: "absent" };
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat === undefined) return { kind: "absent" };
    if (stat.isDirectory()) return { kind: "folder" };
    if (!stat.isFile()) return { kind: "refused", reason: "is not a plain file dipo can check" };
    if (stat.size > STATUS_CHECK_MAX) {
      return { kind: "refused", reason: "is too large for dipo to check" };
    }
    return { kind: "text", text: readFileSync(path, "utf8") };
  } catch {
    return { kind: "refused", reason: "cannot be read, so dipo cannot check it" };
  }
}

/**
 * The project-relative backlog folder `backlog.config.yml` names (`backlog_directory`), read line by
 * line as 1.53 reads it, or null.
 */
function rootBacklogFolder(text: string): string | null {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const colon = line.indexOf(":");
    if (line.startsWith("#") || colon < 0) continue;
    const key = line.slice(0, colon).trim();
    if (key !== "backlog_directory" && key !== "backlogDirectory") continue;
    const value = line
      .slice(colon + 1)
      .trim()
      .replace(/['"]/g, "");
    if (value === "" || isAbsolute(value) || value.includes("\\")) return null;
    const folder = normalize(value).replace(/\/+$/, "");
    if (folder === "." || folder === ".." || folder.startsWith("../")) return null;
    return folder;
  }
  return null;
}

/** Why the file at `path` stops a status change, or null; `check` reads its text. */
function fileRefusal(path: string, check: (text: string) => string | null): string | null {
  const read = readBacklogFile(path);
  if (read.kind === "absent" || read.kind === "folder") return null;
  return read.kind === "refused" ? read.reason : check(read.text);
}

/**
 * The Backlog files in `cwd` that stop a status change there (see the section above), in a fixed
 * order: the configuration files, then the task files of each backlog folder by name.
 */
export function statusCommandFiles(cwd: string): StatusCommandFile[] {
  const found: StatusCommandFile[] = [];
  const folders = ["backlog", ".backlog"];
  const configs = [...CONFIG_PLACES];
  const root = readBacklogFile(join(cwd, "backlog.config.yml"));
  const named = root.kind === "text" ? rootBacklogFolder(root.text) : null;
  if (named !== null && !folders.includes(named)) {
    folders.push(named);
    configs.push(`${named}/config.yml`, `${named}/config.yaml`);
  }
  for (const path of configs) {
    const reason = fileRefusal(join(cwd, path), configStatusCommand);
    if (reason !== null) found.push({ path, reason });
  }
  for (const folder of folders) {
    for (const sub of TASK_FOLDERS) {
      let names: string[];
      try {
        names = readdirSync(join(cwd, folder, sub));
      } catch {
        continue;
      }
      for (const name of names.toSorted()) {
        if (!name.toLowerCase().endsWith(".md")) continue;
        const path = `${folder}/${sub}/${name}`;
        const reason = fileRefusal(join(cwd, path), taskStatusCommand);
        if (reason !== null) found.push({ path, reason });
      }
    }
  }
  return found;
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
