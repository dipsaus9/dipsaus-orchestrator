// The story's ignore rules (DIPO-273): which paths of a part git would ignore, such as
// `node_modules`, so they never leave the box as changes. dipo reads the `.gitignore` files as
// data and matches them here, in its own code: no git or other tool runs on a `.gitignore` the
// worker wrote (0021 section 14).
//
// The matching follows gitignore(5): blank lines and `#` comments are skipped, trailing spaces are
// cut unless escaped, `!` negates, a trailing `/` matches folders only, a pattern with a `/` before
// its end is anchored to its file's folder (a leading `/` too), and one without matches a name at
// any depth below it. `*` and `?` stay within one path part, `[...]` is a character class, `**/`
// and `/**/` match any number of folders, `/**` everything inside, and `\` escapes the next
// character. A deeper `.gitignore` decides before a higher one, the last matching line of a file
// decides within it, and a path below an ignored folder is ignored whatever a later line says, as
// in git. Matching is case-sensitive, as git is by default. The rules of `.git/info/exclude` and of
// the maintainer's own `core.excludesFile` are not read: they are not the story's.
//
// The worker writes these files, so the matcher uses no regular expressions: one path part is
// matched in at most (pattern length x part length) steps, and `**` parts are memoised, so no
// pattern can make a match take long. A pattern longer than `MAX_PATTERN_CHARS` ignores nothing,
// and so its paths are delivered and scanned like any other.

/** The longest pattern matched; a longer one ignores nothing. */
const MAX_PATTERN_CHARS = 256;
/** The most lines of one `.gitignore` read. */
const MAX_PATTERNS_PER_FILE = 2_000;
/** The most patterns of all `.gitignore` files together. */
const MAX_PATTERNS_TOTAL = 5_000;
/** The most `.gitignore` files read; the shallowest go first. */
const MAX_FILES = 500;
/** The most `**` parts one pattern holds once runs of them are merged; more ignore nothing. */
const MAX_GLOBSTARS = 4;
/** The deepest path matched; a deeper one passes every budget at once. */
export const MAX_MATCH_DEPTH = 64;

/** Thrown when matching passes its budget (`MatchBudget`) or a path is deeper than matched. */
export class IgnoreBudgetExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IgnoreBudgetExceeded";
  }
}

/**
 * The steps matching may take: every character compared, every memoised `**` step and every
 * `**` extension counts one, and the step past `limit` throws `IgnoreBudgetExceeded` at once.
 */
export class MatchBudget {
  #steps = 0;

  constructor(readonly limit: number) {}

  get steps(): number {
    return this.#steps;
  }

  take(): void {
    this.#steps += 1;
    if (this.#steps > this.limit) {
      throw new IgnoreBudgetExceeded(`ignore matching passed ${this.limit} steps.`);
    }
  }
}

/** One `.gitignore` file: its folder (repo-relative, "" for the root) and its text. */
export interface IgnoreFile {
  readonly dir: string;
  readonly text: string;
}

/** One token of a pattern part. */
type Token =
  | { readonly kind: "char"; readonly char: string }
  | { readonly kind: "one" }
  | { readonly kind: "star" }
  | {
      readonly kind: "class";
      readonly negated: boolean;
      readonly ranges: readonly (readonly [number, number])[];
    };

/** One part of a pattern between slashes: its tokens, or `**`. */
type Part = readonly Token[] | "**";

interface Pattern {
  /** Anchored patterns match the path's parts; others its last part only (`parts` has one). */
  readonly anchored: boolean;
  readonly parts: readonly Part[];
  readonly negated: boolean;
  readonly dirOnly: boolean;
  /** The pattern itself when it is a plain name matched at any depth (`node_modules`), else null. */
  readonly plainName: string | null;
}

interface RuleFile {
  readonly dir: string;
  readonly patterns: readonly Pattern[];
}

