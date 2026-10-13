// Claiming a story (0010 sections 2, 2a and 7): the engine creates the story's frozen branch and a
// locked worktree at `<root>/<ID>` from `origin/<base>`, commits `<ID>: status In Progress` there
// through the Backlog CLI, pushes the branch and records the claim. Setup after the claim (files,
// ports, install) is `setup.ts` (DIPO-39); it runs outside this queue item, so a long install does
// not hold the office's git queue, and a failed setup undoes the claim with `rollbackClaim`.
//
// Order and atomicity:
// - Before anything is created, the free space on the worktree root's filesystem is checked
//   (`platform/disk.ts`); below `MIN_FREE_BYTES` the story is skipped as `notRunnable`.
// - When the office has a remote, `OfficeGit.fetch` runs first as its own queue item.
// - Then one office git queue item holds the pickup re-check (the caller's `recheck`, the live-claim
//   check and the pending lane-b check) together with the claim checks, `git worktree add`, the
//   lock, the claim record, the claim commit and the push. A lane-b operation is journaled in its
//   own queue item with its live-claim check, so it lands either before this item (the re-check
//   skips the story) or after it (the lane refuses the story, which now has a live claim).
//
// A new branch needs the exact local ref absent, `git ls-remote --heads <remote> <branch>` empty
// and no worktree at the path; `git worktree add -b` is atomic, so a lost `cannot lock ref` race
// is a skip with nothing to clean. A branch released for the same StoryKey is reused
// (`git worktree add <path> <branch>`) and `origin/<base>` is merged into it before the claim
// commit; a code conflict is aborted and recorded as the worker's first feedback. A ref tracked
// for another story or unknown to the engine is a `collision` skip and is never deleted; an
// existing worktree path is a skip and is not touched.
//
// At the claim the engine records the snapshot of the worktree's git links (0008 section 2) and
// pins it on the office git, so every later engine git call in that worktree is refused with
// `git.worktreeTampered` once one of them changed.

import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import type { Clock, OfficeId, RunId, SkipReason, StoryKey } from "@dipsaus-orchestrator/contract";

import { viewStory } from "../backlog/fields/write";
import { PENDING_LANE_NOTICE, pendingLaneOp } from "../backlog/lane/journal";
import { statusPaths } from "../backlog/lane/lane";
import { runBacklog, type BacklogCli } from "../backlog/runner";
import { appendEntries } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import { FETCH_CONFIG, type GitLocation, WORKTREE_ADD_CONFIG } from "../git/hardened";
import type { GitSession, OfficeGit } from "../git/office";
import { EXTERNAL_STEP_TIMEOUT_MS, GitError, type GitResult, isTimedOut } from "../git/runner";
import { readWorktreeSnapshot } from "../git/snapshot";
import { type DiskProbe, formatGigabytes } from "../platform/disk";

import {
  type ClaimRecord,
  failedClaimOf,
  type FAILED_CLAIM_REASONS,
  findClaim,
  insertClaim,
  keysTrackingBranch,
  liveClaimOf,
  markReclaimed,
  type ReleasedBranch,
  releasedBranchFor,
  updateClaim,
} from "./records";

/** The free space a claim needs on the worktree root's filesystem (M0 review, DIPO-15): 2 GB. */
export const MIN_FREE_BYTES = 2_000_000_000;

/** The status the claim commit writes (0012). */
export const CLAIM_STATUS = "In Progress";

/** `engine.notice` codes of the claim. */
export const CLAIM_NOTICES = {
  lowDisk: "claim.lowDisk",
  pendingLaneOp: "claim.pendingLaneOp",
  collision: "claim.collision",
  pathExists: "claim.pathExists",
  lostRace: "claim.lostRace",
  mergeConflict: "claim.mergeConflict",
  pushFailed: "claim.pushFailed",
  leftover: "claim.leftover",
} as const;

/** Why the claim did not happen; nothing was created. */
export interface ClaimSkip {
  readonly ok: false;
  readonly reason: SkipReason;
  /** The notice put on the office, or null for a silent skip (the story's own live claim). */
  readonly notice: string | null;
  /** The notice code, or null for a silent skip. */
  readonly code: string | null;
}

export interface Claimed {
  readonly ok: true;
  readonly claim: ClaimRecord;
  /** True when the branch was pushed (false without a remote, or when the push failed). */
  readonly pushed: boolean;
}

