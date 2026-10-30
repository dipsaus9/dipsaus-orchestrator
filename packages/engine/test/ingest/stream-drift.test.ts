// Stream drift and the checked version in ingestion (DIPO-315): the ingestor counts the lines the
// adapter cannot read per run in `ingest_cursors.drift_lines`, hands the deciding drift to
// `onStreamDrift` inside the pass, and posts one `engine.notice` per office and version for a
// worker newer than the adapter was checked with. Through the real Claude parser.

import { describe, expect, it } from "bun:test";

import { AgentId } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { HOST_LAUNCH_DEADLINE_MS } from "../../src/run/hosts";
import {
  type IngestAdapter,
  type IngestHooks,
  Ingestor,
  NEWER_VERSION_CODE,
  type StreamDriftCount,
} from "../../src/ingest/ingestor";
import { STREAM_DRIFT_LINES } from "../../src/records/caps";
import { recordWorkerHost } from "../../src/records/worker-hosts";
import { initialState, interpret } from "../../src/workers/claude-cli/interpret";
import { CHECKED_CLAUDE_VERSION } from "../../src/workers/claude-cli/probe";
import type { HostLine, ParseState, WorkerEvent } from "../../src/workers/types";
import { appendLines, type IngestFixture, ingestFixture, loggedEvents, target } from "./helpers";

const claude: IngestAdapter = {
  interpret: (line, state) =>
    interpret(line, state as unknown as ReturnType<typeof initialState>) as unknown as {
      events: [];
      state: ParseState;
    },
};

const start = (): ParseState => initialState({ plannedModel: "haiku" }) as unknown as ParseState;

let at = 0;
const out = (data: unknown): HostLine => ({
  t: (at += 10),
  ch: "stdout",
  data: JSON.stringify(data),
});

const init = (version = "2.1.296"): HostLine =>
  out({
    type: "system",
    subtype: "init",
    session_id: "session-1",
    model: "claude-haiku-5-5",
    claude_code_version: version,
    permissionMode: "default",
    tools: ["Read", "StructuredOutput"],
    apiKeySource: "none",
    cwd: "/work",
  });

/** A line of a message type the adapter does not know: dropped. */
const unknown = (n: number): HostLine => out({ type: "brand_new_type", n });

interface Decided {
  readonly run: string;
  readonly event: Extract<WorkerEvent, { t: "streamDrift" }>;
  readonly count: StreamDriftCount;
}

function ingestor(f: IngestFixture, decided: Decided[]): Ingestor {
  const hooks: IngestHooks = {
    onStreamDrift: (run, _agent, event, count) => decided.push({ run, event, count }),
  };
  return new Ingestor({ office: f.office, clock: f.t.clock, hooks });
}

const driftLines = (f: IngestFixture): number =>
  f.office.get<{ n: number }>(
    `select coalesce(sum(drift_lines), 0) as n from ingest_cursors
      where office_id = $office_id and run_id = $run`,
    { run: f.run },
  )?.n ?? -1;

