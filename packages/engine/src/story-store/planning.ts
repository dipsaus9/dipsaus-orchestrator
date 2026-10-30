// The planning lane's half of the StoryStore seam (0010): the story changes that belong to no story
// PR. Each is a target state of one story (or of the office), journaled in the state database
// before the store applies it, so a pending change wins over pickup at once. The Backlog.md
// implementation (`backlog/lane/`) applies them through the Backlog CLI on an engine branch and a
// backlog PR; the engine asks for them only through `PlanningLane`, and asks the StoryStore
// whether one holds a story from pickup (`planningHold`) and which park a pending change writes
// (`plannedPark`): that park counts as the story's park before its backlog PR merges
// (`run/park-state.ts`).

import type { FieldBlockPark, Lifecycle, StoryKey } from "@dipsaus-orchestrator/contract";
import { z } from "zod";

import type { StoryKind } from "./story";

/** How far a journaled planning change got. */
export type JournalState =
  | "pending"
  | "applied"
  | "committed"
  | "pushed"
  | "merged"
  | "dropped"
  | "withdrawn";

/** States of a change that is not yet on the base and not given up. */
export const OPEN_STATES: readonly JournalState[] = ["pending", "applied", "committed", "pushed"];

/** The notice text a pending planning change gives a skipped story (0010). */
export const PENDING_LANE_NOTICE = "pending backlog PR";

/** The change kinds; a kind is also the verb of the change's commit. */
export const EDIT_KIND = "edit";
/** Hold, resume of a hold and drop (0020). */
export const HOLD_KIND = "hold";
export const RESUME_KIND = "resume";
export const DROP_KIND = "drop";
/** `work.discard` (DIPO-161): an edit back to Refined with the park removed. */
export const DISCARD_KIND = "discard";
/** An accepted worker proposal filed as a draft (DIPO-166). */
export const PROPOSE_KIND = "propose";

/** The target state of an edit: status, field-block keys and labels. */
export const EditTarget = z
  .object({
    /** `task` (default) or `draft`. */
    kind: z.enum(["task", "draft"]).optional(),
    /** Applies only while the story's status is one of these; otherwise it is dropped. */
    from: z.array(z.string().min(1)).min(1).optional(),
    status: z.string().min(1).optional(),
    /** Field-block keys to set (0010). */
    fields: z.record(z.string(), z.unknown()).optional(),
    /** Field-block keys to remove. */
    unset: z.array(z.string()).optional(),
    labels: z
      .object({
        add: z.array(z.string()).optional(),
        remove: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .strict();
export type EditTarget = z.infer<typeof EditTarget>;

/** The target state of a drop: the story is archived. */
export const DropTarget = z.object({ kind: z.enum(["task", "draft"]).optional() }).strict();
export type DropTarget = z.infer<typeof DropTarget>;

/** A park record as a story holds it (0010 field block `park`). */
export type PlannedPark = FieldBlockPark;

/** A planning change the store journaled. */
export interface PlannedChange {
  readonly opId: number;
}

/** The story a planning change is about. */
export interface PlanningStory {
  readonly key: StoryKey;
  /** The story's id, as the change's commit names it. */
  readonly story: string;
}

/** The draft an accepted worker proposal becomes (0020, DIPO-166). */
export interface ProposedDraft {
  /** The proposal's id; the store finds a draft it filed for it again by it. */
  readonly proposal: string;
  readonly title: string;
  readonly description: string;
  readonly references: readonly string[];
}

/**
 * The planning lane of one office (0010). Each change is journaled before anything is applied; a
 * change of a story that has a live claim is refused with `PlanningRefusedError` (its changes
 * travel in its story PR), unless the change releases the claim (drop, discard). `flush` applies
 * every journaled change and opens or updates the office's backlog PR; a flush that fails puts
 * its own notice on the office and leaves the changes journaled for the next one.
 */
export interface PlanningLane {
  /**
   * Parks a story that has no run (0020): status Parked with the park record
   * `{reason: by-maintainer, from, note}`, applied only while the story is Refined, Ready or the
   * legacy To Do. An open hold of the story is reused.
   */
  hold(
    story: PlanningStory,
    park: { readonly from: Lifecycle; readonly note: string },
  ): Promise<PlannedChange>;
  /** Lifts a hold: status `to`, the park record removed, only while Parked; reuses an open one. */
  resume(story: PlanningStory, to: Lifecycle): Promise<PlannedChange>;
  /** Archives the story (`kind` says which), releasing its claim. Reuses an open drop. */
  drop(story: PlanningStory, kind: StoryKind): Promise<PlannedChange>;
  /** Moves the story to Refined with the park removed, never over Done. Reuses an open discard. */
  discard(story: PlanningStory): Promise<PlannedChange>;
  /** Moves a Ready story back to Refined (a failed pickup check). */
  toRefined(story: PlanningStory): Promise<PlannedChange>;
  /** Files an accepted proposal as a draft; `subject` names it in the commit. */
  fileDraft(subject: string, draft: ProposedDraft): Promise<PlannedChange>;
  /** Gives a journaled change up before anything of it was applied. */
  withdraw(change: PlannedChange): void;
  /** Applies every journaled change; a failure is a notice on the office, never a throw. */
  flush(): Promise<void>;

  /** True while a drop (or a discard) of the story `key` is journaled and not merged. */
  isOpen(key: StoryKey, kind: typeof DROP_KIND | typeof DISCARD_KIND): boolean;
  /** The stories with a drop journaled and not merged. */
  dropping(): ReadonlySet<StoryKey>;
  /**
   * The change that files the draft of `proposal`, while it is journaled or once it merged, with
   * whether it is still open; undefined when there is none.
   */
  draftOf(proposal: string): (PlannedChange & { readonly open: boolean }) | undefined;
}

/** Why the planning lane holds a story from pickup (0010: a pending change always wins). */
export type PlanningHold =
  /** A change of the story is journaled and not on the base yet. */
  | "pending"
  /** The office's backlog PR failed its structural check on the story. */
  | "checkFailed";
