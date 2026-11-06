// The minimal story view and office summary (DIPO-32; 0005, 0009): a
// column from the lifecycle alone, counts per column, active runs, and the summary source that
// `engine.hello` answers with.

import { describe, expect, it } from "bun:test";

import {
  LIFECYCLES,
  OfficeSummary,
  RequestId,
  StoryId,
  StoryKey,
  StoryView,
  StreamName,
} from "@dipsaus-orchestrator/contract";

import { type OfficeDirectory, officeUnknown } from "../../src/commands/offices";
import { OFFICE_DEFAULTS } from "../../src/config";
import { buildRegistry } from "../../src/commands/registry";
import { executeRead } from "../../src/reads/execute";
import { helloFeature } from "../../src/reads/hello";
import {
  columnCounts,
  deriveOfficeSummary,
  officeSummaries,
  officeSummaryOfSource,
  officeSummarySource,
  summarySettings,
} from "../../src/overview";
import { columnOf, deriveStoryView, lifecycleOf } from "../../src/views";
import { addOffice } from "../commands/helpers";
import { draft, pass, task, withOffice } from "./helpers";

const noOffices: OfficeDirectory = {
  get: () => undefined,
  load: async (office) => ({ ok: false, error: officeUnknown(office) }),
};

const KEY = StoryKey.parse("sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D");

describe("minimal story view", () => {
  it("takes the column from the lifecycle alone", () => {
    expect(
      Object.fromEntries(LIFECYCLES.map((lifecycle) => [lifecycle, columnOf(lifecycle)])),
    ).toEqual({
      Draft: "draft",
      Refined: "refined",
      Ready: "ready",
      "In Progress": "running",
      "In Review": "review",
      Done: "done",
      Parked: "desk",
      Removed: "removed",
    });
  });

  it("derives a contract StoryView for every lifecycle", () => {
    for (const lifecycle of LIFECYCLES) {
      const view = deriveStoryView({
        key: KEY,
        story: StoryId.parse("DIPO-7"),
        title: "Seven",
        lifecycle,
        tier: "M",
      });
      expect(StoryView.parse(view)).toEqual(view);
      expect(view).toEqual({
        key: KEY,
        story: StoryId.parse("DIPO-7"),
        provisional: false,
        title: "Seven",
        lifecycle,
        tier: "M",
        column: columnOf(lifecycle),
      });
    }
    expect(
      deriveStoryView({ key: KEY, story: StoryId.parse("DRAFT-2"), title: "", lifecycle: "Draft" }),
    ).toEqual({
      key: KEY,
      story: StoryId.parse("DRAFT-2"),
      provisional: true,
      title: "",
      lifecycle: "Draft",
      column: "draft",
    });
  });

  it("reads drafts as Draft and To Do or unknown task statuses as Refined", () => {
    expect(lifecycleOf("draft", "Ready")).toBe("Draft");
    expect(lifecycleOf("task", "In Review")).toBe("In Review");
    expect(lifecycleOf("task", "To Do")).toBe("Refined");
    expect(lifecycleOf("task", "Blocked")).toBe("Refined");
  });
});

