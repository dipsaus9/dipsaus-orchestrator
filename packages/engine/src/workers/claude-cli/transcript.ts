// The Claude Code transcript parser (0008 section 4, DIPO-134). The transcript
// (`<session>.jsonl`, and one file per subagent) is internal to Claude Code, so it is read only
// here, behind the worker port, and only for what the engine lacks after a worker host died
// without `exit.json`: the usage of the assistant messages. A line is kept for its message id,
// model and usage; every other line, and every line of a shape this parser does not understand, is
// ignored. A version outside the range recordings cover is refused whole, so a format change never
// turns into wrong numbers.

import { z } from "zod";

import type { TranscriptMessage, TranscriptRead } from "../types";

/** The first Claude Code version whose transcript is covered by a recording. */
export const TRANSCRIPT_MIN_VERSION = "2.1.296";
/** The first version above the range; the format may have changed there. */
export const TRANSCRIPT_BEFORE_VERSION = "2.2.0";

function versionParts(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < 3; index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Whether this parser reads the transcript format of the Claude Code `version`. */
export function transcriptSupported(version: string | null): boolean {
  if (version === null) return false;
  const parts = versionParts(version);
  const min = versionParts(TRANSCRIPT_MIN_VERSION);
  const before = versionParts(TRANSCRIPT_BEFORE_VERSION);
  if (parts === null || min === null || before === null) return false;
  return compare(parts, min) >= 0 && compare(parts, before) < 0;
}

const Tokens = z.number().int().nonnegative();

const TranscriptLine = z.object({
  type: z.literal("assistant"),
  message: z.object({
    id: z.string().min(1),
    model: z.string().min(1),
    usage: z.object({
      input_tokens: Tokens,
      output_tokens: Tokens,
      cache_creation_input_tokens: Tokens.optional(),
      cache_read_input_tokens: Tokens.optional(),
      cache_creation: z
        .object({
          ephemeral_5m_input_tokens: Tokens.optional(),
          ephemeral_1h_input_tokens: Tokens.optional(),
        })
        .optional(),
    }),
  }),
});

/** Claude Code writes this model for a message it made up itself (no API call, no usage). */
const SYNTHETIC_MODEL = "<synthetic>";

/** The usage of one transcript line, or null for a line that holds none or is not understood. */
function messageOf(text: string): TranscriptMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = TranscriptLine.safeParse(value);
  if (!parsed.success || parsed.data.message.model === SYNTHETIC_MODEL) return null;
  const { id, model, usage } = parsed.data.message;
  const cacheCreate = usage.cache_creation_input_tokens ?? 0;
  const oneHour = Math.min(cacheCreate, usage.cache_creation?.ephemeral_1h_input_tokens ?? 0);
  return {
    messageId: id,
    model,
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheCreate,
    cacheCreate5m: cacheCreate - oneHour,
    cacheCreate1h: oneHour,
    cacheRead: usage.cache_read_input_tokens ?? 0,
  };
}

/**
 * Pure: the usage messages of transcript `lines`, one per message id (a message is written once
 * per content block, and the last line carries its final output), in order of first appearance.
 * Refused, with a reason, when the Claude Code `version` is unknown or outside the covered range.
 */
export function readTranscript(lines: readonly string[], version: string | null): TranscriptRead {
  if (!transcriptSupported(version)) {
    return {
      ok: false,
      reason: `the transcript format of Claude Code ${version ?? "unknown"} is not covered (${TRANSCRIPT_MIN_VERSION} up to ${TRANSCRIPT_BEFORE_VERSION})`,
    };
  }
  const byId = new Map<string, TranscriptMessage>();
  for (const line of lines) {
    const message = messageOf(line);
    if (message !== null) byId.set(message.messageId, message);
  }
  return { ok: true, messages: [...byId.values()] };
}
