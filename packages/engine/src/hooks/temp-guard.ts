// The Bash check of `dipo hook PreToolUse --bash` (DIPO-194; 0008 amendment of 2026-10-19, section
// 5): a worker command that sets or clears DIPO_TMP or TMPDIR is refused before it runs, since dipo
// sets DIPO_TMP and the sandbox sets TMPDIR for the run, and a path the worker chose itself loses
// its verify to EPERM. Pure: it splits the command text into simple commands and looks at the words
// of each; it does not expand anything, so `$DIPO_TMP` and `${TMPDIR}` (reads) pass.

/** The variables a worker command may not set or clear. */
export const GUARDED_TEMP_VARIABLES: readonly string[] = ["DIPO_TMP", "TMPDIR"];

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/;
/** Words in front of the real command that do not change which variables it sets. */
const PREFIX_WORDS = new Set(["command", "builtin", "exec", "time", "nohup", "nice"]);
/** Shell keywords that open a command list: `then export TMPDIR=x` sets the variable too. */
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
/** Nesting of `sh -c`, `env -S`, `eval`, here-doc bodies and substitutions that is followed. */
const MAX_DEPTH = 4;

/** A simple command: its words with quotes removed, and the here-doc body it reads, if any. */
interface SimpleCommand {
  words: string[];
  body: string | null;
  /** The command before this one when this one follows a pipe `|`. */
  pipedFrom: SimpleCommand | null;
}

/** A here-doc opened by `<<` or `<<-`; its delimiter is the next word, its body follows the line. */
interface HereDoc {
  command: SimpleCommand;
  strip: boolean;
  delim: string | undefined;
}

function emptyCommand(): SimpleCommand {
  return { words: [], body: null, pipedFrom: null };
}

/** The index of the `)` that closes the `(` at `open`, or the end of the text when it is not closed. */
function closingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text.charAt(i) === "(") depth++;
    else if (text.charAt(i) === ")" && --depth === 0) return i;
  }
  return text.length;
}

/**
 * Reads a here-doc body from `start` up to the line that is its delimiter (leading tabs are ignored
 * for `<<-`). `next` is the line break that ends the delimiter line, or the end of the text.
 */
function readHereDoc(
  text: string,
  start: number,
  heredoc: { delim: string; strip: boolean },
): { body: string; next: number } {
  const lines: string[] = [];
  for (let at = start; at < text.length;) {
    let stop = text.indexOf("\n", at);
    if (stop === -1) stop = text.length;
    const line = text.slice(at, stop);
    if ((heredoc.strip ? line.replace(/^\t+/, "") : line) === heredoc.delim) {
      return { body: lines.join("\n"), next: stop };
    }
    lines.push(line);
    at = stop + 1;
  }
  return { body: lines.join("\n"), next: text.length };
}

/**
 * Splits the text into simple commands, each a list of words with quotes removed, and collects the
 * text of each command substitution inside double quotes. Unquoted `&&`, `||`, `;`, `|`, `&`,
 * newlines, parentheses and backticks end a command; an unquoted `#` at a word start begins a
 * comment. A here-doc body is not split: it becomes the body of the command that opens it. `<<<`
 * is a here-string and no here-doc.
 */
function simpleCommands(text: string): { commands: SimpleCommand[]; nested: string[] } {
  const commands: SimpleCommand[] = [];
  const nested: string[] = [];
  const heredocs: HereDoc[] = [];
  let current = emptyCommand();
  let word = "";
  let inWord = false;
  // The here-doc whose delimiter is the next word.
  let delimFor: HereDoc | null = null;
  const endWord = () => {
    if (inWord && delimFor !== null) {
      delimFor.delim = word;
      delimFor = null;
    } else if (inWord) {
      current.words.push(word);
    }
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (current.words.length > 0) commands.push(current);
    current = emptyCommand();
  };
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (c === "\\") {
      i++;
      // A backslash-newline continues the line.
      if (text.charAt(i) !== "\n") {
        word += text.charAt(i);
        inWord = true;
      }
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1);
      const stop = end === -1 ? text.length : end;
      word += text.slice(i + 1, stop);
      inWord = true;
      i = stop;
    } else if (c === '"') {
      inWord = true;
      for (i++; i < text.length && text.charAt(i) !== '"'; i++) {
        const d = text.charAt(i);
        if (d === "$" && text.charAt(i + 1) === "(") {
          const close = closingParen(text, i + 1);
          nested.push(text.slice(i + 2, close));
          word += text.slice(i, close + 1);
          i = close;
        } else if (d === "`") {
          const found = text.indexOf("`", i + 1);
          const close = found === -1 ? text.length : found;
          nested.push(text.slice(i + 1, close));
          word += text.slice(i, close + 1);
          i = close;
        } else {
          if (d === "\\" && i + 1 < text.length) i++;
          word += text.charAt(i);
        }
      }
    } else if (c === "#" && !inWord) {
      while (i < text.length && text.charAt(i) !== "\n") i++;
      // The line break is left to the loop, which ends the command and reads a here-doc body.
      i--;
      endCommand();
    } else if (c === " " || c === "\t" || c === "\r") {
      endWord();
    } else if (c === "<" && text.startsWith("<<<", i)) {
      // A here-string: its `<<<` is an ordinary word.
      word += "<<<";
      inWord = true;
      i += 2;
    } else if (c === "<" && text.startsWith("<<", i)) {
      endWord();
      const strip = text.charAt(i + 2) === "-";
      delimFor = { command: current, strip, delim: undefined };
      heredocs.push(delimFor);
      i += strip ? 2 : 1;
    } else if (c === "|") {
      const before = current;
      endCommand();
      current.pipedFrom = before.words.length > 0 ? before : null;
    } else if (c === "\n" && heredocs.length > 0) {
      endCommand();
      delimFor = null;
      let next = i;
      for (const heredoc of heredocs) {
        if (heredoc.delim === undefined) continue;
        const read = readHereDoc(text, next + 1, { delim: heredoc.delim, strip: heredoc.strip });
        heredoc.command.body = read.body;
        next = read.next;
      }
      heredocs.length = 0;
      // The loop continues at the line break that ends the last delimiter line.
      i = next - 1;
    } else if (";&\n()`".includes(c)) {
      endCommand();
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return { commands, nested };
}

