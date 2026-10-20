// `work.resume` of a run the maintainer paused (ADR 0020 section 9, DIPO-163): the `paused` row of
// the resume policy table.
//
// - The worker still lives (the pause is younger than 10 minutes): it gets one user message,
//   `continue` with the steers and feedback items that waited, and the pause is resolved.
// - Its process exited after the 10 minutes: the run's next session starts with `--resume` when the
//   adapter allows it (a handoff otherwise), the waiting messages in its first message. When the
//   office's worker place is taken the run waits for it as any maintainer resume does
//   (`waitForPlace`, `queued: true`), and the place's starter, `startQueued`, starts the session.
//
// The paused time ends when the pause is resolved, so the minute cap leaves it out (`pausedMs`).
// The wait for the worker place is not counted either: the queued resume resolves nothing, and
// when the place frees, `claimPlace` adds that wait to `parked_ms` (`capsStartedAt` adds it).

import type { OfficeId, workResume } from "@dipsaus-orchestrator/contract";
import type { z } from "zod";

import { CommandError } from "../commands/errors";
import type { AsyncCommandContext, CommandOutcome } from "../commands/registry";
import type { OfficeHandle } from "../db/office";
import type { StoryIdentity } from "../stories/keys";

import { hasLiveSession, progressEntries, steerText, STORY_NOT_STEERABLE } from "./intervene";
import { recordIntent, sendAsIntent } from "./intents";
import type { OutcomeParts } from "./outcomes";
import {
  findSteer,
  heldMessages,
  markHeldSent,
  markPauseResumed,
  MAINTAINER_TAGS,
  openPause,
  PAUSE_CLOSE_MS,
  PAUSE_OUTCOMES,
  queuedPauseResume,
  resolvePauses,
} from "./pauses";
import { PLACE_NOTICES, type Places, START_KINDS, waitForPlace } from "./places";
import { findRun, type StoredRun } from "./records";
import { type PausedResumer, afterFailure, RUN_HOST_ALIVE } from "./work-resume";

type ResumeResult = z.input<typeof workResume.result>;

/** The first message of a worker resumed while its process lives. */
export const PAUSE_CONTINUE = "continue";

const RESUME_WHY = "the maintainer resumed the paused run";

export class PausedResumes implements PausedResumer {
  readonly #s: OutcomeParts["support"];
  readonly #sessions: OutcomeParts["sessions"];
  readonly #places: () => Places | undefined;

  constructor(parts: OutcomeParts, places: () => Places | undefined) {
    this.#s = parts.support;
    this.#sessions = parts.sessions;
    this.#places = places;
  }

