// Inputs and verdict of the Ready gate (0012 section 3, R26 from 0014 section 4). The caller reads
// the story, the office's active tasks and its milestones through the Backlog CLI and passes them
// in; the gate itself reads nothing.

import type { OfficeConfig } from "../config/schema";

/** `ready` evaluates R01a, `pickup` (the re-check inside `work.run`) R01b; both add R02 to R26. */
export type GateMode = "ready" | "pickup";

export const GATE_RULES = [
  "R01a",
  "R01b",
  "R02",
  "R03",
  "R04",
  "R05",
  "R06",
  "R07",
  "R08",
  "R09",
  "R10",
  "R11",
  "R12",
  "R13",
  "R14",
  "R15",
  "R16",
  "R17",
  "R18",
  "R19",
  "R20",
  "R21",
  "R22",
  "R23",
  "R24",
  "R25",
  "R26",
] as const;
export type GateRule = (typeof GATE_RULES)[number];

export interface GateCriterion {
  /** The number Backlog.md prints, `#<n>`. */
  readonly index: number;
  readonly checked: boolean;
  readonly text: string;
}

/** The story under evaluation, as `task view --plain` shows it (a subset of `PlainTask`). */
export interface GateStory {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly type?: string;
  readonly milestone?: string;
  readonly labels: readonly string[];
  /** The full description, `dipo` field block included. */
  readonly description: string;
  readonly acceptanceCriteria: readonly GateCriterion[];
  /** Declared scope (F8). */
  readonly references: readonly string[];
  /** Inputs (F9). */
  readonly documentation: readonly string[];
  readonly dependencies: readonly string[];
  /** Ids from `task list -p <ID>` (R03). */
  readonly subtasks: readonly string[];
  /** Extra instructions (F17). */
  readonly implementationPlan?: string;
  /** The dependencies that are not Done on the base, from `openDependencies` (DIPO-179). */
  readonly waitingOn?: readonly GateDependency[];
}

/** A dependency of the story that is not Done: its id, and its status when the CLI read it. */
export interface GateDependency {
  readonly id: string;
  readonly status?: string;
}

/** One active task of the office (0012: any task `task list --plain` returns). */
export interface GateTask {
  readonly id: string;
  readonly dependencies: readonly string[];
  /** F15 from its field block, when it has one that parses. */
  readonly branch?: string;
}

/** A roster role (0011). `code: false` marks a non-code role such as a designer (M4). */
export interface GateRole {
  readonly name: string;
  readonly code: boolean;
}

/** Until M4 the only role is the built-in `developer` (0012 F12). */
export const BUILT_IN_ROSTER: readonly GateRole[] = [{ name: "developer", code: true }];

/** The office configuration keys the gate reads. */
export interface GateConfig {
  readonly story: OfficeConfig["story"];
  readonly prompt: Pick<OfficeConfig["prompt"], "contractMax">;
}

export interface GateInput {
  readonly story: GateStory;
  /** Every active task, the story itself included when it is active. */
  readonly activeTasks: readonly GateTask[];
  /** Milestone ids and names that exist in the office (R07). */
  readonly milestones: readonly string[];
  readonly config: GateConfig;
  /** Defaults to `BUILT_IN_ROSTER`. */
  readonly roster?: readonly GateRole[];
}

export interface GateFailure {
  readonly rule: GateRule;
  /** `ready <ID> failed <rule>: <0012 message>`. */
  readonly message: string;
}

export interface GateResult {
  readonly mode: GateMode;
  /** True only with zero failures. */
  readonly passed: boolean;
  /** Every failure, in rule order. */
  readonly failures: readonly GateFailure[];
  /** The open dependencies of the story, absent when none (DIPO-179); they do not change `passed`. */
  readonly waitingOn?: readonly GateDependency[];
}