describe("the stream drift count (DIPO-315)", () => {
  it("counts dropped lines per run and decides at the threshold, not before", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      const decided: Decided[] = [];
      const ingest = ingestor(f, decided);
      appendLines(f.eventFile, [init()]);
      ingest.track(target(f, claude, start()));
      appendLines(
        f.eventFile,
        Array.from({ length: STREAM_DRIFT_LINES - 1 }, (_, n) => unknown(n)),
      );
      ingest.pass(f.run, f.agent);
      expect(driftLines(f)).toBe(STREAM_DRIFT_LINES - 1);
      expect(decided).toEqual([]);

      appendLines(f.eventFile, [unknown(99)]);
      ingest.pass(f.run, f.agent);
      expect(driftLines(f)).toBe(STREAM_DRIFT_LINES);
      expect(decided).toHaveLength(1);
      expect(decided[0]?.count).toEqual({
        lines: STREAM_DRIFT_LINES,
        threshold: STREAM_DRIFT_LINES,
      });
      expect(decided[0]?.event).toMatchObject({ kind: "dropped", worker: "Claude Code 2.1.296" });
      ingest.close();
    }));

  it("keeps the count over a restart and sums a run's agents", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      const first: Decided[] = [];
      const before = ingestor(f, first);
      appendLines(f.eventFile, [init(), unknown(1), unknown(2), unknown(3)]);
      before.track(target(f, claude, start()));
      before.close();
      expect(driftLines(f)).toBe(3);

      // A second agent of the same run (a resumed session) on its own event file.
      const second = AgentId.parse(f.t.ids.next("agt"));
      const file = `${dir}/second.ndjson`;
      recordWorkerHost(
        f.office,
        {
          pid: 4343,
          startTimeMs: 0,
          runId: f.run,
          agentId: second,
          socketPath: `${dir}/second.sock`,
          protocolVersion: 1,
          runDir: dir,
          eventFile: file,
          launchDeadline: f.t.clock.now() + HOST_LAUNCH_DEADLINE_MS,
        },
        f.t.clock,
      );
      appendLines(file, [
        init(),
        ...Array.from({ length: STREAM_DRIFT_LINES - 3 }, (_, n) => unknown(n)),
      ]);
      const decided: Decided[] = [];
      const after = ingestor(f, decided);
      after.track({ ...target(f, claude, start()), agent: second });
      expect(driftLines(f)).toBe(STREAM_DRIFT_LINES);
      expect(first).toEqual([]);
      expect(decided.map((d) => d.count.lines)).toEqual([STREAM_DRIFT_LINES]);
      after.close();
    }));

  it("decides at once on a result whose usage cannot be read, whatever the count", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      const decided: Decided[] = [];
      const ingest = ingestor(f, decided);
      appendLines(f.eventFile, [
        init(),
        out({ type: "result", subtype: "success", session_id: "session-1", modelUsage: "x" }),
      ]);
      ingest.track(target(f, claude, start()));
      expect(decided).toHaveLength(1);
      expect(decided[0]?.event.kind).toBe("usage");
      // A usage drift is not one of the counted lines.
      expect(decided[0]?.count.lines).toBe(0);
      expect(driftLines(f)).toBe(0);
      ingest.close();
    }));
});

const notices = (f: IngestFixture) =>
  loggedEvents(f.office).filter(
    (event) =>
      event.type === "engine.notice" &&
      (event.data as { code?: string }).code === NEWER_VERSION_CODE,
  );

describe("a worker newer than the checked version (DIPO-315)", () => {
  it("posts one engine.notice per version, and none for the checked one", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      const ingest = ingestor(f, []);
      appendLines(f.eventFile, [init(CHECKED_CLAUDE_VERSION)]);
      ingest.track(target(f, claude, start()));
      expect(notices(f)).toEqual([]);
      ingest.close();

      // Two more sessions on 2.1.400, then one on 2.1.401: one notice per version.
      for (const version of ["2.1.400", "2.1.400", "2.1.401"]) {
        const agent = AgentId.parse(f.t.ids.next("agt"));
        const file = `${dir}/${agent}.ndjson`;
        recordWorkerHost(
          f.office,
          {
            pid: 4444,
            startTimeMs: 0,
            runId: f.run,
            agentId: agent,
            socketPath: `${dir}/${agent}.sock`,
            protocolVersion: 1,
            runDir: dir,
            eventFile: file,
            launchDeadline: f.t.clock.now() + HOST_LAUNCH_DEADLINE_MS,
          },
          f.t.clock,
        );
        appendLines(file, [init(version)]);
        const next = ingestor(f, []);
        next.track({ ...target(f, claude, start()), agent });
        next.close();
      }
      const posted = notices(f).map((event) => (event.data as { text: string }).text);
      expect(posted).toHaveLength(2);
      expect(posted[0]).toContain("Claude Code 2.1.400");
      expect(posted[0]).toContain(CHECKED_CLAUDE_VERSION);
      expect(posted[1]).toContain("Claude Code 2.1.401");
    }));
});
