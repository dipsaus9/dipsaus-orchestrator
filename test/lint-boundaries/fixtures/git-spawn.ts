// Starts git outside the git module: through an injected spawn, and through node:child_process.
import { execFile } from "node:child_process";

import type { Spawn } from "@dipsaus-orchestrator/contract";

export function head(spawn: Spawn, program?: string) {
  return spawn({ cmd: [program ?? "git", "rev-parse", "HEAD"], cwd: "/repo" });
}

export function status(): void {
  execFile("git", ["status", "--porcelain"], () => undefined);
}
