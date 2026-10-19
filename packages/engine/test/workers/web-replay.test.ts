// The web recording replayed (DIPO-164; 0020 section 11b, 0017 section 2): the derived
// `web-calls` recording, with a WebSearch, a WebFetch and a WebFetch the PreToolUse hook refused,
// parses through the adapter, each web call shows in the worker output with its query or URL, the
// hook lines relay the whole query or URL, and the calls are counted by tool.

import { describe, expect, it } from "bun:test";

import { findSecret, refusalText, webCallCounts } from "../../src/hooks";
import { loadRecording, replay } from "./replay";

// The fixture env file of the `web` scenario (tools/recordings/scenarios.ts).
const ENV = { file: ".env", key: "FIXTURE_API_KEY", value: "fixture-env-value-7f3a9c" };
const QUERY = "bun test runner documentation";
const URL = "https://bun.sh/docs/cli/test";
const REFUSED_URL = `https://example.com/lookup?token=${ENV.value}`;

type Json = Record<string, unknown>;

/** The text of every tool_result in the recording, by tool use id. */
function toolResults(name: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of loadRecording(name).lines) {
    const data = line.data as Json;
    if (line.ch !== "stdout" || data["type"] !== "user") continue;
    for (const block of (data["message"] as { content: Json[] }).content) {
      if (block["type"] === "tool_result" && typeof block["content"] === "string") {
        out.set(block["tool_use_id"] as string, block["content"]);
      }
    }
  }
  return out;
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
    const refused = toolResults("web-calls").get("toolu-w3") ?? "";
    expect(refused).toBe(refusalText("WebFetch", { file: ENV.file, key: ENV.key }));
    expect(refused).toContain(".env (FIXTURE_API_KEY)");
    expect(refused).not.toContain(ENV.value);
  });
});
