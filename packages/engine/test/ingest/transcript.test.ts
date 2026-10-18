// Worker usage from the transcript when a host died (DIPO-134; 0008 section 4). A scrubbed
// transcript under test/recordings/transcripts/host-died is replayed over a session whose host
// stopped mid-turn: the usage the stream lacked is stored once per message id, a second pass adds
// nothing, an unsupported Claude Code version is refused, and subagent transcripts give the
// per-subagent detail. A resumed session's transcript (test/recordings/transcripts/resumed) holds
// the earlier session's messages too; they are counted once across the run's agents.

import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withTempDir, type Recording } from "@dipsaus-orchestrator/testkit";

import { Ingestor, type IngestAdapter } from "../../src/ingest/ingestor";
import {
  readSubagentUsage,
  recordTranscriptPath,
  recoverTranscriptUsage,
  TRANSCRIPT_SOURCE,
} from "../../src/ingest/transcript";
import type { UsageScope } from "../../src/ingest/usage";
import { initialState, interpret } from "../../src/workers/claude-cli/interpret";
import { readTranscript } from "../../src/workers/claude-cli/transcript";
import type { HostLine, ParseState } from "../../src/workers/types";
import { loadRecording, plannedModel } from "../workers/replay";
import { appendLines, hostLines, ingestFixture, target, type IngestFixture } from "./helpers";

const RECORDING = "success-tools-subagent";
const FIXTURES = join(import.meta.dir, "..", "recordings", "transcripts", "host-died");
const SESSION_FILE = join(FIXTURES, "transcript.jsonl");
const SUBAGENT_FILE = join(FIXTURES, "agent-a1.jsonl");

const claude: IngestAdapter = {
  interpret: (line, state) =>
    interpret(line, state as unknown as ReturnType<typeof initialState>) as unknown as {
      events: [];
      state: ParseState;
    },
  readTranscript,
};

/** The recording up to its first assistant message: the worker host then stopped mid-turn. */
function untilFirstAssistant(recording: Recording): HostLine[] {
  const lines = hostLines(recording);
  const index = lines.findIndex(
    (line) => line.ch === "stdout" && line.data.includes('"type":"assistant"'),
  );
  if (index < 0) throw new Error(`${recording.name} has no assistant line`);
  return lines.slice(0, index + 1);
}

function hook(t: number, payload: Record<string, unknown>): HostLine {
  return { t, ch: "hook", data: JSON.stringify({ session_id: "session-1", ...payload }) };
}

function scopeOf(f: IngestFixture): UsageScope {
  return { run: f.run, agent: f.agent, role: "developer", tier: "M", budgetLimit: 400_000 };
}

/** A session whose host died after one assistant message, with the hooks that name its files. */
function dyingSession(f: IngestFixture, hooks: boolean = true): Ingestor {
  const recording = loadRecording(RECORDING);
  const lines = untilFirstAssistant(recording);
  const last = lines[lines.length - 1]?.t ?? 0;
  const named = hooks
    ? [
        hook(last + 1, {
          hook_event_name: "SessionStart",
          source: "startup",
          transcript_path: SESSION_FILE,
        }),
        hook(last + 2, {
          hook_event_name: "SubagentStop",
          agent_id: "a1",
          agent_transcript_path: SUBAGENT_FILE,
        }),
      ]
    : [];
  appendLines(f.eventFile, [...lines, ...named]);
  const ingestor = new Ingestor({ office: f.office, clock: f.t.clock, pricing: f.t.state.pricing });
  const state = initialState({ plannedModel: plannedModel(recording) }) as unknown as ParseState;
  expect(ingestor.track(target(f, claude, state)).status).toBe("ingested");
  return ingestor;
}

interface Totals {
  input: number;
  output: number;
  cache_create: number;
  cache_read: number;
  budget_used: number;
}

function totalsOf(f: IngestFixture): Totals {
  const row = f.office.get<Totals>(
    `select sum(input) as input, sum(output) as output, sum(cache_create) as cache_create,
       sum(cache_read) as cache_read, sum(budget_used) as budget_used
     from usage_totals where office_id = $office_id and run_id = $run`,
    { run: f.run },
  );
  if (row === null) throw new Error("no totals");
  return row;
}

function messageIds(f: IngestFixture): string[] {
  return f.office
    .all<{ message_id: string }>(
      "select message_id from usage_messages where office_id = $office_id order by message_id",
    )
    .map((row) => row.message_id);
}

function recover(f: IngestFixture, mode: "lost" | "detail") {
  return recoverTranscriptUsage({
    office: f.office,
    scope: scopeOf(f),
    read: readTranscript,
    pricing: f.t.state.pricing,
    mode,
    at: f.t.clock.now(),
  });
}

function withIngest(fn: (f: IngestFixture, dir: string) => void | Promise<void>) {
  return () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      try {
        await fn(f, dir);
      } finally {
        f.t.state.close();
      }
    });
}

