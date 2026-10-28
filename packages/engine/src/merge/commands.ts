// `gate.approve` and `gate.reject` on merge gates (0002). Both answer `gate.notWaitingOnMaintainer`
// for a gate that waits for no maintainer: a gate decided by rule, one decided already, a gate that
// is not a merge gate, or one that no longer holds for the story PR's head (the PR moved since it
// opened, and its verdict did not carry).
//
// - `gate.approve { gate, note? }` decides the merge gate `approved` by `maintainer`, and dipo
//   turns auto-merge on for the PR at its next poll (a hold label still holds it). It answers
//   `gate.handMergeOnly`, and decides nothing, when only a hand merge on GitHub can merge the PR:
//   a PR labelled `autorelease: pending`, a PR whose diff changes the release path (it needs the
//   maintainer's code owner approval, which is the maintainer's merge on the host), and a PR whose
//   head on GitHub is one dipo did not push.
// - On the override gate of a story parked `review-blocked`, `gate.approve` needs a note
//   (`gate.noteRequired` without one) and records a maintainer override of the blocked verdict: the
//   gate decided by the maintainer with the note, the verdict marked overridden, an `override` run
//   step, the park resolved as `override` (0020), and the story back In Review with no session: the
//   park is lifted on the branch (`<ID>: status In Review`) and the run waits as reviewed. Its PR
//   then goes through its required checks and the auto-merge; the override gate is its merge
//   decision. The gate is checked undecided right before the lift; when the record fails after the
//   lift, the park is put back on the branch (or the failure says it could not be).
// - `gate.reject { gate, note }` (`confirm: true`) decides the gate `rejected` by the maintainer
//   and starts a fix round with the note as its one item (`FixRounds.reject`). Rejecting an
//   override gate leaves the story parked.

import {
  gateApprove,
  type GateId,
  gateReject,
  type OfficeId,
  type RunId,
  StoryId,
  type StoryKey,
} from "@dipsaus-orchestrator/contract";
import type { z } from "zod";

import type { NewEntry } from "../changelog/log";
import { CommandError } from "../commands/errors";
import type { AsyncCommandContext, CommandOutcome, FeatureModule } from "../commands/registry";
import type { OfficeHandle } from "../db/office";
import type { CodeHost, PrReviewHost } from "../platform/host";
import { recordReviewOverride } from "../review/store";
import { openPark, type ParkWriter, resolvePark, type UnparkWriter } from "../run/park";
import { mirrorUnpark } from "../run/park-state";
import {
  appendRunStep,
  applyRunEvent,
  findRun,
  REVIEWED_END,
  type StoredRun,
} from "../run/records";
import { type BranchPush, findStoryPr, recordBranchPush } from "../story-pr/records";
import { deriveStoryView, storyView } from "../views/story";
import { withWorkViews } from "../views/work";
import { repoOfPrUrl } from "../worktree/release";

import { autoreleasePending, decideMergeGate, mergeGate, type StoredMergeGate } from "./gates";

type ApproveArgs = z.output<typeof gateApprove.args>;
type RejectArgs = z.output<typeof gateReject.args>;

export interface MergeGatesDeps {
  /** The PR's labels, for the `autorelease: pending` answer. */
  readonly labels: Pick<PrReviewHost, "prLabels">;
  /** The PR on GitHub, for the answer to a head dipo did not push; not read without it. */
  readonly view?: Pick<CodeHost, "viewPr">;
  /** Lifts the park on the story branch (`gitUnparkWriter`). */
  readonly unpark: UnparkWriter;
  /** Starts the fix round of a maintainer reject (`FixRounds.reject`). */
  readonly reject?: (
    office: OfficeId,
    runId: RunId,
    reject: { readonly gateId: string; readonly note: string },
  ) => Promise<boolean>;
  /** Lets the auto-merge act on a decision at once (`AutoMerge.kick`). */
  readonly kick?: (office: OfficeId) => void;
  /** Updates the story PR to the branch's pushed head after the override's status commit. */
  readonly prSync?: (office: OfficeId, runId: RunId) => Promise<void>;
  /** Reads the story again at its branch tip after the override's status commit. */
  readonly refreshStory?: (office: OfficeId, key: StoryKey) => Promise<unknown>;
  /**
   * True when `gate` holds for the story PR's head `head` (`AutoMerge.gateHolds`: its own head,
   * or a head its verdict carried to); by default only its own head.
   */
  readonly holds?: (office: OfficeHandle, gate: StoredMergeGate, head: string) => Promise<boolean>;
  /**
   * Puts the park back on the story branch when the override's record failed after the park was
   * lifted (`gitParkWriter`); without it that failure is only reported.
   */
  readonly repark?: ParkWriter;
}

