// What a StoryStore throws when it cannot read or write a story (0010). The engine tells a store
// failure from its own errors by these classes alone; each implementation's errors extend them.

/** The store could not read or write a story: its tracker failed, refused, or printed no story. */
export class StoryStoreError extends Error {}

/** A story the store read does not parse, so its fields are unknown (0012 R02). */
export class StoryParseError extends StoryStoreError {}

/**
 * The `GitError` code when a story's file on its branch holds a field dipo does not know: the
 * operation is refused before the store's tracker runs, and a story in a run parks
 * `scope-violation` (0021).
 */
export const TASK_FIELD_ERROR = "story.unknownTaskField";

/** The planning lane refused a change: nothing was journaled (0010). */
export class PlanningRefusedError extends StoryStoreError {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "PlanningRefusedError";
  }
}

/** The `PlanningRefusedError` code of a change refused because the story has a live claim. */
export const LIVE_CLAIM_REFUSAL = "backlog.lane.liveClaim";
