// The story's ignore rules (DIPO-273): which paths of a part git would ignore, such as
// `node_modules`, so they never leave the box as changes. dipo reads the `.gitignore` files as
// data and matches them here, in its own code: no git or other tool runs on a `.gitignore` the
// worker wrote (0021 section 14).
//
// The matching follows gitignore(5): blank lines and `#` comments are skipped, trailing spaces are
// cut unless escaped, `!` negates, a trailing `/` matches folders only, a pattern with a `/` before
// its end is anchored to its file's folder (a leading `/` too), and one without matches a name at
// any depth below it. `*` and `?` stay within one path part, `[...]` is a character class, `**/`,
// `/**/` and `/**` match any number of folders, and `\` escapes the next character. A deeper
// `.gitignore` decides before a higher one, the last matching line of a file decides within it,
// and a path below an ignored folder is ignored whatever a later line says, as in git. Matching is
// case-sensitive, as git is by default. The rules of `.git/info/exclude` and of the maintainer's
// own `core.excludesFile` are not read: they are not the story's.

/** One `.gitignore` file: its folder (repo-relative, "" for the root) and its text. */
export interface IgnoreFile {
  readonly dir: string;
  readonly text: string;
}

interface Pattern {
  readonly regex: RegExp;
  readonly negated: boolean;
  readonly dirOnly: boolean;
  /** The pattern itself when it is a plain name matched at any depth (`node_modules`), else null. */
  readonly plainName: string | null;
}

interface RuleFile {
  readonly dir: string;
  readonly patterns: readonly Pattern[];
}

/** The glob of one pattern as a regular expression source, `**` rules included. */
function globSource(glob: string): string {
  let out = "";
  let at = 0;
  while (at < glob.length) {
    const char = glob[at]!;
    if (char === "\\" && at + 1 < glob.length) {
      out += escapeChar(glob[at + 1]!);
      at += 2;
      continue;
    }
    if (char === "*") {
      if (glob[at + 1] === "*") {
        const before = at === 0 || glob[at - 1] === "/";
        const after = at + 2 === glob.length || glob[at + 2] === "/";
        if (before && after) {
          if (at + 2 === glob.length) {
            // `x/**`: everything inside; `**` alone: everything.
            out += ".*";
            at += 2;
          } else {
            // `**/` (leading or in the middle): zero or more folders.
            out += "(?:.*/)?";
            at += 3;
          }
          continue;
        }
      }
      out += "[^/]*";
      at += 1;
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      at += 1;
      continue;
    }
    if (char === "[") {
      const end = classEnd(glob, at);
      if (end > 0) {
        out += classSource(glob.slice(at + 1, end));
        at = end + 1;
        continue;
      }
    }
    out += escapeChar(char);
    at += 1;
  }
  return out;
}

function escapeChar(char: string): string {
  return /[\\^$.*+?()[\]{}|/-]/.test(char) ? `\\${char}` : char;
}

/** The index of the `]` that ends the class opened at `start`, or -1 when it is not closed. */
function classEnd(glob: string, start: number): number {
  let at = start + 1;
  if (glob[at] === "!" || glob[at] === "^") at += 1;
  if (glob[at] === "]") at += 1;
  while (at < glob.length) {
    if (glob[at] === "\\") at += 2;
    else if (glob[at] === "]") return at;
    else at += 1;
  }
  return -1;
}

/** A gitignore character class body as a regular expression class that never matches `/`. */
function classSource(body: string): string {
  let negated = false;
  let at = 0;
  if (body[0] === "!" || body[0] === "^") {
    negated = true;
    at = 1;
  }
  let out = "";
  for (; at < body.length; at += 1) {
    let char = body[at]!;
    if (char === "\\" && at + 1 < body.length) {
      at += 1;
      char = body[at]!;
      out += `\\${char}`;
      continue;
    }
    out += char === "-" ? "-" : /[\\\]^[]/.test(char) ? `\\${char}` : char;
  }
  return negated ? `(?!/)[^${out}]` : `(?!/)[${out}]`;
}

