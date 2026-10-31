// The one retention rule (DIPO-65, DIPO-354; 0007): run detail older than retention.days goes in
// batches of at most 5,000 rows, the outcome rows and the daily rollup stay, a replay below the
// oldest change-log entry left must reset, run directories go, and the load step runs at load and
// hourly.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { OfficeId, StoryId } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { appendEntries, cursorAt, readLogState } from "../../src/changelog/log";
import { replay } from "../../src/changelog/replay";
import { buildRegistry } from "../../src/commands/registry";
import { OFFICE_DEFAULTS, type OfficeConfig } from "../../src/config";
import type { OfficeHandle } from "../../src/db/office";
import { storeGateDecision } from "../../src/gate-decisions";
import { officeDirectory } from "../../src/office/marker";
import { Retention, RETENTION_INTERVAL_MS, RETENTION_STEP } from "../../src/retention/feature";
import { DAY_MS, runRetention } from "../../src/retention/run";
import { MAX_BATCH_ROWS } from "../../src/retention/slices";
import { addStory } from "../../src/records/story-keys";
import { runDirectory } from "../../src/records/worker-hosts";
import { addOffice, countRows, openTestState, type TestState } from "../commands/helpers";

import {
  DeleteRecorder,
  insertAgent,
  insertClaim,
  insertHost,
  insertJournal,
  insertOpenPark,
  insertRun,
  insertProfile,
  insertPromptPart,
  insertReleasedBranch,
  insertScan,
  insertStoryPr,
  insertRequest,
  insertRequests,
} from "./helpers";

const noPause = async () => {};
const DAYS = 30;

async function withOffice(fn: (t: TestState, office: OfficeHandle, dir: string) => Promise<void>) {
  return withTempDir(async (dir) => {
    const t = await openTestState(dir);
    try {
      await fn(t, addOffice(t), dir);
    } finally {
      t.state.close();
    }
  });
}

// A short-tier entry that renders (the write check of DIPO-124 refuses one that does not).
const progress = (n: number) => ({
  type: "work.progress",
  delta: {
    work: {
      story: "DIPO-21",
      key: "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D",
      run: "run_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D",
      agent: "agt_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D",
      role: "developer",
      tier: "M",
      model: "claude-sonnet",
    },
    progress: {
      criteriaMet: n,
      criteriaTotal: 7,
      loop: 1,
      loopCap: 5,
      verify: "none",
      reviewRound: 0,
    },
  },
});
const notice = (text: string) => ({
  type: "engine.notice",
  delta: { level: "info", code: "test.notice", text },
});

function append(office: OfficeHandle, at: number, entries: { type: string; delta: unknown }[]) {
  office.immediate(() => appendEntries(office, entries, { at }));
}

function seqs(office: OfficeHandle): number[] {
  return office
    .all<{ seq: number }>("select seq from change_log where office_id = $office_id order by seq")
    .map((row) => row.seq);
}

describe("retention of the change log", () => {
  it("deletes entries older than retention.days, and a replay below the oldest left must reset", () =>
    withOffice(async (t, office) => {
      const start = t.clock.now();
      append(office, start, [progress(1), notice("old"), progress(2)]); // seqs 1-3
      t.clock.advance(31 * DAY_MS);
      append(office, t.clock.now(), [progress(3), notice("new")]); // seqs 4-5

      const report = await runRetention({ office, clock: t.clock, days: DAYS, pause: noPause });

      expect(report.deleted).toEqual({ change_log: 3 });
      expect(seqs(office)).toEqual([4, 5]);
      const below = replay(office, cursorAt(office.officeId, 2));
      expect(below.ok).toBe(false);
      if (!below.ok) {
        expect(below.error.code).toBe("stream.resetRequired");
        expect(below.error.details).toEqual({ oldest: cursorAt(office.officeId, 3) });
      }
      const atOldest = replay(office, cursorAt(office.officeId, 3));
      expect(atOldest.ok && atOldest.entries.map((entry) => entry.seq)).toEqual([4, 5]);

      t.clock.advance(31 * DAY_MS);
      const again = await runRetention({ office, clock: t.clock, days: DAYS, pause: noPause });
      expect(again.deleted).toEqual({ change_log: 2 });
      expect(seqs(office)).toEqual([]);
      // Nothing left: only the head can be replayed, and the next entry keeps the seq order.
      expect(replay(office, cursorAt(office.officeId, 4)).ok).toBe(false);
      expect(replay(office, cursorAt(office.officeId, 5)).ok).toBe(true);
      expect(readLogState(office).nextSeq).toBe(6);
    }));
});

