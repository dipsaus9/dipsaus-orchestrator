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
// proxy's `boxModelEnvironment`, and `boxRouteEnv` for the web proxy, NO_PROXY and the
// Safe-Chain CA bundle) plus what Claude Code needs: IS_SANDBOX, without which it refuses all permissions as
// root, and the session state events dipo's watchdog reads. Nothing comes from the Mac's
// environment; the `container` client on the Mac gets only the backend's client environment.
// The host runs the session's stop command when it signals the worker and after the worker
// exits, since a killed `container exec` client leaves claude running in the box.
//
// A reviewer session (0002, 0008) runs the same way in its own read-only box (`BoxWorkers.review`),
// with only the reviewer's tools (`--tools`, named by `allowedTools` from its kind), its empty
// working directory beside the copy and the copy added as a directory (`--add-dir`), and only the
// box user's settings (`--setting-sources user`): no settings, hooks or MCP servers of the copy
// load.

import { allowedTools } from "./tools";
import { BOX_NPM_PREFIX } from "../../box/firewall";
import { REVIEW_CODE_DIR } from "../../box/review-box";
import type { BoxSession } from "../../box/workers";
import type { LaunchPlan, WorkerSpec } from "../types";
import { PlanError } from "../types";
import { userMessageLine } from "./encode";
import { checkSpec, flagValue, INCLUDE_PARTIAL_MESSAGES } from "./plan";
import { DISABLE_SLASH_COMMANDS } from "./skills";

/** Claude Code in the box image: in the box user's npm prefix (DIPO-266, DIPO-334). */
export const BOX_CLAUDE = `${BOX_NPM_PREFIX}/bin/claude`;

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
    allowedTools(spec).join(","),
    // A reviewer loads nothing of the copy it reviews: only the box user's settings, and the copy
    // as a directory its read tools reach, never its working directory.
    ...(spec.kind === "review" ? ["--setting-sources", "user", "--add-dir", REVIEW_CODE_DIR] : []),
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
 * Pure: the launch plan of a developer session in `session`'s box, or of a reviewer session in its
 * reviewer box. `runDir` is the host's working directory on the Mac (the run directory); nothing
 * of it reaches the box.
 */
export function planInBox(spec: WorkerSpec, session: BoxSession, runDir: string): LaunchPlan {
  checkSpec(spec);
  if (spec.kind !== "implement" && spec.kind !== "review") {
    throw new PlanError(
      `only a developer or reviewer session runs in a box, not a ${spec.kind} session`,
    );
  }
  if (spec.kind === "review" && spec.session.resume) {
    throw new PlanError("a reviewer session is never resumed (0002)");
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
