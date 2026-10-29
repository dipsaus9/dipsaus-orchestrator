// Claiming a story (0010 sections 2, 2a and 5): a claim is the story's frozen branch plus a row in
// `claims`. It creates no worktree: the developer works in the story's box (0008), and every later
// git read or write of the story runs on the branch ref in the repository. The engine creates the
// branch from `origin/<base>` (or reuses a branch released for the same story), records the claim,
// runs the caller's `setup` (the box and the launch checks), commits `<ID>: status In Progress`
// on the branch as one story lane edit of the StoryStore (`editOnBranch`), and pushes.
//
// Order and atomicity:
// - When the office has a remote, `OfficeGit.fetch` runs first as its own queue item.
// - Queue item A holds the pickup re-check (the caller's `recheck`, the live-claim check and the
//   pending lane-b check) together with the claim checks, the branch and the live claim record. A
//   lane-b operation is journaled in its own queue item with its live-claim check, so it lands
//   either before this item (the re-check skips the story) or after it (the lane refuses the
//   story, which now has a live claim).
// - `setup` runs outside the git queue, so a long box preparation does not hold it. A failed setup
//   rolls the claim back: nothing was committed or pushed, so a new branch is deleted only while it
//   still points at its start and a reused branch stays where it was released; the story stays
//   Ready and the caller gets a `pickupCheckFailed` skip with the setup log.
// - Queue item C re-checks that the claim is still live, then makes the claim commit and pushes.
//
// A new branch needs the exact local ref absent and `git ls-remote --heads <remote> <branch>`
// empty. It is created by the git writer (`git/write.ts`) with `git update-ref refs/heads/<branch>
// <start> ""`: the empty old value makes the creation atomic, so a claim that lost the race to
// another one is a skip that overwrote nothing. A branch released for the same StoryKey is reused
// at its kept tip: dipo's catch-up merges the base into it and the box later, and a conflict is a
// recorded hand-off (0002). A ref tracked for another story or unknown to the engine is a
// `collision` skip and is never deleted.

import type { Clock, OfficeId, RunId, SkipReason, StoryKey } from "@dipsaus-orchestrator/contract";

import { PENDING_LANE_NOTICE, pendingLaneOp } from "../backlog/lane/journal";
import { appendEntries } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import { FETCH_CONFIG } from "../git/hardened";
import type { GitSession, OfficeGit } from "../git/office";
import { EXTERNAL_STEP_TIMEOUT_MS, GitError, type GitResult, isTimedOut } from "../git/runner";
import { branchTip, createBranch, deleteBranch, moveBranch, pushBranch } from "../git/write";
import { endRunMarked } from "../run/markers";
import type { StoryStore } from "../story-store/store";

import {
  type ClaimRecord,
  failedClaimOf,
  type FAILED_CLAIM_REASONS,
  findClaim,
  insertClaim,
  keysTrackingBranch,
  liveClaimOf,
  markReclaimed,
  releaseClaim,
  type ReleasedBranch,
  releasedBranchFor,
  releaseReclaimedBy,
  updateClaim,
} from "./records";

/** The status the claim commit writes (0012). */
export const CLAIM_STATUS = "In Progress";

/** `engine.notice` codes of the claim. */
export const CLAIM_NOTICES = {
  pendingLaneOp: "claim.pendingLaneOp",
  collision: "claim.collision",
  lostRace: "claim.lostRace",
  pushFailed: "claim.pushFailed",
  leftover: "claim.leftover",
  setupFailed: "setup.failed",
  releasedDuringSetup: "claim.releasedDuringSetup",
  setupInterrupted: "claim.setupInterrupted",
} as const;

/** Why the claim did not happen; nothing is left of it. */
export interface ClaimSkip {
  readonly ok: false;
  readonly reason: SkipReason;
  /** The notice put on the office, or null for a silent skip (the story's own live claim). */
  readonly notice: string | null;
  /** The notice code, or null for a silent skip. */
  readonly code: string | null;
  /** The setup log, when setup failed. */
  readonly log?: string;
}

/** A setup that succeeded; `release` frees what it holds when the claim fails after it. */
export interface ClaimSetupDone {
  readonly ok: true;
  release(): void;
}

