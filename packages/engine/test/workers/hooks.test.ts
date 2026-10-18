// The Claude CLI adapter's hook mapping (DIPO-59 AC #3 and #10): a fixture payload of every
// registered hook maps to its neutral `HookEvent`; `PostCompact` and `PostModelSwitch` also give
// `compacted` and `modelSwitched`, once, whichever of the hook and the stream comes first; and the
// engine's neutral reply becomes Claude's `PermissionRequest` output.

import { describe, expect, it } from "bun:test";

import type { HookEvent } from "../../src/hooks/types";
import { encode } from "../../src/workers/claude-cli/encode";
import {
  DEFAULT_DENY_MESSAGE,
  exactAction,
  HOOK_TIMEOUT_SECONDS,
  hookEventOf,
  hookSettings,
  inputSummary,
  NUDGE_HOOKS,
  REGISTERED_HOOKS,
} from "../../src/workers/claude-cli/hooks";
import {
  type ClaudeParseState,
  initialState,
  interpret,
} from "../../src/workers/claude-cli/interpret";
import { ClaudeWorkerEventSchema } from "../../src/workers/claude-cli/schema";
import type { HostLine, WorkerEvent } from "../../src/workers/types";

const COMMON = {
  session_id: "session-1",
  transcript_path: "/home/maintainer/.claude/projects/x/session-1.jsonl",
  cwd: "/work/tree",
  permission_mode: "default",
};

/** One fixture payload per registered hook (Claude Code hooks reference), and its neutral event. */
const FIXTURES: Record<(typeof REGISTERED_HOOKS)[number], [Record<string, unknown>, HookEvent]> = {
  SessionStart: [
    { source: "startup" },
    {
      kind: "sessionStarted",
      id: 640,
      source: "startup",
      transcriptPath: "/home/maintainer/.claude/projects/x/session-1.jsonl",
    },
  ],
  PermissionRequest: [
    { tool_name: "Bash", tool_input: { command: "docker compose up", description: "start" } },
    {
      kind: "permissionRequest",
      id: 640,
      tool: "Bash",
      input: "docker compose up",
      exact: "docker compose up",
    },
  ],
  PostToolUse: [
    { tool_name: "Edit", tool_input: { file_path: "a.ts" }, tool_response: {} },
    { kind: "toolUsed", id: 640, tool: "Edit", wrote: "a.ts" },
  ],
  Notification: [
    { message: "Claude needs your permission", notification_type: "permission_prompt" },
    { kind: "notification", type: "permission_prompt" },
  ],
  SubagentStart: [
    { agent_id: "agent-7", agent_type: "Explore" },
    { kind: "subagentStarted", agentId: "agent-7" },
  ],
  SubagentStop: [
    {
      agent_id: "agent-7",
      stop_hook_active: false,
      agent_transcript_path: "/home/maintainer/.claude/projects/x/session-1/agent-7.jsonl",
    },
    {
      kind: "subagentStopped",
      agentId: "agent-7",
      transcriptPath: "/home/maintainer/.claude/projects/x/session-1/agent-7.jsonl",
    },
  ],
  Stop: [{ stop_hook_active: false, last_assistant_message: "done" }, { kind: "stopped" }],
  StopFailure: [{ error: "server_error" }, { kind: "stopFailed", error: "server_error" }],
  PostCompact: [{ trigger: "auto" }, { kind: "compacted", trigger: "auto" }],
  PostModelSwitch: [
    { from_model: "claude-haiku-4-5", to_model: "claude-sonnet-4-5" },
    { kind: "modelSwitched", from: "claude-haiku-4-5", to: "claude-sonnet-4-5" },
  ],
  SessionEnd: [{ reason: "other" }, { kind: "sessionEnded", reason: "other" }],
};

function hook(name: string, fields: Record<string, unknown>, end?: number): HostLine {
  return {
    t: 0,
    ch: "hook",
    data: JSON.stringify({ ...COMMON, hook_event_name: name, ...fields }),
    ...(end === undefined ? {} : { end }),
  };
}

function out(data: unknown): HostLine {
  return { t: 0, ch: "stdout", data: `${JSON.stringify(data)}\n` };
}

function run(
  lines: readonly HostLine[],
  state: ClaudeParseState = initialState({ plannedModel: "haiku" }),
) {
  const events: WorkerEvent[] = [];
  let current = state;
  for (const line of lines) {
    const step = interpret(line, current);
    events.push(...step.events);
    current = step.state;
  }
  return { events, state: current };
}

const compacted = (events: WorkerEvent[]) => events.filter((event) => event.t === "compacted");
const switched = (events: WorkerEvent[]) => events.filter((event) => event.t === "modelSwitched");
const output = (decision: "allow" | "deny" | null, reason?: string) =>
  encode({
    kind: "hookReply",
    reply: { hook: 640, decision, ...(reason === undefined ? {} : { reason }) },
  });

const boundary = out({
  type: "system",
  subtype: "compact_boundary",
  session_id: "session-1",
  compact_metadata: { trigger: "auto", pre_tokens: 150_000 },
});

