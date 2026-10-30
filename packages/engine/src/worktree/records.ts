// Claim facts (0007 section 4, 0010 sections 2a and 7): rows of `claims` and `released_branches`,
// read and written through the office handle. A claim is live from the claim until its release;
// the planning lane refuses a story with a live claim (lane a owns it), and the backlog PR check
// (DIPO-35) reads live claims. Writers run inside the caller's `office.immediate`.

import type { RunId, StoryKey } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import type { RunEnd } from "../records/lifecycle";
import { endRunMarked } from "../run/markers";

export interface ClaimRecord {
  readonly runId: RunId;
  readonly key: StoryKey;
  /** The story id at the claim. */
  readonly story: string;
  readonly branch: string;
  /** The base branch name, for example `main`. */
  readonly base: string;
  /** `origin/<base>` (local `<base>` without a remote) at the claim. */
  readonly baseSha: string;
  /** The commit the branch started from: `baseSha` for a new branch, the kept tip when reused. */
  readonly startSha: string;
  /**
   * The claim commit (the branch tip after the claim when the status was already In Progress), or
   * null until the claim finished: a live claim without it is one whose setup never finished.
   */
  readonly claimSha: string | null;
  /** True when a branch released for this story was reused (0010 section 2a). */
  readonly reused: boolean;
  readonly claimedAt: number;
  readonly pushedAt: number | null;
  readonly releasedAt: number | null;
  readonly releaseReason: string | null;
  /** When the teardown of a Done story started its git steps (DIPO-58), or null. */
  readonly teardownStartedAt: number | null;
}

interface ClaimRow {
  run_id: string;
  key: string;
  story_id: string;
  branch: string;
  base: string;
  base_sha: string;
  start_sha: string;
  claim_sha: string | null;
  reused: number;
  claimed_at: number;
  pushed_at: number | null;
  released_at: number | null;
  release_reason: string | null;
  teardown_started_at: number | null;
}

const COLUMNS = `run_id, key, story_id, branch, base, base_sha, start_sha, claim_sha, reused, claimed_at,
  pushed_at, released_at, release_reason`;

/** The columns a read selects: the inserted ones and those set later. */
const READ_COLUMNS = `${COLUMNS}, teardown_started_at`;

function toRecord(row: ClaimRow): ClaimRecord {
  return {
    runId: row.run_id as RunId,
    key: row.key as StoryKey,
    story: row.story_id,
    branch: row.branch,
    base: row.base,
    baseSha: row.base_sha,
    startSha: row.start_sha,
    claimSha: row.claim_sha,
    reused: row.reused === 1,
    claimedAt: row.claimed_at,
    pushedAt: row.pushed_at,
    releasedAt: row.released_at,
    releaseReason: row.release_reason,
    teardownStartedAt: row.teardown_started_at,
  };
}

export type NewClaim = Omit<
  ClaimRecord,
  "pushedAt" | "releasedAt" | "releaseReason" | "teardownStartedAt"
>;

/** Records a live claim. Runs inside the caller's transaction. */
export function insertClaim(office: OfficeHandle, claim: NewClaim): void {
  office.run(
    `insert into claims (office_id, ${COLUMNS})
     values ($office_id, $run, $key, $story, $branch, $base, $base_sha, $start_sha, $claim_sha,
       $reused, $at, null, null, null)`,
    {
      run: claim.runId,
      key: claim.key,
      story: claim.story,
      branch: claim.branch,
      base: claim.base,
      base_sha: claim.baseSha,
      start_sha: claim.startSha,
      claim_sha: claim.claimSha,
      reused: claim.reused ? 1 : 0,
      at: claim.claimedAt,
    },
  );
}

export interface ClaimChange {
  readonly claimSha?: string;
  readonly pushedAt?: number;
}

/** Updates the claim of `runId`. Runs inside the caller's transaction. */
export function updateClaim(office: OfficeHandle, runId: RunId, change: ClaimChange): void {
  office.run(
    `update claims set
       claim_sha = coalesce($claim_sha, claim_sha),
       pushed_at = coalesce($pushed_at, pushed_at)
     where office_id = $office_id and run_id = $run`,
    {
      run: runId,
      claim_sha: change.claimSha ?? null,
      pushed_at: change.pushedAt ?? null,
    },
  );
}

export function findClaim(office: OfficeHandle, runId: RunId): ClaimRecord | null {
  const row = office.get<ClaimRow>(
    `select ${READ_COLUMNS} from claims where office_id = $office_id and run_id = $run`,
    { run: runId },
  );
  return row === null ? null : toRecord(row);
}

/** The story's live claim, or null. */
export function liveClaimOf(office: OfficeHandle, key: StoryKey): ClaimRecord | null {
  const row = office.get<ClaimRow>(
    `select ${READ_COLUMNS} from claims
     where office_id = $office_id and key = $key and released_at is null`,
    { key },
  );
  return row === null ? null : toRecord(row);
}

/**
 * True when the story has a live claim, so it belongs to lane a (0010 section 2): the planning
 * lane refuses it and the backlog PR check (DIPO-35) fails a PR that touches it.
 */
export function hasLiveClaim(office: OfficeHandle, key: StoryKey): boolean {
  return liveClaimOf(office, key) !== null;
}

/** Release reasons of a claim that failed and was rolled back. */
export const FAILED_CLAIM_REASONS = ["claim-failed", "setup-failed"] as const;

/**
 * The latest claim of the story on `branch` that failed and was rolled back (in the claim, or in
 * setup after it, DIPO-39), or null.
 */