/** A setup that failed; it already freed what it took. */
export interface ClaimSetupFailed {
  readonly ok: false;
  /** One line for the notice. */
  readonly reason: string;
  readonly log: string;
}

export interface Claimed<S extends ClaimSetupDone = ClaimSetupDone> {
  readonly ok: true;
  readonly claim: ClaimRecord;
  /** True when the branch was pushed (false without a remote, or when the push failed). */
  readonly pushed: boolean;
  /** What `setup` returned, or null without one. */
  readonly setup: S | null;
}

export type ClaimOutcome<S extends ClaimSetupDone = ClaimSetupDone> = Claimed<S> | ClaimSkip;

export interface ClaimRequest<S extends ClaimSetupDone = ClaimSetupDone> {
  /**
   * Prepares the claimed run (the launch: box and launch checks), after the branch and the claim
   * record and before the claim commit, outside the git queue. A failure rolls the claim back.
   */
  readonly setup?: (claim: ClaimRecord) => Promise<S | ClaimSetupFailed>;
  readonly key: StoryKey;
  /** The story's current id. */
  readonly story: string;
  /** The story's frozen branch (F15), `<ID>/<slug>`. */
  readonly branch: string;
  /** The run that claims. */
  readonly runId: RunId;
  /**
   * The pickup re-check (DIPO-48), run first inside the claim's queue item; a skip it returns
   * ends the claim before anything is created.
   */
  readonly recheck?: (git: GitSession) => Promise<ClaimSkip | null> | ClaimSkip | null;
  /**
   * Called once queue item A committed the live claim row, before `setup` (DIPO-314): from then
   * on no other claim of the story can start, so the caller's own serialized step may end here.
   */
  readonly onClaimed?: () => void;
}

export interface ClaimDeps {
  readonly officeId: OfficeId;
  readonly office: OfficeHandle;
  readonly git: OfficeGit;
  /** The story store; the claim commit is one story lane edit. */
  readonly stories: StoryStore;
  readonly clock: Clock;
  /** Called after the claim appended change-log entries outside a command. */
  readonly onChanged?: (office: OfficeId) => void;
}

/** Claims `request.story`; see the file comment for the order of steps. */
export async function claimStory<S extends ClaimSetupDone = ClaimSetupDone>(
  deps: ClaimDeps,
  request: ClaimRequest<S>,
): Promise<ClaimOutcome<S>> {
  assertBranchOf(request);
  const { remote } = deps.git.settings;
  const hasRemote = await deps.git.run((git) => remoteConfigured(git, remote));
  if (hasRemote) {
    const fetched = await deps.git.fetch();
    if (!fetched.ok) throw fetched.error;
  }
  const base = await deps.git.resolveBase();

  const started = await deps.git.run(async (git): Promise<ClaimSkip | Started> =>
    startClaim(deps, git, request, { base, hasRemote }),
  );
  if (!started.ok) return started;
  request.onClaimed?.();

  // Setup, outside the git queue.
  let setup: S | null = null;
  if (request.setup !== undefined) {
    let result: S | ClaimSetupFailed;
    try {
      result = await request.setup(claimOf(deps, request));
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      result = { ok: false, reason: why, log: `setup: ${why}` };
    }
    if (!result.ok) {
      const failure = result;
      await deps.git.run((git) =>
        rollback(deps, git, request, started.created, true, [...started.made], "setup-failed"),
      );
      return skip(
        deps,
        request,
        "pickupCheckFailed",
        CLAIM_NOTICES.setupFailed,
        `${request.story} was not started: setup failed (${failure.reason}). The claim was rolled back and the story stays Ready. To read the step's output, run \`dipo daemon log-level debug\`, start the story again, then run \`dipo daemon logs --level debug\`.`,
        failure.log,
      );
    }
    setup = result;
  }

  return deps.git.run((git) => finishClaim(deps, git, request, started, setup));
}

/** The claim row of `request`, which item A inserted. */
function claimOf(deps: ClaimDeps, request: ClaimRequest<ClaimSetupDone>): ClaimRecord {
  const claim = findClaim(deps.office, request.runId);
  if (claim === null) throw new Error(`the claim of ${request.runId} vanished after its insert`);
  return claim;
}

