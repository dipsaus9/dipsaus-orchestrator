// zod schemas for the Claude Code stream-json lines the adapter reads (0017 section 2: strict on
// the fields we use, tolerant of unknown message types and fields), and the schema of the Worker
// events this adapter can produce (the contract check for `ScriptedWorker`, 0017 section 2).
//
// Recordings redact every string outside the 0017 allowlist to `[redacted ...]`, so a schema here
// only types fields; decisions read kept fields (types, subtypes, enums, numbers, ids) alone.

import { z } from "zod";

import { ReviewReportSchema, WorkerReportSchema } from "./report-schema";

const Count = z.number().int().nonnegative();
/** A token count; absent counts read as zero. */
const Tokens = Count.optional().default(0);

export const InitMessage = z.object({
  type: z.literal("system"),
  subtype: z.literal("init"),
  session_id: z.string().min(1),
  model: z.string().min(1),
  claude_code_version: z.string().min(1),
  permissionMode: z.string(),
  tools: z.array(z.string()),
  apiKeySource: z.string(),
  /**
   * The plugins the session loaded (DIPO-108). `source` is `<plugin>@<marketplace>`, the form
   * `enabledPlugins` and `worker.plugins` use (live run, Claude Code 2.1.301); `name` is the
   * plugin alone. Recordings redact both.
   */
  plugins: z
    .array(z.looseObject({ name: z.string(), source: z.string().optional() }))
    .optional()
    .default([]),
  /**
   * The skills the session loaded (DIPO-130), by name; `[]` under `--disable-slash-commands` (live
   * run, Claude Code 2.1.301). Recordings redact the names.
   */
  skills: z.array(z.string()).optional().default([]),
});

const ContentBlock = z.looseObject({ type: z.string() });
export const TextBlock = z.object({ type: z.literal("text"), text: z.string() });
export const ToolUseBlock = z.object({
  type: z.literal("tool_use"),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown(),
});

export const AssistantMessage = z.object({
  type: z.literal("assistant"),
  message: z.object({
    id: z.string().min(1),
    model: z.string().min(1),
    content: z.array(ContentBlock),
    usage: z.object({
      input_tokens: Tokens,
      cache_creation_input_tokens: Tokens,
      cache_read_input_tokens: Tokens,
      output_tokens: Tokens,
      cache_creation: z
        .object({
          ephemeral_5m_input_tokens: Tokens.optional(),
          ephemeral_1h_input_tokens: Tokens.optional(),
        })
        .optional(),
    }),
  }),
  parent_tool_use_id: z.string().nullable(),
  error: z.string().optional(),
  /**
   * How long the thinking block on this line took (DIPO-96). A value of the wrong shape is dropped,
   * so it never costs the message its usage.
   */
  thinking_duration_ms: z.number().nonnegative().optional().catch(undefined),
});

/** Content blocks that hold thinking; only their presence is read, never their text (DIPO-96). */
export const THINKING_BLOCK_TYPES: readonly string[] = ["thinking", "redacted_thinking"];

/**
 * The CLI's running estimate of the current thinking block (DIPO-96): `estimated_tokens` so far in
 * the block, `estimated_tokens_delta` the rise since the last line. Recordings captured before the
 * allowlist kept these fields hold neither, so both are optional.
 */
export const ThinkingTokensMessage = z.object({
  type: z.literal("system"),
  subtype: z.literal("thinking_tokens"),
  estimated_tokens: z.number().nonnegative().optional(),
  estimated_tokens_delta: z.number().nonnegative().optional(),
});

/**
 * The `stream_event` lines the live numbers read (DIPO-296), sent with `--include-partial-messages`:
 * a message's start names its id, and its `message_delta` carries the message's final output count,
 * which an `assistant` line never has (its output is a placeholder, 0008 section 4). Every other
 * stream event, and one of another shape, is read for liveness only.
 */
export const StreamMessageStart = z.object({
  type: z.literal("stream_event"),
  event: z.object({
    type: z.literal("message_start"),
    message: z.object({ id: z.string().min(1) }),
  }),
  parent_tool_use_id: z.string().nullable().optional(),
});

export const StreamMessageDelta = z.object({
  type: z.literal("stream_event"),
  event: z.object({
    type: z.literal("message_delta"),
    usage: z.object({ output_tokens: Count }),
  }),
  parent_tool_use_id: z.string().nullable().optional(),
});

/**
 * A `user` line (DIPO-296): tool results or a message sent mid-turn, each one more model turn of
 * the agent it went to. Only whose line it is gets read, never its content.
 */
export const UserLine = z.object({
  type: z.literal("user"),
  parent_tool_use_id: z.string().nullable().optional(),
});

