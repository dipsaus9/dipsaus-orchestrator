// The story data a task message is built from (0014 section 2, 0012 fields), read from the parsed
// `task view --plain` output and the parsed field block. Pure: the caller runs the CLI.

import type { FieldBlock, FieldBlockUnknown, TestPlan } from "@dipsaus-orchestrator/contract";

import { locateBlock } from "../backlog/fields/block";
import { readLabels } from "../backlog/fields/labels";
import type { PlainTask } from "../backlog/plain";

const OUTCOME_PREFIX = "Outcome:";

export interface PromptCriterion {
  /** The number Backlog.md prints. */
  readonly index: number;
  readonly text: string;
}

/** One F7 dependency: its id, title and outcome line. */
export interface PromptDependency {
  readonly id: string;
  readonly title: string;
  /** Empty when the dependency has no `Outcome:` line. */
  readonly outcome: string;
}

export interface PromptStory {
  /** F1. */
  readonly id: string;
  /** F2. */
  readonly title: string;
  /** F5; undefined when the story has none. */
  readonly type: string | undefined;
  /** F11, the `<T>` of `tier:<T>`; undefined when the story has none. */
  readonly tier: string | undefined;
  /** F3. */
  readonly outcome: string;
  /** F4, in Backlog.md order. */
  readonly criteria: readonly PromptCriterion[];
  /** F8. */
  readonly scope: readonly string[];
  /** F9. */
  readonly inputs: readonly string[];
  /** F7, in Backlog.md order. */
  readonly dependencies: readonly PromptDependency[];
  /** The description outside the `Outcome:` line and the field block, trimmed. */
  readonly background: string;
  /** F14; undefined when the field block has none. */
  readonly testPlan: TestPlan | undefined;
  /** F10. */
  readonly unknowns: readonly FieldBlockUnknown[];
  /** F17, the implementation plan; empty when there is none. */
  readonly instructions: string;
  /** Repo-relative path of the task file, named by a background cut marker. */
  readonly taskFile: string;
}

/** The text after `Outcome:` of each description line that starts with it, trimmed, joined. */
export function outcomeOf(description: string): string {
  return description
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.startsWith(OUTCOME_PREFIX))
    .map((line) => line.slice(OUTCOME_PREFIX.length).trim())
    .join("\n");
}

/**
 * The free text of a description (0014 section 2, `background`): every line except the
 * `Outcome:` lines and the field block with its fences, with runs of blank lines collapsed and
 * the ends trimmed. Throws `FieldBlockError` for a block that does not parse (the gate's R02).
 */
export function backgroundOf(description: string): string {
  const text = description.replace(/\r\n?/g, "\n");
  const block = locateBlock(text);
  // The content ends in a newline, so splitting it gives one entry per content line plus one.
  const closeLine =
    block === undefined
      ? 0
      : block.openLine + text.slice(block.contentStart, block.contentEnd).split("\n").length;
  const kept = text.split("\n").filter((line, index) => {
    if (line.startsWith(OUTCOME_PREFIX)) return false;
    if (block === undefined) return true;
    return index + 1 < block.openLine || index + 1 > closeLine;
  });
  return kept
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface PromptStoryOptions {
  /** The F7 dependencies as `task view --plain` shows them, in the story's dependency order. */
  readonly dependencies: readonly PlainTask[];
  readonly fields: FieldBlock;
  /** Repo-relative task file path. */
  readonly taskFile: string;
}

/** The prompt's view of a story. */
export function promptStoryOf(task: PlainTask, options: PromptStoryOptions): PromptStory {
  const labels = readLabels(task.labels);
  return {
    id: task.id,
    title: task.title,
    type: task.type,
    tier: labels.tiers[0],
    outcome: outcomeOf(task.description),
    criteria: task.acceptanceCriteria.map(({ index, text }) => ({ index, text })),
    scope: task.references,
    inputs: task.documentation,
    dependencies: options.dependencies.map((dep) => ({
      id: dep.id,
      title: dep.title,
      outcome: outcomeOf(dep.description),
    })),
    background: backgroundOf(task.description),
    testPlan: options.fields.test_plan,
    unknowns: options.fields.unknowns ?? [],
    instructions: task.implementationPlan?.trim() ?? "",
    taskFile: options.taskFile,
  };
}
