// `work.resume { story, note? }` (0005 section 4, DIPO-61, DIPO-138): the command of the
// resumption module. It works out the reason the story stands still, asks the policy table
// (`resume-policy.ts`) whether `work.resume` resumes that reason, and dispatches on the row. In M0
// the only `work.resume` row is `plan-limit`, which the plan-limit schedule resumes at once
// (`PlanLimits.resumeNow`); every other reason, a park included, answers `story.notPausedOrParked`.
// The park `on-hold` (DIPO-160) is the exception: it has no run, and its row hands the story to the
// planning lane (`HoldResumer`), which removes F16 and sets `park.from`.

import {
  type Lifecycle,
  type OfficeId,
  type RunId,
  workResume,
} from "@dipsaus-orchestrator/contract";
import type { z } from "zod";

import { CommandError } from "../commands/errors";
import type {
  AsyncCommandContext,
  CommandOutcome,
  FeatureModule,
  FeatureRegistry,
} from "../commands/registry";
import type { OfficeHandle } from "../db/office";
import type { StoryIdentity } from "../stories/keys";

import { openWait } from "./outcome-types";
import { openPark } from "./park";
import { activeRuns, type StoredRun } from "./records";
import { resumeVia } from "./resume-policy";

/** `work.resume` on a story with no run it can resume (0005 section 4). */
export const NOT_PAUSED_OR_PARKED = "story.notPausedOrParked";
/** `work.resume` while the held worker has not exited (0005 section 10, retryable). */
export const RUN_HOST_ALIVE = "run.hostAlive";

/** What answers `resumeWait`. */
export type ResumeWaitOutcome = "started" | "failed" | "notHeld" | "busy";

/** The plan-limit schedule as `work.resume` uses it (`PlanLimits.resumeNow`). */
export interface HeldRunResumer {
  resumeNow(office: OfficeId, run: RunId): Promise<ResumeWaitOutcome>;
}

/** The planning lane's resume of an on-hold park (`StoryPlanning.resumeHold`). */
export interface HoldResumer {
  resumeHold(
    ctx: AsyncCommandContext,
    identity: StoryIdentity,
    park: { readonly parkId: number; readonly from: string; readonly detail: string },
    note: string | undefined,
  ): Promise<Lifecycle>;
}

type ResumeArgs = z.output<typeof workResume.args>;
type ResumeResult = z.input<typeof workResume.result>;

/** Why a story stands still: its open park's reason, `plan-limit` for a held run, or none. */
interface Standing {
  readonly reason: string | null;
  /** The story's active run held by a plan limit, when it has one. */
  readonly held: StoredRun | null;
}

export class WorkResumeCommand {
  /** The plan-limit schedule; read when needed, since it is built after this. */
  readonly #planLimits: () => HeldRunResumer | undefined;

  /** The planning lane's hold resume; read when needed, since it is built after this. */
  readonly #holds: () => HoldResumer | undefined;

  constructor(
    planLimits: () => HeldRunResumer | undefined = () => undefined,
    holds: () => HoldResumer | undefined = () => undefined,
  ) {
    this.#planLimits = planLimits;
    this.#holds = holds;
  }

  /** `work.resume` for held runs; read by the plan-limit schedule's feature. */
  get feature(): FeatureModule {
    return {
      name: "resumption",
      register: (registry: FeatureRegistry) => {
        registry.addAsyncOfficeCommand({
          definition: workResume,
          handle: (ctx, args) => this.run(ctx, args),
        });
      },
    };
  }

