// The records of the maintainer's tests (DIPO-309, 0002, 0007): `acceptance_tests` and the story's
// `test` gate. Writes run inside the caller's transaction and return the change-log entries.
//
// - A test row is written when `test.start` begins, marked ready once the product runs (with the
//   URL and the forwarder behind it), and ended once: by its record (`recordTestResult`) or by a
//   close (`endTest`: a new head, the idle timeout, the story dropped, discarded, merged or out of
//   review, its box lost, a start that failed). At most one open test per story.
// - The test gate. A record opens a `gates` row of kind `test` for the head it tested and decides
//   it at once by the maintainer: `approved` for a pass, `rejected` for a fail. The story's test
//   gate is decided for a head while an approved one exists for it (`testPassedFor`); a fail or a
//   new head leaves it open again.

import {
  type GateId,
  type IdSource,
  type RunId,
  StoryId,
  type StoryKey,
  type TestEndReason,
  TestId,
  type TestResult,
  type TestStep,
  type TestView,
} from "@dipsaus-orchestrator/contract";

import type { NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import { workRefOf } from "../views/work";

/** The gate kind of the story's test gate. */
export const TEST_GATE_KIND = "test";

/** The `end_reason` of a test that was recorded. */
export const TEST_RECORDED = "recorded";

/** One stored test. */
export interface StoredTest {
  readonly testId: TestId;
  readonly key: StoryKey;
  readonly runId: RunId;
  readonly head: string;
  readonly gateId: GateId | null;
  readonly box: string;
  readonly steps: readonly TestStep[];
  readonly url: string | null;
  readonly forwardPort: number | null;
  readonly target: { readonly address: string; readonly port: number } | null;
  readonly startedAt: number;
  readonly readyAt: number | null;
  readonly result: TestResult | null;
  readonly note: string | null;
  readonly recordedAt: number | null;
  readonly endedAt: number | null;
  readonly endReason: string | null;
}

interface TestRow {
  test_id: string;
  key: string;
  run_id: string;
  head_sha: string;
  gate_id: string | null;
  box: string;
  steps: string;
  url: string | null;
  forward_port: number | null;
  target_address: string | null;
  target_port: number | null;
  started_at: number;
  ready_at: number | null;
  result: TestResult | null;
  note: string | null;
  recorded_at: number | null;
  ended_at: number | null;
  end_reason: string | null;
}

const COLUMNS = `test_id, key, run_id, head_sha, gate_id, box, steps, url, forward_port,
  target_address, target_port, started_at, ready_at, result, note, recorded_at, ended_at,
  end_reason`;

function stepsOf(text: string): TestStep[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): TestStep[] => {
      const step = entry as { check?: unknown; expect?: unknown };
      if (typeof step.check !== "string") return [];
      return [
        { check: step.check, ...(typeof step.expect === "string" ? { expect: step.expect } : {}) },
      ];
    });
  } catch {
    return [];
  }
}

function toTest(row: TestRow): StoredTest {
  return {
    testId: TestId.parse(row.test_id),
    key: row.key as StoryKey,
    runId: row.run_id as RunId,
    head: row.head_sha,
    gateId: row.gate_id as GateId | null,
    box: row.box,
    steps: stepsOf(row.steps),
    url: row.url,
    forwardPort: row.forward_port,
    target:
      row.target_address === null || row.target_port === null
        ? null
        : { address: row.target_address, port: row.target_port },
    startedAt: row.started_at,
    readyAt: row.ready_at,
    result: row.result,
    note: row.note,
    recordedAt: row.recorded_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
  };
}

/** Writes a new open test, before its box is made. */
export function insertTest(
  office: OfficeHandle,
  test: {
    readonly testId: string;
    readonly key: StoryKey | string;
    readonly runId: RunId | string;
    readonly head: string;
    readonly box: string;
    readonly steps: readonly TestStep[];
    readonly at: number;
  },
): void {
  office.run(
    `insert into acceptance_tests (office_id, test_id, key, run_id, head_sha, box, steps,
       started_at)
     values ($office_id, $test, $key, $run, $head, $box, $steps, $at)`,
    {
      test: test.testId,
      key: test.key,
      run: test.runId,
      head: test.head,
      box: test.box,
      steps: JSON.stringify(test.steps),
      at: test.at,
    },
  );
}

