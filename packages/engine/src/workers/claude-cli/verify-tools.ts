// The verify tools check (DIPO-173): the programs the office's verify runs must be able to start
// in the worker sandbox. Verify runs `bun run verify`, which runs oxfmt, oxlint and tsc from
// `node_modules/.bin`; those start with `#!/usr/bin/env node`, and a node under `~/.nvm` is outside
// the default read paths, so the worker would fail `env: node: No such file or directory` and
// spend its turns finding out. The check follows `bun`, `npm`, `pnpm` and `yarn` script calls
// (`run <script>`, and `bun`, `pnpm` and `yarn <script>`) through the root package.json scripts,
// takes the bin `npx` names, takes the first word of each other command, reads the interpreter
// line of each program found in `node_modules/.bin` and resolves the interpreter on the worker's
// PATH.
//
// A refusal is a `PlanError` like the npm token check's: it is this office's read paths, so it
// refuses this run and holds no adapter for other offices. Reads files only; never throws for a
// file it cannot read (the worker cannot read it either).

import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { posix } from "node:path";

import { expandHome, isAtOrUnder } from "../../sandbox/policy";
import type { VerifyCommands } from "../port";
import { PlanError } from "../types";
import type { ClaudeLaunchContext } from "./plan";

/** One interpreter the worker sandbox cannot reach, with the verify programs that need it. */
export interface VerifyToolFailure {
  /** The programs of `node_modules/.bin` that verify runs and that start with it. */
  readonly programs: readonly string[];
  /** The interpreter as the shebang names it: `node`, or an absolute path. */
  readonly interpreter: string;
  /** Where the daemon's own PATH finds it; null when it finds nothing. */
  readonly foundAt: string | null;
}

