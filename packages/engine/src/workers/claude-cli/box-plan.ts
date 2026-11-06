// The launch plan of a box worker (DIPO-271, 0008): Claude Code runs inside the story's box as a
// long-running `container exec`, with the same stream-json input and output dipo reads from a
// session on the Mac, so ingestion, the caps and the live view see the same stream.
//
// Inside the box the worker runs with all permissions (`--permission-mode bypassPermissions`), so
// no guard is planned inside it: no run settings file, no permission rules, no hooks. The box is
// the boundary (0008: no per-call checks inside the box).
//
// Its environment in the box is the session's route environment (`BoxSession.env`: the model
// proxy's `boxModelEnvironment`, and `boxRouteEnv` for the web proxy, NO_PROXY and the Safe-Chain
// CA bundle) plus what Claude Code needs: IS_SANDBOX, without which it refuses all permissions as
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
//
// A planning session (DIPO-447) runs as a reviewer does, in a read-only box of its own
// (`BoxWorkers.planning`) with a copy of the base branch and the backlog, with only the planning
// tools and no structured-output schema: the maintainer talks to it turn by turn and it answers in
// text. The plan of either read-only kind is checked once it is built (`checkReadOnlyArgv`): one
// `--tools` with only the kind's own tools, no other flag that names tools, permissions, settings,
// plugins or MCP servers, and `--strict-mcp-config`. Text the maintainer writes (the goal, each
// message) reaches the session only on stdin, never on argv.

import { allowedTools, checkReadOnlyTools, isReadOnlyKind } from "./tools";
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

/** The flag that makes Claude Code echo each user message as it reads it (DIPO-412). */
export const REPLAY_USER_MESSAGES = "--replay-user-messages";

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
    // Each user message is echoed as the session reads it, so dipo sees when a steer is read
    // (DIPO-412, `interpret.ts`).
    REPLAY_USER_MESSAGES,
    "--session-id",
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
    // A reviewer or planner loads nothing of the copy it reads: only the box user's settings, and
    // the copy as a directory its read tools reach, never its working directory.
    ...(isReadOnlyKind(spec.kind)
      ? ["--setting-sources", "user", "--add-dir", REVIEW_CODE_DIR]
      : []),
    "--strict-mcp-config",
    "--append-system-prompt-file",
    session.systemFile,
    "--exclude-dynamic-system-prompt-sections",
    DISABLE_SLASH_COMMANDS,
    // A planning session answers the maintainer in text: its turns end in no report.
    ...(spec.kind === "planning" ? [] : ["--json-schema", JSON.stringify(spec.reportSchema)]),
  ];
}

/**
 * Flags a read-only session's plan never holds (DIPO-447): each would add tools, permissions,
 * settings, plugins, agents or MCP servers to the kind's own. Compared without case, alone or as
 * `--flag=value`.
 */
export const READ_ONLY_REFUSED_FLAGS: readonly string[] = [
  "--allowedtools",
  "--allowed-tools",
  "--disallowedtools",
  "--disallowed-tools",
  "--mcp-config",
  "--settings",
  "--plugin-dir",
  "--agents",
  "--permission-prompt-tool",
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
];

/**
 * Throws a `PlanError` unless the argv of a read-only session (`review`, `planning`) holds exactly
 * one `--tools` with only the kind's own tools, none of `READ_ONLY_REFUSED_FLAGS` and
 * `--strict-mcp-config`.
 */
export function checkReadOnlyArgv(kind: string, argv: readonly string[]): void {
  const flags = argv.map((arg) => arg.toLowerCase().split("=", 1)[0] ?? "");
  const refused = flags.filter((flag) => READ_ONLY_REFUSED_FLAGS.includes(flag));
  if (refused.length > 0) {
    throw new PlanError(`a ${kind} session's plan may not pass ${refused.join(", ")}`);
  }
  const tools = flags.flatMap((flag, index) => (flag === "--tools" ? [index] : []));
  const at = tools[0];
  if (tools.length !== 1 || at === undefined || argv[at] !== "--tools") {
    throw new PlanError(`a ${kind} session's plan passes exactly one --tools with its own tools`);
  }
  const listed = argv[at + 1] ?? "";
  checkReadOnlyTools(
    kind,
    listed.split(",").filter((tool) => tool !== ""),
  );
  if (!flags.includes("--strict-mcp-config")) {
    throw new PlanError(
      `a ${kind} session's plan passes --strict-mcp-config: it loads no MCP server`,
    );
  }
}

/**
 * Pure: the launch plan of a developer session in `session`'s box, or of a reviewer or planning
 * session in its read-only box. `runDir` is the host's working directory on the Mac (the run
 * directory); nothing of it reaches the box.
 */
export function planInBox(spec: WorkerSpec, session: BoxSession, runDir: string): LaunchPlan {
  checkSpec(spec);
  if (spec.kind !== "implement" && spec.kind !== "review" && spec.kind !== "planning") {
    throw new PlanError(
      `only a developer, reviewer or planning session runs in a box, not a ${spec.kind} session`,
    );
  }
  if (!runDir.startsWith("/")) throw new PlanError(`runDir must be an absolute path: ${runDir}`);
  const env = { ...session.env, ...BOX_CLAUDE_ENV };
  const argv = boxClaudeArgv(spec, session);
  if (isReadOnlyKind(spec.kind)) checkReadOnlyArgv(spec.kind, argv);
  const client = session.exec(argv, env);
  return {
    argv: client.argv,
    env: { ...client.env },
    cwd: runDir,
    files: [],
    stdin: [userMessageLine(spec.taskMessage)],
    stopCommand: session.stop.argv,
  };
}
