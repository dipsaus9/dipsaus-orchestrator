// The title of a story PR (0019 section 3; 0016 rule 1): `<type>(<ID>): <subject>`, built by code
// from the story so the `pr-title` check passes.

/** The subject limit of 0016 rule 1 (`STORY_PR_MAX_SUBJECT` of `scripts/check-pr-title.ts`). */
export const STORY_PR_MAX_SUBJECT = 100;

const TYPE_MAP: Readonly<Record<string, string>> = {
  feature: "feat",
  enhancement: "feat",
  bug: "fix",
  docs: "docs",
  spike: "docs",
};

/** The Conventional Commits type of a story type; `chore` for every other type and for none. */
export function storyPrCommitType(storyType: string | undefined): string {
  return TYPE_MAP[(storyType ?? "").trim().toLowerCase()] ?? "chore";
}

function withoutTrailing(text: string, drop: (char: string) => boolean): string {
  let end = text.length;
  while (end > 0 && drop(text[end - 1] as string)) end--;
  return text.slice(0, end);
}

/**
 * The subject of a story title: whitespace collapsed, trailing full stops removed, the first
 * letter lowercased unless the second character is uppercase (an acronym), and at most
 * `STORY_PR_MAX_SUBJECT` characters, cut on a word boundary.
 */
export function storyPrSubject(title: string): string {
  let text = withoutTrailing(title.replace(/\s+/g, " ").trim(), (c) => c === ".");
  const chars = [...text];
  const first = chars[0];
  const second = chars[1];
  if (first !== undefined && !(second !== undefined && second !== second.toLowerCase())) {
    chars[0] = first.toLowerCase();
    text = chars.join("");
  }
  const all = [...text];
  if (all.length > STORY_PR_MAX_SUBJECT) {
    const head = all.slice(0, STORY_PR_MAX_SUBJECT);
    // Cut at the last space when the next character starts a new word, else inside the last word.
    const space = all[STORY_PR_MAX_SUBJECT] === " " ? STORY_PR_MAX_SUBJECT : head.lastIndexOf(" ");
    text = (space > 0 ? all.slice(0, space) : head).join("");
  }
  return withoutTrailing(text, (c) => c === "." || c === " " || c === "," || c === ";");
}

/** The PR title of a story: `<type>(<ID>): <subject>`. */
export function storyPrTitle(story: {
  id: string;
  title: string;
  type: string | undefined;
}): string {
  return `${storyPrCommitType(story.type)}(${story.id}): ${storyPrSubject(story.title)}`;
}
