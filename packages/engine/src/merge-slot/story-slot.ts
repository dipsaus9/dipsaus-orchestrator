// Story PRs in the office merge slot (0019 sections 9 and 11; DIPO-150 with DIPO-151). The merge
// slot (`slot.ts`) asks this module at each tick for the story PRs that may enter, and moves a
// story PR in the slot on.
//
// - The gates pass (`candidates`). For each open story PR of a run waiting In Review (ended at In
//   Review or after its review, live claim, no open park) that is not in the slot: its required
//   checks must be green on the pushed head (`StoryPrs.ciState`, or no CI ran for a box run's head,
//   DIPO-299), and the review verdict of the head's code tree must be approved or overridden. Only
//   then the host is read: the PR's state, its head and its labels. A PR merged on the host is the
//   Done poll's; one closed without a merge parks the story `stopped` with cause `pr-closed`; a
//   host head that differs from the pushed head keeps the story out with a `pr.headChanged` notice
//   naming both heads, and no gate opens for it (0019 section 9). Otherwise the head's merge gate
//   opens (`gates.ts`) unless one holds for it already, decided by rule or waiting for the
//   maintainer. A story whose gate is approved and whose PR carries no hold label may enter, by the
//   time its gate was approved; one with a hold label waits with a `merge.held` notice. Each story
//   parked `review-blocked` gets its override gate here too.
// - The release path (DIPO-331). Before a gate opens, the release paths the head changes are read
//   from git (`StorySlotGit.releasePaths`: the base's CODEOWNERS, the PR's diff). A PR that
//   changes one gets a gate that waits for the maintainer's merge on the host only (`gates.ts`),
//   also when an earlier gate of the head was approved (the CODEOWNERS on the base grew, or an
//   override), and never enters; dipo never passes `--admin` or any bypass. When git cannot tell,
//   the PR stays out this tick.
// - The steps (`advance`), each an office git queue item, in the story worktree's repository:
//   1. the close-out commit: final summary (`writeCloseOutSummary`, DIPO-154), modified files and
//      status Done (provisional until the host merge);
//   2. the sync: the base is merged only when the host would report a conflict (strict is off on
//      the base, 0016 amendment of 2026-10-22), and whenever the base moved after the host refused
//      a merge because it did. A clean merge is recorded (`catch_ups`) so the approval carries to
//      the merged head with no new review round (0019 section 6). A conflict is committed as git
//      left it and pushed, and the story leaves the slot as a conflict hand-off: one fix round with
//      the conflict item (`FixRounds.conflict`, DIPO-149). A conflict in a path the worker cannot
//      write parks `conflict` with cause `unwritable-path`. The merge commit is planned first and
//      persisted in `merge_slot` (step `record`) before the branch moves to it, so a restart in
//      between moves or records it then; a merge whose record or carry fails pushes and merges
//      nothing;
//   3. one push, never forced, and the story PR updated to the pushed head;
//   4. the required checks of that head (the PR poll reads them): red leaves the slot, and the CI
//      fix round of DIPO-148 takes the red head; checks that stay unfinished past the run's
//      `mergeSlot.checksWaitMinutes` leave it until they pass;
//   5. the label guard (`autorelease: pending` is never merged, a hold label waits), the release
//      path guard (the base fetched again and read for the pushed head; one changed, a failed
//      fetch or an unreadable answer leaves), the host's
//      PR head equal to the pushed head, and an approved or overridden verdict and an approved
//      merge gate that hold for exactly that head (else the story leaves the slot unmerged and the
//      review loop takes the head);
//   6. the squash merge with `--match-head-commit` and the PR title as subject. A refusal after
//      which the base moved goes back to step 2, at most 3 times per stay; then the story parks
//      `conflict` with cause `slot-refused`.
//   Every step is idempotent when it runs again after a daemon restart, and the slot's occupant and
//   step are in `merge_slot`.
// - Stages after a run's start read the run's configuration snapshot (`runConfigOf`, DIPO-303
//   review): the required checks, `autoMerge`, `holdLabels` and `checksWaitMinutes` of the run.

import type {
  Clock,
  CommandName,
  IdSource,
  OfficeId,
  RunId,
  StoryKey,
} from "@dipsaus-orchestrator/contract";

