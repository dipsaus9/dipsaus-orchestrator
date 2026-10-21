// The gh check of `dipo hook PreToolUse --bash` (DIPO-195; 0014 amendment of 2026-10-20, section 3):
// the engine handles the code host, so a worker runs gh only to read gh's own help and version.
// Allowed: `gh --version`, `gh help` followed by subcommand words, and `gh` followed by subcommand
// words and then `--help` as the last argument. Every other simple command whose program is gh is
// refused. Pure, like temp-guard: it splits the command text the same way and looks at the words.
// A wrapper's command, a shell's script (`-c`, a here-string or its stdin) and a function body are
// checked as commands of their own (DIPO-242).

import {
  ansiCText,
  envSplitTexts,
  simpleCommands,
  SUDO_LONG_VALUE_OPTIONS,
  SUDO_VALUE_OPTIONS,
  wrappedCommandAt,
  wrapperOptions,
  XARGS_LONG_VALUE_OPTIONS,
  XARGS_VALUE_OPTIONS,
} from "./temp-guard";

/** A subcommand word: a letter, then letters, digits or dashes, so no flag is one. */
const SUBCOMMAND = /^[A-Za-z][A-Za-z0-9-]*$/;
/** Shell keywords that open a command list: `then gh pr view` runs gh too. */
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until"]);
const SHELLS = new Set([
  "sh",
  "bash",
  "rbash",
  "zsh",
  "dash",
  "ash",
  "ksh",
  "mksh",
  "yash",
  "posh",
  "fish",
  "csh",
  "tcsh",
]);
/** The options of a wrapper: the short and long ones that take a value, and the operands before its command. */
interface WrapperOptions {
  short: ReadonlySet<string>;
  long: ReadonlySet<string>;
  operands: number;
}
const NO_OPTIONS: WrapperOptions = { short: new Set(), long: new Set(), operands: 0 };
/**
 * Programs that run another command after their options; a gh call behind one is checked. The
 * Claude CLI strips timeout and stdbuf before it matches a Bash rule, so the `Bash(gh *)` deny rule
 * this check replaces caught `timeout 10 gh ...` and `stdbuf -oL gh ...` too. env and xargs have
 * their own checks below.
 */
const WRAPPERS: ReadonlyMap<string, WrapperOptions> = new Map([
  ["sudo", { short: SUDO_VALUE_OPTIONS, long: SUDO_LONG_VALUE_OPTIONS, operands: 0 }],
  ["doas", { short: new Set("uC"), long: new Set(), operands: 0 }],
  ["timeout", { short: new Set("ks"), long: new Set(["--kill-after", "--signal"]), operands: 1 }],
  ["stdbuf", { short: new Set("ioe"), long: new Set(), operands: 0 }],
  ["nice", { short: new Set("n"), long: new Set(["--adjustment"]), operands: 0 }],
  ["time", { short: new Set("fo"), long: new Set(["--format", "--output"]), operands: 0 }],
  ["exec", { short: new Set("a"), long: new Set(), operands: 0 }],
  ["command", NO_OPTIONS],
  ["builtin", NO_OPTIONS],
  ["nohup", NO_OPTIONS],
  ["setsid", NO_OPTIONS],
  ["busybox", NO_OPTIONS],
]);
/** A redirection word (`>`, `2>`, `>out`, `>>`, `<`); with no target of its own the next word is. */
const REDIRECTION = /^\d*(>>|>\||>|<<<|<<|<)(.*)$/;
/** Nesting of `sh -c`, `eval`, here-doc bodies and substitutions that is followed. */
const MAX_DEPTH = 4;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
/** A gh word anywhere in a text, in any letter case. */
const GH_WORD = /(^|[^A-Za-z0-9_-])gh($|[^A-Za-z0-9_-])/i;

/** Told to the worker when a gh call is refused. */
export const GH_REFUSAL =
  "dipo refused this command because the engine handles the code host (gh): a worker may run only gh --version, gh help <subcommand words> and gh <subcommand words> --help, to read gh's own help; run the command without gh.";

