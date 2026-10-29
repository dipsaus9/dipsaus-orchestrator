// Token spend over all offices (DIPO-311 test plan 2 to 4): the day and month sums over usage rows
// of two offices, the summary's usage with the all-office limit, and the notices at the level and
// the limit, once per window and not again after a restart.

import { describe, expect, it } from "bun:test";

import { OfficeId, type Event } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { SoftwareStream } from "../../src/software-stream";
import { UsageAlerts, USAGE_NOTICES } from "../../src/run/usage-alerts";
import { deriveOfficeSummary, summarySettings } from "../../src/views";
import { UsageMeter, sumUsage, summaryUsage, windowUsage } from "../../src/views/usage";
import { addOffice, openTestState, type TestState } from "../commands/helpers";
import type { OfficeHandle } from "../../src/db/office";

const JAN_15 = Date.UTC(2026, 0, 15, 12);

function daily(
  office: OfficeHandle,
  day: string,
  role: string,
  row: { input?: number; output?: number; create?: number; read?: number; cost?: number },
): void {
  office.immediate(() =>
    office.run(
      `insert into usage_daily (office_id, day, role, tier, model, input, output, cache_create,
         cache_create_5m, cache_create_1h, cache_read, cost_micros)
       values ($office_id, $day, $role, 'M', 'sonnet', $input, $output, $create, $create, 0,
         $read, $cost)
       on conflict (office_id, day, role, tier, model) do update set
         input = input + excluded.input`,
      {
        day,
        role,
        input: row.input ?? 0,
        output: row.output ?? 0,
        create: row.create ?? 0,
        read: row.read ?? 0,
        cost: row.cost ?? null,
      },
    ),
  );
}

// The row of an agent still open. Its run and agent rows are the run tests' business, so the
// foreign keys are off for this one insert.
function live(
  t: TestState,
  office: OfficeHandle,
  run: string,
  input: number,
  liveOutput: number,
): void {
  t.state.connection.exec("pragma foreign_keys = off");
  office.immediate(() =>
    office.run(
      `insert into usage_totals (office_id, run_id, agent_id, model, role, tier, input,
         live_output, cost_micros, final, updated_at)
       values ($office_id, $run, $agent, 'sonnet', 'developer', 'M', $input, $liveOutput, 1000, 0, 1)`,
      { run, agent: `agt-${run}`, input, liveOutput },
    ),
  );
  t.state.connection.exec("pragma foreign_keys = on");
}

async function twoOffices(
  dir: string,
): Promise<{ t: TestState; a: OfficeHandle; b: OfficeHandle }> {
  const t = await openTestState(dir);
  t.clock.advance(JAN_15 - t.clock.now());
  const a = addOffice(t, "a");
  const b = addOffice(t, "b");
  // Office a: a worker, a reviewer and a session today; an earlier day this month; last month.
  daily(a, "2026-01-15", "developer", { input: 100, output: 50, create: 25, read: 999, cost: 500 });
  daily(a, "2026-01-15", "reviewer", { input: 10 });
  daily(a, "2026-01-15", "session", { output: 5 });
  daily(a, "2026-01-02", "developer", { input: 1000 });
  daily(a, "2025-12-31", "developer", { input: 7777 });
  // Office b: a final row today, and the live row of an agent still open.
  daily(b, "2026-01-15", "developer", { output: 200 });
  live(t, b, "run-b", 30, 20);
  return { t, a, b };
}

describe("sumUsage", () => {
  it("counts budget tokens of every run kind, live rows included, and splits at the UTC edges", () =>
    withTempDir(async (dir) => {
      const { t, a, b } = await twoOffices(dir);
      const snapshot = sumUsage(t.state, JAN_15);
      expect(snapshot.dayKey).toBe("2026-01-15");
      expect(snapshot.monthKey).toBe("2026-01");
      // Cache reads (999) are left out; 100 + 50 + 25 + 10 + 5.
      expect(snapshot.offices.get(a.officeId)?.day).toEqual({ tokens: 190, costMicros: 500 });
      expect(snapshot.offices.get(a.officeId)?.month.tokens).toBe(1190);
      // 200 final + 30 input + 20 live output of the open agent.
      expect(snapshot.offices.get(b.officeId)?.day).toEqual({ tokens: 250, costMicros: 1000 });
      expect(snapshot.offices.get(b.officeId)?.month.tokens).toBe(250);
      expect(snapshot.total.day.tokens).toBe(440);
      expect(snapshot.total.month.tokens).toBe(1440);
      expect(snapshot.total.day.costMicros).toBe(1500);
      // The next UTC day starts a new day window; the month keeps its sum.
      const next = sumUsage(t.state, Date.UTC(2026, 0, 16));
      expect(next.offices.get(a.officeId)?.day.tokens).toBe(0);
      expect(next.offices.get(a.officeId)?.month.tokens).toBe(1190);
      // The next UTC month holds none of January's final rows.
      expect(sumUsage(t.state, Date.UTC(2026, 1, 1)).offices.get(a.officeId)?.month.tokens).toBe(0);
    }));
});

