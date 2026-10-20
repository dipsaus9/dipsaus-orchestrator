// The daemon's Backlog CLI (DIPO-74 AC #8): the absolute `backlog` resolved on the daemon's PATH
// at start is what `backlogFeature` runs, next to the resolved `claude` the run launcher plans
// with; without one, `backlog` is looked up on PATH as before.

import { describe, expect, it } from "bun:test";

import type { OfficeId, SpawnOptions } from "@dipsaus-orchestrator/contract";
import {
  engineFeatures,
  engineRegistry,
  OFFICE_DEFAULTS,
  type OfficeHandle,
  type ParseState,
  type StoredRun,
  type WorkerSpec,
} from "@dipsaus-orchestrator/engine";
import { FakeProcess, ManualClock, SequentialIds } from "@dipsaus-orchestrator/testkit";

import { backlogCliFor, startedSessionState } from "../../src/runs";

const BACKLOG = "/opt/tools/bin/backlog";

function notStarted(): never {
  throw new Error("not started here");
}

describe("the daemon's Backlog CLI", () => {
  it("runs the backlog the daemon resolved, by absolute path", () => {
    expect(
      backlogCliFor({ backlog: BACKLOG, claude: "/opt/tools/bin/claude" }, notStarted),
    ).toEqual({ spawn: notStarted, command: [BACKLOG] });
    expect(backlogCliFor({}, notStarted)).toEqual({ spawn: notStarted });
  });

  it("is what the backlog.version load step of the engine features runs", async () => {
    const clock = new ManualClock();
    const calls: SpawnOptions[] = [];
    const spawn = (options: SpawnOptions) => {
      calls.push(options);
      return new FakeProcess({
        lines: [
          { t: 1, ch: "stdout", data: "1.53.0\n" },
          { t: 2, ch: "exit", data: { code: 0, signal: null } },
        ],
        clock,
      });
    };
    const registry = engineRegistry(
      engineFeatures({ backlog: backlogCliFor({ backlog: BACKLOG }, spawn) }),
    );
    const step = registry.loadSteps().find((entry) => entry.name === "backlog.version");
    expect(step).toBeDefined();
    const result = await step?.run({
      officeId: "off_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D" as OfficeId,
      office: undefined as unknown as OfficeHandle,
      path: "/work/app",
      commonDir: "/work/app/.git",
      config: undefined,
      clock,
      ids: new SequentialIds(),
    });
    expect(result).toEqual({ ok: true });
    expect(calls.map((call) => call.cmd)).toEqual([[BACKLOG, "--version"]]);
  });
});

describe("a re-attached session's initial state (DIPO-207)", () => {
  const run = { runId: "run_1", model: "haiku", tier: "M" } as unknown as StoredRun;
  // The office's tier M was edited after the run started: another model, effort high.
  const edited = { ...OFFICE_DEFAULTS.tiers.M, model: "opus", effort: "high" };
  const paths = { runDir: "/run", workdir: "/work" } as unknown as Parameters<
    typeof startedSessionState
  >[5];

  function stateWith(startEffort: string | null) {
    const specs: WorkerSpec[] = [];
    const handle = {
      get: () => (startEffort === null ? { effort: null } : { effort: startEffort }),
    } as unknown as OfficeHandle;
    const worker = {
      reportSchema: {},
      initialState: (spec: WorkerSpec) => {
        specs.push(spec);
        return {} as ParseState;
      },
    } as unknown as Parameters<typeof startedSessionState>[0];
    startedSessionState(worker, handle, run, "agt_2", edited, paths, true);
    return specs[0];
  }

  it("is built with the model and effort the run started with", () => {
    const spec = stateWith("medium");
    expect(spec?.model).toBe("haiku");
    expect(spec?.effort).toBe("medium");
  });

  it("falls back to the effort of the tier in force without a recorded start effort", () => {
    const spec = stateWith(null);
    expect(spec?.model).toBe("haiku");
    expect(spec?.effort).toBe("high");
  });
});