/** The test `testId`, or null. */
export function findTest(office: OfficeHandle, testId: string): StoredTest | null {
  const row = office.get<TestRow>(
    `select ${COLUMNS} from acceptance_tests where office_id = $office_id and test_id = $test`,
    { test: testId },
  );
  return row === null ? null : toTest(row);
}

/** The story's open test, or null. */
export function openTestOf(office: OfficeHandle, key: StoryKey | string): StoredTest | null {
  const row = office.get<TestRow>(
    `select ${COLUMNS} from acceptance_tests
      where office_id = $office_id and key = $key and ended_at is null`,
    { key },
  );
  return row === null ? null : toTest(row);
}

/** Every open test of the office, oldest first. */
export function openTests(office: OfficeHandle): StoredTest[] {
  return office
    .all<TestRow>(
      `select ${COLUMNS} from acceptance_tests where office_id = $office_id and ended_at is null
        order by started_at, test_id`,
    )
    .map(toTest);
}

/** The newest recorded test of the run, or null. */
export function latestRecordedTest(office: OfficeHandle, runId: RunId | string): StoredTest | null {
  const row = office.get<TestRow>(
    `select ${COLUMNS} from acceptance_tests
      where office_id = $office_id and run_id = $run and result is not null
      order by recorded_at desc, rowid desc limit 1`,
    { run: runId },
  );
  return row === null ? null : toTest(row);
}

/** True when a test pass is recorded for the story at `head`: its test gate is decided. */
export function testPassedFor(office: OfficeHandle, key: StoryKey | string, head: string): boolean {
  if (head === "") return false;
  return (
    office.get<{ found: number }>(
      `select 1 as found from acceptance_tests
        where office_id = $office_id and key = $key and head_sha = $head and result = 'pass'
        limit 1`,
      { key, head },
    ) !== null
  );
}

/** The story id of `key` now, or null. */
export function storyIdOfKey(office: OfficeHandle, key: StoryKey | string): StoryId | null {
  const row = office.get<{ story_id: string }>(
    "select story_id from stories where office_id = $office_id and key = $key",
    { key },
  );
  return row === null ? null : StoryId.parse(row.story_id);
}

/** The `dipo test shell <ID>` line of a story. */
export function shellLine(story: string): string {
  return `dipo test shell ${story}`;
}

/** The test's view, as `office.snapshot` and `test.started` carry it; null without its story. */
export function testViewOf(office: OfficeHandle, test: StoredTest): TestView | null {
  const story = storyIdOfKey(office, test.key);
  if (story === null) return null;
  return {
    test: test.testId,
    story,
    key: test.key,
    checkout: test.box,
    head: test.head,
    steps: [...test.steps],
    ...(test.url === null ? {} : { url: test.url }),
    shell: shellLine(story),
    startedAt: new Date(test.startedAt).toISOString(),
  };
}

/** The views of the office's open tests whose product runs, for `office.snapshot`. */
export function openTestViews(office: OfficeHandle): TestView[] {
  return openTests(office).flatMap((test) => {
    if (test.readyAt === null) return [];
    const view = testViewOf(office, test);
    return view === null ? [] : [view];
  });
}

/** Marks the test ready: its product runs, with the URL and the forwarder behind it. */
export function markTestReady(
  office: OfficeHandle,
  testId: string,
  ready: {
    readonly url: string | null;
    readonly forwardPort: number | null;
    readonly target: { readonly address: string; readonly port: number } | null;
    readonly at: number;
  },
): NewEntry[] {
  office.run(
    `update acceptance_tests set url = $url, forward_port = $port, target_address = $address,
       target_port = $target_port, ready_at = $at
     where office_id = $office_id and test_id = $test and ended_at is null`,
    {
      test: testId,
      url: ready.url,
      port: ready.forwardPort,
      address: ready.target?.address ?? null,
      target_port: ready.target?.port ?? null,
      at: ready.at,
    },
  );
  return startedEntries(office, testId);
}

/** The `test.started` entry of an open, ready test; none otherwise. */
export function startedEntries(office: OfficeHandle, testId: string): NewEntry[] {
  const test = findTest(office, testId);
  if (test === null || test.endedAt !== null || test.readyAt === null) return [];
  const view = testViewOf(office, test);
  return view === null
    ? []
    : [{ type: "test.started", key: test.key, run: test.runId, delta: view }];
}

