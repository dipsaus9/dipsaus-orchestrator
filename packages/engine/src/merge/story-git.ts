// The git steps of a story PR's merge (0002, 0010). Each method is its own item of the office git
// queue, so claims, parts and commits of other stories run between the steps, and waiting for
// GitHub never holds the queue. Every step is idempotent when it runs again after a daemon
// restart: the close-out finds the story Done, the conflict merge finds the base merged, the push
// finds nothing to push.
//
// - The close-out commit: in one story lane edit of the StoryStore (`editOnBranch`), the
//   final summary (`writeCloseOutSummary`, passed in), the modified files (the paths the branch
//   changed since its merge base with the base, without `backlog/`), then `closeOutFields`: the
//   park field removed and status `Done`, committed alone as `<ID>: status Done`.
// - The conflict merge: when GitHub reports that the base conflicts with the PR, dipo merges the
//   base into the story branch in its own repository from git objects (`planCatchUp`,
//   `commit-tree`), never in the box. The conflict is committed as git left it, markers and all,
//   so the worker's resolution in its fix round is an ordinary change; a conflict in a path the
//   worker cannot write merges nothing. A base that merges cleanly merges nothing: GitHub's
//   "require branches to be up to date" is off (0016). The box gets the merge before the run's
//   next developer session (`catch_ups.box_copy`).
// - The push: once, never forced.
// - The release path: the paths of the PR's diff (merge base with the base to the head) that the
//   base's CODEOWNERS gives an owner (`release-path.ts`), read from git objects.

import { mkdirSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";

import {
  baseRefOf,
  type CatchUpMerged,
  CONFLICT_FILE_READ_MAX,
  type ConflictItem,
  conflictFeedbackItem,
  fileHunks,
  planCatchUp,
} from "../box/collisions";
import type { GitSession, OfficeGit } from "../git/office";
import { moveBranch, pushBranch } from "../git/write";
import { codeTreeKeyOf } from "../run/story-git";
import type { StoryEditor, StoryStore } from "../story-store/store";
import { BRANCH_READ_PREFIX } from "../worktree/sweep";

import { closeOutFields, DONE_STATUS } from "./close-out";
import { CODEOWNERS_LOCATIONS, parseCodeowners, releasePathsOf } from "./release-path";

/** The most modified files the close-out writes; the rest are left out. */
export const MODIFIED_FILES_MAX = 200;

/** What a push did: pushed, nothing to push, or failed with why. */
export type PushOutcome =
  | { readonly ok: true; readonly pushed: boolean }
  | { readonly ok: false; readonly detail: string };

/** The story run a merge step works on. */
export interface StoryMergeRun {
  readonly runId: string;
  readonly story: string;
  readonly branch: string;
  readonly startSha: string;
  /** The conflict item's character budget (`prompt.budgets.feedbackItem` of its tier). */
  readonly itemMax?: number;
}

/** What the conflict merge did. */
export type ConflictMerge =
  /** Nothing merged: the branch holds the base, or the base merges cleanly. */
  | { readonly kind: "none" }
  | {
      /** The merge commit is made from git objects, but the branch has not moved yet. */
      readonly kind: "planned";
      readonly merged: CatchUpMerged;
      /** The conflict item for the worker. */
      readonly item: ConflictItem;
    }
  /** The merge conflicts in paths the worker cannot write; nothing merged (0002). */
  | {
      readonly kind: "unwritable";
      readonly base: string;
      readonly onto: string;
      readonly paths: readonly string[];
    };

/** The git a story PR's merge needs; `gitStoryMergeOps` is the real one, tests use fakes. */
export interface StoryMergeGit {
  /** Fetches the remote; false when the fetch failed. */
  fetch(office: OfficeId): Promise<boolean>;
  /** The local tip of `branch`, or null when it does not exist. */
  head(office: OfficeId, branch: string): Promise<string | null>;
  /**
   * The close-out commit: `summary` writes the final summary in the story lane edit, then the
   * modified files and status Done. Returns the commit, or null when nothing changed.
   */
  closeOut(
    office: OfficeId,
    run: StoryMergeRun,
    summary: (story: StoryEditor) => Promise<unknown>,
  ): Promise<string | null>;
  /**
   * Plans the merge of the base into the story branch when it conflicts and makes its commit (see
   * the file comment); the branch does not move.
   */
  conflictMerge(office: OfficeId, run: StoryMergeRun): Promise<ConflictMerge>;
  /** The conflict item of a conflicted merge dipo made, built again from its commit. */
  conflictItem(office: OfficeId, run: StoryMergeRun, merged: CatchUpMerged): Promise<ConflictItem>;
  /** Moves `branch` from `tip` to `commit`; false when it is not at `tip` any more. */
  moveBranch(office: OfficeId, branch: string, commit: string, tip: string): Promise<boolean>;
  /** Pushes `branch` once, never forced, when its tip differs from the remote's. */
  push(office: OfficeId, branch: string): Promise<PushOutcome>;
  /**
   * The code tree key of `head` (0010: `git ls-tree -r` without the story's own task file), or null
   * when the commit or its one task file of `story` cannot be read.
   */
  treeKey(office: OfficeId, story: string, head: string): Promise<string | null>;
  /**
   * The release paths `head` changes (DIPO-331): the paths of its diff against its merge base with
   * the base as last fetched that the base's CODEOWNERS gives an owner, sorted; empty when the base
   * has no CODEOWNERS. Null when git cannot tell (no base, an unreadable commit): dipo then turns
   * no auto-merge on.
   */
  releasePaths(office: OfficeId, head: string): Promise<readonly string[] | null>;
}

async function revParse(session: GitSession, ref: string): Promise<string | null> {
  const found = await session.step(session.repository, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref}^{commit}`,
  ]);
  return found.code === 0 ? found.stdout.trim() : null;
}

/** The paths `tip` changed since its merge base with `baseRef`, without `backlog/`, sorted. */
async function modifiedFiles(
  session: GitSession,
  tip: string,
  baseRef: string | null,
  startSha: string,
): Promise<string[]> {
  let from = startSha;
  if (baseRef !== null && (await revParse(session, baseRef)) !== null) {
    const base = await session.step(session.repository, ["merge-base", tip, baseRef]);
    if (base.code === 0 && base.stdout.trim() !== "") from = base.stdout.trim();
  }
  const listed = await session.ok(session.repository, [
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    from,
    tip,
  ]);
  return listed
    .split("\0")
    .filter((path) => path !== "" && !path.startsWith("backlog/"))
    .toSorted();
}

/** A story PR merge's git steps with the office git and the story store. */
export function gitStoryMergeOps(deps: {
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  readonly stories: StoryStore;
}): StoryMergeGit {
  const gitOf = (office: OfficeId): OfficeGit => {
    const git = deps.git(office);
    if (git === undefined) throw new Error(`Office ${office} has no git attached.`);
    return git;
  };
  return {
    fetch: async (office) => (await gitOf(office).fetch()).ok,

    head: (office, branch) =>
      gitOf(office).run((session) => revParse(session, `refs/heads/${branch}`)),

    closeOut: (office, run, summary) => closeOutIn(gitOf(office), deps.stories, run, summary),

    conflictMerge: (office, run) => conflictMergeIn(gitOf(office), run),

    conflictItem: (office, run, merged) =>
      gitOf(office).run(async (session) =>
        conflictFeedbackItem({
          base: merged.base,
          onto: merged.onto,
          conflicts: merged.conflicts,
          hunks: await hunksOf(session, merged.commit, merged.conflicts),
          ...(run.itemMax === undefined ? {} : { itemMax: run.itemMax }),
        }),
      ),

    moveBranch: (office, branch, commit, tip) =>
      gitOf(office).run((session) =>
        moveBranch(session, branch, commit, tip, `Merge the base into ${branch}`),
      ),

    push: (office, branch) => {
      const git = gitOf(office);
      return git.run(async (session): Promise<PushOutcome> => {
        const local = await revParse(session, `refs/heads/${branch}`);
        if (local === null) return { ok: false, detail: `the branch ${branch} does not exist` };
        const tracking = await revParse(session, `refs/remotes/${git.settings.remote}/${branch}`);
        if (local === tracking) return { ok: true, pushed: false };
        const pushed = await pushBranch(session, git.settings.remote, branch);
        if (pushed.pushed) return { ok: true, pushed: true };
        if (pushed.error === null) return { ok: true, pushed: false };
        return { ok: false, detail: pushed.error };
      });
    },

    releasePaths: (office, head) => releasePathsOnBase(gitOf(office), head),

    treeKey: (office, story, head) =>
      gitOf(office).run(async (session) => {
        const listed = await session.step(session.repository, ["ls-tree", "-r", "-z", head]);
        if (listed.code !== 0) return null;
        const own = listed.stdout
          .split("\0")
          .map((entry) => entry.slice(entry.indexOf("\t") + 1))
          .filter((path) => deps.stories.isStoryFile(path, story));
        return own.length === 1 ? codeTreeKeyOf(listed.stdout, own[0] as string) : null;
      }),
  };
}

/** The hunks of the merge's content conflicts, read from git objects within the read cap. */
async function hunksOf(
  session: GitSession,
  commit: string,
  conflicts: CatchUpMerged["conflicts"],
): Promise<string[]> {
  const out: string[] = [];
  for (const file of conflicts) {
    if (file.kind !== "content") continue;
    const spec = `${commit}:${file.path}`;
    const size = await session.step(session.repository, ["cat-file", "-s", spec]);
    if (size.code !== 0 || Number(size.stdout.trim()) > CONFLICT_FILE_READ_MAX) continue;
    const text = await session.step(session.repository, ["cat-file", "blob", spec]);
    if (text.code === 0) out.push(...fileHunks(file.path, text.stdout));
  }
  return out;
}

/** The release paths `head` changes against the base as last fetched; null when unreadable. */
export function releasePathsOnBase(git: OfficeGit, head: string): Promise<string[] | null> {
  return git.run(async (session) => {
    const base = await baseRefOf(git, session);
    const onto = base === null ? null : await revParse(session, base.ref);
    return onto === null ? null : releasePathsAt(session, onto, head);
  });
}

/** The CODEOWNERS text on `commit` (the first of GitHub's locations), "" when there is none. */
async function codeownersAt(session: GitSession, commit: string): Promise<string | null> {
  const listed = await session.step(session.repository, [
    "ls-tree",
    "-r",
    "-z",
    "--name-only",
    commit,
    "--",
    ...CODEOWNERS_LOCATIONS,
  ]);
  if (listed.code !== 0) return null;
  const present = new Set(listed.stdout.split("\0"));
  const found = CODEOWNERS_LOCATIONS.find((path) => present.has(path));
  if (found === undefined) return "";
  const blob = await session.step(session.repository, ["cat-file", "blob", `${commit}:${found}`]);
  return blob.code === 0 ? blob.stdout : null;
}

/** The release paths `head` changes against its merge base with `onto`; null when unreadable. */
async function releasePathsAt(
  session: GitSession,
  onto: string,
  head: string,
): Promise<string[] | null> {
  const owners = await codeownersAt(session, onto);
  if (owners === null) return null;
  const rules = parseCodeowners(owners);
  if (!rules.some((rule) => rule.owned)) return [];
  const base = await session.step(session.repository, ["merge-base", head, onto]);
  if (base.code !== 0 || base.stdout.trim() === "") return null;
  const diff = await session.step(session.repository, [
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    base.stdout.trim(),
    head,
  ]);
  if (diff.code !== 0) return null;
  return releasePathsOf(
    rules,
    diff.stdout.split("\0").filter((path) => path !== ""),
  );
}

/** The close-out commit on the story branch (see the file comment); its commit or null. */
function closeOutIn(
  git: OfficeGit,
  stories: StoryStore,
  run: StoryMergeRun,
  summary: (story: StoryEditor) => Promise<unknown>,
): Promise<string | null> {
  return git.run(async (session) => {
    const tip = await revParse(session, `refs/heads/${run.branch}`);
    if (tip === null) throw new Error(`The story branch ${run.branch} no longer exists.`);
    const base = await baseRefOf(git, session);
    const files = (await modifiedFiles(session, tip, base?.ref ?? null, run.startSha)).slice(
      0,
      MODIFIED_FILES_MAX,
    );
    // Only the task file.
    const { commit } = await stories.editOnBranch(
      git,
      session,
      run,
      `${run.story}: status ${DONE_STATUS}`,
      async (story) => {
        // A later close-out writes the summary and the modified files again as they are now,
        // also when the story is Done from an earlier one; nothing new commits nothing.
        await summary(story);
        await story.recordModifiedFiles(files);
        // The close-out fields: the park record removed and status Done, read back.
        await closeOutFields(story);
      },
    );
    return commit;
  });
}

/** The conflict merge of the base into the story branch (see the file comment). */
function conflictMergeIn(git: OfficeGit, run: StoryMergeRun): Promise<ConflictMerge> {
  return git.run(async (session): Promise<ConflictMerge> => {
    const base = await baseRefOf(git, session);
    if (base === null) return { kind: "none" };
    // A folder of dipo's own for the task file's temporary index; the claims load step sweeps
    // one a killed daemon left behind (the branch reads' prefix).
    const root = git.worktreeRoot();
    mkdirSync(root, { recursive: true });
    const scratch = await realpath(await mkdtemp(join(root, BRANCH_READ_PREFIX)));
    try {
      const input = {
        branch: run.branch,
        startSha: run.startSha,
        story: run.story,
        base: base.base,
        baseRef: base.ref,
        mode: "always" as const,
        scratch,
      };
      const planned = await planCatchUp(session, { ...input, write: false });
      if (planned.kind === "current" || planned.kind === "apart") return { kind: "none" };
      if (planned.kind === "unwritable") {
        return {
          kind: "unwritable",
          base: base.base,
          onto: planned.onto,
          paths: planned.paths,
        };
      }
      if (planned.conflicts.length === 0) return { kind: "none" };
      const plan = await planCatchUp(session, { ...input, write: true });
      if (plan.kind !== "merge" || plan.commit === null || plan.conflicts.length === 0) {
        return { kind: "none" };
      }
      const merged: CatchUpMerged = {
        base: base.base,
        onto: plan.onto,
        tip: plan.tip,
        commit: plan.commit,
        conflicts: plan.conflicts,
        taskFile: plan.taskFile,
        // Made in dipo's own git, not in the box: copied in before the next session (DIPO-324).
        outsideBox: true,
      };
      const item = conflictFeedbackItem({
        base: base.base,
        onto: plan.onto,
        conflicts: plan.conflicts,
        hunks: await hunksOf(session, plan.commit, plan.conflicts),
        ...(run.itemMax === undefined ? {} : { itemMax: run.itemMax }),
      });
      return { kind: "planned", merged, item };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
}
