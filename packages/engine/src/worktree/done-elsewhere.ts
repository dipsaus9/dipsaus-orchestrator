// A story finished outside dipo (DIPO-161; 0020 section 10, spike answer 5; 0007 and 0010 notes of
// 2026-10-16). A live claim whose story reads Done on the base while its own branch is not
// detected Done was finished through another branch. The Done poll (`done.ts`) and reconcile
// (`reconcile/done-on-base.ts`) both find it and hand it here; a Done on the base wins over the
// status on the branch for the one terminal state.
//
// - A claim with a live worker (its run active, or a worker host that has not ended) is never
//   stopped by code: `flagLiveWorker` records it once (`done_elsewhere.flagged_at`, the DONE
//   ELSEWHERE desk item) with an `engine.notice`. The release follows when the run next ends (a
//   park, In Review, a stop): the next poll or reconcile finds the claim idle.
// - `releaseDoneElsewhere`, for a parked or idle claim, in one transaction: the claim released as
//   `done-elsewhere` with its run ended, an open park of the story resolved `done-elsewhere`, the
//   run's open questions closed `ended`, the story Done in the mirror with its `story.state`, the
//   worktree's tier T rows forgotten, the row recorded as released, and a notice naming the base
//   commit that last changed the task file. The port slot is freed after it.
// - `settleDoneElsewhere`, after the release (and again after a crash, for a released row not yet
//   settled): dipo's open story PR is closed with a comment naming that commit; the worktree is
//   removed when clean and kept when it holds uncommitted or untracked files; the branch is deleted
//   locally and remotely when `git merge-tree` shows it adds nothing to the base, else kept and
//   recorded in `released_branches` with reason `done-elsewhere`. Anything kept is the row's
//   leftovers: the commits not on the base and the dirty files, one LEFTOVERS desk item with the
//   action `dipo discard <id>`, and a notice. Leftovers are never deleted automatically.
//
// The desk read (`office.desk`, DIPO-158) is not built yet: `doneElsewhereDeskItems` is the seam it
// reads; until then the notices carry the same text. Nothing writes to the backlog: the base
// already says Done, and Done is terminal (0012).

import type { Clock, LostCommit, OfficeId, RunId, StoryKey } from "@dipsaus-orchestrator/contract";

import { viewStory } from "../backlog/fields/write";
import type { BacklogCli } from "../backlog/runner";
import { appendEntries, type NewEntry } from "../changelog/log";
import { forgetContextPack } from "../context/pack";
import type { OfficeHandle } from "../db/office";
import type { GitSession, OfficeGit } from "../git/office";
import { closeQuestion, openQuestions } from "../hooks/questions";
import { CodeHostError, type CodeHost } from "../platform/host";
import { forgetWorkerNotes } from "../prompts/notes";
import { findRun } from "../run/records";
import { latestStoryPr, setStoryPrState } from "../story-pr/records";
import { lifecycleOf, storyView } from "../views/story";

import { notice } from "./claim";
import {
  type ClaimRecord,
  findClaim,
  openReleasedBranches,
  releaseClaim,
  releasedBranchFor,
} from "./records";
import {
  addsNothingTo,
  baseRefIn,
  deleteOwnBranch,
  type LeftoverTargets,
  remoteBranchOf,
  repoOfPrUrl,
} from "./release";
import type { SlotTable } from "./slots";
import { dirtyFiles, removeWorktree } from "./teardown";

/** The release reason of a claim whose story is Done on the base through another branch. */
export const DONE_ELSEWHERE_REASON = "done-elsewhere";

/** `engine.notice` codes of a story Done elsewhere. */
export const DONE_ELSEWHERE_NOTICES = {
  live: "doneElsewhere.live",
  released: "doneElsewhere.released",
  leftovers: "doneElsewhere.leftovers",
  cleaned: "doneElsewhere.cleaned",
  prNotClosed: "doneElsewhere.prNotClosed",
  remoteBranch: "doneElsewhere.remoteBranch",
} as const;

/** The desk kinds a story Done elsewhere puts up (0020 section 12, group 4). */
export const DONE_ELSEWHERE_DESK = { live: "DONE ELSEWHERE", leftovers: "LEFTOVERS" } as const;

