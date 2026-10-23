// The park record at close-out (0019 section 9 step 1; 0012 F16 and 0010 section 3; DIPO-190 in
// DIPO-155). A park record exists only while a story is Parked, so the close-out commit that sets
// `Done` on the story branch also removes the F16 `park` block, through the single field write
// path, in the same commit. DIPO-129 merged with a stale `park: ambiguous-spec` block because
// nothing removed it.
//
// The story merge slot's close-out commit itself is DIPO-150's (the slot here serves backlog PRs
// only so far). This is the narrow seam it calls: `closeOutFields` is the edit inside the
// close-out's `editInStoryBacklog`, where the final summary (DIPO-154) joins it, and
// `gitCloseOutWriter` is the whole commit for a caller that adds nothing else.

import type { OfficeId } from "@dipsaus-orchestrator/contract";

import { type StoryTarget, viewStory, writeFields } from "../backlog/fields/write";
import { type BacklogCli, runBacklog } from "../backlog/runner";
import type { GitLocation } from "../git/hardened";
import type { OfficeGit } from "../git/office";
import { GitError } from "../git/runner";
import { editInStoryBacklog } from "../worktree/claim";

/** The status the close-out commit sets (0012). */
export const DONE_STATUS = "Done";

type WorktreeLocation = Extract<GitLocation, { kind: "worktree" }>;

/**
 * Inside the close-out edit, in dipo's own copy of the story's backlog: the F16 `park` block is
 * removed through the single field write path, then the status is set to `Done`. Throws a
 * `GitError` when the CLI left another status.
 */
export async function closeOutFields(target: StoryTarget): Promise<void> {
  await writeFields(target, (fields) => {
    const { park: _park, ...rest } = fields;
    return rest;
  });
  const before = await viewStory(target);
  if (before.status !== DONE_STATUS) {
    await runBacklog(target.cli, target.cwd, ["task", "edit", target.id, "--status", DONE_STATUS]);
  }
  const back = await viewStory(target);
  if (back.status !== DONE_STATUS) {
    throw new GitError(
      "closeOut.statusNotWritten",
      `The Backlog CLI left ${target.id} at ${back.status}, not ${DONE_STATUS}.`,
    );
  }
}

/** What the close-out commit needs. */
export interface CloseOutRequest {
  readonly story: string;
  readonly worktree: string;
}

/** The close-out commit on the story branch (the real one is `gitCloseOutWriter`). */
export interface CloseOutWriter {
  /** The commit, or null when the task file was already Done with no park record. */
  write(office: OfficeId, request: CloseOutRequest): Promise<{ readonly commit: string | null }>;
}

/**
 * The close-out commit with the Backlog CLI and the office git: `closeOutFields` in dipo's own copy
 * of the story's backlog, the task file committed alone as `<ID>: status Done`. Pushing is the
 * merge slot's step.
 */
export function gitCloseOutWriter(deps: {
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  readonly cli: BacklogCli;
}): CloseOutWriter {
  return {
    async write(office, request) {
      const git = deps.git(office);
      if (git === undefined) throw new Error(`Office ${office} has no git attached.`);
      return git.run(async (session) => {
        const location = git.worktreeLocation(request.worktree) as WorktreeLocation;
        const { commit } = await editInStoryBacklog(
          git,
          session,
          location,
          request.story,
          `${request.story}: status ${DONE_STATUS}`,
          (backlog) => closeOutFields({ cli: deps.cli, cwd: backlog.cwd, id: request.story }),
        );
        return { commit };
      });
    },
  };
}
