// Worker compactions as facts (DIPO-106; 0008 sections 3 and 4): each compaction of a replayed
// session is stored once with its pre-compaction tokens and time, and the run's and agent's stats
// give the count and the latest pre-compaction tokens. Retention deletes them with their agent.

import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { AgentId } from "@dipsaus-orchestrator/contract";

import { withTempDir, type RecordedLine, type Recording } from "@dipsaus-orchestrator/testkit";

import { runRetention, DAY_MS } from "../../src/retention/run";
import { Ingestor, type IngestAdapter } from "../../src/ingest/ingestor";
import { readCompactions, type UsageScope } from "../../src/ingest/usage";
import { recordWorkerHost } from "../../src/runs/worker-hosts";
import { initialState, interpret } from "../../src/workers/claude-cli/interpret";
import type { ParseState } from "../../src/workers/types";
import { loadRecording, plannedModel } from "../workers/replay";
import { addOffice, countRows, openTestState } from "../commands/helpers";
import { insertAgent } from "../retention/helpers";
import { eventFileText, ingestFixture, target, type IngestFixture } from "./helpers";

const NAME = "success-single";
const claude: IngestAdapter = {
  interpret: (line, state) =>
    interpret(line, state as unknown as ReturnType<typeof initialState>) as unknown as {
      events: [];
      state: ParseState;
    },
};

const boundary = (t: number, preTokens: number): RecordedLine => ({
  t,
  ch: "stdout",
  data: {
    type: "system",
    subtype: "compact_boundary",
    session_id: "session-1",
    uuid: `uuid-compact-${preTokens}`,
    compact_metadata: { trigger: "auto", pre_tokens: preTokens },
  },
});

const postCompact = (t: number): RecordedLine => ({
  t,
  ch: "hook",
  data: {
    session_id: "session-1",
    transcript_path: "${TRANSCRIPT}",
    cwd: "${WORKDIR}",
    permission_mode: "default",
    hook_event_name: "PostCompact",
    trigger: "auto",
  },
});

const isResult = (line: RecordedLine) =>
  line.ch === "stdout" && (line.data as { type?: string }).type === "result";

/** `success-single` with lines put before its result line. */
function withLinesBeforeResult(lines: (t: number) => RecordedLine[]): Recording {
  const recording = loadRecording(NAME);
  const index = recording.lines.findIndex(isResult);
  const result = recording.lines[index];
  if (result === undefined) throw new Error(`${NAME} has no result line`);
  return {
    ...recording,
    lines: [
      ...recording.lines.slice(0, index),
      ...lines(result.t),
      ...recording.lines.slice(index),
    ],
  };
}

function newIngestor(f: IngestFixture): Ingestor {
  return new Ingestor({ office: f.office, clock: f.t.clock, pricing: f.t.state.pricing });
}

function targetOf(f: IngestFixture, recording: Recording) {
  const state = initialState({ plannedModel: plannedModel(recording) }) as unknown as ParseState;
  return target(f, claude, state);
}

function ingestRecording(f: IngestFixture, recording: Recording, ingestor = newIngestor(f)) {
  writeFileSync(f.eventFile, eventFileText(recording));
  return ingestor.track(targetOf(f, recording));
}

/** A second agent of the same run, with its own worker host and event file. */
function ingestSecondAgent(f: IngestFixture, dir: string, recording: Recording): AgentId {
  const agent = AgentId.parse(f.t.ids.next("agt"));
  const eventFile = join(dir, "events-2.ndjson");
  writeFileSync(eventFile, eventFileText(recording));
  recordWorkerHost(
    f.office,
    {
      pid: 4343,
      startTimeMs: 0,
      runId: f.run,
      agentId: agent,
      socketPath: join(dir, "host-2.sock"),
      protocolVersion: 1,
      runDir: dir,
      eventFile,
    },
    f.t.clock,
  );
  const state = initialState({ plannedModel: plannedModel(recording) }) as unknown as ParseState;
  const result = newIngestor(f).track({ ...target(f, claude, state, { work: false }), agent });
  expect(result.status).toBe("ended");
  return agent;
}

function scopeOf(f: IngestFixture): UsageScope {
  return { run: f.run, agent: f.agent, role: "developer", tier: "M", budgetLimit: 400_000 };
}

interface CompactionRow {
  run_id: string;
  agent_id: string;
  pre_tokens: number | null;
  at: number;
}

function compactionsOf(f: IngestFixture): CompactionRow[] {
  return f.office.all<CompactionRow>(
    "select run_id, agent_id, pre_tokens, at from compactions where office_id = $office_id order by seq",
  );
}

