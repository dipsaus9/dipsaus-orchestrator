// Story PRs and GitHub's auto-merge (0002). The office's auto-merge poll (`merger.ts`) runs this
// module at each round of the PR-state poll, after the story-PR poll, for each open story PR of a
// run waiting In Review (open at In Review with no active period, live claim, no open park):
//
// - The gate (`#approvedGate`). Once the required checks are green on the pushed head
//   (`StoryPrs.ciState`, or no CI ran for a box run's head) and the review verdict of the head's
//   code tree is approved or overridden, the host is read: the PR's state, head, labels and whether
//   GitHub can merge it. The head's merge gate opens (`gates.ts`) unless one holds for it already,
//   decided by rule or waiting for the maintainer. Each story parked `review-blocked` gets its
//   override gate here too.
// - The release path. Before a gate opens, the release paths the head changes are read from git
//   (`StoryMergeGit.releasePaths`: the base's CODEOWNERS, the PR's diff). A PR that changes one gets
//   a gate that waits for the maintainer's merge on the host only, also when an earlier gate of the
//   head was approved, and never gets auto-merge; dipo never passes `--admin`. When git cannot tell,
//   nothing happens this round.
// - Turning auto-merge on (`#arm`), for a PR whose gate is approved, that carries no hold label and
//   that GitHub does not report as conflicting: the close-out commit (final summary, modified files,
//   status Done), one push, never forced, the story PR updated to the pushed head, the approval and
//   the release path checked again for exactly that head, and then
//   `gh pr merge --auto --squash --match-head-commit <that head>`. GitHub merges once its required
//   checks pass on that head, and the Done poll sees the merge.
// - While auto-merge is on (`#watch`), each round reads the PR, its labels and the head's CI. dipo
//   turns auto-merge off (`gh pr merge --disable-auto`) and then:
//   - on a conflict, merges the base into the branch as git leaves it, markers and all, pushes, and
//     hands the conflict to the worker as one fix round (`FixRounds.conflict`); a conflict in a path
//     the worker cannot write parks the story `conflict`;
//   - on red required checks, leaves the fix round to the CI path (`StoryPrs`, `FixRounds.consider`);
//   - on a hold label (`autorelease: pending` always, and `merge.holdLabels`), reopens the gate:
//     a new merge gate for the head waits for the maintainer;
//   - on a head dipo did not push, reopens the gate as one only a hand merge or a discard decides;
//   - when the head changes the release path now (the base's CODEOWNERS grew), git cannot tell, or
//     no approved review and gate hold for the head any more, leaves it off: the gate pass opens a
//     hand-merge-only gate, or waits for the review.
//   A `--disable-auto` that fails is a notice, and the next round tries again before anything else.
// - A story that no longer waits for its merge (a fix round reopened its run, it parked, its claim
//   ended) gets auto-merge off at the next round, and every park or lift written to its branch
//   turns it off first (`guard.ts`, `offFor`): `--match-head-commit` is checked only when
//   auto-merge goes on, so a later head must never meet it still on.
// - A PR closed on GitHub without a merge parks the story `by-maintainer` with the detail "PR #n
//   closed on GitHub" (0002); a resume opens a new PR.
// - Stages after a run's start read the run's configuration snapshot (`runConfigOf`): `autoMerge`
//   and `holdLabels` of the run.
//
// The conflict hand-off records the merge before the branch moves to it. A crash after the record
// leaves the branch at the merge's tip or at the merge; the next hand-off finds the record
// (`#cutShort`), moves the branch when it has not moved, and pushes and hands it over then.

import type {
  Clock,
  CommandName,
  IdSource,
  OfficeId,
  RunId,
  StoryKey,
} from "@dipsaus-orchestrator/contract";