/** The tokens of one pattern part (no `/` in it). */
function tokens(glob: readonly string[]): Token[] {
  const out: Token[] = [];
  for (let at = 0; at < glob.length; at += 1) {
    const char = glob[at]!;
    if (char === "\\" && at + 1 < glob.length) {
      at += 1;
      out.push({ kind: "char", char: glob[at]! });
    } else if (char === "*") {
      if (out.at(-1)?.kind !== "star") out.push({ kind: "star" });
    } else if (char === "?") {
      out.push({ kind: "one" });
    } else if (char === "[") {
      const parsed = charClass(glob, at);
      if (parsed === null) out.push({ kind: "char", char });
      else {
        out.push(parsed.token);
        at = parsed.end;
      }
    } else {
      out.push({ kind: "char", char });
    }
  }
  return out;
}

/** The class opened at `start` and the index of its `]`, or null when it is not closed. */
function charClass(
  glob: readonly string[],
  start: number,
): { readonly token: Token; readonly end: number } | null {
  let at = start + 1;
  let negated = false;
  if (glob[at] === "!" || glob[at] === "^") {
    negated = true;
    at += 1;
  }
  const ranges: [number, number][] = [];
  let first = true;
  for (; at < glob.length; at += 1) {
    let char = glob[at]!;
    if (char === "]" && !first) return { token: { kind: "class", negated, ranges }, end: at };
    first = false;
    if (char === "\\" && at + 1 < glob.length) {
      at += 1;
      char = glob[at]!;
    }
    const low = char.codePointAt(0)!;
    if (glob[at + 1] === "-" && at + 2 < glob.length && glob[at + 2] !== "]") {
      let high = glob[at + 2]!;
      at += 2;
      if (high === "\\" && at + 1 < glob.length) {
        at += 1;
        high = glob[at]!;
      }
      ranges.push([low, high.codePointAt(0)!]);
    } else {
      ranges.push([low, low]);
    }
  }
  return null;
}

function matchesOne(token: Token, char: string): boolean {
  switch (token.kind) {
    case "char":
      return token.char === char;
    case "one":
      return true;
    case "star":
      return false;
    case "class": {
      const code = char.codePointAt(0)!;
      const inside = token.ranges.some(([low, high]) => code >= low && code <= high);
      return inside !== token.negated;
    }
  }
}

/**
 * True when the tokens match the whole of `text` (one path part): the greedy match with one star
 * to fall back to, at most (tokens x characters) steps.
 */
function matchPart(
  pattern: readonly Token[],
  text: readonly string[],
  budget: MatchBudget,
): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    budget.take();
    const token = pattern[p];
    if (token?.kind === "star") {
      star = p;
      resume = t;
      p += 1;
    } else if (token !== undefined && matchesOne(token, text[t]!)) {
      p += 1;
      t += 1;
    } else if (star >= 0) {
      p = star + 1;
      resume += 1;
      t = resume;
    } else {
      return false;
    }
  }
  while (pattern[p]?.kind === "star") p += 1;
  return p === pattern.length;
}

/** True when the pattern's parts match the path's parts; `**` parts match any number of them. */
function matchParts(
  parts: readonly Part[],
  path: readonly (readonly string[])[],
  budget: MatchBudget,
): boolean {
  const memo = new Map<number, boolean>();
  const at = (i: number, j: number): boolean => {
    if (i === parts.length) return j === path.length;
    const key = i * (path.length + 1) + j;
    const known = memo.get(key);
    if (known !== undefined) return known;
    budget.take();
    const part = parts[i]!;
    let result: boolean;
    if (part === "**") {
      // A trailing `/**` matches everything inside, so at least one part; elsewhere zero or more.
      const least = i === parts.length - 1 ? 1 : 0;
      result = false;
      for (let k = j + least; k <= path.length && !result; k += 1) {
        budget.take();
        result = at(i + 1, k);
      }
    } else {
      result = j < path.length && matchPart(part, path[j]!, budget) && at(i + 1, j + 1);
    }
    memo.set(key, result);
    return result;
  };
  return at(0, 0);
}

/** The trailing spaces of `line` cut, unless escaped with `\`. */
function trimEnd(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === " " && line[end - 2] !== "\\") end -= 1;
  return line.slice(0, end);
}

