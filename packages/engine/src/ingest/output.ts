// What worker output is stored (0007 section 8): the main agent's text, plus one line per tool
// call with the tool name and its target path. Shell command text, tool inputs and tool results
// never reach `output_chunks`; the neutral worker events carry none of them except the path.

import type { WorkerEvent } from "../workers/types";

/** The line stored for one tool call: `[tool] Read src/greet.ts`, or `[tool] Bash`. */
export function toolLine(tool: string, path?: string): string {
  return path === undefined ? `[tool] ${tool}\n` : `[tool] ${tool} ${path}\n`;
}

/** Stored text for one worker event, or "" when the event adds no output. */
export function outputText(event: WorkerEvent): string {
  if (event.t === "output") {
    return event.text.endsWith("\n") || event.text === "" ? event.text : `${event.text}\n`;
  }
  if (event.t !== "activity" || event.kind === "text") return "";
  // Only the main agent's own calls: a subagent's work shows as the one call that started it.
  if (event.kind === "tool" && event.agentId !== undefined) return "";
  return toolLine(event.tool ?? event.kind, event.kind === "tool" ? event.path : undefined);
}

const encoder = new TextEncoder();

/** UTF-8 length; stored output offsets count bytes. */
export function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}
