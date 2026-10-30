// Resuming a parked run (0020, DIPO-138): the one module for every resume of a parked run.
//
// - `work.resume` (`work-resume.ts`) resumes a parked story through `ParkResumes`
//   (`park-resume.ts`), the one resume path, by the 0020 table of its reason; a story parked with
//   no run returns to its status through the planning lane. A resume whose worker place is taken is
//   still accepted: the run waits for the place (`places.ts`) and `startQueued` starts its session
//   when the place frees. `recoverParkResumes` finishes a resume a restart interrupted.
// - `resumeLifted` is the one resume no command asks for: when the office's starts paused lifts,
//   `StartsPaused` resumes each park a plan limit made through the same path (0020).
// - `questionParks` is the resume of an `ambiguous-spec` park by `work.answer` on its question:
//   the same path, with the answer as the note.

import { type OfficeId, StoryId, StoryKey, type workResume } from "@dipsaus-orchestrator/contract";
import type { z } from "zod";

import { CommandError } from "../commands/errors";
import type { AsyncCommandContext, CommandOutcome, FeatureModule } from "../commands/registry";
import type { OfficeHandle } from "../db/office";
import type { QuestionParkResumer } from "../questions/permissions";

import { RunOutcomes, type OutcomeParts } from "./outcomes";
import { openPark } from "./park";
import { ParkResumes, type ParkResumeOptions, type ResumeRequest } from "./park-resume";
import type { RunOutcomesDeps } from "./outcome-types";
import type { Places } from "./places";
import type { StoredRun } from "../records/run-records";
import type { LiftedPark, LiftedResume } from "./starts-paused";
import { type HoldResumer, WorkResumeCommand } from "./work-resume";

export { NOT_PARKED, RUN_HOST_ALIVE, WorkResumeCommand } from "./work-resume";

/**
 * The refusals of a resume after starts paused lifted that pass by themselves, so the resume is
 * tried again: scheduling off, a worker that has not exited, the starts paused again.
 */
const LIFTED_RETRY_CODES: ReadonlySet<string> = new Set([
  "scheduling.off",
  "run.hostAlive",
  "run.refused",
]);

export interface ResumptionOptions {
  /**
   * The office's session places (DIPO-142); read when needed, since they are built after this. A
   * resume whose place is blocked waits for it; without them a resume starts at once.
   */
  readonly places?: () => Places | undefined;
  /**
   * The planning lane's resume of a park with no run (DIPO-160); read when needed. `work.resume`
   * of such a story needs it.
   */
  readonly holds?: () => HoldResumer | undefined;
  /** What the park resume needs besides the places (DIPO-155); see `ParkResumeOptions`. */
  readonly parks?: Omit<ParkResumeOptions, "places">;
}

type ResumeArgs = z.output<typeof workResume.args>;
type ResumeResult = z.input<typeof workResume.result>;

/**
 * Builds worker outcomes and the resumption that shares their facts and guard: the outcomes'
 * restart step finishes the park resumes a restart interrupted through it.
 */
export function createRunOutcomes(
  deps: RunOutcomesDeps,
  options: ResumptionOptions = {},
): { readonly outcomes: RunOutcomes; readonly resumption: Resumption } {
  let resumption: Resumption | null = null;
  const outcomes = new RunOutcomes({
    ...deps,
    recoverParks: (officeId, office) => resumption?.recoverParkResumes(officeId, office) ?? 0,
  });
  resumption = new Resumption(outcomes.parts, options);
  return { outcomes, resumption };
}

/** The story of a story run, as `work.resume` names it; throws for a run with no story. */
function identity(run: StoredRun): { readonly story: StoryId; readonly key: StoryKey } {
  if (run.story === null || run.key === null) {
    throw new Error(`${run.runId} is not a story run; only a story's park resumes`);
  }
  return { story: StoryId.parse(run.story), key: StoryKey.parse(run.key) };
}

export class Resumption {
  readonly #deps: RunOutcomesDeps;
  readonly #command: WorkResumeCommand;
  readonly #parks: ParkResumes;