export type ClaimOutcome = Claimed | ClaimSkip;

export interface ClaimRequest {
  readonly key: StoryKey;
  /** The story's current id; the worktree is `<root>/<ID>`. */
  readonly story: string;
  /** The story's frozen branch (F15), `<ID>/<slug>`. */
  readonly branch: string;
  /** The run that claims; the worktree lock reason is `dipo <run-id>`. */
  readonly runId: RunId;
  /**
   * The pickup re-check (DIPO-48), run first inside the claim's queue item; a skip it returns
   * ends the claim before anything is created.
   */
  readonly recheck?: (git: GitSession) => Promise<ClaimSkip | null> | ClaimSkip | null;
}

export interface ClaimDeps {
  readonly officeId: OfficeId;
  readonly office: OfficeHandle;
  readonly git: OfficeGit;
  /** How the Backlog CLI starts; it runs inside the story worktree. */
  readonly cli: BacklogCli;
  readonly clock: Clock;
  readonly disk: DiskProbe;
  /** Called after the claim appended change-log entries outside a command. */
  readonly onChanged?: (office: OfficeId) => void;
}

/** A worktree location (the claim only ever builds this kind). */
type WorktreeLocation = Extract<GitLocation, { kind: "worktree" }>;

/** Claims `request.story`; see the file comment for the order of steps. */
export async function claimStory(deps: ClaimDeps, request: ClaimRequest): Promise<ClaimOutcome> {
  const root = deps.git.worktreeRoot();
  const path = join(root, request.story);
  assertBranchOf(request);

  const free = await deps.disk.freeBytes(root);
  if (free < MIN_FREE_BYTES) {
    return skip(
      deps,
      request,
      "notRunnable",
      CLAIM_NOTICES.lowDisk,
      `${request.story} was not claimed: the filesystem holding the worktree root ${root} has ${formatGigabytes(free)} free, less than the ${formatGigabytes(MIN_FREE_BYTES)} a claim needs.`,
    );
  }

  const { remote } = deps.git.settings;
  const hasRemote = await deps.git.run((git) => remoteConfigured(git, remote));
  if (hasRemote) {
    const fetched = await deps.git.fetch();
    if (!fetched.ok) throw fetched.error;
  }
  const base = await deps.git.resolveBase();

  return deps.git.run(async (git) => {
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
    if (existsSync(path)) {
      return skip(
        deps,
        request,
        "collision",
        CLAIM_NOTICES.pathExists,
        `${request.story} was not claimed: the worktree path ${path} already exists. dipo leaves it alone; move it away to claim the story.`,
      );
    }

    // Create the worktree: a new branch from the base, or the released branch.
    const add = await git.step(
      git.repository,
      released === null
        ? ["worktree", "add", "--quiet", "-b", request.branch, path, baseSha]
        : ["worktree", "add", "--quiet", path, request.branch],
      { config: WORKTREE_ADD_CONFIG },
    );
    if (add.code !== 0) {
      if (released === null && lostRace(add.stderr)) {
        return skip(
          deps,
          request,
          "collision",
          CLAIM_NOTICES.lostRace,
          `${request.story} was not claimed: another git process created ${request.branch} at the same moment (${add.stderr.trim()}). Nothing was created.`,
        );
      }
      throw failed(["worktree", "add"], add);
    }

    const created: Created = {
      path,
      base,
      baseRef,
      baseSha,
      startSha: released === null ? baseSha : (local as string),
      released,
      hasRemote,
    };
    if (released === null) return completeClaim(deps, git, request, created);
    // A reused branch starts at what the new worktree checked out.
    let head: string;
    try {
      head = (
        await git.ok(deps.git.worktreeLocation(path), ["rev-parse", "--verify", "HEAD"])
      ).trim();
    } catch (error) {
      await rollback(deps, git, request, created, false);
      throw error;
    }
    return completeClaim(deps, git, request, {
      ...created,
      startSha: head,
    });
  });
}

interface Created {
  readonly path: string;
  readonly base: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly startSha: string;
  readonly released: ReleasedBranch | null;
  readonly hasRemote: boolean;
}

/**
 * Everything after `git worktree add`: lock, snapshot, record, merge (reused branch), claim
 * commit, push. A failure before the claim commit rolls the claim back and rethrows.
 */
