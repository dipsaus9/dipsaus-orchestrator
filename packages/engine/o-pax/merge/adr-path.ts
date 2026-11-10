// The ADR folder (0002). A PR that changes anything under `docs/decisions/` needs the maintainer's
// approval of the wording before it merges, whoever opened it (CLAUDE.md): its merge gate waits for
// the maintainer, and a backlog PR gets no auto-merge. The changed paths are the PR's diff as for
// the release path (`release-path.ts`): merge base to head, renames as a delete and an add, so a
// file moved out of the folder still touches it.

/** The ADR folder, lower case; paths are compared in lower case because the file system may fold case. */
const ADR_FOLDER = "docs/decisions";

/**
 * Pure: the paths of `changed` in the ADR folder (any depth, any file type, any letter case), in
 * the order given, sorted.
 */
export function adrPathsOf(changed: readonly string[]): string[] {
  return changed
    .filter((path) => {
      const folded = path.toLowerCase();
      return folded === ADR_FOLDER || folded.startsWith(`${ADR_FOLDER}/`);
    })
    .toSorted();
}
