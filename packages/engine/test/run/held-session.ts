// What a fake `NextSession` of the tests sends with a session, as `RunResumer` does: every message
// held on the one feedback path for a developer session (`sessionFeedback`), after the resume delta
// of a native resume, marked delivered when the session started.

import type { RunId } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../../src/db/office";
import { FEEDBACK_TEMPLATES, renderTemplate } from "../../src/prompts/templates";
import { deliverHeld } from "../../src/run/feedback";
import { findRun } from "../../src/records/run-records";
import { type NextSessionRequest, sessionFeedback } from "../../src/run/resume";

/** A next-session request with the first message the session got from the held messages. */
export interface HeldSession extends NextSessionRequest {
  /** The resume delta (native resume) then the held messages; undefined when none were held. */
  readonly message: string | undefined;
}

/**
 * The held messages of the run `runId` joined as a first message carries them; delivered at `at`
 * when `started` (the default), else left held. Empty when none were held.
 */
export function heldFirstMessage(
  office: OfficeHandle,
  runId: RunId | string,
  at: number,
  started = true,
): string {
  const run = findRun(office, runId as RunId);
  if (run === null) return "";
  const held = sessionFeedback(office, run);
  if (started) office.immediate(() => deliverHeld(office, runId, held.ids, at));
  return held.texts.join("\n\n");
}

/** `request` with what its session got (see `HeldSession`); delivered when `started`. */
export function withHeld(
  office: OfficeHandle,
  request: NextSessionRequest,
  at: number,
  started = true,
): HeldSession {
  const held = heldFirstMessage(office, request.run.runId, at, started);
  if (held === "") return { ...request, message: undefined };
  const lead =
    request.mode === "resume"
      ? renderTemplate(FEEDBACK_TEMPLATES.resume, { reason: request.why })
      : undefined;
  return { ...request, message: lead === undefined ? held : `${lead}\n\n${held}` };
}
