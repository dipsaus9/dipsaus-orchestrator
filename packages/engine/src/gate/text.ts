// The text definitions of 0012 section 3: characters and word matches.

/** Text after NFC normalisation, trimmed of leading and trailing whitespace. */
export function clean(text: string): string {
  return text.normalize("NFC").trim();
}

/** The number of characters: Unicode code points of `clean(text)`. */
export function characters(text: string): number {
  let count = 0;
  for (const _ of clean(text)) count += 1;
  return count;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A code span: the text between a pair of backticks on one line. */
const CODE_SPAN = /`[^`\n]*`/g;
/** A run of non-whitespace characters: the candidates for a path token. */
const RUN = /\S+/g;
/** Opening brackets and quotes that wrap a path token, and closing ones plus sentence punctuation. */
const WRAP_START = /^[([{"'`]*/;
const WRAP_END = /[)\]}"'`.,;:!?]*$/;

/**
 * True when a run (without its wrapping brackets, quotes and sentence punctuation) looks like a
 * path (DIPO-218): it contains a slash and starts with `/`, `~`, `./` or `../`, or ends with a
 * slash, or its last segment ends with a file extension. So `TBD/later` and `and/or,etc` are prose.
 */
function looksLikePath(core: string): boolean {
  if (!core.includes("/")) return false;
  if (/^(\/|~|\.{1,2}\/)/.test(core) || core.endsWith("/")) return true;
  return /\.[\p{L}\p{N}]+$/u.test(core.slice(core.lastIndexOf("/") + 1));
}

/**
 * Marks a masked character: neither a letter, a digit nor whitespace, so it ends a word (a match may
 * sit next to it) but cannot stand in for the space inside a phrase such as `works well`.
 */
const MASK = "\u0000";

/**
 * The text with every code span and path token masked out, so no match can lie inside one. A path
 * token is masked without its wrapping brackets, quotes and sentence punctuation (DIPO-218). Code
 * spans are found in the original text, so a slash inside one still makes its run a path token.
 */
function outsideCodeAndPaths(text: string): string {
  const units = text.split("");
  for (const match of text.matchAll(CODE_SPAN)) {
    units.fill(MASK, match.index, match.index + match[0].length);
  }
  for (const match of text.matchAll(RUN)) {
    const run = match[0];
    const lead = WRAP_START.exec(run)?.[0].length ?? 0;
    const rest = run.slice(lead);
    const core = rest.slice(0, rest.length - (WRAP_END.exec(rest)?.[0].length ?? 0));
    if (looksLikePath(core)) {
      units.fill(MASK, match.index + lead, match.index + lead + core.length);
    }
  }
  return units.join("");
}

/**
 * True when `phrase` occurs in `text` as a word match: case-insensitive, and the match starts and
 * ends at the text's start or end or next to a character outside `\p{L}\p{N}`. So `etc` does not
 * match `fetch` and `properly` does not match `improperly`. A match inside a code span or a path
 * token does not count (DIPO-170), so `/etc/zprofile` does not match `etc`. A run only counts as a
 * path token when it looks like one (DIPO-218), so `etc/zprofile` and `and/or,etc` do match `etc`.
 */
export function wordMatch(text: string, phrase: string): boolean {
  const needle = clean(phrase);
  if (needle === "") return false;
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, "iu");
  return pattern.test(outsideCodeAndPaths(text.normalize("NFC")));
}
