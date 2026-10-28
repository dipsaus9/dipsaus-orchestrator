// Backlog PRs and GitHub's auto-merge (0010 planning lane, 0002). The office's auto-merge poll
// (`merger.ts`) runs this module at each round, after the story PRs, for each open backlog PR:
//
// - Auto-merge on. A backlog PR whose structural check (`BacklogPrs`) passed on the branch's local
//   head, which GitHub shows as the PR's head, with no hold label (`autorelease: pending` always, and
//   `mergeSlot.holdLabels`), no conflict and no failed required check, gets
//   `gh pr merge --auto --squash --match-head-commit <head>`. GitHub merges it once its required
//   checks pass on that head. dipo never passes `--admin`.
// - The lane holds. While auto-merge is on for its PR, the lane leaves the branch alone (`holding`):
//   new operations stay journaled, so the head GitHub merges is the one the check passed on.
// - Auto-merge off. While it is on, each round reads the PR again. A head dipo did not push, a hold
//   label, a conflict, a failed required check or a check that no longer passes on the head turns
//   it off (`gh pr merge --disable-auto`), with a notice; the lane then applies what it held, and a
//   conflict rebuilds the branch from the journal on a new branch, whose new PR replaces this one.
//   A failed `--disable-auto` is a notice, and the next round tries again.
// - Merged. A PR GitHub merged at the head whose check passed: its journal entries whose commit is
//   in that head are merged, its record is closed as merged, the blocks it fixed are cleared, its
//   branch is deleted, and the lane applies what it held on a new branch. A PR merged at any other
//   head (a merge by hand) is left to `BacklogPrs`, which checks it again (0010).

import type { OfficeId, StoryKey } from "@dipsaus-orchestrator/contract";

