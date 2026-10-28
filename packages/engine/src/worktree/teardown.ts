// Teardown of a claimed story that is Done (DIPO-58; 0010 "Teardown"; 0007 tier T). Whether it is
// Done is the one Done check (`done-check.ts`, 0002); the Done poll (`done.ts`) calls the teardown
// once its own PR merged. A claim has no worktree, so teardown deletes only the branch; the box goes
// with the released claim (`box/lifetime.ts`).
//
// Teardown runs as one item of the office git queue. The branch must still be at the tip the
// Done poll judged; a branch that moved since keeps everything. Then `claims.teardown_started_at`
// is recorded (and cleared again when the local delete fails, since nothing was removed), the local
// branch is deleted only while it is still at the judged tip (`deleteBranch` of the git writer),
// then the remote branch with a lease on the tip dipo pushed (the judged tip,
// else the story PR's recorded head; `deleteRemoteBranch`), a branch the remote no longer has being
// fine. Only after the git steps the claim is released (`done`) and the branch's `worker_notes` and
// `context_packs` are deleted. A teardown a crash interrupted is finished by the next poll, whose
// Done check still reads the merged PR. Every step is idempotent.

import type { Clock, OfficeId } from "@dipsaus-orchestrator/contract";

import { forgetContextPack } from "../context/pack";
import type { OfficeHandle } from "../db/office";
import type { GitSession, OfficeGit } from "../git/office";
import { deleteBranch, deleteRemoteBranch, remoteUrl } from "../git/write";
import { forgetWorkerNotes } from "../prompts/notes";
import { findStoryPr } from "../story-pr/records";

import { notice, writeWith } from "./claim";
import { type ClaimRecord, markTeardownStarted, releaseClaim } from "./records";

/** `engine.notice` codes of Done detection and teardown. */
export const TEARDOWN_NOTICES = {
  done: "teardown.done",
  kept: "teardown.kept",
  parked: "teardown.parked",
  remoteBranch: "teardown.remoteBranch",
  checkFailed: "done.checkFailed",
  unmergedCommits: "done.unmergedCommits",
  claimGone: "done.claimGone",
  statusUnknown: "teardown.statusUnknown",
  hostUnreachable: "done.hostUnreachable",
} as const;

/** The release reason of a claim whose story reached Done. */
export const DONE_RELEASE_REASON = "done";

/** The PR a teardown names: the claim's story PR that merged. */
export interface MergedPr {
  readonly number: number;
  readonly url: string;
}

/** What the Done poll reads from git about a claim, in one queue item. */
export interface ClaimGitFacts {
  /** The remote's URL, or null without a remote. */
  readonly url: string | null;
  /** `refs/remotes/<remote>/<base>`, or `refs/heads/<base>` without a remote. */
  readonly baseRef: string;
  /** The local branch tip, or null when the branch is gone. */
  readonly tip: string | null;
}

/** What the Done poll reads from git about a claim, inside the caller's queue item. */
export async function claimGitFacts(
  officeGit: OfficeGit,
  git: GitSession,
  claim: ClaimRecord,
): Promise<ClaimGitFacts> {
  const { remote } = officeGit.settings;
  const url = await remoteUrl(git, remote);
  return {
    url,
    baseRef: url === null ? `refs/heads/${claim.base}` : `refs/remotes/${remote}/${claim.base}`,
    tip: await revParse(git, `refs/heads/${claim.branch}`),
  };
}

// ---- teardown --------------------------------------------------------------------------------

export interface TeardownDeps {
  readonly officeId: OfficeId;
  readonly office: OfficeHandle;
  readonly git: OfficeGit;
  readonly clock: Clock;
  readonly onChanged?: (office: OfficeId) => void;
}

export type TeardownOutcome =
  | {
      readonly ok: true;
      /** Why the remote branch may still exist, or null when it is gone. */
      readonly remoteProblem: string | null;
    }
  | {
      readonly ok: false;
      /** Why everything was kept. */
      readonly why: string;
    };

/**
 * Deletes the branch of a claim whose story PR `pr` merged, then releases the claim and deletes its
 * tier T rows. `tip` is the branch tip the Done poll judged (null when the branch was gone): a
 * branch that moved since keeps everything. The caller puts the notices on the office.
 */
