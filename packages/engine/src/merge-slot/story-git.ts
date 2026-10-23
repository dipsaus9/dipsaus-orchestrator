// The git steps of the merge slot for a story PR (0019 section 9, the 0016 amendment of
// 2026-10-22). Each method is its own item of the office git queue, so claims, parts and commits
// of other stories run between the steps, and waiting for CI never holds the queue. Every step is
// idempotent when run again after a daemon restart: the close-out finds the story Done, the sync
// finds the base contained, the push finds nothing to push.
//
// - The close-out commit (step 1): in dipo's own copy of the story's backlog (`editInStoryBacklog`,
//   0021 section 14), the final summary (DIPO-154's `writeCloseOutSummary`, passed in), the
//   modified files (the paths the branch changed since its merge base with the base, without
//   `backlog/`), then DIPO-155's `closeOutFields`: the F16 park record removed and status `Done`,
//   committed alone as `<ID>: status Done`. Provisional until the
//   host merge (0010).
// - The sync (step 2): dipo merges the base into the story branch in its own repository from git
//   objects (`planCatchUp`, `commit-tree`, `update-ref`), never in a worktree a worker writes and
//   never in the box (0021 sections 8 and 14). `onConflict` merges only when git cannot merge the
//   base cleanly (the test the host makes when it reports a conflict; strict is off on the base
//   since the 0016 amendment); `always` whenever the base moved, after the host refused a merge
//   because the base moved. A conflict is committed as git left it, markers and all (DIPO-149's
//   committed catch-up), so the worker's resolution in its fix round is an ordinary change; a
//   conflict in a path the worker cannot write merges nothing. The box does not get the merge
//   here: it is recorded as one the box still lacks (`catch_ups.box_copy`), and the run's next
//   developer session copies it into the box before the worker starts (DIPO-324).
// - The push (step 3): once, never forced.

import { mkdirSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";

import type { StoryTarget } from "../backlog/fields/write";
import { type BacklogCli, isTaskFileOf, runBacklog, TASKS_DIR } from "../backlog/runner";
import {
  baseRefOf,
  type CatchUpMerged,
  CONFLICT_FILE_READ_MAX,
  type ConflictItem,
  conflictFeedbackItem,
  fileHunks,
  moveBranch,
  planCatchUp,
} from "../box/collisions";
import type { GitLocation } from "../git/hardened";
import type { GitSession, OfficeGit } from "../git/office";
import { pushBranch } from "../git/task-commit";
import { codeTreeKeyOf } from "../run/story-git";
import { BRANCH_READ_PREFIX } from "../stories/branch-read";
import { editInStoryBacklog } from "../worktree/claim";

import { closeOutFields, DONE_STATUS } from "./close-out-park";

import type { PushOutcome } from "./git";
import type { SlotSyncMode } from "./store";

type WorktreeLocation = Extract<GitLocation, { kind: "worktree" }>;

/** The most modified files the close-out writes; the rest are left out. */
export const MODIFIED_FILES_MAX = 200;

/** The story run a slot step works on. */
export interface StorySlotRun {
  readonly runId: string;
  readonly story: string;
  readonly branch: string;
  readonly worktree: string;
  readonly startSha: string;
  /** The conflict item's character budget (`prompt.budgets.feedbackItem` of its tier). */
  readonly itemMax?: number;
}

/** What the sync step did. */
export type StorySync =
  /** Nothing merged: the branch holds the base, or the mode leaves a clean merge for later. */
  | { readonly kind: "none" }
  | {
      /**
       * The merge commit is made from git objects, but the branch has not moved: the slot records
       * the merge first (`merge_slot`), then moves the branch (`moveBranch`), so a restart in
       * between finds it.
       */
      readonly kind: "planned";
      readonly merged: CatchUpMerged;
      /** The conflict item for the worker; null for a clean merge. */
      readonly item: ConflictItem | null;
    }
  /** The merge conflicts in paths the worker cannot write; nothing merged (0019 section 10). */
  | {
      readonly kind: "unwritable";
      readonly base: string;
      readonly onto: string;
      readonly paths: readonly string[];
    };

/** The git the story merge slot needs; `gitStorySlotOps` is the real one, tests use fakes. */
export interface StorySlotGit {
  /** Fetches the remote; false when the fetch failed. */
  fetch(office: OfficeId): Promise<boolean>;
  /** The local tip of `branch`, or null when it does not exist. */
  head(office: OfficeId, branch: string): Promise<string | null>;
  /** True when `branch` contains the base as last fetched. */
  containsBase(office: OfficeId, branch: string): Promise<boolean>;
  /**
   * The close-out commit: `summary` writes the final summary in dipo's copy of the backlog, then
   * the modified files and status Done. Returns the commit, or null when nothing changed.
   */
  closeOut(
    office: OfficeId,
    run: StorySlotRun,
    summary: (target: StoryTarget) => Promise<unknown>,
  ): Promise<string | null>;
  /**
   * Plans the merge of the base into the story branch by `mode` and makes its commit (see the file
   * comment); the branch does not move.
   */
  sync(office: OfficeId, run: StorySlotRun, mode: SlotSyncMode): Promise<StorySync>;
  /** Moves `branch` from `tip` to `commit`; false when it is not at `tip` any more. */
  moveBranch(office: OfficeId, branch: string, commit: string, tip: string): Promise<boolean>;
  /** Pushes `branch` once, never forced, when its tip differs from the remote's. */
  push(office: OfficeId, branch: string): Promise<PushOutcome>;
  /**
   * The code tree key of `head` (0010: `git ls-tree -r` without the story's own task file), or null
   * when the commit or its one task file of `story` cannot be read.
   */
  treeKey(office: OfficeId, story: string, head: string): Promise<string | null>;
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

/** The story merge slot's git steps with the office git and the Backlog CLI. */
export function gitStorySlotOps(deps: {
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  readonly cli: BacklogCli;
}): StorySlotGit {
  const gitOf = (office: OfficeId): OfficeGit => {
    const git = deps.git(office);
    if (git === undefined) throw new Error(`Office ${office} has no git attached.`);
    return git;
  };
  return {
    fetch: async (office) => (await gitOf(office).fetch()).ok,

    head: (office, branch) =>
      gitOf(office).run((session) => revParse(session, `refs/heads/${branch}`)),

    containsBase: (office, branch) => {
      const git = gitOf(office);
      return git.run(async (session) => {
        const base = await baseRefOf(git, session);
        if (base === null) return true;
        const result = await session.step(session.repository, [
          "merge-base",
          "--is-ancestor",
          base.ref,
          `refs/heads/${branch}`,
        ]);
        return result.code === 0;
      });
    },

    closeOut: (office, run, summary) => {
      const git = gitOf(office);
      return git.run(async (session) => {
        const tip = await revParse(session, `refs/heads/${run.branch}`);
        if (tip === null) throw new Error(`The story branch ${run.branch} no longer exists.`);
        const base = await baseRefOf(git, session);
        const files = (await modifiedFiles(session, tip, base?.ref ?? null, run.startSha)).slice(
          0,
          MODIFIED_FILES_MAX,
        );
        const location = git.worktreeLocation(run.worktree) as WorktreeLocation;
        // Only the task file: anything else staged stays out of the close-out commit.
        const { commit } = await editInStoryBacklog(
          git,
          session,
          location,
          run.story,
          `${run.story}: status ${DONE_STATUS}`,
          async (backlog) => {
            const target = { cli: deps.cli, cwd: backlog.cwd, id: run.story };
            // A later stay in the slot writes the summary and the modified files again as they are
            // now, also when the story is Done from an earlier stay; nothing new commits nothing.
            await summary(target);
            if (files.length > 0) {
              await runBacklog(deps.cli, backlog.cwd, [
                "task",
                "edit",
                run.story,
                ...files.flatMap((file) => ["--modified-file", file]),
              ]);
            }
            // DIPO-155's close-out fields: the park record removed and status Done, read back.
            await closeOutFields(target);
          },
        );
        return commit;
      });
    },

    sync: (office, run, mode) => {
      const git = gitOf(office);
      return git.run(async (session): Promise<StorySync> => {
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
          if (mode === "onConflict" && planned.conflicts.length === 0) return { kind: "none" };
          const plan = await planCatchUp(session, { ...input, write: true });
          if (plan.kind !== "merge" || plan.commit === null) return { kind: "none" };
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
          const item =
            plan.conflicts.length === 0
              ? null
              : conflictFeedbackItem({
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
    },

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

    treeKey: (office, story, head) =>
      gitOf(office).run(async (session) => {
        const listed = await session.step(session.repository, ["ls-tree", "-r", "-z", head]);
        if (listed.code !== 0) return null;
        const own = listed.stdout
          .split("\0")
          .map((entry) => entry.slice(entry.indexOf("\t") + 1))
          .filter(
            (path) =>
              path.startsWith(`${TASKS_DIR}/`) &&
              !path.slice(TASKS_DIR.length + 1).includes("/") &&
              isTaskFileOf(path.slice(TASKS_DIR.length + 1), story),
          );
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
