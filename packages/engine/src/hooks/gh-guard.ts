// The gh check of `dipo hook PreToolUse --bash` (DIPO-195; 0014 amendment of 2026-10-20, section 3):
// the engine handles the code host, so a worker runs gh only to read gh's own help and version.
// Allowed: `gh --version`, `gh help` followed by subcommand words, and `gh` followed by subcommand
// words and then `--help` as the last argument. Every other simple command whose program is gh is
// refused. Pure, like temp-guard: it splits the command text the same way and looks at the words.

import { simpleCommands } from "./temp-guard";

/** A subcommand word: a letter, then letters, digits or dashes, so no flag is one. */
const SUBCOMMAND = /^[A-Za-z][A-Za-z0-9-]*$/;
/** Words in front of the real command that do not change which program runs. */
const PREFIX_WORDS = new Set(["command", "builtin", "exec", "time", "nohup", "nice"]);
/** Shell keywords that open a command list: `then gh pr view` runs gh too. */
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
/**
 * Programs that run another command after their options; a gh call behind one is checked. The
 * Claude CLI strips timeout and stdbuf before it matches a Bash rule, so the `Bash(gh *)` deny rule
 * this check replaces caught `timeout 10 gh ...` and `stdbuf -oL gh ...` too.
 */
const WRAPPERS = new Set(["env", "sudo", "doas", "xargs", "timeout", "stdbuf"]);
/** A redirection word (`>`, `2>`, `>out`, `>>`, `<`); with no target of its own the next word is. */
const REDIRECTION = /^\d*(>>|>\||>|<<<|<<|<)(.*)$/;
/** Nesting of `sh -c`, `eval`, here-doc bodies and substitutions that is followed. */
const MAX_DEPTH = 4;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

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

function ghIn(text: string, depth: number): string | null {
  if (depth > MAX_DEPTH) return null;
  const { commands, nested } = simpleCommands(text);
  // The here-doc body each command reads: its own, else the one fed to an earlier stage of its pipe.
  const fed = new Map<(typeof commands)[number], string | null>();
  for (const command of commands) {
    const piped = command.pipedFrom === null ? null : (fed.get(command.pipedFrom) ?? null);
    const body = command.body ?? piped;
    fed.set(command, body);
    const hit = ghCommand(command.words, depth, body);
    if (hit !== null) return hit;
  }
  for (const inner of nested) {
    const hit = ghIn(inner, depth + 1);
    if (hit !== null) return hit;
  }
  return null;
}

function ghCommand(words: readonly string[], depth: number, body: string | null): string | null {
  let at = 0;
  // Prefix assignments, prefix words and keywords come before the program.
  while (at < words.length) {
    const word = words[at] ?? "";
    if (
      ASSIGNMENT.test(word) ||
      PREFIX_WORDS.has(word) ||
      KEYWORDS.has(word) ||
      word === "{" ||
      word === "!"
    ) {
      at++;
    } else {
      break;
    }
  }
  const program = words[at] ?? "";
  const base = basename(program);
  const args = words.slice(at + 1);
  if (base === "gh") return ghHelpCall(withoutTrailingRedirections(args)) ? null : GH_REFUSAL;
  // A wrapper runs its gh call after its own options (`env -C dir gh ...`), so the words after it
  // are checked too; xargs appends its input to the command, so an xargs gh call is refused.
  const wrapped = WRAPPERS.has(base) || words.slice(0, at).some((word) => PREFIX_WORDS.has(word));
  if (wrapped) {
    const index = words.findIndex((word, i) => i > at && basename(word) === "gh");
    if (index !== -1) {
      if (base === "xargs") return GH_REFUSAL;
      return ghHelpCall(withoutTrailingRedirections(words.slice(index + 1))) ? null : GH_REFUSAL;
    }
  }
  if (base === "eval") return ghIn(args.join(" "), depth + 1);
  if (SHELLS.has(base)) {
    const flag = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
    if (flag !== -1) return ghIn(args[flag + 1] ?? "", depth + 1);
    // Without -c a shell reads its here-doc body as a script.
    if (body !== null) return ghIn(body, depth + 1);
  }
  return null;
}

/**
 * Pure: the refusal for a Bash command text that runs a gh call other than the help forms, else
 * null. Checks every simple command, also inside a compound command, a command substitution, a
 * `sh -c` or `eval` text and a here-doc a shell reads, and a gh call behind a wrapper such as `env`.
 */
export function ghRefusal(command: string): string | null {
  return ghIn(command, 0);
}