function notWaiting(gate: string, why: string): CommandError {
  return new CommandError(
    "gate.notWaitingOnMaintainer",
    `The gate ${gate} does not wait for the maintainer: ${why}.`,
    { gate },
  );
}

export class MergeGates {
  readonly #deps: MergeGatesDeps;

  constructor(deps: MergeGatesDeps) {
    this.#deps = deps;
  }

  /** `gate.approve` and `gate.reject` on the waiting command path. */
  get feature(): FeatureModule {
    return {
      name: "merge/gates",
      register: (registry) => {
        registry.addAsyncOfficeCommand({
          definition: gateApprove,
          handle: (ctx, args) => this.approve(ctx, args),
        });
        registry.addAsyncOfficeCommand({
          definition: gateReject,
          handle: (ctx, args) => this.reject(ctx, args),
        });
      },
    };
  }

  async approve(
    ctx: AsyncCommandContext,
    args: ApproveArgs,
  ): Promise<CommandOutcome<{ gate: GateId; decision: "approved" }>> {
    const office = ctx.office;
    const officeId = office.officeId as OfficeId;
    const { gate, run } = this.#waiting(office, args.gate);
    await this.#forPrHead(office, gate, run);
    const note = args.note?.trim() ?? "";
    if (gate.overrideOf !== null) {
      await this.#override(ctx, gate, run, note);
    } else {
      const pr = findStoryPr(office, run.runId);
      if (gate.handMerge !== null) {
        const which = pr === null ? "Its PR" : `PR #${pr.number}`;
        throw new CommandError(
          "gate.handMergeOnly",
          `${which} changes the release path, which needs the maintainer's code owner approval, so dipo never merges it: merge it by hand on GitHub, which closes the gate.`,
          { gate: gate.gate, ...(pr === null ? {} : { pr: pr.number }) },
        );
      }
      if (pr !== null) await this.#mergeableByDipo(gate, pr);
      ctx.commit(() => {
        const entries = decideMergeGate(office, gate.gate, {
          decision: "approved",
          by: "maintainer",
          note: note === "" ? null : note,
          at: ctx.now,
        });
        if (entries.length === 0) throw notWaiting(gate.gate, "it was decided meanwhile");
        return withWorkViews(office, entries);
      });
    }
    this.#deps.kick?.(officeId);
    return { result: { gate: gate.gate, decision: "approved" } };
  }

  async reject(
    ctx: AsyncCommandContext,
    args: RejectArgs,
  ): Promise<CommandOutcome<{ gate: GateId; decision: "rejected" }>> {
    const office = ctx.office;
    const officeId = office.officeId as OfficeId;
    const { gate, run } = this.#waiting(office, args.gate);
    await this.#forPrHead(office, gate, run);
    const note = args.note.trim();
    if (note === "") {
      throw new CommandError("gate.noteRequired", "A reject needs a note for the worker.", {
        gate: gate.gate,
      });
    }
    ctx.commit(() => {
      const entries = decideMergeGate(office, gate.gate, {
        decision: "rejected",
        by: "maintainer",
        note,
        at: ctx.now,
      });
      if (entries.length === 0) throw notWaiting(gate.gate, "it was decided meanwhile");
      return withWorkViews(office, entries);
    });
    // The note goes to the worker in a fix round; an override declined leaves the story parked.
    if (gate.overrideOf === null) {
      await this.#deps.reject?.(officeId, run.runId, { gateId: gate.gate, note });
    }
    return { result: { gate: gate.gate, decision: "rejected" } };
  }

