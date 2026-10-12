// The recording scrubber (0017 section 2, "Scrubbing"). It works from an allowlist per channel and
// message type: listed fields are kept, ids and paths are normalised to stable placeholders, and
// every other string at any depth becomes `[redacted sha256:<12 hex> len:<n>]`. A message type or
// hook event the allowlist does not know is redacted whole and reported. Numbers, booleans and
// null are kept: they are the usage and structure a replay needs, and carry no text. Name lists
// from the maintainer's setup in `system/init` keep only their lengths (`[redacted len:<n>]`).

import { createHash } from "node:crypto";

import { isRecord } from "./format";
import type { Envelope } from "./format";

/** What happens to a string at a matching path. */
export type Action = "keep" | "id" | "path" | "opaque";

/** A dot path; `*` matches one key or index, `**` any number of them (also none). */
export type PathRule = readonly [pattern: string, action: Action];

const REDACTED = /^\[redacted (?:sha256:[0-9a-f]{12} )?len:\d+\]$/;

export function redact(value: string): string {
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `[redacted sha256:${hash} len:${value.length}]`;
}

/**
 * A marker without a hash, for short names from the maintainer's own setup (skills, agents,
 * plugins, slash commands): an unsalted hash of a short name could be reversed by guessing.
 */
export function opaque(value: string): string {
  return `[redacted len:${value.length}]`;
}

export function isRedacted(value: unknown): boolean {
  return typeof value === "string" && REDACTED.test(value);
}

/** Fields kept on every known stdout message. */
const COMMON: readonly PathRule[] = [
  ["type", "keep"],
  ["subtype", "keep"],
  ["session_id", "id"],
  ["uuid", "id"],
  ["parent_uuid", "id"],
  ["prompt_id", "id"],
  ["request_id", "id"],
  ["parent_tool_use_id", "id"],
  ["tool_use_id", "id"],
  ["agent_id", "id"],
  ["task_id", "id"],
  ["api_message_id", "id"],
  ["is_error", "keep"],
  ["model", "keep"],
  ["stop_reason", "keep"],
  ["permissionMode", "keep"],
];

/** Usage objects keep everything: token counts plus tier strings such as `service_tier`. */
const USAGE = (prefix: string): PathRule => [`${prefix}.**`, "keep"];

const CONTENT_BLOCKS = (prefix: string): PathRule[] => [
  [`${prefix}.*.type`, "keep"],
  [`${prefix}.*.name`, "keep"],
  [`${prefix}.*.id`, "id"],
  [`${prefix}.*.tool_use_id`, "id"],
  [`${prefix}.*.is_error`, "keep"],
  [`${prefix}.*.caller.type`, "keep"],
];

/**
 * The stdout allowlist, keyed by `type/subtype` or `type`. Decision fields (0008 sections 2, 3, 5
 * and 7) are listed in `DECISION_FIELDS` below and must be kept here; a test checks both lists.
 */