/** A ready test's forwarder moved to `port` (a daemon restart); returns its new `test.started`. */
export function moveTestForward(
  office: OfficeHandle,
  testId: string,
  forward: { readonly port: number; readonly url: string },
): NewEntry[] {
  office.run(
    `update acceptance_tests set forward_port = $port, url = $url
     where office_id = $office_id and test_id = $test and ended_at is null`,
    { test: testId, port: forward.port, url: forward.url },
  );
  return startedEntries(office, testId);
}

/** Closes an open test without a record; returns its `test.ended`, or none when it was closed. */
export function endTest(
  office: OfficeHandle,
  testId: string,
  reason: TestEndReason,
  at: number,
): NewEntry[] {
  const test = findTest(office, testId);
  if (test === null || test.endedAt !== null) return [];
  office.run(
    `update acceptance_tests set ended_at = $at, end_reason = $reason
     where office_id = $office_id and test_id = $test and ended_at is null`,
    { test: testId, at, reason },
  );
  // A test that never ran its product was never shown; it closes without an event.
  if (test.readyAt === null) return [];
  const story = storyIdOfKey(office, test.key);
  return story === null
    ? []
    : [
        {
          type: "test.ended",
          key: test.key,
          run: test.runId,
          delta: { test: test.testId, story, key: test.key, reason },
        },
      ];
}

/**
 * Records the open test's result: the row, the story's test gate for the head opened and decided
 * by the maintainer (approved for a pass, rejected for a fail), and `test.recorded`. Returns no
 * entries when the test was closed meanwhile.
 */
export function recordTestResult(
  office: OfficeHandle,
  ids: IdSource,
  testId: string,
  record: { readonly result: TestResult; readonly note: string | null; readonly at: number },
): NewEntry[] {
  const test = findTest(office, testId);
  if (test === null || test.endedAt !== null) return [];
  const story = storyIdOfKey(office, test.key);
  if (story === null) return [];
  const gate = ids.next("gat") as GateId;
  const summary = `${story}: the maintainer's test of ${test.head.slice(0, 12)} ${record.result === "pass" ? "passed" : "failed"}${record.note === null ? "" : `: ${record.note}`}`;
  office.run(
    `insert into gates (office_id, gate_id, kind, key, run_id, opened_at, waiting_on, summary,
       head_sha)
     values ($office_id, $gate, $kind, $key, $run, $at, 'maintainer', $summary, $head)`,
    {
      gate,
      kind: TEST_GATE_KIND,
      key: test.key,
      run: test.runId,
      at: record.at,
      summary,
      head: test.head,
    },
  );
  const decision = record.result === "pass" ? "approved" : "rejected";
  office.run(
    `insert into gate_decisions
       (office_id, gate_id, decision, decided_by, note, rule_results, content_hash, decided_at)
     values ($office_id, $gate, $decision, 'maintainer', $note, '[]', $head, $at)`,
    { gate, decision, note: record.note, head: test.head, at: record.at },
  );
  office.run(
    `update acceptance_tests set result = $result, note = $note, recorded_at = $at,
       ended_at = $at, end_reason = $reason, gate_id = $gate
     where office_id = $office_id and test_id = $test`,
    {
      test: testId,
      result: record.result,
      note: record.note,
      at: record.at,
      reason: TEST_RECORDED,
      gate,
    },
  );
  const entries: NewEntry[] = [];
  const work = workRefOf(office, test.runId);
  if (work !== null) {
    entries.push({
      type: "gate.reached",
      key: test.key,
      run: test.runId,
      delta: { gate, work, kind: TEST_GATE_KIND, waitingOn: "maintainer", summary },
    });
    entries.push({
      type: "gate.decided",
      key: test.key,
      run: test.runId,
      delta: {
        gate,
        decision,
        by: "maintainer",
        ...(record.note === null ? {} : { note: record.note }),
      },
    });
  }
  entries.push({
    type: "test.recorded",
    key: test.key,
    run: test.runId,
    delta: {
      test: test.testId,
      story,
      key: test.key,
      result: record.result,
      ...(record.note === null ? {} : { note: record.note }),
    },
  });
  return entries;
}
