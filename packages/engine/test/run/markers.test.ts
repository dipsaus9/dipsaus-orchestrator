// Phase markers in the worker output (DIPO-83): each phase change and the run's end is one
// engine-written line in the run's stored worker output, sent as `work.output`. Interleaved with
// ingested worker output, every byte is stored once and sent once, in order, live and on reread.

import { describe, expect, it } from "bun:test";

import { KNOWN_OUTPUT_MARKER_KINDS, KNOWN_PHASES } from "@dipsaus-orchestrator/contract";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { appendEntries } from "../../src/changelog/log";
import { Ingestor } from "../../src/ingest/ingestor";
import { endRunMarked, markerLine, markPhase, storedMarker } from "../../src/run/markers";
import { runSteps } from "../../src/run/records";
import { outputRange, workView } from "../../src/views";
import type { WorkerEvent } from "../../src/workers/types";
import { scriptedWorker } from "../workers/scripts";
import {
  appendLines,
  type IngestFixture,
  ingestFixture,
  loggedEvents,
  storedOutput,
  target,
} from "../ingest/helpers";

const T0 = Date.parse("2026-10-15T12:04:31.000Z");

function addStoryRun(f: IngestFixture): void {
  f.office.immediate(() => {
    f.office.run(
      `insert into runs (office_id, run_id, kind, key, story_id, tier, role, model, start_sha,
         branch, budget_unit, budget_limit, loop_cap, config_hash, started_at)
       values ($office_id, $run, 'story', $key, 'DIPO-1', 'M', 'developer', 'haiku', $sha,
         'DIPO-1/x', 'tokens', 400000, 3, 'h', 0)`,
      { run: f.run, key: f.work.key, sha: "a".repeat(40) },
    );
    f.office.run(
      `insert into agents (office_id, agent_id, run_id, role, model, started_at)
       values ($office_id, $agent, $run, 'developer', 'haiku', 0)`,
      { agent: f.agent, run: f.run },
    );
  });
}

function phase(f: IngestFixture, name: string, at: number): void {
  f.office.immediate(() => {
    const entries = markPhase(f.office, f.run, name, at);
    appendEntries(f.office, entries, { at });
  });
}

interface Sent {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

function sentOutput(f: IngestFixture): Sent[] {
  return loggedEvents(f.office)
    .filter((event) => event.type === "work.output")
    .map((event) => event.data as Sent);
}

describe("phase markers (DIPO-83)", () => {
  it("interleave with worker output; each byte is stored and sent once, in order", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      addStoryRun(f);
      const script: WorkerEvent[] = [
        { t: "output", text: "first words" },
        { t: "output", text: "still building" },
        { t: "output", text: "fixing the failure" },
      ];
      const lines = scriptedWorker({ script }).lines();
      const ingestor = new Ingestor({
        office: f.office,
        clock: f.t.clock,
      });

      phase(f, "setup", T0);
      ingestor.track(target(f, scriptedWorker({ script }), { events: [] }));
      phase(f, "build", T0 + 1_000);
      appendLines(f.eventFile, lines.slice(0, 1));
      f.t.clock.advance(1_000); // poll and 250 ms debounce: "first words" is sent
      appendLines(f.eventFile, lines.slice(1, 2));
      ingestor.pass(f.run, f.agent); // stored, still pending when the phase changes
      const pending = sentOutput(f)
        .map((range) => range.text)
        .join("");
      expect(storedOutput(f.office, f.run).startsWith(pending)).toBe(true);
      expect(pending).not.toContain("still building");
      phase(f, "verify", T0 + 2_000);
      phase(f, "build", T0 + 3_000);
      appendLines(f.eventFile, lines.slice(2, 3));
      ingestor.pass(f.run, f.agent);
      f.t.clock.advance(1_000);
      f.office.immediate(() => endRunMarked(f.office, f.run, T0 + 4_000, "parked"));
      f.t.clock.advance(1_000);

      const stored = storedOutput(f.office, f.run);
      expect(stored).toBe(
        [
          markerLine("phase", "setup", T0),
          markerLine("phase", "build", T0 + 1_000),
          "first words\n",
          "still building\n",
          markerLine("phase", "verify", T0 + 2_000),
          markerLine("phase", "build", T0 + 3_000),
          "fixing the failure\n",
          markerLine("ended", "parked", T0 + 4_000),
        ].join(""),
      );
      expect(markerLine("phase", "verify", T0)).toBe(
        "[dipo] 2026-10-15T12:04:31.000Z phase verify\n",
      );

      // Live: the work.output ranges are contiguous from 0, never overlap, and add up to the store.
      const sent = sentOutput(f);
      let end = 0;
      for (const range of sent) {
        expect(range.from).toBe(end);
        expect(range.to - range.from).toBe(new TextEncoder().encode(range.text).byteLength);
        end = range.to;
      }
      expect(sent.map((range) => range.text).join("")).toBe(stored);

      // Reread: work.outputRange returns the same bytes.
      expect(outputRange(f.office, f.run, "worker", 0).text).toBe(stored);
      expect(runSteps(f.office, f.run).map((step) => step.value)).toEqual([
        "setup",
        "build",
        "verify",
        "build",
      ]);
    }));