import type { CatchUpMerged } from "../box/collisions";
import type { NewEntry } from "../changelog/log";
import type { OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import type { Logger } from "../log/logger";
import {
  type AutoMergeHost,
  CodeHostError,
  type HostPr,
  type PrReviewHost,
} from "../platform/host";
import type { PrStateReads } from "../story-pr/pr-state";
import type { FixItem } from "../prompts/feedback";
import {
  latestVerdictOfRun,
  reviewVerdictForTree,
  type StoredReviewVerdict,
} from "../review/store";
import { runConfigOf } from "../run/config-snapshot";
import { catchUpsOf } from "../run/conflicts";
import { openPark, type ParkWriter, parkStory } from "../run/park";
import { heldByPark } from "../run/park-state";
import type { RunStoryFacts } from "../run/resume";
import { findRun, openAtInReview, runRoundCounts, type StoredRun } from "../run/records";
import type { CiHeadState } from "../story-pr/prs";
import {
  findStoryPr,
  openStoryPrs,
  recordBranchPush,
  type StoryPrRecord,
} from "../story-pr/records";
import type { StoryEditor } from "../story-store/store";
import { withWorkViews } from "../views/work";
import { latestRecordedTest, testPassedFor } from "../run/test-records";
import { findClaim } from "../worktree/records";
import { repoOfPrUrl } from "../worktree/release";

import {
  autoreleasePending,
  decideMergeGate,
  holdLabelsOn,
  type MergeWait,
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
import type { PushOutcome, StoryMergeGit, StoryMergeRun } from "./story-git";

/** `engine.notice` codes of story PRs and the auto-merge (0002). */
export const STORY_MERGE_NOTICES = {
  autoMergeOn: "merge.autoMergeOn",
  autoMergeOff: "merge.autoMergeOff",
  autoMergeFailed: "merge.autoMergeFailed",
  conflict: "merge.conflict",
  pushFailed: "merge.pushFailed",
  failed: "merge.failed",
  headChanged: "pr.headChanged",
  held: "merge.held",
  /** The release path of a PR could not be read: no auto-merge for it this round. */
  releaseUnknown: "merge.releasePathUnknown",
  /** The head that would merge has no approved review and merge gate. */
  unapproved: "merge.unapproved",
  /** A merge of the base dipo made could not be recorded. */
  unrecorded: "merge.unrecorded",
} as const;

/** What the story PRs' auto-merge needs besides the poll's own reads and clock. */
export interface StoryMergeDeps {
  readonly git: StoryMergeGit;
  readonly ids: IdSource;
  /** Turns GitHub's auto-merge on and off. */
  readonly host: Pick<AutoMergeHost, "enableAutoMerge" | "disableAutoMerge">;
  /** The PR's labels (the hold labels and `autorelease: pending`). */
  readonly labels: Pick<PrReviewHost, "prLabels">;
  /** Where the CI of a run's pushed head stands (`StoryPrs.ciState`). */
  readonly ci: (office: OfficeId, runId: RunId) => CiHeadState | null;
  /** The code tree key of `head` (0010), or null when it cannot be read; `git.treeKey` by default. */
  readonly treeKey?: (office: OfficeId, run: StoredRun, head: string) => Promise<string | null>;
  /** Updates the story PR to the branch's pushed head (`StoryPrs.sync`). */
  readonly prSync: (office: OfficeId, runId: RunId) => Promise<void>;
  /** The story facts on the base: the manual test-plan entries of a flagged story's gate. */
  readonly story?: (office: OfficeId, run: StoredRun) => Promise<RunStoryFacts>;
  /** Writes the close-out's final summary (`writeCloseOutSummary`). */
  readonly summary: (
    story: StoryEditor,
    office: OfficeHandle,
    key: string,
    at: number,
  ) => Promise<unknown>;
  /** Records a merge of the base dipo made (`StoryConflicts.recorded`): catch-up row, hand-off. */
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

/** What a round of the poll gives this module. */
export interface StoryMergeContext {
  readonly officeId: OfficeId;
  readonly office: OfficeHandle;
  /** How the round reads a PR: through the office's PR-state round, else the host. */
  readonly reads: Pick<PrStateReads, "viewPr" | "invalidate">;
  readonly clock: Clock;
  /** The configuration in force; a run's snapshot is laid on it. */
  readonly config: OfficeConfig;
  /** Writes the notice unless it was given already for this `subject`, code and `value`. */
  once(subject: string, code: string, value: string, make: () => NewEntry): void;
  /** Runs `fn` in one transaction and appends the entries it returns. */
  write(fn: () => readonly NewEntry[]): void;
  readonly logger?: Logger;
}

/** One open story PR of a run waiting In Review, as the round read it. */
interface Pr {
  readonly run: StoredRun;
  readonly stored: StoryPrRecord;
  readonly repo: string;
  readonly view: HostPr;
}

/** Why dipo turns auto-merge off for a PR (see the file comment). */
type Stop =
  | { readonly kind: "foreignHead"; readonly head: string }
  | { readonly kind: "conflict" }
  | { readonly kind: "red" }
  | { readonly kind: "held"; readonly labels: readonly string[] }
  | { readonly kind: "releasePath"; readonly paths: readonly string[] }
  | { readonly kind: "releaseUnknown" }
  | { readonly kind: "unapproved" }
  | { readonly kind: "notWaiting" };

/** The PR auto-merge goes off for, with what its notices name. */
interface Target {
  readonly repo: string;
  readonly number: number;
  readonly story: string;
  readonly key: StoryKey | null;
  readonly runId: RunId;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/** Pure: the text of a stop, after "dipo turned auto-merge off for PR #n of <story>: ". */
function stopText(stop: Stop): string {
  switch (stop.kind) {
    case "foreignHead":
      return `its head on GitHub is ${short(stop.head)}, which dipo did not push. Its merge gate waits again: merge it by hand on GitHub or discard the story.`;
    case "conflict":
      return "GitHub reports that the base conflicts with it. dipo merges the base into the branch and hands the conflict to its worker in a fix round.";
    case "red":
      return "its required checks are red. The CI feedback goes back to its worker in a fix round.";
    case "held":
      return `it carries ${stop.labels.map((label) => `"${label}"`).join(", ")}. Its merge gate waits for the maintainer again.`;
    case "releasePath":
      return `it changes the release path (${releasePathList(stop.paths)}), which needs the maintainer's code owner approval, so only a merge by hand on GitHub merges it.`;
    case "releaseUnknown":
      return "dipo could not read whether it changes the release path. dipo turns auto-merge on again once it can.";
    case "unapproved":
      return "no approved review and merge gate hold for its head any more. The review loop takes that head.";
    case "notWaiting":
      return "its story no longer waits for its merge (a fix round, a park or the end of its claim), so no later head merges without its merge gate.";
  }
}

export class StoryMerges {
  readonly #deps: StoryMergeDeps;

  constructor(deps: StoryMergeDeps) {
    this.#deps = deps;
  }

  /** The story PR of the run updated to its branch's pushed head (a resume, DIPO-324). */
  async prSynced(office: OfficeId, runId: RunId): Promise<void> {
    await this.#deps.prSync(office, runId);
  }

  /** One round over the office's story PRs (see the file comment). */
  async tick(ctx: StoryMergeContext): Promise<void> {
    await this.#overrideGates(ctx);
    await this.#closedPrs(ctx);
    for (const stored of openStoryPrs(ctx.office)) {
      try {
        await this.#story(ctx, stored);
      } catch (error) {
        ctx.logger?.warn("the auto-merge of a story PR failed", {
          office: ctx.officeId,
          run: stored.runId,
          reason: messageOf(error),
        });
      }
    }
  }

  /**
   * Turns auto-merge off for the open story PR of `branch` before dipo writes to that branch for a
   * park or a fix round. Throws when GitHub cannot be read or refuses, so nothing is written to the
   * branch until auto-merge is off: `--match-head-commit` is checked only when it goes on.
   */
  async offFor(ctx: StoryMergeContext, branch: string): Promise<void> {
    const stored = openStoryPrs(ctx.office).find((pr) => pr.branch === branch);
    const repo = stored === undefined ? null : repoOfPrUrl(stored.url);
    if (stored === undefined || repo === null) return;
    const failed = (why: string): Error =>
      new Error(
        `turning auto-merge off for PR #${stored.number} failed (${why}), so dipo wrote nothing to ${branch}`,
      );
    let view: HostPr;
    try {
      view = await ctx.reads.viewPr(repo, stored.number);
    } catch (error) {
      throw failed(`GitHub could not be read: ${messageOf(error)}`);
    }
    if (view.state !== "open" || view.autoMerge !== true) return;
    const refused = await this.#disable(ctx, this.#target(ctx, stored, repo), {
      kind: "notWaiting",
    });
    if (refused !== null) throw failed(`GitHub refused: ${refused}`);
  }

  async #story(ctx: StoryMergeContext, stored: StoryPrRecord): Promise<void> {
    const run = this.#waitingRun(ctx.office, stored.runId);
    const repo = repoOfPrUrl(stored.url);
    if (repo === null) return;
    if (run === null) return this.#offWhileNotWaiting(ctx, stored, repo);
    let view: HostPr;
    try {
      view = await ctx.reads.viewPr(repo, stored.number, { head: stored.headSha });
    } catch (error) {
      if (error instanceof CodeHostError) return;
      throw error;
    }
    if (view.state === "merged") return;
    if (view.state === "closed") return this.#prClosed(ctx, run, stored);
    const pr: Pr = { run, stored, repo, view };
    if (view.autoMerge === true) return this.#watch(ctx, pr);
    if (view.headSha !== "" && view.headSha !== stored.headSha) {
      this.#headChanged(ctx, run, stored, view.headSha);
      return;
    }
    if (!(await this.#approvedGate(ctx, pr))) return;
    if (view.mergeable === "conflicting") return this.#conflict(ctx, run, stored);
    await this.#arm(ctx, pr);
  }

  /**
   * The PR of a run that no longer waits for its merge (a fix round reopened it, it parked, its
   * claim ended): auto-merge goes off, so a later head never merges without its gate.
   */
  async #offWhileNotWaiting(
    ctx: StoryMergeContext,
    stored: StoryPrRecord,
    repo: string,
  ): Promise<void> {
    let view: HostPr;
    try {
      view = await ctx.reads.viewPr(repo, stored.number);
    } catch (error) {
      if (error instanceof CodeHostError) return;
      throw error;
    }
    if (view.state !== "open" || view.autoMerge !== true) return;
    await this.#disable(ctx, this.#target(ctx, stored, repo), { kind: "notWaiting" });
  }

  /** What the notices of a PR's auto-merge name. */
  #target(ctx: StoryMergeContext, stored: StoryPrRecord, repo: string): Target {
    const run = findRun(ctx.office, stored.runId);
    return {
      repo,
      number: stored.number,
      story: run?.story ?? stored.key,
      key: stored.key,
      runId: stored.runId,
    };
  }

  /** The story run waiting In Review whose PR this is, or null. */
  #waitingRun(office: OfficeHandle, runId: RunId): StoredRun | null {
    const run = findRun(office, runId);
    if (run === null || run.kind !== "story" || run.key === null || !openAtInReview(run)) {
      return null;
    }
    if (run.branch === null || run.startSha === null) return null;
    const claim = findClaim(office, runId);
    if (claim === null || claim.releasedAt !== null) return null;
    if (heldByPark(office, run.key)) return null;
    return run;
  }

  // ---- the gate ---------------------------------------------------------------------------------

  /**
   * True when the PR's merge gate for its head is approved and nothing holds the PR: its required
   * checks were green on that head (or no CI ran for it), its verdict is approved or overridden,
   * no hold label is on it and it changes no release path. Opens the gate when none holds yet.
   */
  async #approvedGate(ctx: StoryMergeContext, pr: Pr): Promise<boolean> {
    const { run, stored } = pr;
    const head = stored.headSha;
    const ci = this.#deps.ci(ctx.officeId, run.runId);
    if (ci === null || ci.head !== head || (ci.kind !== "green" && ci.kind !== "none"))
      return false;
    const verdict = await this.#verdictFor(ctx.officeId, ctx.office, run, head);
    if (verdict === null || (verdict.verdict !== "approved" && verdict.override === null)) {
      return false;
    }
    const held = await this.#held(ctx, pr);
    const release = await this.#releasePaths(ctx, run, head);
    if (release === null) return false;
    const gate = await this.#gateFor(ctx, pr, { head, verdict, held, release });
    if (gate?.decision?.decision !== "approved") return false;
    return !this.#heldBack(ctx, run, { number: stored.number, head, held, release });
  }

  /** The PR's labels that hold it: `autorelease: pending` and the run's hold labels. */
  async #held(ctx: StoryMergeContext, pr: Pr): Promise<string[]> {
    const config = runConfigOf(ctx.office, pr.run, ctx.config);
    const labels = await this.#deps.labels.prLabels(pr.repo, pr.stored.number);
    return holdLabelsOn(labels, config.merge.holdLabels);
  }

  /**
   * The release paths `head` changes, or null with a notice (once per head) when git cannot tell:
   * then nothing turns auto-merge on for it.
   */
  async #releasePaths(
    ctx: StoryMergeContext,
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
    this.#releaseUnknownNotice(ctx, run, head, "the base's CODEOWNERS or the PR's diff");
    return null;
  }

  /** The `merge.releasePathUnknown` notice, once per head: nothing turns auto-merge on for it. */
  #releaseUnknownNotice(ctx: StoryMergeContext, run: StoredRun, head: string, what: string): void {
    ctx.once(`story:${run.runId}`, STORY_MERGE_NOTICES.releaseUnknown, head, () =>
      notice(
        "warn",
        STORY_MERGE_NOTICES.releaseUnknown,
        `${run.story}: dipo could not read whether ${short(head)} changes the release path (${what}), so it does not turn auto-merge on. It tries again at the next poll.`,
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
    ctx: StoryMergeContext,
    run: StoredRun,
    pr: {
      readonly number: number;
      readonly head: string;
      readonly held: readonly string[];
      readonly release: readonly string[];
    },
  ): boolean {
    let text: string;
    if (pr.release.length > 0) {
      text = `${run.story}: PR #${pr.number} changes the release path (${releasePathList(pr.release)}), which needs the maintainer's code owner approval, so dipo never turns auto-merge on for it; the maintainer merges it by hand on GitHub.`;
    } else if (autoreleasePending(pr.held)) {
      text = `${run.story}: PR #${pr.number} carries "autorelease: pending", so dipo never turns auto-merge on for it; merge it by hand on GitHub.`;
    } else if (pr.held.length > 0) {
      const labels = pr.held.map((label) => `"${label}"`).join(", ");
      text = `${run.story}: PR #${pr.number} is approved but carries the hold label ${labels}; dipo turns auto-merge on once the label is gone.`;
    } else {
      return false;
    }
    const value = `${pr.head}:${pr.held.join(",")}${pr.release.length > 0 ? ":release-path" : ""}`;
    ctx.once(`story:${run.runId}`, STORY_MERGE_NOTICES.held, value, () =>
      notice("info", STORY_MERGE_NOTICES.held, text, run.key, run.runId),
    );
    return true;
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
   * gate's head or an approval carried from it (task-file commits such as the close-out).
   */
  async #holds(
    officeId: OfficeId,
    office: OfficeHandle,
    run: StoredRun,
    gate: StoredMergeGate,
    head: string,
  ): Promise<boolean> {
    if (gate.head === head) return true;
    if (gate.head === "") return false;
    const verdict = await this.#verdictFor(officeId, office, run, head);
    if (verdict === null) return false;
    const atGate = await this.#verdictFor(officeId, office, run, gate.head);
    if (atGate === null) return false;
    return atGate.gate === verdict.gate || verdict.carriedFrom === atGate.commit;
  }

  /**
   * True when the verdict of `head`'s code tree is approved or overridden and an approved merge
   * gate of the run holds for `head`: what dipo checks right before it turns auto-merge on.
   */
  async #approvedFor(ctx: StoryMergeContext, run: StoredRun, head: string): Promise<boolean> {
    if (head === "") return false;
    const verdict = await this.#verdictFor(ctx.officeId, ctx.office, run, head);
    if (verdict === null || (verdict.verdict !== "approved" && verdict.override === null)) {
      return false;
    }
    for (const gate of mergeGatesOfRun(ctx.office, run.runId).toReversed()) {
      if (gate.decision?.decision !== "approved") continue;
      if (await this.#holds(ctx.officeId, ctx.office, run, gate, head)) return true;
    }
    return false;
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
    return this.#holds(officeId, office, run, gate, head);
  }

  /**
   * The head's merge gate: one that holds for it, else a new one; superseded open ones close. A
   * head that changes the release path gets a hand-merge-only gate even when one that holds for it
   * was approved, unless the maintainer rejected it; an open hand-merge-only gate of a head that no
   * longer changes it is replaced.
   */
  async #gateFor(
    ctx: StoryMergeContext,
    pr: Pr,
    input: {
      readonly head: string;
      readonly verdict: StoredReviewVerdict;
      readonly held: readonly string[];
      readonly release: readonly string[];
    },
  ): Promise<StoredMergeGate | null> {
    const { run } = pr;
    let found: StoredMergeGate | null = null;
    for (const gate of mergeGatesOfRun(ctx.office, run.runId).toReversed()) {
      if (await this.#holds(ctx.officeId, ctx.office, run, gate, input.head)) {
        found = gate;
        break;
      }
    }
    if (found !== null && !gateOutdated(found, input.release)) return found;
    const waits = this.#waits(ctx, run, input);
    const note =
      found === null
        ? `superseded: the PR head moved to ${short(input.head)}`
        : `superseded: the release path of ${short(input.head)} changed`;
    return this.#openGate(ctx, pr, { head: input.head, waits, note });
  }

  /**
   * Every reason the head's merge gate waits for the maintainer (`mergeWaits`); a flagged story
   * whose test passed at the head no longer waits on its flag (DIPO-309).
   */
  #waits(
    ctx: StoryMergeContext,
    run: StoredRun,
    input: {
      readonly head: string;
      readonly verdict: StoredReviewVerdict;
      readonly held: readonly string[];
      readonly release: readonly string[];
    },
  ): MergeWait[] {
    const config = runConfigOf(ctx.office, run, ctx.config);
    const key = run.key as StoryKey;
    return mergeWaits({
      autoMerge: config.merge.autoMerge,
      testBeforeMerge:
        mirrorFlagged(ctx.office, key) && !testPassedFor(ctx.office, key, input.head),
      verdict: input.verdict,
      holdLabels: input.held,
      releasePaths: input.release,
    });
  }

  /** Opens a merge gate for `head` with `waits`; open gates of the run close as superseded. */
  async #openGate(
    ctx: StoryMergeContext,
    pr: Pr,
    input: { readonly head: string; readonly waits: readonly MergeWait[]; readonly note: string },
  ): Promise<StoredMergeGate | null> {
    const { run, stored } = pr;
    const office = ctx.office;
    const key = run.key as StoryKey;
    const flagged = mirrorFlagged(office, key);
    const manual = flagged ? await this.#manualEntries(ctx, run) : [];
    const tested = latestRecordedTest(office, run.runId);
    const summary = mergeGateSummary({
      story: run.story as string,
      pr: { number: stored.number, url: stored.url },
      head: input.head,
      waits: input.waits,
      ...(flagged ? { manual } : {}),
      test:
        tested === null || tested.result === null
          ? null
          : { result: tested.result, head: tested.head, note: tested.note },
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
            note: input.note,
            at,
          }),
        );
      }
      const made = openMergeGate(office, this.#deps.ids, {
        runId: run.runId,
        key,
        head: input.head,
        waits: input.waits,
        summary,
        phase: flagged ? "test" : "merge",
        at,
      });
      opened.gate = made.gate;
      return withWorkViews(office, [...entries, ...made.entries]);
    });
    return opened.gate;
  }

  /** The manual test-plan entries of a flagged story, for its gate's summary; none when unread. */
  async #manualEntries(
    ctx: StoryMergeContext,
    run: StoredRun,
  ): Promise<{ check: string; expect?: string }[]> {
    if (this.#deps.story === undefined) return [];
    try {
      const facts = await this.#deps.story(ctx.officeId, run);
      return (facts.fields.test_plan?.entries ?? [])
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
      return [];
    }
  }

  /** Each story parked `review-blocked` gets its override gate (0002). */
  async #overrideGates(ctx: StoryMergeContext): Promise<void> {
    const office = ctx.office;
    // The reason is Backlog.md's (DIPO-360); the open rows only name the runs.
    const parked = office.all<{ run_id: string }>(
      `select run_id from parks where office_id = $office_id and resolved_at is null
        and run_id is not null
      order by park_id`,
    );
    for (const row of parked) {
      const run = findRun(office, row.run_id as RunId);
      if (run === null || run.key === null || run.story === null) continue;
      const park = openPark(office, run.key);
      if (park?.runId !== run.runId || park.reason !== "review-blocked") continue;
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

  // ---- auto-merge on ----------------------------------------------------------------------------

  /** The close-out, the push, and auto-merge on at the pushed head (see the file comment). */
  async #arm(ctx: StoryMergeContext, pr: Pr): Promise<void> {
    const { run, repo } = pr;
    const git = this.#deps.git;
    const branch = run.branch as string;
    await git.closeOut(ctx.officeId, this.#mergeRun(ctx, run), (story) =>
      this.#deps.summary(story, ctx.office, run.key as string, ctx.clock.now()),
    );
    if (!(await this.#push(ctx, run, branch))) return;
    await this.#deps.prSync(ctx.officeId, run.runId);
    const stored = findStoryPr(ctx.office, run.runId);
    const head = await git.head(ctx.officeId, branch);
    // The PR follows the pushed head before GitHub is asked to merge exactly that head.
    if (stored === null || head === null || stored.headSha !== head) return;
    if (!(await this.#approvedFor(ctx, run, head))) {
      this.#unapproved(ctx, run, head);
      return;
    }
    // The base as it is now: CODEOWNERS may have grown since the gate's read.
    if (!(await git.fetch(ctx.officeId))) {
      this.#releaseUnknownNotice(ctx, run, head, "the fetch of the base failed");
      return;
    }
    const release = await this.#releasePaths(ctx, run, head);
    if (release === null || release.length > 0) return;
    try {
      await this.#deps.host.enableAutoMerge(repo, stored.number, {
        headSha: head,
        subject: stored.title,
      });
    } catch (error) {
      if (!(error instanceof CodeHostError)) throw error;
      ctx.once(`story:${run.runId}`, STORY_MERGE_NOTICES.autoMergeFailed, error.message, () =>
        notice(
          "warn",
          STORY_MERGE_NOTICES.autoMergeFailed,
          `${run.story}: dipo could not turn auto-merge on for PR #${stored.number}: ${error.message} It tries again at the next poll.`,
          run.key,
          run.runId,
        ),
      );
      return;
    }
    ctx.reads.invalidate?.(repo, stored.number);
    ctx.write(() => [
      notice(
        "info",
        STORY_MERGE_NOTICES.autoMergeOn,
        `${run.story}: dipo committed the close-out on PR #${stored.number} and turned GitHub's auto-merge on at ${short(head)}; GitHub squash-merges it once its required checks pass on that head.`,
        run.key,
        run.runId,
      ),
    ]);
  }

  #unapproved(ctx: StoryMergeContext, run: StoredRun, head: string): void {
    ctx.once(`story:${run.runId}`, STORY_MERGE_NOTICES.unapproved, head, () =>
      notice(
        "warn",
        STORY_MERGE_NOTICES.unapproved,
        `${run.story}: no approved review and merge gate hold for ${short(head)}, the head that would merge, so dipo does not turn auto-merge on. The review loop takes that head.`,
        run.key,
        run.runId,
      ),
    );
  }

  #mergeRun(ctx: StoryMergeContext, run: StoredRun): StoryMergeRun {
    return {
      runId: run.runId,
      story: run.story as string,
      branch: run.branch as string,
      startSha: run.startSha as string,
      ...(this.#deps.itemMax === undefined
        ? {}
        : { itemMax: this.#deps.itemMax(ctx.officeId, run) }),
    };
  }

  /** One push of the branch, never forced, recorded on the claim; false with a notice on failure. */
  async #push(ctx: StoryMergeContext, run: StoredRun, branch: string): Promise<boolean> {
    const pushed = await this.#deps.git.push(ctx.officeId, branch);
    recordPush(ctx, branch, pushed);
    if (pushed.ok) return true;
    ctx.once(`story:${run.runId}`, STORY_MERGE_NOTICES.pushFailed, pushed.detail, () =>
      notice(
        "warn",
        STORY_MERGE_NOTICES.pushFailed,
        `dipo could not push ${run.story} (${branch}): ${pushed.detail}. It tries again at the next poll.`,
        run.key,
        run.runId,
      ),
    );
    return false;
  }

  // ---- while auto-merge is on -------------------------------------------------------------------

  /** Turns auto-merge off and acts when something stops the merge (see the file comment). */
  async #watch(ctx: StoryMergeContext, pr: Pr): Promise<void> {
    const stop = await this.#stopOf(ctx, pr);
    if (stop === null) return;
    const { run, stored } = pr;
    if ((await this.#disable(ctx, this.#target(ctx, stored, pr.repo), stop)) !== null) return;
    switch (stop.kind) {
      case "conflict":
        return this.#conflict(ctx, run, stored);
      case "held":
        return this.#reopen(ctx, pr, stop.labels);
      case "foreignHead":
        this.#headChanged(ctx, run, stored, stop.head);
        await this.#openGate(ctx, pr, {
          head: stored.headSha,
          waits: [{ kind: "foreignHead", head: stop.head }],
          note: `superseded: the PR head on GitHub moved to ${short(stop.head)}`,
        });
        return;
      default:
        // Red checks take the CI path's fix round; the gate pass takes the rest.
        return;
    }
  }

  /** Why auto-merge must go off for the PR now, or null while nothing stops it. */
  async #stopOf(ctx: StoryMergeContext, pr: Pr): Promise<Stop | null> {
    const { run, stored, view } = pr;
    const head = stored.headSha;
    if (view.headSha !== "" && view.headSha !== head) {
      return { kind: "foreignHead", head: view.headSha };
    }
    if (view.mergeable === "conflicting") return { kind: "conflict" };
    const ci = this.#deps.ci(ctx.officeId, run.runId);
    if (ci?.head === head && ci.kind === "red") return { kind: "red" };
    const held = await this.#held(ctx, pr);
    if (held.length > 0) return { kind: "held", labels: held };
    const release = await this.#releasePaths(ctx, run, head);
    if (release === null) return { kind: "releaseUnknown" };
    if (release.length > 0) return { kind: "releasePath", paths: release };
    if (!(await this.#approvedFor(ctx, run, head))) return { kind: "unapproved" };
    return null;
  }

  /** `gh pr merge --disable-auto`; null, or why it failed with a notice (once per cause). */
  async #disable(ctx: StoryMergeContext, pr: Target, stop: Stop): Promise<string | null> {
    try {
      await this.#deps.host.disableAutoMerge(pr.repo, pr.number);
    } catch (error) {
      if (!(error instanceof CodeHostError)) throw error;
      ctx.once(`story:${pr.runId}`, STORY_MERGE_NOTICES.autoMergeFailed, error.message, () =>
        notice(
          "error",
          STORY_MERGE_NOTICES.autoMergeFailed,
          `${pr.story}: dipo must turn auto-merge off for PR #${pr.number} (${stopText(stop)}), but GitHub refused: ${error.message} It tries again at the next poll.`,
          pr.key,
          pr.runId,
        ),
      );
      return error.message;
    }
    ctx.reads.invalidate?.(pr.repo, pr.number);
    ctx.write(() => [
      notice(
        "warn",
        STORY_MERGE_NOTICES.autoMergeOff,
        `dipo turned auto-merge off for PR #${pr.number} of ${pr.story}: ${stopText(stop)}`,
        pr.key,
        pr.runId,
      ),
    ]);
    return null;
  }

  /** A hold label appeared while auto-merge was on: the head's merge gate waits again. */
  async #reopen(ctx: StoryMergeContext, pr: Pr, held: readonly string[]): Promise<void> {
    const head = pr.stored.headSha;
    const verdict = await this.#verdictFor(ctx.officeId, ctx.office, pr.run, head);
    if (verdict === null) return;
    const waits = this.#waits(ctx, pr.run, { head, verdict, held, release: [] });
    await this.#openGate(ctx, pr, {
      head,
      waits,
      note: `superseded: a hold label appeared on ${short(head)}`,
    });
  }

  #headChanged(
    ctx: StoryMergeContext,
    run: StoredRun,
    stored: StoryPrRecord,
    hostHead: string,
  ): void {
    ctx.once(
      `story:${run.runId}`,
      STORY_MERGE_NOTICES.headChanged,
      `${stored.headSha}:${hostHead}`,
      () =>
        notice(
          "warn",
          STORY_MERGE_NOTICES.headChanged,
          `${run.story}: the head of PR #${stored.number} on the host is ${short(hostHead)}, not ${short(stored.headSha)} as dipo pushed it, so dipo does not merge it. Merge it by hand on GitHub (the Done poll picks that up) or discard the story.`,
          run.key,
          run.runId,
        ),
    );
  }

  // ---- the conflict hand-off --------------------------------------------------------------------

  /**
   * The base merged into the branch with its markers, pushed, and one fix round with its item. The
   * merge is recorded before the branch moves to it, so a hand-off a crash cut short is found again
   * at the next round (`#cutShort`) and finished, never planned twice.
   */
  async #conflict(ctx: StoryMergeContext, run: StoredRun, stored: StoryPrRecord): Promise<void> {
    const git = this.#deps.git;
    const office = ctx.officeId;
    const branch = run.branch as string;
    const resumed = await this.#cutShort(ctx, run);
    if (resumed !== null) return this.#handOff(ctx, run, stored, resumed);
    if (!(await git.fetch(office))) return;
    const merge = await git.conflictMerge(office, this.#mergeRun(ctx, run));
    if (merge.kind === "none") return;
    if (merge.kind === "unwritable") {
      await this.#park(ctx, run, {
        reason: "conflict",
        detail: `git could not merge ${merge.base} at ${short(merge.onto)} cleanly in paths the worker cannot write: ${merge.paths.join(", ")}`,
      });
      return;
    }
    const { merged, item } = merge;
    try {
      await this.#deps.recordMerge?.(office, run, merged);
    } catch (error) {
      this.#unrecorded(ctx, run, merged.commit, messageOf(error));
      return;
    }
    if (!(await git.moveBranch(office, branch, merged.commit, merged.tip))) return;
    await this.#handOff(ctx, run, stored, { merged, item });
  }

  /**
   * A conflicted merge of the base dipo recorded for the run whose hand-off a crash cut short: the
   * branch is still at the tip it was made on, or at the merge itself. The branch is moved to it
   * when it is not yet, and the conflict item is built again from git. Null when there is none.
   */
  async #cutShort(
    ctx: StoryMergeContext,
    run: StoredRun,
  ): Promise<{ merged: CatchUpMerged; item: FixItem } | null> {
    const git = this.#deps.git;
    const branch = run.branch as string;
    const tip = await git.head(ctx.officeId, branch);
    const row = catchUpsOf(ctx.office, run.runId)
      .filter((entry) => entry.kind === "merged" && entry.conflicts.length > 0)
      .at(-1);
    if (tip === null || row?.commit == null || (row.tip !== tip && row.commit !== tip)) return null;
    const merged: CatchUpMerged = {
      base: row.base,
      onto: row.onto,
      tip: row.tip,
      commit: row.commit,
      conflicts: row.conflicts,
      taskFile: null,
      outsideBox: true,
    };
    if (tip === row.tip && !(await git.moveBranch(ctx.officeId, branch, row.commit, row.tip))) {
      return null;
    }
    const item = await git.conflictItem(ctx.officeId, this.#mergeRun(ctx, run), merged);
    return { merged, item };
  }

  /** The merge on the branch pushed, the PR updated, and the conflict handed to the worker. */
  async #handOff(
    ctx: StoryMergeContext,
    run: StoredRun,
    stored: StoryPrRecord,
    hand: { readonly merged: CatchUpMerged; readonly item: FixItem },
  ): Promise<void> {
    const office = ctx.officeId;
    const branch = run.branch as string;
    const { merged, item } = hand;
    const pushed = await this.#push(ctx, run, branch);
    ctx.write(() => [
      notice(
        "warn",
        STORY_MERGE_NOTICES.conflict,
        `${run.story}: the base conflicts with PR #${stored.number}. dipo committed git's merge on the branch at ${short(merged.commit)}${pushed ? "" : " (the push failed)"} and hands the conflict to its worker in a fix round.`,
        run.key,
        run.runId,
      ),
    ]);
    await this.#deps.prSync(office, run.runId).catch(() => undefined);
    const queued = await this.#deps.conflict?.(office, run.runId, { head: merged.commit, item });
    if (queued !== true) {
      ctx.logger?.warn("the conflict was not handed to the worker", { run: run.runId });
    }
  }

  /** The merge was made on the branch but not recorded: nothing is pushed or handed over. */
  #unrecorded(ctx: StoryMergeContext, run: StoredRun, commit: string, reason: string): void {
    ctx.write(() => [
      notice(
        "warn",
        STORY_MERGE_NOTICES.unrecorded,
        `${run.story}: dipo could not record its merge of the base at ${short(commit)} (${reason}), so the branch did not move to it and nothing was pushed or handed to the worker. dipo tries again at the next poll.`,
        run.key,
        run.runId,
      ),
    ]);
  }

  // ---- closed PRs and parks ---------------------------------------------------------------------

  /**
   * A story PR the host shows closed without a merge parks the story `by-maintainer` with the
   * detail "PR #n closed on GitHub" (0002), once per close: no park of the run since the close.
   * Its resume opens a new PR that names the closed one (0020).
   */
  async #closedPrs(ctx: StoryMergeContext): Promise<void> {
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

  async #prClosed(ctx: StoryMergeContext, run: StoredRun, stored: StoryPrRecord): Promise<void> {
    const office = ctx.office;
    if (run.kind !== "story" || run.key === null || heldByPark(office, run.key)) return;
    const since = stored.closedAt ?? stored.openedAt;
    const parkedFor = office.get(
      `select 1 as found from parks where office_id = $office_id and run_id = $run
        and at >= $since limit 1`,
      { run: run.runId, since },
    );
    if (parkedFor !== null) return;
    await this.#park(ctx, run, {
      reason: "by-maintainer",
      detail: `PR #${stored.number} closed on GitHub`,
    });
  }

  async #park(
    ctx: StoryMergeContext,
    run: StoredRun,
    park: {
      readonly reason: "conflict" | "by-maintainer";
      readonly detail: string;
    },
  ): Promise<void> {
    const deps = this.#deps.park;
    if (deps === undefined) {
      ctx.write(() => [
        notice(
          "warn",
          STORY_MERGE_NOTICES.failed,
          `${run.story} should park ${park.reason}: ${park.detail}. This daemon cannot park it.`,
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
        { run, reason: park.reason, detail: park.detail },
      );
    } catch (error) {
      ctx.logger?.warn("parking a story from the auto-merge failed", {
        run: run.runId,
        reason: messageOf(error),
      });
    }
  }
}

/**
 * Pure: true when the merge gate `gate` that holds for a head no longer fits the release paths the
 * head changes: it is no hand-merge-only gate and the head changes one (and the maintainer did not
 * reject it), or it is an open hand-merge-only gate and the head changes none.
 */
function gateOutdated(gate: StoredMergeGate, release: readonly string[]): boolean {
  if (release.length > 0) {
    return gate.handMerge === null && gate.decision?.decision !== "rejected";
  }
  return gate.handMerge !== null && gate.decision === null;
}

/**
 * A push that reached the remote, on the story's live claim (every story-branch push sets
 * `claims.pushed_at`). An unchanged branch or a failed push records nothing here.
 */
function recordPush(
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
