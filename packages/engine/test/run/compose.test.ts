// The run services have one wiring (DIPO-129): `composeRuns` builds them from injected ports. These
// tests call it with fake ports on a migrated state database and check the wiring itself: which
// services exist for which ports, and that a worker's lost host reaches worker outcomes and then
// `afterExit`. A source check keeps the daemon and the run tests from constructing them by hand.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { StoryId } from "@dipsaus-orchestrator/contract";

import { Nudges } from "../../src/hooks/nudges";
import { PermissionAsks } from "../../src/hooks/permissions";
import {
  activeSignals,
  composeRuns,
  insertRun,
  OfficeIngest,
  PlanLimits,
  RunControl,
  RunLauncher,
  RunOutcomes,
  type RunPorts,
  RunReattacher,
  RunResumer,
} from "../../src/run";
import { addStory } from "../../src/stories/keys";
import { encode } from "../../src/workers/claude-cli/encode";
import type { WorkerPort } from "../../src/workers/port";
import type { Caps } from "../../src/workers/types";
import { type IngestFixture, ingestFixture } from "../ingest/helpers";

const ROOMY: Caps = { budgetTokens: 1_000_000, maxTurns: 100, maxMinutes: 30 };

// Only `encode` and `id` are read on the paths these tests take.
const WORKER = {
  id: "claude-cli",
  encode,
  result: () => {
    throw new Error("no worker result is read here");
  },
} as unknown as WorkerPort;

let dir: string;
let f: IngestFixture;
const closers: (() => void)[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "compose-"));
  f = await ingestFixture(dir);
});

