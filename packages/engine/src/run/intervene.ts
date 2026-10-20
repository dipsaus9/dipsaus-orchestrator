// The maintainer's hand on a running worker (ADR 0020 section 9, 0008 section 6, DIPO-163):
// `work.steer` and `work.pause`, on the waiting command path of the 0005 note of 2026-10-17. Their
// facts and the rules of the 10-minute close are in `pauses.ts`.
//
// - `work.steer { story, text }`: a worker with a live session gets one next-priority user message
//   wrapped in `feedback/steer.md`, stored first as a `steer` intent; the reply says `next-turn`.
//   A paused or parked story, or a run between two sessions, stores the steer once, keyed by its
//   request, and the first message of the next session carries it; the reply says `on-resume`.
//   A story whose live (or next) session is its reviewer, or whose host is followed only, answers
//   `story.notSteerable`: the reviewer gets no maintainer text (0002), and a follow-only host takes
//   no input (0006). A story with no run and no park answers `story.notRunning`.
// - `work.pause { story }`: a `pause` intent and a now-priority message. The run stays In Progress
//   with health `paused` and keeps its claim, slot and session place. After 10 minutes (the cap
//   tick, `expire`) stdin closes and the process exits, which frees the place; `work.resume`
//   continues it. Its time leaves the minute cap (`runTotals`).
//
// Both handlers are target-state under a re-run: a steer finds its stored intent by its request, and
// a pause that is in effect answers again with its run.

import { type RunId, workPause, workSteer } from "@dipsaus-orchestrator/contract";
import type { z } from "zod";

import { CommandError } from "../commands/errors";
import type { AsyncCommandContext, CommandOutcome, FeatureModule } from "../commands/registry";
import type { OfficeHandle } from "../db/office";
import steerTemplate from "../prompts/feedback/steer.md" with { type: "text" };
import { renderTemplate } from "../prompts/templates";
import { background } from "../platform/background";
import { runProgress, withWorkViews, workRefOf } from "../views/work";
import { workerHostsOf } from "../runs/worker-hosts";
import type { NewEntry } from "../changelog/log";

import { type RunControlDeps, STORY_NOT_RUNNING, type Tracked } from "./control-types";
import { recordIntent, sendAsIntent } from "./intents";
import { openWait } from "./outcome-types";
import {
  findSteer,
  MAINTAINER_TAGS,
  openPause,
  PAUSE_CLOSE_MS,
  PAUSE_OUTCOMES,
  resolvePauses,
} from "./pauses";
import { openPark } from "./park";
import { placeOfRun } from "./places";
import { activeRuns, type StoredRun } from "./records";

/** `work.steer` or `work.pause` on a story it cannot reach (0020 section 9). */
export const STORY_NOT_STEERABLE = "story.notSteerable";