describe("usage in the office summary", () => {
  it("carries the office's tokens with the all-office limit, share, alert and cost", () =>
    withTempDir(async (dir) => {
      const { t, a } = await twoOffices(dir);
      const meter = new UsageMeter({
        database: () => t.state,
        clock: t.clock,
        limits: { dayTokens: 500, level: 0.8 },
      });
      const usage = meter.of(a.officeId);
      if (usage === undefined) throw new Error("expected usage");
      expect(usage.dayUsage).toEqual({
        tokens: 190,
        limit: 500,
        share: 440 / 500,
        alert: true,
        estimatedCost: 0.0005,
      });
      // No month limit: tokens only, no share and no alert.
      expect(usage.monthUsage).toEqual({ tokens: 1190, alert: false, estimatedCost: 0.0005 });
      expect(usage.evidence["dayUsage.tokens"]).toBe("claimed");
      expect(usage.evidence["dayUsage.estimatedCost"]).toBe("estimated");
      const summary = deriveOfficeSummary(
        { office: OfficeId.parse(a.officeId), name: "a", path: "/repos/a" },
        a,
        { ...summarySettings(undefined), usage },
      );
      expect(summary.dayUsage?.share).toBe(0.88);
      expect(summary.monthUsage?.tokens).toBe(1190);
    }));

  it("shows tokens with no share and no alert when no limit is set", () => {
    const usage = windowUsage(
      { tokens: 90, costMicros: null },
      { tokens: 900, costMicros: null },
      undefined,
      0.8,
    );
    expect(usage).toEqual({ tokens: 90, alert: false });
    const snapshot = {
      at: 0,
      dayKey: "d",
      monthKey: "m",
      offices: new Map(),
      total: { day: { tokens: 0, costMicros: null }, month: { tokens: 0, costMicros: null } },
    };
    expect(
      summaryUsage(snapshot, OfficeId.parse("off_01J00000000000000000000000"), { level: 0.8 })
        .dayUsage,
    ).toEqual({ tokens: 0, alert: false });
  });

  it("reuses a snapshot for a minute so the summary changes at most once a minute", () =>
    withTempDir(async (dir) => {
      const { t, a, b } = await twoOffices(dir);
      const meter = new UsageMeter({ database: () => t.state, clock: t.clock });
      expect(meter.of(a.officeId)?.dayUsage.tokens).toBe(190);
      daily(a, "2026-01-15", "reviewer", { input: 10 });
      void b;
      t.clock.advance(30_000);
      expect(meter.of(a.officeId)?.dayUsage.tokens).toBe(190);
      t.clock.advance(31_000);
      expect(meter.of(a.officeId)?.dayUsage.tokens).toBe(200);
    }));
});

function alerts(t: TestState, limits: { dayTokens?: number; monthTokens?: number }) {
  const software = new SoftwareStream({ clock: t.clock });
  const events: Event[] = [];
  software.onAppend((event) => events.push(event));
  const changed: string[] = [];
  const meter = new UsageMeter({
    database: () => t.state,
    clock: t.clock,
    limits: { level: 0.5, ...limits },
  });
  const instance = new UsageAlerts({
    meter,
    database: () => t.state,
    software,
    clock: t.clock,
    onOfficeChanged: (office) => changed.push(office),
  });
  return { instance, events, changed };
}

const notices = (events: readonly Event[]) =>
  events
    .filter((event) => event.type === "engine.notice")
    .map((event) => {
      const { level, code } = event.data as { level: string; code: string };
      return { level, code };
    });

describe("usage alerts", () => {
  it("raises one notice at the level and one at the limit per window, once across restarts", () =>
    withTempDir(async (dir) => {
      const { t, a } = await twoOffices(dir);
      // Day total 440: under the level (500 of 1000) until more is used.
      const first = alerts(t, { dayTokens: 1000 });
      first.instance.check();
      expect(notices(first.events)).toEqual([]);
      expect(first.changed).toHaveLength(2);
      daily(a, "2026-01-15", "reviewer", { input: 100 });
      first.instance.check();
      first.instance.check();
      expect(notices(first.events)).toEqual([{ level: "warn", code: USAGE_NOTICES.dayLevel }]);
      daily(a, "2026-01-15", "reviewer", { input: 500 });
      first.instance.check();
      first.instance.check();
      expect(notices(first.events)).toEqual([
        { level: "warn", code: USAGE_NOTICES.dayLevel },
        { level: "error", code: USAGE_NOTICES.dayLimit },
      ]);
      // A restarted daemon repeats neither.
      const restarted = alerts(t, { dayTokens: 1000 });
      restarted.instance.check();
      expect(notices(restarted.events)).toEqual([]);
      // The next UTC day raises a new one when the total is over the level again.
      t.clock.advance(24 * 3_600_000);
      daily(a, "2026-01-16", "reviewer", { input: 1200 });
      restarted.instance.check();
      expect(notices(restarted.events)).toEqual([{ level: "error", code: USAGE_NOTICES.dayLimit }]);
    }));

  it("alerts only: crossing the limit holds nothing and parks nothing", () =>
    withTempDir(async (dir) => {
      const { t, a } = await twoOffices(dir);
      const { instance } = alerts(t, { dayTokens: 100, monthTokens: 100 });
      const before = a.get<{ n: number }>(
        "select count(*) as n from runs where office_id = $office_id",
      );
      instance.check();
      expect(
        a.get<{ n: number }>("select count(*) as n from runs where office_id = $office_id"),
      ).toEqual(before);
      const rows = t.state.connection.all<{ code: string }>(
        "select code from once_notices order by code",
      );
      expect(rows.map((row) => row.code.split(":")[0])).toEqual([
        USAGE_NOTICES.dayLimit,
        USAGE_NOTICES.monthLimit,
      ]);
    }));

  it("raises nothing without a limit", () =>
    withTempDir(async (dir) => {
      const { t } = await twoOffices(dir);
      const { instance, events } = alerts(t, {});
      instance.check();
      expect(notices(events)).toEqual([]);
    }));
});
