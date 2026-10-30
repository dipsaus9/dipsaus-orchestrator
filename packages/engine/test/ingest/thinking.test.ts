// Worker thinking as counts (DIPO-96): the Claude adapter maps `thinking_duration_ms` and
// `system/thinking_tokens` to a neutral `thinking` activity, and ingestion stores one line per
// thinking block, `[thinking] 0.9s ~265 tokens`. No thinking text or signature is ever stored or
// sent. Live recordings run through the real parser and the ingestor; hand-made lines cover what
// the recordings cannot show (thinking text, a subagent, a malformed duration).

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { scrubLine } from "../../src/host/scrub";
import { type IngestAdapter, Ingestor } from "../../src/ingest/ingestor";
import { outputText, thinkingLine } from "../../src/ingest/output";
import { CLAUDE_LINE_SCRUB } from "../../src/workers/claude-cli/adapter";
import {
  type ClaudeParseState,
  initialState,
  interpret,
} from "../../src/workers/claude-cli/interpret";
import { ClaudeWorkerEventSchema } from "../../src/workers/claude-cli/schema";
import type { HostLine, ParseState, WorkerEvent } from "../../src/workers/types";
import { loadRecording, plannedModel, recordingNames } from "../workers/replay";
import {
  appendLines,
  eventFileText,
  hostLines,
  type IngestFixture,
  ingestFixture,
  loggedEvents,
  storedOutput,
  target,
} from "./helpers";

const MODEL = "claude-haiku-5-5";
/** Stand-ins for what a thinking block could hold; neither may leave the parser. */
const THOUGHT = "PRIVATE-THOUGHT the maintainer must never see this";
const SIGNATURE = "SIGNATURE-EqQBCkYIBxgCKkDopaqueBlob0123456789";

const claude: IngestAdapter = {
  interpret: (line, state) =>
    interpret(line, state as unknown as ClaudeParseState) as unknown as {
      events: [];
      state: ParseState;
    },
};

type Thinking = Extract<WorkerEvent, { t: "activity" }>;

function thinkingOf(events: readonly WorkerEvent[]): Thinking[] {
  return events.filter(
    (event): event is Thinking => event.t === "activity" && event.kind === "thinking",
  );
}

function replay(lines: readonly HostLine[], state = initialState()): WorkerEvent[] {
  const events: WorkerEvent[] = [];
  let current = state;
  for (const line of lines) {
    const step = interpret(line, current);
    events.push(...step.events);
    current = step.state;
  }
  return events;
}

function replayRecording(name: string): WorkerEvent[] {
  const recording = loadRecording(name);
  return replay(hostLines(recording), initialState({ plannedModel: plannedModel(recording) }));
}

function stdout(t: number, data: unknown): HostLine {
  return { t, ch: "stdout", data: JSON.stringify(data) };
}

function thinkingTokens(t: number, fields: Record<string, number>): HostLine {
  return stdout(t, { type: "system", subtype: "thinking_tokens", ...fields, session_id: "s-1" });
}

