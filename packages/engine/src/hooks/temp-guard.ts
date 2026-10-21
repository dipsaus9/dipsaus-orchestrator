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
/** The word that closes each compound that a keyword opens: `if` ... `fi`, `for` ... `done`. */
const COMPOUND_CLOSERS: ReadonlyMap<string, string> = new Map([
  ["if", "fi"],
  ["while", "done"],
  ["until", "done"],
  ["for", "done"],
  ["case", "esac"],
]);
/** The words that close a group: `}` of `{ ...; }` and the closing word of each compound. */
const CLOSERS: ReadonlySet<string> = new Set(["}", "fi", "done", "esac"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
/** Nesting of `sh -c`, `env -S`, `eval`, here-doc bodies and substitutions that is followed. */
const MAX_DEPTH = 4;
/** A here-doc delimiter of digits only is taken for a shift such as `1<<2`, not a here-doc. */
const NUMBER = /^[0-9]+$/;

/** A simple command: its words with quotes removed, and the here-doc body it reads, if any. */
interface SimpleCommand {
  words: string[];
  body: string | null;
  /** The command before this one when this one follows a pipe `|`. */
  pipedFrom: SimpleCommand | null;
  /**
   * For the closing word of a `{ ...; }` group or of an if, loop or case compound, or the command
   * after the `)` of a `( ... )` group: the indexes [start, end) of the commands inside the group,
   * which read a here-doc it opens.
   */
  group: { start: number; end: number } | null;
}

/** A here-doc opened by `<<` or `<<-`; its delimiter is the next word, its body follows the line. */
interface HereDoc {
  command: SimpleCommand;
  strip: boolean;
  delim: string | undefined;
}

function emptyCommand(): SimpleCommand {
  return { words: [], body: null, pipedFrom: null, group: null };
}

/** The here-doc delimiter word from `start` with its quotes removed, and the index after it. */
function hereDocWord(text: string, start: number): { delim: string; end: number } {
  let i = start;
  while (text.charAt(i) === " " || text.charAt(i) === "\t") i++;
  let delim = "";
  for (; i < text.length; i++) {
    const c = text.charAt(i);
    if (" \t\r\n;&|()<>".includes(c)) break;
    if (c === "\\") {
      i++;
      delim += text.charAt(i);
    } else if (c === "'" || c === '"') {
      const found = text.indexOf(c, i + 1);
      const stop = found === -1 ? text.length : found;
      delim += text.slice(i + 1, stop);
      i = stop;
    } else {
      delim += c;
    }
  }
  return { delim, end: i };
}

/**
 * The index of the `)` that closes the `(` at `open` (of a `$(` or `$((`), or -1 when nothing in
 * the text closes it. A `(` or `)` inside quotes, a backtick, a comment or a here-doc body is not
 * counted, and `<<` inside an arithmetic `(( ))` opens no here-doc.
 */
function closingParen(text: string, open: number): number {
  // What is open: `(`, arithmetic `((`, a double quote `"` or a backtick.
  const stack: string[] = [];
  let arithmetic = 0;
  const pending: Array<{ delim: string; strip: boolean }> = [];
  for (let i = open; i < text.length; i++) {
    const c = text.charAt(i);
    const top = stack[stack.length - 1];
    if (c === "\\") {
      i++;
    } else if (top === '"' || top === "`") {
      if (c === top) {
        stack.pop();
      } else if (c === "$" && text.charAt(i + 1) === "(") {
        i++;
        if (text.charAt(i + 1) === "(") {
          stack.push("((");
          arithmetic++;
          i++;
        } else {
          stack.push("(");
        }
      } else if (top === '"' && c === "`") {
        stack.push("`");
      }
    } else if (c === "(") {
      if (text.charAt(i + 1) === "(") {
        stack.push("((");
        arithmetic++;
        i++;
      } else {
        stack.push("(");
      }
    } else if (c === ")") {
      if (top === "((") {
        arithmetic--;
        if (text.charAt(i + 1) === ")") i++;
      }
      stack.pop();
      if (stack.length === 0) return i;
    } else if (c === "'") {
      // A `$'...'` span ends at the first quote that no backslash escapes.
      const ansi = text.charAt(i - 1) === "$";
      let end = i + 1;
      while (end < text.length && text.charAt(end) !== "'") {
        end += ansi && text.charAt(end) === "\\" ? 2 : 1;
      }
      if (end >= text.length) return -1;
      i = end;
    } else if (c === '"' || c === "`") {
      stack.push(c);
    } else if (c === "#" && " \t\n;&|(".includes(text.charAt(i - 1))) {
      const end = text.indexOf("\n", i);
      if (end === -1) return -1;
      // The line break is left to the loop, which reads a here-doc body.
      i = end - 1;
    } else if (c === "<" && text.startsWith("<<<", i)) {
      i += 2;
    } else if (c === "<" && text.startsWith("<<", i) && arithmetic === 0) {
      const strip = text.charAt(i + 2) === "-";
      const word = hereDocWord(text, i + (strip ? 3 : 2));
      if (word.delim !== "" && !NUMBER.test(word.delim)) pending.push({ delim: word.delim, strip });
      i = word.end - 1;
    } else if (c === "\n" && pending.length > 0) {
      let next = i;
      for (const heredoc of pending) next = readHereDoc(text, next + 1, heredoc).next;
      pending.length = 0;
      i = next - 1;
    }
  }
  return -1;
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

/** The escapes of ANSI-C quoting (`$'...'`) that stand for one character. */
const ANSI_C_LETTERS: ReadonlyMap<string, string> = new Map([
  ["a", "\x07"],
  ["b", "\b"],
  ["e", "\x1b"],
  ["E", "\x1b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["v", "\v"],
  ["\\", "\\"],
  ["'", "'"],
  ['"', '"'],
  ["?", "?"],
]);
/** The digits that follow `\x`, `\u` and `\U` in ANSI-C quoting. */
const ANSI_C_HEX_DIGITS: ReadonlyMap<string, number> = new Map([
  ["x", 2],
  ["u", 4],
  ["U", 8],
]);

/**
 * The escape at `at` (the backslash) of an ANSI-C span, decoded as bash decodes it, and the index
 * after it. An unknown escape keeps its backslash and letter.
 */
function ansiCEscape(text: string, at: number): { value: string; next: number } {
  const letter = text.charAt(at + 1);
  const simple = ANSI_C_LETTERS.get(letter);
  if (simple !== undefined) return { value: simple, next: at + 2 };
  if (letter === "c" && at + 2 < text.length) {
    return { value: String.fromCharCode(text.charCodeAt(at + 2) & 0x1f), next: at + 3 };
  }
  const octal = /^[0-7]{1,3}/.exec(text.slice(at + 1, at + 4));
  if (octal !== null) {
    return { value: String.fromCharCode(parseInt(octal[0], 8)), next: at + 1 + octal[0].length };
  }
  const width = ANSI_C_HEX_DIGITS.get(letter);
  if (width !== undefined) {
    const digits = /^[0-9A-Fa-f]*/.exec(text.slice(at + 2, at + 2 + width))?.[0] ?? "";
    const code = parseInt(digits, 16);
    if (digits !== "" && code <= 0x10ffff) {
      return { value: String.fromCodePoint(code), next: at + 2 + digits.length };
    }
  }
  return { value: `\\${letter}`, next: at + 2 };
}

/**
 * The text of an ANSI-C span `$'...'` whose body starts at `start`, with its escapes decoded, and
 * the index of its closing quote (the text's length when none closes it). Only `\'` does not end it.
 */
function ansiCSpan(text: string, start: number): { value: string; end: number } {
  let value = "";
  let i = start;
  while (i < text.length && text.charAt(i) !== "'") {
    if (text.charAt(i) === "\\" && i + 1 < text.length) {
      const escape = ansiCEscape(text, i);
      value += escape.value;
      i = escape.next;
    } else {
      value += text.charAt(i);
      i++;
    }
  }
  return { value, end: i };
}

/**
 * The text with every backslash escape decoded as in ANSI-C quoting: how `echo -e` and a printf
 * format write it out.
 */
export function ansiCText(text: string): string {
  let value = "";
  let i = 0;
  while (i < text.length) {
    if (text.charAt(i) === "\\" && i + 1 < text.length) {
      const escape = ansiCEscape(text, i);
      value += escape.value;
      i = escape.next;
    } else {
      value += text.charAt(i);
      i++;
    }
  }
  return value;
}

/**
 * Splits the text into simple commands, each a list of words with quotes removed, and collects the
 * text of each command substitution inside double quotes. Unquoted `&&`, `||`, `;`, `|`, `&`,
 * newlines, parentheses and backticks end a command; an unquoted `#` at a word start begins a
 * comment. A here-doc body is not split: it becomes the body of the command that opens it, and of
 * each command inside a `{ ...; }`, an if, loop or case compound, or a `( ... )` group that opens
 * it. A `$( ... )` substitution is no group. `<<<` is a here-string and no here-doc, and a `<<`
 * inside an arithmetic `(( ))` or before a number is a shift.
 */
export function simpleCommands(text: string): { commands: SimpleCommand[]; nested: string[] } {
  const commands: SimpleCommand[] = [];
  const nested: string[] = [];
  const heredocs: HereDoc[] = [];
  // The open `(`, `$(`, arithmetic `((` and `{` groups, and compounds, with the index of their
  // first command. A group's kind is its closing word for `{` and compounds.
  const groups: Array<{ kind: string; start: number }> = [];
  let arithmetic = 0;
  let current = emptyCommand();
  // True while the current command holds only keywords and `{`, so a `{` opens a group.
  let listStart = true;
  let word = "";
  let inWord = false;
  // True once any part of the current word is quoted or escaped: bash then reads it as a plain word,
  // never as a keyword, a group word or a closer.
  let quoted = false;
  // The here-doc whose delimiter is the next word.
  let delimFor: HereDoc | null = null;
  // Set once a `$(` inside double quotes is not closed: later ones are not scanned again.
  let unclosed = false;
  const endWord = () => {
    if (inWord && delimFor !== null && !NUMBER.test(word)) {
      delimFor.delim = word;
      delimFor = null;
    } else if (inWord) {
      if (delimFor !== null) {
        // `<<2` is a shift, not a here-doc.
        heredocs.pop();
        delimFor = null;
      }
      const closer = listStart && !quoted ? COMPOUND_CLOSERS.get(word) : undefined;
      if (word === "{" && listStart && !quoted) {
        groups.push({ kind: "}", start: commands.length });
      } else if (closer !== undefined) {
        groups.push({ kind: closer, start: commands.length });
      } else if (
        CLOSERS.has(word) &&
        !quoted &&
        current.words.length === 0 &&
        groups.at(-1)?.kind === word
      ) {
        const group = groups.pop();
        if (group !== undefined) current.group = { start: group.start, end: commands.length };
      }
      listStart = listStart && !quoted && (KEYWORDS.has(word) || word === "{");
      current.words.push(word);
    }
    word = "";
    inWord = false;
    quoted = false;
  };
  const endCommand = () => {
    endWord();
    if (current.words.length > 0) commands.push(current);
    current = emptyCommand();
    listStart = true;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (c === "\\") {
      i++;
      // A backslash-newline continues the line.
      if (text.charAt(i) !== "\n") {
        word += text.charAt(i);
        inWord = true;
        quoted = true;
      }
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1);
      const stop = end === -1 ? text.length : end;
      word += text.slice(i + 1, stop);
      inWord = true;
      quoted = true;
      i = stop;
    } else if (c === '"') {
      inWord = true;
      quoted = true;
      for (i++; i < text.length && text.charAt(i) !== '"'; i++) {
        const d = text.charAt(i);
        const close =
          d === "$" && text.charAt(i + 1) === "(" && !unclosed
            ? closingParen(text, i + 1)
            : d === "`"
              ? text.indexOf("`", i + 1)
              : -1;
        if (close !== -1) {
          nested.push(text.slice(d === "$" ? i + 2 : i + 1, close));
          word += text.slice(i, close + 1);
          i = close;
        } else {
          // A substitution nothing closes is read as plain text.
          if (d === "$" && text.charAt(i + 1) === "(") unclosed = true;
          if (d === "\\" && i + 1 < text.length) i++;
          word += text.charAt(i);
        }
      }
    } else if (c === "$" && text.charAt(i + 1) === "'") {
      // ANSI-C quoting: the span's escapes are decoded, as bash decodes them.
      const span = ansiCSpan(text, i + 2);
      word += span.value;
      inWord = true;
      quoted = true;
      i = span.end;
    } else if (c === "$" && text.charAt(i + 1) === '"') {
      // Locale quoting `$"..."` is read as the double-quoted span it wraps: the `$` is dropped.
      inWord = true;
    } else if (c === "#" && !inWord) {
      while (i < text.length && text.charAt(i) !== "\n") i++;
      // The line break is left to the loop, which ends the command and reads a here-doc body.
      i--;
      endCommand();
    } else if (c === " " || c === "\t" || c === "\r") {
      endWord();
    } else if (
      c === "<" &&
      (text.startsWith("<<<", i) || (arithmetic > 0 && text.startsWith("<<", i)))
    ) {
      // A here-string's `<<<` and an arithmetic shift are ordinary words.
      const operator = text.startsWith("<<<", i) ? "<<<" : "<<";
      word += operator;
      inWord = true;
      i += operator.length - 1;
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
        const group = heredoc.command.group;
        for (let k = group?.start ?? 0; k < (group?.end ?? 0); k++) {
          const inner = commands[k];
          if (inner !== undefined && inner.body === null) inner.body = read.body;
        }
        next = read.next;
      }
      heredocs.length = 0;
      // The loop continues at the line break that ends the last delimiter line.
      i = next - 1;
    } else if (c === "(") {
      endCommand();
      if (text.charAt(i + 1) === "(") {
        groups.push({ kind: "((", start: commands.length });
        arithmetic++;
        i++;
      } else {
        // A `$(` substitution is a word of its command: the command after its `)` reads no body.
        groups.push({ kind: text.charAt(i - 1) === "$" ? "$(" : "(", start: commands.length });
      }
    } else if (c === ")") {
      endCommand();
      const group = groups.at(-1);
      if (group?.kind === "((") {
        groups.pop();
        arithmetic--;
        if (text.charAt(i + 1) === ")") i++;
      } else if (group?.kind === "(") {
        groups.pop();
        current.group = { start: group.start, end: commands.length };
      } else if (group?.kind === "$(") {
        groups.pop();
      }
    } else if (";&\n`".includes(c)) {
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
export const SUDO_VALUE_OPTIONS: ReadonlySet<string> = new Set("ugCDhpRTU");
/** `sudo` long options that take the next word as their value. */
export const SUDO_LONG_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "--user",
  "--group",
  "--close-from",
  "--chdir",
  "--host",
  "--prompt",
  "--chroot",
  "--role",
  "--type",
  "--command-timeout",
  "--other-user",
]);
/** `xargs` short options that take a value (-I, -L, -n, -P, -s, -E, -d and -a). */
export const XARGS_VALUE_OPTIONS: ReadonlySet<string> = new Set("ILnPsEda");
/** `xargs` long options that take the next word as their value. */
export const XARGS_LONG_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "--arg-file",
  "--delimiter",
  "--max-args",
  "--max-procs",
  "--max-chars",
  "--process-slot-var",
]);
/** `read` short options that take a value; `-a` takes an array name, which is checked. */
const READ_VALUE_OPTIONS: ReadonlySet<string> = new Set("adinNptu");

function envRefusal(args: readonly string[], depth: number, body: string | null): string | null {
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
      return commandRefusal(args.slice(i), depth, body);
    }
  }
  return null;
}

