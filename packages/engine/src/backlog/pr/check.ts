// The structural check of a backlog-only PR (0010 section 2, lane b): the reviewer contract of a PR
// that changes only `backlog/`, decided by code alone. Pure: it reads the PR diff as the collector
// (`diff.ts`) gathered it and the stored facts the caller read, and the same input always gives the
// same result. Five rules, each failure naming its rule and, where there is one, its task:
//
// - `backlog-only`: every changed path is a Backlog file, a `.md` file under `backlog/` or
//   `backlog/config.yml`, except a new `.dipo/.gitignore`, the one file office init adds outside
//   it (0007 section 2, 0010 section 11; DIPO-36). Changing or removing an existing one fails the
//   rule. Every changed entry is a regular file on both sides: a symlink, a submodule or an
//   executable fails it, under `backlog/` too (DIPO-341).
// - `parses` (R02): every changed task or draft that still exists parses: its view, and its `dipo`
//   field block.
// - `transition`: each status change is a 0012 transition that lane b may write (below).
// - `ready-decision`: each task that becomes `Ready` has a passing Ready gate decision stored for
//   its content hash (DIPO-71).
// - `no-claim`: no changed task has a live claim (DIPO-38); such a story belongs to lane a.

import type { StoryKey } from "@dipsaus-orchestrator/contract";

import { gateStoryFromView } from "../../gate/input";
import { gateContentHash } from "../../gate/store/hash";
import { FieldBlockError, parseFieldBlock } from "../../story-store/fields/block";
import type { PlainTask } from "../../story-store/story";

export const CHECK_RULES = [
  "backlog-only",
  "parses",
  "transition",
  "ready-decision",
  "no-claim",
] as const;
export type CheckRule = (typeof CHECK_RULES)[number];

/** Where a task is on one side of the diff, and its view when the CLI can show it. */
export type TaskSide =
  | { readonly where: "absent" }
  | { readonly where: "task" | "draft"; readonly view: ParsedView }
  /** `backlog/archive/`: the story was dropped (Removed). */
  | { readonly where: "archived" }
  /** `backlog/completed/`. */
  | { readonly where: "completed" };

export type ParsedView =
  | { readonly ok: true; readonly task: PlainTask }
  | { readonly ok: false; readonly error: string };

/** One task or draft whose file the PR changed, by its Backlog.md id. */
export interface TaskChange {
  readonly id: string;
  readonly before: TaskSide;
  readonly after: TaskSide;
}

/**
 * Paths outside `backlog/` a backlog PR may add, never change or remove: the `.dipo/.gitignore`
 * office init adds only if absent (0007 section 2, DIPO-36).
 */
export const ADDED_OUTSIDE_BACKLOG: readonly string[] = [".dipo/.gitignore"];

/**
 * The file modes of a regular file on one side of `git diff --raw`: `100644`, or `000000` on the
 * side where the file is absent (an add or a delete).
 */
export const REGULAR_MODES: readonly string[] = ["100644", "000000"];

/** A Backlog file a backlog PR may change: a `.md` file under `backlog/`, or `backlog/config.yml`. */
export function isBacklogFile(path: string): boolean {
  return path === "backlog/config.yml" || (path.startsWith("backlog/") && path.endsWith(".md"));
}

/** The PR diff: every changed path, and the tasks among them on both sides. */
export interface PrDiff {
  /** Paths changed between the merge base and the head, repository-relative. */
  readonly paths: readonly string[];
  /** The paths among `paths` the PR adds (absent at the merge base); absent means none. */
  readonly added?: readonly string[];
  /**
   * The paths among `paths` that are not a regular file on one side (a mode outside
   * `REGULAR_MODES`); absent means none.
   */
  readonly irregular?: readonly string[];
  readonly tasks: readonly TaskChange[];
}

/** What the engine has stored, read by the caller for the tasks of the diff. */
export interface PrFacts {
  /** The StoryKey of each task id the engine knows. */
  readonly keys: Readonly<Record<string, StoryKey>>;
  /** Keys with a live claim. */
  readonly claimed: readonly StoryKey[];
  /** Content hashes with a passing Ready gate decision, per key. */
  readonly passing: Readonly<Record<string, readonly string[]>>;
}

export interface CheckFailure {
  readonly rule: CheckRule;
  /** The task the failure is about; absent for a PR-wide failure. */
  readonly task?: string;
  readonly key?: StoryKey;
  readonly message: string;
}

export interface CheckResult {
  readonly passed: boolean;
  readonly failures: readonly CheckFailure[];
  /** The keys of every changed task the engine knows. */
  readonly touched: readonly StoryKey[];
}

