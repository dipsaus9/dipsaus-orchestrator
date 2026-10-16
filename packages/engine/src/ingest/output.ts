// What worker output is stored (0007 section 8): the main agent's text, plus one line per tool
// call with the tool name and its target path. Shell command text, tool inputs and tool results
// never reach `output_chunks` by default.
//
// With the machine-local opt-in `privacy.storeCommandBodies` (0007 section 8, DIPO-83) the tool
// line also holds the call's input as one line: `[tool] Bash bun test`. Line breaks and other
// control characters become spaces, and an input longer than `INPUT_MAX_CHARS` is cut with a marker
// that says how much was left out.
//
// A finished thinking block of the main agent is one line of counts (DIPO-96): `[thinking] 0.9s
// ~265 tokens`. It holds no thinking text; the worker event carries none.

import type { WorkerEvent } from "../workers/types";

/** The most characters of a tool input one stored tool line holds. */
export const INPUT_MAX_CHARS = 200;

/** What ingestion may store beyond the default (0007 section 8). */
export interface OutputPrivacy {
  /** `privacy.storeCommandBodies`: tool inputs in `output_chunks`. */
  readonly storeCommandBodies: boolean;
}

export const DEFAULT_OUTPUT_PRIVACY: OutputPrivacy = { storeCommandBodies: false };

/** `input` as one line of at most `INPUT_MAX_CHARS` characters, cut with a marker. */
export function oneLineInput(input: string): string {
  // Every run of whitespace or control characters (line breaks, tabs, escapes) is one space.
  // oxlint-disable-next-line no-control-regex
  const line = input.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  const chars = Array.from(line);
  if (chars.length <= INPUT_MAX_CHARS) return line;
  const cut = chars.length - INPUT_MAX_CHARS;
  return `${chars.slice(0, INPUT_MAX_CHARS).join("").trimEnd()} [cut ${cut} more chars]`;
}

/**
 * The line stored for one tool call: `[tool] Read src/greet.ts`, `[tool] Bash`, or with the opt-in
 * `[tool] Bash bun test`.
 */
export function toolLine(tool: string, path?: string, input?: string): string {
  const parts = [`[tool] ${tool}`];
  if (path !== undefined) parts.push(path);
  if (input !== undefined) {
    const line = oneLineInput(input);
    if (line !== "") parts.push(line);
  }
  return `${parts.join(" ")}\n`;
}

/**
 * The line stored for one thinking block: `[thinking] 0.9s ~265 tokens`, with what is known of the
 * duration (seconds, one decimal) and the estimated tokens.
 */
export function thinkingLine(ms?: number, tokens?: number): string {
  const parts = ["[thinking]"];
  if (ms !== undefined) parts.push(`${(ms / 1000).toFixed(1)}s`);
  if (tokens !== undefined) parts.push(`~${tokens} tokens`);
  return `${parts.join(" ")}\n`;
}

/** Stored text for one worker event, or "" when the event adds no output. */
export function outputText(
  event: WorkerEvent,
  privacy: OutputPrivacy = DEFAULT_OUTPUT_PRIVACY,
): string {
  if (event.t === "output") {
    return event.text.endsWith("\n") || event.text === "" ? event.text : `${event.text}\n`;
  }
  if (event.t !== "activity" || event.kind === "text") return "";
  // Only the main agent's own calls and thinking: a subagent's work shows as the one call that
  // started it.
  if (event.kind !== "subagent" && event.agentId !== undefined) return "";
  if (event.kind === "thinking") return thinkingLine(event.ms, event.tokens);
  if (event.kind !== "tool") return toolLine(event.tool ?? event.kind);
  // The input only with the opt-in; without it the line is exactly what it always was.
  const input = privacy.storeCommandBodies ? event.input : undefined;
  return toolLine(event.tool ?? event.kind, event.path, input);
}

const encoder = new TextEncoder();

/** UTF-8 length; stored output offsets count bytes. */
export function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}