type SteerArgs = z.output<typeof workSteer.args>;
type SteerResult = z.input<typeof workSteer.result>;
type PauseArgs = z.output<typeof workPause.args>;
type PauseResult = z.input<typeof workPause.result>;

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
  readonly #tracked: Map<string, Tracked>;
  readonly #inflight: Set<Promise<unknown>>;

  constructor(deps: Deps, tracked: Map<string, Tracked>, inflight: Set<Promise<unknown>>) {
    this.#deps = deps;
    this.#tracked = tracked;
    this.#inflight = inflight;
  }

  /** The commands `work.steer` and `work.pause`. */
  get feature(): FeatureModule {
    return {
      name: "run-intervene",
      register: (registry) => {
        registry.addAsyncOfficeCommand({
          definition: workSteer,
          handle: (ctx, args) => this.steer(ctx, args),
        });
        registry.addAsyncOfficeCommand({
          definition: workPause,
          handle: (ctx, args) => this.pause(ctx, args),
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
          delivered: stored.state === "pending" ? "on-resume" : "next-turn",
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
    const { done } = sendAsIntent(handle, this.#deps.steering, run.runId, {
      kind: "steer",
      detail: `${MAINTAINER_TAGS.steer} ${ctx.requestId} ${args.text}`,
      ops: this.#deps.encode({ kind: "steer", text: steerText(args.text) }),
      clock: this.#deps.clock,
    });
    const { error } = await done;
    if (error !== null) {
      throw new CommandError(
        STORY_NOT_STEERABLE,
        `dipo could not send the steer to ${identity.story}'s worker (${error}).`,
        { story: identity.story },
      );
    }
    return { result: { run: run.runId, delivered: "next-turn" } };
  }

  /** `work.pause`: see the file comment. */
  async pause(ctx: AsyncCommandContext, args: PauseArgs): Promise<CommandOutcome<PauseResult>> {
    const handle = ctx.office;
    const identity = ctx.stories.get(args.story);
    if (identity === undefined) throw new Error(`${args.story} was not resolved`);
    const run = activeStoryRun(handle, identity.key);
    if (run === undefined || !hasLiveSession(handle, run.runId)) {
      if (run !== undefined && openPause(handle, run.runId) !== null) {
        return { result: { run: run.runId }, changed: false };
      }
      throw new CommandError(
        STORY_NOT_RUNNING,
        `${identity.story} has no running worker to pause.`,
        { story: identity.story },
      );
    }
    if (openPause(handle, run.runId) !== null) {
      return { result: { run: run.runId }, changed: false };
    }
    this.#refuseUnsteerable(handle, run, identity.story);
    const { done } = sendAsIntent(handle, this.#deps.steering, run.runId, {
      kind: "pause",
      detail: MAINTAINER_TAGS.pause,
      ops: this.#deps.encode({ kind: "pause" }),
      clock: this.#deps.clock,
      // A pause that did not reach the worker is no pause.
      inMark: (error, at) => {
        if (error !== null) resolvePauses(handle, run.runId, PAUSE_OUTCOMES.sendFailed, at);
      },
    });
    const { error } = await done;
    if (error !== null) {
      throw new CommandError(
        STORY_NOT_STEERABLE,
        `dipo could not send the pause to ${identity.story}'s worker (${error}).`,
        { story: identity.story },
      );
    }
    ctx.commit(() => progressEntries(handle, run));
    return { result: { run: run.runId } };
  }

  /**
   * Called on the cap tick of a tracked run: a pause older than 10 minutes closes stdin, so the
   * process exits and its place frees. Sent once per tracking; a restart sends it again, which a
   * closed stdin takes without harm.
   */
  expire(tracked: Tracked): void {
    if (tracked.pauseClosed === true) return;
    const office = this.#deps.offices.get(tracked.office);
    if (office === undefined) return;
    const pause = openPause(office, tracked.runId);
    if (pause === null || this.#deps.clock.now() - pause.since < PAUSE_CLOSE_MS) return;
    tracked.pauseClosed = true;
    background(
      async () => {
        const sent = await this.#deps.steering.send(office, tracked.runId, [{ closeStdin: true }]);
        if (!sent.ok) {
          tracked.pauseClosed = false;
          this.#deps.warn?.("closing the stdin of a paused worker failed", {
            run: tracked.runId,
            reason: sent.reason,
          });
        }
      },
      {
        failed: "closing the stdin of a paused worker failed",
        fields: { run: tracked.runId },
        log: this.#deps.warn,
        inflight: this.#inflight,
      },
    );
  }

  /** Stores a steer that waits for the next session's first message, once per request. */
  #hold(ctx: AsyncCommandContext, runId: string, text: string): void {
    ctx.commit(() => {
      if (findSteer(ctx.office, ctx.requestId) !== null) return;
      recordIntent(
        ctx.office,
        runId as RunId,
        "steer",
        `${MAINTAINER_TAGS.steer} ${ctx.requestId} ${text}`,
        ctx.now,
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
    const newest = workerHostsOf(office, run.runId).at(-1);
    if (newest !== undefined && newest.endedAt === null && newest.mode === "follow") {
      throw new CommandError(
        STORY_NOT_STEERABLE,
        `${story}'s worker host is followed only after a daemon restart, so dipo cannot steer it.`,
        { story },
      );
    }
  }

  /** True while the run is tracked; the tick drives the pause expiry for those. */
  isTracked(runId: string): boolean {
    return this.#tracked.has(runId);
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
 * True when the run has no session to send to now: it is paused, waits for its place or a plan
 * limit, or its worker exited and the next session has not started.
 */
function standsStill(office: OfficeHandle, run: StoredRun): boolean {
  return (
    openPause(office, run.runId) !== null ||
    run.waiting != null ||
    openWait(office, run.runId) !== null ||
    !hasLiveSession(office, run.runId)
  );
}

/** The `work.progress` entry that carries the run's view, so clients see health `paused`. */
export function progressEntries(office: OfficeHandle, run: StoredRun): NewEntry[] {
  const work = workRefOf(office, run.runId as RunId);
  const progress = runProgress(office, run.runId as RunId);
  if (work === null || progress === null) return [];
  return withWorkViews(office, [
    { type: "work.progress", key: work.key, run: run.runId, delta: { work, progress } },
  ]);
}