  async resumePaused(
    ctx: AsyncCommandContext,
    identity: StoryIdentity,
    run: StoredRun,
    note: string | undefined,
  ): Promise<CommandOutcome<ResumeResult>> {
    const handle = ctx.office;
    const deps = this.#s.deps;
    const runId = run.runId;
    const pause = openPause(handle, runId);
    if (pause === null) throw new Error(`${identity.story} is not paused`);
    const result = (to: ResumeResult["to"], queued?: true): ResumeResult => ({
      story: identity.story,
      key: identity.key,
      to,
      run: runId,
      ...(queued === undefined ? {} : { queued }),
    });
    const trimmed = note?.trim();
    if (trimmed !== undefined && trimmed !== "") {
      const key = `${ctx.requestId}:note`;
      ctx.commit(() => {
        if (findSteer(handle, key) !== null) return;
        recordIntent(handle, runId, "steer", `${MAINTAINER_TAGS.steer} ${key} ${trimmed}`, ctx.now);
      });
    }
    if (this.#s.guard.busy(runId)) {
      throw new CommandError(
        RUN_HOST_ALIVE,
        `${identity.story} is being resumed; send work.resume again in a moment.`,
        { story: identity.story, run: runId },
      );
    }
    if (hasLiveSession(handle, runId)) {
      // Past the 10 minutes its stdin is closed and the process is on its way out.
      if (deps.clock.now() - pause.since >= PAUSE_CLOSE_MS) {
        throw new CommandError(
          RUN_HOST_ALIVE,
          `${identity.story}'s paused worker has not exited yet; send work.resume again in a moment.`,
          { story: identity.story, run: runId },
        );
      }
      const held = heldMessages(handle, runId, steerText);
      const { done } = sendAsIntent(handle, deps.steering, runId, {
        kind: "steer",
        detail: "maintainer-resume",
        ops: deps.encode({ kind: "steer", text: [PAUSE_CONTINUE, ...held.texts].join("\n\n") }),
        clock: deps.clock,
        inMark: (error, at) => {
          if (error !== null) return;
          markHeldSent(handle, runId, held.ids, at);
          resolvePauses(handle, runId, PAUSE_OUTCOMES.resumed, at);
        },
      });
      const { error } = await done;
      if (error !== null) {
        throw new CommandError(
          STORY_NOT_STEERABLE,
          `dipo could not send the resume to ${identity.story}'s worker (${error}).`,
          { story: identity.story },
        );
      }
      ctx.commit(() => progressEntries(handle, run));
      return { result: result("In Progress") };
    }
    const officeId = handle.officeId as OfficeId;
    const places = this.#places();
    const at = deps.clock.now();
    const queued =
      places?.blocked(
        officeId,
        { kind: START_KINDS.resume, runId, since: at },
        places.modelOf(officeId, "worker", run),
      ) ?? null;
    if (queued !== null) {
      ctx.commit(() => {
        resolvePauses(handle, runId, PAUSE_OUTCOMES.resumeQueued, at);
        waitForPlace(handle, runId, START_KINDS.resume, at);
        return [
          {
            type: "engine.notice",
            key: identity.key,
            run: runId,
            delta: {
              level: "info",
              code: PLACE_NOTICES.queued,
              text: `${identity.story}: resumed; its session starts when the office's worker place frees (${queued}).`,
            },
          },
          ...progressEntries(handle, run),
        ];
      });
      void places?.drain(officeId).catch((error: unknown) => {
        deps.warn?.("starting a queued resume failed", { run: runId, reason: String(error) });
      });
      return { result: result("In Progress", true) };
    }
    const started = await this.#start(handle, run, (resolveAt) =>
      handle.immediate(() => resolvePauses(handle, runId, PAUSE_OUTCOMES.resumed, resolveAt)),
    );
    if (started === null) {
      throw new Error(`dipo cannot resume ${identity.story} in this office`);
    }
    return { result: result(started ? "In Progress" : afterFailure(handle, runId)) };
  }

  /**
   * The starter of a paused run's resume that waited for the worker place (`Places`): its pause
   * was resolved `resume-queued`, and no session started since. False when it has none or the
   * session did not start.
   */
  async startQueued(officeId: OfficeId, run: StoredRun): Promise<boolean> {
    const office = this.#s.deps.offices.get(officeId);
    if (office === undefined) return false;
    const intent = queuedPauseResume(office, run.runId);
    if (intent === null || this.#s.guard.busy(run.runId)) return false;
    const started = await this.#start(office, findRun(office, run.runId) ?? run, undefined);
    if (started === true) markPauseResumed(office, run.runId, intent);
    return started === true;
  }

  /** Starts the next session of the run; null when the office cannot, else whether it started. */
  async #start(
    office: OfficeHandle,
    run: StoredRun,
    before: ((at: number) => void) | undefined,
  ): Promise<boolean | null> {
    const officeId = office.officeId as OfficeId;
    const view = this.#s.viewOf(officeId, office, run);
    if (view === null) return null;
    return await this.#s.guard.within(`${run.runId} pause-resume`, async () => {
      before?.(this.#s.deps.clock.now());
      return await this.#sessions.next(office, run, view, { mode: "resume", why: RESUME_WHY });
    });
  }
}
