// The Claude Code tools of each worker kind (0002, 0008, 0020, DIPO-310, DIPO-318, DIPO-447). The
// engine says only which kind a session is and whether its developer may use the web; the tool
// names live here, and no spec can ask for any other tool.
//
// A read-only kind (`review`, `planning`) is checked again where its tools leave dipo and where they
// come back: `checkReadOnlyTools` refuses any name that is not exactly one of the kind's own, so a
// writing tool asked for in another case (`bash`), as a rule (`Bash(*)`), under an alias
// (`MultiEdit`, `NotebookEdit`, `Task`) or from an MCP server (`mcp__<server>__<tool>`) never runs.

import { PlanError, type WorkerSpec } from "../types";

/** The developer's tools in its box: read, edit, write, search the files and run the shell. */
export const DEVELOPER_TOOLS: readonly string[] = ["Read", "Edit", "Write", "Glob", "Grep", "Bash"];

/**
 * The web tools of the developer, which always has the web in its box (0008, DIPO-164); the
 * reviewer and the planner always have them too. The adapter's output lines read the same list.
 */
export const WEB_TOOLS: readonly string[] = ["WebSearch", "WebFetch"];

/**
 * The only tools a `review` session may have (0002): it reads the read-only copy of the pushed
 * commit and may search the web. No shell, no Edit or Write, and so no git or gh.
 */
export const REVIEW_TOOLS: readonly string[] = ["Read", "Glob", "Grep", ...WEB_TOOLS];

/**
 * The only tools a `planning` session may have (DIPO-447): it reads and searches the read-only
 * copy of the base branch with the backlog, and may search and fetch the web. Nothing writes, runs
 * or starts another agent: what it proposes, dipo files.
 */
export const PLANNING_TOOLS: readonly string[] = ["Read", "Glob", "Grep", ...WEB_TOOLS];

/** The kinds whose sessions only read, with their tool sets. */
const READ_ONLY_TOOLS: Readonly<Record<string, readonly string[]>> = {
  review: REVIEW_TOOLS,
  planning: PLANNING_TOOLS,
};

/** True for a kind whose sessions only read (`review`, `planning`). */
export function isReadOnlyKind(kind: string): boolean {
  return Object.hasOwn(READ_ONLY_TOOLS, kind);
}

/**
 * The tools a session gets, from its kind alone, plus the web for a developer, which always has it
 * (0008): a `session` gets none (DIPO-310), a `review` the review set, a `planning` the planning
 * set. Any other kind gets no tool list at all: it is refused, never given the developer's.
 */
export function allowedTools(spec: Pick<WorkerSpec, "kind" | "web">): readonly string[] {
  switch (spec.kind) {
    case "session":
      return [];
    case "review":
      return REVIEW_TOOLS;
    case "planning":
      return PLANNING_TOOLS;
    case "implement":
      return spec.web ? [...DEVELOPER_TOOLS, ...WEB_TOOLS] : DEVELOPER_TOOLS;
    default:
      throw new PlanError(`no tools are named for worker kind "${String(spec.kind)}"`);
  }
}

/**
 * The tool names of `tools` a read-only `kind` may not have: every name that is not exactly one of
 * the kind's own. An empty list when all are its own; every name for a kind that is not read-only.
 */
export function foreignTools(kind: string, tools: readonly string[]): string[] {
  const own = READ_ONLY_TOOLS[kind];
  return tools.filter((tool) => own === undefined || !own.includes(tool));
}

/** Throws a `PlanError` unless every tool of `tools` is one of read-only `kind`'s own. */
export function checkReadOnlyTools(kind: string, tools: readonly string[]): void {
  const foreign = foreignTools(kind, tools);
  if (foreign.length > 0) {
    throw new PlanError(
      `a ${kind} session only reads: ${foreign.map((tool) => JSON.stringify(tool)).join(", ")} is not one of its tools (${(READ_ONLY_TOOLS[kind] ?? []).join(", ")})`,
    );
  }
}

/** Which web call a tool makes, for the run's counts (DIPO-164); undefined for any other tool. */
export function webCallOf(tool: string): "search" | "fetch" | undefined {
  if (tool === "WebSearch") return "search";
  if (tool === "WebFetch") return "fetch";
  return undefined;
}