export async function tearDown(
  deps: TeardownDeps,
  claim: ClaimRecord,
  pr: MergedPr,
  tip: string | null,
): Promise<TeardownOutcome> {
  const outcome = await deps.git.run((git) => removeAll(deps, git, claim, tip));
  if (!outcome.ok) return outcome;
  const how = `its PR #${pr.number} merged (${pr.url})`;
  writeWith(deps, () => {
    releaseClaim(deps.office, claim.runId, {
      at: deps.clock.now(),
      reason: DONE_RELEASE_REASON,
      keepBranch: false,
    });
    forgetWorkerNotes(deps.office, claim.branch);
    forgetContextPack(deps.office, claim.branch);
    const entries = [
      notice(
        "info",
        TEARDOWN_NOTICES.done,
        `${claim.story} is Done: ${how}. dipo deleted the branch ${claim.branch}.`,
        claim.key,
      ),
    ];
    if (outcome.remoteProblem !== null) {
      entries.push(
        notice(
          "warn",
          TEARDOWN_NOTICES.remoteBranch,
          `dipo could not delete the remote branch ${claim.branch}: ${outcome.remoteProblem}. Delete it by hand (\`git push ${deps.git.settings.remote} --delete ${claim.branch}\`).`,
          claim.key,
        ),
      );
    }
    return entries;
  });
  return outcome;
}

/** The git steps of a teardown, inside one queue item. */
async function removeAll(
  deps: TeardownDeps,
  git: GitSession,
  claim: ClaimRecord,
  tip: string | null,
): Promise<TeardownOutcome> {
  const ref = `refs/heads/${claim.branch}`;
  // The branch must still be where the detection judged it; a commit since then is kept.
  const current = await revParse(git, ref);
  if (current !== tip) {
    return {
      ok: false,
      why: `the branch ${claim.branch} moved from ${tip ?? "(gone)"} to ${current ?? "(gone)"} after Done was detected; dipo checks it again on its next poll`,
    };
  }
  // Recorded before the first step that removes anything, so a crash after it is resumable.
  const fresh = claim.teardownStartedAt === null;
  if (fresh) {
    deps.office.immediate(() => markTeardownStarted(deps.office, claim.runId, deps.clock.now()));
  }

  // The local branch, only now that Done is detected (0010 section 7), and only while it is still
  // at the tip the detection judged.
  if (tip !== null) {
    const deleted = await deleteBranch(git, claim.branch, tip);
    if (deleted.code !== 0) {
      if (fresh) deps.office.immediate(() => markTeardownStarted(deps.office, claim.runId, null));
      return {
        ok: false,
        why: `deleting the branch ${claim.branch} at ${tip} failed (${deleted.stderr.trim() || `exit ${deleted.code}`})`,
      };
    }
  }

  // The remote branch (open question 8), with a lease on the tip dipo pushed: the tip the detection
  // judged (the merged PR's head), else the story PR's recorded head. The host's auto-delete may
  // already have removed it.
  const { remote } = deps.git.settings;
  if ((await remoteUrl(git, remote)) === null) return { ok: true, remoteProblem: null };
  const pushed = tip ?? recordedHeads(deps.office, claim)[0] ?? null;
  if (pushed === null) {
    return {
      ok: true,
      remoteProblem: `dipo knows no tip it pushed for ${claim.branch}, so it does not delete the remote branch`,
    };
  }
  const deleted = await deleteRemoteBranch(git, remote, claim.branch, pushed);
  return { ok: true, remoteProblem: deleted.ok ? null : deleted.problem };
}

/**
 * The heads dipo pushed for the claim's run (its story PR's last pushed head): the lease of a remote
 * branch delete when the local branch is already gone.
 */
export function recordedHeads(
  office: OfficeHandle,
  claim: Pick<ClaimRecord, "runId" | "branch">,
): string[] {
  const pr = findStoryPr(office, claim.runId);
  return pr === null || pr.branch !== claim.branch || pr.headSha === "" ? [] : [pr.headSha];
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
