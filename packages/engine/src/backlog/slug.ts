// The branch slug (0010 section 4, 0012 F15). Computed once from the title when the story gets its
// real id, then frozen in the field block's `branch`. `<ID>/<slug>` matches R18 by construction.

/** The longest slug R18 allows. */
export const SLUG_MAX = 40;

/** The slug for an empty result. */
export const EMPTY_SLUG = "story";

const STOP_WORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "of",
  "to",
  "for",
  "in",
  "on",
  "with",
]);

/** The slug of `title`, following the five steps of 0010 section 4. */
export function slug(title: string): string {
  // (1) NFKD-normalise, drop combining marks, lowercase.
  const plain = title.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  // (2) Each run of characters outside [a-z0-9] becomes a space; split into words.
  const words = plain
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((word) => word !== "");
  // (3) Drop stop words, unless nothing would remain.
  const kept = words.filter((word) => !STOP_WORDS.has(word));
  const chosen = kept.length > 0 ? kept : words;
  // (4) Join with `-` while the result stays within the limit; cut a single over-long first word.
  let result = "";
  for (const word of chosen) {
    if (result === "") {
      result = word.slice(0, SLUG_MAX);
      if (word.length > SLUG_MAX) break;
      continue;
    }
    if (result.length + 1 + word.length > SLUG_MAX) break;
    result = `${result}-${word}`;
  }
  // (5) An empty result is `story`.
  return result === "" ? EMPTY_SLUG : result;
}

/** The frozen branch `<ID>/<slug>` for a story with this id and title (F15, R18). */
export function branchFor(id: string, title: string): string {
  return `${id}/${slug(title)}`;
}