import { openEntries, updateEntry } from "../backlog/lane/journal";
import type { OfficeLane } from "../backlog/lane/lane";
import { repoOfUrl } from "../backlog/pr/feature";
import {
  type BacklogPrRecord,
  clearBlocks,
  closePrRecord,
  findPr,
  openPrs,
} from "../backlog/pr/records";
import type { NewEntry } from "../changelog/log";
import type { OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import type { Logger } from "../log/logger";
import {
  type AutoMergeHost,
  type CodeHost,
  CodeHostError,
  type HostPr,
  type PrReviewHost,
} from "../platform/host";
import type { PrStateReads } from "../platform/pr-state";

import type { BacklogMergeGit } from "./backlog-git";
import { autoreleasePending, holdLabelsOn } from "./gates";

/** `engine.notice` codes of backlog PRs and the auto-merge. */
export const BACKLOG_MERGE_NOTICES = {
  autoMergeOn: "merge.autoMergeOn",
  autoMergeOff: "merge.autoMergeOff",
  autoMergeFailed: "merge.autoMergeFailed",
  merged: "merge.merged",
  held: "merge.held",
  rebuilt: "merge.rebuilt",
  headChanged: "pr.headChanged",
  checksFailed: "merge.checksFailed",
} as const;

/** What the backlog PRs' auto-merge needs. */
export interface BacklogMergeDeps {
  readonly host: Pick<AutoMergeHost, "enableAutoMerge" | "disableAutoMerge"> &
    Pick<CodeHost, "requiredChecks">;
  /** A backlog PR's labels; without it labels are not read (tests). */
  readonly labels?: Pick<PrReviewHost, "prLabels">;
}

/** What a round of the poll gives this module. */
export interface BacklogMergeContext {
  readonly officeId: OfficeId;
  readonly office: OfficeHandle;
  readonly lane: OfficeLane;
  readonly git: BacklogMergeGit;
  readonly reads: Pick<PrStateReads, "viewPr" | "invalidate">;
  readonly now: () => number;
  readonly config: OfficeConfig;
  /** The office's backlog PRs with auto-merge on, as the last round read them. */
  readonly armed: Set<number>;
  once(subject: string, code: string, value: string, make: () => NewEntry): void;
  write(fn: () => readonly NewEntry[]): void;
  readonly logger?: Logger;
}

/** One open backlog PR, its repository, its local head and its state on GitHub. */
interface Pr {
  readonly record: BacklogPrRecord;
  readonly repo: string;
  readonly head: string;
  readonly view: HostPr;
}

/** Why auto-merge goes off for a backlog PR. */
type Stop = "foreignHead" | "held" | "conflict" | "checksFailed" | "unchecked";

const STOP_TEXT: Record<Stop, string> = {
  foreignHead: "its head on GitHub is not the one dipo pushed",
  held: "it carries a hold label",
  conflict: "GitHub reports that the base conflicts with it; dipo rebuilds it on a new branch",
  checksFailed: "a required check failed",
  unchecked: "the structural check does not pass on its head",
};

function notice(level: "info" | "warn" | "error", code: string, text: string): NewEntry {
  return { type: "engine.notice", delta: { level, code, text } };
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** True when the record's structural check passed on `head`. */
const passedOn = (record: BacklogPrRecord, head: string): boolean =>
  record.check === "passed" && record.checkedHead === head;

export class BacklogMerges {
  readonly #deps: BacklogMergeDeps;

  constructor(deps: BacklogMergeDeps) {
    this.#deps = deps;
  }

  /** One round over the office's open backlog PRs (see the file comment). */
  async tick(ctx: BacklogMergeContext): Promise<void> {
    for (const record of openPrs(ctx.office)) {
      try {
        await this.#pr(ctx, record);
      } catch (error) {
        ctx.logger?.warn("the auto-merge of a backlog PR failed", {
          office: ctx.officeId,
          pr: record.number,
          reason: messageOf(error),
        });
      }
    }
  }

  async #pr(ctx: BacklogMergeContext, record: BacklogPrRecord): Promise<void> {
    const repo = repoOfUrl(record.url);
    const head = repo === null ? null : await ctx.git.head(record.branch);
    if (repo === null || head === null) return;
    let view: HostPr;
    try {
      view = await ctx.reads.viewPr(repo, record.number);
    } catch (error) {
      if (error instanceof CodeHostError) return;
      throw error;
    }
    if (view.autoMerge === true && view.state === "open") ctx.armed.add(record.number);
    else ctx.armed.delete(record.number);
    if (view.state === "merged") return this.#merged(ctx, { record, repo, head, view });
    if (view.state !== "open") return;
    const pr: Pr = { record, repo, head, view };
    return view.autoMerge === true ? this.#watch(ctx, pr) : this.#arm(ctx, pr);
  }

  /** Why auto-merge must go off now, or null; the same facts keep it off. */
  async #stopOf(ctx: BacklogMergeContext, pr: Pr): Promise<Stop | null> {
    if (pr.view.headSha !== "" && pr.view.headSha !== pr.head) return "foreignHead";
    if ((await this.#heldBy(ctx, pr)).length > 0) return "held";
    if (pr.view.mergeable === "conflicting") return "conflict";
    if (!passedOn(pr.record, pr.head)) return "unchecked";
    const checks = await this.#deps.host.requiredChecks(pr.repo, pr.record.number);
    if (checks.some((check) => check.bucket === "fail" || check.bucket === "cancel")) {
      return "checksFailed";
    }
    return null;
  }

  async #heldBy(ctx: BacklogMergeContext, pr: Pr): Promise<string[]> {
    const host = this.#deps.labels;
    if (host === undefined) return [];
    const labels = await host.prLabels(pr.repo, pr.record.number);
    return holdLabelsOn(labels, ctx.config.mergeSlot.holdLabels);
  }

  /** Auto-merge on for a PR whose check passed on its head, unless something stops it. */
  async #arm(ctx: BacklogMergeContext, pr: Pr): Promise<void> {
    if (!passedOn(pr.record, pr.head)) return;
    let stop: Stop | null;
    try {
      stop = await this.#stopOf(ctx, pr);
    } catch (error) {
      if (error instanceof CodeHostError) return;
      throw error;
    }
    if (stop !== null) return this.#keptOff(ctx, pr, stop);
    const number = pr.record.number;
    try {
      await this.#deps.host.enableAutoMerge(pr.repo, number, {
        headSha: pr.head,
        subject: pr.record.title,
      });
    } catch (error) {
      if (!(error instanceof CodeHostError)) throw error;
      ctx.once(`${number}`, BACKLOG_MERGE_NOTICES.autoMergeFailed, error.message, () =>
        notice(
          "warn",
          BACKLOG_MERGE_NOTICES.autoMergeFailed,
          `dipo could not turn auto-merge on for the backlog PR #${number}: ${error.message} It tries again at the next poll.`,
        ),
      );
      return;
    }
    ctx.armed.add(number);
    ctx.reads.invalidate?.(pr.repo, number);
    ctx.write(() => [
      notice(
        "info",
        BACKLOG_MERGE_NOTICES.autoMergeOn,
        `dipo turned auto-merge on for the backlog PR #${number} at ${pr.head.slice(0, 12)} after its structural check passed; new backlog changes wait until it merges.`,
      ),
    ]);
  }

  /** What keeps auto-merge off for a PR, told once per head and cause; a conflict rebuilds. */
  async #keptOff(ctx: BacklogMergeContext, pr: Pr, stop: Stop): Promise<void> {
    const number = pr.record.number;
    if (stop === "conflict") return this.#rebuild(ctx, pr);
    if (stop === "unchecked") return;
    let text = `The backlog PR #${number} gets no auto-merge: ${STOP_TEXT[stop]}.`;
    if (stop === "held") {
      const held = await this.#heldBy(ctx, pr);
      text = autoreleasePending(held)
        ? `The backlog PR #${number} carries "autorelease: pending", so dipo never merges it; merge it by hand on GitHub.`
        : `The backlog PR #${number} carries the hold label ${held.map((label) => `"${label}"`).join(", ")}; dipo turns auto-merge on once the label is gone.`;
    }
    const code =
      stop === "held"
        ? BACKLOG_MERGE_NOTICES.held
        : stop === "foreignHead"
          ? BACKLOG_MERGE_NOTICES.headChanged
          : BACKLOG_MERGE_NOTICES.checksFailed;
    ctx.once(`${number}`, code, `${pr.head}:${stop}`, () => notice("info", code, text));
  }

  /** The branch conflicts with the base: the lane rebuilds it on a new branch with a new PR. */
  async #rebuild(ctx: BacklogMergeContext, pr: Pr): Promise<void> {
    const number = pr.record.number;
    ctx.write(() => [
      notice(
        "info",
        BACKLOG_MERGE_NOTICES.rebuilt,
        `The backlog PR #${number} conflicts with the base; dipo rebuilds its operations from the journal on a new branch, opens a new PR and closes #${number}.`,
      ),
    ]);
    // The flush puts its own notice on the office when it fails.
    await ctx.lane.flush({ rebuild: pr.record.branch }).catch(() => undefined);
  }

  /** Auto-merge off when something stops the merge, then the lane applies what it held. */
  async #watch(ctx: BacklogMergeContext, pr: Pr): Promise<void> {
    let stop: Stop | null;
    try {
      stop = await this.#stopOf(ctx, pr);
    } catch (error) {
      if (error instanceof CodeHostError) return;
      throw error;
    }
    if (stop === null) return;
    const number = pr.record.number;
    try {
      await this.#deps.host.disableAutoMerge(pr.repo, number);
    } catch (error) {
      if (!(error instanceof CodeHostError)) throw error;
      ctx.once(`${number}`, BACKLOG_MERGE_NOTICES.autoMergeFailed, error.message, () =>
        notice(
          "error",
          BACKLOG_MERGE_NOTICES.autoMergeFailed,
          `dipo must turn auto-merge off for the backlog PR #${number} (${STOP_TEXT[stop]}), but GitHub refused: ${error.message} It tries again at the next poll.`,
        ),
      );
      return;
    }
    ctx.armed.delete(number);
    ctx.reads.invalidate?.(pr.repo, number);
    ctx.write(() => [
      notice(
        "warn",
        BACKLOG_MERGE_NOTICES.autoMergeOff,
        `dipo turned auto-merge off for the backlog PR #${number}: ${STOP_TEXT[stop]}.`,
      ),
    ]);
    if (stop === "conflict") return this.#rebuild(ctx, pr);
    await this.#flush(ctx);
  }

  /**
   * GitHub merged the PR. At the head whose check passed: the journal entries in it merged, the
   * record closed as merged, the blocks it fixed cleared, the branch deleted, and the lane applies
   * what it held. At another head it is a merge by hand, which `BacklogPrs` checks again.
   */
  async #merged(ctx: BacklogMergeContext, pr: Pr): Promise<void> {
    const head = pr.view.headSha === "" ? pr.head : pr.view.headSha;
    if (!passedOn(pr.record, head)) return;
    const number = pr.record.number;
    const merged: number[] = [];
    for (const entry of openEntries(ctx.office)) {
      if (entry.branch !== pr.record.branch || entry.commit === null) continue;
      if (await ctx.git.inHead(entry.commit, head)) merged.push(entry.opId);
    }
    const now = ctx.now();
    ctx.write(() => {
      for (const opId of merged) updateEntry(ctx.office, opId, { state: "merged" }, now);
      const touched: readonly StoryKey[] = findPr(ctx.office, number)?.touched ?? [];
      clearBlocks(ctx.office, number, touched, now);
      closePrRecord(ctx.office, number, "merged", now);
      return [
        notice(
          "info",
          BACKLOG_MERGE_NOTICES.merged,
          `GitHub merged the backlog PR #${number} at ${head.slice(0, 12)} after its required checks and the structural check passed.`,
        ),
      ];
    });
    const problem = await ctx.git.deleteBranch(pr.record.branch).catch(messageOf);
    if (problem !== null) {
      ctx.logger?.warn("the merged backlog branch could not be deleted", {
        office: ctx.officeId,
        branch: pr.record.branch,
        reason: problem,
      });
    }
    // An operation left out still names the deleted branch: the flush applies it on a new branch.
    await ctx.lane.flush().catch(() => undefined);
  }

  /** The lane applies the operations it held, when there are any. */
  async #flush(ctx: BacklogMergeContext): Promise<void> {
    if (!openEntries(ctx.office).some((entry) => entry.state === "pending")) return;
    // The flush puts its own notice on the office when it fails.
    await ctx.lane.flush().catch(() => undefined);
  }
}
