// The story's diff as the verdict checks it (0019 section 5): for each changed path, the lines of
// the file at the reviewed commit that lie inside a hunk of the story's diff, by line number. A
// blocking scope, security or correctness finding must point at one of them and quote it. Pure.

/** The new-side lines of one changed file inside its hunks, by line number. */
export interface DiffFile {
  readonly path: string;
  readonly lines: ReadonlyMap<number, string>;
}

/** The story's diff from the merge base at the reviewed commit, without its own task file. */
export interface StoryDiff {
  readonly files: ReadonlyMap<string, DiffFile>;
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

const ESCAPES: Readonly<Record<string, string>> = {
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  '"': '"',
  "\\": "\\",
};

/** A path as git prints it: plain, or quoted with C escapes and octal bytes. */
function unquote(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"') || path.length < 2) return path;
  const bytes: number[] = [];
  const body = path.slice(1, -1);
  const encoder = new TextEncoder();
  for (let at = 0; at < body.length; at += 1) {
    const char = body[at] ?? "";
    if (char !== "\\") {
      bytes.push(...encoder.encode(char));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(body.slice(at + 1));
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8));
      at += 3;
      continue;
    }
    const next = body[at + 1] ?? "";
    bytes.push(...encoder.encode(ESCAPES[next] ?? next));
    at += 1;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** The `b/` side a `+++` line names; null for a deleted file. */
function newPath(line: string): string | null {
  const name = unquote(line.slice("+++ ".length).replace(/\t.*$/, ""));
  if (name === "/dev/null") return null;
  return name.startsWith("b/") ? name.slice(2) : name;
}

/**
 * Pure: a unified `git diff` split into changed files and the new-side lines of their hunks. A
 * context line and an added line are lines of the file at the reviewed commit; a removed line is
 * not. A deleted file has no lines; a binary file has none either.
 */
export function parseStoryDiff(diff: string): StoryDiff {
  const files = new Map<string, DiffFile>();
  let lines: Map<number, string> | null = null;
  let next = 0;
  let left = 0;
  for (const line of diff.replace(/\r\n?/g, "\n").split("\n")) {
    if (line.startsWith("diff --git ")) {
      lines = null;
      left = 0;
      continue;
    }
    if (left === 0 && line.startsWith("+++ ")) {
      const path = newPath(line);
      lines = new Map();
      if (path !== null) files.set(path, { path, lines });
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk !== null && lines !== null) {
      next = Number(hunk[1]);
      left = hunk[2] === undefined ? 1 : Number(hunk[2]);
      continue;
    }
    if (left === 0 || lines === null) continue;
    // An empty line inside a hunk is a blank context line whose leading space was stripped.
    if (line.startsWith("+") || line.startsWith(" ") || line === "") {
      lines.set(next, line.slice(1));
      next += 1;
      left -= 1;
    }
    // `-` lines are the base's; `\ No newline at end of file` is no line.
  }
  return { files };
}
