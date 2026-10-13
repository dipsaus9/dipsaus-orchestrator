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

/**
 * True when `phrase` occurs in `text` as a word match: case-insensitive, and the match starts and
 * ends at the text's start or end or next to a character outside `\p{L}\p{N}`. So `etc` does not
 * match `fetch` and `properly` does not match `improperly`.
 */
export function wordMatch(text: string, phrase: string): boolean {
  const needle = clean(phrase);
  if (needle === "") return false;
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, "iu");
  return pattern.test(text.normalize("NFC"));
}