function assignedName(word: string): string | null {
  const name = ASSIGNMENT.exec(word)?.[1];
  return name !== undefined && GUARDED_TEMP_VARIABLES.includes(name) ? name : null;
}

function guarded(name: string | undefined): string | null {
  return name !== undefined && GUARDED_TEMP_VARIABLES.includes(name) ? name : null;
}

/** `env` short options that take a value: the rest of the word or the next word. */
const ENV_SHORT_VALUE_OPTIONS: ReadonlySet<string> = new Set(["u", "C", "P", "S"]);
/** `env` long options that take the next word as their value. */
const ENV_LONG_VALUE_OPTIONS = new Set(["--chdir", "--default-path"]);
/** `sudo` short options that take a value (-u, -g, -C, -D, -h, -p, -R, -T and -U). */
const SUDO_VALUE_OPTIONS: ReadonlySet<string> = new Set("ugCDhpRTU");
/** `xargs` short options that take a value (-I, -L, -n, -P, -s, -E, -d and -a). */
const XARGS_VALUE_OPTIONS: ReadonlySet<string> = new Set("ILnPsEda");
/** `read` short options that take a value; `-a` takes an array name, which is checked. */
const READ_VALUE_OPTIONS: ReadonlySet<string> = new Set("adinNptu");

function envRefusal(args: readonly string[], depth: number): string | null {
  for (let i = 0; i < args.length; i++) {
    const word = args[i] ?? "";
    if (word === "--") continue;
    const assigned = assignedName(word);
    if (assigned !== null) return assigned;
    if (ASSIGNMENT.test(word)) continue;
    if (word.startsWith("--")) {
      if (word === "--unset") {
        const hit = guarded(args[i + 1]);
        if (hit !== null) return hit;
        i++;
      } else if (word.startsWith("--unset=")) {
        const hit = guarded(word.slice("--unset=".length));
        if (hit !== null) return hit;
      } else if (word === "--split-string") {
        const hit = refusedIn(args[i + 1] ?? "", depth + 1);
        if (hit !== null) return hit;
        i++;
      } else if (ENV_LONG_VALUE_OPTIONS.has(word)) {
        i++;
      }
    } else if (word.startsWith("-")) {
      // Short options combine: `-iu TMPDIR` and `-iuTMPDIR` both clear TMPDIR.
      for (let k = 1; k < word.length; k++) {
        const letter = word.charAt(k);
        if (!ENV_SHORT_VALUE_OPTIONS.has(letter)) continue;
        const value = k + 1 < word.length ? word.slice(k + 1) : (args[++i] ?? "");
        const hit =
          letter === "u" ? guarded(value) : letter === "S" ? refusedIn(value, depth + 1) : null;
        if (hit !== null) return hit;
        break;
      }
    } else {
      // The command `env` runs: look at it as a command of its own.
      return commandRefusal(args.slice(i), depth);
    }
  }
  return null;
}

/**
 * The index of the command that a wrapper such as `sudo` or `xargs` runs: its options are skipped,
 * and a letter in `valued` takes the rest of its word or the next word as its value.
 */
function wrappedCommandAt(args: readonly string[], valued: ReadonlySet<string>): number {
  let at = 0;
  while (at < args.length) {
    const word = args[at] ?? "";
    if (word === "--") return at + 1;
    if (!word.startsWith("-") || word === "-") return at;
    if (word.startsWith("--")) {
      at++;
      continue;
    }
    const letters = word.slice(1).split("");
    const k = letters.findIndex((letter) => valued.has(letter));
    at += k !== -1 && k === letters.length - 1 ? 2 : 1;
  }
  return at;
}

