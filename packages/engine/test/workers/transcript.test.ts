// The Claude adapter's transcript parser (DIPO-134; 0008 section 4): it keeps only message id,
// model and usage, ignores lines it does not understand, and refuses a Claude Code version outside
// the range recordings cover.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  readTranscript,
  TRANSCRIPT_BEFORE_VERSION,
  TRANSCRIPT_MIN_VERSION,
  transcriptSupported,
} from "../../src/workers/claude-cli/transcript";

const FIXTURE = join(import.meta.dir, "..", "recordings", "transcripts", "host-died");
const lines = (file: string): string[] => readFileSync(join(FIXTURE, file), "utf8").split("\n");

describe("the transcript parser (DIPO-134)", () => {
  it("keeps one usage per message id, from the last line of a repeated message", () => {
    const read = readTranscript(lines("transcript.jsonl"), "2.1.296");
    expect(read).toEqual({
      ok: true,
      messages: [
        {
          messageId: "msg-1",
          model: "claude-haiku-5-5",
          input: 2,
          output: 16,
          cacheCreate: 7839,
          cacheCreate5m: 0,
          cacheCreate1h: 7839,
          cacheRead: 0,
        },
        {
          messageId: "msg-2",
          model: "claude-haiku-5-5",
          input: 2,
          output: 7,
          cacheCreate: 660,
          cacheCreate5m: 0,
          cacheCreate1h: 660,
          cacheRead: 7839,
        },
        {
          messageId: "msg-3",
          model: "claude-haiku-5-5",
          input: 3,
          output: 40,
          cacheCreate: 100,
          cacheCreate5m: 100,
          cacheCreate1h: 0,
          cacheRead: 0,
        },
      ],
    });
  });

  it("ignores lines it does not understand: unknown types, odd shapes, non-JSON, synthetic", () => {
    const read = readTranscript(
      [
        "not json",
        "",
        "[]",
        '{"type":"future-line","payload":{"a":1}}',
        '{"type":"assistant","message":{"id":"m","model":"x","usage":"odd"}}',
        '{"type":"assistant","message":{"id":"m","model":"x","usage":{"input_tokens":-1,"output_tokens":1}}}',
        '{"type":"assistant","message":{"id":"s","model":"<synthetic>","usage":{"input_tokens":0,"output_tokens":0}}}',
        '{"type":"assistant","message":{"id":"ok","model":"claude-haiku-5-5","usage":{"input_tokens":1,"output_tokens":2}}}',
      ],
      "2.1.300",
    );
    expect(read).toMatchObject({ ok: true });
    expect(read.ok && read.messages.map((m) => m.messageId)).toEqual(["ok"]);
  });

  it("takes no text, thinking or tool content from a line", () => {
    const read = readTranscript(lines("transcript.jsonl"), "2.1.296");
    expect(JSON.stringify(read)).not.toContain("${");
  });

  it("refuses a Claude Code version outside the covered range, or none", () => {
    for (const version of [null, "", "2.1.295", "2.2.0", "3.0.1", "dev"]) {
      const read = readTranscript(lines("transcript.jsonl"), version);
      expect(read.ok).toBe(false);
      expect(!read.ok && read.reason).toContain(TRANSCRIPT_MIN_VERSION);
    }
    for (const version of [TRANSCRIPT_MIN_VERSION, "2.1.301", "2.1.9999"]) {
      expect(transcriptSupported(version)).toBe(true);
    }
    expect(transcriptSupported(TRANSCRIPT_BEFORE_VERSION)).toBe(false);
  });
});