/** What queue item A created: the branch and the commits the claim made so far. */
interface Started {
  readonly ok: true;
  readonly created: Created;
  readonly made: readonly string[];
}

interface Created {
  readonly base: string;
  readonly baseSha: string;
  readonly startSha: string;
  readonly released: ReleasedBranch | null;
  readonly hasRemote: boolean;
}

/**
 * Queue item A: the pickup re-check, the claim checks, the branch and the live claim record. A
 * failure after the branch was created rolls the claim back and rethrows.
 */
async function startClaim(
  deps: ClaimDeps,
  git: GitSession,
  request: ClaimRequest<ClaimSetupDone>,
  where: { readonly base: string; readonly hasRemote: boolean },
): Promise<ClaimSkip | Started> {
  const { base, hasRemote } = where;
  const { remote } = deps.git.settings;
  // The pickup re-check: the caller's checks, then the story's own claim and lane b.
  const rechecked = request.recheck === undefined ? null : await request.recheck(git);
  if (rechecked !== null) return rechecked;
  if (liveClaimOf(deps.office, request.key) !== null) {
    return { ok: false, reason: "notRunnable", notice: null, code: null };
  }
  if (pendingLaneOp(deps.office, request.key) !== null) {
    return skip(
      deps,
      request,
      "notRunnable",
      CLAIM_NOTICES.pendingLaneOp,
      `${request.story} was not claimed: ${PENDING_LANE_NOTICE}.`,
    );
  }

  const baseRef = hasRemote ? `refs/remotes/${remote}/${base}` : `refs/heads/${base}`;
  const baseSha = await revParse(git, baseRef);
  if (baseSha === null) {
    throw new GitError(
      "git.baseMissing",
      `${baseRef} does not exist, so ${request.story} has no start point.`,
      false,
      { ref: baseRef },
    );
  }

  const released = releasedBranchFor(deps.office, request.key, request.branch);
  const local = await revParse(git, `refs/heads/${request.branch}`);
  const remoteHeads = hasRemote ? await lsRemote(git, remote, request.branch) : "";
  const refused = collision(deps, request, { released, local, remoteHeads });
  if (refused !== null) return refused;

  // A new branch from the base, created only while no ref of that name exists.
  if (released === null && !(await createBranch(git, request.branch, baseSha))) {
    return skip(
      deps,
      request,
      "collision",
      CLAIM_NOTICES.lostRace,
      `${request.story} was not claimed: another claim or git process created ${request.branch} at the same moment. Nothing was created or overwritten.`,
    );
  }
  const created: Created = {
    base,
    baseSha,
    // A reused branch starts at its kept tip.
    startSha: released === null ? baseSha : (local as string),
    released,
    hasRemote,
  };
  try {
    const now = deps.clock.now();
    deps.office.immediate(() => {
      insertClaim(deps.office, {
        runId: request.runId,
        key: request.key,
        story: request.story,
        branch: request.branch,
        base,
        baseSha,
        startSha: created.startSha,
        claimSha: null,
        reused: released !== null,
        claimedAt: now,
      });
      if (released !== null) markReclaimed(deps.office, released, now, request.runId);
    });
  } catch (error) {
    await rollback(deps, git, request, created, false);
    throw error;
  }
  return { ok: true, created, made: [created.startSha] };
}

