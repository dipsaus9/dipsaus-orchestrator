// `work.resume { story, note?, budget? }` (0005 section 4, DIPO-61, DIPO-138, DIPO-155): the
// command of the resumption module. It works out the reason the story stands still, asks the policy
// table (`resume-policy.ts`) whether `work.resume` resumes that reason, and dispatches on the row.
// `plan-limit` is resumed at once by the plan-limit schedule (`PlanLimits.resumeNow`); `paused`
// (DIPO-163) is a run the maintainer paused, continued by `PausedResumes`; the park `on-hold`
// (DIPO-160) has no run, and its row hands the story to the planning lane (`HoldResumer`), which
// removes F16 and sets `park.from`. Every other park goes to the park resume
// (`ParkResumes`, `park-resume.ts`), which follows the 0020 matrix row of its reason and cause,
// refusals included; a story standing still for nothing answers `story.notPausedOrParked`.

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
import { openPause } from "./pauses";
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

/** The resume of a parked story by its matrix row (`ParkResumes`, DIPO-155). */
export interface ParkResumer {
  resume(
    ctx: AsyncCommandContext,
    identity: StoryIdentity,
    park: NonNullable<ReturnType<typeof openPark>>,
    args: z.output<typeof workResume.args>,
  ): Promise<CommandOutcome<z.input<typeof workResume.result>>>;
  /**
   * A retry of a request whose park resume was stored (a crash before its reply): finished when it
   * was not, and replied with what it did; null when the request stored none.
   */
  replay(
    ctx: AsyncCommandContext,
    identity: StoryIdentity,
  ): Promise<CommandOutcome<z.input<typeof workResume.result>> | null>;
}

/** The maintainer-paused run's resume (`PausedResumes`, DIPO-163). */
export interface PausedResumer {
  resumePaused(
    ctx: AsyncCommandContext,
    identity: StoryIdentity,
    run: StoredRun,
    note: string | undefined,
  ): Promise<CommandOutcome<z.input<typeof workResume.result>>>;
}

type ResumeArgs = z.output<typeof workResume.args>;
type ResumeResult = z.input<typeof workResume.result>;

/**
 * Why a story stands still: its open park's reason, `paused` for a run the maintainer paused,
 * `plan-limit` for a held run, or none.
 */
interface Standing {
  readonly reason: string | null;
  /** The story's active run held by a plan limit or paused, when it has one. */
  readonly held: StoredRun | null;
}

export class WorkResumeCommand {
  /** The plan-limit schedule; read when needed, since it is built after this. */
  readonly #planLimits: () => HeldRunResumer | undefined;

  /** The planning lane's hold resume; read when needed, since it is built after this. */
  readonly #holds: () => HoldResumer | undefined;

  /** The resume of a maintainer-paused run. */
  readonly #paused: () => PausedResumer | undefined;

  /** The resume of a parked story by its matrix row. */
  readonly #parks: () => ParkResumer | undefined;

  constructor(
    planLimits: () => HeldRunResumer | undefined = () => undefined,
    holds: () => HoldResumer | undefined = () => undefined,
    paused: () => PausedResumer | undefined = () => undefined,
    parks: () => ParkResumer | undefined = () => undefined,
  ) {
    this.#planLimits = planLimits;
    this.#holds = holds;
    this.#paused = paused;
    this.#parks = parks;
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
        `${identity.story} is not paused, held by a plan limit or parked, so there is nothing to resume.`,
        { story: identity.story },
      );
    // A retry of a park resume this request stored repeats nothing (0005 note of 2026-10-17).
    const replayed = await this.#parks()?.replay(ctx, identity);
    if (replayed != null) return replayed;
    const standing = standingOf(handle, identity.key);
    // A parked story other than on-hold resumes by its matrix row (DIPO-155), refusals included.
    const parks = this.#parks();
    if (standing.held === null && standing.reason !== null && standing.reason !== "on-hold") {
      const park = openPark(handle, identity.key);
      if (parks !== undefined && park !== null)
        return await parks.resume(ctx, identity, park, args);
    }
    if (standing.reason === null || resumeVia(standing.reason) !== "work.resume") throw notHeld();
    switch (standing.reason) {
      case "paused": {
        const paused = this.#paused();
        if (paused === undefined || standing.held === null) throw notHeld();
        return await paused.resumePaused(ctx, identity, standing.held, args.note);
      }
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
  if (openPause(handle, run.runId) !== null) return { reason: "paused", held: run };
  return openWait(handle, run.runId) === null
    ? { reason: null, held: null }
    : { reason: "plan-limit", held: run };
}

/** Where the story is after a resume that did not start: parked, else released to Ready. */
export function afterFailure(handle: OfficeHandle, runId: RunId): Lifecycle {
  const parked = handle.get(
    "select 1 as found from parks where office_id = $office_id and run_id = $run",
    { run: runId },
  );
  return parked === null ? "Ready" : "Parked";
}
