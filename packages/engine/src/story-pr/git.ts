// What the story PR reads from the story's branch and the repository (DIPO-144): the story as
// committed on its branch, read through the StoryStore (`viewOnBranch`), the branch tip, the remote
// URL and the base, and what the branch changes against the base (DIPO-459, the desk's MERGE
// preview). Every step is an office git queue item through the hardened runner, as the steps of
// verify and commit are.

import type { OfficeId, StoryPrChange } from "@dipsaus-orchestrator/contract";

import { baseRefOf } from "../box/collisions";
import type { GitSession, OfficeGit } from "../git/office";
import { branchTip, type PushResult, pushBranch } from "../git/write";
import { promptStoryOf } from "../prompts/story";
import { parseFieldBlock } from "../story-store/fields/block";
import type { StoryStore } from "../story-store/store";

import type { PrBodyStory } from "./body";

/** The story facts a PR title and body are built from. */
export interface PrStory extends PrBodyStory {
  readonly title: string;
  /** The Backlog.md type; undefined when the story has none. */
  readonly type: string | undefined;
}

/** What one PR sync reads. */
export interface StoryPrFacts {
  readonly story: PrStory;
  /** The branch tip, the commit pushed. */
  readonly head: string;
  /** The URL of the office's remote; null when it has none. */
  readonly remoteUrl: string | null;
  /** The base branch the PR targets. */
  readonly base: string;
  /** The files the branch changes against the base and their lines; absent when git could not say. */
  readonly change?: StoryPrChange;
}

/**
 * Pure: `git diff --numstat` as a change: one line per file, `<added>\t<removed>\t<path>`; a
 * binary file (`-\t-`) counts as a file with no lines.
 */
export function numstatChange(stdout: string): StoryPrChange {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of stdout.split("\n")) {
    const match = /^(\d+|-)\t(\d+|-)\t./.exec(line);
    if (match === null) continue;
    files += 1;
    additions += match[1] === "-" ? 0 : Number(match[1]);
    deletions += match[2] === "-" ? 0 : Number(match[2]);
  }
  return { files, additions, deletions };
}

/** What `head` changes against the base's tip, three-dot as the PR shows it; undefined on a failure. */
async function changeOf(
  git: OfficeGit,
  session: GitSession,
  head: string,
): Promise<StoryPrChange | undefined> {
  const base = await baseRefOf(git, session);
  if (base === null) return undefined;
  const diff = await session.step(session.repository, [
    "diff",
    "--numstat",
    "--no-renames",
    `${base.ref}...${head}`,
  ]);
  return diff.code === 0 ? numstatChange(diff.stdout) : undefined;
}

export interface StoryPrGit {
  read(
    office: OfficeId,
    input: { readonly branch: string; readonly story: string },
  ): Promise<StoryPrFacts>;
  /**
   * Pushes the story branch again, never forced (DIPO-315: the PR poll's retry of a failed In
   * Review push). Absent: the poll pushes nothing.
   */
  push?(office: OfficeId, branch: string): Promise<PushResult>;
}

/** The real reads, on the office git and the story store. */
export function gitStoryPrOps(deps: {
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  readonly stories: StoryStore;
}): StoryPrGit {
  return {
    push: (office, branch) => {
      const git = deps.git(office);
      if (git === undefined) throw new Error(`Office ${office} has no git attached.`);
      return git.run((session) => pushBranch(session, git.settings.remote, branch));
    },
    read: (office, input) => {
      const git = deps.git(office);
      if (git === undefined) throw new Error(`Office ${office} has no git attached.`);
      return git.run(async (session) => {
        const { view, file: taskFile } = await deps.stories.viewOnBranch(git, session, input);
        const fields = parseFieldBlock(view.description).fields;
        const prompt = promptStoryOf(view, { dependencies: [], fields, taskFile });
        const checked = new Map(view.acceptanceCriteria.map((c) => [c.index, c.checked]));
        const head = await branchTip(session, input.branch);
        const remote = await session.step(session.repository, [
          "config",
          "--get",
          `remote.${git.settings.remote}.url`,
        ]);
        const url = remote.stdout.trim();
        const change = await changeOf(git, session, head).catch(() => undefined);
        return {
          story: {
            id: prompt.id,
            title: prompt.title,
            type: prompt.type,
            storyLine: prompt.storyLine,
            criteria: prompt.criteria.map((c) => ({
              ...c,
              checked: checked.get(c.index) ?? false,
            })),
            testPlan: prompt.testPlan,
            scope: prompt.scope,
            taskFile,
          },
          head,
          remoteUrl: remote.code === 0 && url !== "" ? url : null,
          base: await git.resolveBaseIn(session),
          ...(change === undefined ? {} : { change }),
        };
      });
    },
  };
}

/** What `branchDiff` read: the base's name and the diff text, cut at the byte cap. */
export interface BranchDiff {
  readonly base: string;
  readonly diff: string;
  readonly truncated: boolean;
}

/**
 * The unified diff of `branch` against the base's tip, three-dot as the PR shows it (DIPO-462);
 * null when git cannot tell (no base, no such branch). The branch is read from the local heads,
 * else from the remote's.
 */
export function branchDiff(
  git: OfficeGit,
  branch: string,
  maxBytes: number,
): Promise<BranchDiff | null> {
  return git.run(async (session) => {
    const base = await baseRefOf(git, session);
    if (base === null) return null;
    for (const head of [`refs/heads/${branch}`, `refs/remotes/${git.settings.remote}/${branch}`]) {
      const diff = await session.step(session.repository, [
        "diff",
        "--no-renames",
        "--no-color",
        "--no-ext-diff",
        `${base.ref}...${head}`,
      ]);
      if (diff.code !== 0) continue;
      const bytes = new TextEncoder().encode(diff.stdout);
      if (bytes.length <= maxBytes) return { base: base.base, diff: diff.stdout, truncated: false };
      const cut = new TextDecoder().decode(bytes.subarray(0, maxBytes)).replace(/�$/, "");
      return { base: base.base, diff: cut, truncated: true };
    }
    return null;
  });
}
