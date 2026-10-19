// Retention (DIPO-65; 0007 section 7): tiered deletes in batches of at most 5,000 rows, the replay
// floor, run directories, and the load step that runs at load and hourly.

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
import { storeGateDecision } from "../../src/gate";
import { officeDirectory } from "../../src/office/marker";
import { Retention, RETENTION_INTERVAL_MS, RETENTION_STEP } from "../../src/retention/feature";
import { DAY_MS, runRetention } from "../../src/retention/run";
import { MAX_BATCH_ROWS } from "../../src/retention/slices";
import { addStory } from "../../src/stories/keys";
import { runDirectory } from "../../src/runs/worker-hosts";
import { addOffice, countRows, openTestState, type TestState } from "../commands/helpers";

import {
  DeleteRecorder,
  insertAgent,
  insertClaim,
  insertHost,
  insertJournal,
  insertPricingCheck,
  insertProfile,
  insertPromptPart,
  insertNudgeSource,
  insertReleasedBranch,
  insertScan,
  insertStoryPr,
  insertRequest,
  insertRequests,
} from "./helpers";

const noPause = async () => {};
const DEFAULTS = { shortDays: 7, stateDays: 365 };

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

const progress = (n: number) => ({ type: "work.progress", delta: { n } });
const notice = (text: string) => ({
  type: "engine.notice",
  delta: { level: "info", code: "test.notice", text },
});

function append(office: OfficeHandle, at: number, entries: { type: string; delta: unknown }[]) {
  office.immediate(() => appendEntries(office, entries, { at }));
}

function seqs(office: OfficeHandle): { seq: number; tier: string }[] {
  return office.all("select seq, tier from change_log where office_id = $office_id order by seq");
}

describe("retention of the change log", () => {
  it("deletes R entries past the short tier, moves the floor, and a replay below it must reset", () =>
    withOffice(async (t, office) => {
      const start = t.clock.now();
      append(office, start, [progress(1), notice("kept"), progress(2)]); // seqs 1-3
      t.clock.advance(8 * DAY_MS);
      append(office, t.clock.now(), [progress(3), notice("new")]); // seqs 4-5
      const before = readLogState(office);
      expect(before.replayFloorSeq).toBe(0);

      const report = await runRetention({
        office,
        clock: t.clock,
        periods: DEFAULTS,
        pause: noPause,
      });

      expect(report.deleted).toEqual({ change_log: 2 });
      expect(seqs(office)).toEqual([
        { seq: 2, tier: "S" },
        { seq: 4, tier: "R" },
        { seq: 5, tier: "S" },
      ]);
      expect(report.replayFloorSeq).toBe(3);
      expect(readLogState(office).replayFloorSeq).toBe(3);

      const below = replay(office, cursorAt(office.officeId, before.epoch, 1));
      expect(below.ok).toBe(false);
      if (!below.ok) {
        expect(below.error.code).toBe("stream.resetRequired");
        expect(below.error.details).toEqual({
          oldest: cursorAt(office.officeId, before.epoch, 3),
        });
      }
      const atFloor = replay(office, cursorAt(office.officeId, before.epoch, 3));
      expect(atFloor.ok && atFloor.entries.map((entry) => entry.seq)).toEqual([4, 5]);
    }));

  it("deletes S entries after the state tier and never moves the floor back", () =>
    withOffice(async (t, office) => {
      append(office, t.clock.now(), [notice("old"), progress(1)]);
      t.clock.advance(30 * DAY_MS);
      append(office, t.clock.now(), [progress(2), notice("young")]);
      await runRetention({ office, clock: t.clock, periods: DEFAULTS, pause: noPause });
      expect(readLogState(office).replayFloorSeq).toBe(2);

      t.clock.advance(400 * DAY_MS);
      const report = await runRetention({
        office,
        clock: t.clock,
        periods: DEFAULTS,
        pause: noPause,
      });
      expect(report.deleted).toEqual({ change_log: 3 });
      expect(seqs(office)).toEqual([]);
      expect(report.replayFloorSeq).toBe(4);
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
        periods: DEFAULTS,
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
      await runRetention({ office: recorder, clock: t.clock, periods: DEFAULTS, pause: noPause });
      expect(recorder.batches.filter((n) => n > 0)).toEqual([5_000, 2_500, 1_250, 250]);
    }));
});