export interface DoneElsewhereRecord {
  readonly runId: RunId;
  readonly key: StoryKey;
  readonly story: string;
  readonly branch: string;
  readonly worktree: string;
  /** The commit the claim's worktree started from. */
  readonly startSha: string;
  readonly base: string;
  readonly baseCommit: string | null;
  readonly flaggedAt: number | null;
  readonly releasedAt: number | null;
  readonly settledAt: number | null;
  readonly worktreeKept: boolean;
  readonly branchKept: boolean;
  readonly commits: readonly LostCommit[];
  readonly files: readonly string[];
  readonly clearedAt: number | null;
}

interface Row {
  run_id: string;
  key: string;
  story_id: string;
  branch: string;
  worktree: string;
  start_sha: string;
  base: string;
  base_commit: string | null;
  flagged_at: number | null;
  released_at: number | null;
  settled_at: number | null;
  worktree_kept: number;
  branch_kept: number;
  commits: string;
  files: string;
  cleared_at: number | null;
}

const COLUMNS = `run_id, key, story_id, branch, worktree, start_sha, base, base_commit, flagged_at, released_at,
  settled_at, worktree_kept, branch_kept, commits, files, cleared_at`;

function toRecord(row: Row): DoneElsewhereRecord {
  return {
    runId: row.run_id as RunId,
    key: row.key as StoryKey,
    story: row.story_id,
    branch: row.branch,
    worktree: row.worktree,
    startSha: row.start_sha,
    base: row.base,
    baseCommit: row.base_commit,
    flaggedAt: row.flagged_at,
    releasedAt: row.released_at,
    settledAt: row.settled_at,
    worktreeKept: row.worktree_kept === 1,
    branchKept: row.branch_kept === 1,
    commits: JSON.parse(row.commits) as LostCommit[],
    files: JSON.parse(row.files) as string[],
    clearedAt: row.cleared_at,
  };
}

export function findDoneElsewhere(office: OfficeHandle, runId: RunId): DoneElsewhereRecord | null {
  const row = office.get<Row>(
    `select ${COLUMNS} from done_elsewhere where office_id = $office_id and run_id = $run`,
    { run: runId },
  );
  return row === null ? null : toRecord(row);
}

/** The released rows whose PR, worktree and branch were not handled yet (a crash), oldest first. */
export function unsettledDoneElsewhere(office: OfficeHandle): DoneElsewhereRecord[] {
  return office
    .all<Row>(
      `select ${COLUMNS} from done_elsewhere where office_id = $office_id
         and released_at is not null and settled_at is null and cleared_at is null
       order by released_at, run_id`,
    )
    .map(toRecord);
}

/** The story's leftovers not yet cleared: settled rows that kept a worktree or a branch. */
export function openLeftovers(office: OfficeHandle, key: StoryKey): DoneElsewhereRecord[] {
  return office
    .all<Row>(
      `select ${COLUMNS} from done_elsewhere where office_id = $office_id and key = $key
         and released_at is not null and cleared_at is null
         and (worktree_kept = 1 or branch_kept = 1 or settled_at is null)
       order by released_at, run_id`,
      { key },
    )
    .map(toRecord);
}

/** Marks the story's leftovers removed by `dipo discard`. In the caller's transaction. */
export function clearLeftovers(office: OfficeHandle, key: StoryKey, at: number): number {
  return office.run(
    `update done_elsewhere set cleared_at = $at, cleared_how = 'discard'
      where office_id = $office_id and key = $key and cleared_at is null`,
    { key, at },
  ).changes;
}

/**
 * What `work.discard` removes of the story's leftovers, and so what its loss list shows: the
 * worktrees of the open leftovers (settled or not), the story's open releases and the leftovers'
 * own branches.
 */
export function leftoverTargets(office: OfficeHandle, key: StoryKey): LeftoverTargets {
  const rows = openLeftovers(office, key);
  return {
    worktrees: rows.map((row) => ({
      runId: row.runId,
      worktree: row.worktree,
      branch: row.branch,
      startSha: row.startSha,
    })),
    branches: openReleasedBranches(office, key),
    loose: rows.map((row) => row.branch),
    base: rows[0]?.base ?? "",
  };
}