afterEach(() => {
  for (const close of closers.splice(0)) close();
  f.t.state.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The ports every wiring has; `extra` adds the optional services. */
function portsOf(extra: Partial<RunPorts> = {}): RunPorts {
  return {
    clock: f.t.clock,
    ids: f.t.ids,
    offices: { get: () => f.office, config: () => undefined },
    worker: WORKER,
    steering: { send: async () => ({ ok: true }) },
    hosts: {
      start: async () => {
        throw new Error("no host starts here");
      },
    },
    git: () => undefined,
    base: {
      read: async () => {
        throw new Error("no story is read here");
      },
    },
    runtimeDir: join(dir, "rt"),
    tmpRoot: join(dir, "tmp"),
    release: async () => undefined,
    setup: async () => {
      throw new Error("no setup runs here");
    },
    ingest: { pricing: () => null },
    ...extra,
  };
}

const CONTROL: NonNullable<RunPorts["control"]> = {
  writer: {
    write: async () => {
      throw new Error("no park is written here");
    },
  },
};

const REATTACH: NonNullable<RunPorts["reattach"]> = {
  probe: async () => null,
  steering: { send: async () => ({ ok: true }) },
  adapter: () => null,
  initialState: () => ({}),
  caps: () => null,
};

function compose(extra: Partial<RunPorts> = {}) {
  const composed = composeRuns(portsOf(extra));
  closers.push(() => {
    composed.planLimits?.close();
    composed.permissions.close();
    composed.control?.close();
    composed.ingest.close();
  });
  return composed;
}

/** The fixture's run, stored as a claimed story run that has not ended. */
function storeRun(): void {
  const { office } = f;
  const { key } = office.immediate(() =>
    addStory(office, f.t.ids, { story: StoryId.parse("DIPO-1") }, f.t.clock.now()),
  );
  office.immediate(() => {
    insertRun(office, {
      runId: f.run,
      kind: "story",
      key,
      story: "DIPO-1",
      tier: "M",
      role: "developer",
      model: "haiku",
      startSha: "b".repeat(40),
      branch: "DIPO-1/add-a-greeting",
      worktree: join(dir, "trees", "DIPO-1"),
      slot: 1,
      budgetUnit: "tokens",
      budgetLimit: ROOMY.budgetTokens,
      loopCap: 3,
      reviewRoundCap: null,
      configHash: "h",
      overrideKeys: null,
      runProfileId: null,
      startedAt: f.t.clock.now(),
    });
  });
  f = { ...f, work: { ...f.work, key } };
}

/** Tracks the stored run in `control` and reports its host lost, as re-attach does. */
async function loseHost(composed: ReturnType<typeof compose>): Promise<void> {
  const control = composed.control;
  if (control === null) throw new Error("run control was not built");
  control.track(f.office.officeId, {
    runId: f.run,
    work: f.work,
    caps: ROOMY,
    startedAt: f.t.clock.now(),
  });
  control.onHostLost(f.run, f.agent);
  await control.idle();
  await composed.resumption?.idle();
}

describe("composeRuns", () => {
  test("without control builds only ingestion, the permission wait, the nudges and the launcher", () => {
    const composed = compose({ outcomes: {}, planLimits: {}, reattach: REATTACH });
    expect(composed.ingest).toBeInstanceOf(OfficeIngest);
    expect(composed.permissions).toBeInstanceOf(PermissionAsks);
    expect(composed.nudges).toBeInstanceOf(Nudges);
    expect(composed.launcher).toBeInstanceOf(RunLauncher);
    // Outcomes, the plan-limit schedule and re-attach need run control.
    expect(composed.control).toBeNull();
    expect(composed.outcomes).toBeNull();
    expect(composed.resumer).toBeNull();
    expect(composed.planLimits).toBeNull();
    expect(composed.reattacher).toBeNull();
  });

  test("builds each service only when its ports are given", () => {
    const controlOnly = compose({ control: CONTROL });
    expect(controlOnly.control).toBeInstanceOf(RunControl);
    expect(controlOnly.outcomes).toBeNull();
    expect(controlOnly.resumer).toBeNull();
    expect(controlOnly.reattacher).toBeNull();

    const noSchedule = compose({ control: CONTROL, outcomes: {} });
    expect(noSchedule.outcomes).toBeInstanceOf(RunOutcomes);
    expect(noSchedule.resumer).toBeInstanceOf(RunResumer);
    expect(noSchedule.planLimits).toBeNull();

    const all = compose({ control: CONTROL, outcomes: {}, planLimits: {}, reattach: REATTACH });
    expect(all.planLimits).toBeInstanceOf(PlanLimits);
    expect(all.reattacher).toBeInstanceOf(RunReattacher);
  });

  test("a lost worker host reaches worker outcomes, then afterExit", async () => {
    storeRun();
    // The signals worker outcomes had raised on the run when `afterExit` ran.
    const atAfterExit: string[][] = [];
    const composed = compose({
      control: CONTROL,
      outcomes: {},
      afterExit: () => {
        atAfterExit.push(activeSignals(f.office, f.run).map((s) => s.signal));
      },
    });

    await loseHost(composed);

    // Outcomes raised `host-lost` before `afterExit` ran, and it ran once.
    expect(atAfterExit).toEqual([["host-lost"]]);
  });

  test("without outcomes a lost host decides nothing", async () => {
    storeRun();
    const composed = compose({ control: CONTROL });

    await loseHost(composed);

    expect(activeSignals(f.office, f.run)).toEqual([]);
  });
});

// The daemon and the run tests build the run services only through `composeRuns`.
const ROOT = join(import.meta.dir, "..", "..", "..");
const SITES = [
  join(ROOT, "daemon", "src", "runs.ts"),
  join(ROOT, "engine", "test", "run", "run-office.ts"),
];
const BUILT_BY_COMPOSE = [
  "RunLauncher",
  "RunResumer",
  "RunControl",
  "RunOutcomes",
  "RunReattacher",
  "OfficeIngest",
  "PermissionAsks",
  "Nudges",
  "PlanLimits",
];

describe("the run service wiring sites", () => {
  for (const site of SITES) {
    test(`${site.slice(ROOT.length + 1)} builds the run services through composeRuns`, () => {
      const source = readFileSync(site, "utf8");
      expect(source).toContain("composeRuns(");
      for (const name of BUILT_BY_COMPOSE) {
        expect(source).not.toMatch(new RegExp(`new ${name}\\(`));
      }
    });
  }
});
