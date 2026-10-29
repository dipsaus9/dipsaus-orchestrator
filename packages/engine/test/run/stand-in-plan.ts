// The launch plan the run tests start hosts with (DIPO-240): the Claude CLI plans a developer
// session only in its box, and these tests launch without box workers, so a worker port of theirs
// plans with this. It carries the flags and paths the tests read: model, effort, caps, tools,
// session, system file, environment and task message. A worktree path with a character that has a
// meaning in permission rules is refused as the reviewer's plan refuses it, so the launch's
// `run.planRefused` notice stays tested.

import { userMessageLine } from "../../src/workers/claude-cli/encode";
import { allowedTools } from "../../src/workers/claude-cli/tools";
import type { RunLaunchPaths } from "../../src/workers/port";
import { type LaunchPlan, PlanError, type WorkerSpec } from "../../src/workers/types";

export function standInPlan(
  spec: WorkerSpec,
  paths: RunLaunchPaths,
  claude = "/usr/local/bin/claude",
): LaunchPlan {
  const odd = [...spec.workdir].find((char) => "()[]{}*?!\\".includes(char));
  if (odd !== undefined) {
    throw new PlanError(
      `workdir holds a character with a meaning in permission rules: ${spec.workdir}`,
      { path: spec.workdir, character: odd },
    );
  }
  return {
    argv: [
      claude,
      "-p",
      "--output-format",
      "stream-json",
      spec.session.resume ? "--resume" : "--session-id",
      spec.session.id,
      "--model",
      spec.model,
      "--effort",
      spec.effort,
      "--max-turns",
      String(spec.caps.maxTurns),
      "--tools",
      allowedTools(spec).join(","),
      "--append-system-prompt-file",
      spec.systemFile,
    ],
    env: { PATH: "/usr/bin:/bin", DIPO_RUN: spec.run, DIPO_TMP: paths.shortTmpDir },
    cwd: spec.workdir,
    files: [],
    stdin: [userMessageLine(spec.taskMessage)],
  };
}
