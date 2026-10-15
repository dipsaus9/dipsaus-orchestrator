// Claude Code hooks for the hook relay (0008 section 5, amendment of 2026-10-12; DIPO-59): which
// hooks the run settings file registers, how a Claude hook payload maps to the engine's neutral
// `HookEvent`, and how the engine's neutral `HookReply` becomes Claude's `PermissionRequest`
// output. Everything Claude-specific about hooks lives here; `engine/src/hooks` sees only the
// neutral shapes.

import type { HookEvent, HookReply } from "../../hooks/types";

/** The hooks the run settings file registers (0008 section 5), each `dipo hook <event>`. */
export const REGISTERED_HOOKS = [
  "SessionStart",
  "PermissionRequest",
  "PostToolUse",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "StopFailure",
  "PostCompact",
  "PostModelSwitch",
  "SessionEnd",
] as const;
export type RegisteredHook = (typeof REGISTERED_HOOKS)[number];

/** The hook whose call waits for the engine's decision. */
export const WAITING_HOOK: RegisteredHook = "PermissionRequest";

/** `timeouts.permissionWaitSeconds` when the launch context names none (0008 section 9). */
export const DEFAULT_PERMISSION_WAIT_SECONDS = 300;
/** The `PermissionRequest` hook's timeout is this much above the wait (0008 section 5). */
export const PERMISSION_HOOK_MARGIN_SECONDS = 30;
/** The timeout of every hook that does not wait; the relay ends within 2 s. */
export const HOOK_TIMEOUT_SECONDS = 5;

/** One argument quoted for `sh`: inside single quotes, a quote closes, escapes and reopens. */
export function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * How much longer the relay asks the worker host to hold a `PermissionRequest` call than the
 * engine waits for the maintainer, so the engine's timeout deny (with its reason) always reaches
 * the held call before the host gives up on it. The relay's own grace and the hook timeout lie
 * above both.
 */
export const HOST_WAIT_MARGIN_SECONDS = 10;

/**
 * An empty Bun config file in the run directory. Run from source, the hooks start Bun with it and
 * with `--no-env-file`, so no `bunfig.toml` (and its `preload`) or `.env` the worker could write
 * ever loads in a hook, which runs outside the sandbox.
 */
export const HOOK_BUNFIG_FILE = "hook-bunfig.toml";

/**
 * The hook command prefix: `cd <runDir> &&`, then the binary. A compiled binary loads no config
 * from its directory; a runtime plus entry script (run from source) gets an explicit empty config
 * and no env file, so nothing from the worktree, where Claude runs hooks, can change what runs.
 */
export function hookCommandLine(command: readonly [string, ...string[]], runDir: string): string {
  const [program, ...rest] = command;
  const argv =
    rest.length === 0
      ? [program]
      : [program, "--no-env-file", `--config=${runDir}/${HOOK_BUNFIG_FILE}`, ...rest];
  return `cd ${shellQuote(runDir)} && ${argv.map(shellQuote).join(" ")}`;
}

/**
 * The run settings file's `hooks` block: one command hook per registered event, running
 * `<dipo> hook <event>` with the binary's own path from the run directory. `PermissionRequest`
 * asks the host to hold the call `waitSeconds` plus a margin (see `HOST_WAIT_MARGIN_SECONDS`).
 */
export function hookSettings(
  command: readonly [string, ...string[]],
  waitSeconds: number,
  runDir: string,
): Record<string, unknown> {
  const prefix = hookCommandLine(command, runDir);
  const hooks: Record<string, unknown> = {};
  for (const event of REGISTERED_HOOKS) {
    const waits = event === WAITING_HOOK;
    hooks[event] = [
      {
        hooks: [
          {
            type: "command",
            command: `${prefix} hook ${event}${waits ? ` --wait ${waitSeconds + HOST_WAIT_MARGIN_SECONDS}` : ""}`,
            timeout: waits ? waitSeconds + PERMISSION_HOOK_MARGIN_SECONDS : HOOK_TIMEOUT_SECONDS,
          },
        ],
      },
    ];
  }
  return hooks;
}

/** The longest call summary a permission question shows. */
export const INPUT_SUMMARY_MAX = 200;

function oneLine(value: string): string {
  const flat = value.replaceAll(/\s+/g, " ").trim();
  return flat.length <= INPUT_SUMMARY_MAX ? flat : `${flat.slice(0, INPUT_SUMMARY_MAX - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A one-line summary of a tool call: the command, the path, the URL, else the input in short. */
export function inputSummary(input: unknown): string {
  if (!isRecord(input)) return input === undefined ? "" : oneLine(JSON.stringify(input));
  for (const key of ["command", "file_path", "path", "notebook_path", "url", "pattern"]) {
    const value = text(input[key]);
    if (value !== undefined) return oneLine(value);
  }
  return oneLine(JSON.stringify(input));
}

/**
 * Pure: the neutral hook event of one Claude hook payload, or null for an event the relay does not
 * register. `call` is the waiting call's id (the hook line's end offset), when known.
 */
export function hookEventOf(
  payload: Record<string, unknown>,
  call: number | null,
): HookEvent | null {
  const name = payload["hook_event_name"];
  const agentId = text(payload["agent_id"]);
  switch (name) {
    case "SessionStart": {
      const source = text(payload["source"]);
      return { kind: "sessionStarted", ...(source === undefined ? {} : { source }) };
    }
    case "PermissionRequest":
      return {
        kind: "permissionRequest",
        id: call,
        tool: text(payload["tool_name"]) ?? "unknown",
        input: inputSummary(payload["tool_input"]),
      };
    case "PostToolUse":
      return { kind: "toolUsed", tool: text(payload["tool_name"]) ?? "unknown" };
    case "Notification": {
      const type = text(payload["notification_type"]);
      return { kind: "notification", ...(type === undefined ? {} : { type }) };
    }
    case "SubagentStart":
      return { kind: "subagentStarted", ...(agentId === undefined ? {} : { agentId }) };
    case "SubagentStop":
      return { kind: "subagentStopped", ...(agentId === undefined ? {} : { agentId }) };
    case "Stop":
      return { kind: "stopped" };
    case "StopFailure": {
      const error = text(payload["error"]) ?? text(payload["error_type"]);
      return { kind: "stopFailed", ...(error === undefined ? {} : { error }) };
    }
    case "PostCompact": {
      const trigger = text(payload["trigger"]);
      return { kind: "compacted", ...(trigger === undefined ? {} : { trigger }) };
    }
    case "PostModelSwitch": {
      const to = text(payload["to_model"]);
      if (to === undefined) return null;
      const from = text(payload["from_model"]);
      return { kind: "modelSwitched", to, ...(from === undefined ? {} : { from }) };
    }
    case "SessionEnd": {
      const reason = text(payload["reason"]);
      return { kind: "sessionEnded", ...(reason === undefined ? {} : { reason }) };
    }
    default:
      return null;
  }
}

/** The deny message when the engine gives no reason. */
export const DEFAULT_DENY_MESSAGE = "The maintainer denied this call.";

/**
 * Pure: what `dipo hook PermissionRequest` prints for the engine's reply. No decision prints
 * nothing, so the call is denied (`--permission-prompts none`).
 */
export function permissionOutput(reply: HookReply): string {
  if (reply.decision === null) return "";
  const decision =
    reply.decision === "allow"
      ? { behavior: "allow" }
      : {
          behavior: "deny",
          message:
            reply.reason === undefined || reply.reason.trim() === ""
              ? DEFAULT_DENY_MESSAGE
              : reply.reason,
        };
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision },
  });
}
