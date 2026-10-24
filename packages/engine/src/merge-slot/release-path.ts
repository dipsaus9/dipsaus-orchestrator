// The release path of a story PR (DIPO-331; the 0016 amendment of 2026-10-23, DIPO-321). The paths
// `.github/CODEOWNERS` assigns an owner need the maintainer's code owner approval before a PR that
// changes them merges, and for a PR opened with the maintainer's login that approval is the
// maintainer's bypass merge on the host. dipo never passes `--admin` or any other bypass, so the
// merge slot holds such a story PR for the maintainer: its merge gate waits for a hand merge only.
//
// - The list comes from the base, never from the PR: GitHub reads CODEOWNERS from the base branch,
//   so a PR cannot take itself out of it. GitHub uses the first of `.github/CODEOWNERS`,
//   `CODEOWNERS` and `docs/CODEOWNERS` that exists (`CODEOWNERS_LOCATIONS`), and so does dipo.
// - Every rule with an owner counts. In this repository every owner is the maintainer; an owner who
//   is someone else also needs an approval dipo cannot give, so holding the PR is the safe side.
// - The last rule that matches a path decides, as on GitHub; a rule without owners leaves the path
//   without one. The patterns follow GitHub's CODEOWNERS syntax: `*`, `**` and `?`, a leading `/`
//   anchors to the root, a slash inside the pattern anchors it too, a trailing `/` matches the
//   folder's contents, and a pattern that names a folder matches everything below it (except a
//   last segment of `*`, which GitHub documents as one level only). Negation (`!`) is not part of
//   GitHub's syntax and such a line is skipped, which can only hold more PRs, never fewer. A rule
//   with syntax the matcher does not model (`UNMODELLED`) fails closed: with an owner it matches
//   every path, without one none.
// - The changed paths are the PR's diff as GitHub shows it: merge base with the base to the head,
//   renames as a delete and an add, so a file moved out of the release path still touches it.

/** Where GitHub looks for CODEOWNERS on the base, in its order: the first that exists counts. */
export const CODEOWNERS_LOCATIONS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

/** One CODEOWNERS rule: its pattern as a matcher and whether it names an owner. */
export interface CodeownersRule {
  readonly pattern: string;
  readonly owned: boolean;
  readonly matches: (path: string) => boolean;
}

/** Pure: the rules of a CODEOWNERS file, in file order (comments, blanks and negations skipped). */
export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const tokens = raw.trim().split(/\s+/);
    const first = tokens[0] ?? "";
    if (first === "" || first.startsWith("#") || first.startsWith("!")) continue;
    const owners: string[] = [];
    for (const token of tokens.slice(1)) {
      if (token.startsWith("#")) break;
      owners.push(token);
    }
    const pattern = first.startsWith("\\#") ? first.slice(1) : first;
    const owned = owners.length > 0;
    rules.push({ pattern, owned, matches: unmodelled(pattern) ? () => owned : matcherOf(pattern) });
  }
  return rules;
}

/**
 * Syntax the matcher does not model: a backslash (other than the leading `\#` read above, so also
 * an escaped space, whose rest the line split takes for owners), `[`, `]`, `{`, `}` and control
 * characters. Such a rule fails closed: with an owner it matches every path, without one none,
 * so it can never take a path out of the release path.
 */
const UNMODELLED = "\\[]{}";

/** Pure: true when `pattern` holds syntax the matcher does not model (see `UNMODELLED`). */
function unmodelled(pattern: string): boolean {
  return Array.from(pattern).some((c) => {
    const code = c.charCodeAt(0);
    return UNMODELLED.includes(c) || code < 0x20 || code === 0x7f;
  });
}

/** Pure: the paths of `changed` whose last matching rule names an owner, sorted. */
export function releasePathsOf(
  rules: readonly CodeownersRule[],
  changed: readonly string[],
): string[] {
  const out = new Set<string>();
  for (const path of changed) {
    let owned = false;
    for (const rule of rules) if (rule.matches(path)) owned = rule.owned;
    if (owned) out.add(path);
  }
  return [...out].toSorted();
}

/** Pure: the regular expression body of one pattern segment run (`*`, `**`, `?`, literals). */
function globBody(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "*" && pattern[i + 1] === "*") {
      // `**/` is any number of folders, a trailing `**` anything below.
      if (pattern[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[\\^$.|+()[\]{}]/g, "\\$&");
  }
  return out;
}

/** Pure: a matcher of a repository path for one CODEOWNERS pattern (see the file comment). */
function matcherOf(pattern: string): (path: string) => boolean {
  const folder = pattern.endsWith("/");
  let body = folder ? pattern.slice(0, -1) : pattern;
  const anchored = body.includes("/");
  if (body.startsWith("/")) body = body.slice(1);
  if (body === "") return () => true;
  const prefix = anchored ? "" : "(?:.*/)?";
  const last = body.slice(body.lastIndexOf("/") + 1);
  // A folder's contents below it; a last segment of `*` is one level only.
  const below = folder ? "/.*" : last === "*" ? "" : "(?:/.*)?";
  const regex = new RegExp(`^${prefix}${globBody(body)}${below}$`);
  return (path) => regex.test(path);
}