import type { StoryTarget } from "../backlog/fields/write";
import type { CatchUpMerged } from "../box/collisions";
import type { NewEntry } from "../changelog/log";
import type { OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import type { Logger } from "../log/logger";
import { type CodeHost, CodeHostError, type PrReviewHost, repoOfRemoteUrl } from "../platform/host";
import type { PrStateReads } from "../platform/pr-state";
import type { FixItem } from "../prompts/feedback";
import {
  latestVerdictOfRun,
  reviewVerdictForTree,
  type StoredReviewVerdict,
} from "../review/store";
import { runConfigOf } from "../run/config-snapshot";
import { catchUpsOf } from "../run/conflicts";
import { openPark, PARK_CAUSES, type ParkWriter, parkStory } from "../run/park";
import type { RunStoryFacts } from "../run/resume";
import {
  findRun,
  IN_REVIEW_END,
  REVIEWED_END,
  runRoundCounts,
  type StoredRun,
} from "../run/records";
import type { CiHeadState } from "../story-pr/prs";
import {
  findStoryPr,
  openStoryPrs,
  recordBranchPush,
  type StoryPrRecord,
} from "../story-pr/records";
import { withWorkViews } from "../views/work";
import { findClaim } from "../worktree/records";

import {
  autoreleasePending,
  decideMergeGate,
  holdLabelsOn,
  mergeGatesOfRun,
  mergeGateSummary,
  mergeWaits,
  mirrorFlagged,
  openMergeGate,
  overrideGateOf,
  overrideGateSummary,
  releasePathList,
  type StoredMergeGate,
} from "./gates";
import { type SlotOccupant, leaveSlot, runInSlot, updateSlot } from "./store";
import type { PushOutcome } from "./git";
import type { StorySlotGit, StorySlotRun } from "./story-git";

/** `engine.notice` codes of story PRs in the merge slot (0019 section 15). */
export const STORY_SLOT_NOTICES = {
  entered: "mergeSlot.entered",
  merged: "mergeSlot.merged",
  conflict: "mergeSlot.conflict",
  checksFailed: "mergeSlot.checksFailed",
  checksStuck: "mergeSlot.checksStuck",
  pushFailed: "mergeSlot.pushFailed",
  refused: "mergeSlot.refused",
  failed: "mergeSlot.failed",
  headChanged: "pr.headChanged",
  closedOnHost: "pr.closedOnHost",
  held: "merge.held",
  /** The release path of a PR could not be read: it stays out of the slot (DIPO-331). */
  releaseUnknown: "mergeSlot.releasePathUnknown",
  /** The head the slot would merge has no approved review and merge gate. */
  unapproved: "mergeSlot.unapproved",
  /** A merge of the base the slot made could not be recorded. */
  unrecorded: "mergeSlot.unrecorded",
} as const;

/** Host merges a story PR gets in one stay in the slot while the base keeps moving (0016 rule 2). */
export const STORY_MERGE_ATTEMPTS = 3;

/** What the story merge slot needs besides the slot's own host and clock. */
export interface StorySlotDeps {
  readonly git: StorySlotGit;
  readonly ids: IdSource;
  /** The PR's labels (0019 section 7's guard). */
  readonly labels: Pick<PrReviewHost, "prLabels">;
  /** Where the CI of a run's pushed head stands (`StoryPrs.ciState`). */
  readonly ci: (office: OfficeId, runId: RunId) => CiHeadState | null;
  /** The code tree key of `head` (0010), or null when it cannot be read; `git.treeKey` by default. */
  readonly treeKey?: (office: OfficeId, run: StoredRun, head: string) => Promise<string | null>;
  /** Updates the story PR to the branch's pushed head (`StoryPrs.sync`). */
  readonly prSync?: (office: OfficeId, runId: RunId) => Promise<void>;
  /** The story facts on the base: the manual test-plan entries of a flagged story's gate. */
  readonly story?: (office: OfficeId, run: StoredRun) => Promise<RunStoryFacts>;
  /** Writes the close-out's final summary (`writeCloseOutSummary`, DIPO-154). */
  readonly summary: (
    target: StoryTarget,
    office: OfficeHandle,
    key: string,
    at: number,
  ) => Promise<unknown>;
  /** Records a merge the slot made (`StoryConflicts.recorded`): catch-up row, hand-off, carry. */
  readonly recordMerge?: (office: OfficeId, run: StoredRun, merged: CatchUpMerged) => Promise<void>;
  /** Hands a conflict to the worker as one fix round (`FixRounds.conflict`). */
  readonly conflict?: (
    office: OfficeId,
    runId: RunId,
    input: { readonly head: string; readonly item: FixItem },
  ) => Promise<boolean>;
  /** What a story parks through; without it a story that should park only gets a notice. */
  readonly park?: {
    readonly writer: ParkWriter;
    readonly implemented: (name: CommandName) => boolean;
  };
  /** The conflict item's character budget of the run. */
  readonly itemMax?: (office: OfficeId, run: StoredRun) => number;
}

/** What a tick of the slot gives this module. */
export interface StorySlotContext {
  readonly officeId: OfficeId;
  readonly office: OfficeHandle;
  readonly host: CodeHost;
  /**
   * How the slot reads a story PR's state during a tick: through the office's PR-state round
   * (DIPO-314), so a PR the story-PR poll read this round is not read again; `host` when absent.
   */
  readonly prState?: Pick<PrStateReads, "viewPr" | "invalidate">;
  readonly clock: Clock;
  /** The configuration in force; a run's snapshot is laid on it. */
  readonly config: OfficeConfig;
  /** Overrides each run's `mergeSlot.checksWaitMinutes` (tests). */
  readonly checksWaitMs?: number;
  /** Writes the notice unless it was given already for this `subject`, code and `value`. */
  once(subject: string, code: string, value: string, make: () => NewEntry): void;
  /** Runs `fn` in one transaction and appends the entries it returns. */
  write(fn: () => readonly NewEntry[]): void;
  /** Story PRs that left the slot unmerged, with the head they left at: out until it changes. */
  readonly left: Map<string, string>;
  readonly logger?: Logger;
}

/** A story PR that may enter the slot. */
export interface StoryCandidate {
  readonly runId: RunId;
  readonly key: StoryKey;
  readonly number: number;
  readonly repo: string;
  readonly branch: string;
  readonly head: string;
  /** When it became eligible: its merge gate's approval. */
  readonly eligibleAt: number;
}

type Outcome = "waiting" | "merged" | "left";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The `[HOST/]OWNER/REPO` of a PR URL, or null. */
export function repoOfPrUrl(url: string): string | null {
  const at = url.lastIndexOf("/pull/");
  return at <= 0 || !/^\/pull\/\d+\/?$/.test(url.slice(at))
    ? null
    : repoOfRemoteUrl(url.slice(0, at));
}

function notice(
  level: "info" | "warn" | "error",
  code: string,
  text: string,
  key: StoryKey | null,
  run: RunId | null,
): NewEntry {
  return {
    type: "engine.notice",
    ...(key === null ? {} : { key }),
    ...(run === null ? {} : { run }),
    delta: { level, code, text },
  };
}

const short = (sha: string): string => sha.slice(0, 12);

/**
 * What a story that left the slot unapproved is kept out on: the head it would have merged, that
 * head's verdict and the approved gate that held for it (`none` for each it lacked).
 */
const approvalKey = (head: string, verdict: string, gate: string): string =>
  `unapproved ${head} ${verdict} ${gate}`;

/** Frees the office's slot: the story PR in it left. */
function free(ctx: StorySlotContext): void {
  ctx.write(() => {
    leaveSlot(ctx.office);
    return [];
  });
}

export class StorySlot {
  readonly #deps: StorySlotDeps;

  constructor(deps: StorySlotDeps) {
    this.#deps = deps;
  }

  /** The story PR of the run updated to its branch's pushed head (a re-entry, DIPO-324). */
  async prSynced(office: OfficeId, runId: RunId): Promise<void> {
    await this.#deps.prSync?.(office, runId);
  }

  // ---- the gates pass -----------------------------------------------------------------------

  /** Opens the gates due and returns the story PRs that may enter the slot (see the file comment). */
  async candidates(ctx: StorySlotContext): Promise<StoryCandidate[]> {
    await this.#overrideGates(ctx);
    await this.#closedPrs(ctx);
    const out: StoryCandidate[] = [];
    for (const stored of openStoryPrs(ctx.office)) {
      try {
        const candidate = await this.#candidate(ctx, stored);
        if (candidate !== null) out.push(candidate);
      } catch (error) {
        ctx.logger?.warn("checking a story PR for the merge slot failed", {
          office: ctx.officeId,
          run: stored.runId,
          reason: messageOf(error),
        });
      }
    }
    return out;
  }

  /** The story run waiting In Review whose PR this is, or null. */
  #waitingRun(office: OfficeHandle, runId: RunId): StoredRun | null {
    const run = findRun(office, runId);
    if (run === null || run.kind !== "story" || run.key === null || run.endedAt === null) {
      return null;
    }
    if (run.endKind !== REVIEWED_END && run.endKind !== IN_REVIEW_END) return null;
    if (run.branch === null || run.worktree === null || run.startSha === null) return null;
    const claim = findClaim(office, runId);
    if (claim === null || claim.releasedAt !== null) return null;
    if (openPark(office, run.key) !== null) return null;
    return run;
  }

  async #candidate(ctx: StorySlotContext, stored: StoryPrRecord): Promise<StoryCandidate | null> {
    const ready = await this.#ready(ctx, stored);
    if (ready === null) return null;
    const { run, repo, head, verdict } = ready;
    if (!(await this.#openOnHost(ctx, run, stored, repo))) return null;
    const config = runConfigOf(ctx.office, run, ctx.config);
    const labels = await this.#deps.labels.prLabels(repo, stored.number);
    const held = holdLabelsOn(labels, config.mergeSlot.holdLabels);
    const release = await this.#releasePaths(ctx, run, head);
    if (release === null) return null;
    const gate = await this.#gateFor(ctx, run, stored, { head, verdict, held, release });
    if (gate?.decision?.decision !== "approved") return null;
    if (this.#heldBack(ctx, run, { number: stored.number, head, held, release }, "candidate")) {
      return null;
    }
    if (await this.#keptOut(ctx, run, head)) return null;
    return {
      runId: run.runId,
      key: run.key as StoryKey,
      number: stored.number,
      repo,
      branch: stored.branch,
      head,
      eligibleAt: gate.decision.at,
    };
  }

  /**
   * The run waiting In Review of a story PR outside the slot, its repository, its pushed head and
   * the verdict that holds for it, once its required checks were green on that head (or no CI ran
   * for it, DIPO-299) and the verdict is approved or overridden; else null.
   */
  async #ready(
    ctx: StorySlotContext,
    stored: StoryPrRecord,
  ): Promise<{
    readonly run: StoredRun;
    readonly repo: string;
    readonly head: string;
    readonly verdict: StoredReviewVerdict;
  } | null> {
    const run = this.#waitingRun(ctx.office, stored.runId);
    if (run === null || runInSlot(ctx.office, run.runId)) return null;
    const repo = repoOfPrUrl(stored.url);
    if (repo === null) return null;
    const head = stored.headSha;
    const ci = this.#deps.ci(ctx.officeId, run.runId);
    if (ci === null || ci.head !== head || (ci.kind !== "green" && ci.kind !== "none")) return null;
    const verdict = await this.#verdictFor(ctx.officeId, ctx.office, run, head);
    if (verdict === null) return null;
    if (verdict.verdict !== "approved" && verdict.override === null) return null;
    return { run, repo, head, verdict };
  }

  /** True when the host shows the PR open at the pushed head; a closed PR parks, a moved head tells. */
  async #openOnHost(
    ctx: StorySlotContext,
    run: StoredRun,
    stored: StoryPrRecord,
    repo: string,
  ): Promise<boolean> {
    let view;
    try {
      // Through the PR-state round when this tick belongs to one (DIPO-314).
      view = await readsOf(ctx).viewPr(repo, stored.number, { head: stored.headSha });
    } catch (error) {
      if (error instanceof CodeHostError) return false;
      throw error;
    }
    if (view.state === "merged") return false;
    if (view.state === "closed") {
      await this.#prClosed(ctx, run, stored);
      return false;
    }
    if (view.headSha !== "" && view.headSha !== stored.headSha) {
      this.#headChanged(ctx, run, stored, view.headSha);
      return false;
    }
    return true;
  }

  /**
   * The release paths `head` changes (DIPO-331), or null with a notice (once per head) when git
   * cannot tell: the PR then stays out of the slot, and nothing merges it.
   */
  async #releasePaths(
    ctx: StorySlotContext,
    run: StoredRun,
    head: string,
  ): Promise<readonly string[] | null> {
    const paths = await this.#deps.git.releasePaths(ctx.officeId, head).catch((error: unknown) => {
      ctx.logger?.warn("reading the release path of a story PR failed", {
        run: run.runId,
        reason: messageOf(error),
      });
      return null;
    });
    if (paths !== null) return paths;
    this.#releaseUnknown(ctx, run, head, "the base's CODEOWNERS or the PR's diff");
    return null;
  }

  /** The `mergeSlot.releasePathUnknown` notice, once per head: nothing merges it this time. */
  #releaseUnknown(ctx: StorySlotContext, run: StoredRun, head: string, what: string): void {
    ctx.once(`story:${run.runId}`, STORY_SLOT_NOTICES.releaseUnknown, head, () =>
      notice(
        "warn",
        STORY_SLOT_NOTICES.releaseUnknown,
        `${run.story}: dipo could not read whether ${short(head)} changes the release path (${what}), so it does not merge it. It tries again at the next check.`,
        run.key,
        run.runId,
      ),
    );
  }

  /**
   * True when a hold label or the release path holds the PR back, with a `merge.held` notice once
   * per head and reason: `autorelease: pending` and the release path only a hand merge resolves.
   */
  #heldBack(
    ctx: StorySlotContext,
    run: StoredRun,
    pr: {
      readonly number: number;
      readonly head: string;
      readonly held: readonly string[];
      readonly release: readonly string[];
    },
    where: "candidate" | "slot",
  ): boolean {
    let text: string;
    if (pr.release.length > 0) {
      text = `${run.story}${where === "slot" ? " left the merge slot" : ""}: PR #${pr.number} changes the release path (${releasePathList(pr.release)}), which needs the maintainer's code owner approval, so dipo never merges it; the maintainer merges it by hand on GitHub.`;
    } else if (autoreleasePending(pr.held)) {
      text = `${run.story}: PR #${pr.number} carries "autorelease: pending", so dipo never merges it; merge it by hand on GitHub.`;
    } else if (pr.held.length > 0) {
      const labels = pr.held.map((label) => `"${label}"`).join(", ");
      text =
        where === "slot"
          ? `${run.story} left the merge slot: PR #${pr.number} carries the hold label ${labels}; dipo merges it once the label is gone.`
          : `${run.story}: PR #${pr.number} is approved but carries the hold label ${labels}; dipo merges it once the label is gone.`;
    } else {
      return false;
    }
    const value = `${pr.head}:${pr.held.join(",")}${pr.release.length > 0 ? ":release-path" : ""}`;
    ctx.once(`story:${run.runId}`, STORY_SLOT_NOTICES.held, value, () =>
      notice("info", STORY_SLOT_NOTICES.held, text, run.key, run.runId),
    );
    return true;
  }

  /** True when the story left the slot at `head` (or unapproved there) and stays out for now. */
  async #keptOut(ctx: StorySlotContext, run: StoredRun, head: string): Promise<boolean> {
    // Out until its head changes; one that left unapproved also until its verdict or gate does.
    const left = ctx.left.get(run.runId);
    if (left === head) return true;
    if (left?.startsWith("unapproved ") === true) {
      // Left unapproved at the head it would merge: out until that head's verdict or gate changes.
      const [, unapproved = ""] = left.split(" ");
      const now = await this.#approvedFor(ctx.officeId, ctx.office, run, unapproved);
      if (approvalKey(unapproved, now.verdict ?? "none", now.gate ?? "none") === left) return true;
      ctx.left.delete(run.runId);
    }
    return false;
  }

  /** The verdict of the head's code tree, or null when it has none (or the tree is unreadable). */
  async #verdictFor(
    officeId: OfficeId,
    office: OfficeHandle,
    run: StoredRun,
    head: string,
  ): Promise<StoredReviewVerdict | null> {
    const tree = await (
      this.#deps.treeKey?.(officeId, run, head) ??
      this.#deps.git.treeKey(officeId, run.story ?? "", head)
    ).catch(() => null);
    if (tree === null) {
      const latest = latestVerdictOfRun(office, run.runId);
      return latest?.commit === head ? latest : null;
    }
    return reviewVerdictForTree(office, run.runId, tree);
  }

  /**
   * True when `gate` holds for `head`: its own head, or a head whose verdict is the one of the
   * gate's head or an approval carried from it (0019 sections 6 and 11).
   */
  async #holds(
    officeId: OfficeId,
    office: OfficeHandle,
    run: StoredRun,
    gate: StoredMergeGate,
    head: string,
    verdict: StoredReviewVerdict,
  ): Promise<boolean> {
    if (gate.head === head) return true;
    if (gate.head === "") return false;
    const atGate = await this.#verdictFor(officeId, office, run, gate.head);
    if (atGate === null) return false;
    return atGate.gate === verdict.gate || verdict.carriedFrom === atGate.commit;
  }

  /**
   * Whether the verdict of `head`'s code tree is approved or overridden and an approved merge gate
   * of the run holds for `head` (what the slot checks right before the host merge), with the
   * verdict's and that gate's ids, or null for each it did not find.
   */
  async #approvedFor(
    officeId: OfficeId,
    office: OfficeHandle,
    run: StoredRun,
    head: string,
  ): Promise<{
    readonly ok: boolean;
    readonly verdict: string | null;
    readonly gate: string | null;
  }> {
    const none = { ok: false, verdict: null, gate: null };
    if (head === "") return none;
    const verdict = await this.#verdictFor(officeId, office, run, head);
    if (verdict === null) return none;
    if (verdict.verdict !== "approved" && verdict.override === null) {
      return { ok: false, verdict: verdict.gate, gate: null };
    }
    for (const gate of mergeGatesOfRun(office, run.runId).toReversed()) {
      if (gate.decision?.decision !== "approved") continue;
      if (await this.#holds(officeId, office, run, gate, head, verdict)) {
        return { ok: true, verdict: verdict.gate, gate: gate.gate };
      }
    }
    return { ok: false, verdict: verdict.gate, gate: null };
  }

  /**
   * True when the merge gate `gate` holds for `head` (its own head, or a head whose verdict is the
   * gate head's or carried from it): `gate.approve` and `gate.reject` decide only such a gate.
   */
  async gateHolds(
    officeId: OfficeId,
    office: OfficeHandle,
    gate: StoredMergeGate,
    head: string,
  ): Promise<boolean> {
    if (gate.head === head) return true;
    const run = findRun(office, gate.runId);
    if (run === null) return false;
    const verdict = await this.#verdictFor(officeId, office, run, head);
    if (verdict === null) return false;
    return this.#holds(officeId, office, run, gate, head, verdict);
  }

  /** True when the merge `commit` has its `catch_ups` row (DIPO-149's record of dipo's merges). */
  #recorded(office: OfficeHandle, runId: RunId, commit: string): boolean {
    return catchUpsOf(office, runId).some((row) => row.kind === "merged" && row.commit === commit);
  }

  /** The merge was made on the branch but not recorded: nothing goes on, the slot lets go. */
  #unrecorded(ctx: StorySlotContext, run: StoredRun, commit: string, reason: string): Outcome {
    free(ctx);
    ctx.write(() => [
      notice(
        "warn",
        STORY_SLOT_NOTICES.unrecorded,
        `${run.story} left the merge slot unmerged: dipo merged the base into its branch at ${short(commit)} but could not record that merge (${reason}), so no approval carries to it. Nothing was pushed this time; a later stay may push that merge, but dipo never merges it without an approved review of it.`,
        run.key,
        run.runId,
      ),
    ]);
    return "left";
  }

  /**
   * The head's merge gate: one that holds for it, else a new one; superseded open ones close. A
   * head that changes the release path gets a hand-merge-only gate even when one that holds for it
   * was approved (the base's CODEOWNERS grew, or an override), unless the maintainer rejected it;
   * an open hand-merge-only gate of a head that no longer changes it is replaced.
   */
  async #gateFor(
    ctx: StorySlotContext,
    run: StoredRun,
    stored: StoryPrRecord,
    input: {
      readonly head: string;
      readonly verdict: StoredReviewVerdict;
      readonly held: readonly string[];
      readonly release: readonly string[];
    },
  ): Promise<StoredMergeGate | null> {
    const office = ctx.office;
    const { head, verdict } = input;
    let found: StoredMergeGate | null = null;
    for (const gate of mergeGatesOfRun(office, run.runId).toReversed()) {
      if (await this.#holds(ctx.officeId, office, run, gate, head, verdict)) {
        found = gate;
        break;
      }
    }
    if (found !== null && !gateOutdated(found, input.release)) return found;
    const key = run.key as StoryKey;
    const config = runConfigOf(office, run, ctx.config);
    const flagged = mirrorFlagged(office, key);
    const waits = mergeWaits({
      autoMerge: config.mergeSlot.autoMerge,
      testBeforeMerge: flagged,
      verdict,
      holdLabels: input.held,
      releasePaths: input.release,
    });
    let manual: { check: string; expect?: string }[] = [];
    if (flagged && this.#deps.story !== undefined) {
      try {
        const facts = await this.#deps.story(ctx.officeId, run);
        manual = (facts.fields.test_plan?.entries ?? [])
          .filter((entry) => entry.kind === "manual")
          .map((entry) => ({
            check: entry.check,
            ...(entry.expect === undefined ? {} : { expect: entry.expect }),
          }));
      } catch (error) {
        ctx.logger?.warn("reading the test plan for a merge gate failed", {
          run: run.runId,
          reason: messageOf(error),
        });
      }
    }
    const summary = mergeGateSummary({
      story: run.story as string,
      pr: { number: stored.number, url: stored.url },
      head,
      waits,
      ...(flagged ? { manual, worktree: run.worktree } : {}),
    });
    const opened: { gate: StoredMergeGate | null } = { gate: null };
    ctx.write(() => {
      const at = ctx.clock.now();
      const entries: NewEntry[] = [];
      // An open gate of an earlier head waits on nothing that can merge any more.
      for (const gate of mergeGatesOfRun(office, run.runId)) {
        if (gate.decision !== null || gate.overrideOf !== null) continue;
        entries.push(
          ...decideMergeGate(office, gate.gate, {
            decision: "rejected",
            by: "rule",
            note:
              found === null
                ? `superseded: the PR head moved to ${short(head)}`
                : `superseded: the release path of ${short(head)} changed`,
            at,
          }),
        );
      }
      const made = openMergeGate(office, this.#deps.ids, {
        runId: run.runId,
        key,
        head,
        waits,
        summary,
        phase: flagged ? "test" : "merge",
        at,
      });
      opened.gate = made.gate;
      return withWorkViews(office, [...entries, ...made.entries]);
    });
    return opened.gate;
  }

  /** Each story parked `review-blocked` (cause `rounds`) gets its override gate (0019 section 11). */
  async #overrideGates(ctx: StorySlotContext): Promise<void> {
    const office = ctx.office;
    const parked = office.all<{ run_id: string }>(
      `select run_id from parks where office_id = $office_id and resolved_at is null
        and reason = 'review-blocked' and run_id is not null
      order by park_id`,
    );
    for (const row of parked) {
      const run = findRun(office, row.run_id as RunId);
      if (run === null || run.key === null || run.story === null) continue;
      const verdict = latestVerdictOfRun(office, run.runId);
      if (verdict === null || verdict.verdict !== "blocked" || verdict.override !== null) continue;
      if (overrideGateOf(office, run.runId, verdict.gate) !== null) continue;
      const failed = runRoundCounts(office, run.runId).reviewRoundsFailed;
      ctx.write(() => {
        if (overrideGateOf(office, run.runId, verdict.gate) !== null) return [];
        const made = openMergeGate(office, this.#deps.ids, {
          runId: run.runId,
          key: run.key as StoryKey,
          head: verdict.commit,
          waits: [],
          summary: overrideGateSummary({ story: run.story as string, verdict, failed }),
          overrideOf: verdict.gate,
          at: ctx.clock.now(),
        });
        return withWorkViews(office, made.entries);
      });
    }
  }

  /**
   * A story PR the host shows closed without a merge parks the story `stopped` with cause
   * `pr-closed` (0019 section 9), once per close: a resume that keeps it closed is 0020's.
   */
  async #closedPrs(ctx: StorySlotContext): Promise<void> {
    const rows = ctx.office.all<{ run_id: string }>(
      `select p.run_id from story_prs p where p.office_id = $office_id and p.state = 'closed'
         and exists (select 1 from claims c where c.office_id = p.office_id
           and c.run_id = p.run_id and c.released_at is null)
       order by p.closed_at, p.rowid`,
    );
    for (const row of rows) {
      const run = findRun(ctx.office, row.run_id as RunId);
      const stored = findStoryPr(ctx.office, row.run_id as RunId);
      if (run === null || stored === null) continue;
      await this.#prClosed(ctx, run, stored);
    }
  }

  async #prClosed(ctx: StorySlotContext, run: StoredRun, stored: StoryPrRecord): Promise<void> {
    const office = ctx.office;
    if (run.kind !== "story" || run.key === null || openPark(office, run.key) !== null) return;
    const since = stored.closedAt ?? stored.openedAt;
    const parkedFor = office.get(
      `select 1 as found from parks where office_id = $office_id and run_id = $run
        and cause = $cause and at >= $since limit 1`,
      { run: run.runId, cause: PARK_CAUSES.prClosed, since },
    );
    if (parkedFor !== null) return;
    if (runInSlot(office, run.runId)) free(ctx);
    const detail = `PR #${stored.number} was closed on the host`;
    await this.#park(ctx, run, { reason: "stopped", cause: PARK_CAUSES.prClosed, detail });
  }

  #headChanged(
    ctx: StorySlotContext,
    run: StoredRun,
    stored: StoryPrRecord,
    hostHead: string,
  ): void {
    ctx.once(
      `story:${run.runId}`,
      STORY_SLOT_NOTICES.headChanged,
      `${stored.headSha}:${hostHead}`,
      () =>
        notice(
          "warn",
          STORY_SLOT_NOTICES.headChanged,
          `${run.story}: the head of PR #${stored.number} on the host is ${short(hostHead)}, not ${short(stored.headSha)} as dipo pushed it, so dipo does not merge it and opens no merge gate for it. Merge it by hand on GitHub (the Done poll picks that up) or discard the story.`,
          run.key,
          run.runId,
        ),
    );
  }

  // ---- the steps ------------------------------------------------------------------------------

  /** Moves the story PR in the slot on as far as it can go without waiting. */
  async advance(ctx: StorySlotContext, occupant: SlotOccupant): Promise<Outcome> {
    const office = ctx.office;
    const runId = occupant.runId as RunId;
    const run = findRun(office, runId);
    const stored = findStoryPr(office, runId);
    if (
      run === null ||
      stored === null ||
      run.key === null ||
      run.story === null ||
      run.branch === null ||
      run.worktree === null ||
      run.startSha === null
    ) {
      free(ctx);
      return "left";
    }
    const claim = findClaim(office, runId);
    if (claim === null || claim.releasedAt !== null || openPark(office, run.key) !== null) {
      free(ctx);
      return "left";
    }
    const config = runConfigOf(office, run, ctx.config);
    const slotRun: StorySlotRun = {
      runId,
      story: run.story,
      branch: run.branch,
      worktree: run.worktree,
      startSha: run.startSha,
      ...(this.#deps.itemMax === undefined
        ? {}
        : { itemMax: this.#deps.itemMax(ctx.officeId, run) }),
    };
    const git = this.#deps.git;
    let current = occupant;
    const move = (change: Parameters<typeof updateSlot>[1]): void => {
      ctx.write(() => {
        updateSlot(office, change);
        return [];
      });
      current = { ...current, ...change };
    };
    for (;;) {
      switch (current.phase) {
        case "close-out": {
          // Step 1: the close-out commit (final summary, modified files, status Done).
          await this.#closeOut(ctx, run, slotRun);
          move({ phase: "sync" });
          break;
        }
        case "sync": {
          // Step 2: the base, only on a conflict (or whenever it moved after a refusal).
          if (!(await git.fetch(ctx.officeId))) {
            // Offline: the slot lets go; the steps run again when the story enters again.
            free(ctx);
            return "left";
          }
          const sync = await git.sync(ctx.officeId, slotRun, current.syncMode);
          if (sync.kind === "unwritable") {
            free(ctx);
            await this.#park(ctx, run, {
              reason: "conflict",
              cause: PARK_CAUSES.unwritablePath,
              detail: `git could not merge ${sync.base} at ${short(sync.onto)} cleanly in paths the worker cannot write: ${sync.paths.join(", ")}`,
            });
            return "left";
          }
          if (sync.kind === "planned") {
            // The merge is persisted before the branch moves, so a restart finds it (`record`).
            move({ phase: "record", merge: { merged: sync.merged, item: sync.item } });
            break;
          }
          move({ phase: "push" });
          break;
        }
        case "record": {
          // Step 2, continued: the branch moves to the planned merge, which is recorded (its catch-up
          // row and, for a clean one, the approval carried to it). Safe to run again after a restart.
          const merge = current.merge ?? null;
          if (merge === null) {
            move({ phase: "sync" });
            break;
          }
          const tip = await git.head(ctx.officeId, run.branch);
          const { merged } = merge;
          if (tip === merged.tip) {
            if (!(await git.moveBranch(ctx.officeId, run.branch, merged.commit, merged.tip))) {
              move({ phase: "sync", merge: null });
              break;
            }
          } else if (tip !== merged.commit) {
            // The branch moved another way meanwhile: plan the sync again.
            move({ phase: "sync", merge: null });
            break;
          }
          if (!this.#recorded(office, runId, merged.commit)) {
            try {
              await this.#deps.recordMerge?.(ctx.officeId, run, merged);
            } catch (error) {
              // An unrecorded merge carries no approval: nothing is pushed or merged on it.
              return this.#unrecorded(ctx, run, merged.commit, messageOf(error));
            }
          }
          // The merge took the base's version of the task file: Done goes back on it.
          if (merged.taskFile !== null) await this.#closeOut(ctx, run, slotRun);
          if (merge.item !== null) {
            const head = (await git.head(ctx.officeId, run.branch)) ?? merged.commit;
            return await this.#conflict(ctx, run, stored, head, merge.item);
          }
          move({ phase: "push", merge: null });
          break;
        }
        case "push": {
          // Step 3: one push, never forced; the PR follows the pushed head.
          const pushed = await git.push(ctx.officeId, run.branch);
          recordSlotPush(ctx, run.branch, pushed);
          const head = await git.head(ctx.officeId, run.branch);
          if (!pushed.ok || head === null) {
            const detail = pushed.ok ? `the branch ${run.branch} is gone` : pushed.detail;
            ctx.once(`story:${runId}`, STORY_SLOT_NOTICES.pushFailed, head ?? "", () =>
              notice(
                "warn",
                STORY_SLOT_NOTICES.pushFailed,
                `The merge slot could not push ${run.story} (${run.branch}): ${detail}. It left the slot; dipo takes it in again when its PR changes.`,
                run.key,
                runId,
              ),
            );
            ctx.left.set(runId, stored.headSha);
            free(ctx);
            return "left";
          }
          move({ phase: "checks", head, checksSince: ctx.clock.now() });
          await this.#deps.prSync?.(ctx.officeId, runId).catch((error: unknown) => {
            ctx.logger?.warn("updating the story PR after the slot's push failed", {
              run: runId,
              reason: messageOf(error),
            });
          });
          break;
        }
        case "checks": {
          // Step 4: the required checks of the pushed head, as the PR poll reads them.
          const head = current.head ?? "";
          const ci = this.#deps.ci(ctx.officeId, runId);
          const state = ci === null || ci.head !== head ? "pending" : ci.kind;
          if (state === "red") {
            ctx.write(() => {
              leaveSlot(office);
              return [
                notice(
                  "warn",
                  STORY_SLOT_NOTICES.checksFailed,
                  `${run.story} left the merge slot unmerged: its required checks were red on ${short(head)}. The CI feedback goes back to its worker in a fix round.`,
                  run.key,
                  runId,
                ),
              ];
            });
            return "left";
          }
          if (state === "pending" || state === "stuck") {
            const limit = ctx.checksWaitMs ?? config.mergeSlot.checksWaitMinutes * 60_000;
            if (ctx.clock.now() - (current.checksSince ?? ctx.clock.now()) < limit) {
              return "waiting";
            }
            ctx.once(`story:${runId}`, STORY_SLOT_NOTICES.checksStuck, head, () =>
              notice(
                "warn",
                STORY_SLOT_NOTICES.checksStuck,
                `${run.story} left the merge slot unmerged: after ${Math.round(limit / 60_000)} minutes the required checks of ${short(head)} are still not final. dipo takes it in again when they pass.`,
                run.key,
                runId,
              ),
            );
            free(ctx);
            return "left";
          }
          move({ phase: "merge" });
          break;
        }
        case "merge": {
          const outcome = await this.#merge(ctx, run, stored, current);
          if (outcome === "again") {
            current = { ...current, ...this.#again(ctx, current) };
            continue;
          }
          return outcome;
        }
      }
    }
  }

  /** The refusal went back to the sync: the next sync merges the base whenever it moved. */
  #again(
    ctx: StorySlotContext,
    current: SlotOccupant,
  ): Pick<SlotOccupant, "phase" | "syncMode" | "attempts"> {
    const change = {
      phase: "sync" as const,
      syncMode: "always" as const,
      attempts: current.attempts + 1,
    };
    ctx.write(() => {
      updateSlot(ctx.office, change);
      return [];
    });
    return change;
  }

  /** Steps 5 and 6: the guards and the host merge. */
  async #merge(
    ctx: StorySlotContext,
    run: StoredRun,
    stored: StoryPrRecord,
    current: SlotOccupant,
  ): Promise<Outcome | "again"> {
    const office = ctx.office;
    const runId = run.runId;
    const head = current.head ?? "";
    const leave = (code: string, text: string, level: "info" | "warn" = "warn"): Outcome => {
      ctx.left.set(runId, head);
      ctx.write(() => {
        leaveSlot(office);
        return [notice(level, code, text, run.key, runId)];
      });
      return "left";
    };
    let view;
    try {
      // A copy of this round on another head is read again: the slot may have pushed since.
      view = await readsOf(ctx).viewPr(current.repo, current.number, { head });
    } catch (error) {
      if (error instanceof CodeHostError) return "waiting";
      throw error;
    }
    // A merge found merged (a step run again after a restart, or a hand merge meanwhile).
    if (view.state === "merged") return this.#merged(ctx, run, current);
    if (view.state === "closed") {
      free(ctx);
      await this.#prClosed(ctx, run, { ...stored, closedAt: ctx.clock.now() });
      return "left";
    }
    // Step 5: the host's head is the one dipo pushed, and no label holds the PR.
    if (view.headSha !== "" && view.headSha !== head) {
      this.#headChanged(ctx, run, { ...stored, headSha: head }, view.headSha);
      ctx.left.set(runId, head);
      free(ctx);
      return "left";
    }
    if (await this.#guarded(ctx, run, current, head)) {
      free(ctx);
      return "left";
    }
    // The review verdict and an approved merge gate must hold for exactly the head that merges:
    // the slot's own commits (the close-out, a merge of the base) never merge without them.
    const approval = await this.#approvedFor(ctx.officeId, office, run, head);
    if (!approval.ok) {
      // Out of the slot until the head, its verdict or its approved gate changes, so it does not
      // come back every tick without merging.
      const key = approvalKey(head, approval.verdict ?? "none", approval.gate ?? "none");
      ctx.left.set(runId, key);
      free(ctx);
      ctx.once(`story:${runId}`, STORY_SLOT_NOTICES.unapproved, key, () =>
        notice(
          "warn",
          STORY_SLOT_NOTICES.unapproved,
          `${run.story} left the merge slot unmerged: no approved review and merge gate hold for ${short(head)}, the head it would merge. The review loop takes that head.`,
          run.key,
          runId,
        ),
      );
      return "left";
    }
    // Step 6: squash-merge, only while the host's head is the one dipo pushed.
    try {
      await ctx.host.squashMerge(current.repo, current.number, {
        headSha: head,
        subject: stored.title,
      });
    } catch (error) {
      if (!(error instanceof CodeHostError)) throw error;
      const again = await ctx.host.viewPr(current.repo, current.number).catch(() => null);
      if (again?.state === "merged") {
        ctx.prState?.invalidate?.(current.repo, current.number);
        return this.#merged(ctx, run, current);
      }
      const git = this.#deps.git;
      const moved =
        (await git.fetch(ctx.officeId)) && !(await git.containsBase(ctx.officeId, current.branch));
      if (!moved) {
        return leave(
          STORY_SLOT_NOTICES.refused,
          `The host refused to merge PR #${current.number} of ${run.story}: ${error.message} It left the slot; dipo takes it in again when its PR changes.`,
        );
      }
      if (current.attempts + 1 >= STORY_MERGE_ATTEMPTS) {
        free(ctx);
        await this.#park(ctx, run, {
          reason: "conflict",
          cause: PARK_CAUSES.slotRefused,
          detail: `base moved during merge ${STORY_MERGE_ATTEMPTS} times: the host refused to merge PR #${current.number} each time because the base had moved`,
        });
        return "left";
      }
      return "again";
    }
    // The PR-state round's copy of the PR is stale now (DIPO-314).
    ctx.prState?.invalidate?.(current.repo, current.number);
    return this.#merged(ctx, run, current);
  }

  /**
   * Step 5's label and release path guards for the head that would merge: true when a hold label
   * or the release path holds it (with its notice), or the release path cannot be read. The base is
   * fetched first, so the CODEOWNERS read is the base's as it is now, not as it was at the sync; a
   * failed fetch leaves the slot with the `mergeSlot.releasePathUnknown` notice.
   */
  async #guarded(
    ctx: StorySlotContext,
    run: StoredRun,
    current: SlotOccupant,
    head: string,
  ): Promise<boolean> {
    const config = runConfigOf(ctx.office, run, ctx.config);
    const labels = await this.#deps.labels.prLabels(current.repo, current.number);
    const held = holdLabelsOn(labels, config.mergeSlot.holdLabels);
    if (held.length > 0) {
      return this.#heldBack(ctx, run, { number: current.number, head, held, release: [] }, "slot");
    }
    if (!(await this.#deps.git.fetch(ctx.officeId).catch(() => false))) {
      this.#releaseUnknown(ctx, run, head, "the fetch of the base failed");
      return true;
    }
    const release = await this.#releasePaths(ctx, run, head);
    if (release === null) return true;
    return this.#heldBack(ctx, run, { number: current.number, head, held, release }, "slot");
  }

  #merged(ctx: StorySlotContext, run: StoredRun, current: SlotOccupant): Outcome {
    ctx.left.delete(run.runId);
    ctx.write(() => {
      leaveSlot(ctx.office);
      return [
        notice(
          "info",
          STORY_SLOT_NOTICES.merged,
          `dipo squash-merged PR #${current.number} of ${run.story} at ${short(current.head ?? "")} after its review, its merge gate and its required checks passed.`,
          run.key,
          run.runId,
        ),
      ];
    });
    return "merged";
  }

  async #closeOut(ctx: StorySlotContext, run: StoredRun, slotRun: StorySlotRun): Promise<void> {
    await this.#deps.git.closeOut(ctx.officeId, slotRun, (target) =>
      this.#deps.summary(target, ctx.office, run.key as string, ctx.clock.now()),
    );
  }

  /** A conflict the sync committed: pushed, out of the slot, and one fix round with its item. */
  async #conflict(
    ctx: StorySlotContext,
    run: StoredRun,
    stored: StoryPrRecord,
    head: string,
    item: FixItem,
  ): Promise<Outcome> {
    const office = ctx.office;
    const pushed = await this.#deps.git.push(ctx.officeId, stored.branch);
    recordSlotPush(ctx, stored.branch, pushed);
    ctx.write(() => {
      leaveSlot(office);
      return [
        notice(
          "warn",
          STORY_SLOT_NOTICES.conflict,
          `${run.story} left the merge slot: the base conflicts with PR #${stored.number}. dipo committed git's merge on the branch at ${short(head)}${pushed.ok ? "" : ` (the push failed: ${pushed.detail})`} and hands the conflict to its worker in a fix round.`,
          run.key,
          run.runId,
        ),
      ];
    });
    await this.#deps.prSync?.(ctx.officeId, run.runId).catch(() => undefined);
    const queued = await this.#deps.conflict?.(ctx.officeId, run.runId, { head, item });
    if (queued !== true) {
      ctx.logger?.warn("the merge slot's conflict was not handed to the worker", {
        run: run.runId,
      });
    }
    return "left";
  }

  async #park(
    ctx: StorySlotContext,
    run: StoredRun,
    park: {
      readonly reason: "conflict" | "stopped";
      readonly cause: string;
      readonly detail: string;
    },
  ): Promise<void> {
    const deps = this.#deps.park;
    if (deps === undefined) {
      ctx.write(() => [
        notice(
          "warn",
          STORY_SLOT_NOTICES.failed,
          `${run.story} should park ${park.reason} (${park.cause}): ${park.detail}. This daemon cannot park it.`,
          run.key,
          run.runId,
        ),
      ]);
      return;
    }
    try {
      await parkStory(
        {
          office: ctx.office,
          writer: deps.writer,
          now: () => ctx.clock.now(),
          write: (fn) => ctx.write(() => withWorkViews(ctx.office, fn())),
          implemented: deps.implemented,
        },
        { run, reason: park.reason, cause: park.cause, detail: park.detail, endKind: park.reason },
      );
    } catch (error) {
      ctx.logger?.warn("parking a story from the merge slot failed", {
        run: run.runId,
        reason: messageOf(error),
      });
    }
  }
}