/** True for the argument list of a gh call that only reads gh's own help or version. */
export function ghHelpCall(args: readonly string[]): boolean {
  if (args.length === 1 && args[0] === "--version") return true;
  if (args[0] === "help") return args.slice(1).every((word) => SUBCOMMAND.test(word));
  return (
    args.length >= 2 &&
    args.at(-1) === "--help" &&
    args.slice(0, -1).every((word) => SUBCOMMAND.test(word))
  );
}

/**
 * The words without the redirections at their end: `gh pr view --help 2>&1` is a help form. Only
 * trailing ones go, since the words come without their quotes and a quoted `'<'` in the middle is
 * a real argument that could hide a flag taking `--help` as its value; a target that starts with
 * `-` is never dropped, for the same reason.
 */
function withoutTrailingRedirections(words: readonly string[]): string[] {
  const kept = [...words];
  for (;;) {
    const last = REDIRECTION.exec(kept.at(-1) ?? "");
    if (last !== null && last[2] !== "" && !last[2]?.startsWith("-")) {
      kept.pop();
      continue;
    }
    const target = kept.at(-1) ?? "";
    const operator = REDIRECTION.exec(kept.at(-2) ?? "");
    if (operator !== null && operator[2] === "" && target !== "" && !target.startsWith("-")) {
      kept.splice(-2, 2);
      continue;
    }
    if (last !== null && last[2] === "") {
      kept.pop();
      continue;
    }
    return kept;
  }
}

function basename(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

/** True for a program named gh: the file system may be case-insensitive, so `GH` runs gh too. */
function isGh(word: string): boolean {
  return basename(word).toLowerCase() === "gh";
}

/** Words in front of the program: assignments, shell keywords, `{` and `!`. */
function isPrefixWord(word: string): boolean {
  return ASSIGNMENT.test(word) || KEYWORDS.has(word) || word === "{" || word === "!";
}

/**
 * The texts of every here-string `<<<` (`0<<<` too) among a shell's arguments. A word spelled
 * `<<<` in quotes counts as well, since the words come without their quotes.
 */
function hereStrings(args: readonly string[]): string[] {
  const texts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const match = /^\d*<<<(.*)$/.exec(args[i] ?? "");
    if (match !== null) texts.push(match[1] === "" ? (args[i + 1] ?? "") : (match[1] ?? ""));
  }
  return texts;
}

/**
 * The texts that `echo` or `printf` may write to its output, which a shell reading the next stage
 * of its pipe runs: the words as written, with their escapes decoded (`echo -e`, a printf format),
 * and for printf decoded with each word on a line of its own (`printf '%s\n' 'gh pr list'`).
 */
/** Printed text with its escapes decoded, as a shell reads it: bash drops a NUL from its script. */
function printedScript(text: string): string {
  return ansiCText(text).replaceAll("\0", "");
}

function printedTexts(words: readonly string[]): string[] | null {
  const base = basename(words[0] ?? "").toLowerCase();
  if (base === "echo") {
    const args = words.slice(1).filter((word) => !/^-[neE]+$/.test(word));
    return [args.join(" "), printedScript(args.join(" "))];
  }
  if (base !== "printf") return null;
  const args = words.slice(1);
  return [args.join(" "), printedScript(args.join(" ")), printedScript(args.join("\n"))];
}