describe("the hook relay records the transcript paths (DIPO-134)", () => {
  it(
    "keeps the session's and the subagent's transcript from their hooks",
    withIngest((f) => {
      dyingSession(f);
      const row = f.office.get<{ path: string; read_offset: number; parse_state: string }>(
        `select path, read_offset, parse_state from ingest_cursors
         where office_id = $office_id and run_id = $run and source_kind = $kind`,
        { run: f.run, kind: TRANSCRIPT_SOURCE },
      );
      expect(row?.path).toBe(SESSION_FILE);
      expect(row?.read_offset).toBe(0);
      expect(JSON.parse(row?.parse_state ?? "{}")).toMatchObject({
        subagents: { a1: { path: SUBAGENT_FILE, offset: 0 } },
      });
    }),
  );
});

describe("a worker host that died mid-turn (DIPO-134)", () => {
  it(
    "stores the usage the stream lacked once per message id, and a second pass adds nothing",
    withIngest((f) => {
      dyingSession(f);
      // The stream carried msg-1 only; its output is not in the totals before a turn end.
      expect(messageIds(f)).toEqual(["msg-1"]);
      expect(totalsOf(f)).toMatchObject({ input: 2, output: 0, cache_create: 7839 });

      const first = recover(f, "lost");
      expect(first).toEqual({ counted: 5, detailed: 2, refused: null });
      expect(messageIds(f)).toEqual(["msg-1", "msg-2", "msg-3", "msg-s1", "msg-s2"]);
      // msg-1, msg-2, msg-3 and the two subagent messages; the unknown line, the non-JSON line,
      // the synthetic message and the partial last line add nothing.
      expect(totalsOf(f)).toEqual({
        input: 2 + 2 + 3 + 2 + 2,
        output: 16 + 7 + 40 + 16 + 1,
        cache_create: 7839 + 660 + 100 + 4578 + 776,
        cache_read: 7839 + 4578,
        budget_used: 11 + 80 + 13953,
      });

      const before = totalsOf(f);
      const stored = f.office.get<{ read_offset: number }>(
        "select read_offset from ingest_cursors where office_id = $office_id and source_kind = $kind",
        { kind: TRANSCRIPT_SOURCE },
      );
      expect(stored?.read_offset).toBeGreaterThan(0);

      expect(recover(f, "lost")).toEqual({ counted: 0, detailed: 0, refused: null });
      expect(totalsOf(f)).toEqual(before);
      expect(messageIds(f)).toHaveLength(5);
    }),
  );

  it(
    "counts nothing twice when the transcript is read again from its start",
    withIngest((f) => {
      dyingSession(f);
      recover(f, "lost");
      const before = totalsOf(f);
      const row = f.office.get<{ parse_state: string }>(
        "select parse_state from ingest_cursors where office_id = $office_id and source_kind = $kind",
        { kind: TRANSCRIPT_SOURCE },
      );
      const state = JSON.parse(row?.parse_state ?? "{}") as {
        subagents: Record<string, { offset: number }>;
      };
      for (const sub of Object.values(state.subagents)) sub.offset = 0;
      f.office.run(
        `update ingest_cursors set read_offset = 0, parse_state = $state
         where office_id = $office_id and source_kind = $kind`,
        { state: JSON.stringify(state), kind: TRANSCRIPT_SOURCE },
      );
      expect(recover(f, "lost").counted).toBe(0);
      expect(totalsOf(f)).toEqual(before);
    }),
  );

  it(
    "picks up the lines written after the first read, and leaves a partial last line",
    withIngest((f, dir) => {
      const growing = join(dir, "growing.jsonl");
      writeFileSync(
        growing,
        `${assistantLine("msg-a", 5, 3)}\n${assistantLine("msg-b", 1, 1).slice(0, 30)}`,
      );
      dyingSessionAt(f, growing);
      expect(recover(f, "lost").counted).toBe(1);
      expect(messageIds(f)).toContain("msg-a");
      expect(messageIds(f)).not.toContain("msg-b");

      writeFileSync(growing, `${assistantLine("msg-a", 5, 3)}\n${assistantLine("msg-b", 1, 1)}\n`);
      expect(recover(f, "lost").counted).toBe(1);
      expect(messageIds(f)).toContain("msg-b");
    }),
  );

  it(
    "refuses a transcript of an unsupported Claude Code version and stores nothing",
    withIngest((f) => {
      dyingSession(f);
      f.office.run(
        "update agents set adapter_version = '3.0.0' where office_id = $office_id and agent_id = $agent",
        { agent: f.agent },
      );
      const before = totalsOf(f);
      const pass = recover(f, "lost");
      expect(pass.counted).toBe(0);
      expect(pass.refused).toContain("3.0.0");
      expect(totalsOf(f)).toEqual(before);
      expect(messageIds(f)).toEqual(["msg-1"]);

      // The offset did not move, so the same transcript counts once the version is covered.
      f.office.run(
        "update agents set adapter_version = '2.1.301' where office_id = $office_id and agent_id = $agent",
        { agent: f.agent },
      );
      expect(recover(f, "lost").counted).toBe(5);
    }),
  );

  it(
    "does nothing for a session whose hooks named no transcript",
    withIngest((f) => {
      dyingSession(f, false);
      expect(recover(f, "lost")).toEqual({ counted: 0, detailed: 0, refused: null });
      expect(messageIds(f)).toEqual(["msg-1"]);
    }),
  );
});