/**
 * The index of the command that a wrapper such as `sudo` or `xargs` runs: its options are skipped,
 * a letter in `valued` takes the rest of its word or the next word as its value, and a long option
 * in `longValued` the next word.
 */
export function wrappedCommandAt(
  args: readonly string[],
  valued: ReadonlySet<string>,
  longValued: ReadonlySet<string>,
): number {
  return wrapperOptions(args, valued, longValued).at;
}

/**
 * As wrappedCommandAt, and also the indexes of the words taken as an option's value, which the gh
 * check passes over when it looks for a gh word that an option it does not know could hide.
 */
export function wrapperOptions(
  args: readonly string[],
  valued: ReadonlySet<string>,
  longValued: ReadonlySet<string>,
): { at: number; values: Set<number> } {
  const values = new Set<number>();
  let at = 0;
  while (at < args.length) {
    const word = args[at] ?? "";
    if (word === "--") return { at: at + 1, values };
    if (!word.startsWith("-") || word === "-") return { at, values };
    const letters = word.slice(1).split("");
    const k = letters.findIndex((letter) => valued.has(letter));
    const takesNext = word.startsWith("--")
      ? longValued.has(word)
      : k !== -1 && k === letters.length - 1;
    if (takesNext) values.add(at + 1);
    at += takesNext ? 2 : 1;
  }
  return { at, values };
}

