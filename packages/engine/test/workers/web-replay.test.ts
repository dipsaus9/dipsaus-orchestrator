// The web recording replayed (DIPO-164; 0020 section 11b, 0017 section 2): the derived
// `web-calls` recording, with a WebSearch, a WebFetch and a WebFetch the PreToolUse hook refused,
// parses through the adapter, each web call shows in the worker output with its query or URL, the
// hook lines relay the whole query or URL, and the calls are counted by tool.

import { describe, expect, it } from "bun:test";

import { findSecret, refusalText, webCallCounts } from "../../src/hooks";
import { WEB_TOOLS } from "../../src/workers/types";
import { loadRecording, replay } from "./replay";

// The fixture env file of the `web` scenario (tools/recordings/scenarios.ts).
const ENV = { file: ".env", key: "FIXTURE_API_KEY", value: "fixture-env-value-7f3a9c" };
const QUERY = "bun test runner documentation";
const URL = "https://bun.sh/docs/cli/test";
const REFUSED_URL = `https://example.com/lookup?token=${ENV.value}`;

type Json = Record<string, unknown>;

/** The message content blocks of the recording's stdout lines of `type`. */
function blocks(name: string, type: string): Json[] {
  return loadRecording(name).lines.flatMap((line) => {
    const data = line.data as Json;
    if (line.ch !== "stdout" || data["type"] !== type) return [];
    const content = (data["message"] as { content?: unknown } | undefined)?.content;
    return Array.isArray(content) ? (content as Json[]) : [];
  });
}

/** The text of a tool result: a string, or its text blocks joined. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Json[]).map((part) => String(part["text"] ?? "")).join("");
}

/**
 * The result of the recording's third web call, found by order, not by id, so the test reads a
 * live capture of the `web` scenario as it reads the derived recording.
 */
function thirdWebResult(name: string): { text: string; isError: boolean } {
  const ids = blocks(name, "assistant")
    .filter((block) => block["type"] === "tool_use" && WEB_TOOLS.includes(String(block["name"])))
    .map((block) => block["id"]);
  const result = blocks(name, "user").find(
    (block) => block["type"] === "tool_result" && block["tool_use_id"] === ids[2],
  );
  return { text: resultText(result?.["content"]), isError: result?.["is_error"] === true };
}

describe("the web-calls recording (DIPO-164)", () => {
  it("parses, shows each web call with its query or URL, and counts the calls by tool", async () => {
    const run = await replay(loadRecording("web-calls"));
    expect(run.state.problems).toEqual([]);
    expect(run.state.unknownTypes).toEqual([]);

    const output = run.events.flatMap((event) => (event.t === "output" ? [event.text] : []));
    expect(output.filter((text) => text.startsWith("[web] "))).toEqual([
      `[web] WebSearch ${QUERY}\n`,
      `[web] WebFetch ${URL}\n`,
      `[web] WebFetch ${REFUSED_URL}\n`,
    ]);
    expect(webCallCounts(run.events)).toEqual({ WebSearch: 1, WebFetch: 2 });
  });

  it("relays the whole query or URL on the PreToolUse lines, and only the third holds an env value", async () => {
    const run = await replay(loadRecording("web-calls"));
    const calls = run.events.flatMap((event) =>
      event.t === "hook" && event.hook.kind === "webCall"
        ? [{ tool: event.hook.tool, target: event.hook.target }]
        : [],
    );
    expect(calls).toEqual([
      { tool: "WebSearch", target: QUERY },
      { tool: "WebFetch", target: URL },
      { tool: "WebFetch", target: REFUSED_URL },
    ]);
    expect(calls.map((call) => findSecret(call.target, [ENV]))).toEqual([
      null,
      null,
      { file: ENV.file, key: ENV.key },
    ]);
  });

  it("gives the refused call the engine's reason, naming the file and key and not the value", () => {
    const refused = thirdWebResult("web-calls");
    expect(refused.isError).toBe(true);
    // Claude Code may wrap the hook's reason in text of its own.
    expect(refused.text).toContain(refusalText("WebFetch", { file: ENV.file, key: ENV.key }));
    expect(refused.text).toContain(".env (FIXTURE_API_KEY)");
    expect(refused.text).not.toContain(ENV.value);
  });
});
