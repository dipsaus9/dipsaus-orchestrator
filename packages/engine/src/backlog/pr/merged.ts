// The one backlog PR status change from Parked to Done (0012, DIPO-468): a story whose own PR merged
// while it was parked. The story PR carried the park's "status Parked" commit to the base, so the
// merge commit of that PR is the last commit on the base that touched the story's task file. This
// module gathers that fact for each task a backlog PR moves from Parked to Done, and the structural
// check (`check.ts`) decides it with the one Done check (`decideDone`, `worktree/done-check.ts`):
// accepted exactly when it answers `merged` for the claim {branch: the `branch` of the task's `dipo`
// field block on the base side, base: the PR's base}. dipo's own run of the check (`feature.ts`)
// and CI (`scripts/check-backlog-pr.ts`) both gather it here, so there is no third Done definition.
//
// The PR comes from git and the host only: `git log -1 <base> -- <task file>` names the commit, and
// the host names the PR that merged as exactly that commit (`MergeCommitHost`). Any later commit on
// the base that touches the task file (a backlog PR, a hand edit) is then the last one, and it is no
// merge commit of the story's PR, so the check refuses: it fails safe by design, and the maintainer
// resolves such a story by hand. A host that fails, times out or names no PR refuses too.

import type { GitSession } from "../../git/office";
import { CodeHostError, type MergeCommitHost } from "../../platform/host";
import type { DonePr } from "../../worktree/done-check";
import { lastTaskFileCommit } from "../task-file";

import { type PrDiff, stateOf } from "./check";

/** What the check knows of a task the PR moves from Parked to Done. */
export interface MergedFact {
  /** The story PR whose merge commit last touched the task file on the base, or null. */
  readonly pr: DonePr | null;
  /** Why there is no such PR (git found no commit, or the host failed or named none), or null. */
  readonly why: string | null;
}

export interface MergedFactsInput {
  /** A git session of the repository that holds `base`. */
  readonly git: GitSession;
  readonly diff: PrDiff;
  /**
   * The commit the PR's base branch is at without the PR: its tip for an open PR (in CI the merge
   * commit's first parent), the base the PR's diff started from for one already merged. The last
   * commit that touched a task file is looked up there. Null when dipo could not read it: every
   * Parked to Done is then refused.
   */
  readonly base: string | null;
  /** The code host, or null when there is none (every Parked to Done is then refused). */
  readonly host: MergeCommitHost | null;
  /** `[HOST/]OWNER/REPO` of the repository, or null when it is unknown. */
  readonly repo: string | null;
}

/** True when the PR moves the task from Parked to Done, both sides readable. */
export function movesParkedToDone(change: PrDiff["tasks"][number]): boolean {
  return (
    change.before.where === "task" &&
    change.before.view.ok &&
    change.after.where === "task" &&
    change.after.view.ok &&
    stateOf(change.before) === "Parked" &&
    stateOf(change.after) === "Done"
  );
}

/** The merged-PR fact of every task the PR moves from Parked to Done, by task id. Never throws a host error. */
export async function mergedWhileParkedFacts(
  input: MergedFactsInput,
): Promise<Record<string, MergedFact>> {
  const facts: Record<string, MergedFact> = {};
  for (const change of input.diff.tasks) {
    if (!movesParkedToDone(change)) continue;
    facts[change.id] = await factOf(input, change.id);
  }
  return facts;
}

async function factOf(input: MergedFactsInput, id: string): Promise<MergedFact> {
  if (input.base === null) {
    return { pr: null, why: "dipo could not read the commit the PR's base branch is at" };
  }
  const sha = await lastTaskFileCommit(input.git, input.base, id);
  if (sha === null) {
    return { pr: null, why: `git finds no commit on the base that touched its task file` };
  }
  if (input.host === null || input.repo === null) {
    return { pr: null, why: `dipo has no code host to ask which PR merged as ${short(sha)}` };
  }
  let merged;
  try {
    merged = await input.host.mergedPrOfCommit(input.repo, sha);
  } catch (error) {
    if (!(error instanceof CodeHostError)) throw error;
    return {
      pr: null,
      why: `the code host could not say which PR merged as ${short(sha)}: ${error.message}`,
    };
  }
  if (merged === null || merged.mergeCommit !== sha) {
    return {
      pr: null,
      why: `the last commit on the base that touched its task file, ${short(sha)}, is the merge commit of no PR`,
    };
  }
  return {
    pr: {
      number: merged.number,
      url: merged.url,
      state: merged.state,
      branch: merged.head,
      base: merged.base,
      headSha: merged.headSha,
    },
    why: null,
  };
}

function short(sha: string): string {
  return sha.slice(0, 12);
}
