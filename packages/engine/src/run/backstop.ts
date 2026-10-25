// The git state of a story worktree (DIPO-49; 0008 section 2): its HEAD, its checked-out branch,
// the repository's stash and `git status --porcelain -- backlog .dipo`, read in one git queue item.
// A git-state park reads it when it resumes, as the run's new baseline (`park-resume.ts`), and the
// worker outcomes read whether the worktree holds work (`storyHoldsWork`).
//
// The compare after every worker turn is gone (DIPO-342): the developer works in its box, never in
// the Mac worktree, so no turn is compared with a run-start snapshot.
//
// Every read goes through the office git queue and the hardened runner, so a worktree whose git
// links changed is refused (`git.worktreeTampered`).

import type { GitLocation } from "../git/hardened";
import type { OfficeGit } from "../git/office";

/** The git state of a story worktree (all strings as git printed them). */
export interface BackstopSnapshot {
  /** `git rev-parse --verify HEAD`. */
  readonly head: string;
  /** `git symbolic-ref -q HEAD`; empty when HEAD is detached. */
  readonly branch: string;
  /** `git rev-parse -q --verify refs/stash`; empty when there is no stash. */
  readonly stash: string;
  /** `git status --porcelain=v1 -z --untracked-files=all -- backlog .dipo`. */
  readonly backlogStatus: string;
}

type WorktreeLocation = Extract<GitLocation, { kind: "worktree" }>;

/** Reads the snapshot of the story worktree at `worktree`, in one git queue item. */
export function readBackstop(git: OfficeGit, worktree: string): Promise<BackstopSnapshot> {
  return git.run(async (session) => {
    const location = git.worktreeLocation(worktree) as WorktreeLocation;
    const head = (await session.ok(location, ["rev-parse", "--verify", "HEAD"])).trim();
    const branch = await session.step(location, ["symbolic-ref", "-q", "HEAD"]);
    const stash = await session.step(location, ["rev-parse", "-q", "--verify", "refs/stash"]);
    const status = await session.ok(location, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--",
      "backlog",
      ".dipo",
    ]);
    return {
      head,
      branch: branch.code === 0 ? branch.stdout.trim() : "",
      stash: stash.code === 0 ? stash.stdout.trim() : "",
      backlogStatus: status,
    };
  });
}