const RUNNERS = new Set(["bun", "npm", "pnpm", "yarn"]);
/** The runners that also take a bare script name: `bun <script>` runs one like `run` does. */
const SHORTHAND = new Set(["bun", "pnpm", "yarn"]);
/** Commands bun runs itself, before a script of the same name (`bun --help` of Bun 1.4.2). */
const BUN_COMMANDS = new Set([
  "run",
  "test",
  "i",
  "a",
  "rm",
  "c",
  "dedupe",
  "prune",
  "x",
  "repl",
  "exec",
  "install",
  "add",
  "remove",
  "update",
  "outdated",
  "link",
  "unlink",
  "publish",
  "patch",
  "pm",
  "info",
  "why",
  "audit",
  "init",
  "create",
  "upgrade",
  "build",
  "completions",
  "getcompletes",
  "help",
  "feedback",
]);
/** Commands pnpm runs itself, before a root script of the same name. `test` and `start` are not here: pnpm runs those scripts. */
const PNPM_COMMANDS = new Set([
  "add",
  "audit",
  "create",
  "dlx",
  "exec",
  "i",
  "init",
  "install",
  "link",
  "outdated",
  "pack",
  "patch",
  "publish",
  "rebuild",
  "remove",
  "rm",
  "unlink",
  "up",
  "update",
  "why",
]);
/** Commands yarn runs itself, before a root script of the same name. `test` and `start` are not here: yarn runs those scripts. */
const YARN_COMMANDS = new Set([
  "add",
  "audit",
  "cache",
  "config",
  "create",
  "dlx",
  "exec",
  "info",
  "init",
  "install",
  "link",
  "outdated",
  "pack",
  "publish",
  "remove",
  "unlink",
  "up",
  "upgrade",
  "why",
]);
/** The commands each runner runs itself, which a root script of the same name does not shadow. */
const BUILT_IN_COMMANDS = new Map<string, Set<string>>([
  ["bun", BUN_COMMANDS],
  ["pnpm", PNPM_COMMANDS],
  ["yarn", YARN_COMMANDS],
]);
const SEGMENT = /&&|\|\||;|\||\n/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function rootScripts(root: string): Promise<Record<string, string>> {
  const text = await readOptional(posix.join(root, "package.json"));
  if (text === null) return {};
  try {
    const scripts = (JSON.parse(text) as { scripts?: unknown }).scripts;
    if (typeof scripts !== "object" || scripts === null) return {};
    return Object.fromEntries(
      Object.entries(scripts).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

/** The first word that is not a flag. */
function operand(words: readonly string[]): string | undefined {
  return words.find((word) => !word.startsWith("-"));
}

function isBuiltIn(runner: string, word: string): boolean {
  return BUILT_IN_COMMANDS.get(runner)?.has(word) ?? false;
}

/**
 * The root script a command runs, or undefined when it runs none: `bun`, `npm`, `pnpm` and `yarn`
 * `run <script>`, and `bun`, `pnpm` and `yarn <script>`, unless the runner runs that word as its
 * own command.
 */
function scriptOf(words: readonly string[], scripts: Record<string, string>): string | undefined {
  const [runner, verb, ...rest] = words;
  if (runner === undefined || !RUNNERS.has(runner)) return undefined;
  const name =
    verb === "run" ? operand(rest) : SHORTHAND.has(runner) ? operand(words.slice(1)) : undefined;
  if (name === undefined || !Object.hasOwn(scripts, name)) return undefined;
  return verb !== "run" && isBuiltIn(runner, name) ? undefined : name;
}

/**
 * The bin `npx` starts: the first word that is not a flag, past the value of `-p` and `--package`
 * (the package it installs, not the bin).
 */
function npxBin(args: readonly string[]): string | undefined {
  for (let at = 0; at < args.length; at++) {
    const word = args[at] ?? "";
    if (word === "-p" || word === "--package") at++;
    else if (!word.startsWith("-")) return word;
  }
  return undefined;
}

/**
 * The program a command starts when it runs no root script: the bin `npx` names, the word a
 * `bun`, `pnpm` or `yarn` shorthand names (checked against `node_modules/.bin` like any program),
 * else the runner itself, which is also what a runner's own command starts. A `run` call that
 * names no script starts nothing.
 */
function programOf(words: readonly string[]): string | undefined {
  const [runner, verb] = words;
  if (runner === undefined) return undefined;
  if (runner === "npx") return npxBin(words.slice(1)) ?? runner;
  if (RUNNERS.has(runner) && verb === "run") return undefined;
  if (!SHORTHAND.has(runner)) return runner;
  const word = operand(words.slice(1));
  return word === undefined || isBuiltIn(runner, word) ? runner : word;
}

/** The first word of every command in a script body, in order. */
function commandsOf(body: string): string[][] {
  return body
    .split(SEGMENT)
    .map((part) => part.trim().split(/\s+/).filter(Boolean))
    .map((words) => {
      const at = words.findIndex((word) => !ASSIGNMENT.test(word));
      return at < 0 ? [] : words.slice(at);
    })
    .filter((words) => words.length > 0);
}

/**
 * The first words of the commands verify runs, following the script calls of `bun`, `npm`, `pnpm`
 * and `yarn` through the root scripts (each script once), and the bins `npx` names.
 */
export async function verifyPrograms(root: string, verify: VerifyCommands): Promise<string[]> {
  const scripts = await rootScripts(posix.join(root, verify.cwd));
  const seen = new Set<string>();
  const programs: string[] = [];
  const visit = (words: readonly string[]): void => {
    const script = scriptOf(words, scripts);
    if (script === undefined) {
      const program = programOf(words);
      if (program !== undefined && !programs.includes(program)) programs.push(program);
      return;
    }
    if (seen.has(script)) return;
    seen.add(script);
    for (const command of commandsOf(scripts[script] ?? "")) visit(command);
  };
  for (const command of verify.commands) visit(command);
  return programs;
}

/** The interpreter of a script's `#!` line: `env`'s program, or the absolute path; else null. */
export function shebangInterpreter(text: string): string | null {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  if (!first.startsWith("#!")) return null;
  const words = first.slice(2).trim().split(/\s+/).filter(Boolean);
  const [program, ...args] = words;
  if (program === undefined) return null;
  if (posix.basename(program) !== "env") return program;
  return args.find((arg) => !arg.startsWith("-") && !ASSIGNMENT.test(arg)) ?? null;
}

async function executable(file: string): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false;
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveOn(name: string, dirs: readonly string[]): Promise<string | null> {
  for (const dir of dirs) {
    const file = posix.join(dir, name);
    if (await executable(file)) return file;
  }
  return null;
}

/** The path with symlinks resolved, or the path itself when it does not resolve. */
async function realOf(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch {
    return file;
  }
}

/**
 * The interpreters the verify programs need that the worker cannot start. `path` is the daemon's
 * PATH, which the worker's PATH is planned from; an entry under `home` outside `readable` is one
 * the worker sandbox cannot read, so it does not count. As `detectSafeChain` does, a PATH entry
 * and an interpreter are judged on their realpath too: a readable directory's `node` that links
 * into an unread one cannot start. Reads files; never throws.
 */
export async function findVerifyToolFailures(input: {
  readonly root: string;
  readonly verify: VerifyCommands;
  readonly home: string;
  readonly path: string;
  /** Absolute paths the worker sandbox can read inside the home directory. */
  readonly readable: readonly string[];
}): Promise<VerifyToolFailure[]> {
  // A realpath may name the home directory and the read paths by their own realpaths.
  const realHome = await realOf(input.home);
  const homes = [input.home, realHome];
  const roots = [...input.readable, ...(await Promise.all(input.readable.map(realOf)))];
  const unreadable = (file: string): boolean =>
    homes.some((home) => isAtOrUnder(file, home)) && !roots.some((root) => isAtOrUnder(file, root));
  const reachable = async (file: string): Promise<boolean> =>
    !unreadable(file) && !unreadable(await realOf(file));
  /** The realpath of a file the daemon finds, written below the home directory as it is named. */
  const shown = async (file: string): Promise<string> => {
    const real = await realOf(file);
    return realHome !== input.home && isAtOrUnder(real, realHome)
      ? `${input.home}${real.slice(realHome.length)}`
      : real;
  };
  const dirs = input.path.split(":").filter((entry) => entry.startsWith("/"));
  const planned: string[] = [];
  for (const dir of dirs) if (await reachable(dir)) planned.push(dir);

  const byInterpreter = new Map<string, string[]>();
  for (const program of await verifyPrograms(input.root, input.verify)) {
    const text = await readOptional(posix.join(input.root, "node_modules", ".bin", program));
    const interpreter = text === null ? null : shebangInterpreter(text);
    if (interpreter === null) continue;
    byInterpreter.set(interpreter, [...(byInterpreter.get(interpreter) ?? []), program]);
  }

  const failures: VerifyToolFailure[] = [];
  for (const [interpreter, programs] of byInterpreter) {
    if (interpreter.startsWith("/")) {
      const found = await executable(interpreter);
      if (!found || !(await reachable(interpreter))) {
        failures.push({ programs, interpreter, foundAt: found ? await shown(interpreter) : null });
      }
      continue;
    }
    // The worker's PATH starts the first one it finds, which must be readable through its links.
    const first = await resolveOn(interpreter, planned);
    if (first !== null && (await reachable(first))) continue;
    const found = await resolveOn(interpreter, dirs);
    failures.push({ programs, interpreter, foundAt: found === null ? null : await shown(found) });
  }
  return failures;
}

/** The refusal text for the failures: one sentence per interpreter, naming the key that fixes it. */
export function verifyToolsRefusal(failures: readonly VerifyToolFailure[], home: string): string {
  const tilde = (path: string): string =>
    isAtOrUnder(path, home) ? `~${path.slice(home.length)}` : path;
  return failures
    .map((failure) => {
      const programs = failure.programs.join(", ");
      const where =
        failure.foundAt === null
          ? `the daemon's PATH does not find ${failure.interpreter} either`
          : `the daemon's PATH finds ${failure.interpreter} at ${failure.foundAt}, which the worker sandbox cannot read`;
      const dir =
        failure.foundAt === null
          ? "the directory of its install"
          : tilde(
              posix.basename(posix.dirname(failure.foundAt)) === "bin"
                ? posix.dirname(posix.dirname(failure.foundAt))
                : posix.dirname(failure.foundAt),
            );
      return `verify runs ${programs} (node_modules/.bin), which needs ${failure.interpreter} (#! line), but ${failure.interpreter} does not resolve on the worker's PATH: ${where}. Add ${dir} to sandbox.toolchainReadPaths in .dipo/office.local.yaml`;
    })
    .join("; ");
}

/**
 * Refuses with a `PlanError` when a program the office's verify runs needs an interpreter the
 * worker sandbox cannot reach. `root` is the checkout whose `node_modules` holds the programs.
 */
export async function checkVerifyTools(
  ctx: ClaudeLaunchContext,
  root: string,
  verify: VerifyCommands,
): Promise<void> {
  const readable = [
    ...[...ctx.sandbox.toolchainReadPaths, ...ctx.sandbox.allowRead].map((entry) =>
      posix.normalize(expandHome(entry, ctx.home)),
    ),
    root,
    ctx.mainCheckout,
  ];
  const failures = await findVerifyToolFailures({
    root,
    verify,
    home: ctx.home,
    path: ctx.env["PATH"] ?? "",
    readable,
  });
  if (failures.length > 0) throw new PlanError(verifyToolsRefusal(failures, ctx.home));
}
