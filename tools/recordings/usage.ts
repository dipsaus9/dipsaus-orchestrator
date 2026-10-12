// Usage checksum (0017 section 2, "Usage for 0014's measurement"). The capture takes it from the
// raw stream before scrubbing and stores it in `meta.json`; a unit test recomputes it from the
// committed stream, so a scrubber change that touches a usage number fails the build.

import { createHash } from "node:crypto";

import { isRecord } from "./format";
import type { Envelope } from "./format";

type Entry = readonly [line: number, path: string, value: number | string];

function collect(value: unknown, path: string, line: number, out: Entry[]): void {
  if (typeof value === "number" || typeof value === "string") {
    out.push([line, path, value]);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => collect(item, `${path}.${index}`, line, out));
  } else if (isRecord(value)) {
    for (const key of Object.keys(value).toSorted()) {
      collect(value[key], `${path}.${key}`, line, out);
    }
  }
}

const RESULT_NUMBERS = ["total_cost_usd", "num_turns", "duration_ms", "duration_api_ms"] as const;

/** The usage fields of one stream-json object, as `[line, path, value]` entries. */
export function usageEntries(message: unknown, line: number): Entry[] {
  if (!isRecord(message)) return [];
  const out: Entry[] = [];
  const inner = isRecord(message.message) ? message.message : undefined;
  const event = isRecord(message.event) ? message.event : undefined;
  switch (message.type) {
    case "assistant":
      collect(inner?.usage, "message.usage", line, out);
      break;
    case "stream_event":
      collect(
        isRecord(event?.message) ? event.message.usage : undefined,
        "event.message.usage",
        line,
        out,
      );
      collect(event?.usage, "event.usage", line, out);
      break;
    case "result":
      collect(message.usage, "usage", line, out);
      collect(message.modelUsage, "modelUsage", line, out);
      for (const key of RESULT_NUMBERS) collect(message[key], key, line, out);
      break;
    default:
      break;
  }
  return out;
}

/** sha256 over every usage entry of the stdout lines, in order. */
export function usageChecksum(stdout: readonly unknown[]): string {
  const entries = stdout.flatMap((message, index) => usageEntries(message, index));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

/** The stdout payloads of a recording, in order. */
export function stdoutOf(lines: readonly Envelope[]): unknown[] {
  return lines.filter((line) => line.ch === "stdout").map((line) => line.data);
}

/** Budget tokens (0008 section 4) from the last result's `modelUsage`, summed over models. */
export function budgetTokens(lines: readonly Envelope[]): number {
  let total = 0;
  for (const message of stdoutOf(lines)) {
    if (!isRecord(message) || message.type !== "result" || !isRecord(message.modelUsage)) continue;
    total = 0;
    for (const usage of Object.values(message.modelUsage)) {
      if (!isRecord(usage)) continue;
      for (const key of ["inputTokens", "outputTokens", "cacheCreationInputTokens"]) {
        const value = usage[key];
        if (typeof value === "number") total += value;
      }
    }
  }
  return total;
}