const init = (model: string) =>
  out({
    type: "system",
    subtype: "init",
    session_id: "session-1",
    claude_code_version: "2.1.296",
    model,
    permissionMode: "default",
    apiKeySource: "none",
    tools: ["Read"],
    cwd: "/work/tree",
  });

describe("hook payloads to neutral hook events (DIPO-59)", () => {
  for (const name of REGISTERED_HOOKS) {
    it(`maps ${name}`, () => {
      const [fields, expected] = FIXTURES[name];
      const { events } = run([hook(name, fields, 640)]);
      const neutral = events.filter((event) => event.t === "hook");
      expect(neutral).toEqual([{ t: "hook", hook: expected }]);
      for (const event of events)
        expect(ClaudeWorkerEventSchema.safeParse(event).success).toBe(true);
      expect(hookEventOf({ ...COMMON, hook_event_name: name, ...fields }, 640)).toEqual(expected);
    });
  }

  it("leaves an unregistered hook unmapped and a waiting call without an offset unanswerable", () => {
    expect(run([hook("UserPromptSubmit", { prompt: "x" })]).events).toEqual([]);
    expect(run([hook("PermissionRequest", { tool_name: "Write" })]).events[0]).toEqual({
      t: "hook",
      hook: { kind: "permissionRequest", id: null, tool: "Write", input: "" },
    });
  });

  it("summarises a call's input on one line", () => {
    expect(inputSummary({ file_path: "/a/b.ts", content: "x" })).toBe("/a/b.ts");
    expect(inputSummary({ command: "echo  a\n  b" })).toBe("echo a b");
    expect(inputSummary({ query: "q" })).toBe('{"query":"q"}');
    expect(inputSummary({ command: "x".repeat(500) })).toHaveLength(200);
  });

  it("keeps the exact command or path untouched for allow once (DIPO-75)", () => {
    expect(exactAction({ command: "echo  a\n  b" })).toBe("echo  a\n  b");
    expect(exactAction({ command: "x".repeat(500) })).toHaveLength(500);
    expect(exactAction({ file_path: "/a/b.ts", content: "x" })).toBe("/a/b.ts");
    expect(exactAction({ url: "https://example.com" })).toBeNull();
    expect(exactAction("docker ps")).toBeNull();
    const event = hookEventOf(
      { hook_event_name: "PermissionRequest", tool_name: "WebFetch", tool_input: { url: "u" } },
      7,
    );
    expect(event).toEqual({ kind: "permissionRequest", id: 7, tool: "WebFetch", input: "u" });
  });
});

describe("PostCompact and PostModelSwitch, deduplicated (DIPO-59 AC #10)", () => {
  it("gives one compacted for a compaction seen as compact_boundary and PostCompact, in either order", () => {
    const post = hook("PostCompact", { trigger: "auto" });
    expect(compacted(run([boundary, post]).events)).toEqual([
      { t: "compacted", preTokens: 150_000 },
    ]);
    // The hook first waits for the boundary's token count (DIPO-100).
    expect(compacted(run([post]).events)).toEqual([]);
    expect(compacted(run([post, boundary]).events)).toEqual([
      { t: "compacted", preTokens: 150_000 },
    ]);
    // Two compactions give two events, and a new process counts again.
    expect(compacted(run([boundary, post, post, boundary]).events)).toEqual([
      { t: "compacted", preTokens: 150_000 },
      { t: "compacted", preTokens: 150_000 },
    ]);
    expect(compacted(run([post, post, boundary, boundary]).events)).toHaveLength(2);
    const exit: HostLine = { t: 0, ch: "exit", data: '{"code":0,"signal":null}' };
    // A hook whose boundary never comes is reported at the exit, with no token count.
    expect(compacted(run([boundary, exit, post, exit]).events)).toEqual([
      { t: "compacted", preTokens: 150_000 },
      { t: "compacted" },
    ]);
  });

  it("reports a hook-only compaction at the exit; the next process counts afresh (DIPO-100)", () => {
    const post = hook("PostCompact", { trigger: "auto" });
    const exit: HostLine = { t: 0, ch: "exit", data: '{"code":0,"signal":null}' };
    const { state } = run([post]);
    expect(state.compactReported).toBe(0);
    // Counts are per process: after the exit the next process starts from zero.
    const after = run([exit, boundary], state);
    expect(compacted(after.events)).toEqual([
      { t: "compacted" },
      { t: "compacted", preTokens: 150_000 },
    ]);
  });

  it("reads a state stored before DIPO-100 as having emitted every counted compaction", () => {
    // The old adapter emitted `preTokens` 0 at once for a hook ahead of the boundary.
    const stored = { ...initialState({ plannedModel: "haiku" }), compactHooks: 1 };
    expect(compacted(run([boundary], stored).events)).toEqual([]);
    const next = run([boundary, boundary], stored);
    expect(compacted(next.events)).toEqual([{ t: "compacted", preTokens: 150_000 }]);
  });

  it("gives one modelSwitched for a switch seen as PostModelSwitch and in the stream", () => {
    const post = hook("PostModelSwitch", {
      from_model: "claude-haiku-4-5",
      to_model: "claude-sonnet-4-5",
    });
    const assistant = out({
      type: "assistant",
      session_id: "session-1",
      parent_tool_use_id: null,
      message: {
        id: "msg-2",
        model: "claude-sonnet-4-5",
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const hookFirst = run([init("claude-haiku-4-5"), post, assistant, init("claude-sonnet-4-5")]);
    expect(switched(hookFirst.events)).toEqual([
      { t: "modelSwitched", from: "claude-haiku-4-5", to: "claude-sonnet-4-5" },
    ]);
    // The switched init is accepted, not rejected.
    expect(hookFirst.events.some((event) => event.t === "initRejected")).toBe(false);
    const streamFirst = run([init("claude-haiku-4-5"), assistant, post]);
    expect(switched(streamFirst.events)).toHaveLength(1);
    // An alias in the hook and the full id in the stream are one switch.
    const alias = hook("PostModelSwitch", { to_model: "sonnet" });
    const mixed = run([init("claude-haiku-4-5"), alias, assistant]);
    expect(switched(mixed.events)).toHaveLength(1);
    // Without a planned model, the stream's model change and the hook are one switch too.
    const unplanned = run(
      [init("claude-haiku-4-5"), post, init("claude-sonnet-4-5")],
      initialState(),
    );
    expect(switched(unplanned.events)).toHaveLength(1);
  });
});

describe("the engine's neutral reply as Claude's PermissionRequest output (DIPO-59 AC #3)", () => {
  it("allows, denies with the reason, or gives no decision", () => {
    expect(output("allow")).toEqual([
      {
        hookReply: 640,
        output:
          '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}',
      },
    ]);
    const deny = output("deny", "Use the fixture instead.")[0] as { output: string };
    expect(JSON.parse(deny.output)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "Use the fixture instead." },
      },
    });
    const bare = output("deny")[0] as { output: string };
    expect(JSON.parse(bare.output).hookSpecificOutput.decision.message).toBe(DEFAULT_DENY_MESSAGE);
    expect(output(null)).toEqual([{ hookReply: 640, output: "" }]);
  });
});