/** One item of the desk (0020 section 12) a story Done elsewhere puts up, for `office.desk`. */
export interface DoneElsewhereDeskItem {
  readonly kind: (typeof DONE_ELSEWHERE_DESK)[keyof typeof DONE_ELSEWHERE_DESK];
  readonly key: StoryKey;
  readonly story: string;
  readonly detail: string;
  readonly since: number;
  readonly commits: readonly LostCommit[];
  readonly files: readonly string[];
  readonly actions: readonly { readonly command: string; readonly cli: string }[];
}

/**
 * The DONE ELSEWHERE items (a live worker, release pending) and the LEFTOVERS items (one per story,
 * with the commits not on the base and the dirty files) of the office, oldest first: the seam the
 * desk read of DIPO-158 reads.
 */
export function doneElsewhereDeskItems(office: OfficeHandle): DoneElsewhereDeskItem[] {
  const rows = office
    .all<Row>(
      `select ${COLUMNS} from done_elsewhere where office_id = $office_id and cleared_at is null
       order by coalesce(released_at, flagged_at), run_id`,
    )
    .map(toRecord);
  const items: DoneElsewhereDeskItem[] = [];
  const leftovers = new Map<string, DoneElsewhereRecord[]>();
  for (const row of rows) {
    if (row.releasedAt === null && row.flaggedAt !== null) {
      items.push({
        kind: DONE_ELSEWHERE_DESK.live,
        key: row.key,
        story: row.story,
        detail: `Done on ${row.base}${commitText(row.baseCommit)} · worker still running`,
        since: row.flaggedAt,
        commits: [],
        files: [],
        actions: [{ command: "work.stop", cli: `dipo stop ${row.story}` }],
      });
    } else if (row.settledAt !== null && (row.worktreeKept || row.branchKept)) {
      leftovers.set(row.key, [...(leftovers.get(row.key) ?? []), row]);
    }
  }
  for (const group of leftovers.values()) {
    const first = group[0];
    if (first === undefined) continue;
    const commits = unique(
      group.flatMap((row) => row.commits),
      (c) => c.sha,
    );
    const files = unique(
      group.flatMap((row) => row.files),
      (f) => f,
    );
    items.push({
      kind: DONE_ELSEWHERE_DESK.leftovers,
      key: first.key,
      story: first.story,
      detail: leftoversDetail(first, commits.length, files.length),
      since: first.settledAt ?? first.releasedAt ?? 0,
      commits,
      files,
      actions: [{ command: "work.discard", cli: discardCli(first.story) }],
    });
  }
  return items.toSorted((a, b) => a.since - b.since);
}

export interface DoneElsewhereDeps {
  readonly officeId: OfficeId;
  readonly office: OfficeHandle;
  readonly git: OfficeGit;
  readonly clock: Clock;
  readonly slots?: SlotTable;
  /** Closes dipo's open story PR; without it the PR is left open with a notice. */
  readonly host?: Pick<CodeHost, "closePr"> | null;
  readonly onChanged?: (office: OfficeId) => void;
  /**
   * Checks and deletes the boxes of ended runs (0021 section 6), as `work.discard` does, after a
   * release is settled; best effort.
   */
  readonly finishBoxes?: () => Promise<unknown>;
  /** Hears each notice written, for reconcile's report. */
  readonly onNotice?: (notice: {
    readonly code: string;
    readonly key?: StoryKey;
    readonly text: string;
  }) => void;
}

/** True when the claim's run is still active or one of its worker hosts has not ended. */
export function hasLiveWorker(office: OfficeHandle, claim: Pick<ClaimRecord, "runId">): boolean {
  const run = findRun(office, claim.runId);
  if (run !== null && run.endedAt === null) return true;
  return (
    office.get<{ n: number }>(
      `select 1 as n from worker_hosts
        where office_id = $office_id and run_id = $run and ended_at is null limit 1`,
      { run: claim.runId },
    ) !== null
  );
}

/**
 * The commit of `ref` that last changed the task file of `story` (`backlog/**\/<id> - *.md`), or
 * null when git finds none.
 */
export async function lastTaskCommit(
  git: GitSession,
  ref: string,
  story: string,
): Promise<string | null> {
  const result = await git.step(git.repository, [
    "log",
    "-1",
    "--format=%H",
    ref,
    "--",
    `:(glob,icase)backlog/**/${story} - *.md`,
  ]);
  const sha = result.code === 0 ? result.stdout.trim() : "";
  return sha === "" ? null : sha;
}

