// Resuming a run that stands still (0020, DIPO-138): the one module for every resume of a held or
// parked run.
//
// - `work.resume` (`work-resume.ts`) resumes a parked story through `ParkResumes`
//   (`park-resume.ts`), the one resume path, by the 0020 table of its reason; a story parked with
//   no run returns to its status through the planning lane. A resume whose worker place is taken,
//   or paused by a plan limit, is still accepted: the run waits for the place (`places.ts`) and
//   `startQueued` starts its session when the place frees. `recoverParkResumes` finishes a resume
//   a restart interrupted.
// - `resumeWait` resumes a run held by a plan limit; `work.resume` and the schedule's timers call
//   it.
// - `questionParks` is the resume of an `ambiguous-spec` park by `work.answer` on its question:
//   the same path, with the answer as the note.

import {
  type OfficeId,
  type RunId,
  StoryId,
  StoryKey,
  type workResume,
} from "@dipsaus-orchestrator/contract";
import type { z } from "zod";

import type { AsyncCommandContext, CommandOutcome, FeatureModule } from "../commands/registry";
import type { OfficeHandle } from "../db/office";
import type { QuestionParkResumer } from "../hooks/permissions";

import { runIntents } from "./intents";
import { RunOutcomes, type OutcomeParts } from "./outcomes";
import { ParkResumes, type ParkResumeOptions } from "./park-resume";
import {
  INTENT_TAGS,
  intentTag,
  openWait,
  PLAN_LIMIT_CONTINUE,
  type RunOutcomesDeps,
} from "./outcome-types";
import type { Places } from "./places";
import { findRun, type StoredRun } from "./records";
import {
  type HeldRunResumer,
  type HoldResumer,
  type ResumeWaitOutcome,
  WorkResumeCommand,
} from "./work-resume";

export {
  type HeldRunResumer,
  NOT_PAUSED_OR_PARKED,
  type ResumeWaitOutcome,
  RUN_HOST_ALIVE,
  WorkResumeCommand,
} from "./work-resume";

export interface ResumptionOptions {
  /**
   * The plan-limit schedule; read when needed, since it is built after this. `work.resume` of a
   * held run needs it and refuses without it.
   */
  readonly planLimits?: () => HeldRunResumer | undefined;
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
  readonly #s: OutcomeParts["support"];
  readonly #deps: RunOutcomesDeps;
  readonly #guard: OutcomeParts["support"]["guard"];
  readonly #sessions: OutcomeParts["sessions"];
  readonly #command: WorkResumeCommand;
  readonly #parks: ParkResumes;

  constructor(parts: OutcomeParts, options: ResumptionOptions = {}) {
    this.#s = parts.support;
    this.#deps = parts.support.deps;
    this.#guard = parts.support.guard;
    this.#sessions = parts.sessions;
    const places = options.places ?? (() => undefined);
    this.#parks = new ParkResumes(parts, { ...options.parks, places });
    this.#command = new WorkResumeCommand(options.planLimits, options.holds, () => this.#parks);
  }

  /** Resolves once every session start of a resumed park this started has finished. */
  async idle(): Promise<void> {
    await this.#parks.idle();
  }

  /** `work.resume` (`WorkResumeCommand`); read by the plan-limit schedule's feature. */
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
   * Resumes a run held by a plan limit (DIPO-61, 0008): its session continues with "continue" (a
   * handoff when it cannot be resumed), and the `plan-limit` signal ends when the new session is
   * recorded. `notHeld` when the run has no open wait or has ended, `busy` while the held worker
   * has not exited yet. A next session that cannot start parks or releases the story as after a
   * crash.
   */
  async resumeWait(officeId: OfficeId, runId: RunId, why: string): Promise<ResumeWaitOutcome> {
    const office = this.#deps.offices.get(officeId);
    if (office === undefined) return "notHeld";
    const run = findRun(office, runId);
    if (run === null || run.endedAt !== null || openWait(office, runId) === null) return "notHeld";
    const key = `${runId} plan-limit`;
    if (this.#guard.busy(runId)) return "busy";
    const latest = office.get<{ ended_at: number | null }>(
      `select ended_at from agents where office_id = $office_id and run_id = $run
        order by started_at desc, rowid desc limit 1`,
      { run: runId },
    );
    if (latest !== null && latest.ended_at === null) return "busy";
    const view = this.#s.viewOf(officeId, office, run);
    if (view === null) return "notHeld";
    return this.#guard.within(key, async () => {
      // The wait explained the held worker's exit; one left open (an exit a restart did not
      // decide) must not explain the next session's exit.
      const at = this.#deps.clock.now();
      for (const intent of runIntents(office, runId)) {
        if (intent.resolvedAt !== null || intent.kind !== "pause") continue;
        if (intentTag(intent.detail) !== INTENT_TAGS.planLimit) continue;
        this.#s.resolve(office, runId, intent, "plan-limit", at);
      }
      const started = await this.#sessions.next(office, run, view, {
        mode: "resume",
        why,
        message: PLAN_LIMIT_CONTINUE,
        clear: ["plan-limit"],
      });
      return started ? "started" : "failed";
    });
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
