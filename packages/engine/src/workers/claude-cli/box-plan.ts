// The launch plan of a box worker (DIPO-271, 0021 sections 1, 4 and 7): Claude Code runs inside the
// story's box as a long-running `container exec`, with the same stream-json input and output dipo
// reads from a worker on the Mac, so ingestion, the caps and the live view see the same stream.
//
// Inside the box the worker runs with all permissions (`--permission-mode bypassPermissions`), so
// none of the Mac worker's guards are planned: no run settings file with its Bash sandbox and
// permission rules, no hooks and so no `dipo hook` or host socket, no permission relay. The box is
// the boundary (0021 section 7: no per-call checks inside the box).
//
// Its environment in the box is the session's route environment (`BoxSession.env`: the model
// proxy's `boxModelEnvironment`, HTTPS_PROXY and HTTP_PROXY for the web proxy and the Safe-Chain
// CA bundle) plus what Claude Code needs: IS_SANDBOX, without which it refuses all permissions as
// root, and the session state events dipo's watchdog reads. Nothing comes from the Mac's
// environment; the `container` client on the Mac gets only the backend's client environment.
// The host runs the session's stop command when it signals the worker and after the worker
// exits, since a killed `container exec` client leaves claude running in the box.

import type { BoxSession } from "../../box/workers";
import type { LaunchPlan, WorkerSpec } from "../types";
import { PlanError } from "../types";
import { userMessageLine } from "./encode";
import { checkSpec, flagValue, INCLUDE_PARTIAL_MESSAGES } from "./plan";
import { DISABLE_SLASH_COMMANDS } from "./skills";

/** Claude Code in the box image: npm's global prefix there is /usr/local (DIPO-266). */
export const BOX_CLAUDE = "/usr/local/bin/claude";

/** What Claude Code itself needs in a box, on top of the session's route environment. */
export const BOX_CLAUDE_ENV: Readonly<Record<string, string>> = {
  // Claude Code refuses all permissions to root unless it is told it runs in a sandbox.
  IS_SANDBOX: "1",
  // The session state events the watchdog reads as liveness, as on the Mac.
  CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
};

/** The argv of Claude Code inside the box for one session. */
export function boxClaudeArgv(spec: WorkerSpec, session: BoxSession): [string, ...string[]] {
  return [
    BOX_CLAUDE,
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    // As on the Mac: the live view counts the session's output from the stream events (DIPO-296).
    INCLUDE_PARTIAL_MESSAGES,
    spec.session.resume ? "--resume" : "--session-id",
    spec.session.id,
    "--model",
    flagValue("model", spec.model),
    "--effort",
    flagValue("effort", spec.effort),
    "--max-turns",
    String(spec.caps.maxTurns),
    "--permission-mode",
    "bypassPermissions",
    "--tools",
    spec.tools.allow.join(","),
    "--strict-mcp-config",
    "--append-system-prompt-file",
    session.systemFile,
    "--exclude-dynamic-system-prompt-sections",
    DISABLE_SLASH_COMMANDS,
    "--json-schema",
    JSON.stringify(spec.reportSchema),
  ];
}

/**
 * Pure: the launch plan of a developer session in `session`'s box. `runDir` is the host's working
 * directory on the Mac (the run directory); nothing of it reaches the box.
 */
export function planInBox(spec: WorkerSpec, session: BoxSession, runDir: string): LaunchPlan {
  checkSpec(spec);
  if (spec.kind !== "implement") {
    throw new PlanError(`only a developer session runs in a box, not a ${spec.kind} session`);
  }
  if (!runDir.startsWith("/")) throw new PlanError(`runDir must be an absolute path: ${runDir}`);
  const env = { ...session.env, ...BOX_CLAUDE_ENV };
  const client = session.exec(boxClaudeArgv(spec, session), env);
  return {
    argv: client.argv,
    env: { ...client.env },
    cwd: runDir,
    files: [],
    stdin: [userMessageLine(spec.taskMessage)],
    stopCommand: session.stop.argv,
  };
}