export const ModelUsageEntry = z.object({
  inputTokens: Tokens,
  outputTokens: Tokens,
  cacheReadInputTokens: Tokens,
  cacheCreationInputTokens: Tokens,
  /** The CLI's own cost estimate, cumulative per process (0008 section 4, DIPO-62). */
  costUSD: z.number().nonnegative().optional(),
  /** The model's context window in tokens, for the resume check (DIPO-51, 0014 section 6). */
  contextWindow: Count.optional(),
});

export const ResultMessage = z.object({
  type: z.literal("result"),
  subtype: z.string().min(1),
  session_id: z.string().min(1),
  is_error: z.boolean(),
  num_turns: Count,
  terminal_reason: z.string().nullish(),
  structured_output: z.unknown().optional(),
  modelUsage: z.record(z.string(), ModelUsageEntry),
  permission_denials: z
    .array(z.object({ tool_name: z.string().min(1), tool_use_id: z.string().min(1) }))
    .optional()
    .default([]),
  startup_failure_reason: z.string().nullish(),
  api_error_status: z.number().int().nullish(),
});

export const PermissionDeniedMessage = z.object({
  type: z.literal("system"),
  subtype: z.literal("permission_denied"),
  tool_name: z.string().min(1),
  tool_use_id: z.string().min(1),
  decision_reason_type: z.string().optional(),
});

const RateLimitWindow = z.object({
  utilization: z.number().nonnegative().optional(),
  resetsAt: z.number().optional(),
});

export const RateLimitMessage = z.object({
  type: z.literal("rate_limit_event"),
  rate_limit_info: z.object({
    status: z.string().min(1),
    resetsAt: z.number().optional(),
    utilization: z.number().nonnegative().optional(),
    rateLimitType: z.string().optional(),
    errorCode: z.string().optional(),
    unifiedWindows: z.record(z.string(), RateLimitWindow).optional(),
  }),
});

export const ApiRetryMessage = z.object({
  type: z.literal("system"),
  subtype: z.literal("api_retry"),
  error: z.string().min(1),
});

export const CompactBoundaryMessage = z.object({
  type: z.literal("system"),
  subtype: z.literal("compact_boundary"),
  compact_metadata: z.object({ pre_tokens: Count }),
});

export const SessionStateMessage = z.object({
  type: z.literal("system"),
  subtype: z.literal("session_state_changed"),
  state: z.string().min(1),
});

/** A hook payload relayed by the worker host (0008 section 5); only the event name is required. */
export const HookPayload = z.looseObject({
  hook_event_name: z.string().min(1),
  tool_name: z.string().optional(),
  error: z.string().optional(),
});

/** A neutral hook event as the adapter emits it (DIPO-59; `hooks/types.ts`). */
const HookEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("sessionStarted"),
    id: z.int().nonnegative().nullable(),
    source: z.string().exactOptional(),
    resumed: z.literal(true).exactOptional(),
    transcriptPath: z.string().min(1).exactOptional(),
  }),
  z.strictObject({
    kind: z.literal("permissionRequest"),
    id: z.int().nonnegative().nullable(),
    tool: z.string().min(1),
    input: z.string(),
    exact: z.string().exactOptional(),
  }),
  z.strictObject({
    kind: z.literal("toolUsed"),
    id: z.int().nonnegative().nullable(),
    tool: z.string().min(1),
    wrote: z.string().min(1).exactOptional(),
  }),
  z.strictObject({
    kind: z.literal("webCall"),
    id: z.int().nonnegative().nullable(),
    tool: z.string().min(1),
    target: z.string(),
  }),
  z.strictObject({ kind: z.literal("notification"), type: z.string().exactOptional() }),
  z.strictObject({ kind: z.literal("subagentStarted"), agentId: z.string().exactOptional() }),
  z.strictObject({
    kind: z.literal("subagentStopped"),
    agentId: z.string().exactOptional(),
    transcriptPath: z.string().min(1).exactOptional(),
  }),
  z.strictObject({ kind: z.literal("stopped") }),
  z.strictObject({ kind: z.literal("stopFailed"), error: z.string().exactOptional() }),
  z.strictObject({ kind: z.literal("compacted"), trigger: z.string().exactOptional() }),
  z.strictObject({
    kind: z.literal("modelSwitched"),
    from: z.string().exactOptional(),
    to: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal("sessionEnded"), reason: z.string().exactOptional() }),
]);

/** Top-level `type` values the adapter knows. Any other type is logged once per run and ignored. */
export const KNOWN_TYPES = [
  "system",
  "assistant",
  "user",
  "stream_event",
  "result",
  "rate_limit_event",
  "tool_progress",
] as const;

/**
 * `system` subtypes the adapter knows: some map to events, the rest are read for liveness only.
 * `background_tasks_changed`, `thinking_tokens` and `task_updated` were seen live in DIPO-41;
 * `thinking_tokens` feeds the `thinking` activity since DIPO-96.
 */
