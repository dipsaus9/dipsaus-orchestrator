// The live `needs-permission` recording (0017 scenario, DIPO-75 AC #6), captured by the maintainer
// with `bun run recordings:capture needs-permission`, for the replay tests.
//
// The tool and action come from the `result` line's `structured_output.needsPermission`, the
// decision field the engine parks on, which the scrubber keeps (`tools/recordings/scrub.ts`). The
// same report also appears as the input of the worker's StructuredOutput tool call, where the
// scrubber redacts it like any tool input; nothing reads that copy.

import { join } from "node:path";

import { readRecording, type Recording } from "@dipsaus-orchestrator/testkit";

import { RECORDINGS_DIR } from "../workers/replay";

export const NEEDS_PERMISSION = "needs-permission";

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The committed live recording. */
export function needsPermissionRecording(): Recording {
  return readRecording(join(RECORDINGS_DIR, NEEDS_PERMISSION));
}

/** The tool and action the recording's blocked report carries, from its `result` line. */
export function reportedPermission(recording: Recording): { tool: string; action: string } {
  for (const line of recording.lines) {
    if (line.ch !== "stdout" || !isRecord(line.data) || line.data["type"] !== "result") continue;
    const report = line.data["structured_output"];
    if (!isRecord(report) || !isRecord(report["needsPermission"])) continue;
    const { tool, action } = report["needsPermission"];
    if (typeof tool !== "string" || typeof action !== "string") continue;
    if (tool.startsWith("[redacted") || action.startsWith("[redacted")) {
      throw new Error(`${recording.name}: the result's needsPermission was redacted`);
    }
    return { tool, action };
  }
  throw new Error(`${recording.name}: no blocked result with needsPermission`);
}