export const STDOUT_RULES: Readonly<Record<string, readonly PathRule[]>> = {
  "system/init": [
    ["cwd", "path"],
    ["tools.*", "keep"],
    ["mcp_servers.*.name", "keep"],
    ["mcp_servers.*.status", "keep"],
    ["apiKeySource", "keep"],
    ["claude_code_version", "keep"],
    ["capabilities.*", "keep"],
    ["output_style", "keep"],
    ["fast_mode_state", "keep"],
    ["slash_commands.**", "opaque"],
    ["terminal_slash_commands.**", "opaque"],
    ["agents.**", "opaque"],
    ["skills.**", "opaque"],
    ["plugins.**", "opaque"],
  ],
  "system/api_retry": [
    ["error", "keep"],
    ["error_status", "keep"],
  ],
  "system/permission_denied": [
    ["tool_name", "keep"],
    ["decision_reason_type", "keep"],
  ],
  "system/compact_boundary": [["compact_metadata.trigger", "keep"]],
  "system/status": [["status", "keep"]],
  "system/session_state_changed": [["state", "keep"]],
  "system/hook_started": [
    ["hook_id", "id"],
    ["hook_name", "keep"],
    ["hook_event", "keep"],
    ["hook_event_name", "keep"],
  ],
  "system/hook_progress": [
    ["hook_id", "id"],
    ["hook_name", "keep"],
    ["hook_event", "keep"],
    ["hook_event_name", "keep"],
  ],
  "system/hook_response": [
    ["hook_id", "id"],
    ["hook_name", "keep"],
    ["hook_event", "keep"],
    ["hook_event_name", "keep"],
    ["outcome", "keep"],
  ],
  "system/task_started": [
    ["task_type", "keep"],
    ["subagent_type", "keep"],
    ["run_id", "id"],
  ],
  "system/task_progress": [
    ["last_tool_name", "keep"],
    ["subagent_type", "keep"],
    ["run_id", "id"],
    USAGE("usage"),
  ],
  "system/task_notification": [["status", "keep"], ["run_id", "id"], USAGE("usage")],
  "system/task_updated": [
    ["patch.status", "keep"],
    ["status", "keep"],
  ],
  "system/background_tasks_changed": [],
  "system/thinking_tokens": [],
  "system/files_persisted": [],
  assistant: [
    ["error", "keep"],
    ["message.id", "id"],
    ["message.type", "keep"],
    ["message.role", "keep"],
    ["message.model", "keep"],
    ["message.stop_reason", "keep"],
    ...CONTENT_BLOCKS("message.content"),
    ["subagent_type", "keep"],
    USAGE("message.usage"),
  ],
  user: [
    ["message.role", "keep"],
    ...CONTENT_BLOCKS("message.content"),
    ["tool_result_meta.*.id", "id"],
    ["tool_result_meta.*.permission_decision.decision", "keep"],
    ["tool_result_meta.*.permission_decision.source", "keep"],
    ["tool_result_meta.*.permission_decision.reason_type", "keep"],
    ["tool_result_meta.*.non_execution_kind", "keep"],
    ["subagent_type", "keep"],
  ],
  stream_event: [
    ["event.type", "keep"],
    ["event.message.id", "id"],
    ["event.message.type", "keep"],
    ["event.message.role", "keep"],
    ["event.message.model", "keep"],
    ["event.message.stop_reason", "keep"],
    USAGE("event.message.usage"),
    ["event.content_block.type", "keep"],
    ["event.content_block.name", "keep"],
    ["event.content_block.id", "id"],
    ["event.content_block.tool_use_id", "id"],
    ["event.content_block.caller.type", "keep"],
    ["event.delta.type", "keep"],
    ["event.delta.stop_reason", "keep"],
    USAGE("event.usage"),
  ],
  result: [
    ["terminal_reason", "keep"],
    ["api_error_status", "keep"],
    ["startup_failure_reason", "keep"],
    USAGE("usage"),
    USAGE("modelUsage"),
    ["permission_denials.*.tool_name", "keep"],
    ["permission_denials.*.tool_use_id", "id"],
    // Report exemption: the fixture story makes the worker report fixed, fixture-controlled text.
    ["structured_output.status", "keep"],
    ["structured_output.question", "keep"],
    ["structured_output.needsPermission.tool", "keep"],
    ["structured_output.needsPermission.action", "keep"],
  ],
  rate_limit_event: [
    ["rate_limit_info.status", "keep"],
    ["rate_limit_info.resetsAt", "keep"],
    ["rate_limit_info.utilization", "keep"],
    ["rate_limit_info.rateLimitType", "keep"],
    ["rate_limit_info.errorCode", "keep"],
    ["rate_limit_info.overageStatus", "keep"],
    ["rate_limit_info.overageDisabledReason", "keep"],
    ["status", "keep"],
    ["resetsAt", "keep"],
    ["utilization", "keep"],
    ["errorCode", "keep"],
  ],
  session_state_changed: [["state", "keep"]],
  tool_progress: [
    ["tool_name", "keep"],
    ["heartbeat", "keep"],
  ],
  tool_use_summary: [["preceding_tool_use_ids.*", "id"]],
  auth_status: [["error", "keep"]],
};