export function failedClaimOf(
  office: OfficeHandle,
  key: StoryKey,
  branch: string,
): ClaimRecord | null {
  const row = office.get<ClaimRow>(
    `select ${READ_COLUMNS} from claims
     where office_id = $office_id and key = $key and branch = $branch
       and release_reason in ('claim-failed', 'setup-failed')
     order by released_at desc limit 1`,
    { key, branch },
  );
  return row === null ? null : toRecord(row);
}

/** Every live claim of the office, oldest first. */
export function liveClaims(office: OfficeHandle): ClaimRecord[] {
  return office
    .all<ClaimRow>(
      `select ${READ_COLUMNS} from claims where office_id = $office_id and released_at is null
       order by claimed_at, run_id`,
    )
    .map(toRecord);
}

/**
 * The story keys the engine has tracked `branch` for: every claim of it and every release of it,
 * live or not, and the frozen branch the story index recorded.
 */
export function keysTrackingBranch(office: OfficeHandle, branch: string): StoryKey[] {
  const rows = office.all<{ key: string }>(
    `select key from claims where office_id = $office_id and branch = $branch
     union select key from released_branches where office_id = $office_id and branch = $branch
     union select key from stories where office_id = $office_id and frozen_branch = $branch
     order by key`,
    { branch },
  );
  return rows.map((row) => row.key as StoryKey);
}

/**
 * Ends the claim of `runId` (`released_at`, reason) and its run as `ending` (0020: done for a
 * story that is Done, dropped otherwise; DIPO-74). With `keepBranch`, records the branch as released for the story (0010
 * section 2a), so a later claim of the same StoryKey reuses it. Runs inside the caller's
 * transaction. Release steps themselves (the restore commit, the worktree
 * removal) belong to the transition that releases.
 */
export function releaseClaim(
  office: OfficeHandle,
  runId: RunId,
  release: {
    readonly at: number;
    readonly reason: string;
    readonly ending: Extract<RunEnd, "done" | "dropped">;
    readonly keepBranch: boolean;
  },
): void {
  const claim = findClaim(office, runId);
  if (claim === null || claim.releasedAt !== null) return;
  office.run(
    `update claims set released_at = $at, release_reason = $reason
     where office_id = $office_id and run_id = $run`,
    { run: runId, at: release.at, reason: release.reason },
  );
  endRunMarked(office, runId, release.at, release.ending);
  if (release.keepBranch) {
    office.run(
      `insert into released_branches (office_id, branch, released_at, key, reason)
       values ($office_id, $branch, $at, $key, $reason)`,
      { branch: claim.branch, at: release.at, key: claim.key, reason: release.reason },
    );
  }
}

export interface ReleasedBranch {
  readonly branch: string;
  readonly key: StoryKey;
  readonly releasedAt: number;
  readonly reason: string;
}

/** The open release of `branch` for `key` (not yet reclaimed), or null. */
export function releasedBranchFor(
  office: OfficeHandle,
  key: StoryKey,
  branch: string,
): ReleasedBranch | null {
  const row = office.get<{ branch: string; key: string; released_at: number; reason: string }>(
    `select branch, key, released_at, reason from released_branches
     where office_id = $office_id and key = $key and branch = $branch and reclaimed_at is null
     order by released_at desc limit 1`,
    { key, branch },
  );
  return row === null
    ? null
    : {
        branch: row.branch,
        key: row.key as StoryKey,
        releasedAt: row.released_at,
        reason: row.reason,
      };
}

/** The open releases (not reclaimed) of the story `key`, oldest first (DIPO-228). */
export function openReleasedBranches(office: OfficeHandle, key: StoryKey): ReleasedBranch[] {
  return office
    .all<{ branch: string; key: string; released_at: number; reason: string }>(
      `select branch, key, released_at, reason from released_branches
       where office_id = $office_id and key = $key and reclaimed_at is null
       order by released_at, branch`,
      { key },
    )
    .map((row) => ({
      branch: row.branch,
      key: row.key as StoryKey,
      releasedAt: row.released_at,
      reason: row.reason,
    }));
}

/** Marks a release reclaimed by `runId`, or (with `at` null) open again. In the caller's transaction. */
export function markReclaimed(
  office: OfficeHandle,
  released: ReleasedBranch,
  at: number | null,
  runId: RunId | null,
): void {
  office.run(
    `update released_branches set reclaimed_at = $at, reclaimed_by = $run
     where office_id = $office_id and branch = $branch and released_at = $released_at`,
    { at, run: runId, branch: released.branch, released_at: released.releasedAt },
  );
}

/** The release the claim of `runId` reused (0010 section 2a), or null. */
export function releaseReclaimedBy(office: OfficeHandle, runId: RunId): ReleasedBranch | null {
  const row = office.get<{ branch: string; key: string; released_at: number; reason: string }>(
    `select branch, key, released_at, reason from released_branches
     where office_id = $office_id and reclaimed_by = $run
     order by released_at desc limit 1`,
    { run: runId },
  );
  return row === null
    ? null
    : {
        branch: row.branch,
        key: row.key as StoryKey,
        releasedAt: row.released_at,
        reason: row.reason,
      };
}

/**
 * Records that the teardown of the live claim of `runId` started (DIPO-58), or with `at` null that
 * it stopped and kept everything. Runs inside the caller's transaction.
 */
export function markTeardownStarted(office: OfficeHandle, runId: RunId, at: number | null): void {
  office.run(
    `update claims set teardown_started_at = $at
     where office_id = $office_id and run_id = $run and released_at is null`,
    { run: runId, at },
  );
}