  constructor(parts: OutcomeParts, options: ResumptionOptions = {}) {
    this.#deps = parts.support.deps;
    const places = options.places ?? (() => undefined);
    this.#parks = new ParkResumes(parts, { ...options.parks, places });
    this.#command = new WorkResumeCommand(this.#deps.stories, options.holds, () => this.#parks);
  }

  /** Resolves once every session start of a resumed park this started has finished. */
  async idle(): Promise<void> {
    await this.#parks.idle();
  }

  /** `work.resume` (`WorkResumeCommand`). */
  get feature(): FeatureModule {
    return this.#command.feature;
  }

  /** `work.resume { story, note?, budget? }` (`WorkResumeCommand.run`). */
  resumeCommand(ctx: AsyncCommandContext, args: ResumeArgs): Promise<CommandOutcome<ResumeResult>> {
    return this.#command.run(ctx, args);
  }

  /**
   * The resume of an `ambiguous-spec` park by `work.answer` (0020): `work.resume`'s park path for
   * the run's story with the answer as its note, refusals included.
   */
  get questionParks(): QuestionParkResumer {
    return {
      resume: async (ctx, run, park, answer) => {
        const story = identity(run);
        const outcome = await this.#parks.resume(ctx, story, park, {
          story: story.story,
          note: answer,
        } as ResumeArgs);
        return {
          ...(outcome.result.run === undefined ? {} : { run: outcome.result.run }),
          ...(outcome.result.queued === true ? { queued: true } : {}),
        };
      },
      replay: async (ctx, run) => {
        const outcome = await this.#parks.replay(ctx, identity(run));
        if (outcome === null) return null;
        return outcome.result.run === undefined ? {} : { run: outcome.result.run };
      },
    };
  }

  /**
   * The resume of a park a plan limit made, once the office's starts paused lifted (0020,
   * `StartsPaused`): the one resume path, with no note and an engine-made request, as dipo and
   * not the maintainer. `retry` when it cannot run yet (scheduling off, a worker not exited, the
   * starts paused again), `refused` with why when the park stays for the maintainer.
   */
  async resumeLifted(officeId: OfficeId, lifted: LiftedPark): Promise<LiftedResume> {
    const office = this.#deps.offices.get(officeId);
    if (office === undefined) return { outcome: "retry", why: "the office is not loaded" };
    const park = openPark(this.#deps.stories, office, lifted.key);
    // Resumed, dropped or parked again meanwhile: nothing to do for this park.
    if (park === null || park.parkId !== lifted.parkId) return { outcome: "resumed" };
    const current = office.get<{ story_id: string }>(
      "select story_id from stories where office_id = $office_id and key = $key",
      { key: lifted.key },
    );
    const story = StoryId.parse(current?.story_id ?? lifted.story);
    const request: ResumeRequest = {
      office,
      requestId: `lifted:${park.parkId}:${this.#deps.clock.now()}`,
      origin: "other",
      lifted: true,
    };
    try {
      await this.#parks.resume(request, { story, key: StoryKey.parse(lifted.key) }, park, {
        story,
      } as ResumeArgs);
      return { outcome: "resumed" };
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      const code = error instanceof CommandError ? error.error.code : null;
      if (code !== null && LIFTED_RETRY_CODES.has(code)) return { outcome: "retry", why };
      return { outcome: "refused", why };
    }
  }

  /**
   * The starter of a maintainer resume that waited for the worker place (`Places`, DIPO-142).
   * False when the run has no such resume or the session did not start.
   */
  async startQueued(officeId: OfficeId, run: StoredRun): Promise<boolean> {
    return (await this.#parks.startQueued(officeId, run)) ?? false;
  }

  /** After a restart: the park resumes it interrupted are finished (`ParkResumes.recover`). */
  async recoverParkResumes(officeId: OfficeId, office: OfficeHandle): Promise<number> {
    void officeId;
    return await this.#parks.recover(office);
  }
}
