// The watchdog (DIPO-52; 0008 section 3, 0009 section 3): the `stall` recording replayed through
// ingestion on the manual clock writes `work.observed quiet` after `workerQuietMinutes` and
// `no-output` after `workerStallMinutes`, health goes `quiet` then `stuck`, and the next line
// clears both signals.

import { describe, expect, it } from "bun:test";

import { type OfficeId, WorkView } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { readLogState } from "../../src/changelog/log";
import { Renderer } from "../../src/changelog/render";
import type { OfficeHandle } from "../../src/db/office";
import { type IngestAdapter, Ingestor } from "../../src/ingest/ingestor";
import { activeSignals } from "../../src/run/signals";
import { Watchdog } from "../../src/run/watchdog";
import { workView } from "../../src/views/work";
import { initialState, interpret } from "../../src/workers/claude-cli/interpret";
import type { ParseState } from "../../src/workers/types";
import { addOffice, openTestState } from "../commands/helpers";
import { appendLines, hostLines } from "../ingest/helpers";
import { pass, task } from "../stories/helpers";
import { loadRecording, plannedModel } from "../workers/replay";
import { startRun } from "./helpers";

const MINUTE = 60_000;

const claude: IngestAdapter = {
  interpret: (line, state) =>
    interpret(line, state as unknown as ReturnType<typeof initialState>) as unknown as {
      events: [];
      state: ParseState;
    },
};

interface Rendered {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

/** The office's events after `afterSeq`, rendered with their stored views. */
function eventsAfter(office: OfficeHandle, afterSeq: number): Rendered[] {
  const epoch = readLogState(office).epoch;
  const renderer = new Renderer();
  return office
    .all<{
      seq: number;
      at: number;
      type: string;
      tier: "S" | "R";
      delta: string;
      view: string | null;
    }>(
      `select seq, at, type, tier, delta, view from change_log
        where office_id = $office_id and seq > $after order by seq`,
      { after: afterSeq },
    )
    .map((row) => {
      const event = renderer.render(office.officeId as OfficeId, epoch, {
        seq: row.seq,
        at: row.at,
        type: row.type,
        tier: row.tier,
        delta: JSON.parse(row.delta) as unknown,
        ...(row.view === null ? {} : { view: JSON.parse(row.view) as unknown }),
      });
      return { type: event.type, data: event.data as Record<string, unknown> };
    });
}

describe("watchdog", () => {
  it("replays stall: quiet, then no-output and stuck, cleared by the next line", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const office = addOffice(t);
        pass(t, office, [task("TASK-1", { status: "In Progress" })]);
        const started = startRun(t, office, "TASK-1", dir);
        const recording = loadRecording("stall");
        const lines = hostLines(recording);
        const gap = lines.findIndex(
          (line, i) => i > 0 && line.t - (lines[i - 1]?.t ?? line.t) >= 20 * MINUTE,
        );
        expect(gap).toBeGreaterThan(0);
        appendLines(started.eventFile, lines.slice(0, gap));

        let appended = 0;
        let ingested = 0;
        const watchdog = new Watchdog({
          clock: t.clock,
          timeouts: () => ({ workerQuietMinutes: 3, workerStallMinutes: 20 }),
          onAppended: () => {
            appended += 1;
          },
        });
        const ingestor = new Ingestor({
          office,
          clock: t.clock,
          pricing: null,
          hooks: {
            onLines: (run) => watchdog.lineSeen(run),
            onAppended: () => {
              ingested += 1;
            },
          },
        });
        watchdog.track(office, started.run);
        ingestor.track({
          run: started.run,
          agent: started.agent,
          role: "developer",
          tier: "S",
          model: "haiku",
          budgetLimit: 400_000,
          work: started.work,
          adapter: claude,
          initialState: initialState({
            plannedModel: plannedModel(recording),
          }) as unknown as ParseState,
        });
        const seq = readLogState(office).nextSeq - 1;
        // The daemon hears of what ingestion appended once its transaction is done.
        await Promise.resolve();
        expect(ingested).toBeGreaterThan(0);
        expect(workView(office, started.run)?.health).toBe("busy");

        t.clock.advance(3 * MINUTE - 1);
        expect(activeSignals(office, started.run)).toEqual([]);
        t.clock.advance(1);
        expect(workView(office, started.run)?.health).toBe("quiet");
        t.clock.advance(17 * MINUTE);
        const stuck = workView(office, started.run);
        expect(stuck?.health).toBe("stuck");
        expect(stuck?.signals.map((signal) => signal.signal)).toEqual(["quiet", "no-output"]);
        expect(appended).toBe(2);

        const observed = eventsAfter(office, seq).filter((event) => event.type === "work.observed");
        expect(observed.map((event) => [event.data["signal"], event.data["clearedAt"]])).toEqual([
          ["quiet", undefined],
          ["no-output", undefined],
        ]);
        // Each carries the work view at that moment, so a client never derives health.
        expect(observed.map((event) => WorkView.parse(event.data["view"]).health)).toEqual([
          "quiet",
          "stuck",
        ]);

        // The next line clears both, in the pass that read it.
        const before = readLogState(office).nextSeq - 1;
        appendLines(started.eventFile, lines.slice(gap, gap + 1));
        ingestor.pass(started.run, started.agent);
        expect(activeSignals(office, started.run)).toEqual([]);
        const cleared = eventsAfter(office, before).filter(
          (event) => event.type === "work.observed",
        );
        expect(cleared.map((event) => event.data["signal"])).toEqual(["quiet", "no-output"]);
        for (const event of cleared) {
          expect(event.data["clearedAt"]).toBe(new Date(t.clock.now()).toISOString());
          expect(WorkView.parse(event.data["view"]).health).toBe("busy");
        }
        // The waits start again from that line.
        t.clock.advance(3 * MINUTE);
        expect(workView(office, started.run)?.health).toBe("quiet");
        watchdog.close();
        ingestor.close();
      } finally {
        t.state.close();
      }
    }));

  it("stops watching a run that ended and never writes a signal for it", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const office = addOffice(t);
        pass(t, office, [task("TASK-1", { status: "In Progress" })]);
        const started = startRun(t, office, "TASK-1", dir);
        const watchdog = new Watchdog({ clock: t.clock, timeouts: () => undefined });
        watchdog.track(office, started.run);
        office.immediate(() =>
          office.run(
            "update runs set ended_at = 1, end_kind = 'stopped' where office_id = $office_id",
            {},
          ),
        );
        t.clock.advance(30 * MINUTE);
        expect(activeSignals(office, started.run)).toEqual([]);
        expect(watchdog.watching).toBe(0);
      } finally {
        t.state.close();
      }
    }));
});
