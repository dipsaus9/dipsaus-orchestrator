// Story status commits on a story branch (DIPO-112; 0010 section 2a): the claim, In Review, park
// and unpark each commit only the story's own task file, as `<ID>: status <state>`, and push the
// branch without force. Both helpers run inside a queue item the caller already holds.

import { FETCH_CONFIG, type GitLocation } from "./hardened";
import type { GitSession } from "./office";
import { EXTERNAL_STEP_TIMEOUT_MS, GitError, type GitResult, isTimedOut } from "./runner";

/** What the push of a story branch did. */
export interface PushResult {
  readonly pushed: boolean;
  /** True when the remote refused a non-fast-forward update (0010: park `conflict`). */
  readonly rejected: boolean;
  /** Why the push failed, or null; null with `pushed` false means the office has no remote. */
  readonly error: string | null;
}

/** Paths in `git status --porcelain=v1 -z` output, both sides of a rename or copy. */
export function statusPaths(output: string): string[] {
  const records = output.split("\0").filter((record) => record !== "");
  const paths: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? "";
    paths.push(record.slice(3));
    const x = record[0];
    if (x === "R" || x === "C") {
      i += 1;
      const from = records[i];
      if (from !== undefined) paths.push(from);
    }
  }
  return paths;
}

/**
 * Commits the task file `taskFile` (repo-relative) alone as `message`: it is staged and committed
 * with literal pathspecs limited to it, so anything else staged stays staged and out of the
 * commit. Returns the commit, or null when the task file has no change. A failed commit throws
 * `git.failed`.
 */
export async function commitTaskFile(
  git: GitSession,
  location: GitLocation,
  taskFile: string,
  message: string,
): Promise<string | null> {
  const changed = statusPaths(
    await git.ok(location, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  );
  if (!changed.includes(taskFile)) return null;
  await git.ok(location, ["--literal-pathspecs", "add", "--", taskFile]);
  const args = ["commit", "--quiet", "--no-verify", "-m", message];
  const committed = await git.step(location, ["--literal-pathspecs", ...args, "--", taskFile], {
    timeoutMs: EXTERNAL_STEP_TIMEOUT_MS,
  });
  if (committed.code !== 0) {
    throw new GitError(
      "git.failed",
      `git commit failed: ${committed.stderr.trim() || committed.stdout.trim() || `exit ${committed.code}`}`,
      false,
      { args: ["commit"], code: committed.code, stderr: committed.stderr },
    );
  }
  return (await git.ok(location, ["rev-parse", "--verify", "HEAD"])).trim();
}

/**
 * Pushes `branch` to `remote` without force. Without a configured remote nothing is pushed and
 * `error` is null; a failed or timed-out push is returned, never thrown.
 */
export async function pushBranch(
  git: GitSession,
  remote: string,
  branch: string,
): Promise<PushResult> {
  const url = await git.step(git.repository, ["config", "--get", `remote.${remote}.url`]);
  if (url.code !== 0 || url.stdout.trim() === "") {
    return { pushed: false, rejected: false, error: null };
  }
  const ref = `refs/heads/${branch}`;
  const pushed = await git
    .step(git.repository, ["push", "--quiet", "--no-verify", remote, `${ref}:${ref}`], {
      config: FETCH_CONFIG,
      timeoutMs: EXTERNAL_STEP_TIMEOUT_MS,
    })
    .catch((error: unknown): GitResult => {
      if (isTimedOut(error)) return { code: null, stdout: "", stderr: error.message };
      throw error;
    });
  if (pushed.code === 0) return { pushed: true, rejected: false, error: null };
  const stderr = pushed.stderr.trim();
  return {
    pushed: false,
    rejected: /non-fast-forward|\[rejected\]|fetch first/.test(stderr),
    error: `pushing ${branch} to ${remote} failed (${stderr || `exit ${pushed.code}`})`,
  };
}
