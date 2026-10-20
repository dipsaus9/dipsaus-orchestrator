// Claude Code hooks for the hook relay (0008 section 5, amendment of 2026-10-12; DIPO-59): which
// hooks the run settings file registers, how a Claude hook payload maps to the engine's neutral
// `HookEvent`, and how the engine's neutral `HookReply` becomes Claude's `PermissionRequest`
// output. Everything Claude-specific about hooks lives here; `engine/src/hooks` sees only the
// neutral shapes.
//
// Residual risk of the web gate: Claude Code treats a hook past its 5 s timeout as a non-blocking
// error and runs the call, so a gate process that is very slow to start is not covered.

import type { HookEvent, HookReply } from "../../hooks/types";
import { type NudgeOp, WEB_TOOLS } from "../types";

export { WEB_TOOLS };

/** The hooks the run settings file registers (0008 section 5), each `dipo hook <event>`. */
export const REGISTERED_HOOKS = [
  "SessionStart",
  "PreToolUse",
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

/**
 * The `PreToolUse` matcher of the web tools (0020 section 11b, DIPO-164): exactly `WEB_TOOLS`, in
 * name order, so `dipo hook PreToolUse --gate` checks every one of them and nothing else.
 */
export const WEB_HOOK_MATCHER = WEB_TOOLS.toSorted().join("|");
/**
 * The `PreToolUse` matcher of Bash (0008 amendment of 2026-10-19, DIPO-194): `dipo hook PreToolUse
 * --bash` decides the command in its own process and fails open, except for a gh word when the
 * check cannot run (`bashHookCommand`, DIPO-241).
 */
export const BASH_HOOK_MATCHER = "Bash";
/** The hook of the web gate (fails closed, only with web tools) and of the Bash check. */
export const GATE_HOOK: RegisteredHook = "PreToolUse";

/** Told to the worker when the gate command itself failed (exit 2 shows stderr to Claude). */
export const GATE_CRASH_REASON = "dipo could not check this web call, so it was refused.";

/**
 * The end of the gate's command line: when `cd` or `dipo hook PreToolUse --gate` fails in any way
 * (a crash exits 1, which Claude Code treats as a non-blocking error and runs the call), the shell
 * exits 2 instead, which blocks a `PreToolUse` call and shows stderr to Claude (hooks reference,
 * exit code 2). A gate that ran prints its own decision and exits 0.
 */
export const GATE_CRASH_EXIT = ` || { echo ${shellQuote(GATE_CRASH_REASON)} >&2; exit 2; }`;

/**
 * The gh words the Bash check's fallback looks for, as `grep -Ei` reads them: a word whose basename
 * is gh, in any case. The fallback first joins the JSON payload the way the shell joins the command
 * (`GH_PAYLOAD_JOIN`). The daemon's `GH_WORD` (`hook.ts`) matches the same words in the parsed
 * command (DIPO-241).
 */
export const GH_WORD_PATTERN = "(^|[^A-Za-z0-9_-])gh($|[^A-Za-z0-9_-])";

/**
 * Prints the JSON `$payload` joined the way the shell joins the command, for the gh grep. Backslash
 * pairs are decoded left to right at both levels: a JSON `\\\\` becomes the marker \001 (each JSON
 * escape starts a pair, so this is aligned), two markers become \002 (an escaped backslash in the
 * command), a marker before a `\n` escape is a line continuation and goes, every other `\n`, `\t` or
 * `\r` escape becomes a space, and the markers, quotes and backslashes go. So `g\\h`, `'g'h`, a
 * continuation and a gh call on a later line are seen, and an escaped backslash before a newline
 * keeps the line break. It errs toward a gh word, which only refuses more. It assumes the payload
 * is canonical JSON.stringify output, as Claude Code sends it: a `\uXXXX` escape there is only a
 * control character or a lone surrogate, never a printable letter or a command separator.
 */
export const GH_PAYLOAD_JOIN = String.raw`a=$(printf "\001"); b=$(printf "\002"); printf "%s" "$payload" | sed -e "s/\\\\\\\\/$a/g" -e "s/$a$a/$b/g" -e "s/$a\\\\n//g" -e "s/\\\\[nrt]/ /g" | tr -d "\001\002\047\042\134"`;

/** Told to the worker when the Bash check cannot run on a command that names gh (DIPO-241). */
export const BASH_GH_CRASH_REASON =
  "dipo could not check this command, and it names gh: the engine handles the code host, so the call was refused.";

/**
 * The hooks whose call may get a 0014 section 8 nudge (DIPO-60): `dipo hook <event> --nudge` waits
 * a short while for the engine's answer and still ends within 2 s.
 */
export const NUDGE_HOOKS = ["PostToolUse", "SessionStart"] as const satisfies RegisteredHook[];

/** The tools whose `PostToolUse` names a written file (0014 section 8, "Edit or Write"). */
export const WRITE_TOOLS: readonly string[] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

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
  return `cd ${shellQuote(runDir)} && ${hookProgram(command, runDir)}`;
}