function assistant(
  t: number,
  id: string,
  content: unknown[],
  extra: Record<string, unknown> = {},
  parent: string | null = null,
): HostLine {
  return stdout(t, {
    type: "assistant",
    message: {
      model: MODEL,
      id,
      type: "message",
      role: "assistant",
      content,
      usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    parent_tool_use_id: parent,
    session_id: "s-1",
    thinking_display: "updates",
    ...extra,
  });
}

/** `line` as the host appends it: a stdout line through the Claude scrub (DIPO-105). */
function scrubbed(line: HostLine): HostLine {
  return line.ch === "stdout" ? { ...line, data: scrubLine(line.data, CLAUDE_LINE_SCRUB) } : line;
}

const THINKING_BLOCK = { type: "thinking", thinking: THOUGHT, signature: SIGNATURE };
const EXIT: HostLine = { t: 99, ch: "exit", data: JSON.stringify({ code: 0, signal: null }) };

/** One thinking block with text and a signature, then the tool call it led to. */
const HAND_LINES: HostLine[] = [
  thinkingTokens(1, { estimated_tokens: 50, estimated_tokens_delta: 50 }),
  thinkingTokens(2, { estimated_tokens: 120, estimated_tokens_delta: 70 }),
  assistant(3, "msg-1", [THINKING_BLOCK], { thinking_duration_ms: 1520 }),
  assistant(4, "msg-1", [
    { type: "tool_use", id: "toolu-1", name: "Read", input: { file_path: "src/a.ts" } },
  ]),
  EXIT,
];

/** Every byte of the state database files, WAL included. */
function databaseBytes(dir: string): string {
  const stateDir = join(dir, "state");
  return readdirSync(stateDir)
    .filter((name) => name.startsWith("dipo.db"))
    .map((name) => readFileSync(join(stateDir, name)).toString("latin1"))
    .join("");
}

function workOutputText(f: IngestFixture): string {
  return loggedEvents(f.office)
    .filter((event) => event.type === "work.output")
    .map((event) => (event.data as { text: string }).text)
    .join("");
}

function ingestor(f: IngestFixture): Ingestor {
  return new Ingestor({ office: f.office, clock: f.t.clock });
}

function stateFor(name: string): ParseState {
  return initialState({ plannedModel: plannedModel(loadRecording(name)) }) as unknown as ParseState;
}

describe("thinking as counts in the Claude adapter (DIPO-96)", () => {
  it("maps each thinking block of a live recording to one thinking activity with ms and tokens", () => {
    expect(thinkingOf(replayRecording("safety-bash-prompts-none"))).toEqual([
      { t: "activity", kind: "thinking", ms: 864, tokens: 265 },
      { t: "activity", kind: "thinking", ms: 782, tokens: 267 },
      { t: "activity", kind: "thinking", ms: 497, tokens: 207 },
    ]);
    // Over a pause and two more processes: each block keeps its own estimate.
    expect(thinkingOf(replayRecording("pause-now"))).toEqual([
      { t: "activity", kind: "thinking", ms: 1748, tokens: 390 },
      { t: "activity", kind: "thinking", ms: 2358, tokens: 467 },
      { t: "activity", kind: "thinking", ms: 2116, tokens: 510 },
      { t: "activity", kind: "thinking", ms: 611, tokens: 241 },
    ]);
  });

  it("reports the duration alone when the recording kept no token estimate", () => {
    // success-tools-subagent was captured before the allowlist kept the estimate fields.
    expect(thinkingOf(replayRecording("success-tools-subagent"))).toEqual([
      { t: "activity", kind: "thinking", ms: 2161 },
      { t: "activity", kind: "thinking", ms: 694 },
    ]);
  });

  it("emits only events the adapter's event schema allows, and comes before the block's words", () => {
    const events = replay(HAND_LINES);
    for (const event of thinkingOf(events)) {
      expect(ClaudeWorkerEventSchema.safeParse(event).success).toBe(true);
    }
    expect(events.filter((event) => event.t === "activity").map((event) => event.kind)).toEqual([
      "thinking",
      "tool",
    ]);
  });

  it("never passes on thinking text or the signature", () => {
    const events = replay(HAND_LINES);
    expect(thinkingOf(events)).toEqual([
      { t: "activity", kind: "thinking", ms: 1520, tokens: 120 },
    ]);
    const sent = JSON.stringify(events);
    expect(sent).not.toContain("PRIVATE-THOUGHT");
    expect(sent).not.toContain("SIGNATURE-");
    expect(sent).not.toContain("updates");
    // Nor does the parse state the engine stores between passes.
    let state = initialState();
    for (const line of HAND_LINES.slice(0, 3)) state = interpret(line, state).state;
    expect(JSON.stringify(state)).not.toContain("PRIVATE-THOUGHT");
    expect(JSON.stringify(state)).not.toContain("SIGNATURE-");
  });

  it("adds up estimate deltas when a line carries no running total", () => {
    const events = replay([
      thinkingTokens(1, { estimated_tokens_delta: 40 }),
      thinkingTokens(2, { estimated_tokens_delta: 60 }),
      assistant(3, "msg-1", [THINKING_BLOCK], { thinking_duration_ms: 300 }),
    ]);
    expect(thinkingOf(events)).toEqual([{ t: "activity", kind: "thinking", ms: 300, tokens: 100 }]);
  });

  it("starts each block from a fresh estimate, and drops an unfinished one at the exit", () => {
    const events = replay([
      thinkingTokens(1, { estimated_tokens_delta: 500 }),
      EXIT,
      thinkingTokens(2, { estimated_tokens_delta: 30 }),
      assistant(3, "msg-1", [THINKING_BLOCK], { thinking_duration_ms: 100 }),
      assistant(4, "msg-2", [THINKING_BLOCK], { thinking_duration_ms: 200 }),
    ]);
    expect(thinkingOf(events)).toEqual([
      { t: "activity", kind: "thinking", ms: 100, tokens: 30 },
      { t: "activity", kind: "thinking", ms: 200 },
    ]);
  });

  it("keeps the message's usage when the duration has the wrong shape", () => {
    const events = replay([
      assistant(1, "msg-1", [THINKING_BLOCK], { thinking_duration_ms: "slow" }),
    ]);
    expect(thinkingOf(events)).toEqual([{ t: "activity", kind: "thinking" }]);
    expect(events.some((event) => event.t === "usage")).toBe(true);
  });

  it("scopes a subagent's thinking to its agent, and stores no line for it", () => {
    const events = replay([
      assistant(1, "msg-9", [THINKING_BLOCK], { thinking_duration_ms: 400 }, "toolu-agent"),
    ]);
    const [thinking] = thinkingOf(events);
    expect(thinking).toEqual({ t: "activity", kind: "thinking", ms: 400, agentId: "toolu-agent" });
    expect(thinking === undefined ? "missing" : outputText(thinking)).toBe("");
  });
});

describe("the stored [thinking] line (DIPO-96)", () => {
  it("formats seconds with one decimal and the estimate with a tilde", () => {
    expect(thinkingLine(400, 292)).toBe("[thinking] 0.4s ~292 tokens\n");
    expect(thinkingLine(12_345, 3000)).toBe("[thinking] 12.3s ~3000 tokens\n");
    expect(thinkingLine(694)).toBe("[thinking] 0.7s\n");
    expect(thinkingLine(undefined, 50)).toBe("[thinking] ~50 tokens\n");
    expect(thinkingLine()).toBe("[thinking]\n");
  });

  it("replaying a live recording stores one line per block, in order, and sends it as work.output", () =>
    withTempDir(async (dir) => {
      const name = "safety-bash-prompts-none";
      const f = await ingestFixture(dir);
      writeFileSync(f.eventFile, eventFileText(loadRecording(name)));
      ingestor(f).track(target(f, claude, stateFor(name)));

      const stored = storedOutput(f.office, f.run);
      const thinking = stored.split("\n").filter((line) => line.startsWith("[thinking]"));
      expect(thinking).toEqual([
        "[thinking] 0.9s ~265 tokens",
        "[thinking] 0.8s ~267 tokens",
        "[thinking] 0.5s ~207 tokens",
      ]);
      // The first block comes before the first tool call it led to.
      expect(stored.indexOf("[thinking] 0.9s")).toBeLessThan(stored.indexOf("[tool] Bash"));
      expect(workOutputText(f)).toContain("[thinking] 0.9s ~265 tokens\n");

      // No part of a thinking block reaches the database: the recording's (redacted) signatures
      // and display mode stand for what the live stream carries.
      const recording = loadRecording(name);
      const signatures = new Set<string>();
      for (const line of recording.lines) {
        if (line.ch !== "stdout" || typeof line.data !== "object" || line.data === null) continue;
        const message = (line.data as { message?: { content?: unknown[] } }).message;
        for (const block of message?.content ?? []) {
          const { type, signature } = block as { type?: string; signature?: string };
          if (type === "thinking" && typeof signature === "string") signatures.add(signature);
        }
      }
      expect(signatures.size).toBe(3);
      f.t.state.close();
      const bytes = databaseBytes(dir);
      for (const signature of signatures) expect(bytes).not.toContain(signature);
    }));

  it("an estimate read in one pass reaches the block's line in the next", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      const ingest = ingestor(f);
      appendLines(f.eventFile, HAND_LINES.slice(0, 2));
      ingest.track(target(f, claude, initialState() as unknown as ParseState));
      expect(storedOutput(f.office, f.run)).toBe("");
      appendLines(f.eventFile, HAND_LINES.slice(2));
      ingest.pass(f.run, f.agent);
      expect(storedOutput(f.office, f.run)).toBe(
        "[thinking] 1.5s ~120 tokens\n[tool] Read src/a.ts\n",
      );
    }));

  it("stores no thinking text or signature anywhere in the database", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      appendLines(f.eventFile, HAND_LINES);
      ingestor(f).track(target(f, claude, initialState() as unknown as ParseState));
      expect(storedOutput(f.office, f.run)).toBe(
        "[thinking] 1.5s ~120 tokens\n[tool] Read src/a.ts\n",
      );
      expect(workOutputText(f)).not.toContain("PRIVATE-THOUGHT");
      f.t.state.close();
      const bytes = databaseBytes(dir);
      expect(bytes).not.toContain("PRIVATE-THOUGHT");
      expect(bytes).not.toContain("SIGNATURE-");
      // The scan does see what is stored.
      expect(bytes).toContain("[thinking] 1.5s ~120 tokens");
    }));

  it("derives the thinking activity from a line the host has scrubbed (DIPO-105)", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      // The host scrubs stdout lines before it appends them; the exit line is not stdout.
      appendLines(f.eventFile, HAND_LINES.map(scrubbed));
      ingestor(f).track(target(f, claude, initialState() as unknown as ParseState));
      expect(storedOutput(f.office, f.run)).toBe(
        "[thinking] 1.5s ~120 tokens\n[tool] Read src/a.ts\n",
      );
      expect(readFileSync(f.eventFile, "utf8")).not.toContain("PRIVATE-THOUGHT");
      expect(readFileSync(f.eventFile, "utf8")).not.toContain("SIGNATURE-");
    }));

  it("the scrub changes no worker event of any live recording (DIPO-105)", () => {
    let thoughts = 0;
    for (const name of recordingNames()) {
      const recording = loadRecording(name);
      const lines = hostLines(recording);
      const state = initialState({ plannedModel: plannedModel(recording) });
      const raw = replay(lines, state);
      expect(replay(lines.map(scrubbed), state)).toEqual(raw);
      thoughts += thinkingOf(raw).length;
    }
    // The recordings do hold thinking, so the comparison covers it.
    expect(thoughts).toBeGreaterThan(0);
  });
});
