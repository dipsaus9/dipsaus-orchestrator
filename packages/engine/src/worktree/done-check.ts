// The one Done check (0002, 0020, DIPO-363). A claimed story is Done when its own PR merged into the
// claim's base, or when the story reads Done on the base while dipo holds the claim (a story
// finished outside dipo). `decideDone` decides this from those two facts and nothing else: no I/O,
// no ancestry, and no `git merge-tree`, which only decides whether a branch may be deleted (0010).
// A merged PR wins over the base, so a story whose own PR merged is never Done elsewhere (DIPO-332).
//
// The Done poll (`done.ts`) and reconcile (`reconcile/done-on-base.ts`) both gather the facts and
// call it. Both read the PR fact the same way (`claimPr`): dipo's record of the run's story PR,
// which the PR poll keeps, or the host's answer for that same PR when the record does not say
// merged yet (a PR that merged while the daemon was down). An open PR the host could not be asked
// about is not Done this round.

import type { OfficeHandle } from "../db/office";
import { CodeHostError, type HostPr, type PrStateHost } from "../platform/host";
import { findStoryPr, type StoryPrState } from "../story-pr/records";
import { lifecycleOf } from "../views/story";

import type { ClaimRecord } from "./records";

/** A story PR as the Done check reads it. */
export interface DonePr {
  readonly number: number;
  readonly url: string;
  readonly state: StoryPrState;
  /** The head branch. */
  readonly branch: string;
  readonly base: string;
  /** The head that merged, or the head dipo last pushed. */
  readonly headSha: string;
}

/** The facts the Done check decides from; the callers gather them. */
export interface DoneFacts {
  /** The claim's branch and base; null without a claim, so no PR can count as its own. */
  readonly claim: Pick<ClaimRecord, "branch" | "base"> | null;
  /** The claim's story PR (`claimPr`), or null when none is known. */
  readonly pr: DonePr | null;
  /**
   * True when the code host was asked about the claim's PR and failed (`claimPr`): an open PR may
   * have merged unseen, so it is neither merged nor Done on the base this round.
   */
  readonly hostFailed?: boolean;
  /** The story's status on the base, or null when it could not be read. */
  readonly baseStatus: string | null;
}

/** The answer: Done through its own merged PR, Done on the base, or not Done. */
export type DoneAnswer = "merged" | "doneOnBase" | "notDone";

/** The one Done check (see the file comment). Pure. */
export function decideDone(facts: DoneFacts): DoneAnswer {
  const { claim, pr } = facts;
  if (
    pr !== null &&
    claim !== null &&
    pr.state === "merged" &&
    pr.branch === claim.branch &&
    pr.base === claim.base
  ) {
    return "merged";
  }
  // An open PR the host could not be asked about may have merged: wait for an answer rather than
  // release it as Done elsewhere.
  if (facts.hostFailed === true && pr?.state === "open") return "notDone";
  if (facts.baseStatus !== null && lifecycleOf("task", facts.baseStatus) === "Done") {
    return "doneOnBase";
  }
  return "notDone";
}

/** The PR fact of a claim (`claimPr`) and the host's failure, if it was asked and failed. */
export interface ClaimPr {
  readonly pr: DonePr | null;
  /** The host's error message when it was asked and failed, else null. */
  readonly hostError: string | null;
}

/**
 * The PR fact of a claim: dipo's record of the run's story PR when it says merged (a merge is
 * final, so the host is not asked again); else the host's newest merged PR of the branch, but only
 * when it is the run's recorded PR (the same number), since a branch name is reused when a story is
 * claimed again and an old merged PR of it is not this run's; else the record. A host that fails
 * or has no merged PR of this run leaves the record to answer. `repo` is the remote's repository,
 * or null without one.
 */
export async function claimPr(
  host: PrStateHost | null,
  repo: string | null,
  office: OfficeHandle,
  claim: Pick<ClaimRecord, "runId" | "branch">,
): Promise<ClaimPr> {
  const recorded = findStoryPr(office, claim.runId);
  if (recorded === null || recorded.state === "merged" || host === null || repo === null) {
    return { pr: recorded, hostError: null };
  }
  let merged: HostPr | null;
  try {
    merged = await host.findMergedPr(repo, claim.branch);
  } catch (error) {
    if (!(error instanceof CodeHostError)) throw error;
    return { pr: recorded, hostError: error.message };
  }
  if (merged === null || merged.number !== recorded.number)
    return { pr: recorded, hostError: null };
  return {
    pr: {
      number: merged.number,
      url: merged.url,
      state: merged.state,
      branch: merged.head,
      base: merged.base,
      headSha: merged.headSha,
    },
    hostError: null,
  };
}
