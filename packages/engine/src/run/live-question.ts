// The live-question rule (0021 section 11, 0020 amendment of 2026-10-21, DIPO-279): a worker's
// question is asked live only while a TUI is connected to the daemon at the moment it is asked;
// otherwise the story parks with the question at once. There is no activity window: a TUI that
// connected a second ago counts, one that closed a second ago does not, and a CLI command or any
// other client never counts.
//
// Every question source decides through `questionRoute`: the permission hook
// (`hooks/permissions.ts`) and the question of a worker's report, the door's message W3
// (DIPO-272): run control hands it to `LiveQuestions.askWorker`, which asks it live or leaves the
// park to run control. The engine does not know what a TUI is; the daemon supplies `Presence`,
// read once per question. A question that is live when the last TUI closes parks at once too
// (DIPO-284): the daemon then calls `PermissionAsks.presenceChanged`, which reads `Presence` again.

import type { RunId } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";

/** Whether the maintainer has a TUI open, as the daemon sees its connections right now. */
export interface Presence {
  /** True while at least one TUI is connected to the daemon, read at the moment of the call. */
  tuiConnected(): boolean;
}

/** No TUI, ever: every question parks. */
export const ABSENT: Presence = { tuiConnected: () => false };

/** Where a question goes: shown live to the maintainer, or parked with the story. */
export type QuestionRoute = "live" | "park";

/**
 * The route of a question asked now. `allowed` is the source's own gate (for example
 * `permissions.ask: never`, or a run being ended); false parks whatever the presence says.
 */
export function questionRoute(presence: Presence, allowed = true): QuestionRoute {
  return allowed && presence.tuiConnected() ? "live" : "park";
}

/** The live wait of a worker report's question, as run control asks it (DIPO-272). */
export interface LiveQuestions {
  /**
   * Asks the question `text` of `run`'s worker live when `questionRoute` says live, and then the
   * worker waits on stdin for the answer; true when it did. False when the story must park.
   */
  askWorker(office: OfficeHandle, run: RunId, agent: string, text: string): boolean;
}
