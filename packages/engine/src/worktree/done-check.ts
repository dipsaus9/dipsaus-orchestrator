// The one Done check (0002, 0020, DIPO-363). A claimed story is Done when its own PR merged into the
// claim's base, or when the story reads Done on the base while dipo holds the claim (a story
// finished outside dipo). `decideDone` decides this from those two facts and nothing else: no I/O,
// no ancestry, and no `git merge-tree`, which only decides whether a branch may be deleted (0010).
// A merged PR wins over the base, so a story whose own PR merged is never Done elsewhere (DIPO-332).
//
// The Done poll (`done.ts`) and reconcile (`reconcile/done-on-base.ts`) both gather the facts and
// call it. Both read the PR fact the same way (`claimPr`): dipo's record of the claim's story PR,
// which the PR poll keeps, or the host's merged PR of the claim's branch when the record does not
// say merged yet (a PR that merged while the daemon was down).

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
  if (facts.baseStatus !== null && lifecycleOf("task", facts.baseStatus) === "Done") {
    return "doneOnBase";
  }
  return "notDone";
}

/**
 * The PR fact of a claim: dipo's record of the claim's story PR when it says merged (a merge is
 * final, so the host is not asked again), else the host's newest merged PR of the branch when the
 * host answers with one, else the record. A host that is unreachable or has no merged PR leaves
 * the record to answer. `repo` is the remote's repository, or null without one.
 */
export async function claimPr(
  host: PrStateHost | null,
  repo: string | null,
  office: OfficeHandle,
  claim: Pick<ClaimRecord, "runId" | "branch">,
): Promise<DonePr | null> {
  const recorded = findStoryPr(office, claim.runId);
  if (recorded?.state === "merged" || host === null || repo === null) return recorded;
  let merged: HostPr | null = null;
  try {
    merged = await host.findMergedPr(repo, claim.branch);
  } catch (error) {
    if (!(error instanceof CodeHostError)) throw error;
  }
  if (merged === null) return recorded;
  return {
    number: merged.number,
    url: merged.url,
    state: merged.state,
    branch: merged.head,
    base: merged.base,
    headSha: merged.headSha,
  };
}