describe("retention batches", () => {
  it("deletes in transactions of at most 5,000 rows", () =>
    withOffice(async (t, office) => {
      insertRequests(office, 12_001, t.clock.now());
      insertRequest(office, "young", t.clock.now() + 2 * DAY_MS);
      t.clock.advance(2 * DAY_MS);
      const recorder = new DeleteRecorder(t.state.connection, office.officeId);

      const report = await runRetention({
        office: recorder,
        clock: t.clock,
        days: DAYS,
        pause: noPause,
      });

      expect(report.deleted).toEqual({ requests: 12_001 });
      const requestBatches = recorder.batches.filter((n) => n > 0);
      expect(requestBatches).toEqual([MAX_BATCH_ROWS, MAX_BATCH_ROWS, 2_001]);
      expect(Math.max(...recorder.batches)).toBeLessThanOrEqual(MAX_BATCH_ROWS);
      expect(countRows(office, "requests")).toBe(1);
    }));

  it("halves the batch after a slow one", () =>
    withOffice(async (t, office) => {
      insertRequests(office, 9_000, t.clock.now());
      t.clock.advance(2 * DAY_MS);
      const recorder = new DeleteRecorder(t.state.connection, office.officeId);
      // Every batch takes 80 ms on this clock, over the 50 ms budget.
      const original = recorder.immediate.bind(recorder);
      recorder.immediate = <T>(fn: () => T): T => {
        const result = original(fn);
        t.clock.advance(80);
        return result;
      };
      await runRetention({ office: recorder, clock: t.clock, days: DAYS, pause: noPause });
      expect(recorder.batches.filter((n) => n > 0)).toEqual([5_000, 2_500, 1_250, 250]);
    }));
});

