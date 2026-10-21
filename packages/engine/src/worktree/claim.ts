// Claiming a story (0010 sections 2, 2a and 7): the engine creates the story's frozen branch and a
// locked worktree at `<root>/<ID>` from `origin/<base>`, commits `<ID>: status In Progress` there
// through the Backlog CLI, pushes the branch and records the claim. Between the worktree and the
// claim commit the caller's `setup` runs (DIPO-39, `setup.ts`: files, port slot, install), as 0010
// section 7 orders: setup, then the claim commit, then the push. The Backlog CLI runs in dipo's
// own copy of the story's backlog, never in the worktree (`inStoryBacklog`, 0021 section 14).
//
// Order and atomicity:
// - Before anything is created, the free space on the worktree root's filesystem is checked
//   (`platform/disk.ts`); below `MIN_FREE_BYTES` the story is skipped as `notRunnable`.
// - When the office has a remote, `OfficeGit.fetch` runs first as its own queue item.
// - Queue item A holds the pickup re-check (the caller's `recheck`, the live-claim check and the
//   pending lane-b check) together with the claim checks, `git worktree add`, the lock, the live
//   claim record and, for a reused branch, the merge of the base. A lane-b operation is journaled
//   in its own queue item with its live-claim check, so it lands either before this item (the
//   re-check skips the story) or after it (the lane refuses the story, which now has a live claim).
// - `setup` runs outside the git queue, so a long install does not hold it. A failed setup rolls
//   the claim back: nothing was committed or pushed, so a new branch is deleted only while it still
//   points at its start and a reused branch goes back to exactly where it was released; the story
//   stays Ready and the caller gets a `pickupCheckFailed` skip with the setup log.
// - Queue item C re-checks that the claim is still live and the worktree's git links unchanged,
//   then makes the claim commit and pushes.
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

import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

import type { Clock, OfficeId, RunId, SkipReason, StoryKey } from "@dipsaus-orchestrator/contract";

import { viewStory } from "../backlog/fields/write";
import { PENDING_LANE_NOTICE, pendingLaneOp } from "../backlog/lane/journal";
import { runBacklog, type BacklogCli } from "../backlog/runner";
import { appendEntries } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import { FETCH_CONFIG, type GitLocation, WORKTREE_ADD_CONFIG } from "../git/hardened";
import type { GitSession, OfficeGit } from "../git/office";
import { EXTERNAL_STEP_TIMEOUT_MS, GitError, type GitResult, isTimedOut } from "../git/runner";
import { changedLinks, readWorktreeSnapshot, worktreeTampered } from "../git/snapshot";
import { commitTaskFile, pushBranch, statusPaths } from "../git/task-commit";
import { type DiskProbe, formatGigabytes } from "../platform/disk";
import { endRunMarked } from "../run/markers";
import { BRANCH_READ_PREFIX } from "../stories/branch-read";

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
   * Sets up the claimed worktree (DIPO-39), after the worktree, lock and claim record and before
   * the claim commit, outside the git queue. A failure rolls the claim back.
   */
  readonly setup?: (claim: ClaimRecord) => Promise<S | ClaimSetupFailed>;
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
  /** How the Backlog CLI starts; it runs in dipo's own copy of the story's backlog. */
  readonly cli: BacklogCli;
  readonly clock: Clock;
  readonly disk: DiskProbe;
  /** Called after the claim appended change-log entries outside a command. */
  readonly onChanged?: (office: OfficeId) => void;
}

/** A worktree location (the claim only ever builds this kind). */
type WorktreeLocation = Extract<GitLocation, { kind: "worktree" }>;

