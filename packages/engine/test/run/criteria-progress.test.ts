// Criteria progress from the worker report during a run (DIPO-85): an accepted report's met
// criteria become the run's `Progress.criteriaMet` while the base index still shows none, a
// `work.progress` event carries the new count, a criterion number the story lacks is ignored,
// and a reopened state database keeps the count.

import { describe, expect, it } from "bun:test";

import { type Progress, WorkView } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import type { OfficeHandle } from "../../src/db/office";
import { type IngestAdapter, Ingestor } from "../../src/ingest/ingestor";
import { workView } from "../../src/views/work";
import type { ParseState, WorkerEvent, WorkerReport } from "../../src/workers/types";
import { addOffice, openTestState, type TestState } from "../commands/helpers";
import { appendLines, loggedEvents } from "../ingest/helpers";
import { pass, task } from "../stories/helpers";
import { type StartedRun, startRun } from "../views/helpers";

/** Each stdout line is one turn whose report is the line's JSON. */
const reports: IngestAdapter = {
  interpret: (line, state) => {
    if (line.ch !== "stdout") return { events: [], state };
    const event: WorkerEvent = {
      t: "turn",
      report: JSON.parse(line.data) as WorkerReport,
      totals: {},
      numTurns: 1,
      terminal: "success",
    };
    return { events: [event], state };
  },
};

function report(met: readonly number[], unmet: readonly number[] = []): WorkerReport {
  return {
    status: "done",
    criteria: [
      ...met.map((n) => ({ n, met: true, evidence: `#${n} done` })),
      ...unmet.map((n) => ({ n, met: false, evidence: "" })),
    ],
    summary: "work",
    commitSubject: "do the work",
  };
}

function writeReport(started: StartedRun, t: TestState, body: WorkerReport): void {
  appendLines(started.eventFile, [{ t: t.clock.now(), ch: "stdout", data: JSON.stringify(body) }]);
}

/** The `progress` of each `work.progress` event, with the progress of the view it carries. */
function progressEvents(office: OfficeHandle): { delta: Progress; view: Progress | undefined }[] {
  return loggedEvents(office)
    .filter((event) => event.type === "work.progress")
    .map((event) => {
      const data = event.data as { progress: Progress; view?: { progress: Progress } };
      return { delta: data.progress, view: data.view?.progress };
    });
}

async function setup(dir: string) {
  const t = await openTestState(dir);
  const office = addOffice(t);
  // The base index: the story has three criteria and none is checked there before the merge.
  pass(t, office, [task("TASK-1", { status: "In Progress", criteria: { met: 0, total: 3 } })]);
  const started = startRun(t, office, "TASK-1", dir, {
    criteria: { known: [1, 2, 3], checked: [] },
  });
  const ingestor = new Ingestor({ office, clock: t.clock, pricing: null });
  return { t, office, started, ingestor };
}

function track(ingestor: Ingestor, started: StartedRun): void {
  ingestor.track({
    run: started.run,
    agent: started.agent,
    role: "developer",
    tier: "S",
    model: "haiku",
    budgetLimit: 400_000,
    work: started.work,
    adapter: reports,
    initialState: {} as ParseState,
  });
}

