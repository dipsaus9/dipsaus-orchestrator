// Adapter-neutral hook events and replies (0008 section 5, amendment of 2026-10-12). A worker
// adapter that relays its CLI's hooks maps each payload to a `HookEvent` and maps the engine's
// `HookReply` back to its CLI's reply format. Nothing here names a CLI field: a lint rule keeps
// `workers/claude-cli` out of `engine/src/hooks`.

/**
 * A hook call the engine may answer (a permission request waits for its decision; a tool use or a
 * session start may get a nudge, DIPO-60). `id` is the byte offset in `events.ndjson` after
 * the hook line, which the worker host also holds the call under; null when the line came without
 * an offset (a replay outside ingestion), so no reply can reach it.
 */
export interface HookCall {
  readonly id: number | null;
}

/** One relayed hook, adapter-neutral. */
export type HookEvent =
  | ({
      readonly kind: "sessionStarted";
      readonly source?: string;
      /** True when the session continues an earlier one (a resume). */
      readonly resumed?: true;
    } & HookCall)
  | ({
      readonly kind: "permissionRequest";
      /** The tool the worker asks to use. */
      readonly tool: string;
      /** A one-line summary of the call: a command, a path, or the input in short. */
      readonly input: string;
    } & HookCall)
  | ({
      readonly kind: "toolUsed";
      readonly tool: string;
      /** The file the tool wrote, as the worker named it (absolute, or relative to its worktree). */
      readonly wrote?: string;
    } & HookCall)
  | { readonly kind: "notification"; readonly type?: string }
  | { readonly kind: "subagentStarted"; readonly agentId?: string }
  | { readonly kind: "subagentStopped"; readonly agentId?: string }
  | { readonly kind: "stopped" }
  | { readonly kind: "stopFailed"; readonly error?: string }
  | { readonly kind: "compacted"; readonly trigger?: string }
  | { readonly kind: "modelSwitched"; readonly from?: string; readonly to: string }
  | { readonly kind: "sessionEnded"; readonly reason?: string };

export type HookEventKind = HookEvent["kind"];

/** The engine's decision on a waiting permission request; null returns no decision (a deny). */
export type PermissionDecision = "allow" | "deny" | null;

/** The engine's reply to a waiting hook call, adapter-neutral. */
export interface HookReply {
  /** The hook call (`HookCall.id`). */
  readonly hook: number;
  readonly decision: PermissionDecision;
  /** Told to the worker with a deny. */
  readonly reason?: string;
}