async function completeClaim(
  deps: ClaimDeps,
  git: GitSession,
  request: ClaimRequest,
  created: Created,
): Promise<ClaimOutcome> {
  const { path, released } = created;
  const now = deps.clock.now();
  let recorded = false;
  // The commits this claim made on the branch, collected as they are made; rollback moves only a
  // ref whose tip is one of them.
  const made: string[] = [created.startSha];
  try {
    await git.ok(git.repository, ["worktree", "lock", "--reason", `dipo ${request.runId}`, path]);
    const adminDir = deps.git.adminDirOf(path);
    if (adminDir === null) {
      throw new GitError("git.failed", `${path} is not registered after \`git worktree add\`.`);
    }
    const snapshot = readWorktreeSnapshot(path, adminDir);
    deps.git.pinWorktree(snapshot);
    deps.office.immediate(() => {
      insertClaim(deps.office, {
        runId: request.runId,
        key: request.key,
        story: request.story,
        branch: request.branch,
        worktree: path,
        base: created.base,
        baseSha: created.baseSha,
        startSha: created.startSha,
        claimSha: null,
        reused: released !== null,
        snapshot,
        firstFeedback: null,
        claimedAt: now,
      });
      if (released !== null) markReclaimed(deps.office, released, now, request.runId);
    });
    recorded = true;

    const location = deps.git.worktreeLocation(path) as WorktreeLocation;
    if (released !== null) {
      const feedback = await mergeBase(git, location, request, created);
      if (feedback !== null) {
        writeWith(deps, () => {
          updateClaim(deps.office, request.runId, { firstFeedback: feedback });
          return [notice("warn", CLAIM_NOTICES.mergeConflict, feedback, request.key)];
        });
      }
      // The merge commit (or the start again, when the branch was up to date).
      made.push((await git.ok(location, ["rev-parse", "--verify", "HEAD"])).trim());
    }

    const claimSha = await claimCommit(deps, git, location, request);
    if (claimSha !== null) {
      made.push(claimSha);
      deps.office.immediate(() => updateClaim(deps.office, request.runId, { claimSha }));
    }
  } catch (error) {
    await rollback(deps, git, request, created, recorded, made);
    throw error;
  }

  const pushed = created.hasRemote ? await push(deps, git, request) : false;
  const claim = findClaim(deps.office, request.runId);
  if (claim === null) throw new Error(`the claim of ${request.runId} vanished after its insert`);
  return { ok: true, claim, pushed };
}

/**
 * Merges `origin/<base>` into a reused branch (0010 section 2a). Returns the worker's first
 * feedback when the merge conflicts (the merge is aborted), else null.
 */