/**
 * Whether `story` is Done in `_base`, which the story index's fetch keeps at `<remote>/<base>`, read
 * with the Backlog CLI, with the base commit that last changed its task file; null when it is not
 * Done there or cannot be read. Never throws.
 */
export async function baseDoneOf(
  git: OfficeGit,
  cli: BacklogCli,
  story: string,
): Promise<{ readonly commit: string | null } | null> {
  const path = git.baseWorktreePath();
  if (git.adminDirOf(path) === null) return null;
  try {
    return await git.run(async (session) => {
      const head = (
        await session.ok(git.worktreeLocation(path), ["rev-parse", "--verify", "HEAD"])
      ).trim();
      const view = await viewStory({ cli, cwd: path, id: story });
      if (lifecycleOf("task", view.status) !== "Done") return null;
      return { commit: await lastTaskCommit(session, head, story) };
    });
  } catch {
    return null;
  }
}

/**
 * Records once that the claim's story is Done on the base while its worker still runs, with a warn
 * notice; returns false when it was recorded already.
 */
export function flagLiveWorker(
  deps: DoneElsewhereDeps,
  claim: ClaimRecord,
  baseCommit: string | null,
): boolean {
  if (findDoneElsewhere(deps.office, claim.runId) !== null) return false;
  write(deps, () => {
    insertRow(deps.office, claim, baseCommit, { flaggedAt: deps.clock.now() });
    return [
      notice(
        "warn",
        DONE_ELSEWHERE_NOTICES.live,
        `${claim.story} is Done on ${claim.base}${commitText(baseCommit)}, not through its own branch ${claim.branch}, but its worker still runs. dipo does not stop it: stop it with \`dipo stop ${claim.story}\`, or dipo releases the claim when the run next ends.`,
        claim.key,
      ),
    ];
  });
  return true;
}

/**
 * Releases the parked or idle claim in one transaction (see the file comment); the caller checked
 * that no worker of its run is live. `reason` is `done` only for an own-branch teardown a crash
 * interrupted after its worktree removal (DIPO-216 keeps that reason). Returns the entries it wrote.
 */
export function releaseDoneElsewhere(
  deps: DoneElsewhereDeps,
  claim: ClaimRecord,
  baseCommit: string | null,
  options: { readonly reason?: string; readonly text?: string } = {},
): void {
  const { office } = deps;
  const at = deps.clock.now();
  write(deps, () => {
    const before = storyView(office, claim.key);
    releaseClaim(office, claim.runId, {
      at,
      reason: options.reason ?? DONE_ELSEWHERE_REASON,
      keepBranch: false,
    });
    office.run(
      `update parks set resolved_at = $at, resolved_how = 'done-elsewhere'
        where office_id = $office_id and key = $key and resolved_at is null`,
      { key: claim.key, at },
    );
    const entries: NewEntry[] = [];
    for (const question of openQuestions(office, claim.runId)) {
      if (!closeQuestion(office, question.questionId, "ended", at)) continue;
      entries.push({
        type: "question.closed",
        key: claim.key,
        run: claim.runId,
        delta: { question: question.questionId },
      });
    }
    // The base says Done; the mirror holds the branch's read until the next index pass.
    office.run(
      `update backlog_mirror set status = 'Done', park = null, park_since = null, source = 'base'
        where office_id = $office_id and key = $key`,
      { key: claim.key },
    );
    const view = storyView(office, claim.key);
    if (view !== null && before !== null && before.lifecycle !== "Done") {
      entries.push({
        type: "story.state",
        key: claim.key,
        delta: {
          story: view.story,
          key: claim.key,
          from: before.lifecycle,
          to: "Done",
          detail: [`Done on ${claim.base}${commitText(baseCommit)}`],
        },
        view,
      });
    }
    forgetWorkerNotes(office, claim.worktree);
    forgetContextPack(office, claim.worktree);
    if (findDoneElsewhere(office, claim.runId) === null) {
      insertRow(office, claim, baseCommit, { releasedAt: at });
    } else {
      office.run(
        `update done_elsewhere set released_at = $at, base_commit = coalesce($commit, base_commit)
          where office_id = $office_id and run_id = $run`,
        { run: claim.runId, at, commit: baseCommit },
      );
    }
    entries.push(
      notice(
        "info",
        DONE_ELSEWHERE_NOTICES.released,
        options.text ??
          `${claim.story} is Done on ${claim.base}${commitText(baseCommit)}, not through its own branch ${claim.branch}; dipo released its claim and ended its run.`,
        claim.key,
      ),
    );
    return entries;
  });
  deps.slots?.free(claim.worktree);
}

