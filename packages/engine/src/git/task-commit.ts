// Story branch helpers (DIPO-112; 0010 section 2a): the paths of a `git status` and the push of a
// story branch without force, run inside a queue item the caller already holds. A task file
// status commit goes through the backlog lane (DIPO-270); the unused one here is gone (DIPO-240).

import { FETCH_CONFIG } from "./hardened";
import type { GitSession } from "./office";
import { EXTERNAL_STEP_TIMEOUT_MS, type GitResult, isTimedOut } from "./runner";

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
