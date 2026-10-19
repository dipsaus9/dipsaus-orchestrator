import { describe, expect, it } from "bun:test";

import type { Envelope } from "./format";
import {
  DECISION_FIELDS,
  HOOK_RULES,
  isRedacted,
  matchRule,
  redact,
  Scrubber,
  scrubCapture,
  STDOUT_RULES,
  valuesAt,
  WEB_INPUT_FIELDS,
} from "./scrub";
import { guardSecrets, SecretFoundError } from "./secrets";
import { readRecording, serializeStream } from "./format";
import { stdoutOf, usageChecksum } from "./usage";

const ROOTS = [
  { path: "/private/tmp/dipo-abc123/repo.worktrees/story", placeholder: "${WORKDIR}" },
  { path: "/private/tmp/dipo-abc123", placeholder: "${ROOT}" },
  { path: "/home/maintainer", placeholder: "${HOME}" },
];

const PLANTED = "sk-ant-api03-planted-secret-value";

const SESSION = "5b0c1f3e-1111-4222-8333-944455556666";

function out(t: number, data: unknown): Envelope {
  return { t, ch: "stdout", data };
}

/** A synthetic stream in the shape of Claude Code stream-json, with a planted secret. */
function syntheticStream(): Envelope[] {
  return [
    out(5, {
      type: "system",
      subtype: "init",
      session_id: SESSION,
      uuid: "0a0a0a0a-0000-4000-8000-000000000001",
      cwd: "/tmp/dipo-abc123/repo.worktrees/story",
      model: "claude-haiku-4-5",
      permissionMode: "default",
      apiKeySource: "none",
      claude_code_version: "2.1.296",
      tools: ["Read", "Bash"],
      capabilities: ["structured_output"],
      slash_commands: ["review"],
      plugins: [{ name: "x", path: "/home/maintainer/.claude/plugins/x" }],
    }),
    out(10, {
      type: "assistant",
      session_id: SESSION,
      uuid: "0a0a0a0a-0000-4000-8000-000000000002",
      parent_tool_use_id: null,
      message: {
        id: "msg_01ABC",
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5",
        content: [
          { type: "text", text: `here is the key ${PLANTED}` },
          {
            type: "tool_use",
            id: "toolu_01XYZ",
            name: "Read",
            input: { file_path: "/home/maintainer/x" },
          },
        ],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 12,
          output_tokens: 1,
          cache_creation_input_tokens: 300,
          cache_read_input_tokens: 0,
          service_tier: "standard",
        },
      },
    }),
    out(12, {
      type: "user",
      session_id: SESSION,
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_01XYZ",
            content: "Bearer abc.def",
            is_error: false,
          },
        ],
      },
    }),
    out(14, { type: "brand_new_type", subtype: "x", payload: "something" }),
    out(20, {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: SESSION,
      num_turns: 2,
      duration_ms: 1234,
      duration_api_ms: 1000,
      total_cost_usd: 0.0123,
      result: "done",
      terminal_reason: "completed",
      usage: {
        input_tokens: 20,
        output_tokens: 40,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 10,
      },
      modelUsage: { "claude-haiku-4-5": { inputTokens: 20, outputTokens: 40, costUSD: 0.0123 } },
      permission_denials: [
        { tool_name: "Write", tool_use_id: "toolu_02", tool_input: { file_path: "/x" } },
      ],
      structured_output: {
        status: "blocked",
        question: "Which greeting?",
        summary: "free text",
        criteria: [{ n: 1, met: false, evidence: "none" }],
        commitSubject: "chore: x",
      },
    }),
    { t: 21, ch: "stderr", data: `warning at /home/maintainer/.claude ${PLANTED}` },
    { t: 22, ch: "exit", data: { code: 0, signal: null } },
  ];
}