/**
 * Records a claim released earlier without a row (an own-branch teardown a crash interrupted,
 * released by DIPO-216's reconcile step as `done`), so its kept branch is settled like the others.
 */
export function adoptReleased(
  deps: DoneElsewhereDeps,
  claim: ClaimRecord,
  baseCommit: string | null,
): void {
  if (findDoneElsewhere(deps.office, claim.runId) !== null) return;
  write(deps, () => {
    insertRow(deps.office, claim, baseCommit, { releasedAt: claim.releasedAt ?? deps.clock.now() });
  });
}

/** What `settleDoneElsewhere` did with the worktree and the branch. */
export interface SettleOutcome {
  readonly worktreeKept: boolean;
  readonly branchKept: boolean;
  readonly commits: readonly LostCommit[];
  readonly files: readonly string[];
}

/**
 * Handles the story PR, the worktree and the branch of a released row (see the file comment) and
 * records what was kept. Each step is idempotent, so a row a crash left unsettled is settled again.
 */
export async function settleDoneElsewhere(
  deps: DoneElsewhereDeps,
  row: DoneElsewhereRecord,
): Promise<SettleOutcome> {
  const prProblem = await closePr(deps, row);
  const claim = findClaim(deps.office, row.runId) ?? claimOfRow(row);
  const outcome = await deps.git.run(async (git) => {
    let worktreeKept = false;
    let files: string[] = [];
    if (deps.git.adminDirOf(row.worktree) !== null) {
      const removed = await removeWorktree(deps, git, claim);
      if (!removed.ok) {
        worktreeKept = true;
        files = [...removed.files];
        if (files.length === 0) files = await dirtyFiles(deps, git, claim);
      }
    }
    const branch = await settleBranch(deps, git, row);
    return { worktreeKept, files, ...branch };
  });
  const at = deps.clock.now();
  write(deps, () => {
    const { office } = deps;
    office.run(
      `update done_elsewhere set settled_at = $at, worktree_kept = $worktree, branch_kept = $branch,
         commits = $commits, files = $files
        where office_id = $office_id and run_id = $run`,
      {
        run: row.runId,
        at,
        worktree: outcome.worktreeKept ? 1 : 0,
        branch: outcome.branchKept ? 1 : 0,
        commits: JSON.stringify(outcome.commits),
        files: JSON.stringify(outcome.files),
      },
    );
    if (outcome.branchKept && releasedBranchFor(office, row.key, row.branch) === null) {
      office.run(
        `insert into released_branches (office_id, branch, released_at, key, reason)
         values ($office_id, $branch, $at, $key, $reason)`,
        { branch: row.branch, at, key: row.key, reason: DONE_ELSEWHERE_REASON },
      );
    }
    const entries: NewEntry[] = [];
    if (prProblem !== null) {
      entries.push(notice("warn", DONE_ELSEWHERE_NOTICES.prNotClosed, prProblem, row.key));
    }
    if (outcome.remoteProblem !== null) {
      entries.push(
        notice(
          "warn",
          DONE_ELSEWHERE_NOTICES.remoteBranch,
          `dipo could not delete the remote branch ${row.branch} of ${row.story}: ${outcome.remoteProblem}. Delete it by hand (\`git push ${deps.git.settings.remote} --delete ${row.branch}\`).`,
          row.key,
        ),
      );
    }
    if (outcome.worktreeKept || outcome.branchKept) {
      entries.push(
        notice("warn", DONE_ELSEWHERE_NOTICES.leftovers, leftoversText(row, outcome), row.key),
      );
    } else {
      entries.push(
        notice(
          "info",
          DONE_ELSEWHERE_NOTICES.cleaned,
          `${row.story} is Done on ${row.base}; dipo removed its worktree and its branch ${row.branch}, which held nothing the base does not have.`,
          row.key,
        ),
      );
    }
    return entries;
  });
  // The released run's box goes too (0021 section 6).
  await deps.finishBoxes?.().catch(() => undefined);
  return outcome;
}

