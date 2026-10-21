// The live-question rule (0021 section 11, 0020 amendment of 2026-10-21, DIPO-279): a worker's
// question is asked live only while a TUI is connected to the daemon at the moment it is asked;
// otherwise the story parks with the question at once. There is no activity window: a TUI that
// connected a second ago counts, one that closed a second ago does not, and a CLI command or any
// other client never counts.
//
// Every question source decides through `questionRoute`: the permission hook
// (`hooks/permissions.ts`) today, the box's door questions (DIPO-272) later. The engine does not
// know what a TUI is; the daemon supplies `Presence`, read once per question.

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