describe("scrubber", () => {
  it("aborts the capture when a planted secret is not redacted, and passes once scrubbed", () => {
    const raw = serializeStream(syntheticStream());
    expect(() => guardSecrets("stream.jsonl", raw)).toThrow(SecretFoundError);
    const { lines } = scrubCapture(syntheticStream(), ROOTS);
    const text = serializeStream(lines);
    expect(text).not.toContain(PLANTED);
    expect(text).not.toContain("/home/maintainer");
    expect(() =>
      guardSecrets("stream.jsonl", text, [{ name: "home", value: "/home/maintainer" }]),
    ).not.toThrow();
  });

  it("aborts when a secret sits in a field the allowlist keeps", () => {
    const stream = [
      out(1, { type: "system", subtype: "init", model: PLANTED, session_id: SESSION }),
    ];
    const text = serializeStream(scrubCapture(stream, ROOTS).lines);
    expect(() => guardSecrets("stream.jsonl", text)).toThrow(SecretFoundError);
  });

  it("keeps allowlisted fields as they are", () => {
    const [init, assistant, , , result] = stdoutOf(
      scrubCapture(syntheticStream(), ROOTS).lines,
    ) as Record<string, any>[];
    expect(init).toMatchObject({
      type: "system",
      subtype: "init",
      model: "claude-haiku-4-5",
      permissionMode: "default",
      apiKeySource: "none",
      claude_code_version: "2.1.296",
      tools: ["Read", "Bash"],
      capabilities: ["structured_output"],
      cwd: "${WORKDIR}",
    });
    expect(assistant?.message.content[1]).toMatchObject({ type: "tool_use", name: "Read" });
    expect(assistant?.message.usage).toEqual({
      input_tokens: 12,
      output_tokens: 1,
      cache_creation_input_tokens: 300,
      cache_read_input_tokens: 0,
      service_tier: "standard",
    });
    expect(result).toMatchObject({
      subtype: "success",
      terminal_reason: "completed",
      num_turns: 2,
      total_cost_usd: 0.0123,
      permission_denials: [{ tool_name: "Write" }],
      structured_output: {
        status: "blocked",
        question: "Which greeting?",
        criteria: [{ n: 1, met: false }],
      },
    });
  });

  it("redacts every other string with the sha256 marker", () => {
    const [init, assistant, user, , result] = stdoutOf(
      scrubCapture(syntheticStream(), ROOTS).lines,
    ) as Record<string, any>[];
    expect(assistant?.message.content[0].text).toBe(redact(`here is the key ${PLANTED}`));
    expect(assistant?.message.content[0].text).toMatch(
      /^\[redacted sha256:[0-9a-f]{12} len:\d+\]$/,
    );
    expect(isRedacted(assistant?.message.content[1].input.file_path)).toBe(true);
    expect(isRedacted(user?.message.content[0].content)).toBe(true);
    // Names from the maintainer's setup keep only their length, never a reversible hash.
    expect(init?.slash_commands).toEqual(["[redacted len:6]"]);
    expect(init?.plugins).toEqual([{ name: "[redacted len:1]", path: "[redacted len:34]" }]);
    expect(isRedacted(init?.slash_commands[0])).toBe(true);
    expect(isRedacted(result?.result)).toBe(true);
    expect(isRedacted(result?.structured_output.summary)).toBe(true);
    expect(isRedacted(result?.structured_output.criteria[0].evidence)).toBe(true);
    expect(isRedacted(result?.permission_denials[0].tool_input.file_path)).toBe(true);
  });

  it("keeps a review report's enums and numbers, and redacts its text (DIPO-145)", () => {
    const review = {
      type: "result",
      subtype: "success",
      session_id: SESSION,
      structured_output: {
        criteria: [{ n: 1, status: "unmet", evidence: "greet.ts returns Hi" }],
        findings: [
          {
            severity: "blocking",
            kind: "correctness",
            criterion: 1,
            testEntry: 2,
            file: "src/greet.ts",
            line: 3,
            quote: "return `Hi ${name}`;",
            text: "Wrong greeting.",
          },
        ],
        summary: "One criterion unmet.",
      },
    };
    const [result] = stdoutOf(scrubCapture([out(1, review)], ROOTS).lines) as Record<string, any>[];
    const report = result?.structured_output;
    expect(report.criteria[0]).toMatchObject({ n: 1, status: "unmet" });
    expect(report.findings[0]).toMatchObject({
      severity: "blocking",
      kind: "correctness",
      criterion: 1,
      testEntry: 2,
      line: 3,
    });
    for (const text of [
      report.criteria[0].evidence,
      report.findings[0].file,
      report.findings[0].quote,
      report.findings[0].text,
      report.summary,
    ]) {
      expect(isRedacted(text)).toBe(true);
    }
  });

  it("redacts an unknown message type whole and reports it", () => {
    const { lines, report } = scrubCapture(syntheticStream(), ROOTS);
    const unknown = stdoutOf(lines)[3] as Record<string, unknown>;
    expect(Object.keys(unknown).toSorted()).toEqual(["redacted", "subtype", "type"]);
    expect(unknown).toMatchObject({ type: "brand_new_type", subtype: "x" });
    expect(isRedacted(unknown.redacted)).toBe(true);
    expect(report.unknownTypes).toEqual(["brand_new_type/x"]);
  });

  it("redacts an unknown system subtype and an unknown hook event whole", () => {
    const scrubber = new Scrubber(ROOTS);
    expect(scrubber.stdout({ type: "system", subtype: "mystery", text: "x" })).toMatchObject({
      type: "system",
      subtype: "mystery",
    });
    expect(scrubber.hook({ hook_event_name: "Mystery", prompt: "x" })).toMatchObject({
      hook_event_name: "Mystery",
    });
    expect(scrubber.report.unknownTypes).toEqual(["system/mystery", "hook:Mystery"]);
  });

  it("redacts every stderr line and keeps the exit status", () => {
    const { lines } = scrubCapture(syntheticStream(), ROOTS);
    expect(isRedacted(lines.find((line) => line.ch === "stderr")?.data)).toBe(true);
    expect(lines.at(-1)).toEqual({ t: 22, ch: "exit", data: { code: 0, signal: null } });
  });

  it("changes no usage number", () => {
    const raw = syntheticStream();
    const { lines } = scrubCapture(raw, ROOTS);
    expect(usageChecksum(stdoutOf(lines))).toBe(usageChecksum(stdoutOf(raw)));
  });

  it("keeps the arrival times", () => {
    const { lines } = scrubCapture(syntheticStream(), ROOTS);
    expect(lines.map((line) => line.t)).toEqual(syntheticStream().map((line) => line.t));
  });
});

