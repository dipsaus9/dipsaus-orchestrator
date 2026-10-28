// The git and Backlog CLI steps of verify and commit in a story worktree (DIPO-49; 0010 section 7,
// 0014 section 3). `gitStoryOps` is the real one: every step is an office git queue item through
// the hardened runner, so a worktree whose git links changed is refused (`git.worktreeTampered`).
// Tests of the flow use a fake; story-git.ci.test.ts runs this one on real git. Every Backlog CLI
// call runs in dipo's own copy of the story's backlog, never in the worktree (`inStoryBacklog`,
// 0021 section 14).

import { createHash } from "node:crypto";

import type { OfficeId } from "@dipsaus-orchestrator/contract";

import { viewStory } from "../backlog/fields/write";
import { type BacklogCli, runBacklog } from "../backlog/runner";
import type { GitLocation } from "../git/hardened";
import type { OfficeGit } from "../git/office";
import { GitError } from "../git/runner";
import { type PushResult, pushBranch, statusPaths } from "../git/write";
import { editInStoryBacklog, inStoryBacklog, repoPath } from "../worktree/claim";

import { type BackstopSnapshot, readBackstop } from "./backstop";

/** The Backlog.md status a story reaches when verify and commit pass (0012). */
export const IN_REVIEW_STATUS = "In Review";

export type { PushResult } from "../git/write";

/** The story as the Backlog CLI shows it in its worktree. */
export interface WorktreeStory {
  /** Repo-relative path of the task file. */
  readonly taskFile: string;
  readonly title: string;
  readonly status: string;
  /** Criterion numbers as Backlog.md prints them. */
  readonly criteria: readonly number[];
}

/** The git steps of a story run on dipo's own copy: the worktree and the branch. */
export interface StoryGit {
  snapshot(office: OfficeId, worktree: string): Promise<BackstopSnapshot>;
  /** Every modified, staged and untracked path (`git status --porcelain=v1 -z --untracked-files=all`). */
  changedPaths(office: OfficeId, worktree: string): Promise<string[]>;
  story(office: OfficeId, worktree: string, id: string): Promise<WorktreeStory>;
  /** A file's text at `sha`, or null when the commit has no such file. */
  showAt(office: OfficeId, worktree: string, sha: string, path: string): Promise<string | null>;
  /**
   * Checks off `criteria` and sets status In Review through the Backlog CLI, then commits the task
   * file alone as `<ID>: status In Review`. Returns the commit, or null when nothing changed.
   */
  markInReview(
    office: OfficeId,
    input: {
      readonly worktree: string;
      readonly story: string;
      readonly taskFile: string;
      readonly criteria: readonly number[];
    },
  ): Promise<string | null>;
  /** Pushes the branch without force. */
  push(office: OfficeId, branch: string): Promise<PushResult>;
  /**
   * `git diff --stat <from>` of the worktree, uncommitted changes included; with `branch` (a box
   * run, DIPO-273) the branch tip against `from`, on the repository without a work tree.
   */
  diffstat(office: OfficeId, worktree: string, from: string, branch?: string): Promise<string>;
  /** The paths that differ between `from` and the tip of `branch`, on the repository (DIPO-273). */
  changedFiles(office: OfficeId, branch: string, from: string): Promise<string[]>;
}

type WorktreeLocation = Extract<GitLocation, { kind: "worktree" }>;

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

function at(git: OfficeGit, worktree: string): WorktreeLocation {
  return git.worktreeLocation(worktree) as WorktreeLocation;
}

/** Steps on the office git and the Backlog CLI. */
export function gitStoryOps(deps: {
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  readonly cli: BacklogCli;
}): StoryGit {
  const gitOf = (office: OfficeId): OfficeGit => {
    const git = deps.git(office);
    if (git === undefined) throw new Error(`Office ${office} has no git attached.`);
    return git;
  };
  return {
    snapshot: (office, worktree) => readBackstop(gitOf(office), worktree),
    changedPaths: (office, worktree) => {
      const git = gitOf(office);
      return git.run(async (session) =>
        statusPaths(
          await session.ok(at(git, worktree), [
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
          ]),
        ),
      );
    },
    story: (office, worktree, id) => {
      const git = gitOf(office);
      return git.run((session) =>
        inStoryBacklog(git, session, at(git, worktree), id, async (backlog) => {
          const view = await viewStory({ cli: deps.cli, cwd: backlog.cwd, id });
          return {
            taskFile: repoPath(backlog.cwd, view.file),
            title: view.title,
            status: view.status,
            criteria: view.acceptanceCriteria.map((criterion) => criterion.index),
          };
        }),
      );
    },
    showAt: (office, worktree, sha, path) => {
      const git = gitOf(office);
      return git.run(async (session) => {
        const shown = await session.step(at(git, worktree), ["show", `${sha}:${path}`]);
        return shown.code === 0 ? shown.stdout : null;
      });
    },
    markInReview: (office, input) => {
      const git = gitOf(office);
      return git.run(async (session) => {
        const location = at(git, input.worktree);
        // Only the task file: anything else staged stays out of this commit.
        const edit = await editInStoryBacklog(
          git,
          session,
          location,
          input.story,
          `${input.story}: status ${IN_REVIEW_STATUS}`,
          async (backlog) => {
            await runBacklog(deps.cli, backlog.cwd, [
              "task",
              "edit",
              input.story,
              ...input.criteria.flatMap((n) => ["--check-ac", String(n)]),
              "--status",
              IN_REVIEW_STATUS,
            ]);
            const back = await viewStory({ cli: deps.cli, cwd: backlog.cwd, id: input.story });
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
    diffstat: (office, worktree, from, branch) => {
      const git = gitOf(office);
      return git.run(async (session) =>
        (branch === undefined
          ? await session.ok(at(git, worktree), ["diff", "--stat", from])
          : await session.ok(session.repository, ["diff", "--stat", from, `refs/heads/${branch}`])
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