  /**
   * `work.resume { story, note? }`: the policy table decides. The story's reason is its open
   * park's when it is parked, `plan-limit` when its active run holds an open wait, else none; a
   * reason whose row is not `work.resume` (a park, whose own way back is its row's command, or
   * none) fails `story.notPausedOrParked`. A held run is resumed at once, a `credits` hold on the
   * adapter is lifted, and the result names the run; a held worker that has not exited yet fails
   * the retryable `run.hostAlive`.
   */
  async run(ctx: AsyncCommandContext, args: ResumeArgs): Promise<CommandOutcome<ResumeResult>> {
    const handle = ctx.office;
    const identity = ctx.stories.get(args.story);
    if (identity === undefined) throw new Error(`${args.story} was not resolved`);
    const notHeld = () =>
      new CommandError(
        NOT_PAUSED_OR_PARKED,
        `${identity.story} has no run held by a plan limit; work.resume continues only those for now.`,
        { story: identity.story },
      );
    const standing = standingOf(handle, identity.key);
    if (standing.reason === null || resumeVia(standing.reason) !== "work.resume") throw notHeld();
    switch (standing.reason) {
      case "plan-limit":
        if (standing.held === null) throw notHeld();
        return await this.#resumeHeld(handle, identity, standing.held, notHeld);
      case "on-hold":
        return await this.#resumeHold(ctx, identity, args.note, notHeld);
      default:
        throw notHeld();
    }
  }

  /** The `on-hold` row: the planning lane lifts the hold; the story returns to `park.from`. */
  async #resumeHold(
    ctx: AsyncCommandContext,
    identity: StoryIdentity,
    note: string | undefined,
    notHeld: () => CommandError,
  ): Promise<CommandOutcome<ResumeResult>> {
    const holds = this.#holds();
    if (holds === undefined) {
      throw new Error(
        `work.resume of ${identity.story} needs the planning lane, and this office has none`,
      );
    }
    const park = openPark(ctx.office, identity.key);
    if (park === null || park.reason !== "on-hold") throw notHeld();
    const to = await holds.resumeHold(ctx, identity, park, note);
    return { result: { story: identity.story, key: identity.key, to } };
  }

  /** The `plan-limit` row: the schedule resumes the held run now. */
  async #resumeHeld(
    handle: OfficeHandle,
    identity: StoryIdentity,
    run: StoredRun,
    notHeld: () => CommandError,
  ): Promise<CommandOutcome<ResumeResult>> {
    const planLimits = this.#planLimits();
    if (planLimits === undefined) {
      throw new Error(
        `work.resume of ${identity.story} needs the plan-limit schedule, and this office has none`,
      );
    }
    const outcome = await planLimits.resumeNow(handle.officeId, run.runId);
    switch (outcome) {
      case "notHeld":
        throw notHeld();
      case "busy":
        throw new CommandError(
          RUN_HOST_ALIVE,
          `${identity.story}'s held worker has not exited yet; send work.resume again in a moment.`,
          { story: identity.story, run: run.runId },
        );
      case "started":
        return {
          result: {
            story: identity.story,
            key: identity.key,
            to: "In Progress",
            run: run.runId,
          },
        };
      case "failed":
        return {
          result: {
            story: identity.story,
            key: identity.key,
            to: afterFailure(handle, run.runId),
          },
        };
    }
  }
}

/**
 * Why the story `key` stands still. A park ends its run, so a story is parked when it has an open
 * park and no active run; one whose active run holds an open wait stands under `plan-limit`.
 */
function standingOf(handle: OfficeHandle, key: string): Standing {
  const run = activeRuns(handle).find(
    (candidate) => candidate.kind === "story" && candidate.key === key,
  );
  if (run === undefined) return { reason: openPark(handle, key)?.reason ?? null, held: null };
  return openWait(handle, run.runId) === null
    ? { reason: null, held: null }
    : { reason: "plan-limit", held: run };
}

/** Where the story is after a resume that did not start: parked, else released to Ready. */
function afterFailure(handle: OfficeHandle, runId: RunId): Lifecycle {
  const parked = handle.get(
    "select 1 as found from parks where office_id = $office_id and run_id = $run",
    { run: runId },
  );
  return parked === null ? "Ready" : "Parked";
}
