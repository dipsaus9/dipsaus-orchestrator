// What the story PR reads from the story's worktree and the repository (DIPO-144): the story as
// the Backlog CLI shows it in dipo's own copy of the story's backlog (`inStoryBacklog`, never the
// worktree), the head commit, the remote URL and the base. Every step is an office
// git queue item through the hardened runner, as the steps of verify and commit are.

import type { OfficeId } from "@dipsaus-orchestrator/contract";

import { parseFieldBlock } from "../backlog/fields/block";
import { viewStory } from "../backlog/fields/write";
import type { BacklogCli } from "../backlog/runner";
import type { GitLocation } from "../git/hardened";
import type { OfficeGit } from "../git/office";
import { promptStoryOf } from "../prompts/story";
import { inStoryBacklog, repoPath } from "../worktree/claim";

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
  /** The worktree's HEAD, the commit pushed. */
  readonly head: string;
  /** The URL of the office's remote; null when it has none. */
  readonly remoteUrl: string | null;
  /** The base branch the PR targets. */
  readonly base: string;
}

export interface StoryPrGit {
  read(
    office: OfficeId,
    input: { readonly worktree: string; readonly story: string },
  ): Promise<StoryPrFacts>;
}

/** The real reads, on the office git and the Backlog CLI. */
export function gitStoryPrOps(deps: {
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  readonly cli: BacklogCli;
}): StoryPrGit {
  return {
    read: (office, input) => {
      const git = deps.git(office);
      if (git === undefined) throw new Error(`Office ${office} has no git attached.`);
      return git.run(async (session) => {
        const location = git.worktreeLocation(input.worktree) as Extract<
          GitLocation,
          { kind: "worktree" }
        >;
        // In dipo's own copy of the story's backlog, never the worktree (0021 section 14).
        const { view, taskFile } = await inStoryBacklog(
          git,
          session,
          location,
          input.story,
          async (backlog) => {
            const shown = await viewStory({ cli: deps.cli, cwd: backlog.cwd, id: input.story });
            return { view: shown, taskFile: repoPath(backlog.cwd, shown.file) };
          },
        );
        const fields = parseFieldBlock(view.description).fields;
        const prompt = promptStoryOf(view, { dependencies: [], fields, taskFile });
        const checked = new Map(view.acceptanceCriteria.map((c) => [c.index, c.checked]));
        const head = (await session.ok(location, ["rev-parse", "--verify", "HEAD"])).trim();
        const remote = await session.step(session.repository, [
          "config",
          "--get",
          `remote.${git.settings.remote}.url`,
        ]);
        const url = remote.stdout.trim();
        return {
          story: {
            id: prompt.id,
            title: prompt.title,
            type: prompt.type,
            outcome: prompt.outcome,
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
        };
      });
    },
  };
}