describe("normaliser", () => {
  it("maps ids to stable placeholders within a recording", () => {
    const { lines } = scrubCapture(syntheticStream(), ROOTS);
    const [init, assistant, user, , result] = stdoutOf(lines) as Record<string, any>[];
    expect(init?.session_id).toBe("session-1");
    expect(result?.session_id).toBe("session-1");
    expect(init?.uuid).toBe("uuid-1");
    expect(assistant?.uuid).toBe("uuid-2");
    expect(assistant?.message.id).toBe("msg-1");
    expect(assistant?.message.content[1].id).toBe("toolu-1");
    expect(user?.message.content[0].tool_use_id).toBe("toolu-1");
    expect(result?.permission_denials[0].tool_use_id).toBe("toolu-2");
  });

  it("gives the same placeholder for the same id in a second process of the capture", () => {
    const scrubber = new Scrubber(ROOTS);
    scrubber.stdout({ type: "system", subtype: "init", session_id: SESSION });
    const resumed = scrubber.stdout({
      type: "system",
      subtype: "init",
      session_id: SESSION,
    }) as Record<string, unknown>;
    expect(resumed.session_id).toBe("session-1");
  });

  it("maps the temp, worktree and home paths, also through /private, to placeholders", () => {
    const scrubber = new Scrubber(ROOTS);
    expect(scrubber.normalisePaths("/tmp/dipo-abc123/repo.worktrees/story/src")).toBe(
      "${WORKDIR}/src",
    );
    expect(scrubber.normalisePaths("/private/tmp/dipo-abc123/repo/.git")).toBe("${ROOT}/repo/.git");
    expect(scrubber.normalisePaths("/home/maintainer/.claude")).toBe("${HOME}/.claude");
  });

  it("replaces transcript paths and redacts a path field that still holds a real path", () => {
    const scrubber = new Scrubber(ROOTS);
    const hook = scrubber.hook({
      hook_event_name: "SessionStart",
      session_id: SESSION,
      transcript_path: "/home/maintainer/.claude/projects/x/y.jsonl",
      cwd: "/opt/elsewhere",
      source: "startup",
    }) as Record<string, unknown>;
    expect(hook).toMatchObject({
      transcript_path: "${TRANSCRIPT}",
      source: "startup",
      session_id: "session-1",
    });
    expect(isRedacted(hook.cwd)).toBe(true);
  });

  it("redacts object keys that look like paths", () => {
    const scrubber = new Scrubber(ROOTS);
    const user = scrubber.stdout({ type: "user", snapshot: { "/home/maintainer/a": 1 } }) as Record<
      string,
      any
    >;
    expect(Object.keys(user.snapshot)[0]).toMatch(/^\[redacted sha256:/);
  });
});

describe("allowlist", () => {
  it("keeps every decision field", () => {
    for (const [kind, fields] of Object.entries(DECISION_FIELDS)) {
      const type = kind.split("/")[0] ?? kind;
      const rules = [...(STDOUT_RULES[kind] ?? STDOUT_RULES[type] ?? [])];
      for (const field of fields) {
        if (["type", "subtype", "model", "permissionMode", "is_error"].includes(field)) continue;
        expect({
          kind,
          field,
          action: matchRule(
            rules,
            field.split(".").map((part) => (part === "*" ? "0" : part)),
          ),
        }).toEqual({
          kind,
          field,
          action: "keep",
        });
      }
    }
  });

  it("knows the hook events 0008 section 5 registers", () => {
    for (const event of [
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
    ]) {
      expect(HOOK_RULES[event]).toBeDefined();
    }
  });

  it("reads values at a pattern", () => {
    expect(valuesAt({ a: [{ b: 1 }, { b: 2 }] }, "a.*.b")).toEqual([1, 2]);
  });
});

describe("normaliser on keys", () => {
  it("normalises object keys that are ids, consistently with the same id as a value", () => {
    const scrubber = new Scrubber(ROOTS);
    const assistant = scrubber.stdout({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "toolu_01KEYabcdefghij", name: "StructuredOutput" }],
      },
      wire_tool_inputs: { toolu_01KEYabcdefghij: { status: "done" } },
    }) as Record<string, any>;
    expect(assistant.message.content[0].id).toBe("toolu-1");
    expect(Object.keys(assistant.wire_tool_inputs)).toEqual(["toolu-1"]);
  });
});

