// External tools and the daemon's own executable (DIPO-70, 0006 decisions 5 and 14).
//
// At start the daemon resolves the absolute paths of the tools it runs from its own `PATH`, which
// the starting client kept, so a launchd or SSH start uses the same tools as the maintainer's
// shell. A tool that is not found is reported as missing; it does not stop the start.
//
// Every 60 s the daemon compares a stamp of its executable with the one taken at start; a
// different stamp means the binary on disk was replaced (`upgrade pending`).

import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { ToolPaths } from "@dipsaus-orchestrator/contract";

/** The tools the daemon resolves at start, in report order. */
export const TOOL_NAMES = ["claude", "backlog", "gh", "rg", "git"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** True when `path` is a regular file this process may execute. Injectable for tests. */
export type IsExecutable = (path: string) => boolean;

export const systemIsExecutable: IsExecutable = (path) => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export interface ResolvedTools {
  /** Absolute paths of the tools found; a missing tool is absent (the `daemon.status` shape). */
  readonly paths: ToolPaths;
  /** The tools not found on `PATH`. */
  readonly missing: readonly ToolName[];
}

/**
 * Resolves each tool to the first executable `<dir>/<tool>` along `pathEnv`, as a shell would.
 * Empty and relative `PATH` entries are skipped: they depend on the working directory.
 */
export function resolveTools(
  pathEnv: string | undefined,
  isExecutable: IsExecutable = systemIsExecutable,
): ResolvedTools {
  const dirs = (pathEnv ?? "").split(":").filter((dir) => dir !== "" && isAbsolute(dir));
  const paths: Partial<Record<ToolName, string>> = {};
  const missing: ToolName[] = [];
  for (const tool of TOOL_NAMES) {
    const found = dirs.map((dir) => join(dir, tool)).find((path) => isExecutable(path));
    if (found === undefined) missing.push(tool);
    else paths[tool] = found;
  }
  return { paths, missing };
}

/** What identifies one version of a file on disk; a replaced binary differs in at least one. */
export interface ExecutableStamp {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}

/** Reads the stamp of `path`; null when the file cannot be read (for example while it is replaced). */
export type ReadExecutableStamp = (path: string) => ExecutableStamp | null;

export const systemExecutableStamp: ReadExecutableStamp = (path) => {
  try {
    const stat = statSync(path);
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
};

export function sameStamp(a: ExecutableStamp, b: ExecutableStamp): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}
