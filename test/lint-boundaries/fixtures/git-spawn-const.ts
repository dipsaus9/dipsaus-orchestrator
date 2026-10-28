// Starts git through constants: the program bound to a name, and a shorthand `{ cmd }` whose list
// is a constant.
import { execFile } from "node:child_process";

import type { Spawn } from "@dipsaus-orchestrator/contract";

const GIT = "git";

export function head(spawn: Spawn) {
  const cmd = [GIT, "rev-parse", "HEAD"] as const;
  return spawn({ cmd, cwd: "/repo" });
}

export function status(): void {
  execFile(GIT, ["status"], () => undefined);
}