function assistantCall(id: string, name: string, input: Record<string, unknown>) {
  return {
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input }] },
    wire_tool_inputs: { [id]: input },
  };
}

function toolResult(id: string, content: unknown, isError?: true) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) },
      ],
    },
  };
}

/** The web text of a recording: PreToolUse inputs, web tool_use and wire inputs, tool results. */
function webText(lines: readonly Envelope[]): unknown[] {
  return lines.flatMap((line) => {
    const data = line.data as Record<string, any>;
    if (line.ch === "hook") {
      const field = WEB_INPUT_FIELDS[data.tool_name];
      return data.hook_event_name === "PreToolUse" && field !== undefined ? [data.tool_input] : [];
    }
    if (line.ch !== "stdout" || !Array.isArray(data.message?.content)) return [];
    return (data.message.content as Record<string, any>[]).flatMap((block) => {
      if (block.type === "tool_use" && WEB_INPUT_FIELDS[block.name] !== undefined) {
        return [block.input, data.wire_tool_inputs];
      }
      return block.type === "tool_result" ? [block.content] : [];
    });
  });
}

/** Ids normalised again and redaction markers redacted again read alike; plain text stays. */
function plain(values: readonly unknown[]): string[] {
  return values.map((value) =>
    JSON.stringify(value)
      .replaceAll(/\[redacted sha256:[0-9a-f]{12} len:\d+\]/g, "[redacted]")
      .replaceAll(/toolu-w\d|id-\d+/g, "<id>"),
  );
}