/** Settles every released row a crash left unsettled; a failure is left for the next pass. */
export async function settlePending(deps: DoneElsewhereDeps): Promise<number> {
  let settled = 0;
  for (const row of unsettledDoneElsewhere(deps.office)) {
    try {
      await settleDoneElsewhere(deps, row);
      settled += 1;
    } catch {
      // The next poll or reconcile tries again.
    }
  }
  return settled;
}

// ---- steps -------------------------------------------------------------------------------------

/** Closes dipo's open story PR with a comment naming the base commit; returns a problem or null. */
async function closePr(deps: DoneElsewhereDeps, row: DoneElsewhereRecord): Promise<string | null> {
  const pr = latestStoryPr(deps.office, row.key);
  if (pr === null || pr.state !== "open") return null;
  const repo = repoOfPrUrl(pr.url);
  const host = deps.host ?? null;
  if (repo === null || host === null) {
    return `${row.story} is Done on ${row.base}, but dipo could not close its PR #${pr.number} (${repo === null ? "the repository of its URL is unknown" : "no code host"}); close it by hand.`;
  }
  const comment = `Closed by dipo: ${row.story} is Done on ${row.base} through another branch${commitText(row.baseCommit)}, so this PR must not merge.`;
  try {
    await host.closePr(repo, pr.number, comment);
  } catch (error) {
    if (!(error instanceof CodeHostError)) throw error;
    return `${row.story} is Done on ${row.base}, but dipo could not close its PR #${pr.number}: ${error.message}. Close it by hand.`;
  }
  write(deps, () => {
    setStoryPrState(deps.office, pr.runId, { state: "closed", closedAt: deps.clock.now() });
    return [
      {
        type: "story.pr",
        key: row.key,
        run: pr.runId,
        delta: {
          story: row.story,
          key: row.key,
          pr: { number: pr.number, url: pr.url, state: "closed" },
        },
      },
    ];
  });
  return null;
}

/**
 * The branch: deleted locally and on the remote when `merge-tree` shows it adds nothing to the
 * base, else kept with its commits not on the base. A remote tip with commits that are neither on
 * the local branch nor on the base keeps both, with the remote's commits not on the base listed,
 * so no remote commit is deleted unlisted. A branch already gone is nothing kept.
 */
async function settleBranch(
  deps: DoneElsewhereDeps,
  git: GitSession,
  row: DoneElsewhereRecord,
): Promise<{
  readonly branchKept: boolean;
  readonly commits: LostCommit[];
  readonly remoteProblem: string | null;
}> {
  const ref = `refs/heads/${row.branch}`;
  const tip = await commitOf(git, ref);
  if (tip === null) return { branchKept: false, commits: [], remoteProblem: null };
  const baseRef = await baseRefIn(deps, git, row.base);
  if (!(await addsNothingTo(git, baseRef, ref))) {
    return {
      branchKept: true,
      commits: await commitsNotOn(git, baseRef, ref),
      remoteProblem: null,
    };
  }
  const remote = await remoteBranchOf(deps, git, row.branch, tip, row.base);
  if (remote.kind === "tip" && !remote.covered) {
    return {
      branchKept: true,
      commits: await commitsNotOn(git, baseRef, remote.tip),
      remoteProblem: `the remote branch is at ${remote.tip}, with commits that are neither on the local branch nor on ${row.base}, so dipo keeps the branch locally and on the remote`,
    };
  }
  const deleted = await deleteOwnBranch(deps, git, row.branch, row.base);
  if (!deleted.ok) throw new Error(deleted.why);
  const remoteProblem =
    deleted.remoteProblem ??
    (deleted.remoteKept === null
      ? null
      : `its tip there (${deleted.remoteKept}) holds commits that are not on ${row.base}, so dipo keeps it`);
  return { branchKept: false, commits: [], remoteProblem };
}

/** The commits of `ref` not on `baseRef`, short sha and subject, newest first. */
export async function commitsNotOn(
  git: GitSession,
  baseRef: string,
  ref: string,
): Promise<LostCommit[]> {
  const log = await git.step(git.repository, ["log", "--format=%h%x09%s", `${baseRef}..${ref}`]);
  if (log.code !== 0) return [];
  const commits: LostCommit[] = [];
  for (const line of log.stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab > 0) commits.push({ sha: line.slice(0, tab), subject: line.slice(tab + 1) });
  }
  return commits;
}