/** The trailing spaces of `line` cut, unless escaped with `\`. */
function trimEnd(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === " " && line[end - 2] !== "\\") end -= 1;
  return line.slice(0, end);
}

/** One line of a `.gitignore`, or null for a blank line or a comment. */
function parseLine(raw: string): Pattern | null {
  let line = trimEnd(raw.replace(/\r$/, ""));
  if (line === "" || line.startsWith("#")) return null;
  let negated = false;
  if (line.startsWith("!")) {
    negated = true;
    line = line.slice(1);
  } else if (line.startsWith("\\!") || line.startsWith("\\#")) {
    line = line.slice(1);
  }
  let dirOnly = false;
  while (line.endsWith("/")) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  if (line === "") return null;
  const anchored = line.includes("/");
  if (line.startsWith("/")) line = line.slice(1);
  const body = globSource(line);
  const regex = new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`);
  const plainName = !anchored && /^[A-Za-z0-9._-]+$/.test(line) ? line : null;
  return { regex, negated, dirOnly, plainName };
}

/** The story's ignore rules, from its `.gitignore` files. */
export class IgnoreRules {
  /** Deepest folder first, so a deeper file decides before a higher one. */
  readonly #files: readonly RuleFile[];

  constructor(files: readonly IgnoreFile[]) {
    this.#files = files
      .map((file) => ({
        dir: file.dir.replace(/^\/+|\/+$/g, ""),
        patterns: file.text
          .split("\n")
          .map(parseLine)
          .filter((pattern) => pattern !== null),
      }))
      .filter((file) => file.patterns.length > 0)
      .toSorted((a, b) => depth(b.dir) - depth(a.dir));
  }

  /** True when any rule negates (`!`), which an in-box exclude list could not honour. */
  get hasNegation(): boolean {
    return this.#files.some((file) => file.patterns.some((pattern) => pattern.negated));
  }

  /** The plain names (`node_modules`, `dist/`) the rules ignore at any depth, sorted, each once. */
  get plainNames(): string[] {
    const names = new Set<string>();
    for (const file of this.#files) {
      for (const pattern of file.patterns) {
        if (!pattern.negated && pattern.plainName !== null) names.add(pattern.plainName);
      }
    }
    return [...names].toSorted();
  }

  /** The decision of the rules for `path` itself: true ignored, false re-included, null none. */
  #decide(path: string, isDir: boolean): boolean | null {
    for (const file of this.#files) {
      if (file.dir !== "" && !path.startsWith(`${file.dir}/`)) continue;
      const rel = file.dir === "" ? path : path.slice(file.dir.length + 1);
      for (let at = file.patterns.length - 1; at >= 0; at -= 1) {
        const pattern = file.patterns[at]!;
        if (pattern.dirOnly && !isDir) continue;
        if (pattern.regex.test(rel)) return !pattern.negated;
      }
    }
    return null;
  }

  /**
   * True when git would ignore the repo-relative `path` (a file unless `isDir`): it or a folder
   * above it is ignored. A tracked path is never ignored; the caller checks that.
   */
  ignored(path: string, isDir = false): boolean {
    const parts = path.split("/");
    for (let end = 1; end < parts.length; end += 1) {
      if (this.#decide(parts.slice(0, end).join("/"), true) === true) return true;
    }
    return this.#decide(path, isDir) === true;
  }
}

function depth(dir: string): number {
  return dir === "" ? 0 : dir.split("/").length;
}

/** The folder of a repo-relative `.gitignore` path, or null when the path is no `.gitignore`. */
export function ignoreFileDir(path: string): string | null {
  if (path === ".gitignore") return "";
  return path.endsWith("/.gitignore") ? path.slice(0, -"/.gitignore".length) : null;
}