/** The lifecycle state a side shows: a status, `Draft`, `Removed`, `Done` or null when absent. */
export function stateOf(side: TaskSide): string | null {
  switch (side.where) {
    case "absent":
      return null;
    case "draft":
      return "Draft";
    case "archived":
      return "Removed";
    case "completed":
      return "Done";
    case "task":
      return side.view.ok ? side.view.task.status : null;
  }
}

/**
 * The status changes a backlog-only PR may make (0012 section 2 with its 0010 amendments): the
 * transitions written in lane b. `null` is "no file": a new draft, a promotion (the draft goes and
 * a Refined task appears), and the office-init migration from `To Do`. Everything from In Progress
 * onward belongs to the story PR (lane a).
 */
export const LANE_B_TRANSITIONS: readonly (readonly [string | null, string | null])[] = [
  [null, "Draft"],
  [null, "Refined"],
  ["Draft", null],
  ["Draft", "Refined"],
  ["Draft", "Removed"],
  ["To Do", "Refined"],
  ["Refined", "Ready"],
  ["Ready", "Refined"],
  ["Refined", "Parked"],
  ["Ready", "Parked"],
  ["Parked", "Refined"],
  ["Parked", "Ready"],
  ["Refined", "Removed"],
  ["Ready", "Removed"],
  ["Parked", "Removed"],
];

function allowed(from: string | null, to: string | null): boolean {
  if (from === to) return true;
  return LANE_B_TRANSITIONS.some(([a, b]) => a === from && b === to);
}

function name(state: string | null): string {
  return state === null ? "no file" : state;
}

/** Checks the PR. Every failure is reported, not only the first. */
export function checkBacklogPr(diff: PrDiff, facts: PrFacts): CheckResult {
  const failures: CheckFailure[] = [];
  const claimed = new Set(facts.claimed);
  const touched: StoryKey[] = [];

  const added = new Set(diff.added ?? []);
  const outside = diff.paths.filter(
    (path) => !isBacklogFile(path) && !(ADDED_OUTSIDE_BACKLOG.includes(path) && added.has(path)),
  );
  if (outside.length > 0) {
    failures.push({
      rule: "backlog-only",
      message: `the PR changes paths that are not Backlog files (a .md file under backlog/, or backlog/config.yml): ${outside.join(", ")}`,
    });
  }
  const irregular = diff.irregular ?? [];
  if (irregular.length > 0) {
    failures.push({
      rule: "backlog-only",
      message: `the PR changes entries that are not regular files (a symlink, a submodule or an executable): ${irregular.join(", ")}`,
    });
  }

  for (const change of [...diff.tasks].toSorted((a, b) => a.id.localeCompare(b.id))) {
    const key = facts.keys[change.id];
    if (key !== undefined && !touched.includes(key)) touched.push(key);
    const fail = (rule: CheckRule, message: string) =>
      failures.push({ rule, task: change.id, ...(key === undefined ? {} : { key }), message });

    const after = change.after;
    if (after.where === "task" || after.where === "draft") {
      if (!after.view.ok) {
        fail("parses", `${change.id} does not parse: ${after.view.error}`);
      } else {
        try {
          parseFieldBlock(after.view.task.description);
        } catch (error) {
          if (!(error instanceof FieldBlockError)) throw error;
          fail("parses", `${change.id} has an invalid field block: ${error.message}`);
        }
      }
    }

    const from = stateOf(change.before);
    const to = stateOf(change.after);
    const beforeKnown = !(change.before.where === "task" && !change.before.view.ok);
    const afterKnown = !(after.where === "task" && !after.view.ok);
    if (beforeKnown && afterKnown && !allowed(from, to)) {
      fail(
        "transition",
        `${change.id} moves from ${name(from)} to ${name(to)}, which a backlog PR may not do (0012 section 2)`,
      );
    }

    if (to === "Ready" && from !== "Ready" && after.where === "task" && after.view.ok) {
      const task = after.view.task;
      const hash = gateContentHash(
        gateStoryFromView(
          task,
          task.subtasks.map((sub) => sub.id),
        ),
      );
      if (key === undefined) {
        fail(
          "ready-decision",
          `${change.id} becomes Ready, but dipo knows no story with this id, so no Ready gate decision can match it`,
        );
      } else if (!(facts.passing[key] ?? []).includes(hash)) {
        fail(
          "ready-decision",
          `${change.id} becomes Ready without a passing Ready gate decision for its content; run \`ready ${change.id}\` again`,
        );
      }
    }

    if (key !== undefined && claimed.has(key)) {
      fail(
        "no-claim",
        `${change.id} has a live claim, so its changes belong in its story PR, not a backlog PR`,
      );
    }
  }

  return { passed: failures.length === 0, failures, touched };
}
