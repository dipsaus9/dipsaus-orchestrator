// The prompts of a run's first session (DIPO-74; 0014 sections 1, 2, 4 and 9): the L1+L2 system
// file for `implement` (`implement-box` for a box worker, DIPO-272) and the developer role, and the L4 task message from the story, its
// dependencies and the context pack the default provider gathers from a checkout. A real run reads
// its new worktree; the dry run reads `_base`, which holds the same commit the worktree would start
// from. The session id is made here too: a UUID derived from an engine-made id.

import { createHash } from "node:crypto";

import type { FieldBlock } from "@dipsaus-orchestrator/contract";

import type { PlainTask } from "../backlog/plain";
import type { OfficeConfig } from "../config";
import { createDefaultProvider } from "../context/default-provider";
import { gatherContext } from "../context/gather";
import { sizeClassOfWorkspace } from "../context/size";
import type { ContextPack, Workspace } from "../context/types";
import type { NudgeSources } from "../hooks/nudges";
import { assembleTaskMessage, taskBudgetsFor } from "../prompts/assemble";
import type { BaseVerifyFacts } from "../prompts/base-verify";
import type { Section } from "../prompts/contract";
import type { HandoffFacts } from "../prompts/handoff";
import { promptStoryOf } from "../prompts/story";
import { renderSystemFile } from "../prompts/system";

/** The system file's name in the run directory (0014 section 1). */
export const SYSTEM_FILE = "system.md";

export interface RunPromptsInput {
  readonly view: PlainTask;
  readonly fields: FieldBlock;
  /** The F7 dependencies' views, in the story's dependency order. */
  readonly dependencies: readonly PlainTask[];
  /** Repo-relative path of the story's task file. */
  readonly taskFile: string;
  /** The checkout the context pack is gathered from. */
  readonly workspace: Workspace;
  /** The commit the story branch starts from. */
  readonly baseSha: string;
  readonly config: Pick<OfficeConfig, "prompt">;
  /** The handoff of a new session for a story with earlier work (0014 section 6, DIPO-51). */
  readonly handoff?: HandoffFacts;
  /** What verify said about the base commit in the worker's sandbox (DIPO-183); not known if absent. */
  readonly baseVerify?: BaseVerifyFacts;
  /** The developer works in its own box (DIPO-271): the box worker contract (DIPO-272). */
  readonly box?: boolean;
}

export interface RunPrompts {
  /** The system file's text (L1+L2). */
  readonly systemFile: string;
  /** The task message (L4), the first user message. */
  readonly taskMessage: string;
  /** The context pack and input paths the context and input nudges check (DIPO-60). */
  readonly nudgeSources: NudgeSources;
  /** The task message's sections in message order, measured per section (0014 section 2). */
  readonly sections: readonly Section[];
}

/** The nudge sources of a context pack: its item paths and the story's input paths. */
export function nudgeSourcesOf(
  pack: ContextPack,
  inputs: readonly string[],
): Pick<RunPrompts, "nudgeSources"> {
  return {
    nudgeSources: {
      context: [...new Set(pack.items.map((item) => item.path))].toSorted(),
      inputs: [...new Set(pack.inputs.paths.length > 0 ? pack.inputs.paths : inputs)].toSorted(),
    },
  };
}

/**
 * Renders the system file and the task message of a run's first session, or of a later new
 * session with its handoff block (DIPO-51).
 */
export async function renderRunPrompts(input: RunPromptsInput): Promise<RunPrompts> {
  const { workspace, config } = input;
  const story = promptStoryOf(input.view, {
    dependencies: input.dependencies,
    fields: input.fields,
    taskFile: input.taskFile,
  });
  const size = await sizeClassOfWorkspace(workspace);
  const budgets = config.prompt.budgets;
  const pack = await gatherContext({
    workspace,
    defaultProvider: createDefaultProvider({ workspace }),
    request: {
      storyId: story.id,
      outcome: story.outcome,
      criteria: story.criteria.map((criterion) => criterion.text),
      scope: story.scope,
      inputs: story.inputs,
      components: [],
      baseSha: input.baseSha,
      headSha: await workspace.headSha(),
      sizeClass: size,
      inputsBudget: budgets.inputs[size],
    },
    budget: budgets.context[size],
  });
  const task = assembleTaskMessage({
    story,
    pack,
    budgets: taskBudgetsFor(budgets, size),
    contractMax: config.prompt.contractMax,
    ...(input.handoff === undefined ? {} : { handoff: input.handoff }),
    ...(input.baseVerify === undefined ? {} : { baseVerify: input.baseVerify }),
  });
  return {
    systemFile: renderSystemFile(input.box === true ? "implement-box" : "implement", "developer"),
    taskMessage: task.text,
    sections: task.sections,
    ...nudgeSourcesOf(pack, story.inputs),
  };
}

/**
 * A version 4 UUID derived from an engine-made id (Claude Code session ids are UUIDs), so the
 * session id comes from the injected `IdSource` and the same id always gives the same UUID.
 */
export function sessionUuid(id: string): string {
  const hex = createHash("sha256").update(`dipo-session:${id}`).digest("hex").slice(0, 32);
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}
