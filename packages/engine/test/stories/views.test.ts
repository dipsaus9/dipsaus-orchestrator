// The minimal story view and office summary (DIPO-32; 0005 sections 5 and 7, 0009 section 3): a
// column from the lifecycle alone, counts per column, active runs, and the summary source that
// `engine.hello` answers with.

import { describe, expect, it } from "bun:test";

import {
  CONTRACT_VERSION,
  LIFECYCLES,
  OfficeSummary,
  RequestId,
  StoryId,
  StoryKey,
  StoryView,
  StreamName,
} from "@dipsaus-orchestrator/contract";

import { type OfficeDirectory, officeUnknown } from "../../src/commands/offices";
import { buildRegistry } from "../../src/commands/registry";
import { executeRead } from "../../src/reads/execute";
import { helloFeature } from "../../src/reads/hello";
import {
  columnCounts,
  columnOf,
  deriveOfficeSummary,
  deriveStoryView,
  lifecycleOf,
  officeSummaries,
  officeSummarySource,
} from "../../src/views";
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
      // Active runs (DIPO-52): runs that have not ended; session runs need no claim.
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
        running: 1,
        parked: 1,
        onHold: 0,
        waitingOnMaintainer: 1,
      });
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
          softwareCursor: () => ({ stream: StreamName.parse("software"), epoch: "e", seq: 0 }),
          officeSummaries: source,
        }),
      ]);
      const reply = await executeRead(
        { registry, offices: noOffices, clock: t.clock },
        {
          requestId: RequestId.parse("01J9ZK5Q8W3V4X6Y7Z00000001"),
          name: "engine.hello",
          args: { contract: { ...CONTRACT_VERSION }, client: { name: "test", version: "0" } },
        },
      );
      expect(reply).toMatchObject({ ok: true, result: { offices: source() } });
    }));
});