describe("retention of run rows", () => {
  it("deletes what is older than retention.days and keeps younger and live rows", () =>
    withOffice(async (t, office) => {
      const day = (n: number) => t.clock.now() + n * DAY_MS;
      insertAgent(office, { run: "run-old", agent: "agt-old", startedAt: day(0), endedAt: day(0) });
      insertAgent(office, {
        run: "run-mid",
        agent: "agt-mid",
        startedAt: day(25),
        endedAt: day(25),
      });
      insertAgent(office, {
        run: "run-live",
        agent: "agt-live",
        startedAt: day(25),
        endedAt: null,
      });
      insertHost(office, {
        run: "run-old",
        agent: "agt-old",
        runDir: "/nowhere",
        processed: 5,
        final: 5,
        endedAt: day(0),
      });
      insertJournal(office, 1, "merged", day(0));
      insertJournal(office, 2, "pending", null);
      insertJournal(office, 3, "dropped", day(25));
      t.clock.advanceTo(day(40));

      const report = await runRetention({
        office,
        clock: t.clock,
        days: DAYS,
        pause: noPause,
      });

      expect(report.deleted).toEqual({
        output_chunks: 1,
        usage_messages: 1,
        ingest_cursors: 1,
        usage_totals: 1,
        agents: 1,
        worker_hosts: 1,
        backlog_journal: 1,
      });
      const ids = (table: string, column: string) =>
        office
          .all<{ id: unknown }>(
            `select ${column} as id from ${table} where office_id = $office_id order by 1`,
          )
          .map((row) => row.id);
      expect(ids("agents", "agent_id")).toEqual(["agt-live", "agt-mid"]);
      expect(ids("usage_totals", "agent_id")).toEqual(["agt-live", "agt-mid"]);
      // The live run's cursor stays: its run has not ended.
      expect(ids("ingest_cursors", "agent_id")).toEqual(["agt-live", "agt-mid"]);
      expect(ids("output_chunks", "agent_id")).toEqual(["agt-live", "agt-mid"]);
      expect(ids("backlog_journal", "op_id")).toEqual([2, 3]);
    }));

  it("deletes released claims, scans and prompt parts after retention.days", () =>
    withOffice(async (t, office) => {
      const day = (n: number) => t.clock.now() + n * DAY_MS;
      insertClaim(office, "run-released", day(0));
      insertClaim(office, "run-live", null);
      insertScan(office, 1, day(0));
      insertScan(office, 2, day(25));
      insertAgent(office, {
        run: "run-done",
        agent: "agt-done",
        startedAt: day(0),
        endedAt: day(1),
      });
      insertAgent(office, { run: "run-long", agent: "agt-long", startedAt: day(0), endedAt: null });
      insertPromptPart(office, "run-done", "agt-done", day(0));
      insertPromptPart(office, "run-long", "agt-long", day(0));
      t.clock.advanceTo(day(40));

      const report = await runRetention({
        office,
        clock: t.clock,
        days: DAYS,
        pause: noPause,
      });

      expect(report.deleted).toMatchObject({
        claims: 1,
        scans: 1,
        prompt_parts: 1,
      });
      const ids = (sql: string) => office.all<{ id: unknown }>(sql).map((row) => row.id);
      expect(ids("select run_id as id from claims where office_id = $office_id")).toEqual([
        "run-live",
      ]);
      expect(ids("select scan_id as id from scans where office_id = $office_id")).toEqual([2]);
      // The run with an agent still running keeps its prompt parts.
      expect(ids("select run_id as id from prompt_parts where office_id = $office_id")).toEqual([
        "run-long",
      ]);
    }));

  it("deletes prompt texts recorded more than retention.days ago and keeps newer ones (DIPO-137)", () =>
    withOffice(async (t, office) => {
      const day = (n: number) => t.clock.now() + n * DAY_MS;
      const insert = (agent: string, at: number) =>
        office.immediate(() =>
          office.run(
            `insert into prompt_texts (office_id, run_id, agent_id, part, text, recorded_at)
             values ($office_id, 'run-1', $agent, 'system', 'You are the developer.', $at)`,
            { agent, at },
          ),
        );
      insert("agt-old", day(0));
      insert("agt-new", day(25));
      t.clock.advanceTo(day(40));

      const report = await runRetention({
        office,
        clock: t.clock,
        days: DAYS,
        pause: noPause,
      });

      expect(report.deleted).toMatchObject({ prompt_texts: 1 });
      expect(
        office
          .all<{ agent_id: string }>(
            "select agent_id from prompt_texts where office_id = $office_id",
          )
          .map((row) => row.agent_id),
      ).toEqual(["agt-new"]);
    }));

  it("deletes gate decisions and their decided gates after retention.days (DIPO-71)", () =>
    withOffice(async (t, office) => {
      const day = (n: number) => t.clock.now() + n * DAY_MS;
      const story = office.immediate(() =>
        addStory(office, t.ids, { story: StoryId.parse("DIPO-7") }, day(0)),
      );
      const decide = (at: number) =>
        office.immediate(
          () =>
            storeGateDecision(office, t.ids, {
              key: story.key,
              result: { mode: "pickup", passed: true, failures: [] },
              contentHash: "0".repeat(64),
              at,
            }).gate,
        );
      decide(day(0));
      const recent = decide(day(25));
      office.immediate(() =>
        office.run(
          `insert into gates (office_id, gate_id, kind, key, opened_at, waiting_on, summary)
           values ($office_id, 'gat-waiting', 'review', $key, $at, 'maintainer', 'waiting')`,
          { key: story.key, at: day(0) },
        ),
      );
      t.clock.advanceTo(day(40));

      const report = await runRetention({
        office,
        clock: t.clock,
        days: DAYS,
        pause: noPause,
      });

      expect(report.deleted).toMatchObject({ gate_decisions: 1, gates: 1 });
      const ids = (sql: string) => office.all<{ id: unknown }>(sql).map((row) => row.id);
      expect(ids("select gate_id as id from gate_decisions where office_id = $office_id")).toEqual([
        recent,
      ]);
      expect(
        ids("select gate_id as id from gates where office_id = $office_id order by opened_at desc"),
      ).toEqual([recent, "gat-waiting"]);
    }));

  it("deletes story PRs closed before retention.days and keeps open and recently closed ones", () =>
    withOffice(async (t, office) => {
      const day = (n: number) => t.clock.now() + n * DAY_MS;
      insertStoryPr(office, "run-old", day(0));
      insertStoryPr(office, "run-old-unmerged", day(0), "closed");
      insertStoryPr(office, "run-recent", day(25));
      insertStoryPr(office, "run-open", null);
      t.clock.advanceTo(day(40));

      const report = await runRetention({
        office,
        clock: t.clock,
        days: DAYS,
        pause: noPause,
      });

      expect(report.deleted).toEqual({ story_prs: 2 });
      expect(
        office
          .all<{ id: string }>(
            "select run_id as id from story_prs where office_id = $office_id order by 1",
          )
          .map((row) => row.id),
      ).toEqual(["run-open", "run-recent"]);
    }));

  it("deletes review verdicts decided before retention.days and keeps recent ones (DIPO-146)", () =>
    withOffice(async (t, office) => {
      const day = (n: number) => t.clock.now() + n * DAY_MS;
      for (const [gate, at] of [
        ["gate-old", day(0)],
        ["gate-recent", day(25)],
      ] as const) {
        office.immediate(() =>
          office.run(
            `insert into review_verdicts (office_id, gate_id, run_id, key, round, model, commit_sha,
               code_tree_key, verdict, criteria, findings, summary, validation_notes, decided_at)
             values ($office_id, $gate, 'run-1', 'sto-1', 1, 'm', 'c', 't', 'approved', '[]', '[]',
               's', '[]', $at)`,
            { gate, at },
          ),
        );
      }
      t.clock.advanceTo(day(40));

      const report = await runRetention({
        office,
        clock: t.clock,
        days: DAYS,
        pause: noPause,
      });

      expect(report.deleted).toEqual({ review_verdicts: 1 });
      expect(
        office
          .all<{ id: string }>(
            "select gate_id as id from review_verdicts where office_id = $office_id",
          )
          .map((row) => row.id),
      ).toEqual(["gate-recent"]);
    }));

  it("deletes reclaimed released branches after retention.days", () =>
    withOffice(async (t, office) => {
      const day = (n: number) => t.clock.now() + n * DAY_MS;
      insertReleasedBranch(office, "DIPO-1/old", day(0));
      insertReleasedBranch(office, "DIPO-2/recent", day(25));
      insertReleasedBranch(office, "DIPO-3/open", null);
      t.clock.advanceTo(day(40));

      const report = await runRetention({
        office,
        clock: t.clock,
        days: DAYS,
        pause: noPause,
      });

      expect(report.deleted).toEqual({ released_branches: 1 });
      const ids = (sql: string) => office.all<{ id: unknown }>(sql).map((row) => row.id);
      expect(
        ids("select branch as id from released_branches where office_id = $office_id order by 1"),
      ).toEqual(["DIPO-2/recent", "DIPO-3/open"]);
    }));

  it("keeps the current run profile and its previous one and prunes older ones with their rows", () =>
    withOffice(async (t, office) => {
      insertProfile(office, 1, null, false);
      insertProfile(office, 2, 1, false);
      insertProfile(office, 3, 2, false);
      insertProfile(office, 4, 3, true);
      insertScan(office, 1, t.clock.now());

      const report = await runRetention({
        office,
        clock: t.clock,
        days: DAYS,
        pause: noPause,
      });

      expect(report.deleted).toEqual({
        run_capabilities: 2,
        run_env_files: 2,
        run_extra_scripts: 2,
        run_profiles: 2,
      });
      const profileIds = (table: string) =>
        office
          .all<{ id: number }>(
            `select distinct profile_id as id from ${table} where office_id = $office_id order by 1`,
          )
          .map((row) => row.id);
      for (const table of [
        "run_profiles",
        "run_capabilities",
        "run_env_files",
        "run_extra_scripts",
      ]) {
        expect(profileIds(table)).toEqual([3, 4]);
      }
      // Scans keep their own tier.
      expect(countRows(office, "scans")).toBe(1);
    }));

  it("keeps the two newest run profiles when none is current", () =>
    withOffice(async (t, office) => {
      insertProfile(office, 1, null, false);
      insertProfile(office, 2, 1, false);
      insertProfile(office, 3, 2, false);
      await runRetention({ office, clock: t.clock, days: DAYS, pause: noPause });
      expect(
        office
          .all<{ id: number }>(
            "select profile_id as id from run_profiles where office_id = $office_id order by 1",
          )
          .map((row) => row.id),
      ).toEqual([2, 3]);
    }));

  it("uses retention.days", () =>
    withOffice(async (t, office) => {
      insertAgent(office, {
        run: "run-a",
        agent: "agt-a",
        startedAt: t.clock.now(),
        endedAt: t.clock.now(),
      });
      t.clock.advance(3 * DAY_MS);
      const kept = await runRetention({
        office,
        clock: t.clock,
        days: DAYS,
        pause: noPause,
      });
      expect(kept.deleted).toEqual({});
      const short = await runRetention({
        office,
        clock: t.clock,
        days: 2,
        pause: noPause,
      });
      expect(short.deleted).toEqual({
        output_chunks: 1,
        usage_messages: 1,
        ingest_cursors: 1,
        usage_totals: 1,
        agents: 1,
      });
    }));

  it("deletes an old run's detail and keeps its outcome row and the daily rollup", () =>
    withOffice(async (t, office) => {
      const day = (n: number) => t.clock.now() + n * DAY_MS;
      for (const [run, ended] of [
        ["run-old", day(0)],
        ["run-new", day(25)],
      ] as const) {
        insertRun(office, run, ended, "done");
        insertAgent(office, { run, agent: `agt-${run}`, startedAt: ended, endedAt: ended });
        insertHost(office, {
          run,
          agent: `agt-${run}`,
          runDir: "/nowhere",
          processed: 5,
          final: 5,
          endedAt: ended,
        });
        office.immediate(() =>
          appendEntries(office, [{ ...notice(run), run: run as never }], { at: ended }),
        );
      }
      insertRun(office, "run-active", null);
      t.clock.advanceTo(day(40));

      const report = await runRetention({ office, clock: t.clock, days: DAYS, pause: noPause });

      expect(report.deleted).toEqual({
        change_log: 1,
        output_chunks: 1,
        usage_messages: 1,
        ingest_cursors: 1,
        usage_totals: 1,
        agents: 1,
        run_steps: 1,
        runs: 1,
        worker_hosts: 1,
      });
      const runs = (table: string) =>
        office
          .all<{ id: string }>(
            `select distinct run_id as id from ${table} where office_id = $office_id order by 1`,
          )
          .map((row) => row.id);
      expect(runs("runs")).toEqual(["run-active", "run-new"]);
      expect(runs("run_steps")).toEqual(["run-active", "run-new"]);
      expect(runs("agents")).toEqual(["run-new"]);
      expect(runs("worker_hosts")).toEqual(["run-new"]);
      expect(runs("change_log")).toEqual(["run-new"]);
      // Kept for retro and trends.
      expect(runs("run_outcomes")).toEqual(["run-new", "run-old"]);
      expect(countRows(office, "usage_daily")).toBe(2);
    }));
});

