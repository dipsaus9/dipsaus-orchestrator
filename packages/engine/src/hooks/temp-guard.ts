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
/** Nesting of `sh -c` and `env -S` strings that is followed. */
const MAX_DEPTH = 4;

/**
 * Splits the text into simple commands, each a list of words with quotes removed. Unquoted
 * `&&`, `||`, `;`, `|`, `&`, newlines, parentheses and backticks end a command; an unquoted `#`
 * at a word start begins a comment.
 */
function simpleCommands(text: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
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
        if (text.charAt(i) === "\\" && i + 1 < text.length) i++;
        word += text.charAt(i);
      }
    } else if (c === "#" && !inWord) {
      while (i < text.length && text.charAt(i) !== "\n") i++;
      endCommand();
    } else if (c === " " || c === "\t" || c === "\r") {
      endWord();
    } else if (";|&\n()`".includes(c)) {
      endCommand();
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

function assignedName(word: string): string | null {
  const name = ASSIGNMENT.exec(word)?.[1];
  return name !== undefined && GUARDED_TEMP_VARIABLES.includes(name) ? name : null;
}

function guarded(name: string | undefined): string | null {
  return name !== undefined && GUARDED_TEMP_VARIABLES.includes(name) ? name : null;
}

/** `env` options that take the next word as their value. */
const ENV_VALUE_OPTIONS = new Set(["-C", "--chdir", "-P", "--default-path"]);

function envRefusal(args: readonly string[], depth: number): string | null {
  for (let i = 0; i < args.length; i++) {
    const word = args[i] ?? "";
    if (word === "--") continue;
    const assigned = assignedName(word);
    if (assigned !== null) return assigned;
    if (ASSIGNMENT.test(word)) continue;
    if (word === "-u" || word === "--unset") {
      const hit = guarded(args[i + 1]);
      if (hit !== null) return hit;
      i++;
    } else if (word.startsWith("--unset=")) {
      const hit = guarded(word.slice("--unset=".length));
      if (hit !== null) return hit;
    } else if (word.startsWith("-u") && !word.startsWith("--")) {
      const hit = guarded(word.slice(2));
      if (hit !== null) return hit;
    } else if (word === "-S" || word === "--split-string") {
      const hit = refusedIn(args[i + 1] ?? "", depth + 1);
      if (hit !== null) return hit;
      i++;
    } else if (ENV_VALUE_OPTIONS.has(word)) {
      i++;
    } else if (!word.startsWith("-")) {
      // The command `env` runs: look at it as a command of its own.
      return commandRefusal(args.slice(i), depth);
    }
  }
  return null;
}

function commandRefusal(words: readonly string[], depth: number): string | null {
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
  if (base === "export" || base === "declare" || base === "typeset" || base === "readonly") {
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
  if (SHELLS.has(base)) {
    const flag = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
    if (flag !== -1) return refusedIn(args[flag + 1] ?? "", depth + 1);
  }
  return null;
}

function refusedIn(text: string, depth: number): string | null {
  if (depth > MAX_DEPTH) return null;
  for (const words of simpleCommands(text)) {
    const hit = commandRefusal(words, depth);
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * Pure: the variable (`DIPO_TMP` or `TMPDIR`) a Bash command text sets or clears in one of its
 * simple commands, else null. Sets: a prefix or bare assignment, `export`, `env`; clears: `unset`,
 * `env -u`. Reading it, naming it as a later argument and a longer variable name pass.
 */
export function refusedTempVariable(command: string): string | null {
  return refusedIn(command, 0);
}

/** Told to the worker when `refusedTempVariable` refused its command. */
export function tempVariableRefusal(variable: string): string {
  return `dipo refused this command because it sets or clears ${variable}; dipo sets DIPO_TMP and the sandbox sets TMPDIR for the run, so never set or clear them (contract rule Temp files); run the command without it.`;
}