/** Fields kept on every known hook payload (`ch: "hook"`, 0008 section 5). */
const HOOK_COMMON: readonly PathRule[] = [
  ["hook_event_name", "keep"],
  ["session_id", "id"],
  ["transcript_path", "path"],
  ["agent_transcript_path", "path"],
  ["cwd", "path"],
  ["permission_mode", "keep"],
  ["agent_id", "id"],
  ["agent_type", "keep"],
  ["tool_name", "keep"],
  ["tool_use_id", "id"],
];

export const HOOK_RULES: Readonly<Record<string, readonly PathRule[]>> = {
  SessionStart: [["source", "keep"]],
  SessionEnd: [["reason", "keep"]],
  PreToolUse: [],
  PostToolUse: [],
  PermissionRequest: [],
  PermissionDenied: [],
  Notification: [["notification_type", "keep"]],
  SubagentStart: [],
  SubagentStop: [["stop_hook_active", "keep"]],
  Stop: [["stop_hook_active", "keep"]],
  StopFailure: [
    ["error", "keep"],
    ["error_type", "keep"],
  ],
  PreCompact: [["trigger", "keep"]],
  PostCompact: [["trigger", "keep"]],
  PostModelSwitch: [
    ["from_model", "keep"],
    ["to_model", "keep"],
  ],
  UserPromptSubmit: [],
};

/**
 * Fields 0008 maps to an outcome, signal, wait, hold or park. A redacted value would change what
 * the engine decides on replay, so none of them may ever hold a redaction marker.
 */
export const DECISION_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "system/init": ["apiKeySource", "model", "permissionMode", "claude_code_version", "tools.*"],
  "system/api_retry": ["error"],
  "system/permission_denied": ["tool_name"],
  "system/session_state_changed": ["state"],
  "system/compact_boundary": ["compact_metadata.trigger"],
  assistant: ["error", "message.model", "message.content.*.type", "message.content.*.name"],
  result: [
    "subtype",
    "is_error",
    "terminal_reason",
    "api_error_status",
    "startup_failure_reason",
    "permission_denials.*.tool_name",
    "structured_output.status",
    "structured_output.question",
    "structured_output.needsPermission.tool",
    "structured_output.needsPermission.action",
  ],
  rate_limit_event: [
    "rate_limit_info.status",
    "rate_limit_info.resetsAt",
    "rate_limit_info.utilization",
    "rate_limit_info.rateLimitType",
    "rate_limit_info.errorCode",
  ],
  session_state_changed: ["state"],
  tool_progress: ["tool_name", "heartbeat"],
};

/** `type/subtype` when the subtype is a string, else `type`. */
export function messageKind(message: Record<string, unknown>): string {
  const type = typeof message.type === "string" ? message.type : "?";
  return typeof message.subtype === "string" ? `${type}/${message.subtype}` : type;
}

function rulesFor(message: Record<string, unknown>): readonly PathRule[] | undefined {
  const kind = messageKind(message);
  const type = typeof message.type === "string" ? message.type : "";
  const exact = STDOUT_RULES[kind];
  if (exact !== undefined) return exact;
  // `result` and `assistant` share one rule set across subtypes; `system` subtypes are each
  // their own message and must be listed.
  if (type !== "system") return STDOUT_RULES[type];
  return undefined;
}

function matches(pattern: readonly string[], path: readonly string[]): boolean {
  if (pattern.length === 0) return path.length === 0;
  const [head, ...rest] = pattern;
  if (head === "**") {
    for (let skip = 0; skip <= path.length; skip++) {
      if (matches(rest, path.slice(skip))) return true;
    }
    return false;
  }
  if (path.length === 0) return false;
  if (head !== "*" && head !== path[0]) return false;
  return matches(rest, path.slice(1));
}

export function matchRule(rules: readonly PathRule[], path: readonly string[]): Action | undefined {
  for (const [pattern, action] of rules) {
    if (matches(pattern.split("."), path)) return action;
  }
  return undefined;
}

/** Real paths of one capture and the placeholder each becomes (0017 "Paths normalised"). */
export interface PathRoot {
  readonly path: string;
  readonly placeholder: string;
}

