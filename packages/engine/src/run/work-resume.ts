// `work.resume { story, note?, budget? }` (0005, 0020, DIPO-61, DIPO-138, DIPO-155): the command of
// the resumption module. A story whose active run holds an open plan-limit wait is resumed at once
// by the plan-limit schedule (`PlanLimits.resumeNow`). A parked story with a run goes to the one
// resume path (`ParkResumes`, `park-resume.ts`), which follows the 0020 table of its reason,
// refusals included; one parked with no run (parked from Refined or Ready) gets its status back
// through the planning lane (`HoldResumer`), and the next `work.run` picks it up through the pickup
// check. A story standing still for nothing answers `story.notPausedOrParked`.

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

/** `work.resume` on a story with no park and no held run (0005). */
export const NOT_PAUSED_OR_PARKED = "story.notPausedOrParked";
/** `work.resume` while the held worker has not exited (0005, retryable). */
export const RUN_HOST_ALIVE = "run.hostAlive";

/** What answers `resumeWait`. */
export type ResumeWaitOutcome = "started" | "failed" | "notHeld" | "busy";

/** The plan-limit schedule as `work.resume` uses it (`PlanLimits.resumeNow`). */
export interface HeldRunResumer {
  resumeNow(office: OfficeId, run: RunId): Promise<ResumeWaitOutcome>;
}

/** The planning lane's resume of a park with no run (`StoryPlanning.resumeHold`). */
export interface HoldResumer {
  resumeHold(
    ctx: AsyncCommandContext,
    identity: StoryIdentity,
    park: { readonly parkId: number; readonly from: string; readonly detail: string },
    note: string | undefined,
  ): Promise<Lifecycle>;
}

/** The resume of a parked story with a run (`ParkResumes`, DIPO-155). */
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

type ResumeArgs = z.output<typeof workResume.args>;
type ResumeResult = z.input<typeof workResume.result>;

export class WorkResumeCommand {
  /** The plan-limit schedule; read when needed, since it is built after this. */
  readonly #planLimits: () => HeldRunResumer | undefined;

  /** The planning lane's resume of a park with no run; read when needed. */
  readonly #holds: () => HoldResumer | undefined;

  /** The resume of a parked story with a run. */
  readonly #parks: () => ParkResumer | undefined;

  constructor(
    planLimits: () => HeldRunResumer | undefined = () => undefined,
    holds: () => HoldResumer | undefined = () => undefined,
    parks: () => ParkResumer | undefined = () => undefined,
  ) {
    this.#planLimits = planLimits;
    this.#holds = holds;
    this.#parks = parks;
  }

  /** `work.resume`; read by the plan-limit schedule's feature. */
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

  /** `work.resume`: see the file comment. */
  async run(ctx: AsyncCommandContext, args: ResumeArgs): Promise<CommandOutcome<ResumeResult>> {
    const handle = ctx.office;
    const identity = ctx.stories.get(args.story);
    if (identity === undefined) throw new Error(`${args.story} was not resolved`);
    const notHeld = () =>
      new CommandError(
        NOT_PAUSED_OR_PARKED,
        `${identity.story} is not held by a plan limit or parked, so there is nothing to resume.`,
        { story: identity.story },
      );
    // A retry of a park resume this request stored repeats nothing (0005).
    const replayed = await this.#parks()?.replay(ctx, identity);
    if (replayed != null) return replayed;
    const held = heldRunOf(handle, identity.key);
    if (held !== null) return await this.#resumeHeld(handle, identity, held, notHeld);
    const park = openPark(handle, identity.key);
    if (park === null) throw notHeld();
    if (park.runId === null) return await this.#resumeHold(ctx, identity, park, args.note);
    const parks = this.#parks();
    if (parks === undefined) {
      throw new Error(
        `work.resume of ${identity.story} needs the park resume, and this office has none`,
      );
    }
    return await parks.resume(ctx, identity, park, args);
  }

  /** A park with no run: the planning lane lifts it; the story returns to `park.from`. */
  async #resumeHold(
    ctx: AsyncCommandContext,
    identity: StoryIdentity,
    park: NonNullable<ReturnType<typeof openPark>>,
    note: string | undefined,
  ): Promise<CommandOutcome<ResumeResult>> {
    const holds = this.#holds();
    if (holds === undefined) {
      throw new Error(
        `work.resume of ${identity.story} needs the planning lane, and this office has none`,
      );
    }
    const to = await holds.resumeHold(ctx, identity, park, note);
    return { result: { story: identity.story, key: identity.key, to } };
  }

  /** A run held by a plan limit: the schedule resumes it now. */
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

/** The story's active run held by an open plan-limit wait, or null. */
function heldRunOf(handle: OfficeHandle, key: string): StoredRun | null {
  const run = activeRuns(handle).find(
    (candidate) => candidate.kind === "story" && candidate.key === key,
  );
  return run !== undefined && openWait(handle, run.runId) !== null ? run : null;
}

/** Where the story is after a resume that did not start: parked, else released to Ready. */
export function afterFailure(handle: OfficeHandle, runId: RunId): Lifecycle {
  const parked = handle.get(
    "select 1 as found from parks where office_id = $office_id and run_id = $run",
    { run: runId },
  );
  return parked === null ? "Ready" : "Parked";
}
