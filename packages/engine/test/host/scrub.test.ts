// The host's stdout scrub (DIPO-105) with the Claude rule: the text, signature and redacted data
// of a thinking block leave the line, the rest of it stays, and a line without thinking comes back
// byte for byte.

import { describe, expect, it } from "bun:test";

import { LineSplitter } from "../../src/host/events";
import { LineScrubber, scrubLine } from "../../src/host/scrub";
import { CLAUDE_LINE_SCRUB } from "../../src/workers/claude-cli/adapter";
import { hostLines } from "../ingest/helpers";
import { loadRecording, recordingNames } from "../workers/replay";

const THOUGHT = "PRIVATE-THOUGHT the maintainer must never see this";
const SIGNATURE = "SIGNATURE-EqQBCkYIBxgCKkDopaqueBlob0123456789";
const MIB = 1024 * 1024;

function line(data: unknown): string {
  return `${JSON.stringify(data)}\n`;
}

/** `text` cut into pieces the way the host's pump does, each scrubbed, joined as the event file holds them. */
function pumped(text: string, maxLine?: number): string {
  const splitter = new LineSplitter();
  const scrubber = new LineScrubber(CLAUDE_LINE_SCRUB, maxLine);
  const out: string[] = [];
  const keep = (piece: string) => {
    const data = scrubber.push(piece);
    if (data !== null) out.push(data);
  };
  for (const piece of splitter.push(text)) keep(piece);
  const rest = splitter.flush();
  if (rest !== null) keep(rest);
  const tail = scrubber.flush();
  if (tail !== null) out.push(tail);
  return out.join("");
}

/** A thinking block whose text is `size` bytes long, in the fields' order `thinkingFirst` or not. */
function bigThinking(size: number, thinkingFirst: boolean): string {
  const text = `${THOUGHT} ${"t".repeat(size)}`;
  const block = thinkingFirst
    ? { type: "thinking", thinking: text, signature: SIGNATURE }
    : { thinking: text, signature: SIGNATURE, type: "thinking" };
  return line({ type: "assistant", message: { content: [block] }, session_id: "s-1" });
}

describe("worker host stdout scrub (DIPO-105)", () => {
  it("removes the text and signature of a thinking block and keeps its type and the duration", () => {
    const input = line({
      type: "assistant",
      message: {
        id: "msg-1",
        content: [{ type: "thinking", thinking: THOUGHT, signature: SIGNATURE }],
        usage: { output_tokens: 7 },
      },
      thinking_duration_ms: 1520,
      session_id: "s-1",
    });
    const output = scrubLine(input, CLAUDE_LINE_SCRUB);
    expect(output).not.toContain("PRIVATE-THOUGHT");
    expect(output).not.toContain("SIGNATURE-");
    expect(output.endsWith("\n")).toBe(true);
    expect(JSON.parse(output)).toEqual({
      type: "assistant",
      message: {
        id: "msg-1",
        content: [{ type: "thinking" }],
        usage: { output_tokens: 7 },
      },
      thinking_duration_ms: 1520,
      session_id: "s-1",
    });
  });

  it("removes the encrypted data of a redacted thinking block and keeps its type", () => {
    const input = line({
      type: "assistant",
      message: { content: [{ type: "redacted_thinking", data: "OPAQUE-DATA" }] },
    });
    const output = scrubLine(input, CLAUDE_LINE_SCRUB);
    expect(output).not.toContain("OPAQUE-DATA");
    expect(JSON.parse(output)).toEqual({
      type: "assistant",
      message: { content: [{ type: "redacted_thinking" }] },
    });
  });

  it("removes the text of a thinking block start and of its deltas, and keeps the token estimate", () => {
    const start = line({
      type: "stream_event",
      event: {
        type: "content_block_start",
        content_block: { type: "thinking", thinking: THOUGHT, signature: SIGNATURE },
      },
    });
    const delta = line({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: THOUGHT, estimated_tokens: 42 },
      },
    });
    const sig = line({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "signature_delta", signature: SIGNATURE },
      },
    });
    const outputs = [start, delta, sig].map((input) => scrubLine(input, CLAUDE_LINE_SCRUB));
    expect(outputs.join("")).not.toContain("PRIVATE-THOUGHT");
    expect(outputs.join("")).not.toContain("SIGNATURE-");
    expect(JSON.parse(outputs[1] ?? "")).toEqual({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "thinking_delta", estimated_tokens: 42 },
      },
    });
  });

  it("returns a line without thinking byte for byte", () => {
    const input = line({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] },
    });
    expect(scrubLine(input, CLAUDE_LINE_SCRUB)).toBe(input);
  });

  it("returns a piece that is not JSON as it came", () => {
    const piece = '{"type":"assistant","message":{"content":[{"type":"thinking","thin';
    expect(scrubLine(piece, CLAUDE_LINE_SCRUB)).toBe(piece);
  });

  it("leaves the thinking token estimate line byte for byte", () => {
    const input = line({
      type: "system",
      subtype: "thinking_tokens",
      estimated_tokens: 9,
      estimated_tokens_delta: 4,
    });
    expect(scrubLine(input, CLAUDE_LINE_SCRUB)).toBe(input);
  });

  it("writes every stdout line of every live recording as valid JSON with no thinking left", () => {
    let scrubbed = 0;
    for (const name of recordingNames()) {
      for (const hostLine of hostLines(loadRecording(name))) {
        if (hostLine.ch !== "stdout") continue;
        const output = scrubLine(hostLine.data, CLAUDE_LINE_SCRUB);
        // crash-truncated ends in a cut-off line, which stays as it came.
        if (!isJson(hostLine.data)) {
          expect(output).toBe(hostLine.data);
          continue;
        }
        expect(thinkingFieldsIn(JSON.parse(output))).toEqual([]);
        if (output !== hostLine.data) scrubbed += 1;
        // A line comes back changed only when it held a thinking field.
        else expect(thinkingFieldsIn(JSON.parse(hostLine.data))).toEqual([]);
      }
    }
    expect(scrubbed).toBeGreaterThan(0);
  });
});