/** The collision skip of a branch the claim may not create or reuse, or null. */
function collision(
  deps: ClaimDeps,
  request: ClaimRequest<ClaimSetupDone>,
  found: {
    readonly released: ReleasedBranch | null;
    readonly local: string | null;
    readonly remoteHeads: string;
  },
): ClaimSkip | null {
  const { released, local, remoteHeads } = found;
  const { remote } = deps.git.settings;
  if (released === null && (local !== null || remoteHeads !== "")) {
    const where = [local === null ? null : "locally", remoteHeads === "" ? null : `on ${remote}`]
      .filter((part) => part !== null)
      .join(" and ");
    const others = keysTrackingBranch(deps.office, request.branch).filter(
      (key) => key !== request.key,
    );
    const why =
      others.length > 0
        ? `it is tracked for another story (${others.join(", ")})`
        : failedClaimOf(deps.office, request.key, request.branch) !== null
          ? "it is left over from an earlier failed claim of this story that dipo could not roll back"
          : "dipo did not create it";
    return skip(
      deps,
      request,
      "collision",
      CLAIM_NOTICES.collision,
      `${request.story} was not claimed: the branch ${request.branch} already exists ${where} and ${why}. dipo never deletes it; remove or rename it by hand if it is stale.`,
    );
  }
  if (released !== null && local === null) {
    return skip(
      deps,
      request,
      "collision",
      CLAIM_NOTICES.collision,
      `${request.story} was not claimed: its released branch ${request.branch} is missing locally. Restore it (for example \`git branch ${request.branch} ${remote}/${request.branch}\`) or forget the release.`,
    );
  }
  return null;
}

/**
 * Queue item C, after setup: re-checks that the claim is still live, then makes the claim commit
 * and pushes. A claim released meanwhile (by whatever released it) is undone without touching its
 * row; a failed claim commit rolls the claim back. Each undo also releases what setup holds.
 */
async function finishClaim<S extends ClaimSetupDone>(
  deps: ClaimDeps,
  git: GitSession,
  request: ClaimRequest<S>,
  started: Started,
  setup: S | null,
): Promise<ClaimOutcome<S>> {
  const { created } = started;
  const made = [...started.made];
  const live = findClaim(deps.office, request.runId);
  if (live === null || live.releasedAt !== null) {
    // Released meanwhile: that release keeps its row, its release and the branch.
    setup?.release();
    return skip(
      deps,
      request,
      "notRunnable",
      CLAIM_NOTICES.releasedDuringSetup,
      `${request.story} was not claimed: its claim was released while setup ran.`,
    );
  }

  try {
    // The claim commit, or the tip when the status was already In Progress; recorded either way,
    // so a live claim without `claim_sha` is one whose setup never finished.
    const claimSha =
      (await claimCommit(deps, git, request)) ?? (await branchTip(git, request.branch));
    made.push(claimSha);
    deps.office.immediate(() => updateClaim(deps.office, request.runId, { claimSha }));
  } catch (error) {
    await rollback(deps, git, request, created, true, made);
    setup?.release();
    throw error;
  }

  const pushed = created.hasRemote ? await push(deps, git, request) : false;
  return { ok: true, claim: claimOf(deps, request), pushed, setup };
}

/**
 * Sets the story's status to In Progress in one story lane edit of the store (`editOnBranch`), which
 * commits only its task file on the branch as `<ID>: status In Progress`. Returns the commit, or null when the status was already In Progress.
 */
async function claimCommit(
  deps: ClaimDeps,
  git: GitSession,
  request: ClaimRequest,
): Promise<string | null> {
  const { commit } = await deps.stories.editOnBranch(
    deps.git,
    git,
    request,
    `${request.story}: status ${CLAIM_STATUS}`,
    async (story) => {
      const before = await story.view();
      if (before.status === CLAIM_STATUS) return;
      await story.setStatus(CLAIM_STATUS);
      const back = await story.view();
      if (back.status !== CLAIM_STATUS) {
        throw new GitError(
          "claim.statusNotWritten",
          `The Backlog CLI left ${request.story} at ${back.status}, not ${CLAIM_STATUS}.`,
        );
      }
    },
  );
  return commit;
}

/** Pushes the story branch without force; a failure is a notice, the claim stands. */
async function push(deps: ClaimDeps, git: GitSession, request: ClaimRequest): Promise<boolean> {
  const result = await pushBranch(git, deps.git.settings.remote, request.branch);
  if (result.pushed) {
    const at = deps.clock.now();
    deps.office.immediate(() => updateClaim(deps.office, request.runId, { pushedAt: at }));
    return true;
  }
  const { error } = result;
  // No remote configured (removed since the claim checked): nothing to push, nothing to say.
  if (error === null) return false;
  writeWith(deps, () => [
    notice(
      "warn",
      CLAIM_NOTICES.pushFailed,
      `${request.story} is claimed, but ${error}; the claim is durable only locally until a later push succeeds.`,
      request.key,
    ),
  ]);
  return false;
}

