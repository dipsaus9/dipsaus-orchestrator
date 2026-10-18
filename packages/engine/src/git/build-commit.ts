// How far an office's base has moved past the commit the daemon's binary was built from (DIPO-198).
// Every file in the binary lies under `packages/`, so the base commits after the build commit that
// change files there are the ones a rebuild would bring in. Counted on the base as last fetched,
// with the office's own git, so no model or configuration is involved.

import type { OfficeGit } from "./office";

/** The directory every file of the binary lies under. */
export const ENGINE_PATH = "packages/";

const BUILD_COMMIT = /^([0-9a-f]{7,40})(-dirty)?$/;

/** The commit hash of a build commit such as `1a2b3c4d5e6f` or `1a2b3c4d5e6f-dirty`, or null. */
export function buildCommitSha(buildCommit: string): string | null {
  return BUILD_COMMIT.exec(buildCommit)?.[1] ?? null;
}

/**
 * The number of commits on `<remote>/<base>` after the build commit that change files under
 * `packages/`. Null when the office's repository does not hold the build commit, the base is
 * unknown or not fetched, or git fails: nothing can be said, so nothing is shown.
 */
export async function engineCommitsAfter(
  office: OfficeGit,
  buildCommit: string,
): Promise<number | null> {
  const sha = buildCommitSha(buildCommit);
  if (sha === null) return null;
  try {
    return await office.run(async (git) => {
      const base = await office.resolveBaseIn(git);
      const ref = `refs/remotes/${office.settings.remote}/${base}`;
      const held = await git.step(git.repository, ["cat-file", "-e", `${sha}^{commit}`]);
      if (held.code !== 0) return null;
      const tip = await git.step(git.repository, [
        "rev-parse",
        "--verify",
        "--quiet",
        `${ref}^{commit}`,
      ]);
      if (tip.code !== 0) return null;
      const count = await git.step(git.repository, [
        "rev-list",
        "--count",
        `${sha}..${tip.stdout.trim()}`,
        "--",
        ENGINE_PATH,
      ]);
      if (count.code !== 0) return null;
      const value = Number.parseInt(count.stdout.trim(), 10);
      return Number.isInteger(value) && value >= 0 ? value : null;
    });
  } catch {
    return null;
  }
}