describe("worker host stdout scrub of capped lines (DIPO-175)", () => {
  it("removes the thinking text of a 5 MiB line whose text spans two pieces", () => {
    const input = bigThinking(5 * MIB, true);
    expect(new LineSplitter().push(input).length).toBeGreaterThan(1);
    const output = pumped(input);
    expect(output).not.toContain("PRIVATE-THOUGHT");
    expect(output).not.toContain("tttttttttt");
    expect(output).not.toContain(SIGNATURE);
    expect(JSON.parse(output)).toEqual({
      type: "assistant",
      message: { content: [{ type: "thinking" }] },
      session_id: "s-1",
    });
  });

  it("removes the thinking text of a 5 MiB line whose block type comes after the text", () => {
    const input = bigThinking(5 * MIB, false);
    expect(new LineSplitter().push(input).length).toBeGreaterThan(1);
    const output = pumped(input);
    expect(output).not.toContain("PRIVATE-THOUGHT");
    expect(output).not.toContain("tttttttttt");
    expect(output).not.toContain(SIGNATURE);
    expect(JSON.parse(output)).toEqual({
      message: { content: [{ type: "thinking" }] },
      session_id: "s-1",
      type: "assistant",
    });
  });

  it("stores a capped line without a thinking block as it came", () => {
    const input = line({
      type: "assistant",
      message: { content: [{ type: "text", text: "a".repeat(5 * MIB) }] },
    });
    expect(new LineSplitter().push(input).length).toBeGreaterThan(1);
    expect(pumped(input)).toBe(input);
  });

  it("stores a line under the cap as it came, and scrubs its thinking", () => {
    const plain = line({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
    expect(pumped(plain)).toBe(plain);
    const thinking = bigThinking(1024, true);
    const output = pumped(thinking);
    expect(output).not.toContain("PRIVATE-THOUGHT");
    expect(output).toBe(scrubLine(thinking, CLAUDE_LINE_SCRUB));
  });

  it("drops a line over the held cap and keeps the lines after it", () => {
    const after = line({ type: "system", subtype: "init" });
    const input = bigThinking(3 * MIB, true);
    const output = pumped(`${input}${after}`, MIB);
    expect(output).not.toContain("PRIVATE-THOUGHT");
    expect(output).toBe(after);
  });

  it("drops a line that never ends, and holds no more than the cap", () => {
    const scrubber = new LineScrubber(CLAUDE_LINE_SCRUB, 10);
    const pieces = ['{"type":"thinking",', '"thinking":"xxxxxxxxxx', "xxxxxxxxxx", "xxxxxxxxxx"];
    for (const piece of pieces) expect(scrubber.push(piece)).toBeNull();
    expect(scrubber.push('"}\n')).toBeNull();
    expect(scrubber.flush()).toBeNull();
  });
});

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where Claude stream-json carries thinking content, by the type of the object that holds it. Kept
 * apart from the adapter's rule so the test checks the rule instead of repeating it.
 */
const THINKING_CONTENT: Readonly<Record<string, readonly string[]>> = {
  thinking: ["thinking", "signature"],
  redacted_thinking: ["data"],
  thinking_delta: ["thinking"],
  signature_delta: ["signature"],
};

/** Every thinking content field anywhere under `value`, as `<type>.<field>`. */
function thinkingFieldsIn(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const type = record["type"];
  const own = (typeof type === "string" ? (THINKING_CONTENT[type] ?? []) : [])
    .filter((field) => field in record)
    .map((field) => `${String(type)}.${field}`);
  return [...own, ...Object.values(record).flatMap(thinkingFieldsIn)];
}