async function commitOf(git: GitSession, ref: string): Promise<string | null> {
  const found = await git.step(git.repository, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref}^{commit}`,
  ]);
  const sha = found.code === 0 ? found.stdout.trim() : "";
  return sha === "" ? null : sha;
}

// ---- rows and text -----------------------------------------------------------------------------

function insertRow(
  office: OfficeHandle,
  claim: ClaimRecord,
  baseCommit: string | null,
  times: { readonly flaggedAt?: number; readonly releasedAt?: number },
): void {
  office.run(
    `insert into done_elsewhere (office_id, run_id, key, story_id, branch, worktree, start_sha,
       base, base_commit, flagged_at, released_at)
     values ($office_id, $run, $key, $story, $branch, $worktree, $start, $base, $commit,
       $flagged, $released)`,
    {
      run: claim.runId,
      key: claim.key,
      story: claim.story,
      branch: claim.branch,
      worktree: claim.worktree,
      start: claim.startSha,
      base: claim.base,
      commit: baseCommit,
      flagged: times.flaggedAt ?? null,
      released: times.releasedAt ?? null,
    },
  );
}

/** A claim record for a row whose claim row retention already removed. */
function claimOfRow(row: DoneElsewhereRecord): ClaimRecord {
  return {
    runId: row.runId,
    key: row.key,
    story: row.story,
    branch: row.branch,
    worktree: row.worktree,
    base: row.base,
    baseSha: "",
    startSha: row.startSha,
    claimSha: null,
    reused: false,
    snapshot: { path: row.worktree, adminDir: "", commondir: "", gitdir: "", pointer: "" },
    firstFeedback: null,
    claimedAt: 0,
    pushedAt: null,
    releasedAt: row.releasedAt,
    releaseReason: null,
    teardownStartedAt: null,
  };
}

function write(
  deps: Pick<DoneElsewhereDeps, "office" | "clock" | "officeId" | "onChanged" | "onNotice">,
  fn: () => readonly NewEntry[] | void,
): void {
  const at = deps.clock.now();
  const written = deps.office.immediate(() => {
    const entries = fn() ?? [];
    appendEntries(deps.office, entries, { at });
    return entries;
  });
  if (written.length > 0) deps.onChanged?.(deps.officeId);
  for (const entry of written) {
    if (entry.type !== "engine.notice") continue;
    const delta = entry.delta as { readonly code: string; readonly text: string };
    deps.onNotice?.({
      code: delta.code,
      text: delta.text,
      ...(entry.key === undefined ? {} : { key: entry.key }),
    });
  }
}

function commitText(commit: string | null): string {
  return commit === null ? "" : ` (${commit.slice(0, 12)})`;
}

function discardCli(story: string): string {
  return `dipo discard ${story} --note "<why>"`;
}

function leftoversDetail(row: DoneElsewhereRecord, commits: number, files: number): string {
  const parts = [`Done on ${row.base}${commitText(row.baseCommit)}`];
  if (commits > 0)
    parts.push(`branch has ${commits} commit${commits === 1 ? "" : "s"} not on ${row.base}`);
  if (files > 0) parts.push(`${files} file${files === 1 ? "" : "s"} uncommitted`);
  return parts.join(" · ");
}

function leftoversText(row: DoneElsewhereRecord, outcome: SettleOutcome): string {
  const kept: string[] = [];
  if (outcome.branchKept) {
    const subjects = outcome.commits.slice(0, 5).map((c) => `${c.sha} ${c.subject}`);
    kept.push(
      `the branch ${row.branch} with ${outcome.commits.length} commit${outcome.commits.length === 1 ? "" : "s"} not on ${row.base}${subjects.length === 0 ? "" : ` (${subjects.join("; ")})`}`,
    );
  }
  if (outcome.worktreeKept) {
    kept.push(
      `the worktree ${row.worktree}${outcome.files.length === 0 ? "" : ` with uncommitted or untracked files: ${outcome.files.slice(0, 10).join(", ")}${outcome.files.length > 10 ? ` and ${outcome.files.length - 10} more` : ""}`}`,
    );
  }
  return `${row.story} is Done on ${row.base}${commitText(row.baseCommit)}, but dipo kept what is not there: ${kept.join("; and ")}. dipo never deletes these on its own; \`${discardCli(row.story)}\` removes them after listing what is lost.`;
}

function unique<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
