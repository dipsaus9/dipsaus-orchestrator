// Starts git by an absolute path, matched by its basename.
import type { Spawn } from "@dipsaus-orchestrator/contract";

export function head(spawn: Spawn) {
  return spawn({ cmd: ["/usr/bin/git", "rev-parse", "HEAD"], cwd: "/repo" });
}
