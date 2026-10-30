// The base tree's file paths the Ready gate passes in for R29 (DIPO-251): a bare test file name in
// a test plan check is covered when a Reference directory holds a file of that name on the base.
// The list is read from git's objects at the base commit, never from a checkout, and kept per
// office keyed by that commit, the key the gate's cached tasks use too (`cachedGateTasks`): the
// tree is listed once per base commit, and again only when the base moves.

import type { OfficeId } from "@dipsaus-orchestrator/contract";

import type { GitSession } from "../git/office";

/** The paths of `git ls-tree -r -z --name-only` output, in the order listed. */
export function treePaths(listing: string): string[] {
  return listing.split("\0").filter((path) => path !== "");
}

/** Every file path of the tree at `commit`, repo-relative, read through `session`. */
export async function listTreeFiles(session: GitSession, commit: string): Promise<string[]> {
  return treePaths(
    await session.ok(session.repository, [
      "ls-tree",
      "-r",
      "-z",
      "--name-only",
      "--full-tree",
      commit,
    ]),
  );
}

/** The base tree's file paths of each office, for the one base commit last listed. */
export class BaseTreeCache {
  readonly #entries = new Map<OfficeId, { readonly sha: string; readonly files: string[] }>();

  /**
   * The file paths at `sha`: the cached list when this office's last listing was at `sha`, else
   * `list(sha)`, which replaces it. Without `list` (no git session to read with) only a cached
   * list is returned, else undefined.
   */
  async filesAt(
    office: OfficeId,
    sha: string,
    list?: (sha: string) => Promise<string[]>,
  ): Promise<readonly string[] | undefined> {
    const cached = this.#entries.get(office);
    if (cached?.sha === sha) return cached.files;
    if (list === undefined) return undefined;
    const files = await list(sha);
    this.#entries.set(office, { sha, files });
    return files;
  }
}