function runDir(commonDir: string, run: string): string {
  const dir = runDirectory(officeDirectory(commonDir), run);
  mkdirSync(dir, { recursive: true });
  for (const file of ["events.ndjson", "host.log", "exit.json"]) {
    writeFileSync(join(dir, file), "{}\n");
  }
  return dir;
}

describe("run directories", () => {
  it("deletes events.ndjson once the run ended, was processed and summarised", () =>
    withOffice(async (t, office, tmp) => {
      const commonDir = join(tmp, "repo", ".git");
      const done = t.ids.next("run");
      const unsummarised = t.ids.next("run");
      const unprocessed = t.ids.next("run");
      const active = t.ids.next("run");
      const dirs = Object.fromEntries(
        [done, unsummarised, unprocessed, active].map((run) => [run, runDir(commonDir, run)]),
      );
      const now = t.clock.now();
      insertHost(office, {
        run: done,
        agent: "a1",
        runDir: dirs[done]!,
        processed: 9,
        final: 9,
        endedAt: now,
      });
      insertHost(office, {
        run: unsummarised,
        agent: "a2",
        runDir: dirs[unsummarised]!,
        processed: 9,
        final: 9,
        endedAt: now,
      });
      insertHost(office, {
        run: unprocessed,
        agent: "a3",
        runDir: dirs[unprocessed]!,
        processed: 4,
        final: 9,
        endedAt: now,
      });
      insertHost(office, {
        run: active,
        agent: "a4",
        runDir: dirs[active]!,
        processed: 9,
        final: null,
        endedAt: null,
      });

      const report = await runRetention({
        office,
        clock: t.clock,
        days: DAYS,
        pause: noPause,
        runFiles: {
          commonDir,
          keepRawEvents: false,
          summarised: (_o, run) => run !== unsummarised,
        },
      });

      expect(report.eventFiles).toBe(1);
      expect(report.runDirectories).toBe(0);
      expect(existsSync(join(dirs[done]!, "events.ndjson"))).toBe(false);
      expect(existsSync(join(dirs[done]!, "host.log"))).toBe(true);
      expect(existsSync(join(dirs[done]!, "exit.json"))).toBe(true);
      for (const run of [unsummarised, unprocessed, active]) {
        expect(existsSync(join(dirs[run]!, "events.ndjson"))).toBe(true);
      }
    }));

  it("deletes the run directory after retention.days, with a notice when never fully processed", () =>
    withOffice(async (t, office, tmp) => {
      const commonDir = join(tmp, "repo", ".git");
      const processed = t.ids.next("run");
      const partial = t.ids.next("run");
      const kept = t.ids.next("run");
      const now = t.clock.now();
      insertHost(office, {
        run: processed,
        agent: "a1",
        runDir: runDir(commonDir, processed),
        processed: 9,
        final: 9,
        endedAt: now,
      });
      insertHost(office, {
        run: partial,
        agent: "a2",
        runDir: runDir(commonDir, partial),
        processed: 4,
        final: 9,
        endedAt: now,
      });
      insertHost(office, {
        run: kept,
        agent: "a3",
        runDir: runDir(commonDir, kept),
        processed: 9,
        final: 9,
        endedAt: now + 5 * DAY_MS,
      });
      t.clock.advance(31 * DAY_MS);
      const head = readLogState(office).nextSeq;

      const report = await runRetention({
        office,
        clock: t.clock,
        days: DAYS,
        pause: noPause,
        // keepRawEvents keeps the stream for retention.days; then it goes with the directory.
        runFiles: { commonDir, keepRawEvents: true, summarised: () => true },
      });

      expect(report.runDirectories).toBe(2);
      expect(report.eventFiles).toBe(2);
      expect(report.notices).toBe(1);
      expect(existsSync(runDirectory(officeDirectory(commonDir), processed))).toBe(false);
      expect(existsSync(runDirectory(officeDirectory(commonDir), partial))).toBe(false);
      expect(
        existsSync(join(runDirectory(officeDirectory(commonDir), kept), "events.ndjson")),
      ).toBe(true);
      const notices = office.all<{ type: string; delta: string }>(
        "select type, delta from change_log where office_id = $office_id and seq >= $head",
        { head },
      );
      expect(notices).toHaveLength(1);
      expect(notices[0]?.type).toBe("engine.notice");
      const delta = JSON.parse(notices[0]?.delta ?? "{}") as { code: string; text: string };
      expect(delta.code).toBe("retention.eventsUnprocessed");
      expect(delta.text).toContain(partial);
    }));

  it("keeps the raw stream for retention.days with privacy.keepRawEvents", () =>
    withOffice(async (t, office, tmp) => {
      const commonDir = join(tmp, "repo", ".git");
      const run = t.ids.next("run");
      const dir = runDir(commonDir, run);
      insertHost(office, {
        run,
        agent: "a1",
        runDir: dir,
        processed: 9,
        final: 9,
        endedAt: t.clock.now(),
      });
      await runRetention({
        office,
        clock: t.clock,
        days: DAYS,
        pause: noPause,
        runFiles: { commonDir, keepRawEvents: true, summarised: () => true },
      });
      expect(existsSync(join(dir, "events.ndjson"))).toBe(true);
    }));
});

