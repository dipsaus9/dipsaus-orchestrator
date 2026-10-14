// The git and Backlog CLI steps of verify and commit in a story worktree (DIPO-49; 0010 section 7,
// 0014 section 3). `gitStoryOps` is the real one: every step is an office git queue item through
// the hardened runner, so a worktree whose git links changed is refused (`git.worktreeTampered`).
// Tests of the flow use a fake; story-git.ci.test.ts runs this one on real git.

import { createHash } from "node:crypto";

import type { OfficeId } from "@dipsaus-orchestrator/contract";

import { viewStory } from "../backlog/fields/write";
import { statusPaths } from "../backlog/lane/lane";
import { type BacklogCli, runBacklog } from "../backlog/runner";
import { FETCH_CONFIG, type GitLocation } from "../git/hardened";
import type { OfficeGit } from "../git/office";
import { EXTERNAL_STEP_TIMEOUT_MS, GitError, type GitResult, isTimedOut } from "../git/runner";
import { repoPath } from "../worktree/claim";

import { type BackstopSnapshot, readBackstop } from "./backstop";

/** The Backlog.md status a story reaches when verify and commit pass (0012). */
export const IN_REVIEW_STATUS = "In Review";

/** What the push of a story branch did. */
export interface PushResult {
  readonly pushed: boolean;
  /** True when the remote refused a non-fast-forward update (0010: park `conflict`). */
  readonly rejected: boolean;
  /** Why the push failed, or null; null with `pushed` false means the office has no remote. */
  readonly error: string | null;
}

/** The story as the Backlog CLI shows it in its worktree. */
export interface WorktreeStory {
  /** Repo-relative path of the task file. */
  readonly taskFile: string;
  readonly title: string;
  readonly status: string;
  /** Criterion numbers as Backlog.md prints them. */
  readonly criteria: readonly number[];
}

/** The steps verify and commit runs in a story worktree. */
export interface StoryGit {
  snapshot(office: OfficeId, worktree: string): Promise<BackstopSnapshot>;
  /** Every modified, staged and untracked path (`git status --porcelain=v1 -z --untracked-files=all`). */
  changedPaths(office: OfficeId, worktree: string): Promise<string[]>;
  story(office: OfficeId, worktree: string, id: string): Promise<WorktreeStory>;
  /** A file's text at `sha`, or null when the commit has no such file. */
  showAt(office: OfficeId, worktree: string, sha: string, path: string): Promise<string | null>;
  /** Stages exactly `paths` and commits them; returns the commit, or null when nothing changed. */
  commitPaths(
    office: OfficeId,
    worktree: string,
    paths: readonly string[],
    message: string,
  ): Promise<string | null>;
  /** sha256 of `git ls-tree -r HEAD` without the story's own task file (0010 section 7). */
  codeTreeKey(office: OfficeId, worktree: string, taskFile: string): Promise<string>;
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
  /** `git diff --stat <from>` of the worktree, uncommitted changes included. */
  diffstat(office: OfficeId, worktree: string, from: string): Promise<string>;
}

type WorktreeLocation = Extract<GitLocation, { kind: "worktree" }>;

async function commitOrFail(
  run: (args: readonly string[]) => Promise<GitResult>,
  message: string,
): Promise<void> {
  const committed = await run(["commit", "--quiet", "--no-verify", "-m", message]);
  if (committed.code !== 0) {
    throw new GitError(
      "git.failed",
      `git commit failed: ${committed.stderr.trim() || committed.stdout.trim() || `exit ${committed.code}`}`,
    );
  }
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
      return git.run(async () => {
        const location = at(git, worktree);
        const view = await viewStory({ cli: deps.cli, cwd: location.workTree, id });
        return {
          taskFile: repoPath(location.workTree, view.file),
          title: view.title,
          status: view.status,
          criteria: view.acceptanceCriteria.map((criterion) => criterion.index),
        };
      });
    },
    showAt: (office, worktree, sha, path) => {
      const git = gitOf(office);
      return git.run(async (session) => {
        const shown = await session.step(at(git, worktree), ["show", `${sha}:${path}`]);
        return shown.code === 0 ? shown.stdout : null;
      });
    },
    commitPaths: (office, worktree, paths, message) => {
      const git = gitOf(office);
      return git.run(async (session) => {
        if (paths.length === 0) return null;
        const location = at(git, worktree);
        await session.ok(location, ["--literal-pathspecs", "add", "--all", "--", ...paths]);
        const staged = await session.step(location, [
          "--literal-pathspecs",
          "diff",
          "--cached",
          "--quiet",
          "--",
          ...paths,
        ]);
        if (staged.code === 0) return null;
        // Only these paths: anything else staged stays out of the commit.
        await commitOrFail(
          (args) =>
            session.step(location, ["--literal-pathspecs", ...args, "--", ...paths], {
              timeoutMs: EXTERNAL_STEP_TIMEOUT_MS,
            }),
          message,
        );
        return (await session.ok(location, ["rev-parse", "--verify", "HEAD"])).trim();
      });
    },
    codeTreeKey: (office, worktree, taskFile) => {
      const git = gitOf(office);
      return git.run(async (session) => {
        const tree = await session.ok(at(git, worktree), ["ls-tree", "-r", "-z", "HEAD"]);
        const kept = tree
          .split("\0")
          .filter((entry) => entry !== "" && entry.slice(entry.indexOf("\t") + 1) !== taskFile);
        return createHash("sha256").update(kept.join("\0")).digest("hex");
      });
    },
    markInReview: (office, input) => {
      const git = gitOf(office);
      return git.run(async (session) => {
        const location = at(git, input.worktree);
        await runBacklog(deps.cli, location.workTree, [
          "task",
          "edit",
          input.story,
          ...input.criteria.flatMap((n) => ["--check-ac", String(n)]),
          "--status",
          IN_REVIEW_STATUS,
        ]);
        const back = await viewStory({ cli: deps.cli, cwd: location.workTree, id: input.story });
        if (back.status !== IN_REVIEW_STATUS) {
          throw new GitError(
            "verify.statusNotWritten",
            `The Backlog CLI left ${input.story} at ${back.status}, not ${IN_REVIEW_STATUS}.`,
          );
        }
        const changed = statusPaths(
          await session.ok(location, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
        );
        if (!changed.includes(input.taskFile)) return null;
        await session.ok(location, ["--literal-pathspecs", "add", "--", input.taskFile]);
        // Only the task file: anything else staged stays out of this commit.
        await commitOrFail(
          (args) =>
            session.step(location, ["--literal-pathspecs", ...args, "--", input.taskFile], {
              timeoutMs: EXTERNAL_STEP_TIMEOUT_MS,
            }),
          `${input.story}: status ${IN_REVIEW_STATUS}`,
        );
        return (await session.ok(location, ["rev-parse", "--verify", "HEAD"])).trim();
      });
    },
    push: (office, branch) => {
      const git = gitOf(office);
      return git.run(async (session) => {
        const { remote } = git.settings;
        const url = await session.step(session.repository, [
          "config",
          "--get",
          `remote.${remote}.url`,
        ]);
        if (url.code !== 0 || url.stdout.trim() === "") {
          return { pushed: false, rejected: false, error: null };
        }
        const ref = `refs/heads/${branch}`;
        const pushed = await session
          .step(session.repository, ["push", "--quiet", "--no-verify", remote, `${ref}:${ref}`], {
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
      });
    },
    diffstat: (office, worktree, from) => {
      const git = gitOf(office);
      return git.run(async (session) =>
        (await session.ok(at(git, worktree), ["diff", "--stat", from])).trimEnd(),
      );
    },
  };
}
