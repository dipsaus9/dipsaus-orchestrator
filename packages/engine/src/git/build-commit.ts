// How far an office's base has moved past the commit the daemon's binary was built from (DIPO-198).
// Every file in the binary lies under `packages/`, so the base commits after the build commit that
// change files there are the ones a rebuild would bring in. Counted on the base as last fetched,
// with the office's own git, so no model or configuration is involved.

import type { GitSession, OfficeGit } from "./office";
import { GitError } from "./runner";

/** The directory every file of the binary lies under. */
export const ENGINE_PATH = "packages/";

/** Each git read of the count is killed after this long, so one count never holds the queue long. */
export const ENGINE_READ_TIMEOUT_MS = 10_000;

const BUILD_COMMIT = /^([0-9a-f]{7,40})(-dirty)?$/;

/** The commit hash of a build commit such as `1a2b3c4d5e6f` or `1a2b3c4d5e6f-dirty`, or null. */
export function buildCommitSha(buildCommit: string): string | null {
  return BUILD_COMMIT.exec(buildCommit)?.[1] ?? null;
}

/**
 * What one read of an office's engine commits after the build commit found: a count; `none` when
 * the repository lacks the build commit or the base is unknown or not fetched; `failed` when the
 * repository holds the build commit but a git read failed or timed out.
 */
export type EngineCommitsRead =
  | { readonly kind: "count"; readonly commits: number }
  | { readonly kind: "none" }
  | { readonly kind: "failed"; readonly detail: string };

export interface EngineCommitsOptions {
  /** The timeout of each git step; default `ENGINE_READ_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** `git` with `timeoutMs` on every step that sets none, the base resolution included. */
function bounded(git: GitSession, timeoutMs: number): GitSession {
  return {
    repository: git.repository,
    step: (location, args, options) => git.step(location, args, { timeoutMs, ...options }),
    ok: (location, args, options) => git.ok(location, args, { timeoutMs, ...options }),
  };
}

/**
 * Reads the number of commits on `<remote>/<base>` after the build commit that change files under
 * `packages/`, as one office queue item whose every step is bounded by `timeoutMs`. The reads
 * (`cat-file`, `symbolic-ref`, `rev-parse`, `rev-list`) take no lock and change nothing.
 */
export async function readEngineCommitsAfter(
  office: OfficeGit,
  buildCommit: string,
  options: EngineCommitsOptions = {},
): Promise<EngineCommitsRead> {
  const sha = buildCommitSha(buildCommit);
  if (sha === null) return { kind: "none" };
  const timeoutMs = options.timeoutMs ?? ENGINE_READ_TIMEOUT_MS;
  try {
    return await office.run(async (session): Promise<EngineCommitsRead> => {
      const git = bounded(session, timeoutMs);
      const present = await git.step(git.repository, ["cat-file", "-e", `${sha}^{commit}`]);
      if (present.code !== 0) return { kind: "none" };
      const base = await office.resolveBaseIn(git).catch((error: unknown) => {
        // No base branch is a fact about the office, not a failed read: nothing can be said.
        if (error instanceof GitError && error.code === "git.baseUnknown") return null;
        throw error;
      });
      if (base === null) return { kind: "none" };
      const ref = `refs/remotes/${office.settings.remote}/${base}`;
      const tip = await git.step(git.repository, [
        "rev-parse",
        "--verify",
        "--quiet",
        `${ref}^{commit}`,
      ]);
      if (tip.code !== 0) return { kind: "none" };
      const count = await git.step(git.repository, [
        "rev-list",
        "--count",
        `${sha}..${tip.stdout.trim()}`,
        "--",
        ENGINE_PATH,
      ]);
      if (count.code !== 0) {
        return { kind: "failed", detail: count.stderr.trim() || `exit ${count.code}` };
      }
      const value = Number.parseInt(count.stdout.trim(), 10);
      return Number.isInteger(value) && value >= 0
        ? { kind: "count", commits: value }
        : { kind: "failed", detail: `rev-list printed ${JSON.stringify(count.stdout.trim())}` };
    });
  } catch (error) {
    return { kind: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The number of commits on `<remote>/<base>` after the build commit that change files under
 * `packages/`. Null when the office's repository does not hold the build commit, the base is
 * unknown or not fetched, or git fails: nothing can be said, so nothing is shown.
 */
export async function engineCommitsAfter(
  office: OfficeGit,
  buildCommit: string,
  options: EngineCommitsOptions = {},
): Promise<number | null> {
  const read = await readEngineCommitsAfter(office, buildCommit, options);
  return read.kind === "count" ? read.commits : null;
}
