// The StoryStore seam (0010): the engine reads and writes stories only through this interface.
// Backlog.md is its one implementation (`backlog/store.ts`): the Backlog CLI, the task-file commits
// of the story lane and the backlog PRs of the planning lane. Another tracker would be another
// implementation (Later, 0003).
//
// Reads come from a checkout of the base (the office's `_base`, or any checkout a caller holds) or
// from a story's branch. Writes on the story lane are edits of one story on its branch, committed
// together as one commit of that story alone. Changes that belong to no story PR go through the
// planning lane (`planning.ts`); the store reads whether one holds a story (`planningHold`).

import type { FieldBlock, StoryKey } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import type { GitLocation } from "../git/hardened";
import type { GitSession, OfficeGit } from "../git/office";

import type { PlannedPark, PlanningHold } from "./planning";
import type { PlainList, PlainTask, StoryKind } from "./story";

/** A story's id, title and status as its list printed them. */
export interface ListedStory {
  readonly id: string;
  readonly title: string;
  readonly status: string;
}

/** One story as a read of every story, or of one, gave it. */
export interface StoryRead {
  readonly kind: StoryKind;
  /** What the list printed; a story that does not parse is known by these alone. */
  readonly listed: ListedStory;
  /** A hash of what the store read, the same wherever the checkout it read lies. */
  readonly contentHash: string;
  /** The story with its fields; undefined when it does not parse (R02). */
  readonly view?: PlainTask;
}

/** A story on its own branch: the story lane (0010). */
export interface StoryOnBranch {
  readonly story: string;
  readonly branch: string;
}

/** A story as committed at its branch tip, with its file. */
export interface BranchView {
  readonly view: PlainTask;
  /** The story's file in the repository, relative to its root. */
  readonly file: string;
}

/** What a story lane edit did. */
export interface StoryEdit<T> {
  readonly value: T;
  /** The commit of the story alone on its branch, or null when the edit changed nothing. */
  readonly commit: string | null;
}

/**
 * Reads of a checkout that may come from the store's kept reads, when nothing they printed changed
 * since (DIPO-314). Runs inside the office's git queue item `session`.
 */
export interface ReadReuse {
  /** Whose kept reads these are: one set per key, for as long as the key lives (the office). */
  readonly key: object;
  readonly session: GitSession;
  /** The checkout's git location. */
  readonly location: GitLocation;
  /** The commit the checkout is at. */
  readonly sha: string;
}

/**
 * One story's edits on the story lane, inside `StoryStore.editOnBranch`. Each write reads back
 * what it wrote; the park reason and a resolved unknown are field-block keys (0010), written
 * through `writeFields`, the single field write path.
 */
export interface StoryEditor {
  /** The story's id, as the edit was asked for. */
  readonly id: string;
  /** The story's file in the repository, relative to its root. */
  readonly file: string;
  /** The story as it is now, within the edit. */
  view(): Promise<PlainTask>;
  /** Sets the status, checking off `check` criteria (their `#n` numbers) in the same write. */
  setStatus(status: string, check?: readonly number[]): Promise<void>;
  /** Applies the target-state `change` to the field block; returns the block now stored. */
  writeFields(change: (fields: FieldBlock) => FieldBlock): Promise<FieldBlock>;
  /** Appends `text` as one block to the implementation notes; returns the notes now stored. */
  appendNotes(text: string): Promise<string>;
  /** Sets the final summary; returns the summary now stored. */
  setFinalSummary(text: string): Promise<string>;
  /** Records `paths` as files the story modified; nothing for none. */
  recordModifiedFiles(paths: readonly string[]): Promise<void>;
}

export interface StoryStore {
  // ---- reads of a checkout of the base ----------------------------------------------------------

  /** Every story of `kind` the checkout holds, all of them, or a `StoryStoreError`. */
  list(checkout: string, kind: StoryKind): Promise<PlainList>;
  /** One story with its fields; a `StoryParseError` when it does not parse. */
  view(checkout: string, id: string, kind?: StoryKind): Promise<PlainTask>;
  /**
   * Every active task and draft of the checkout, in list order. A failed list or read fails the
   * whole read, so no story looks gone; a story that does not parse is still returned.
   */
  readAll(checkout: string, reuse?: ReadReuse): Promise<StoryRead[]>;
  /** One story of the checkout; `listed` stands in when it does not parse. */
  read(checkout: string, kind: StoryKind, listed: ListedStory): Promise<StoryRead>;
  /** The ids and names of every milestone, completed ones included. */
  milestones(checkout: string): Promise<string[]>;
  /** True when `error`, thrown by a read of the story `id`, says that no such story exists. */
  isNotFound(error: unknown, id: string): boolean;

  // ---- reads on a story's branch (inside the office's git queue item `session`) -----------------

  /**
   * The story as committed at its branch tip, with every other story as the base `checkout` holds
   * it; `listed` stands in when it does not parse. Throws when the branch or the story's file is
   * missing, or holds a field dipo does not know (`TASK_FIELD_ERROR`).
   */
  readOnBranch(
    git: OfficeGit,
    session: GitSession,
    target: StoryOnBranch,
    checkout: string,
    listed: ListedStory,
  ): Promise<StoryRead>;
  /** The story as committed at its branch tip, read alone. */
  viewOnBranch(git: OfficeGit, session: GitSession, target: StoryOnBranch): Promise<BranchView>;

  // ---- writes on the story lane -----------------------------------------------------------------

  /**
   * Edits the story as committed at its branch tip with `fn`, then commits what changed of the
   * story alone on its branch as `message`. A branch that moved meanwhile is refused, so no commit
   * is lost.
   */
  editOnBranch<T>(
    git: OfficeGit,
    session: GitSession,
    target: StoryOnBranch,
    message: string,
    fn: (story: StoryEditor) => Promise<T>,
  ): Promise<StoryEdit<T>>;

  // ---- the story's file in the repository -------------------------------------------------------

  /** True when the repository path `path` is the file of the story `id`. */
  isStoryFile(path: string, id: string): boolean;
  /**
   * The file of the story `id` at `commit`, or null when the commit holds none or more than one.
   * Runs inside the office's git queue item `session`.
   */
  fileAt(session: GitSession, commit: string, id: string): Promise<string | null>;
  /** The status a story file's text `text` holds, or null when it holds none. */
  statusIn(text: string): string | null;
  /**
   * The folder the store's root configuration text `text` names for its stories, or null when it
   * names none or one that does not resolve: that folder's configuration is the store's too.
   */
  configuredFolder(text: string): string | null;

  // ---- the planning lane (0010), read from the office's state database ----------------------------

  /**
   * Why the planning lane holds the story `key` from pickup, or null: a journaled change first,
   * then a failed check of the office's backlog PR.
   */
  planningHold(office: OfficeHandle, key: StoryKey): PlanningHold | null;
  /**
   * The park the planning lane's newest journaled change of the story `key` writes, while it is
   * not on the base yet (0010: a pending change wins): `undefined` when no such change sets the
   * story's status or park, else its park record (null when it lifts the park, drops the story or
   * moves it to a status other than Parked).
   */
  plannedPark(office: OfficeHandle, key: StoryKey | string): PlannedPark | null | undefined;
}
