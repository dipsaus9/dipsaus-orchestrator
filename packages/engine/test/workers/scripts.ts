// Worker event scripts for engine tests that need no Claude detail (0017 section 2). Every script
// an engine test plays through `ScriptedWorker` belongs here, so the contract test in
// scripted.test.ts checks it against what the Claude CLI adapter can produce.

import { ClaudeWorkerEventSchema } from "../../src/workers/claude-cli/schema";
import { ScriptedWorker, type ScriptedWorkerOptions } from "../../src/workers/scripted";
import type { WorkerEvent, WorkerReport } from "../../src/workers/types";

const MODEL = "claude-haiku-5-5";

const started: WorkerEvent = {
  t: "started",
  sessionId: "session-1",
  model: MODEL,
  version: "2.1.296",
  permissionMode: "default",
  tools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash", "StructuredOutput"],
};

const done: WorkerReport = {
  status: "done",
  criteria: [{ n: 1, met: true, evidence: "bun test passes" }],
  summary: "The CLI prints hello.",
  commitSubject: "print a greeting",
};

const totals = { [MODEL]: { input: 4, output: 155, cacheCreate: 1662, cacheRead: 3682 } };

export const SCRIPTS: Readonly<Record<string, readonly WorkerEvent[]>> = {
  done: [
    started,
    { t: "activity", kind: "tool", tool: "Read", path: "src/greet.ts" },
    {
      t: "usage",
      messageId: "msg-1",
      model: MODEL,
      input: 2,
      output: 155,
      cacheCreate: 1662,
      cacheCreate5m: 0,
      cacheCreate1h: 1662,
      cacheRead: 3682,
    },
    { t: "activity", kind: "text" },
    { t: "output", text: "Done." },
    { t: "turn", report: done, totals, numTurns: 2, terminal: "completed" },
  ],
  "blocked-question": [
    started,
    {
      t: "turn",
      report: { ...done, status: "blocked", question: "Which greeting should the CLI print?" },
      totals,
      numTurns: 3,
      terminal: "completed",
    },
    { t: "waiting", on: "question", detail: "Which greeting should the CLI print?" },
  ],
  // A call `--permission-prompts none` denied; the worker cannot finish without it (DIPO-50).
  "blocked-permission": [
    started,
    { t: "denied", tool: "Bash", reason: "permission prompts are off" },
    {
      t: "turn",
      report: {
        ...done,
        status: "blocked",
        needsPermission: { tool: "Bash", action: "bun add left-pad" },
      },
      totals,
      numTurns: 2,
      terminal: "completed",
    },
  ],
  "plan-limit": [
    started,
    {
      t: "limit",
      status: "rejected",
      utilization: 1,
      resetsAt: "2026-10-12T17:50:00.000Z",
    },
    {
      t: "waiting",
      on: "plan-limit",
      detail: "rate limit five_hour rejected",
      until: "2026-10-12T17:50:00.000Z",
    },
  ],
  "denied-then-subagent": [
    started,
    { t: "denied", tool: "Write", reason: "asyncAgent" },
    { t: "activity", kind: "subagent", tool: "Agent", agentId: "toolu-2" },
    {
      t: "usage",
      messageId: "msg-2",
      model: MODEL,
      agentId: "toolu-2",
      input: 2,
      output: 9,
      cacheCreate: 10,
      cacheCreate5m: 10,
      cacheCreate1h: 0,
      cacheRead: 5,
    },
    { t: "compacted", preTokens: 150000 },
  ],
  // Ingestion debounce (DIPO-45): small output, usage twice, then more than 16 KiB of text.
  "output-and-usage": [
    started,
    { t: "activity", kind: "text" },
    { t: "output", text: "Reading the greeter." },
    {
      t: "usage",
      messageId: "msg-1",
      model: MODEL,
      input: 2,
      output: 7,
      cacheCreate: 100,
      cacheCreate5m: 100,
      cacheCreate1h: 0,
      cacheRead: 50,
    },
    {
      t: "usage",
      messageId: "msg-2",
      model: MODEL,
      input: 3,
      output: 8,
      cacheCreate: 10,
      cacheCreate5m: 4,
      cacheCreate1h: 6,
      cacheRead: 60,
    },
    { t: "activity", kind: "text" },
    { t: "output", text: "x".repeat(17 * 1024) },
    { t: "turn", report: done, totals, numTurns: 2, terminal: "completed" },
  ],
};

/** A `ScriptedWorker` checked against the Claude CLI adapter's event schema, the M0 default. */
export function scriptedWorker(options: Omit<ScriptedWorkerOptions, "schema">): ScriptedWorker {
  return new ScriptedWorker({ ...options, schema: ClaudeWorkerEventSchema });
}