  /**
   * Throws `gate.handMergeOnly` when only a hand merge on GitHub can merge the PR: it carries
   * `autorelease: pending`, or its head on GitHub is one dipo did not push.
   */
  async #mergeableByDipo(
    gate: StoredMergeGate,
    pr: { readonly number: number; readonly url: string; readonly headSha: string },
  ): Promise<void> {
    const repo = repoOfPrUrl(pr.url);
    if (repo === null) return;
    const handOnly = (why: string): CommandError =>
      new CommandError(
        "gate.handMergeOnly",
        `PR #${pr.number} ${why}: merge it by hand on GitHub.`,
        {
          gate: gate.gate,
          pr: pr.number,
        },
      );
    const labels = await this.#deps.labels.prLabels(repo, pr.number);
    if (autoreleasePending(labels)) {
      throw handOnly(`carries "autorelease: pending", which dipo never merges`);
    }
    const viewed = await this.#deps.view?.viewPr(repo, pr.number);
    if (viewed?.state === "open" && viewed.headSha !== "" && viewed.headSha !== pr.headSha) {
      throw handOnly(
        `is at ${viewed.headSha.slice(0, 12)} on GitHub, a head dipo did not push and never merges`,
      );
    }
  }

  /** The open merge gate `id` that waits for the maintainer, with its story run; else throws. */
  #waiting(office: OfficeHandle, id: string): { gate: StoredMergeGate; run: StoredRun } {
    const gate = mergeGate(office, id);
    if (gate === null) throw notWaiting(id, "it is not a merge gate of this office");
    if (gate.waitingOn !== "maintainer") throw notWaiting(id, "it is decided by rule");
    if (gate.decision !== null) {
      throw notWaiting(id, `it was decided ${gate.decision.decision} by ${gate.decision.by}`);
    }
    const run = findRun(office, gate.runId);
    if (run === null || run.story === null || run.key === null) {
      throw notWaiting(id, "its story run is gone");
    }
    return { gate, run };
  }

  /**
   * Refuses a decision on a gate that no longer holds for the story PR's head: someone or a fix
   * round moved the PR since the gate opened, so the maintainer would decide about another head.
   */
  async #forPrHead(office: OfficeHandle, gate: StoredMergeGate, run: StoredRun): Promise<void> {
    const head = findStoryPr(office, run.runId)?.headSha ?? null;
    if (head === null || head === gate.head) return;
    const holds = (await this.#deps.holds?.(office, gate, head).catch(() => false)) ?? false;
    if (!holds) {
      throw notWaiting(
        gate.gate,
        `it decides about ${gate.head.slice(0, 12)}, and the PR is at ${head.slice(0, 12)} now`,
      );
    }
  }

  /** The maintainer's override past a blocked review (see the file comment). */
  async #override(
    ctx: AsyncCommandContext,
    gate: StoredMergeGate,
    run: StoredRun,
    note: string,
  ): Promise<void> {
    const office = ctx.office;
    const officeId = office.officeId as OfficeId;
    if (note === "") {
      throw new CommandError(
        "gate.noteRequired",
        "Approving past a blocked review needs a note (`dipo approve <ID> --note <why>`); it is recorded as the override.",
        { gate: gate.gate },
      );
    }
    const park = openPark(office, run.key as string);
    if (park === null || park.reason !== "review-blocked") {
      throw notWaiting(gate.gate, "its story is no longer parked review-blocked");
    }
    if (run.branch === null || run.worktree === null) {
      throw notWaiting(gate.gate, "its story run has no branch or worktree");
    }
    // A park ends its run, so an open run here is a crash's or a hand-written park's leftover:
    // the override would record the decision and lift the park, but the run could not wait as
    // reviewed (`lifecycle.ts` refuses an open run).
    if ((findRun(office, run.runId) ?? run).endedAt === null) {
      throw notWaiting(gate.gate, "its story run is still open");
    }
    // Still undecided right before the branch changes: a decision meanwhile lifts nothing.
    if (mergeGate(office, gate.gate)?.decision !== null) {
      throw notWaiting(gate.gate, "it was decided meanwhile");
    }
    const branch = { story: run.story as string, branch: run.branch, worktree: run.worktree };
    // The branch first: the park lifted and the status back to In Review, pushed.
    const lifted = await this.#deps.unpark.lift(officeId, { ...branch, to: "In Review" });
    try {
      this.#recordOverride(ctx, {
        gate,
        run,
        note,
        parkId: park.parkId,
        push: { pushed: lifted.pushed, error: lifted.pushError },
      });
    } catch (error) {
      // The branch is In Review but the override is not recorded: put the park back, or say so.
      const reason = error instanceof Error ? error.message : String(error);
      let back = "this daemon cannot put the park back on the branch";
      if (this.#deps.repark !== undefined) {
        back = await this.#deps.repark
          .write(officeId, { ...branch, reason: "review-blocked", note: park.detail })
          .then(
            () => "dipo put the park back on the branch",
            (again: unknown) =>
              `putting the park back on the branch failed too (${again instanceof Error ? again.message : String(again)})`,
          );
      }
      throw new Error(
        `The override of ${run.story} was not recorded (${reason}) after its park was lifted on the branch; ${back}. Check the story's status before you approve again.`,
        { cause: error },
      );
    }
    await this.#deps.refreshStory?.(officeId, run.key as StoryKey).catch(() => undefined);
    await this.#deps.prSync?.(officeId, run.runId).catch(() => undefined);
  }

  /** In one transaction: the override's gate decision, verdict mark, run step, park and run. */
  #recordOverride(
    ctx: AsyncCommandContext,
    override: {
      readonly gate: StoredMergeGate;
      readonly run: StoredRun;
      readonly note: string;
      readonly parkId: number;
      readonly push: BranchPush;
    },
  ): void {
    const { gate, run, note, parkId, push } = override;
    const office = ctx.office;
    ctx.commit(() => {
      // The lift's push, on the claim like every story-branch push (DIPO-315).
      if (run.branch !== null) recordBranchPush(office, run.branch, push, ctx.now);
      const decided = decideMergeGate(office, gate.gate, {
        decision: "approved",
        by: "maintainer",
        note,
        at: ctx.now,
      });
      if (decided.length === 0) throw notWaiting(gate.gate, "it was decided meanwhile");
      recordReviewOverride(office, gate.overrideOf as GateId, { note, at: ctx.now });
      appendRunStep(office, run.runId, "override", gate.overrideOf as string, ctx.now);
      const closed = resolvePark(office, parkId, "override", ctx.now);
      // The lift read back In Review and no park record on the branch (DIPO-360).
      mirrorUnpark(office, run.key as string, "In Review");
      // In Review with no session: the run waits as reviewed, for its checks and the auto-merge.
      applyRunEvent(office, run.runId, { kind: "relabel", endKind: REVIEWED_END });
      return withWorkViews(office, [...decided, ...closed, ...inReviewEntries(office, run, note)]);
    });
  }
}

/** The story's `story.state` from Parked back to In Review after the override. */
function inReviewEntries(office: OfficeHandle, run: StoredRun, note: string): NewEntry[] {
  const key = run.key as StoryKey;
  const current = storyView(office, key);
  const view = deriveStoryView({
    key,
    story: current?.story ?? StoryId.parse(run.story),
    title: current?.title ?? "",
    lifecycle: "In Review",
    ...(current?.tier === undefined ? {} : { tier: current.tier }),
    ...(current?.pr === undefined ? {} : { pr: current.pr }),
  });
  return [
    {
      type: "story.state",
      key,
      run: run.runId,
      delta: {
        story: run.story as string,
        key,
        from: "Parked",
        to: "In Review",
        view,
        detail: [`approved past the blocked review by the maintainer: ${note}`],
      },
    },
  ];
}