describe("criteria progress from the worker report", () => {
  it("a report marking 2 of 3 criteria met shows 2/3 in the view and the work.progress event", () =>
    withTempDir(async (dir) => {
      const { t, office, started, ingestor } = await setup(dir);
      try {
        expect(workView(office, started.run)?.progress).toMatchObject({
          criteriaMet: 0,
          criteriaTotal: 3,
        });
        writeReport(started, t, report([1, 2], [3]));
        track(ingestor, started);

        const view = workView(office, started.run);
        expect(WorkView.parse(view)).toEqual(view as WorkView);
        expect(view?.progress).toMatchObject({ criteriaMet: 2, criteriaTotal: 3 });
        const events = progressEvents(office);
        expect(events).toHaveLength(1);
        expect(events[0]?.delta).toMatchObject({ criteriaMet: 2, criteriaTotal: 3 });
        expect(events[0]?.view).toMatchObject({ criteriaMet: 2, criteriaTotal: 3 });
      } finally {
        t.state.close();
      }
    }));

  it("ignores a criterion number the story does not have and keeps the count a claim", () =>
    withTempDir(async (dir) => {
      const { t, office, started, ingestor } = await setup(dir);
      try {
        writeReport(started, t, report([2, 7, 42]));
        track(ingestor, started);
        const view = workView(office, started.run);
        expect(view?.progress).toMatchObject({ criteriaMet: 1, criteriaTotal: 3 });
        // The count is what the worker said: the engine never labels it `checked` (0009).
        expect(view?.evidence?.["progress.criteriaMet"]).not.toBe("checked");
        const events = progressEvents(office);
        expect(events.map((event) => event.delta.criteriaMet)).toEqual([1]);
      } finally {
        t.state.close();
      }
    }));

  it("follows the latest report and sends no event when the count stays the same", () =>
    withTempDir(async (dir) => {
      const { t, office, started, ingestor } = await setup(dir);
      try {
        writeReport(started, t, report([1, 2]));
        track(ingestor, started);
        writeReport(started, t, report([2, 1]));
        ingestor.pass(started.run, started.agent);
        expect(progressEvents(office)).toHaveLength(1);

        writeReport(started, t, report([1, 2, 3]));
        ingestor.pass(started.run, started.agent);
        writeReport(started, t, report([1]));
        ingestor.pass(started.run, started.agent);
        expect(progressEvents(office).map((event) => event.delta.criteriaMet)).toEqual([2, 3, 1]);
        expect(workView(office, started.run)?.progress.criteriaMet).toBe(1);
      } finally {
        t.state.close();
      }
    }));

  it("counts criteria checked at run start together with the reported ones", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const office = addOffice(t);
        pass(t, office, [
          task("TASK-1", { status: "In Progress", criteria: { met: 1, total: 3 } }),
        ]);
        const started = startRun(t, office, "TASK-1", dir, {
          criteria: { known: [1, 2, 3], checked: [1] },
        });
        const ingestor = new Ingestor({ office, clock: t.clock, pricing: null });
        // A report naming only the criterion checked already changes nothing shown: no event.
        writeReport(started, t, report([1]));
        track(ingestor, started);
        expect(workView(office, started.run)?.progress.criteriaMet).toBe(1);
        expect(progressEvents(office)).toEqual([]);
        writeReport(started, t, report([3]));
        ingestor.pass(started.run, started.agent);
        expect(workView(office, started.run)?.progress.criteriaMet).toBe(2);
        expect(progressEvents(office).map((event) => event.delta.criteriaMet)).toEqual([2]);
      } finally {
        t.state.close();
      }
    }));

  it("counts only criteria the story still has after a criterion is removed or renumbered", () =>
    withTempDir(async (dir) => {
      const { t, office, started, ingestor } = await setup(dir);
      try {
        writeReport(started, t, report([1, 2, 3]));
        track(ingestor, started);
        expect(workView(office, started.run)?.progress.criteriaMet).toBe(3);
        // The story loses a criterion: the index now holds #1 and #2 only.
        pass(t, office, [
          task("TASK-1", {
            status: "In Progress",
            contentHash: "hash-TASK-1-amended",
            criteria: { met: 0, total: 2, numbers: [1, 2] },
          }),
        ]);
        expect(workView(office, started.run)?.progress).toMatchObject({
          criteriaMet: 2,
          criteriaTotal: 2,
        });
        // A report for the old #3 still counts nothing; a new #3 counts once the story has it.
        writeReport(started, t, report([3]));
        ingestor.pass(started.run, started.agent);
        expect(workView(office, started.run)?.progress.criteriaMet).toBe(0);
        pass(t, office, [
          task("TASK-1", {
            status: "In Progress",
            contentHash: "hash-TASK-1-again",
            criteria: { met: 0, total: 3, numbers: [1, 2, 3] },
          }),
        ]);
        expect(workView(office, started.run)?.progress).toMatchObject({
          criteriaMet: 1,
          criteriaTotal: 3,
        });
      } finally {
        t.state.close();
      }
    }));

  it("keeps the count after a restart", () =>
    withTempDir(async (dir) => {
      const { t, office, started, ingestor } = await setup(dir);
      const officeId = office.officeId;
      try {
        writeReport(started, t, report([1, 3]));
        track(ingestor, started);
        ingestor.close();
      } finally {
        t.state.close();
      }
      // A daemon restart opens the same state database again; the count is a stored run fact.
      const again = await openTestState(dir);
      try {
        const view = workView(again.state.office(officeId), started.run);
        expect(view?.progress).toMatchObject({ criteriaMet: 2, criteriaTotal: 3 });
      } finally {
        again.state.close();
      }
    }));
});