/** What the notice writer needs from the claim's dependencies. */
export type NoticeDeps = Pick<ClaimDeps, "officeId" | "office" | "clock" | "onChanged">;

/** What a rollback needs from the claim's dependencies. */
export type RollbackDeps = Pick<ClaimDeps, "officeId" | "office" | "git" | "clock" | "onChanged">;

/** The story, branch and run a rollback undoes. */
type ClaimIdentity = Pick<ClaimRequest, "key" | "story" | "branch" | "runId">;

/** What the claim created: the branch start and a reused release. */
type CreatedBranch = Pick<Created, "startSha" | "released">;

/**
 * Undoes a claim that failed after its branch was created or taken: a new branch is deleted when
 * its tip is one of the commits this claim made, a reused branch must be back at its start; else
 * the ref is left and a `claim.leftover` notice goes on the office. The claim record ends with
 * `reason` and a reused release opens again. A claim released by something else meanwhile (its row
 * has `released_at`) keeps its row, its release and its branch: that release owns them. Each step
 * is best effort, so the original error is what the caller sees. Runs inside a git queue item.
 */
async function rollback(
  deps: RollbackDeps,
  git: GitSession,
  request: ClaimIdentity,
  created: CreatedBranch,
  recorded: boolean,
  made: readonly string[] = [created.startSha],
  reason: (typeof FAILED_CLAIM_REASONS)[number] = "claim-failed",
): Promise<void> {
  const { released } = created;
  const current = recorded ? findClaim(deps.office, request.runId) : null;
  if (current !== null && current.releasedAt !== null) return;
  const leftBecause = await restoreBranch(git, request.branch, created, made);
  if (leftBecause !== null) {
    const text = `The claim of ${request.story} failed and dipo could not roll back the branch ${request.branch}: ${leftBecause}. It is left as it is; check it and remove or reset it by hand.`;
    writeWith(deps, () => [notice("warn", CLAIM_NOTICES.leftover, text, request.key)]);
  }
  if (!recorded) return;
  const at = deps.clock.now();
  deps.office.immediate(() => {
    // Guarded: a release written since the read above wins and keeps its row and release.
    const ended = deps.office.run(
      `update claims set released_at = $at, release_reason = $reason
       where office_id = $office_id and run_id = $run and released_at is null`,
      { at, run: request.runId, reason },
    );
    // A run recorded for this claim ends with it (DIPO-74).
    if (ended.changes > 0) endRunMarked(deps.office, request.runId, at, reason);
    if (ended.changes > 0 && released !== null) markReclaimed(deps.office, released, null, null);
  });
}

/**
 * Deletes a new branch, or moves a reused one back to its start, when its tip is a commit of
 * `made`. Returns why the branch is left as it is, or null.
 */
async function restoreBranch(
  git: GitSession,
  branch: string,
  created: CreatedBranch,
  made: readonly string[],
): Promise<string | null> {
  const tip = await revParse(git, `refs/heads/${branch}`).catch(() => null);
  if (created.released !== null) {
    if (tip === created.startSha) return null;
    if (tip === null || !made.includes(tip)) {
      return `its tip ${tip ?? "(unreadable)"} is not a commit this claim made`;
    }
    // A reused branch goes back to where it was released.
    const moved = await moveBranch(git, branch, created.startSha, tip).catch(() => false);
    return moved ? null : `moving it back from ${tip} to ${created.startSha} failed`;
  }
  if (tip === null) return null;
  if (!made.includes(tip)) return `its tip ${tip} is not a commit this claim made`;
  const result = await deleteBranch(git, branch, tip).catch(() => null);
  return result?.code === 0
    ? null
    : `deleting it at ${tip} failed (${result?.stderr.trim() || "no result"})`;
}

/**
 * Rolls back a live claim whose setup never finished (no recorded claim commit), for example
 * because the daemon stopped during setup: a new branch is deleted while it still points at its
 * start, a reused branch's release opens again, the row ends as `setup-failed`, and a
 * `claim.setupInterrupted` notice goes on the office. Runs as its own git queue item.
 */