describe("the neutral nudge op as Claude's additionalContext (DIPO-60 AC #5)", () => {
  it("puts the text on the pending PostToolUse or SessionStart hook reply", () => {
    const text = "`src/x.ts` is outside the declared scope; the engine will reject it.";
    const [tool] = encode({ kind: "nudge", text, hook: 812, on: "toolUsed" });
    expect(tool).toEqual({
      hookReply: 812,
      output: JSON.stringify({
        hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text },
      }),
    });
    const [start] = encode({ kind: "nudge", text, hook: 90, on: "sessionStarted" }) as [
      { hookReply: number; output: string },
    ];
    expect(start.hookReply).toBe(90);
    expect(JSON.parse(start.output)).toEqual({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
    });
    expect(encode({ kind: "nudge", text: "", hook: 90, on: "toolUsed" })).toEqual([
      { hookReply: 90, output: "" },
    ]);
  });

  it("names the written file of a write tool only, and marks a resumed session", () => {
    expect(
      hookEventOf(
        {
          hook_event_name: "PostToolUse",
          tool_name: "Write",
          tool_input: { file_path: "/w/a.ts" },
        },
        7,
      ),
    ).toEqual({ kind: "toolUsed", id: 7, tool: "Write", wrote: "/w/a.ts" });
    expect(
      hookEventOf(
        {
          hook_event_name: "PostToolUse",
          tool_name: "NotebookEdit",
          tool_input: { notebook_path: "n.ipynb" },
        },
        7,
      ),
    ).toEqual({ kind: "toolUsed", id: 7, tool: "NotebookEdit", wrote: "n.ipynb" });
    expect(
      hookEventOf(
        { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "a.ts" } },
        7,
      ),
    ).toEqual({ kind: "toolUsed", id: 7, tool: "Read" });
    const resumed = hookEventOf({ hook_event_name: "SessionStart", source: "resume" }, 3);
    expect(resumed).toEqual({ kind: "sessionStarted", id: 3, source: "resume", resumed: true });
    expect(ClaudeWorkerEventSchema.safeParse({ t: "hook", hook: resumed }).success).toBe(true);
  });

  it("registers PostToolUse and SessionStart with --nudge and nothing else", () => {
    const hooks = hookSettings(["/opt/dipo"], 300, "/run/dir") as Record<
      string,
      [{ hooks: [{ command: string; timeout: number }] }]
    >;
    for (const name of REGISTERED_HOOKS) {
      const entry = hooks[name]?.[0].hooks[0];
      if (entry === undefined) throw new Error(`no ${name} hook`);
      const nudged = (NUDGE_HOOKS as readonly string[]).includes(name);
      expect(entry.command.endsWith(" --nudge")).toBe(nudged);
      if (nudged) expect(entry.timeout).toBe(HOOK_TIMEOUT_SECONDS);
    }
  });
});