function ghIn(text: string, depth: number): string | null {
  // Nesting deeper than is followed is refused when its text holds a gh word at all.
  if (depth > MAX_DEPTH) return GH_WORD.test(text) ? GH_REFUSAL : null;
  const { commands, nested } = simpleCommands(text);
  // The texts each command writes out, which a later stage of its pipe reads as its stdin. A command
  // passes on what it reads too, since `echo "$(cat)"` prints its stdin. The here-doc body a
  // command reads comes first.
  const written = new Map<(typeof commands)[number], readonly string[] | null>();
  for (const command of commands) {
    const piped = command.pipedFrom === null ? null : (written.get(command.pipedFrom) ?? null);
    const stdin = command.body === null ? piped : [command.body];
    const printed = printedTexts(command.words);
    written.set(command, printed === null ? stdin : [...printed, ...(stdin ?? [])]);
    const hit = ghCommand(command.words, depth, stdin);
    if (hit !== null) return hit;
  }
  for (const inner of nested) {
    const hit = ghIn(inner, depth + 1);
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * The refusal for a gh word among a wrapper's arguments that is no option's value, unless a help
 * form follows it. It backs up the parsed check: an option the tables do not know makes its value
 * look like the program, and the gh word after it must still be refused, as before DIPO-242.
 */
function ghWordRefusal(args: readonly string[], values: ReadonlySet<number>): string | null {
  for (let j = 0; j < args.length; j++) {
    if (values.has(j) || !isGh(args[j] ?? "")) continue;
    if (!ghHelpCall(withoutTrailingRedirections(args.slice(j + 1)))) return GH_REFUSAL;
  }
  return null;
}

/** The refusal for one simple command's words, else null; `stdin` holds the texts it may read. */
function ghCommand(
  words: readonly string[],
  depth: number,
  stdin: readonly string[] | null,
): string | null {
  let at = 0;
  while (at < words.length && isPrefixWord(words[at] ?? "")) at++;
  const base = basename(words[at] ?? "").toLowerCase();
  const args = words.slice(at + 1);
  if (base === "gh") return ghHelpCall(withoutTrailingRedirections(args)) ? null : GH_REFUSAL;
  // `function f { gh ...; }` and `coproc [NAME] gh ...` run the command after the name, or after a `{`.
  if (base === "function" || base === "coproc") {
    return (
      ghCommand(words.slice(at + 1), depth, stdin) ?? ghCommand(words.slice(at + 2), depth, stdin)
    );
  }
  // xargs appends its input to the command, so a gh word behind it is refused whatever it is.
  if (base === "xargs") {
    if (args.some(isGh)) return GH_REFUSAL;
    const rest = args.slice(wrappedCommandAt(args, XARGS_VALUE_OPTIONS, XARGS_LONG_VALUE_OPTIONS));
    return ghCommand(rest, depth, null);
  }
  if (base === "env") {
    const env = envSplitTexts(args);
    for (const text of env.texts) {
      const hit = ghIn(text, depth + 1);
      if (hit !== null) return hit;
    }
    return ghCommand(args.slice(env.at), depth, stdin) ?? ghWordRefusal(args, new Set());
  }
  const wrapper = WRAPPERS.get(base);
  if (wrapper !== undefined) {
    const options = wrapperOptions(args, wrapper.short, wrapper.long);
    const start = options.at + wrapper.operands;
    // `command -v gh` and `command -V gh` only look the program up; they run none.
    if (base === "command" && args.slice(0, start).some((word) => /^-[^-]*[vV]/.test(word))) {
      return null;
    }
    // A wrapper runs its command after its own options (`env -C dir gh ...`), so it is checked again.
    return ghCommand(args.slice(start), depth, stdin) ?? ghWordRefusal(args, options.values);
  }
  if (base === "eval") return ghIn(args.join(" "), depth + 1);
  if (SHELLS.has(base)) {
    // The script of -c is the first word after the options, which may come after -c too
    // (`bash -c -- 'gh ...'`), so every word after -c is checked as a script.
    const flag = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
    // Without -c a shell reads its script from a here-string or from its stdin; bash takes the
    // last stdin redirection and zsh feeds them all, so each is checked.
    const scripts = flag === -1 ? [...hereStrings(args), ...(stdin ?? [])] : args.slice(flag + 1);
    for (const script of scripts) {
      const hit = ghIn(script, depth + 1);
      if (hit !== null) return hit;
    }
  }
  return null;
}

/**
 * Pure: the refusal for a Bash command text that runs a gh call other than the help forms, else
 * null. Checks every simple command, also inside a compound command, a command substitution, a
 * `sh -c` or `eval` text, a here-doc, a here-string or piped text a shell reads, a function body,
 * and a gh call behind a wrapper such as `env`, whatever the letter case of its program.
 */
export function ghRefusal(command: string): string | null {
  return ghIn(command, 0);
}