/** The binary with its flags, quoted for `sh`: the part of `hookCommandLine` after its `cd`. */
export function hookProgram(command: readonly [string, ...string[]], runDir: string): string {
  const [program, ...rest] = command;
  const argv =
    rest.length === 0
      ? [program]
      : [program, "--no-env-file", `--config=${runDir}/${HOOK_BUNFIG_FILE}`, ...rest];
  return argv.map(shellQuote).join(" ");
}

/**
 * The Bash check's command line (DIPO-194, DIPO-241). The payload is read once and piped to `dipo
 * hook PreToolUse --bash`, whose exit 0 (with or without a deny) and exit 2 stand as they are. When
 * dipo cannot start or crashes (any other status), the shell looks for a gh word in the payload: a
 * gh call exits 2 with the reason on stderr, so it never runs unchecked; every other call exits 0,
 * so the rest of Bash still fails open. A hook that times out is run anyway, the residual risk the
 * header of this file records.
 */
export function bashHookCommand(command: readonly [string, ...string[]], runDir: string): string {
  const ghWord = `${GH_PAYLOAD_JOIN} | grep -Eiq ${shellQuote(GH_WORD_PATTERN)}`;
  return [
    "payload=$(cat);",
    `{ cd ${shellQuote(runDir)} && printf '%s' "$payload" | ${hookProgram(command, runDir)} hook PreToolUse --bash; };`,
    `s=$?; [ "$s" = 0 ] && exit 0; [ "$s" = 2 ] && exit 2;`,
    `${ghWord} && { echo ${shellQuote(BASH_GH_CRASH_REASON)} >&2; exit 2; }; exit 0`,
  ].join(" ");
}

/**
 * The run settings file's `hooks` block: one command hook per registered event, running
 * `<dipo> hook <event>` with the binary's own path from the run directory. `PermissionRequest`
 * asks the host to hold the call `waitSeconds` plus a margin (see `HOST_WAIT_MARGIN_SECONDS`);
 * the `NUDGE_HOOKS` pass `--nudge`. `PreToolUse` is registered for Bash with `--bash` always, and
 * with `web` also for the web tools with `--gate`, first.
 */