/** Claims `request.story`; see the file comment for the order of steps. */
export async function claimStory<S extends ClaimSetupDone = ClaimSetupDone>(
  deps: ClaimDeps,
  request: ClaimRequest<S>,
): Promise<ClaimOutcome<S>> {
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

  const started = await deps.git.run(async (git): Promise<ClaimSkip | Started> => {
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
    if (released === null) return startClaim(deps, git, request, created);
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
    return startClaim(deps, git, request, {
      ...created,
      startSha: head,
    });
  });
  if (!started.ok) return started;

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
        rollback(deps, git, request, started.created, true, started.made, "setup-failed"),
      );
      return skip(
        deps,
        request,
        "pickupCheckFailed",
        CLAIM_NOTICES.setupFailed,
        `${request.story} was not started: setup failed (${failure.reason}). The worktree was removed and the story stays Ready. To read the step's output, run \`dipo daemon log-level debug\`, start the story again, then run \`dipo daemon logs --level debug\`.`,
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

/** What queue item A created: the worktree and the commits the claim made so far. */
interface Started {
  readonly ok: true;
  readonly created: Created;
  readonly made: readonly string[];
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
 * The rest of queue item A after `git worktree add`: lock, snapshot, live claim record, and the
 * base merge of a reused branch. A failure rolls the claim back and rethrows.
 */
async function startClaim(
  deps: ClaimDeps,
  git: GitSession,
  request: ClaimRequest,
  created: Created,
): Promise<Started> {
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
  } catch (error) {
    await rollback(deps, git, request, created, recorded, made);
    throw error;
  }
  return { ok: true, created, made };
}

/**
 * Queue item C, after setup: re-checks that the claim is still live and the worktree's git links
 * unchanged, then makes the claim commit and pushes. A claim released meanwhile (by whatever
 * released it) is undone without touching its row; a changed link refuses with
 * `git.worktreeTampered` and leaves everything for the maintainer; a failed claim commit rolls
 * the claim back. Each undo also releases what setup holds.
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
    await rollback(deps, git, request, created, true, made);
    setup?.release();
    return skip(
      deps,
      request,
      "notRunnable",
      CLAIM_NOTICES.releasedDuringSetup,
      `${request.story} was not claimed: its claim was released while setup ran, so dipo removed the worktree.`,
    );
  }
  const changed = changedLinks(live.snapshot);
  if (changed.length > 0) throw worktreeTampered(live.snapshot, changed);

  try {
    const location = deps.git.worktreeLocation(created.path) as WorktreeLocation;
    // The claim commit, or the tip when the status was already In Progress; recorded either way,
    // so a live claim without `claim_sha` is one whose setup never finished.
    const claimSha =
      (await claimCommit(deps, git, location, request)) ??
      (await git.ok(location, ["rev-parse", "--verify", "HEAD"])).trim();
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
 * Sets the story's status to In Progress through the Backlog CLI in dipo's own copy of the
 * story's backlog (`inStoryBacklog`), never in the worktree, and commits only its task file as
 * `<ID>: status In Progress`. Returns the commit, or null when the status was already In Progress.
 */
async function claimCommit(
  deps: ClaimDeps,
  git: GitSession,
  location: WorktreeLocation,
  request: ClaimRequest,
): Promise<string | null> {
  const taskFile = await inStoryBacklog(
    deps.git,
    git,
    location,
    request.story,
    true,
    async (backlog) => {
      const target = { cli: deps.cli, cwd: backlog.cwd, id: request.story };
      const before = await viewStory(target);
      if (before.status !== CLAIM_STATUS) {
        await runBacklog(deps.cli, backlog.cwd, [
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
      return repoPath(backlog.cwd, before.file);
    },
  );
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
  return commitTaskFile(git, location, taskFile, `${request.story}: status ${CLAIM_STATUS}`);
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

/** What the claim created: the worktree, the branch start, a reused release. */
type CreatedWorktree = Pick<Created, "path" | "startSha" | "released">;

/**
 * Undoes a claim that failed after `git worktree add`: unpin, unlock and remove the worktree,
 * delete a new branch (or move a reused one back to its start) when the worktree is gone and the
 * tip is one of the commits this claim made, else leave the ref and put a `claim.leftover` notice
 * on the office; end the claim record with `reason` and reopen a reused release. A claim that was
 * released by something else meanwhile (its row has `released_at`) keeps its row, its release
 * and its branch: that release owns them, and only the worktree is removed. Each step is best
 * effort, so the original error is what the caller sees. Runs inside a git queue item.
 */
async function rollback(
  deps: RollbackDeps,
  git: GitSession,
  request: ClaimIdentity,
  created: CreatedWorktree,
  recorded: boolean,
  made: readonly string[] = [created.startSha],
  reason: (typeof FAILED_CLAIM_REASONS)[number] = "claim-failed",
): Promise<void> {
  const { path, released } = created;
  const current = recorded ? findClaim(deps.office, request.runId) : null;
  const releasedElsewhere = current !== null && current.releasedAt !== null;
  deps.git.unpinWorktree(path);
  const quiet = async (args: readonly string[]): Promise<void> => {
    await git.step(git.repository, args).catch(() => undefined);
  };
  await quiet(["worktree", "unlock", path]);
  await quiet(["worktree", "remove", "--force", path]);
  if (releasedElsewhere) return;
  // A new branch is deleted, a reused one goes back to its start, only when the worktree is gone
  // and the tip is a commit this claim made (`made`); each ref change is guarded by the tip read
  // here. Anything else is left as it is and reported.
  const ref = `refs/heads/${request.branch}`;
  const tip = await revParse(git, ref).catch(() => null);
  const restored = released === null ? tip === null : tip === created.startSha;
  if (!restored) {
    let leftBecause: string | null = null;
    if (deps.git.adminDirOf(path) !== null) {
      leftBecause = `its worktree ${path} could not be removed`;
    } else if (tip === null || !made.includes(tip)) {
      leftBecause = `its tip ${tip ?? "(unreadable)"} is not a commit this claim made`;
    } else {
      const args =
        released === null
          ? ["update-ref", "-d", ref, tip]
          : ["update-ref", ref, created.startSha, tip];
      const result = await git.step(git.repository, args).catch(() => null);
      if (result?.code !== 0) {
        leftBecause = `\`git ${args.join(" ")}\` failed (${result?.stderr.trim() || "no result"})`;
      }
    }
    if (leftBecause !== null) {
      const text = `The claim of ${request.story} failed and dipo could not roll back the branch ${request.branch}: ${leftBecause}. It is left as it is; check it and remove or reset it by hand.`;
      writeWith(deps, () => [notice("warn", CLAIM_NOTICES.leftover, text, request.key)]);
    }
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
 * Rolls back a live claim whose setup never finished (no recorded claim commit), for example
 * because the daemon stopped during setup: the worktree is removed, a new branch deleted while it
 * still points at its start, a reused branch moved back to its start (also from the base merge
 * the claim made) and its release reopened, the row ended as `setup-failed`, and a
 * `claim.setupInterrupted` notice put on the office. Runs as its own git queue item.
 */
export async function rollBackInterruptedSetup(
  deps: RollbackDeps,
  claim: ClaimRecord,
): Promise<void> {
  await deps.git.run(async (git) => {
    const released = claim.reused ? releaseReclaimedBy(deps.office, claim.runId) : null;
    const made = [claim.startSha];
    const tip = await revParse(git, `refs/heads/${claim.branch}`).catch(() => null);
    if (released !== null && tip !== null && tip !== claim.startSha) {
      // The base merge of a reused branch: first parent the start, second parent the base.
      const parents = await git
        .step(git.repository, ["rev-list", "--parents", "-n", "1", tip])
        .catch(() => null);
      const [, first, second] = parents?.stdout.trim().split(" ") ?? [];
      if (first === claim.startSha && second === claim.baseSha) made.push(tip);
    }
    await rollback(
      deps,
      git,
      claim,
      { path: claim.worktree, startSha: claim.startSha, released },
      true,
      made,
      "setup-failed",
    );
  });
  writeWith(deps, () => [
    notice(
      "warn",
      CLAIM_NOTICES.setupInterrupted,
      `${claim.story} was claimed but its setup did not finish (the daemon stopped during setup); dipo removed the worktree and the story stays Ready.`,
      claim.key,
    ),
  ]);
}

/**
 * Releases a live claim whose worker did not start after the claim commit (DIPO-74): the worktree
 * is unpinned, unlocked and removed; the branch, which may already be pushed with the claim
 * commit, stays and is recorded as released for the story (0010 section 2a), so the next claim
 * reuses it; the claim and its run end with `reason`. The removal is its own git queue item.
 */
export async function releaseUnstarted(
  deps: RollbackDeps,
  claim: ClaimRecord,
  reason: string,
  warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void,
): Promise<void> {
  await deps.git.run(async (git) => {
    deps.git.unpinWorktree(claim.worktree);
    for (const args of [
      ["worktree", "unlock", claim.worktree],
      ["worktree", "remove", "--force", claim.worktree],
    ]) {
      // Best effort: the release goes on, and a failed step is logged.
      const result = await git.step(git.repository, args).catch((error: unknown) => ({
        code: null,
        stderr: error instanceof Error ? error.message : String(error),
      }));
      if (result.code !== 0) {
        warn?.("a worktree step of the release failed", {
          run: claim.runId,
          args: args.join(" "),
          code: result.code,
          stderr: result.stderr.trim(),
        });
      }
    }
  });
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

// ---- the story's backlog folder (0021 section 14) ----------------------------------------------

/** The Backlog.md project directory of a checkout. */
const BACKLOG_DIR = "backlog";

/** The `GitError` code when dipo cannot make or bring back its copy of a story's backlog. */
export const BACKLOG_FOLDER_ERROR = "story.backlogFolder";

/** The Backlog.md configuration, relative to the repository root. */
const BACKLOG_CONFIG = `${BACKLOG_DIR}/config.yml`;

/** dipo's own copy of a story's backlog, where every Backlog CLI call for the story runs. */
export interface StoryBacklog {
  /** The folder the CLI runs in: it holds only `backlog/config.yml` and the story's task file. */
  readonly cwd: string;
  /** Repo-relative path of the story's task file. */
  readonly taskFile: string;
}

/** True when `name` is the task file of `id`: `<id> - <title>.md`, any case. */
function isTaskFileOf(name: string, id: string): boolean {
  return name.toLowerCase().startsWith(`${id.toLowerCase()} - `) && name.endsWith(".md");
}

/**
 * Runs `fn` with dipo's own copy of the backlog of `story` (0021 section 14): a fresh folder under
 * the worktree root, outside any git repository and outside the story's worktree, holding only
 * `backlog/config.yml` and the story's task file as committed at the worktree's `HEAD`, read from
 * git objects and never from the worktree's files. No file a worker wrote, in the worktree or in
 * its `backlog/` folder, reaches the folder the CLI runs in. With `write`, the task file the CLI
 * left in the copy is then written into the worktree in place of its own, so the caller commits
 * it; the worktree's `backlog/` folders must be plain folders, and the file is replaced, never
 * written through. The folder shares the branch reads' prefix, so the claims load step sweeps one
 * a killed daemon left behind (`worktree/sweep.ts`). Runs inside a queue item of `git`.
 */
export async function inStoryBacklog<T>(
  git: OfficeGit,
  session: GitSession,
  location: WorktreeLocation,
  story: string,
  write: boolean,
  fn: (backlog: StoryBacklog) => Promise<T>,
): Promise<T> {
  const head = (await session.ok(location, ["rev-parse", "--verify", "HEAD"])).trim();
  const listed = await session.ok(session.repository, [
    "ls-tree",
    "-r",
    "-z",
    "--name-only",
    head,
    "--",
    `${BACKLOG_DIR}/tasks`,
  ]);
  const files = listed.split("\0").filter((path) => isTaskFileOf(basename(path), story));
  const [taskFile] = files;
  if (taskFile === undefined || files.length > 1) {
    throw new GitError(
      BACKLOG_FOLDER_ERROR,
      `${head} holds ${files.length === 0 ? "no" : "more than one"} task file for ${story} under ${BACKLOG_DIR}/tasks.`,
      false,
      { story, files },
    );
  }
  const config = await session.ok(session.repository, ["show", `${head}:${BACKLOG_CONFIG}`]);
  const committed = await session.ok(session.repository, ["show", `${head}:${taskFile}`]);
  const root = git.worktreeRoot();
  mkdirSync(root, { recursive: true });
  const cwd = mkdtempSync(join(root, BRANCH_READ_PREFIX));
  try {
    for (const [path, text] of [
      [BACKLOG_CONFIG, config],
      [taskFile, committed],
    ] as const) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), text, { flag: "wx" });
    }
    const value = await fn({ cwd, taskFile });
    if (write) {
      const tasks = join(cwd, dirname(taskFile));
      const left = readdirSync(tasks).filter((name) => isTaskFileOf(name, story));
      if (left.length !== 1 || left[0] !== basename(taskFile)) {
        throw new GitError(
          BACKLOG_FOLDER_ERROR,
          `The Backlog CLI left ${left.join(", ") || "no task file"} for ${story}, not ${taskFile}.`,
          false,
          { story, taskFile, left },
        );
      }
      replaceInWorktree(location.workTree, taskFile, readFileSync(join(cwd, taskFile), "utf8"));
    }
    return value;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/**
 * Puts `text` at `path` (repo-relative) in `worktree` without following a link: the folders on
 * the way must be the worktree's own plain folders, and the file is replaced by a rename, so a
 * link or a second name of another file at `path` is replaced rather than written through.
 */
function replaceInWorktree(worktree: string, path: string, text: string): void {
  const dir = dirname(join(worktree, path));
  const expected = join(realpathSync(worktree), dirname(path));
  let real: string | null;
  try {
    real = realpathSync(dir);
  } catch {
    real = null;
  }
  if (real !== expected || !lstatSync(dir).isDirectory()) {
    throw new GitError(
      BACKLOG_FOLDER_ERROR,
      `${dirname(path)} in ${worktree} is not a plain folder of the worktree, so dipo does not write ${path} there.`,
      false,
      { path },
    );
  }
  const temporary = join(dir, `.dipo-${randomUUID()}.tmp`);
  writeFileSync(temporary, text, { flag: "wx" });
  try {
    renameSync(temporary, join(dir, basename(path)));
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** `file` (absolute, as the CLI printed it) relative to the worktree, with `/` separators. */
export function repoPath(worktree: string, file: string): string {
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
