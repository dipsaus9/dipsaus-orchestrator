// The story as the engine knows it, whatever tracker holds it (0010): one story with its fields,
// and one line of a story list. The StoryStore (`store.ts`) returns these; the Backlog.md
// implementation fills them from the CLI's `--plain` output (`backlog/plain.ts`).

/** A task, or a draft that is not a task yet. */
export type StoryKind = "task" | "draft";

/** The Ready gate rule a story that does not parse is reported as (0010, 0012 R02). */
export const PARSE_RULE = "R02";

/** Something the parser did not know, kept raw. */
export type UnknownItem =
  | { readonly kind: "header"; readonly line: number; readonly key: string; readonly value: string }
  | { readonly kind: "section"; readonly line: number; readonly name: string }
  | { readonly kind: "line"; readonly line: number; readonly text: string };

export interface ChecklistItem {
  readonly index: number;
  readonly checked: boolean;
  readonly text: string;
}

export interface TaskRef {
  readonly id: string;
  readonly title: string;
}

/** A first-level entry of the dependency graph. */
export interface DependencyEntry {
  readonly id: string;
  /** `missing` and `ambiguous` are ids the CLI could not resolve. */
  readonly state: "resolved" | "missing" | "ambiguous";
  readonly title?: string;
  /** The status in brackets, `completed` for a task in `completed/`. */
  readonly status?: string;
}

export interface Comment {
  readonly index: number;
  /** The rest of the comment's first line after `#n - `, for example `@bob - 2026-10-12 21:17 (UTC)`. */
  readonly byline: string;
  readonly body: string;
}

/** One task or draft as `task view --plain` or `draft view --plain` prints it. */
export interface PlainTask {
  readonly file: string;
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly priority?: string;
  readonly type?: string;
  readonly project?: string;
  readonly ordinal?: number;
  readonly assignee: readonly string[];
  readonly reporter?: string;
  /** As printed, for example `2026-10-12 21:17 (UTC)`; minute precision. */
  readonly created: string;
  readonly updated?: string;
  readonly due?: string;
  readonly labels: readonly string[];
  readonly milestone?: string;
  readonly parent?: { readonly id: string; readonly title?: string };
  readonly subtasks: readonly TaskRef[];
  readonly references: readonly string[];
  readonly documentation: readonly string[];
  readonly dependencies: readonly DependencyEntry[];
  /** Empty when the CLI printed `No description provided`. */
  readonly description: string;
  readonly acceptanceCriteria: readonly ChecklistItem[];
  readonly definitionOfDone: readonly ChecklistItem[];
  readonly implementationPlan?: string;
  readonly implementationNotes?: string;
  readonly modifiedFiles: readonly string[];
  readonly comments: readonly Comment[];
  readonly finalSummary?: string;
  /** Unknown keys, sections and lines, kept raw. */
  readonly unknown: readonly UnknownItem[];
}

/** One line of `task list --plain` or `draft list --plain`. */
export interface PlainListEntry {
  readonly id: string;
  readonly title: string;
  /** The group the line is in: a status for `task list`, `Drafts` for `draft list`. */
  readonly group: string;
  readonly priority?: string;
  readonly type?: string;
  readonly project?: string;
  /** From the `(ac: n/m)` count; absent when the task has no criteria. */
  readonly ac?: { readonly checked: number; readonly total: number };
  readonly due?: string;
}

export interface PlainList {
  readonly entries: readonly PlainListEntry[];
  readonly unknown: readonly UnknownItem[];
}