export function hookSettings(
  command: readonly [string, ...string[]],
  waitSeconds: number,
  runDir: string,
  web = false,
): Record<string, unknown> {
  const prefix = hookCommandLine(command, runDir);
  const hooks: Record<string, unknown> = {};
  for (const event of REGISTERED_HOOKS) {
    if (event === GATE_HOOK) {
      hooks[event] = [
        ...(web
          ? [
              {
                matcher: WEB_HOOK_MATCHER,
                hooks: [
                  {
                    type: "command",
                    command: `${prefix} hook ${event} --gate${GATE_CRASH_EXIT}`,
                    timeout: HOOK_TIMEOUT_SECONDS,
                  },
                ],
              },
            ]
          : []),
        // A gh word fails closed when dipo cannot run; the rest of Bash fails open (DIPO-241).
        {
          matcher: BASH_HOOK_MATCHER,
          hooks: [
            {
              type: "command",
              command: bashHookCommand(command, runDir),
              timeout: HOOK_TIMEOUT_SECONDS,
            },
          ],
        },
      ];
      continue;
    }
    const waits = event === WAITING_HOOK;
    const flag = waits
      ? ` --wait ${waitSeconds + HOST_WAIT_MARGIN_SECONDS}`
      : (NUDGE_HOOKS as readonly string[]).includes(event)
        ? " --nudge"
        : "";
    hooks[event] = [
      {
        hooks: [
          {
            type: "command",
            command: `${prefix} hook ${event}${flag}`,
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

/** The file a write tool's input names (`file_path`, or `notebook_path` for `NotebookEdit`). */
function writtenPath(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  return text(input["file_path"]) ?? text(input["notebook_path"]);
}

/**
 * The exact command or path of a tool call, untouched (DIPO-75: allow once matches only this); null
 * when the input has neither.
 */
export function exactAction(input: unknown): string | null {
  if (!isRecord(input)) return null;
  for (const key of ["command", "file_path", "path", "notebook_path"]) {
    const value = text(input[key]);
    if (value !== undefined) return value;
  }
  return null;
}

/**
 * The query of a WebSearch or the URL of a WebFetch, whole. A call whose input lacks it is checked
 * as its whole input, so a malformed call cannot slip a value past the check.
 */
export function webTarget(tool: string, input: unknown): string {
  const field = tool === "WebSearch" ? "query" : "url";
  if (isRecord(input)) {
    const value = input[field];
    if (typeof value === "string") return value;
  }
  return JSON.stringify(input ?? {});
}

/**
 * Pure: the neutral hook event of one Claude hook payload, or null for an event the relay does not
 * register. `call` is the call's id (the hook line's end offset), when known: a permission request
 * waits on it, and a tool use or session start may get a nudge under it.
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
      const transcriptPath = text(payload["transcript_path"]);
      return {
        kind: "sessionStarted",
        id: call,
        ...(source === undefined ? {} : { source }),
        ...(source === "resume" ? { resumed: true as const } : {}),
        ...(transcriptPath === undefined ? {} : { transcriptPath }),
      };
    }
    case "PermissionRequest": {
      const exact = exactAction(payload["tool_input"]);
      return {
        kind: "permissionRequest",
        id: call,
        tool: text(payload["tool_name"]) ?? "unknown",
        input: inputSummary(payload["tool_input"]),
        ...(exact === null ? {} : { exact }),
      };
    }
    case "PreToolUse": {
      // Only the web tools are matched; any other tool is not relayed as an event.
      const tool = text(payload["tool_name"]);
      if (tool === undefined || !WEB_TOOLS.includes(tool)) return null;
      return { kind: "webCall", id: call, tool, target: webTarget(tool, payload["tool_input"]) };
    }
    case "PostToolUse": {
      const tool = text(payload["tool_name"]) ?? "unknown";
      const wrote = WRITE_TOOLS.includes(tool) ? writtenPath(payload["tool_input"]) : undefined;
      return { kind: "toolUsed", id: call, tool, ...(wrote === undefined ? {} : { wrote }) };
    }
    case "Notification": {
      const type = text(payload["notification_type"]);
      return { kind: "notification", ...(type === undefined ? {} : { type }) };
    }
    case "SubagentStart":
      return { kind: "subagentStarted", ...(agentId === undefined ? {} : { agentId }) };
    case "SubagentStop": {
      const transcriptPath = text(payload["agent_transcript_path"]);
      return {
        kind: "subagentStopped",
        ...(agentId === undefined ? {} : { agentId }),
        ...(transcriptPath === undefined ? {} : { transcriptPath }),
      };
    }
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

/**
 * Pure: what `dipo hook PreToolUse --gate` prints for a deny: Claude's `PreToolUse` refusal, with
 * `reason` told to the worker.
 */
export function preToolUseDenyOutput(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason.trim() === "" ? DEFAULT_DENY_MESSAGE : reason,
    },
  });
}

/**
 * The engine's answer to a gate call it let through: a marker that carries no decision. It is never
 * empty, so the relay tells the engine's pass apart from the worker host's empty answer (no engine
 * watching, the wait passed, the host stopped), which refuses the call (0020 section 11b). The
 * relay prints nothing for exactly this marker (`gateOutput`), so Claude applies its own permission
 * rules: the run settings' allow rules let the web tool through, and a deny rule there (a WebFetch
 * domain rule) still holds, which an explicit `permissionDecision: "allow"` would bypass (hooks
 * reference). Were the marker ever printed as is, it would still decide nothing.
 */
export const PRE_TOOL_USE_NO_DECISION_MARKER = JSON.stringify({
  hookSpecificOutput: { hookEventName: "PreToolUse" },
});

/**
 * Pure: the engine's answer to a gate call for its reply: a deny, else the marker that carries no
 * decision.
 */
export function preToolUseOutput(reply: HookReply): string {
  return reply.decision === "deny"
    ? preToolUseDenyOutput(reply.reason ?? "")
    : PRE_TOOL_USE_NO_DECISION_MARKER;
}

/** True when `output` is exactly a `PreToolUse` deny as `preToolUseDenyOutput` prints it. */
function isPreToolUseDeny(output: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return false;
  }
  if (!isRecord(value)) return false;
  const reason = isRecord(value["hookSpecificOutput"])
    ? value["hookSpecificOutput"]["permissionDecisionReason"]
    : undefined;
  return typeof reason === "string" && output === preToolUseDenyOutput(reason);
}

/**
 * Pure: what the fail-closed `dipo hook PreToolUse --gate` prints for the worker host's answer
 * (0020 section 11b). Exactly the engine's `PRE_TOOL_USE_NO_DECISION_MARKER` prints nothing, so
 * Claude's own permission rules decide the call; the engine's deny is printed as it is; anything
 * else (no answer, the host's empty answer, an explicit allow, any other text) prints a deny with
 * `noAnswerReason`.
 */
export function gateOutput(answer: string | null, noAnswerReason: string): string {
  if (answer === PRE_TOOL_USE_NO_DECISION_MARKER) return "";
  if (answer !== null && isPreToolUseDeny(answer)) return answer;
  return preToolUseDenyOutput(noAnswerReason);
}

/** Claude's name of the hook a neutral nudge answers. */
const NUDGE_EVENT: Record<NudgeOp["on"], (typeof NUDGE_HOOKS)[number]> = {
  toolUsed: "PostToolUse",
  sessionStarted: "SessionStart",
};

/**
 * Pure: what `dipo hook PostToolUse --nudge` or `dipo hook SessionStart --nudge` prints for the
 * engine's nudge (0014 section 8): the text as `additionalContext`. An empty text prints nothing.
 */
export function nudgeOutput(op: NudgeOp): string {
  if (op.text === "") return "";
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: NUDGE_EVENT[op.on], additionalContext: op.text },
  });
}