/** One line of a `.gitignore`, or null for a blank line, a comment or a pattern too long. */
function parseLine(raw: string): Pattern | null {
  let line = trimEnd(raw.replace(/\r$/, ""));
  if (line === "" || line.startsWith("#") || line.length > MAX_PATTERN_CHARS) return null;
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
  const parts: Part[] = [];
  for (const part of line.split("/")) {
    // A run of `**` parts matches what one does: merged, so it cannot multiply the work.
    if (anchored && part === "**") {
      if (parts.at(-1) !== "**") parts.push("**");
    } else {
      parts.push(tokens([...part]));
    }
  }
  if (parts.filter((part) => part === "**").length > MAX_GLOBSTARS) return null;
  const plainName =
    !anchored && /^[A-Za-z0-9._-]+$/.test(line) && line !== "." && line !== ".." ? line : null;
  return { anchored, parts, negated, dirOnly, plainName };
}

function patternMatches(pattern: Pattern, rel: string, budget: MatchBudget): boolean {
  const parts = rel.split("/").map((part) => [...part]);
  if (pattern.anchored) return matchParts(pattern.parts, parts, budget);
  const only = pattern.parts[0];
  return only !== undefined && only !== "**" && matchPart(only, parts.at(-1) ?? [], budget);
}

/** The story's ignore rules, from its `.gitignore` files. */
export class IgnoreRules {
  /** Deepest folder first, so a deeper file decides before a higher one. */
  readonly #files: readonly RuleFile[];
  /** The budget every match counts against; unbounded until `withBudget`. */
  #budget = new MatchBudget(Number.POSITIVE_INFINITY);

  constructor(files: readonly IgnoreFile[]) {
    // The total is capped too, shallowest files first, so no set of files makes every match
    // slow; the rules past the cap ignore nothing.
    let budget = MAX_PATTERNS_TOTAL;
    this.#files = files
      .map((file) => ({ dir: file.dir.replace(/^\/+|\/+$/g, ""), text: file.text }))
      .toSorted((a, b) => depth(a.dir) - depth(b.dir))
      .slice(0, MAX_FILES)
      .map((file) => {
        const patterns = file.text
          .split("\n")
          .slice(0, Math.min(MAX_PATTERNS_PER_FILE, budget))
          .map(parseLine)
          .filter((pattern) => pattern !== null);
        budget -= patterns.length;
        return { dir: file.dir, patterns };
      })
      .filter((file) => file.patterns.length > 0)
      .toSorted((a, b) => depth(b.dir) - depth(a.dir));
  }

  /** Counts every later match against `budget`, which may be shared with other rules. */
  withBudget(budget: MatchBudget): this {
    this.#budget = budget;
    return this;
  }

  /**
   * True when a `!` rule could re-include a path named `name` or below one: its last part matches
   * the name, or is `**`. An in-box exclude of the name could not honour it.
   */
  reincludes(name: string): boolean {
    const chars = [...name];
    return this.#files.some((file) =>
      file.patterns.some((pattern) => {
        if (!pattern.negated) return false;
        const last = pattern.parts.at(-1);
        return last === undefined || last === "**" || matchPart(last, chars, this.#budget);
      }),
    );
  }

  /**
   * The plain names (`node_modules`, `dist/`) the root `.gitignore` ignores at any depth, sorted,
   * each once. A deeper file's names apply only below its folder, so they are not listed.
   */
  get plainNames(): string[] {
    const names = new Set<string>();
    for (const file of this.#files) {
      if (file.dir !== "") continue;
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
        if (patternMatches(pattern, rel, this.#budget)) return !pattern.negated;
      }
    }
    return null;
  }

  /**
   * True when git would ignore the repo-relative `path` (a file unless `isDir`): it or a folder
   * above it is ignored. A tracked path is never ignored; the caller checks that. Throws
   * `IgnoreBudgetExceeded` past the budget, or for a path deeper than `MAX_MATCH_DEPTH`.
   */
  ignored(path: string, isDir = false): boolean {
    const parts = path.split("/");
    if (parts.length > MAX_MATCH_DEPTH) {
      throw new IgnoreBudgetExceeded(`a path deeper than ${MAX_MATCH_DEPTH} parts is not matched.`);
    }
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
