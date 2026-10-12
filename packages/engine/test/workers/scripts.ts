// Worker event scripts for engine tests that need no Claude detail (0017 section 2). Every script
// an engine test plays through `ScriptedWorker` belongs here, so the contract test in
// scripted.test.ts checks it against what the Claude CLI adapter can produce.

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
    { t: "usage", messageId: "msg-1", model: MODEL, input: 2, cacheCreate: 1662, cacheRead: 3682 },
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
      cacheCreate: 10,
      cacheRead: 5,
    },
    { t: "compacted", preTokens: 150000 },
  ],
};