const ID_PREFIXES: readonly [RegExp, string][] = [
  [/^msg_/, "msg"],
  [/^toolu_/, "toolu"],
  [/^req_/, "req"],
  [/^srvtoolu_/, "srvtoolu"],
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An API id such as `toolu_01...`, as a whole string (not a word like `msg_lifecycle_v1`). */
const RAW_ID = /^(?:msg|toolu|req|srvtoolu)_0[0-9A-Za-z]{10,}$/;

const ID_KEY_PREFIX: Readonly<Record<string, string>> = {
  session_id: "session",
  uuid: "uuid",
  parent_uuid: "uuid",
  prompt_id: "prompt",
  request_id: "req",
  agent_id: "agent",
  task_id: "task",
  hook_id: "hook",
};

export interface ScrubReport {
  /** Unknown stdout types and hook events, redacted whole. */
  readonly unknownTypes: string[];
  /** Strings redacted per message kind, as dot paths with indexes folded to `*` (no values). */
  readonly redactedPaths: Record<string, string[]>;
}

/**
 * Scrubs one capture. Stateful: the id map makes every placeholder stable within a recording, so
 * deduplication by message id and session resume still work on replay.
 */
export class Scrubber {
  private readonly ids = new Map<string, string>();
  private readonly counters = new Map<string, number>();
  private readonly roots: PathRoot[];
  readonly report: ScrubReport = { unknownTypes: [], redactedPaths: {} };

  constructor(roots: readonly PathRoot[]) {
    // Every root also under its `/private` twin (macOS `/tmp` and `/var` are symlinks), longest
    // first so a worktree inside the temp root wins over the root.
    const all: PathRoot[] = [];
    for (const root of roots) {
      all.push(root);
      if (root.path.startsWith("/private/")) {
        all.push({ path: root.path.slice("/private".length), placeholder: root.placeholder });
      } else if (/^\/(?:tmp|var)\//.test(root.path)) {
        all.push({ path: `/private${root.path}`, placeholder: root.placeholder });
      }
    }
    this.roots = all.toSorted((a, b) => b.path.length - a.path.length);
  }

  /** Normalises one id to `<prefix>-<n>`, the same placeholder for the same value. */
  id(value: string, key: string): string {
    const known = this.ids.get(value);
    if (known !== undefined) return known;
    const prefix =
      ID_PREFIXES.find(([pattern]) => pattern.test(value))?.[1] ?? ID_KEY_PREFIX[key] ?? "id";
    const next = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, next);
    const placeholder = `${prefix}-${next}`;
    this.ids.set(value, placeholder);
    return placeholder;
  }

  /** Replaces every known root by its placeholder. */
  normalisePaths(value: string): string {
    let out = value;
    for (const root of this.roots) out = out.split(root.path).join(root.placeholder);
    return out;
  }

  /** A path field: normalised, and redacted when a real absolute path is still left in it. */
  private path(value: string, key: string): string {
    if (key === "transcript_path" || key === "agent_transcript_path") return "${TRANSCRIPT}";
    const out = this.normalisePaths(value);
    const rest = out.replace(/\$\{[A-Z_]+\}[^\s"']*/g, "");
    return /(?:^|[\s"'=:])\//.test(rest) ? redact(value) : out;
  }

  private noteRedacted(kind: string, path: readonly string[]): void {
    const folded = path.map((part) => (/^\d+$/.test(part) ? "*" : part)).join(".");
    const list = (this.report.redactedPaths[kind] ??= []);
    if (!list.includes(folded)) list.push(folded);
  }

  private noteUnknown(kind: string): void {
    if (!this.report.unknownTypes.includes(kind)) this.report.unknownTypes.push(kind);
  }

  private key(key: string): string {
    // Keys are structure (field names, model ids). A key that is an id (`wire_tool_inputs` is
    // keyed by tool use id) is normalised like any id; a key that looks like a path is data.
    if (RAW_ID.test(key) || UUID.test(key)) return this.id(key, "");
    return key.includes("/") ? redact(key) : key;
  }

  private walk(value: unknown, path: string[], rules: readonly PathRule[], kind: string): unknown {
    if (typeof value === "string") {
      const action = matchRule(rules, path);
      const key = path.at(-1) ?? "";
      switch (action) {
        case "keep":
          return this.normalisePaths(value);
        case "id":
          return this.id(value, key);
        case "path":
          return this.path(value, key);
        case "opaque":
          this.noteRedacted(kind, path);
          return opaque(value);
        default:
          this.noteRedacted(kind, path);
          return redact(value);
      }
    }
    if (Array.isArray(value)) {
      return value.map((item, index) => this.walk(item, [...path, String(index)], rules, kind));
    }
    if (isRecord(value)) {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value)) {
        out[this.key(key)] = this.walk(inner, [...path, key], rules, kind);
      }
      return out;
    }
    return value;
  }

  /** Redacts a whole message, keeping only the fields that name it. */
  private whole(
    message: Record<string, unknown>,
    names: readonly string[],
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const name of names) {
      const value = message[name];
      if (typeof value === "string") out[name] = value;
    }
    out.redacted = redact(JSON.stringify(message));
    return out;
  }

  stdout(data: unknown): unknown {
    if (!isRecord(data)) {
      // A line that is not a JSON object (a partial line, a banner) is redacted whole.
      this.noteUnknown("stdout:non-object");
      return redact(typeof data === "string" ? data : JSON.stringify(data));
    }
    const rules = rulesFor(data);
    const kind = messageKind(data);
    if (rules === undefined) {
      this.noteUnknown(kind);
      return this.whole(data, ["type", "subtype"]);
    }
    return this.walk(data, [], [...COMMON, ...rules], kind);
  }

  hook(data: unknown): unknown {
    if (!isRecord(data)) {
      this.noteUnknown("hook:non-object");
      return redact(JSON.stringify(data));
    }
    const event = typeof data.hook_event_name === "string" ? data.hook_event_name : "?";
    const rules = HOOK_RULES[event];
    if (rules === undefined) {
      this.noteUnknown(`hook:${event}`);
      return this.whole(data, ["hook_event_name"]);
    }
    return this.walk(data, [], [...HOOK_COMMON, ...rules], `hook:${event}`);
  }

  envelope(line: Envelope): Envelope {
    switch (line.ch) {
      case "stdout":
        return { t: line.t, ch: "stdout", data: this.stdout(line.data) };
      case "hook":
        return { t: line.t, ch: "hook", data: this.hook(line.data) };
      case "stderr":
        // Every stderr line is redacted (0017 "Always redacted").
        return {
          t: line.t,
          ch: "stderr",
          data: redact(typeof line.data === "string" ? line.data : JSON.stringify(line.data)),
        };
      case "exit": {
        const exit = isRecord(line.data) ? line.data : {};
        const code = typeof exit.code === "number" ? exit.code : null;
        const signal = typeof exit.signal === "string" ? exit.signal : null;
        return { t: line.t, ch: "exit", data: { code, signal } };
      }
      default:
        throw new Error(`unknown channel ${JSON.stringify((line as Envelope).ch)}`);
    }
  }
}

/** Scrubs a whole capture with one stateful scrubber. */
export function scrubCapture(
  lines: readonly Envelope[],
  roots: readonly PathRoot[],
): { lines: Envelope[]; report: ScrubReport } {
  const scrubber = new Scrubber(roots);
  return { lines: lines.map((line) => scrubber.envelope(line)), report: scrubber.report };
}

/** Values at `pattern` (dot path with `*`) inside `value`. */
export function valuesAt(value: unknown, pattern: string): unknown[] {
  const parts = pattern.split(".");
  let current: unknown[] = [value];
  for (const part of parts) {
    const next: unknown[] = [];
    for (const item of current) {
      if (part === "*") {
        if (Array.isArray(item)) next.push(...item);
        else if (isRecord(item)) next.push(...Object.values(item));
      } else if (isRecord(item) && part in item) {
        next.push(item[part]);
      }
    }
    current = next;
  }
  return current;
}