/**
 * The texts of the `-S` options of an `env` call (args after `env`) and the index of the word env
 * runs, args.length when it runs none. Options and assignments before that word are skipped as
 * envRefusal skips them; a `-S` text is a command line env splits, so the gh check reads it as one.
 */
export function envSplitTexts(args: readonly string[]): { texts: string[]; at: number } {
  const texts: string[] = [];
  let at = 0;
  for (; at < args.length; at++) {
    const word = args[at] ?? "";
    if (word === "--") {
      at++;
      break;
    }
    if (ASSIGNMENT.test(word)) continue;
    if (word.startsWith("--")) {
      if (word === "--split-string") {
        texts.push(args[++at] ?? "");
      } else if (word.startsWith("--split-string=")) {
        texts.push(word.slice("--split-string=".length));
      } else if (word === "--unset" || ENV_LONG_VALUE_OPTIONS.has(word)) {
        at++;
      }
      continue;
    }
    if (!word.startsWith("-") || word === "-") break;
    for (let k = 1; k < word.length; k++) {
      const letter = word.charAt(k);
      if (!ENV_SHORT_VALUE_OPTIONS.has(letter)) continue;
      const value = k + 1 < word.length ? word.slice(k + 1) : (args[++at] ?? "");
      if (letter === "S") texts.push(value);
      break;
    }
  }
  return { texts, at };
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
    if (!word.startsWith("-") || word === "-" || word === "--") return null;
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
  if (base === "env") return envRefusal(args, depth, body);
  if (base === "eval") return refusedIn(args.join(" "), depth + 1);
  if (base === "read") return readRefusal(args);
  if (base === "printf") return printfRefusal(args);
  if (base === "sudo") {
    const start = wrappedCommandAt(args, SUDO_VALUE_OPTIONS, SUDO_LONG_VALUE_OPTIONS);
    return commandRefusal(args.slice(start), depth, body);
  }
  if (base === "xargs") {
    // xargs reads its standard input itself, so a here-doc body is not passed on.
    const start = wrappedCommandAt(args, XARGS_VALUE_OPTIONS, XARGS_LONG_VALUE_OPTIONS);
    return commandRefusal(args.slice(start), depth);
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
  // The here-doc body each command reads: its own, else the one fed to an earlier stage of its pipe.
  const fed = new Map<SimpleCommand, string | null>();
  for (const command of commands) {
    const piped = command.pipedFrom === null ? null : (fed.get(command.pipedFrom) ?? null);
    const body = command.body ?? piped;
    fed.set(command, body);
    const hit = commandRefusal(command.words, depth, body);
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