describe("a resumed session (DIPO-134)", () => {
  const RESUMED_FILE = join(FIXTURES, "..", "resumed", "transcript.jsonl");

  it(
    "counts the earlier session's messages in the shared transcript no second time",
    withIngest((f, dir) => {
      // The earlier session's host died with the first 4 lines written (msg-1, msg-2).
      const lines = readFileSync(RESUMED_FILE, "utf8").split("\n");
      const file = join(dir, "resumed.jsonl");
      writeFileSync(file, `${lines.slice(0, 4).join("\n")}\n`);
      dyingSessionAt(f, file);
      expect(recover(f, "lost").counted).toBe(2);

      // The resumed session is a new agent of the run that names the same file, now whole.
      const resumed = f.t.ids.next("agt");
      const at = f.t.clock.now();
      f.office.immediate(() => {
        f.office.run(
          `insert into agents (office_id, agent_id, run_id, role, model, adapter_version, started_at)
           values ($office_id, $agent, $run, 'developer', 'haiku', '2.1.296', $at)`,
          { agent: resumed, run: f.run, at },
        );
        recordTranscriptPath(
          f.office,
          { run: f.run, agent: resumed },
          {
            kind: "sessionStarted",
            id: null,
            source: "resume",
            resumed: true,
            transcriptPath: file,
          },
          at,
        );
      });
      writeFileSync(file, readFileSync(RESUMED_FILE));
      const pass = recoverTranscriptUsage({
        office: f.office,
        scope: { ...scopeOf(f), agent: resumed },
        read: readTranscript,
        pricing: f.t.state.pricing,
        mode: "lost",
        at,
      });

      // Only msg-r1 and msg-r2 are the resumed agent's.
      expect(pass).toEqual({ counted: 2, detailed: 0, refused: null });
      const owned = f.office
        .all<{ message_id: string }>(
          `select message_id from usage_messages where office_id = $office_id and agent_id = $agent
           order by message_id`,
          { agent: resumed },
        )
        .map((row) => row.message_id);
      expect(owned).toEqual(["msg-r1", "msg-r2"]);
      expect(messageIds(f)).toEqual(["msg-1", "msg-2", "msg-r1", "msg-r2"]);
      // msg-1 and msg-2 once, then msg-r1 and msg-r2.
      expect(totalsOf(f)).toEqual({
        input: 2 + 2 + 3 + 1,
        output: 16 + 7 + 20 + 5,
        cache_create: 7839 + 660 + 500 + 40,
        cache_read: 7839 + 8499 + 8999,
        budget_used: 2 + 2 + 3 + 1 + (16 + 7 + 20 + 5) + (7839 + 660 + 500 + 40),
      });
    }),
  );
});

describe("subagent transcripts (DIPO-134)", () => {
  it(
    "give the per-subagent usage the stream lacked, without touching the totals of a healthy end",
    withIngest((f) => {
      dyingSession(f);
      const before = totalsOf(f);

      expect(recover(f, "detail")).toEqual({ counted: 0, detailed: 2, refused: null });
      expect(totalsOf(f)).toEqual(before);
      expect(readSubagentUsage(f.office, f.run, f.agent)).toEqual([
        {
          subagent: "a1",
          messages: 2,
          input: 4,
          output: 17,
          cacheCreate: 4578 + 776,
          cacheRead: 4578,
        },
      ]);
      expect(recover(f, "detail").detailed).toBe(0);
    }),
  );
});

function assistantLine(id: string, input: number, output: number): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      id,
      model: "claude-haiku-5-5",
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });
}

/** `dyingSession` with the session transcript at `path`. */
function dyingSessionAt(f: IngestFixture, path: string): Ingestor {
  const recording = loadRecording(RECORDING);
  const lines = untilFirstAssistant(recording);
  const last = lines[lines.length - 1]?.t ?? 0;
  appendLines(f.eventFile, [
    ...lines,
    hook(last + 1, { hook_event_name: "SessionStart", source: "startup", transcript_path: path }),
  ]);
  const ingestor = new Ingestor({ office: f.office, clock: f.t.clock, pricing: f.t.state.pricing });
  const state = initialState({ plannedModel: plannedModel(recording) }) as unknown as ParseState;
  ingestor.track(target(f, claude, state));
  return ingestor;
}