describe("web rules (DIPO-164 review)", () => {
  const URL = "https://example.com/lookup?token=fixture-env-value-7f3a9c";
  const REFUSAL = "The URL contains a value from .env (FIXTURE_API_KEY); never send env values.";

  it("keeps a web tool's query or URL on its tool_use, wire input and PreToolUse line, and nothing else", () => {
    const scrubber = new Scrubber(ROOTS);
    const fetch = scrubber.stdout(
      assistantCall("toolu_01WEBabcdefghij", "WebFetch", { url: URL, prompt: "read it" }),
    ) as Record<string, any>;
    expect(fetch.message.content[0].input.url).toBe(URL);
    expect(isRedacted(fetch.message.content[0].input.prompt)).toBe(true);
    expect(fetch.wire_tool_inputs["toolu-1"].url).toBe(URL);
    const search = scrubber.stdout(
      assistantCall("toolu_01WEBsearchabcd", "WebSearch", { query: "bun test docs" }),
    ) as Record<string, any>;
    expect(search.message.content[0].input.query).toBe("bun test docs");
    // Another tool's `url` or `query` stays redacted.
    const other = scrubber.stdout(
      assistantCall("toolu_01OTHERabcdefgh", "ToolSearch", { query: "q", url: URL }),
    ) as Record<string, any>;
    expect(isRedacted(other.message.content[0].input.query)).toBe(true);
    expect(isRedacted(other.message.content[0].input.url)).toBe(true);

    const hook = (tool: string, input: Record<string, unknown>) =>
      scrubber.hook({
        hook_event_name: "PreToolUse",
        tool_name: tool,
        tool_input: input,
      }) as Record<string, any>;
    expect(hook("WebFetch", { url: URL }).tool_input.url).toBe(URL);
    expect(hook("WebSearch", { query: "bun test docs" }).tool_input.query).toBe("bun test docs");
    expect(isRedacted(hook("Bash", { url: URL }).tool_input.url)).toBe(true);
    const post = scrubber.hook({
      hook_event_name: "PostToolUse",
      tool_name: "WebFetch",
      tool_input: { url: URL },
    }) as Record<string, any>;
    expect(isRedacted(post.tool_input.url)).toBe(true);
  });

  it("keeps the error result of a web call (the hook's refusal) and redacts a fetched page", () => {
    const scrubber = new Scrubber(ROOTS);
    scrubber.stdout(assistantCall("toolu_01WEBabcdefghij", "WebFetch", { url: URL }));
    scrubber.stdout(assistantCall("toolu_01READabcdefgh", "Read", { file_path: "/x" }));
    const refused = scrubber.stdout(toolResult("toolu_01WEBabcdefghij", REFUSAL, true)) as Record<
      string,
      any
    >;
    expect(refused.message.content[0].content).toBe(REFUSAL);
    const blocks = scrubber.stdout(
      toolResult("toolu_01WEBabcdefghij", [{ type: "text", text: REFUSAL }], true),
    ) as Record<string, any>;
    expect(blocks.message.content[0].content[0].text).toBe(REFUSAL);
    const page = scrubber.stdout(toolResult("toolu_01WEBabcdefghij", "page text")) as Record<
      string,
      any
    >;
    expect(isRedacted(page.message.content[0].content)).toBe(true);
    const read = scrubber.stdout(toolResult("toolu_01READabcdefgh", "error text", true)) as Record<
      string,
      any
    >;
    expect(isRedacted(read.message.content[0].content)).toBe(true);
  });

  it("keep through a capture exactly the web text the derived web-calls recording shows (its cites)", () => {
    const recording = readRecording("web-calls");
    const scrubber = new Scrubber(ROOTS);
    const captured = recording.lines.map((line) => scrubber.envelope(line));
    const kept = webText(recording.lines);
    // The three hook lines, three tool_use inputs and wire inputs, and the four results.
    expect(kept).toHaveLength(13);
    expect(plain(webText(captured))).toEqual(plain(kept));
    expect(plain(kept).filter((text) => text.includes("fixture-env-value"))).toHaveLength(3);
    expect(plain(kept).some((text) => text.includes(".env (FIXTURE_API_KEY)"))).toBe(true);
  });
});