/**
 * Pure: true when the merge gate `gate` that holds for a head no longer fits the release paths the
 * head changes (DIPO-331): it is no hand-merge-only gate and the head changes one (and the
 * maintainer did not reject it), or it is an open hand-merge-only gate and the head changes none.
 */
function gateOutdated(gate: StoredMergeGate, release: readonly string[]): boolean {
  if (release.length > 0) {
    return gate.handMerge === null && gate.decision?.decision !== "rejected";
  }
  return gate.handMerge !== null && gate.decision === null;
}

/**
 * A slot push that reached the remote, on the story's live claim (DIPO-315: every story-branch push
 * sets `claims.pushed_at`). An unchanged branch or a missing remote records nothing here.
 */
function recordSlotPush(
  ctx: { readonly office: OfficeHandle; readonly clock: Clock },
  branch: string,
  pushed: PushOutcome,
): void {
  if (!pushed.ok || !pushed.pushed) return;
  const at = ctx.clock.now();
  ctx.office.immediate(() =>
    recordBranchPush(ctx.office, branch, { pushed: true, error: null }, at),
  );
}

/** How a tick reads a story PR's state: the PR-state round's reads, else the host (DIPO-314). */
function readsOf(ctx: StorySlotContext): Pick<PrStateReads, "viewPr"> {
  return ctx.prState ?? ctx.host;
}