/** `read` sets the names it is given, and `-a` names an array it sets. */
function readRefusal(args: readonly string[]): string | null {
  let at = 0;
  for (; at < args.length; at++) {
    const word = args[at] ?? "";
    if (word === "--") {
      at++;
      break;
    }
    if (!word.startsWith("-") || word === "-") break;
    for (let k = 1; k < word.length; k++) {
      const letter = word.charAt(k);
      if (!READ_VALUE_OPTIONS.has(letter)) continue;
      const value = k + 1 < word.length ? word.slice(k + 1) : (args[++at] ?? "");
      if (letter === "a") {
        const hit = guarded(value);
        if (hit !== null) return hit;
      }
      break;
    }
  }
  for (; at < args.length; at++) {
    const word = args[at] ?? "";
    if (word === "<<<") break;
    const hit = guarded(word);
    if (hit !== null) return hit;
  }
  return null;
}

/** `printf -v NAME` sets NAME, the way `printf -vNAME` does. */
function printfRefusal(args: readonly string[]): string | null {
  for (let at = 0; at < args.length; at++) {
    const word = args[at] ?? "";
    if (!word.startsWith("-") || word === "-") return null;
    if (word.startsWith("-v")) {
      const hit = guarded(word === "-v" ? args[++at] : word.slice(2));
      if (hit !== null) return hit;
    }
  }
  return null;
}

function commandRefusal(
  words: readonly string[],
  depth: number,
  body: string | null = null,
): string | null {
  let at = 0;
  // Prefix assignments, then wrapper words, then the command word.
  for (;;) {
    const word = words[at];
    if (word === undefined) return null;
    const assigned = assignedName(word);
    if (assigned !== null) return assigned;
    if (
      ASSIGNMENT.test(word) ||
      PREFIX_WORDS.has(word) ||
      KEYWORDS.has(word) ||
      word === "{" ||
      word === "!"
    ) {
      at++;
      continue;
    }
    break;
  }
  const program = words[at] ?? "";
  const args = words.slice(at + 1);
  const base = program.slice(program.lastIndexOf("/") + 1);
  if (
    base === "export" ||
    base === "declare" ||
    base === "typeset" ||
    base === "readonly" ||
    base === "local"
  ) {
    for (const arg of args) {
      const hit = assignedName(arg);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (base === "unset") {
    for (const arg of args) {
      const hit = guarded(arg);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (base === "env") return envRefusal(args, depth);
  if (base === "eval") return refusedIn(args.join(" "), depth + 1);
  if (base === "read") return readRefusal(args);
  if (base === "printf") return printfRefusal(args);
  if (base === "sudo") {
    return commandRefusal(args.slice(wrappedCommandAt(args, SUDO_VALUE_OPTIONS)), depth);
  }
  if (base === "xargs") {
    return commandRefusal(args.slice(wrappedCommandAt(args, XARGS_VALUE_OPTIONS)), depth);
  }
  if (SHELLS.has(base)) {
    const flag = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
    if (flag !== -1) return refusedIn(args[flag + 1] ?? "", depth + 1);
    // Without -c a shell reads its here-doc body as a script.
    if (body !== null) return refusedIn(body, depth + 1);
  }
  return null;
}

function refusedIn(text: string, depth: number): string | null {
  if (depth > MAX_DEPTH) return null;
  const { commands, nested } = simpleCommands(text);
  for (const command of commands) {
    // A shell reads a here-doc body fed to it, or one piped into it.
    const hit = commandRefusal(
      command.words,
      depth,
      command.body ?? command.pipedFrom?.body ?? null,
    );
    if (hit !== null) return hit;
  }
  for (const inner of nested) {
    const hit = refusedIn(inner, depth + 1);
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * Pure: the variable (`DIPO_TMP` or `TMPDIR`) a Bash command text sets or clears in one of its
 * simple commands, else null. Sets: a prefix or bare assignment, `export`, `local`, `env`, `eval`,
 * `printf -v`, `read`, a shell reading a here-doc body, and the same behind `sudo` and `xargs`;
 * clears: `unset`, `env -u`. Checks the text of command substitutions inside double quotes, not
 * inside single quotes. Reading it, naming it as a later argument and a longer variable name pass.
 */
export function refusedTempVariable(command: string): string | null {
  return refusedIn(command, 0);
}

/** Told to the worker when `refusedTempVariable` refused its command. */
export function tempVariableRefusal(variable: string): string {
  return `dipo refused this command because it sets or clears ${variable}; dipo sets DIPO_TMP and the sandbox sets TMPDIR for the run, so never set or clear them (contract rule Temp files); run the command without it.`;
}
