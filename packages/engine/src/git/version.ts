// The minimum git version (M0 review, DIPO-15): the conflict check and the branch deletes use
// `git merge-tree --write-tree` (0010), which git 2.38 added. Each office load checks
// `git --version` once.

export interface GitVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** The version as git printed it, for example `2.50.1 (Apple Git-155)`. */
  readonly text: string;
}

export const MIN_GIT_VERSION = { major: 2, minor: 38 } as const;

/**
 * Parses `git --version` output: `git version 2.38.0`, `git version 2.50.1 (Apple Git-155)`,
 * `git version 2.45.2.windows.1`. Null when the output is not a git version line.
 */
export function parseGitVersion(output: string): GitVersion | null {
  const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?(.*)$/.exec(output.trim());
  if (match === null) return null;
  const [, major, minor, patch, rest] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: patch === undefined ? 0 : Number(patch),
    text: `${major}.${minor}${patch === undefined ? "" : `.${patch}`}${rest ?? ""}`,
  };
}

/** True when `version` is at least 2.38. */
export function isSupportedGitVersion(version: GitVersion): boolean {
  return (
    version.major > MIN_GIT_VERSION.major ||
    (version.major === MIN_GIT_VERSION.major && version.minor >= MIN_GIT_VERSION.minor)
  );
}

/** Null when `output` names a supported git; otherwise the reason the office is refused. */
export function checkGitVersion(output: string): string | null {
  const version = parseGitVersion(output);
  const min = `${MIN_GIT_VERSION.major}.${MIN_GIT_VERSION.minor}`;
  if (version === null) {
    return `\`git --version\` printed ${JSON.stringify(output.trim())}, which is not a git version; dipo needs git ${min} or later.`;
  }
  if (isSupportedGitVersion(version)) return null;
  return `git ${version.text} is older than ${min}, which \`git merge-tree --write-tree\` needs; upgrade git to ${min} or later.`;
}
