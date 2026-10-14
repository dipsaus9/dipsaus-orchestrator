// The view reads (DIPO-52; 0005 sections 7 and 8): `office.snapshot` and its alias `office.switch`,
// a subscription after the snapshot's cursor that yields every later entry once, `story.detail`
// with past runs and verdicts, and `work.outputRange` over stored output.

import { describe, expect, it } from "bun:test";

import {
  type Cursor,
  type OfficeSnapshot,
  RequestId,
  type RunRecord,
  type Verdict,
  type WorkView,
} from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { appendEntries } from "../../src/changelog/log";
import { replay } from "../../src/changelog/replay";
import type { OfficeDirectory } from "../../src/commands/offices";
import { buildRegistry } from "../../src/commands/registry";
import type { OfficeHandle } from "../../src/db/office";
import { storeGateDecision } from "../../src/gate/store/decisions";
import { executeRead } from "../../src/reads/execute";
import { endRun } from "../../src/run/records";
import { OUTPUT_RANGE_MAX_BYTES, outputRange, viewsFeature } from "../../src/views/feature";
import { withWorkViews } from "../../src/views/work";
import { addOffice, openTestState, type TestState } from "../commands/helpers";
import { pass, task } from "../stories/helpers";
import { type StartedRun, startRun } from "./helpers";

let request = 0;
function nextRequest(): RequestId {
  request += 1;
  return RequestId.parse(`01J9ZK5Q8W3V4X6Y7Z${String(request).padStart(8, "0")}`);
}

function directory(office: OfficeHandle): OfficeDirectory {
  return {
    get: (id) => (id === office.officeId ? office : undefined),
    load: async () => ({ ok: true, office }),
  };
}

async function read<T>(
  t: TestState,
  office: OfficeHandle,
  name: string,
  args: unknown,
): Promise<T> {
  const reply = await executeRead(
    { registry: buildRegistry([viewsFeature]), offices: directory(office), clock: t.clock },
    { requestId: nextRequest(), name, args },
  );
  if (!reply.ok) throw new Error(`${name} failed: ${reply.error.code} ${reply.error.message}`);
  return reply.result as T;
}

function storeOutput(t: TestState, office: OfficeHandle, started: StartedRun, text: string): void {
  office.immediate(() => {
    const from =
      office.get<{ end: number | null }>(
        "select max(to_offset) as end from output_chunks where office_id = $office_id and run_id = $run",
        { run: started.run },
      )?.end ?? 0;
    const to = from + new TextEncoder().encode(text).byteLength;
    office.run(
      `insert into output_chunks (office_id, run_id, source, from_offset, to_offset, agent_id, text, at)
       values ($office_id, $run, 'worker', $from, $to, $agent, $text, $at)`,
      { run: started.run, from, to, agent: started.agent, text, at: t.clock.now() },
    );
    appendEntries(
      office,
      withWorkViews(office, [
        {
          type: "work.output",
          key: started.key,
          run: started.run,
          delta: { work: started.work, source: "worker", from, to, text },
        },
      ]),
      { at: t.clock.now() },
    );
  });
}

async function withRun(
  fn: (t: TestState, office: OfficeHandle, started: StartedRun) => Promise<void>,
): Promise<void> {
  await withTempDir(async (dir) => {
    const t = await openTestState(dir);
    try {
      const office = addOffice(t);
      pass(t, office, [
        task("TASK-1", { status: "In Progress", criteria: { met: 0, total: 2 } }),
        task("TASK-2", { status: "Ready", waitingOn: ["TASK-1"] }),
      ]);
      await fn(t, office, startRun(t, office, "TASK-1", dir));
    } finally {
      t.state.close();
    }
  });
}

