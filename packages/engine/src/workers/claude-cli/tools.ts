// The Claude Code tools of each worker kind (0002, 0008, 0020, DIPO-310, DIPO-318). The engine says
// only which kind a session is and whether its developer may use the web; the tool names live here,
// and no spec can ask for any other tool.

import { PlanError, type WorkerSpec } from "../types";

/** The developer's tools in its box: read, edit, write, search the files and run the shell. */
export const DEVELOPER_TOOLS: readonly string[] = ["Read", "Edit", "Write", "Glob", "Grep", "Bash"];

/**
 * The web tools of the developer, which always has the web in its box (0008, DIPO-164); the
 * reviewer always has them too. The adapter's output lines read the same list.
 */
export const WEB_TOOLS: readonly string[] = ["WebSearch", "WebFetch"];

/**
 * The only tools a `review` session may have (0002): it reads the read-only copy of the pushed
 * commit and may search the web. No shell, no Edit or Write, and so no git or gh.
 */
export const REVIEW_TOOLS: readonly string[] = ["Read", "Glob", "Grep", ...WEB_TOOLS];

/**
 * The tools a session gets, from its kind alone, plus the web for a developer, which always has it
 * (0008): a `session` gets none (DIPO-310), a `review` the review set. Any other kind gets no tool
 * list at all: it is refused, never given the developer's.
 */
export function allowedTools(spec: Pick<WorkerSpec, "kind" | "web">): readonly string[] {
  switch (spec.kind) {
    case "session":
      return [];
    case "review":
      return REVIEW_TOOLS;
    case "implement":
      return spec.web ? [...DEVELOPER_TOOLS, ...WEB_TOOLS] : DEVELOPER_TOOLS;
    default:
      throw new PlanError(`no tools are named for worker kind "${String(spec.kind)}"`);
  }
}

/** Which web call a tool makes, for the run's counts (DIPO-164); undefined for any other tool. */
export function webCallOf(tool: string): "search" | "fetch" | undefined {
  if (tool === "WebSearch") return "search";
  if (tool === "WebFetch") return "fetch";
  return undefined;
}
