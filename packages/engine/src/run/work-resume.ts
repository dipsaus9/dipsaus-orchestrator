// `work.resume { story, note?, budget? }` (0005, 0020, DIPO-138, DIPO-155): the command of the
// resumption module. A parked story with a run goes to the one resume path (`ParkResumes`,
// `park-resume.ts`), which follows the 0020 table of its reason, refusals included; one parked with
// no run (parked from Refined or Ready) gets its status back through the planning lane
// (`HoldResumer`), and the next `work.run` picks it up through the pickup check. A resume is a
// target state (0005): a story that already runs (In Progress or In Review) answers `changed: false`
// and changes nothing; any other story that is not parked answers `story.notParked`.

import { type Lifecycle, workResume } from "@dipsaus-orchestrator/contract";
import type { z } from "zod";

import { CommandError } from "../commands/errors";
import type {
  AsyncCommandContext,
  CommandOutcome,
  FeatureModule,
  FeatureRegistry,
} from "../commands/registry";
import type { StoryIdentity } from "../stories/keys";
import { storyView } from "../views/story";

import { openPark } from "./park";
import type { ParkStore } from "../records/park-state";
import { notResumable } from "./park-resume";
import { parkResumeNeed } from "../records/resume-policy";

/** `work.resume` on a story that is neither parked nor running (0005). */
export const NOT_PARKED = "story.notParked";

/** The states of a story that already runs: a resume of it changes nothing (0005). */
const RUNNING: ReadonlySet<Lifecycle> = new Set<Lifecycle>(["In Progress", "In Review"]);

/** `work.resume` while the run's last worker has not exited (0005, retryable). */
export const RUN_HOST_ALIVE = "run.hostAlive";

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
  /** The story store: the park a pending planning change writes (`plannedPark`, 0010). */
  readonly #stories: ParkStore;

  /** The planning lane's resume of a park with no run; read when needed. */
  readonly #holds: () => HoldResumer | undefined;

  /** The resume of a parked story with a run. */
  readonly #parks: () => ParkResumer | undefined;

  constructor(
    stories: ParkStore,
    holds: () => HoldResumer | undefined = () => undefined,
    parks: () => ParkResumer | undefined = () => undefined,
  ) {
    this.#stories = stories;
    this.#holds = holds;
    this.#parks = parks;
  }

  /** `work.resume`. */
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
    // A retry of a park resume this request stored repeats nothing (0005).
    const replayed = await this.#parks()?.replay(ctx, identity);
    if (replayed != null) return replayed;
    const park = openPark(this.#stories, handle, identity.key);
    if (park === null) {
      const now = storyView(handle, identity.key);
      if (now !== null && RUNNING.has(now.lifecycle)) {
        return {
          result: {
            story: identity.story,
            key: identity.key,
            to: now.lifecycle,
            ...(now.work === undefined ? {} : { run: now.work.run }),
          },
          changed: false,
        };
      }
      throw new CommandError(
        NOT_PARKED,
        `${identity.story} is not parked, so there is nothing to resume.`,
        { story: identity.story },
      );
    }
    // The table refuses its reason whether the park has a run or not (0020).
    if (parkResumeNeed(park.reason).kind === "refuse")
      throw notResumable(identity.story, park.reason);
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
    return { result: { story: identity.story, key: identity.key, to }, changed: true };
  }
}