async function mergeBase(
  git: GitSession,
  location: WorktreeLocation,
  request: ClaimRequest,
  created: Created,
): Promise<string | null> {
  const name = created.baseRef.replace(/^refs\/(?:remotes|heads)\//, "");
  const merged = await commitStep(git, location, [
    "merge",
    "--quiet",
    "--no-ff",
    "--no-edit",
    "-m",
    `Merge ${name} into ${request.branch}`,
    created.baseSha,
  ]);
  if (merged.code === 0) return null;
  const unmerged = (await git.ok(location, ["diff", "--name-only", "-z", "--diff-filter=U"]))
    .split("\0")
    .filter((file) => file !== "");
  if (merged.code !== 1 || unmerged.length === 0) throw failed(["merge"], merged);
  await git.ok(location, ["merge", "--abort"]);
  return `Merging ${name} into ${request.branch} conflicts in ${unmerged.join(", ")}; dipo aborted the merge. Merge ${name} into the branch and resolve the conflicts.`;
}

/**
 * Sets the story's status to In Progress through the Backlog CLI in its worktree and commits only
 * its task file as `<ID>: status In Progress`. Returns the commit, or null when the status was
 * already In Progress.
 */
async function claimCommit(
  deps: ClaimDeps,
  git: GitSession,
  location: WorktreeLocation,
  request: ClaimRequest,
): Promise<string | null> {
  const target = { cli: deps.cli, cwd: location.workTree, id: request.story };
  const before = await viewStory(target);
  if (before.status !== CLAIM_STATUS) {
    await runBacklog(deps.cli, location.workTree, [
      "task",
      "edit",
      request.story,
      "--status",
      CLAIM_STATUS,
    ]);
    const back = await viewStory(target);
    if (back.status !== CLAIM_STATUS) {
      throw new GitError(
        "claim.statusNotWritten",
        `The Backlog CLI left ${request.story} at ${back.status}, not ${CLAIM_STATUS}.`,
      );
    }
  }
  const taskFile = repoPath(location.workTree, before.file);
  const changed = statusPaths(
    await git.ok(location, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  );
  const others = changed.filter((file) => file !== taskFile);
  if (others.length > 0) {
    throw new GitError(
      "claim.scope",
      `The claim of ${request.story} changed more than its task file ${taskFile}: ${others.join(", ")}.`,
      false,
      { taskFile, others },
    );
  }
  if (changed.length === 0) return null;
  await git.ok(location, ["add", "--", taskFile]);
  const committed = await commitStep(git, location, [
    "commit",
    "--quiet",
    "--no-verify",
    "-m",
    `${request.story}: status ${CLAIM_STATUS}`,
  ]);
  if (committed.code !== 0) throw failed(["commit"], committed);
  return (await git.ok(location, ["rev-parse", "--verify", "HEAD"])).trim();
}

/** Pushes the story branch without force; a failure is a notice, the claim stands. */
async function push(deps: ClaimDeps, git: GitSession, request: ClaimRequest): Promise<boolean> {
  const { remote } = deps.git.settings;
  const ref = `refs/heads/${request.branch}`;
  const result = await git
    .step(git.repository, ["push", "--quiet", "--no-verify", remote, `${ref}:${ref}`], {
      config: FETCH_CONFIG,
      timeoutMs: EXTERNAL_STEP_TIMEOUT_MS,
    })
    .catch((error: unknown): GitResult => {
      if (isTimedOut(error)) return { code: null, stdout: "", stderr: error.message };
      throw error;
    });
  if (result.code === 0) {
    const at = deps.clock.now();
    deps.office.immediate(() => updateClaim(deps.office, request.runId, { pushedAt: at }));
    return true;
  }
  writeWith(deps, () => [
    notice(
      "warn",
      CLAIM_NOTICES.pushFailed,
      `${request.story} is claimed, but pushing ${request.branch} to ${remote} failed (${result.stderr.trim() || `exit ${result.code}`}); the claim is durable only locally until a later push succeeds.`,
      request.key,
    ),
  ]);
  return false;
}

/** What a rollback needs from the claim's dependencies. */
export type RollbackDeps = Pick<ClaimDeps, "officeId" | "office" | "git" | "clock" | "onChanged">;

/** The claim a rollback undoes. */
export interface RollbackTarget {
  readonly key: StoryKey;
  readonly story: string;
  readonly branch: string;
  readonly runId: RunId;
  /** The worktree path. */
  readonly path: string;
  /** The commit the worktree started from. */
  readonly startSha: string;
  /** The release a reused branch came from, reopened by the rollback; null for a new branch. */
  readonly released: ReleasedBranch | null;
  /** True when the claim row exists; the rollback ends it with `reason`. */
  readonly recorded: boolean;
  /** The commits this claim made on the branch: its start, a base merge, the claim commit. */
  readonly made: readonly string[];
  /** The `release_reason` the claim row gets: `claim-failed`, or `setup-failed` (DIPO-39). */
  readonly reason: (typeof FAILED_CLAIM_REASONS)[number];
  /** Leave the branch ref as it is (a reused branch whose claim commit is already pushed). */
  readonly keepRef?: boolean;
}

/**
 * Undoes a claim that failed after `git worktree add`: unpin, unlock and remove the worktree,
 * delete a new branch (or move a reused one back to its start) when the worktree is gone and the
 * tip is one of the commits this claim made, else leave the ref and put a `claim.leftover` notice
 * on the office; end the claim record and reopen a reused release. Each step is best effort, so
 * the original error is what the caller sees. Runs inside the caller's git queue item. Returns
 * true when the branch is back where it was before the claim (gone, or at its start).
 */
export async function rollbackClaim(
  deps: RollbackDeps,
  git: GitSession,
  target: RollbackTarget,
): Promise<boolean> {
  const { path, released } = target;
  deps.git.unpinWorktree(path);
  const quiet = async (args: readonly string[]): Promise<void> => {
    await git.step(git.repository, args).catch(() => undefined);
  };
  await quiet(["worktree", "unlock", path]);
  await quiet(["worktree", "remove", "--force", path]);
  // A new branch is deleted, a reused one goes back to its start, only when the worktree is gone
  // and the tip is a commit this claim made (`made`); each ref change is guarded by the tip read
  // here. Anything else is left as it is and reported.
  const ref = `refs/heads/${target.branch}`;
  const tip = await revParse(git, ref).catch(() => null);
  let restored = released === null ? tip === null : tip === target.startSha;
  if (!restored && target.keepRef !== true) {
    let leftBecause: string | null = null;
    if (deps.git.adminDirOf(path) !== null) {
      leftBecause = `its worktree ${path} could not be removed`;
    } else if (tip === null || !target.made.includes(tip)) {
      leftBecause = `its tip ${tip ?? "(unreadable)"} is not a commit this claim made`;
    } else {
      const args =
        released === null
          ? ["update-ref", "-d", ref, tip]
          : ["update-ref", ref, target.startSha, tip];
      const result = await git.step(git.repository, args).catch(() => null);
      if (result?.code === 0) {
        restored = true;
      } else {
        leftBecause = `\`git ${args.join(" ")}\` failed (${result?.stderr.trim() || "no result"})`;
      }
    }
    if (leftBecause !== null) {
      const text = `The claim of ${target.story} failed and dipo could not roll back the branch ${target.branch}: ${leftBecause}. It is left as it is; check it and remove or reset it by hand.`;
      writeWith(deps, () => [notice("warn", CLAIM_NOTICES.leftover, text, target.key)]);
    }
  }
  if (!target.recorded) return restored;
  const at = deps.clock.now();
  deps.office.immediate(() => {
    deps.office.run(
      `update claims set released_at = $at, release_reason = $reason
       where office_id = $office_id and run_id = $run`,
      { at, run: target.runId, reason: target.reason },
    );
    if (released !== null) markReclaimed(deps.office, released, null, null);
  });
  return restored;
}

/** Rolls back a claim that failed inside `claimStory`. */
async function rollback(
  deps: ClaimDeps,
  git: GitSession,
  request: ClaimRequest,
  created: Created,
  recorded: boolean,
  made: readonly string[] = [created.startSha],
): Promise<void> {
  await rollbackClaim(deps, git, {
    key: request.key,
    story: request.story,
    branch: request.branch,
    runId: request.runId,
    path: created.path,
    startSha: created.startSha,
    released: created.released,
    recorded,
    made,
    reason: "claim-failed",
  });
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

/** stderr of a `worktree add -b` that lost the race for the branch ref (0010 fact 8). */
function lostRace(stderr: string): boolean {
  return /cannot lock ref|a branch named '[^']+' already exists/i.test(stderr);
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

/** A step that commits (and may sign), killed after `EXTERNAL_STEP_TIMEOUT_MS`. */
async function commitStep(
  git: GitSession,
  location: WorktreeLocation,
  args: readonly string[],
): Promise<GitResult> {
  return git.step(location, args, { timeoutMs: EXTERNAL_STEP_TIMEOUT_MS });
}

function failed(args: readonly string[], result: GitResult): GitError {
  return new GitError(
    "git.failed",
    `git ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.code}`}`,
    false,
    { args: [...args], code: result.code, stderr: result.stderr },
  );
}

/** The real path of `path`, or `path` itself when it cannot be resolved. */
function realOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** `file` (absolute, as the CLI printed it) relative to the worktree, with `/` separators. */
function repoPath(worktree: string, file: string): string {
  const rel = relative(realOr(worktree), realOr(file));
  if (rel === "" || isAbsolute(rel) || rel.startsWith("..") || !rel.startsWith(`backlog${sep}`)) {
    throw new GitError(
      "claim.scope",
      `The Backlog CLI named ${file} as the task file, which is not under ${worktree}/backlog.`,
      false,
      { file },
    );
  }
  return rel.split(sep).join("/");
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
export function writeWith(deps: RollbackDeps, fn: () => ReturnType<typeof notice>[] | void): void {
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
): ClaimSkip {
  writeWith(deps, () => [notice("warn", code, text, request.key)]);
  return { ok: false, reason, notice: text, code };
}
