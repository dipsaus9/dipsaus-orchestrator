// The maintainer's hand on a running worker (0020, 0008, DIPO-163): `work.steer`, on the waiting
// command path, through the one feedback path (`feedback.ts`, source `steer`, keyed by its
// request).
//
// - `work.steer { story, text }`: a worker with a live session gets one next-priority user message
//   wrapped in `feedback/steer.md`; the reply says `next-turn`. A parked story, or a run between
//   two sessions, holds the steer once, and the first message of the next session carries it; the
//   reply says `on-resume`. A story
//   whose live (or next) session is its reviewer, or whose host is followed only, answers
//   `story.notSteerable`: the reviewer gets no maintainer text (0002), and a follow-only host takes
//   no input (0005). A story with no run and no park answers `story.notRunning`.
//
// A re-run is target-state: a steer finds its stored intent by its request.

import { workSteer } from "@dipsaus-orchestrator/contract";
import type { z } from "zod";

import { CommandError } from "../commands/errors";
import type { AsyncCommandContext, CommandOutcome, FeatureModule } from "../commands/registry";
import type { OfficeHandle } from "../db/office";
import steerTemplate from "../prompts/feedback/steer.md" with { type: "text" };
import { renderTemplate } from "../prompts/templates";
import { followedOnly } from "../runs/worker-hosts";

import { type RunControlDeps, STORY_NOT_RUNNING } from "./control-types";
import { findSteer, sendFeedback } from "./feedback";
import { openPark } from "./park";
import { placeOfRun } from "./places";
import { activeRuns, type StoredRun } from "./records";

/** `work.steer` on a story it cannot reach (0020). */
export const STORY_NOT_STEERABLE = "story.notSteerable";

type SteerArgs = z.output<typeof workSteer.args>;
type SteerResult = z.input<typeof workSteer.result>;

/** A maintainer steer as the worker reads it (`feedback/steer.md`). */
export function steerText(text: string): string {
  return renderTemplate(steerTemplate, { text });
}

type Deps = Pick<
  RunControlDeps,
  "clock" | "offices" | "steering" | "encode" | "warn" | "onChanged"
>;

export class Interventions {
  readonly #deps: Deps;

  constructor(deps: Deps) {
    this.#deps = deps;
  }

  /** The command `work.steer`. */
  get feature(): FeatureModule {
    return {
      name: "run-intervene",
      register: (registry) => {
        registry.addAsyncOfficeCommand({
          definition: workSteer,
          handle: (ctx, args) => this.steer(ctx, args),
        });
      },
    };
  }

  /** `work.steer`: see the file comment. */
  async steer(ctx: AsyncCommandContext, args: SteerArgs): Promise<CommandOutcome<SteerResult>> {
    const handle = ctx.office;
    const identity = ctx.stories.get(args.story);
    if (identity === undefined) throw new Error(`${args.story} was not resolved`);
    // A retry after a crash finds the steer it stored; nothing is stored or sent twice.
    const stored = findSteer(handle, ctx.requestId);
    if (stored !== null) {
      return {
        result: {
          run: stored.runId as SteerResult["run"],
          delivered: stored.held ? "on-resume" : "next-turn",
        },
        changed: false,
      };
    }
    const run = activeStoryRun(handle, identity.key);
    if (run === undefined) {
      // A parked story: the steer waits on the run that parked.
      const park = openPark(handle, identity.key);
      if (park?.runId == null) {
        throw new CommandError(
          STORY_NOT_RUNNING,
          `${identity.story} has no worker to steer and is not parked.`,
          { story: identity.story },
        );
      }
      this.#hold(ctx, park.runId, args.text);
      return { result: { run: park.runId as SteerResult["run"], delivered: "on-resume" } };
    }
    this.#refuseUnsteerable(handle, run, identity.story);
    if (standsStill(handle, run)) {
      this.#hold(ctx, run.runId, args.text);
      return { result: { run: run.runId, delivered: "on-resume" } };
    }
    const error = await sendFeedback(
      handle,
      run.runId,
      { source: "steer", key: ctx.requestId, text: steerText(args.text) },
      { sender: this.#deps },
    ).done;
    if (error !== null) {
      throw new CommandError(
        STORY_NOT_STEERABLE,
        `dipo could not send the steer to ${identity.story}'s worker (${error}).`,
        { story: identity.story },
      );
    }
    return { result: { run: run.runId, delivered: "next-turn" } };
  }

  /** Stores a steer that waits for the next session's first message, once per request. */
  #hold(ctx: AsyncCommandContext, runId: string, text: string): void {
    ctx.commit(() => {
      if (findSteer(ctx.office, ctx.requestId) !== null) return;
      sendFeedback(
        ctx.office,
        runId,
        { source: "steer", key: ctx.requestId, text: steerText(text) },
        { at: ctx.now },
      );
    });
  }

  /** The reviewer gets no maintainer text (0002); a follow-only host takes no input (0006). */
  #refuseUnsteerable(office: OfficeHandle, run: StoredRun, story: string): void {
    if (placeOfRun(office, run) === "reviewer") {
      throw new CommandError(
        STORY_NOT_STEERABLE,
        `${story}'s live session is its reviewer, which takes no maintainer text.`,
        { story },
      );
    }
    if (followedOnly(office, run.runId)) {
      throw new CommandError(
        STORY_NOT_STEERABLE,
        `${story}'s worker host is followed only after a daemon restart, so dipo cannot steer it.`,
        { story },
      );
    }
  }
}

/** The story's active run, if any. */
export function activeStoryRun(office: OfficeHandle, key: string): StoredRun | undefined {
  return activeRuns(office).find((run) => run.kind === "story" && run.key === key);
}

/** True when the run's newest agent still runs. */
export function hasLiveSession(office: OfficeHandle, runId: string): boolean {
  const agent = office.get<{ ended_at: number | null }>(
    `select ended_at from agents where office_id = $office_id and run_id = $run
      order by started_at desc, rowid desc limit 1`,
    { run: runId },
  );
  return agent !== null && agent.ended_at === null;
}

/**
 * True when the run has no session to send to now: it waits for its place, or its worker exited
 * and the next session has not started.
 */
function standsStill(office: OfficeHandle, run: StoredRun): boolean {
  return run.waiting != null || !hasLiveSession(office, run.runId);
}
