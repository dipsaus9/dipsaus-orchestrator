// `gate.approve` and `gate.reject` on merge gates (0019 section 11; DIPO-151, combined into
// DIPO-150). Both answer `gate.notWaitingOnMaintainer` for a gate that waits for no maintainer: a
// gate decided by rule, one decided already, or a gate that is not a merge gate.
//
// - `gate.approve { gate, note? }` decides the merge gate `approved` by `maintainer`, and the PR
//   enters the merge slot at the slot's next tick (a hold label still holds it). On a PR labelled
//   `autorelease: pending` it answers `gate.handMergeOnly`: a hand merge on GitHub is the only way.
// - On the override gate of a story parked `review-blocked`, `gate.approve` needs a note
//   (`gate.noteRequired` without one) and records a maintainer override of the blocked verdict: the
//   gate decided by the maintainer with the note, the verdict marked overridden, an `override` run
//   step, the park resolved as `override` (0020 section 15), and the story back In Review with no
//   session: the park is lifted on the branch (`<ID>: status In Review`) and the run waits as
//   reviewed. Its PR then goes through its required checks and the merge slot; the override gate
//   is its merge decision.
// - `gate.reject { gate, note }` (`confirm: true`) decides the gate `rejected` by the maintainer
//   and starts a fix round with the note as its one item (`FixRounds.reject`, DIPO-148). For a
//   flagged story this is the failed test until M1b's `test.record` takes over. Rejecting an
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
import type { PrReviewHost } from "../platform/host";
import { recordReviewOverride } from "../review/store";
import { openPark, type UnparkWriter } from "../run/park";
import { appendRunStep, findRun, REVIEWED_END, type StoredRun } from "../run/records";
import { findStoryPr } from "../story-pr/records";
import { deriveStoryView, storyView } from "../views/story";
import { withWorkViews } from "../views/work";

import { autoreleasePending, decideMergeGate, mergeGate, type StoredMergeGate } from "./gates";
import { repoOfPrUrl } from "./story-slot";

type ApproveArgs = z.output<typeof gateApprove.args>;
type RejectArgs = z.output<typeof gateReject.args>;

export interface MergeGatesDeps {
  /** The PR's labels, for the `autorelease: pending` answer. */
  readonly labels: Pick<PrReviewHost, "prLabels">;
  /** Lifts the park on the story branch (`gitUnparkWriter`). */
  readonly unpark: UnparkWriter;
  /** Starts the fix round of a maintainer reject (`FixRounds.reject`). */
  readonly reject?: (
    office: OfficeId,
    runId: RunId,
    reject: { readonly gateId: string; readonly note: string },
  ) => Promise<boolean>;
  /** Lets the merge slot act on a decision at once (`MergeSlot.kick`). */
  readonly kick?: (office: OfficeId) => void;
  /** Updates the story PR to the branch's pushed head after the override's status commit. */
  readonly prSync?: (office: OfficeId, runId: RunId) => Promise<void>;
  /** Reads the story again at its branch tip after the override's status commit. */
  readonly refreshStory?: (office: OfficeId, key: StoryKey) => Promise<unknown>;
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
      name: "merge-slot/gates",
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
    const note = args.note?.trim() ?? "";
    if (gate.overrideOf !== null) {
      await this.#override(ctx, gate, run, note);
    } else {
      const pr = findStoryPr(office, run.runId);
      const repo = pr === null ? null : repoOfPrUrl(pr.url);
      if (pr !== null && repo !== null) {
        const labels = await this.#deps.labels.prLabels(repo, pr.number);
        if (autoreleasePending(labels)) {
          throw new CommandError(
            "gate.handMergeOnly",
            `PR #${pr.number} carries "autorelease: pending", which dipo never merges: merge it by hand on GitHub.`,
            { gate: gate.gate, pr: pr.number },
          );
        }
      }
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
    // The branch first: the park lifted and the status back to In Review, pushed.
    await this.#deps.unpark.lift(officeId, {
      story: run.story as string,
      branch: run.branch,
      worktree: run.worktree,
      to: "In Review",
    });
    ctx.commit(() => {
      const decided = decideMergeGate(office, gate.gate, {
        decision: "approved",
        by: "maintainer",
        note,
        at: ctx.now,
      });
      if (decided.length === 0) throw notWaiting(gate.gate, "it was decided meanwhile");
      recordReviewOverride(office, gate.overrideOf as GateId, { note, at: ctx.now });
      appendRunStep(office, run.runId, "override", gate.overrideOf as string, ctx.now);
      office.run(
        `update parks set resolved_at = $at, resolved_how = 'override'
          where office_id = $office_id and park_id = $park and resolved_at is null`,
        { at: ctx.now, park: park.parkId },
      );
      // In Review with no session: the run waits as reviewed, for its checks and the merge slot.
      office.run(
        `update runs set end_kind = $reviewed where office_id = $office_id and run_id = $run`,
        { reviewed: REVIEWED_END, run: run.runId },
      );
      return withWorkViews(office, [...decided, ...inReviewEntries(office, run, note)]);
    });
    await this.#deps.refreshStory?.(officeId, run.key as StoryKey).catch(() => undefined);
    await this.#deps.prSync?.(officeId, run.runId).catch(() => undefined);
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