describe("office summary", () => {
  it("counts the stories per column and leaves removed ones out", () =>
    withOffice((t, office) => {
      pass(t, office, [
        draft("DRAFT-1"),
        task("TASK-1", { status: "Ready" }),
        task("TASK-2", { status: "Ready" }),
        task("TASK-3", { status: "In Progress" }),
        task("TASK-4", { status: "In Review" }),
        task("TASK-5", { status: "Parked" }),
        task("TASK-6", { status: "Done" }),
        task("TASK-7"),
      ]);
      expect(columnCounts(office)).toEqual({
        draft: 1,
        refined: 1,
        ready: 2,
        running: 1,
        review: 1,
        desk: 1,
        done: 1,
      });
      pass(t, office, [task("TASK-1", { status: "Ready" })]);
      expect(columnCounts(office)).toEqual({ ready: 1 });
    }));

  it("reports active runs, parked and waiting on the maintainer", () =>
    withOffice((t, office) => {
      pass(t, office, [
        task("TASK-1", { status: "Parked" }),
        task("TASK-2", { status: "In Progress" }),
      ]);
      // Session runs hold no run slot: they count as `sessions`, not as running (DIPO-446).
      office.immediate(() => {
        for (const [run, ended] of [
          ["run_1", null],
          ["run_2", 5],
        ] as const) {
          office.run(
            `insert into runs (office_id, run_id, kind, role, model, budget_unit, budget_limit,
               loop_cap, config_hash, started_at, ended_at)
             values ($office_id, $run, 'session', 'developer', 'haiku', 'tokens', 1, 1, 'h', 0, $ended)`,
            { run, ended },
          );
        }
      });
      const summary = deriveOfficeSummary(
        { office: office.officeId, name: "demo", path: "/repos/demo" },
        office,
      );
      expect(OfficeSummary.parse(summary)).toEqual(summary);
      expect(summary).toEqual({
        office: office.officeId,
        name: "demo",
        path: "/repos/demo",
        running: 0,
        sessions: 1,
        parked: 1,
        waitingOnMaintainer: 1,
        ready: 0,
      });
    }));

  it("counts no running story for an ended run while a worker host of it is still open (DIPO-446)", () =>
    withOffice((_t, office) => {
      const host = (run: string, agent: string, pending: 0 | 1) =>
        office.run(
          `insert into worker_hosts (office_id, run_id, agent_id, pid, start_time_ms, socket_path,
             protocol_version, run_dir, event_file, started_at, pending)
           values ($office_id, $run, $agent, 4242, 1, '/s', 3, '/d', '/e', 0, $pending)`,
          { run, agent, pending },
        );
      office.immediate(() => {
        office.run(
          `insert into runs (office_id, run_id, kind, role, model, budget_unit, budget_limit,
             loop_cap, config_hash, started_at, ended_at)
           values ($office_id, 'run_2', 'session', 'developer', 'haiku', 'tokens', 1, 1, 'h', 0, 5)`,
        );
        // An ended run holds no run slot, so its open hosts count nothing (keep-awake still does).
        host("run_2", "agent-1", 0);
        host("run_2", "agent-2", 0);
        host("run_3", "agent-3", 1);
      });
      const running = () =>
        deriveOfficeSummary({ office: office.officeId, name: "demo", path: "/repos/demo" }, office)
          .running;
      expect(running()).toBe(0);
      office.immediate(() =>
        office.run("update worker_hosts set ended_at = 6 where office_id = $office_id"),
      );
      expect(running()).toBe(0);
    }));

  it("names the privacy opt-ins that are on, and leaves the field out when none is (DIPO-83)", () =>
    withOffice(async (t, office) => {
      const on = ["privacy.storeCommandBodies"];
      const settingsOf = (id: string) => ({ optIns: id === office.officeId ? on : [] });
      const summary = officeSummaryOfSource(() => t.state, settingsOf)(office.officeId);
      expect(summary?.optIns).toEqual(on);
      expect(OfficeSummary.parse(summary)).toEqual(summary as OfficeSummary);
      expect(officeSummarySource(() => t.state, settingsOf)()[0]?.optIns).toEqual(on);
      expect(officeSummaryOfSource(() => t.state)(office.officeId)).not.toHaveProperty("optIns");
    }));

  it("names each privacy setting with its value and source (DIPO-136)", () =>
    withOffice(async (t, office) => {
      const config = {
        ...OFFICE_DEFAULTS,
        privacy: { storePrompts: true, storeCommandBodies: false, keepRawEvents: false },
      };
      const settingsOf = () => summarySettings(config, ["privacy.storeCommandBodies"]);
      const summary = officeSummaryOfSource(() => t.state, settingsOf)(office.officeId);
      expect(summary?.privacy).toEqual([
        { key: "privacy.storePrompts", value: true, source: "default" },
        { key: "privacy.storeCommandBodies", value: false, source: "office.local.yaml" },
        { key: "privacy.keepRawEvents", value: false, source: "default" },
      ]);
      expect(OfficeSummary.parse(summary)).toEqual(summary as OfficeSummary);
      const without = officeSummaryOfSource(() => t.state)(office.officeId);
      expect(without).not.toHaveProperty("privacy");
    }));

  it("sends the office's stored-output retention period, absent without a config (DIPO-97)", () =>
    withOffice(async (t, office) => {
      const config = { ...OFFICE_DEFAULTS, retention: { days: 3 } };
      const settingsOf = () => summarySettings(config);
      const summary = officeSummaryOfSource(() => t.state, settingsOf)(office.officeId);
      expect(summary?.outputRetentionDays).toBe(3);
      expect(OfficeSummary.parse(summary)).toEqual(summary as OfficeSummary);
      expect(officeSummarySource(() => t.state, settingsOf)()[0]?.outputRetentionDays).toBe(3);
      expect(summarySettings(undefined)).toEqual({ optIns: [] });
      const without = officeSummaryOfSource(() => t.state)(office.officeId);
      expect(without).not.toHaveProperty("outputRetentionDays");
    }));

  it("counts the Ready column as ready (DIPO-81)", () =>
    withOffice((t, office) => {
      pass(t, office, [
        task("TASK-1", { status: "Ready" }),
        task("TASK-2", { status: "Ready" }),
        task("TASK-3", { status: "In Progress" }),
      ]);
      const summary = deriveOfficeSummary(
        { office: office.officeId, name: "demo", path: "/repos/demo" },
        office,
      );
      expect(summary.ready).toBe(2);
      expect(summary.ready).toBe(columnCounts(office).ready);
    }));

  it("is the source engine.hello answers with, for every listed office", () =>
    withOffice(async (t, office) => {
      pass(t, office, [task("TASK-1", { status: "Parked" })]);
      const other = addOffice(t, "second");
      t.state.connection.immediate(() =>
        t.state.connection.run("update offices set forgotten_at = 1 where office_id = $office", {
          office: other.officeId,
        }),
      );
      const source = officeSummarySource(() => t.state);
      expect(source()).toEqual(officeSummaries(t.state));
      expect(source().map((summary) => [summary.office, summary.parked])).toEqual([
        [office.officeId, 1],
      ]);
      expect(officeSummarySource(() => null)()).toEqual([]);

      const registry = buildRegistry([
        helloFeature({
          engineVersion: "0.0.0-test",
          daemonState: () => "running",
          softwareCursor: () => ({ stream: StreamName.parse("software"), seq: 0 }),
          officeSummaries: source,
        }),
      ]);
      const reply = await executeRead(
        { registry, offices: noOffices, clock: t.clock },
        {
          requestId: RequestId.parse("01J9ZK5Q8W3V4X6Y7Z00000001"),
          name: "engine.hello",
          args: { client: { name: "test", version: "0" } },
        },
      );
      expect(reply).toMatchObject({ ok: true, result: { offices: source() } });
    }));
});