describe("runs that may reopen", () => {
  it("keeps a parked run and one open at In Review, and removes done and dropped runs (DIPO-373)", () =>
    withOffice(async (t, office, tmp) => {
      const commonDir = join(tmp, "repo", ".git");
      const day = (n: number) => t.clock.now() + n * DAY_MS;
      const kept: string[] = [];
      const make = (endKind: string | null) => {
        const run = t.ids.next("run");
        insertRun(office, run, day(0), endKind);
        insertAgent(office, { run, agent: `agt-${run}`, startedAt: day(0), endedAt: day(0) });
        insertHost(office, {
          run,
          agent: `agt-${run}`,
          runDir: runDir(commonDir, run),
          processed: 9,
          final: 9,
          endedAt: day(0),
        });
        return run;
      };
      // Parked with its claim live, and open at In Review (no ending, its active period ended).
      for (const endKind of ["parked", null]) {
        const run = make(endKind);
        insertClaim(office, run, null);
        kept.push(run);
      }
      // Parked with its claim released, but its park still open: a resume brings it back.
      const parked = make("parked");
      insertClaim(office, parked, day(0));
      insertOpenPark(office, 1, parked);
      kept.push(parked);
      // Done, even with its claim still live, and dropped: they never reopen.
      const done = make("done");
      insertClaim(office, done, null);
      const dropped = make("dropped");
      insertClaim(office, dropped, day(0));
      // Parked, its claim released and its park resolved: nothing brings it back.
      const left = make("parked");
      insertClaim(office, left, day(0));
      t.clock.advanceTo(day(31));

      const report = await runRetention({
        office,
        clock: t.clock,
        days: DAYS,
        pause: noPause,
        runFiles: { commonDir, keepRawEvents: true, summarised: () => true },
      });

      const runs = (table: string) =>
        office
          .all<{ id: string }>(
            `select distinct run_id as id from ${table} where office_id = $office_id order by 1`,
          )
          .map((row) => row.id);
      const sorted = kept.toSorted();
      for (const table of ["runs", "run_steps", "agents", "usage_totals", "worker_hosts"]) {
        expect(runs(table)).toEqual(sorted);
      }
      expect(report.deleted).toMatchObject({ runs: 3, agents: 3, worker_hosts: 3 });
      expect(report.runDirectories).toBe(3);
      for (const run of kept) {
        expect(existsSync(runDirectory(officeDirectory(commonDir), run))).toBe(true);
      }
      for (const run of [done, dropped, left]) {
        expect(existsSync(runDirectory(officeDirectory(commonDir), run))).toBe(false);
      }
    }));
});