export const KNOWN_SYSTEM_SUBTYPES = [
  "init",
  "status",
  "session_state_changed",
  "permission_denied",
  "api_retry",
  "compact_boundary",
  "task_started",
  "task_progress",
  "task_notification",
  "task_updated",
  "background_tasks_changed",
  "thinking_tokens",
  "hook_started",
  "hook_progress",
  "hook_response",
] as const;

/** The schema each known stdout message must satisfy; types without one carry no used field. */
export function schemaFor(message: {
  readonly type: string;
  readonly subtype?: unknown;
}): z.ZodType | null {
  switch (message.type) {
    case "assistant":
      return AssistantMessage;
    case "result":
      return ResultMessage;
    case "rate_limit_event":
      return RateLimitMessage;
    case "system":
      switch (message.subtype) {
        case "init":
          return InitMessage;
        case "permission_denied":
          return PermissionDeniedMessage;
        case "api_retry":
          return ApiRetryMessage;
        case "compact_boundary":
          return CompactBoundaryMessage;
        case "session_state_changed":
          return SessionStateMessage;
        case "thinking_tokens":
          return ThinkingTokensMessage;
        default:
          return null;
      }
    default:
      return null;
  }
}

// ---- Worker events this adapter can produce (0008 section 3) -------------------------------

const Name = z.string().min(1);
const Iso = z.iso.datetime();

const Totals = z.strictObject({
  input: Count,
  output: Count,
  cacheCreate: Count,
  cacheRead: Count,
});

/**
 * Every Worker event `interpret` can emit, in the exact shape it emits it. A `ScriptedWorker`
 * script that fails this schema describes something the Claude CLI adapter could not produce.
 */
export const ClaudeWorkerEventSchema = z.union([
  z.strictObject({
    t: z.literal("started"),
    sessionId: Name,
    model: Name,
    version: Name,
    permissionMode: z.string(),
    tools: z.array(Name),
  }),
  z.strictObject({
    t: z.literal("activity"),
    kind: z.literal("text"),
    agentId: Name.exactOptional(),
  }),
  z.strictObject({
    t: z.literal("activity"),
    kind: z.literal("tool"),
    tool: Name,
    path: z.string().exactOptional(),
    input: z.string().exactOptional(),
    effect: z.enum(["edit", "shell"]).exactOptional(),
    agentId: Name.exactOptional(),
  }),
  z.strictObject({
    t: z.literal("activity"),
    kind: z.literal("thinking"),
    ms: Count.exactOptional(),
    tokens: Count.exactOptional(),
    agentId: Name.exactOptional(),
  }),
  z.strictObject({
    t: z.literal("activity"),
    kind: z.literal("subagent"),
    tool: Name,
    agentId: Name,
  }),
  z.strictObject({ t: z.literal("output"), text: z.string() }),
  z
    .strictObject({
      t: z.literal("usage"),
      messageId: Name,
      model: Name,
      agentId: Name.exactOptional(),
      input: Count,
      output: Count,
      cacheCreate: Count,
      cacheCreate5m: Count,
      cacheCreate1h: Count,
      cacheRead: Count,
    })
    .refine((event) => event.cacheCreate === event.cacheCreate5m + event.cacheCreate1h, {
      message: "cacheCreate is the sum of cacheCreate5m and cacheCreate1h",
    }),
  z.strictObject({ t: z.literal("liveUsage"), turns: Count, output: Count }),
  z.strictObject({
    t: z.literal("turn"),
    report: WorkerReportSchema.nullable(),
    review: ReviewReportSchema.exactOptional(),
    totals: z.record(Name, Totals),
    costUsd: z.record(Name, z.number().nonnegative()).exactOptional(),
    numTurns: Count,
    terminal: Name,
    capped: Name.exactOptional(),
    problem: z
      .strictObject({
        kind: z.enum(["report", "contextFull", "error", "startFailed", "planLimit"]),
        detail: Name,
      })
      .exactOptional(),
  }),
  z.strictObject({
    t: z.literal("waiting"),
    on: z.enum(["permission", "question", "plan-limit", "retry", "auth"]),
    detail: Name,
    until: Iso.exactOptional(),
  }),
  z.strictObject({ t: z.literal("denied"), tool: Name, reason: Name }),
  z.strictObject({
    t: z.literal("limit"),
    status: Name,
    utilization: z.number().min(0).max(1).exactOptional(),
    resetsAt: Iso.exactOptional(),
    creditsRequired: z.literal(true).exactOptional(),
    scope: z
      .union([z.literal("session"), z.literal("weekly"), z.string().regex(/^model:[a-z0-9]+$/)])
      .exactOptional(),
  }),
  z.strictObject({ t: z.literal("hook"), hook: HookEventSchema }),
  z.strictObject({ t: z.literal("compacted"), preTokens: Count.exactOptional() }),
  z.strictObject({ t: z.literal("modelSwitched"), from: Name, to: Name }),
  z.strictObject({ t: z.literal("initRejected"), reason: Name }),
  z.strictObject({ t: z.literal("startRefused"), reason: Name }),
]);
