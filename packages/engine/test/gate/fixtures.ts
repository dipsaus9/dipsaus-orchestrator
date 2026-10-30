// Gate fixtures: one story that passes every rule, and helpers to break exactly one thing.

import { OFFICE_DEFAULTS } from "../../src/config/schema";
import type { GateConfig, GateInput, GateStory, GateTask } from "../../src/gate";

export const ID = "DIPO-7";
export const BRANCH = "DIPO-7/export-rows-to-csv";
export const OUTCOME = "Outcome: the export writes every row of the table to a CSV file.";

export const DEFAULT_CONFIG: GateConfig = {
  story: OFFICE_DEFAULTS.story,
  prompt: { contractMax: OFFICE_DEFAULTS.prompt.contractMax },
};

/** A field block with the given YAML content lines. */
export function block(...lines: string[]): string {
  return ["```dipo", ...lines, "```"].join("\n");
}

export const PASSING_BLOCK = block(
  `branch: "${BRANCH}"`,
  "unknowns:",
  '  - q: "Which delimiter?"',
  '    status: "resolved"',
  '    answer: "A comma."',
  "test_plan:",
  "  entries:",
  '    - kind: "automated"',
  '      check: "the export writes one line per row"',
);

/** A description: the outcome line, some context and the given block. */
export function description(fieldBlock: string = PASSING_BLOCK, outcome: string = OUTCOME): string {
  return `${outcome}\n\nContext: the export runs nightly.\n\n${fieldBlock}`;
}

export const PASSING_STORY: GateStory = {
  id: ID,
  title: "Export rows to CSV",
  status: "Refined",
  type: "feature",
  milestone: "m-0",
  labels: ["tier:M"],
  description: description(),
  acceptanceCriteria: [
    { index: 1, checked: false, text: "The export writes a header line first" },
    { index: 2, checked: false, text: "Each row becomes one CSV line" },
  ],
  references: ["packages/export/", "docs/export.md"],
  documentation: ["docs/design/DIPO-4/flow.md"],
  dependencies: ["DIPO-3", "DIPO-4"],
  subtasks: [],
  implementationPlan: "Reuse the existing row iterator.",
};

export const ACTIVE_TASKS: readonly GateTask[] = [
  { id: ID, dependencies: ["DIPO-3", "DIPO-4"], branch: BRANCH },
  { id: "DIPO-3", dependencies: [], branch: "DIPO-3/add-the-table" },
  { id: "DIPO-4", dependencies: ["DIPO-3"], branch: "DIPO-4/design-the-export" },
];

/** The folders the Backlog.md store names in a repository with no root configuration. */
export const STORY_FOLDERS: readonly string[] = ["backlog", ".backlog"];

export function input(
  story: Partial<GateStory> = {},
  rest: Partial<Omit<GateInput, "story">> = {},
): GateInput {
  return {
    story: { ...PASSING_STORY, ...story },
    activeTasks: ACTIVE_TASKS,
    milestones: ["m-0", "m-1"],
    storyFolders: STORY_FOLDERS,
    config: DEFAULT_CONFIG,
    ...rest,
  };
}

export function config(story: Partial<GateConfig["story"]>, contractMax?: number): GateConfig {
  return {
    story: { ...DEFAULT_CONFIG.story, ...story },
    prompt: { contractMax: contractMax ?? DEFAULT_CONFIG.prompt.contractMax },
  };
}