function setup(t: TestState, office: OfficeHandle, commonDir: string) {
  let config: OfficeConfig = {
    ...OFFICE_DEFAULTS,
    retention: { days: 1 },
  };
  const loaded = new Map<string, OfficeHandle>([[office.officeId, office]]);
  const changed: string[] = [];
  const retention = new Retention({
    offices: {
      get: (id) => loaded.get(id),
      config: () => config,
    },
    onOfficeChanged: (id) => changed.push(id),
    pause: noPause,
  });
  const registry = buildRegistry([retention.feature]);
  const step = registry.loadSteps().find((s) => s.name === RETENTION_STEP);
  if (step === undefined) throw new Error("no retention load step");
  const load = () =>
    step.run({
      officeId: OfficeId.parse(office.officeId),
      office,
      path: "/repos/demo",
      commonDir,
      config,
      clock: t.clock,
      ids: t.ids,
    });
  return {
    retention,
    load,
    loaded,
    changed,
    setConfig: (next: OfficeConfig) => {
      config = next;
    },
  };
}

describe("the retention load step", () => {
  it("runs at load and then every hour with the configuration in force", () =>
    withOffice(async (t, office, tmp) => {
      const s = setup(t, office, join(tmp, "repo", ".git"));
      append(office, t.clock.now(), [progress(1)]);
      t.clock.advance(2 * DAY_MS);
      expect(await s.load()).toEqual({ ok: true });
      expect(countRows(office, "change_log")).toBe(0);

      append(office, t.clock.now(), [progress(2)]);
      s.setConfig({ ...OFFICE_DEFAULTS, retention: { days: 0 } });
      t.clock.advance(RETENTION_INTERVAL_MS - 1);
      await s.retention.whenIdle(office.officeId);
      expect(countRows(office, "change_log")).toBe(1);
      t.clock.advance(1);
      await s.retention.whenIdle(office.officeId);
      expect(countRows(office, "change_log")).toBe(0);
      await s.retention.stop();
    }));

  it("starts no pass once stopped, neither at load nor queued behind a running one", () =>
    withOffice(async (t, office, tmp) => {
      const s = setup(t, office, join(tmp, "repo", ".git"));
      append(office, t.clock.now(), [progress(1)]);
      t.clock.advance(2 * DAY_MS);
      await s.load();
      expect(countRows(office, "change_log")).toBe(0);
      append(office, t.clock.now() - 2 * DAY_MS, [progress(2)]);

      // A pass asked for in the same turn as stop() is queued, and never starts.
      const queued = s.retention.run(office.officeId);
      await s.retention.stop();
      expect(await queued).toBeNull();
      // An office loading while the daemon closes the database runs no pass either.
      expect(await s.load()).toEqual({ ok: true });
      await s.retention.whenIdle(office.officeId);
      expect(countRows(office, "change_log")).toBe(1);
      expect(t.clock.pendingTimers).toBe(0);
    }));

  it("stops its timer once the office is no longer loaded", () =>
    withOffice(async (t, office, tmp) => {
      const s = setup(t, office, join(tmp, "repo", ".git"));
      await s.load();
      s.loaded.clear();
      append(office, t.clock.now(), [progress(1)]);
      t.clock.advance(RETENTION_INTERVAL_MS + 2 * DAY_MS);
      await s.retention.whenIdle(office.officeId);
      expect(countRows(office, "change_log")).toBe(1);
      expect(t.clock.pendingTimers).toBe(0);
    }));

  it("tells subscribers when a pass appended a notice", () =>
    withOffice(async (t, office, tmp) => {
      const commonDir = join(tmp, "repo", ".git");
      const s = setup(t, office, commonDir);
      const run = t.ids.next("run");
      const dir = runDirectory(officeDirectory(commonDir), run);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "events.ndjson"), "{}\n");
      insertHost(office, {
        run,
        agent: "a1",
        runDir: dir,
        processed: 0,
        final: 3,
        endedAt: t.clock.now(),
      });
      t.clock.advance(2 * DAY_MS);
      await s.load();
      expect(s.changed).toEqual([office.officeId]);
      await s.retention.stop();
    }));
});
