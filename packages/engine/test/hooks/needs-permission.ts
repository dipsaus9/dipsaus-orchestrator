// The `needs-permission` recording (0017 scenario, DIPO-75 AC #6) for the replay tests.
//
// STAND-IN: until the maintainer captures the live recording (`bun run recordings:capture
// needs-permission`, which needs approval for a live Claude session), the tests replay a stand-in
// built here from the committed live `permission-wait` recording: the same session with its
// `PermissionRequest` hook line, whose final report is rewritten from a question to
// `needsPermission {"tool": "Bash", "action": "docker ps"}`, as the scenario asks the worker to
// report. Once `packages/engine/test/recordings/claude-cli/needs-permission/` is committed, the
// live recording is used instead and `STAND_IN` is false; the tests read the tool and action from
// the recording either way.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { readRecording, type Recording } from "@dipsaus-orchestrator/testkit";

import { RECORDINGS_DIR } from "../workers/replay";

export const NEEDS_PERMISSION = "needs-permission";

/** True while no live `needs-permission` recording is committed. */
export const STAND_IN = !existsSync(join(RECORDINGS_DIR, NEEDS_PERMISSION, "meta.json"));

/** The action the scenario asks the worker to report. */
const SCENARIO_PERMISSION = { tool: "Bash", action: "docker ps" } as const;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The live recording, or the stand-in (see the file comment). */
export function needsPermissionRecording(): Recording {
  if (!STAND_IN) return readRecording(join(RECORDINGS_DIR, NEEDS_PERMISSION));
  const source = readRecording(join(RECORDINGS_DIR, "permission-wait"));
  const lines = source.lines.map((line) => {
    if (line.ch !== "stdout" || !isRecord(line.data) || line.data["type"] !== "result") return line;
    const report = line.data["structured_output"];
    if (!isRecord(report)) return line;
    const { question: _question, ...rest } = report;
    return {
      ...line,
      data: {
        ...line.data,
        structured_output: { ...rest, needsPermission: { ...SCENARIO_PERMISSION } },
      },
    };
  });
  return {
    name: NEEDS_PERMISSION,
    meta: {
      ...source.meta,
      scenario: NEEDS_PERMISSION,
      source: "synthetic",
      derivedFrom: "permission-wait",
    } as Recording["meta"],
    lines,
  };
}

/** The tool and action the recording's blocked report carries. */
export function reportedPermission(recording: Recording): { tool: string; action: string } {
  for (const line of recording.lines) {
    if (line.ch !== "stdout" || !isRecord(line.data) || line.data["type"] !== "result") continue;
    const report = line.data["structured_output"];
    if (!isRecord(report) || !isRecord(report["needsPermission"])) continue;
    const { tool, action } = report["needsPermission"];
    if (typeof tool === "string" && typeof action === "string") return { tool, action };
  }
  throw new Error(`${recording.name}: no blocked report with needsPermission`);
}