describe("office.snapshot", () => {
  it("returns the derived views with the cursor they match, and office.switch the same", () =>
    withRun(async (t, office, started) => {
      storeOutput(t, office, started, "[tool] Read src/a.ts\n");
      const snapshot = await read<OfficeSnapshot>(t, office, "office.snapshot", {
        office: office.officeId,
      });
      expect(snapshot.stories.map((view) => [view.story, view.column])).toEqual([
        ["TASK-1", "running"],
        ["TASK-2", "waiting"],
      ]);
      expect(snapshot.stories[0]?.work).toEqual(started.work);
      expect(snapshot.work.map((view) => [view.work.run, view.phase, view.health])).toEqual([
        [started.run, "setup", "busy"],
      ]);
      expect(snapshot.work[0]?.lastOutputAt).toBe(new Date(t.clock.now()).toISOString());
      expect({
        gates: snapshot.gates,
        questions: snapshot.questions,
        tests: snapshot.tests,
      }).toEqual({ gates: [], questions: [], tests: [] });
      const head = office.get<{ n: number }>(
        "select next_seq - 1 as n from offices where office_id = $office_id",
      );
      expect(snapshot.cursor.seq).toBe(head?.n ?? -1);

      const switched = await read<OfficeSnapshot>(t, office, "office.switch", {
        office: office.officeId,
      });
      expect(switched).toEqual(snapshot);
    }));

  it("subscribing after its cursor yields every later entry once", () =>
    withRun(async (t, office, started) => {
      storeOutput(t, office, started, "before\n");
      const { cursor } = await read<{ cursor: Cursor }>(t, office, "office.snapshot", {
        office: office.officeId,
      });
      t.clock.advance(250);
      storeOutput(t, office, started, "after 1\n");
      storeOutput(t, office, started, "after 2\n");
      const replayed = replay(office, cursor);
      if (!replayed.ok) throw new Error(replayed.error.message);
      expect(replayed.entries.map((entry) => entry.seq)).toEqual([cursor.seq + 1, cursor.seq + 2]);
      expect(replayed.entries.map((entry) => (entry.delta as { text: string }).text)).toEqual([
        "after 1\n",
        "after 2\n",
      ]);
      // Each entry carries the work view derived when it was stored.
      expect(
        replayed.entries.every((entry) => (entry.view as WorkView).work.run === started.run),
      ).toBe(true);
      // From the head nothing is left.
      const rest = replay(office, replayed.head);
      expect(rest.ok && rest.entries).toEqual([]);
    }));
});

describe("story.detail", () => {
  it("returns the view, the active run's view, past runs and verdicts", () =>
    withRun(async (t, office, started) => {
      office.immediate(() =>
        storeGateDecision(office, t.ids, {
          key: started.key,
          result: { mode: "pickup", passed: true, failures: [] } as never,
          contentHash: "h",
          at: t.clock.now(),
        }),
      );
      const detail = await read<{
        view: { story: string; work?: unknown };
        work?: WorkView;
        runs: RunRecord[];
        verdicts: Verdict[];
      }>(t, office, "story.detail", { office: office.officeId, story: "TASK-1" });
      expect(detail.view.story).toBe("TASK-1");
      expect(detail.work?.work.run).toBe(started.run);
      expect(detail.runs as unknown[]).toEqual([
        {
          run: started.run,
          agents: [started.agent],
          role: "developer",
          tier: "S",
          model: "haiku",
          startedAt: new Date(t.clock.now()).toISOString(),
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreateTokens: 0,
            cacheReadTokens: 0,
            turns: 0,
            elapsedMs: 0,
          },
        },
      ]);
      expect(detail.verdicts).toMatchObject([{ kind: "pickup", decision: "approved", by: "rule" }]);
      expect(detail.verdicts[0]).not.toHaveProperty("run");

      // A run that ended (a failed host start, a release) shows its end; no active work is left.
      t.clock.advance(1000);
      office.immediate(() => endRun(office, started.run, t.clock.now(), "start-failed"));
      const ended = await read<{ work?: WorkView; runs: RunRecord[] }>(t, office, "story.detail", {
        office: office.officeId,
        story: started.key,
      });
      expect(ended.work).toBeUndefined();
      expect(ended.runs[0]).toMatchObject({
        endedAt: new Date(t.clock.now()).toISOString(),
        outcome: "start-failed",
      });
    }));
});

describe("work.outputRange", () => {
  it("returns stored text for a byte range on character boundaries", () =>
    withRun(async (t, office, started) => {
      storeOutput(t, office, started, "héllo\n");
      storeOutput(t, office, started, "world\n");
      const all = await read<{ from: number; to: number; text: string }>(
        t,
        office,
        "work.outputRange",
        { office: office.officeId, run: started.run, source: "worker", from: 0 },
      );
      expect(all).toMatchObject({ from: 0, to: 13, text: "héllo\nworld\n" });
      // Byte 2 is inside "é": the range starts after it and ends before a split character.
      expect(outputRange(office, started.run, "worker", 2, 9)).toMatchObject({
        from: 3,
        to: 9,
        text: "llo\nwo",
      });
      expect(outputRange(office, started.run, "worker", 0, 2)).toMatchObject({
        from: 0,
        to: 1,
        text: "h",
      });
      expect(outputRange(office, started.run, "worker", 13)).toMatchObject({
        from: 13,
        to: 13,
        text: "",
      });
      expect(outputRange(office, started.run, "verify", 0).text).toBe("");
      expect(OUTPUT_RANGE_MAX_BYTES).toBe(1024 * 1024);
    }));
});