/** A fresh ingestion fixture, closed after the test. */
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

describe("a compaction of a replayed session (DIPO-106)", () => {
  it(
    "stores one compaction fact with its pre-compaction tokens and time",
    withIngest((f) => {
      const recording = withLinesBeforeResult((t) => [boundary(t, 150_000)]);
      expect(ingestRecording(f, recording).status).toBe("ended");

      expect(compactionsOf(f)).toEqual([
        { run_id: f.run, agent_id: f.agent, pre_tokens: 150_000, at: f.t.clock.now() },
      ]);
    }),
  );

  it(
    "stores a PostCompact hook and its compact_boundary as one compaction, in the boundary-first order",
    withIngest((f) => {
      ingestRecording(
        f,
        withLinesBeforeResult((t) => [boundary(t, 150_000), postCompact(t)]),
      );
      expect(compactionsOf(f).map((row) => row.pre_tokens)).toEqual([150_000]);
    }),
  );

  it(
    "stores a PostCompact hook and its compact_boundary as one compaction, in the hook-first order",
    withIngest((f) => {
      ingestRecording(
        f,
        withLinesBeforeResult((t) => [postCompact(t), boundary(t, 150_000)]),
      );
      expect(compactionsOf(f).map((row) => row.pre_tokens)).toEqual([150_000]);
    }),
  );

  it(
    "stores nothing more when the fully ingested file is passed or tracked again",
    withIngest((f) => {
      const recording = withLinesBeforeResult((t) => [boundary(t, 150_000)]);
      const ingestor = newIngestor(f);
      expect(ingestRecording(f, recording, ingestor).status).toBe("ended");
      expect(compactionsOf(f)).toHaveLength(1);

      ingestor.pass(f.run, f.agent);
      ingestor.track(targetOf(f, recording));
      // A restarted engine resumes from the stored cursor.
      newIngestor(f).track(targetOf(f, recording));
      expect(compactionsOf(f)).toHaveLength(1);
    }),
  );

  it(
    "counts a second agent of the run in the run stats and in its own agent stats only",
    withIngest((f, dir) => {
      ingestRecording(
        f,
        withLinesBeforeResult((t) => [boundary(t, 120_000), boundary(t + 1, 90_000)]),
      );
      const second = ingestSecondAgent(
        f,
        dir,
        withLinesBeforeResult((t) => [boundary(t, 60_000)]),
      );

      expect(readCompactions(f.office, scopeOf(f))).toEqual({
        agent: { count: 2, latestPreTokens: 90_000 },
        run: { count: 3, latestPreTokens: 60_000 },
      });
      expect(readCompactions(f.office, { ...scopeOf(f), agent: second })).toEqual({
        agent: { count: 1, latestPreTokens: 60_000 },
        run: { count: 3, latestPreTokens: 60_000 },
      });
    }),
  );

  it(
    "gives the compaction count and the latest pre-compaction tokens, per run and per agent",
    withIngest((f) => {
      ingestRecording(
        f,
        withLinesBeforeResult((t) => [boundary(t, 120_000), boundary(t + 1, 90_000)]),
      );

      expect(readCompactions(f.office, scopeOf(f))).toEqual({
        agent: { count: 2, latestPreTokens: 90_000 },
        run: { count: 2, latestPreTokens: 90_000 },
      });
    }),
  );

  it(
    "reports no compaction when none was stored",
    withIngest((f) => {
      ingestRecording(f, loadRecording(NAME));
      expect(readCompactions(f.office, scopeOf(f))).toEqual({
        agent: { count: 0, latestPreTokens: null },
        run: { count: 0, latestPreTokens: null },
      });
    }),
  );

  it("deletes the compactions of an agent that ended before the state cutoff", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const office = addOffice(t);
        insertAgent(office, { run: "run-old", agent: "agt-old", startedAt: 1, endedAt: 2 });
        office.immediate(() =>
          office.run(
            `insert into compactions (office_id, seq, run_id, agent_id, pre_tokens, at)
             values ($office_id, 1, 'run-old', 'agt-old', 100, 1)`,
          ),
        );
        t.clock.advance(400 * DAY_MS);
        const report = await runRetention({
          office,
          clock: t.clock,
          periods: { shortDays: 7, stateDays: 365 },
          pause: async () => {},
        });
        expect(report.deleted["compactions"]).toBe(1);
        expect(countRows(office, "compactions")).toBe(0);
      } finally {
        t.state.close();
      }
    }));
});