export async function rollBackInterruptedSetup(
  deps: RollbackDeps,
  claim: ClaimRecord,
): Promise<void> {
  await deps.git.run(async (git) => {
    const released = claim.reused ? releaseReclaimedBy(deps.office, claim.runId) : null;
    await rollback(
      deps,
      git,
      claim,
      { startSha: claim.startSha, released },
      true,
      [claim.startSha],
      "setup-failed",
    );
  });
  writeWith(deps, () => [
    notice(
      "warn",
      CLAIM_NOTICES.setupInterrupted,
      `${claim.story} was claimed but its setup did not finish (the daemon stopped during setup); dipo rolled the claim back and the story stays Ready.`,
      claim.key,
    ),
  ]);
}

/**
 * Releases a live claim whose worker did not start after the claim commit (DIPO-74): the branch,
 * which may already be pushed with the claim commit, stays and is recorded as released for the
 * story (0010 section 2a), so the next claim reuses it; the claim and its run end with `reason`.
 */
export function releaseUnstarted(deps: RollbackDeps, claim: ClaimRecord, reason: string): void {
  const at = deps.clock.now();
  deps.office.immediate(() =>
    releaseClaim(deps.office, claim.runId, { at, reason, keepBranch: true }),
  );
}

// ---- helpers ---------------------------------------------------------------------------------

function assertBranchOf(request: ClaimRequest): void {
  if (!request.branch.startsWith(`${request.story}/`)) {
    throw new GitError(
      "claim.branchMismatch",
      `The branch ${request.branch} is not a branch of ${request.story}; a story's frozen branch starts with \`${request.story}/\`.`,
      false,
      { story: request.story, branch: request.branch },
    );
  }
}

async function remoteConfigured(git: GitSession, remote: string): Promise<boolean> {
  const result = await git.step(git.repository, ["config", "--get", `remote.${remote}.url`]);
  return result.code === 0 && result.stdout.trim() !== "";
}

async function revParse(git: GitSession, ref: string): Promise<string | null> {
  const result = await git.step(git.repository, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref}^{commit}`,
  ]);
  return result.code === 0 ? result.stdout.trim() : null;
}

/** `git ls-remote --heads <remote> refs/heads/<branch>`; empty when the remote has no such head. */
async function lsRemote(git: GitSession, remote: string, branch: string): Promise<string> {
  const result = await git
    .step(git.repository, ["ls-remote", "--heads", remote, `refs/heads/${branch}`], {
      config: FETCH_CONFIG,
      timeoutMs: EXTERNAL_STEP_TIMEOUT_MS,
    })
    .catch((error: unknown): GitResult => {
      if (isTimedOut(error)) return { code: null, stdout: "", stderr: error.message };
      throw error;
    });
  if (result.code !== 0) {
    throw new GitError(
      "git.fetchFailed",
      `\`git ls-remote --heads ${remote} ${branch}\` failed (${result.stderr.trim() || `exit ${result.code}`}); the claim waits until the remote answers.`,
      true,
      { remote, branch },
    );
  }
  return result.stdout.trim();
}

export function notice(
  level: "info" | "warn" | "error",
  code: string,
  text: string,
  key: StoryKey,
): { type: string; key: StoryKey; delta: { level: string; code: string; text: string } } {
  return { type: "engine.notice", key, delta: { level, code, text } };
}

/** Runs `fn` in one transaction and appends the entries it returns. */
export function writeWith(deps: NoticeDeps, fn: () => ReturnType<typeof notice>[] | void): void {
  const at = deps.clock.now();
  const appended = deps.office.immediate(() => {
    const entries = fn() ?? [];
    appendEntries(deps.office, entries, { at });
    return entries.length;
  });
  if (appended > 0) deps.onChanged?.(deps.officeId);
}

/** Puts a skip notice on the office and returns the skip. */
function skip(
  deps: ClaimDeps,
  request: ClaimRequest,
  reason: SkipReason,
  code: string,
  text: string,
  log?: string,
): ClaimSkip {
  writeWith(deps, () => [notice("warn", code, text, request.key)]);
  return log === undefined
    ? { ok: false, reason, notice: text, code }
    : { ok: false, reason, notice: text, code, log };
}
