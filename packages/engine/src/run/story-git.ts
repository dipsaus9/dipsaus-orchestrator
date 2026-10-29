// The git and story steps of a story run at done (DIPO-49; 0010, 0014 section 3), on the story
// branch in the repository: a story has no worktree. `gitStoryOps` is the real one: every step is
// an office git queue item through the hardened runner, and every story read and edit goes through
// the StoryStore's story lane. Tests of the flow use a fake; story-git.ci.test.ts runs this one on
// real git.

import { createHash } from "node:crypto";

import type { OfficeId } from "@dipsaus-orchestrator/contract";

import type { OfficeGit } from "../git/office";
import { GitError } from "../git/runner";
import { type PushResult, pushBranch } from "../git/write";
import type { StoryStore } from "../story-store/store";

/** The Backlog.md status a story reaches when verify and commit pass (0012). */
export const IN_REVIEW_STATUS = "In Review";

export type { PushResult } from "../git/write";

/** The story as committed at the tip of its branch. */
export interface BranchStory {
  /** Repo-relative path of the task file. */
  readonly taskFile: string;
  readonly title: string;
  readonly status: string;
  /** Criterion numbers as Backlog.md prints them. */
  readonly criteria: readonly number[];
}

/** The git steps of a story run on its branch. */
export interface StoryGit {
  /** The tip of `branch`, or null when it is gone. */
  tip(office: OfficeId, branch: string): Promise<string | null>;
  story(office: OfficeId, branch: string, id: string): Promise<BranchStory>;
  /** A file's text at `sha`, or null when the commit has no such file. */
  showAt(office: OfficeId, sha: string, path: string): Promise<string | null>;
  /**
   * Checks off `criteria` and sets status In Review through the story store, then commits the
   * task file alone on the branch as `<ID>: status In Review`. Returns the commit, or null when nothing
   * changed.
   */
  markInReview(
    office: OfficeId,
    input: {
      readonly branch: string;
      readonly story: string;
      readonly taskFile: string;
      readonly criteria: readonly number[];
    },
  ): Promise<string | null>;
  /** Pushes the branch without force. */
  push(office: OfficeId, branch: string): Promise<PushResult>;
  /** `git diff --stat <from> <branch tip>`, on the repository. */
  diffstat(office: OfficeId, branch: string, from: string): Promise<string>;
  /** The paths that differ between `from` and the tip of `branch`, on the repository (DIPO-273). */
  changedFiles(office: OfficeId, branch: string, from: string): Promise<string[]>;
}

/**
 * Pure: the code tree key (0010 section 7) of `git ls-tree -r -z HEAD` output: sha256 of its
 * entries without the story's own task file.
 */
export function codeTreeKeyOf(tree: string, taskFile: string): string {
  const kept = tree
    .split("\0")
    .filter((entry) => entry !== "" && entry.slice(entry.indexOf("\t") + 1) !== taskFile);
  return createHash("sha256").update(kept.join("\0")).digest("hex");
}

/** Steps on the office git and the story store. */
export function gitStoryOps(deps: {
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  readonly stories: StoryStore;
}): StoryGit {
  const gitOf = (office: OfficeId): OfficeGit => {
    const git = deps.git(office);
    if (git === undefined) throw new Error(`Office ${office} has no git attached.`);
    return git;
  };
  return {
    tip: (office, branch) => {
      const git = gitOf(office);
      return git.run(async (session) => {
        const found = await session.step(session.repository, [
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/heads/${branch}^{commit}`,
        ]);
        return found.code === 0 ? found.stdout.trim() : null;
      });
    },
    story: (office, branch, id) => {
      const git = gitOf(office);
      return git.run(async (session) => {
        const { view, file } = await deps.stories.viewOnBranch(git, session, { branch, story: id });
        return {
          taskFile: file,
          title: view.title,
          status: view.status,
          criteria: view.acceptanceCriteria.map((criterion) => criterion.index),
        };
      });
    },
    showAt: (office, sha, path) => {
      const git = gitOf(office);
      return git.run(async (session) => {
        const shown = await session.step(session.repository, ["show", `${sha}:${path}`]);
        return shown.code === 0 ? shown.stdout : null;
      });
    },
    markInReview: (office, input) => {
      const git = gitOf(office);
      return git.run(async (session) => {
        // Only the task file.
        const edit = await deps.stories.editOnBranch(
          git,
          session,
          input,
          `${input.story}: status ${IN_REVIEW_STATUS}`,
          async (story) => {
            await story.setStatus(IN_REVIEW_STATUS, input.criteria);
            const back = await story.view();
            if (back.status !== IN_REVIEW_STATUS) {
              throw new GitError(
                "verify.statusNotWritten",
                `The Backlog CLI left ${input.story} at ${back.status}, not ${IN_REVIEW_STATUS}.`,
              );
            }
          },
        );
        return edit.commit;
      });
    },
    push: (office, branch) => {
      const git = gitOf(office);
      return git.run((session) => pushBranch(session, git.settings.remote, branch));
    },
    diffstat: (office, branch, from) => {
      const git = gitOf(office);
      return git.run(async (session) =>
        (
          await session.ok(session.repository, ["diff", "--stat", from, `refs/heads/${branch}`])
        ).trimEnd(),
      );
    },
    changedFiles: (office, branch, from) => {
      const git = gitOf(office);
      return git.run(async (session) =>
        (
          await session.ok(session.repository, [
            "diff",
            "--name-only",
            "-z",
            from,
            `refs/heads/${branch}`,
          ])
        )
          .split("\0")
          .filter((path) => path !== ""),
      );
    },
  };
}