  it("an ended run is marked once, and a marker never counts as worker output for the view", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      addStoryRun(f);
      phase(f, "setup", T0);
      expect(workView(f.office, f.run)?.lastOutputAt).toBeUndefined();
      f.office.immediate(() => {
        expect(endRunMarked(f.office, f.run, T0 + 1, "parked")).toBe(true);
        expect(endRunMarked(f.office, f.run, T0 + 2, "parked")).toBe(false);
      });
      expect(storedOutput(f.office, f.run)).toBe(
        markerLine("phase", "setup", T0) + markerLine("ended", "parked", T0 + 1),
      );
    }));
});

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

interface Flagged extends Sent {
  readonly markers?: readonly unknown[];
}

describe("marker flags (DIPO-95)", () => {
  it("flag the engine's markers in work.output and work.outputRange, never a worker's lookalike", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      addStoryRun(f);
      // The worker prints a line that reads exactly like a marker.
      const forged = markerLine("phase", "verify", T0 + 5_000).trimEnd();
      const script: WorkerEvent[] = [
        { t: "output", text: "building" },
        { t: "output", text: forged },
      ];
      const ingestor = new Ingestor({
        office: f.office,
        clock: f.t.clock,
      });
      phase(f, "build", T0);
      ingestor.track(target(f, scriptedWorker({ script }), { events: [] }));
      appendLines(f.eventFile, scriptedWorker({ script }).lines());
      f.t.clock.advance(1_000);
      f.office.immediate(() => endRunMarked(f.office, f.run, T0 + 9_000, "parked"));

      const build = markerLine("phase", "build", T0);
      const ended = markerLine("ended", "parked", T0 + 9_000);
      const stored = storedOutput(f.office, f.run);
      expect(stored).toBe(`${build}building\n${forged}\n${ended}`);
      const endedFrom = bytes(stored) - bytes(ended);
      const buildFlag = {
        from: 0,
        to: bytes(build),
        kind: "phase",
        value: "build",
        at: new Date(T0).toISOString(),
      };
      const endedFlag = {
        from: endedFrom,
        to: bytes(stored),
        kind: "ended",
        value: "parked",
        at: new Date(T0 + 9_000).toISOString(),
      };

      // Live: each marker's own range carries its flag; the worker's ranges carry none.
      const sent = sentOutput(f) as Flagged[];
      expect(sent.filter((range) => range.markers !== undefined)).toEqual([
        { ...sent[0]!, markers: [buildFlag] },
        { ...sent.at(-1)!, markers: [endedFlag] },
      ]);
      const worker = sent.filter((range) => range.markers === undefined);
      expect(worker.map((range) => range.text).join("")).toBe(`building\n${forged}\n`);

      // Reread: the same two flags, by byte range; the forged line is plain text.
      const whole = outputRange(f.office, f.run, "worker", 0);
      expect(whole.text).toBe(stored);
      expect(whole.markers).toEqual([buildFlag, endedFlag]);
      // A range with only worker text has no flags; a range that cuts into a marker flags it.
      const forgedFrom = bytes(`${build}building\n`);
      expect(outputRange(f.office, f.run, "worker", forgedFrom, endedFrom).markers).toBeUndefined();
      expect(outputRange(f.office, f.run, "worker", endedFrom + 3).markers).toEqual([endedFlag]);
    }));
});

describe("storedMarker (DIPO-95)", () => {
  const times = [T0, T0 + 123, Date.parse("2026-01-02T03:04:05.000Z")];
  const values: Record<(typeof KNOWN_OUTPUT_MARKER_KINDS)[number], string[]> = {
    phase: [...KNOWN_PHASES],
    ended: ["done", "parked", "dropped", "by you"],
  };

  it("reads back every marker line markerLine writes, for every kind and value shape", () => {
    for (const kind of KNOWN_OUTPUT_MARKER_KINDS) {
      for (const value of values[kind]) {
        for (const at of times) {
          const line = markerLine(kind, value, at);
          const to = 7 + bytes(line);
          expect(storedMarker(line, 7, to)).toEqual({
            from: 7,
            to,
            kind,
            value,
            at: new Date(at).toISOString(),
          });
        }
      }
    }
  });

  it("reads nothing from text that is not a marker line", () => {
    expect(storedMarker("building\n", 0, 9)).toBeNull();
    expect(storedMarker("[dipo] soon phase verify\n", 0, 25)).toBeNull();
    expect(storedMarker("[dipo] 2026-10-15T12:04:31.000Z paused now\n", 0, 43)).toBeNull();
  });
});
