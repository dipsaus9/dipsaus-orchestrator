// Checks a pull request title against the grammar of decision 0016, rule 1:
//
//   <type>(<scope>)[!]: <subject>
//   type    = feat | fix | perf | refactor | docs | test | build | ci | chore | revert
//   scope   = DIPO-<n>[.<m>] | deps (chore or fix only) | main (chore only) | backlog
//   subject = 1 to 100 characters, no trailing period
//
// Usage in CI: PR_TITLE="<title>" bun scripts/check-pr-title.ts

export const TYPES = [
  "feat",
  "fix",
  "perf",
  "refactor",
  "docs",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
] as const;

export const MAX_SUBJECT_LENGTH = 100;

export type TitleCheck = { ok: true } | { ok: false; reason: string };

const HEADER = /^(?<type>[a-z]+)\((?<scope>[^()]*)\)(?<breaking>!?): (?<subject>.*)$/s;
const STORY_SCOPE = /^DIPO-[1-9][0-9]*(\.[1-9][0-9]*)?$/;

const SCOPE_TYPES: Record<string, readonly string[]> = {
  deps: ["chore", "fix"],
  main: ["chore"],
  backlog: TYPES,
};

const GRAMMAR =
  "expected `<type>(<scope>)[!]: <subject>`, for example `feat(DIPO-21): stream worker events to the TUI`";

export function checkPrTitle(title: string): TitleCheck {
  const match = HEADER.exec(title);
  if (match?.groups === undefined) {
    if (title.startsWith('Revert "')) {
      return { ok: false, reason: `retitle the revert as \`revert(DIPO-<n>): ...\`; ${GRAMMAR}` };
    }
    return { ok: false, reason: GRAMMAR };
  }
  const type = match.groups["type"] ?? "";
  const scope = match.groups["scope"] ?? "";
  const subject = match.groups["subject"] ?? "";

  if (!(TYPES as readonly string[]).includes(type)) {
    return { ok: false, reason: `unknown type \`${type}\`; allowed: ${TYPES.join(", ")}` };
  }

  if (!STORY_SCOPE.test(scope)) {
    const allowedTypes = SCOPE_TYPES[scope];
    if (allowedTypes === undefined) {
      return {
        ok: false,
        reason: `unknown scope \`${scope}\`; allowed: DIPO-<n>[.<m>], deps, main, backlog`,
      };
    }
    if (!allowedTypes.includes(type)) {
      return {
        ok: false,
        reason: `scope \`${scope}\` allows only the types ${allowedTypes.join(", ")}`,
      };
    }
  }

  const length = [...subject].length;
  if (length === 0) {
    return { ok: false, reason: "the subject is empty" };
  }
  if (length > MAX_SUBJECT_LENGTH) {
    return {
      ok: false,
      reason: `the subject has ${length} characters; the maximum is ${MAX_SUBJECT_LENGTH}`,
    };
  }
  if (subject.trim() !== subject) {
    return { ok: false, reason: "the subject starts or ends with whitespace" };
  }
  if (/[\r\n]/.test(subject)) {
    return { ok: false, reason: "the title spans more than one line" };
  }
  if (subject.endsWith(".")) {
    return { ok: false, reason: "the subject ends with a period" };
  }
  return { ok: true };
}

if (import.meta.main) {
  const title = process.env["PR_TITLE"];
  if (title === undefined) {
    console.error("PR_TITLE is not set");
    process.exit(2);
  }
  const result = checkPrTitle(title);
  if (result.ok) {
    console.log(`PR title ok: ${title}`);
  } else {
    console.error(`PR title rejected: ${title}\n${result.reason}`);
    process.exit(1);
  }
}