describe("retention of run rows", () => {
  it("keeps the short tier and state tier apart and deletes rows of runs ended a year ago", () =>
    withOffice(async (t, office) => {
      const day = (n: number) => t.clock.now() + n * DAY_MS;
      insertAgent(office, { run: "run-old", agent: "agt-old", startedAt: day(0), endedAt: day(0) });
      insertAgent(office, {
        run: "run-mid",
        agent: "agt-mid",
        startedAt: day(300),
        endedAt: day(300),
      });
      insertAgent(office, {
        run: "run-live",
        agent: "agt-live",
        startedAt: day(300),
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
      insertJournal(office, 3, "dropped", day(300));
      t.clock.advanceTo(day(400));

      const report = await runRetention({
        office,
        clock: t.clock,
        periods: DEFAULTS,
        pause: noPause,
      });

      expect(report.deleted).toEqual({
        output_chunks: 3,
        usage_messages: 3,
        ingest_cursors: 2,
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
      expect(ids("ingest_cursors", "agent_id")).toEqual(["agt-live"]);
      expect(ids("backlog_journal", "op_id")).toEqual([2, 3]);
    }));

  it("deletes released claims, scans, prompt parts and nudge sources after the state tier", () =>
    withOffice(async (t, office) => {
      const day = (n: number) => t.clock.now() + n * DAY_MS;
      insertClaim(office, "run-released", day(0));
      insertClaim(office, "run-live", null);
      insertScan(office, 1, day(0));
      insertScan(office, 2, day(300));
      insertAgent(office, {
        run: "run-done",
        agent: "agt-done",
        startedAt: day(0),
        endedAt: day(1),
      });
      insertAgent(office, { run: "run-long", agent: "agt-long", startedAt: day(0), endedAt: null });
      insertPromptPart(office, "run-done", "agt-done", day(0));
      insertPromptPart(office, "run-long", "agt-long", day(0));
      insertNudgeSource(office, "run-done", "agt-done", day(0));
      insertNudgeSource(office, "run-long", "agt-long", day(0));
      t.clock.advanceTo(day(400));

      const report = await runRetention({
        office,
        clock: t.clock,
        periods: DEFAULTS,
        pause: noPause,
      });

      expect(report.deleted).toMatchObject({
        claims: 1,
        scans: 1,
        prompt_parts: 1,
        nudge_sources: 1,
      });
      const ids = (sql: string) => office.all<{ id: unknown }>(sql).map((row) => row.id);
      expect(ids("select run_id as id from claims where office_id = $office_id")).toEqual([
        "run-live",
      ]);
      expect(ids("select scan_id as id from scans where office_id = $office_id")).toEqual([2]);
      // The run with an agent still running keeps its prompt parts and nudge sources.
      expect(ids("select run_id as id from prompt_parts where office_id = $office_id")).toEqual([
        "run-long",
      ]);
      expect(ids("select run_id as id from nudge_sources where office_id = $office_id")).toEqual([
        "run-long",
      ]);
    }));

  it("deletes prompt texts recorded more than shortDays ago and keeps newer ones (DIPO-137)", () =>
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
      insert("agt-new", day(6));
      t.clock.advanceTo(day(8));

      const report = await runRetention({
        office,
        clock: t.clock,
        periods: DEFAULTS,
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

  it("deletes gate decisions and their decided gates after the state tier (DIPO-71)", () =>
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
      const recent = decide(day(300));
      office.immediate(() =>
        office.run(
          `insert into gates (office_id, gate_id, kind, key, opened_at, waiting_on, summary)
           values ($office_id, 'gat-waiting', 'review', $key, $at, 'maintainer', 'waiting')`,
          { key: story.key, at: day(0) },
        ),
      );
      t.clock.advanceTo(day(400));

      const report = await runRetention({
        office,
        clock: t.clock,
        periods: DEFAULTS,
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

  it("deletes story PRs closed before the state tier and keeps open and recently closed ones", () =>
    withOffice(async (t, office) => {
      const day = (n: number) => t.clock.now() + n * DAY_MS;
      insertStoryPr(office, "run-old", day(0));
      insertStoryPr(office, "run-recent", day(300));
      insertStoryPr(office, "run-open", null);
      t.clock.advanceTo(day(400));

      const report = await runRetention({
        office,
        clock: t.clock,
        periods: DEFAULTS,
        pause: noPause,
      });

      expect(report.deleted).toEqual({ story_prs: 1 });
      expect(
        office
          .all<{ id: string }>(
            "select run_id as id from story_prs where office_id = $office_id order by 1",
          )
          .map((row) => row.id),
      ).toEqual(["run-open", "run-recent"]);
    }));

  it("deletes reclaimed released branches and pricing checks after the state tier", () =>
    withOffice(async (t, office) => {
      const day = (n: number) => t.clock.now() + n * DAY_MS;
      insertReleasedBranch(office, "DIPO-1/old", day(0));
      insertReleasedBranch(office, "DIPO-2/recent", day(300));
      insertReleasedBranch(office, "DIPO-3/open", null);
      insertPricingCheck(office, "run-old", day(0));
      insertPricingCheck(office, "run-new", day(300));
      t.clock.advanceTo(day(400));

      const report = await runRetention({
        office,
        clock: t.clock,
        periods: DEFAULTS,
        pause: noPause,
      });

      expect(report.deleted).toEqual({ released_branches: 1, pricing_checks: 1 });
      const ids = (sql: string) => office.all<{ id: unknown }>(sql).map((row) => row.id);
      expect(
        ids("select branch as id from released_branches where office_id = $office_id order by 1"),
      ).toEqual(["DIPO-2/recent", "DIPO-3/open"]);
      expect(ids("select run_id as id from pricing_checks where office_id = $office_id")).toEqual([
        "run-new",
      ]);
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
        periods: DEFAULTS,
        pause: noPause,
      });

      expect(report.deleted).toEqual({
        run_capabilities: 2,
        run_env_files: 2,
        run_ports: 2,
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
        "run_ports",
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
      await runRetention({ office, clock: t.clock, periods: DEFAULTS, pause: noPause });
      expect(
        office
          .all<{ id: number }>(
            "select profile_id as id from run_profiles where office_id = $office_id order by 1",
          )
          .map((row) => row.id),
      ).toEqual([2, 3]);
    }));

  it("uses retention.shortDays and retention.stateDays", () =>
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
        periods: DEFAULTS,
        pause: noPause,
      });
      expect(kept.deleted).toEqual({});
      const short = await runRetention({
        office,
        clock: t.clock,
        periods: { shortDays: 1, stateDays: 2 },
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
        periods: DEFAULTS,
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

  it("deletes the run directory after the short tier, with a notice when never fully processed", () =>
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
      t.clock.advance(8 * DAY_MS);
      const head = readLogState(office).nextSeq;

      const report = await runRetention({
        office,
        clock: t.clock,
        periods: DEFAULTS,
        pause: noPause,
        // keepRawEvents keeps the stream for the short tier; the fallback still deletes it.
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

  it("keeps the raw stream for the short tier with privacy.keepRawEvents", () =>
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
        periods: DEFAULTS,
        pause: noPause,
        runFiles: { commonDir, keepRawEvents: true, summarised: () => true },
      });
      expect(existsSync(join(dir, "events.ndjson"))).toBe(true);
    }));
});

function setup(t: TestState, office: OfficeHandle, commonDir: string) {
  let config: OfficeConfig = {
    ...OFFICE_DEFAULTS,
    retention: { shortDays: 1, stateDays: 30 },
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
      s.setConfig({ ...OFFICE_DEFAULTS, retention: { shortDays: 0, stateDays: 30 } });
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
