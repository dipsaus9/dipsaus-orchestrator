// The run services have one wiring (DIPO-129): `composeRuns` builds them from injected ports. These
// tests call it with fake ports on a migrated state database and check the wiring itself: which
// services exist for which ports, and that a worker's lost host reaches worker outcomes and then
// `afterExit`. A source check keeps the engine factory and the run tests from constructing them by
// hand.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { StoryId } from "@dipsaus-orchestrator/contract";

import { PermissionAsks } from "../../src/questions/permissions";
import {
  FixRounds,
  pendingReviews,
  OfficeIngest,
  StartsPaused,
  RunControl,
  RunLauncher,
  RunOutcomes,
  RunReattacher,
  RunResumer,
  Reviews,
} from "../../src/run";
import { composeRuns, type RunPorts } from "../../src/create/compose";
import { stopAtInReview } from "../../src/run-state";
import { insertRun } from "../../src/records";
import { insertClaim, updateClaim } from "../../src/worktree/records";
import { addStory } from "../../src/records/story-keys";
import { encode } from "../../src/workers/claude-cli/encode";
import type { WorkerPort } from "../../src/workers/port";
import type { Caps } from "../../src/workers/types";
import { type IngestFixture, ingestFixture } from "../ingest/helpers";
import { backlogLayout } from "../story-store/backlog";

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
    stories: backlogLayout,
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
    ingest: {},
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
  signal: () => false,
  adapter: () => null,
  initialState: () => ({}),
  caps: () => null,
};

function compose(extra: Partial<RunPorts> = {}) {
  const composed = composeRuns(portsOf(extra));
  closers.push(() => {
    composed.startsPaused?.close();
    composed.permissions.close();
    composed.control?.close();
    composed.ingest.close();
  });
  return composed;
}

/** The fixture's run, stored as a claimed story run that has not ended. */
function storeRun(reviewRoundCap: number | null = null): void {
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
      budgetUnit: "tokens",
      budgetLimit: ROOMY.budgetTokens,
      loopCap: 3,
      reviewRoundCap,
      configHash: "h",
      overrideKeys: null,
      runProfileId: null,
      startedAt: f.t.clock.now(),
    });
  });
  f = { ...f, work: { ...f.work, key } };
}

describe("composeRuns", () => {
  test("without control builds only ingestion, the live question rule and the launcher", () => {
    const composed = compose({ outcomes: {}, startsPaused: {}, reattach: REATTACH });
    expect(composed.ingest).toBeInstanceOf(OfficeIngest);
    expect(composed.permissions).toBeInstanceOf(PermissionAsks);
    expect(composed.launcher).toBeInstanceOf(RunLauncher);
    // Outcomes, the office's starts paused and re-attach need run control.
    expect(composed.control).toBeNull();
    expect(composed.outcomes).toBeNull();
    expect(composed.resumer).toBeNull();
    expect(composed.startsPaused).toBeNull();
    expect(composed.reattacher).toBeNull();
  });

  test("builds each service only when its ports are given", () => {
    const controlOnly = compose({ control: CONTROL });
    expect(controlOnly.control).toBeInstanceOf(RunControl);
    expect(controlOnly.outcomes).toBeNull();
    expect(controlOnly.resumer).toBeNull();
    expect(controlOnly.reattacher).toBeNull();
    expect(controlOnly.fixRounds).toBeNull();

    const noSchedule = compose({ control: CONTROL, outcomes: {} });
    expect(noSchedule.outcomes).toBeInstanceOf(RunOutcomes);
    expect(noSchedule.resumer).toBeInstanceOf(RunResumer);
    expect(noSchedule.startsPaused).toBeNull();
    // The fix rounds continue a developer session through worker outcomes (DIPO-148).
    expect(noSchedule.fixRounds).toBeInstanceOf(FixRounds);

    const all = compose({ control: CONTROL, outcomes: {}, startsPaused: {}, reattach: REATTACH });
    expect(all.startsPaused).toBeInstanceOf(StartsPaused);
    expect(all.reattacher).toBeInstanceOf(RunReattacher);
  });

  test("feeds the pending reviews to the review starter in the reviewer place (DIPO-219)", async () => {
    storeRun(3);
    const { office } = f;
    office.immediate(() => {
      insertClaim(office, {
        runId: f.run,
        key: f.work.key,
        story: "DIPO-1",
        branch: "DIPO-1/add-a-greeting",
        base: "main",
        baseSha: "b".repeat(40),
        startSha: "b".repeat(40),
        claimSha: "d".repeat(40),
        reused: false,
        claimedAt: f.t.clock.now(),
      });
      stopAtInReview(office, f.run, f.t.clock.now());
      // Its In Review push reached the remote (DIPO-315).
      updateClaim(office, f.run, { pushedAt: f.t.clock.now() });
    });
    const warned: string[] = [];
    const composed = compose({
      control: CONTROL,
      outcomes: {},
      warn: (message) => warned.push(message),
    });
    expect(composed.reviews).toBeInstanceOf(Reviews);
    expect(pendingReviews(backlogLayout, office).map((start) => start.runId)).toEqual([f.run]);

    // The starter reads the story first; this wiring reads none, so the review waits.
    expect(await composed.places?.drain(office.officeId)).toBe(0);
    expect(warned).toContain("reading a story before its review failed; the review waits");
    composed.places?.close();
  });
});

// The engine factory and the run tests build the run services only through `composeRuns`.
const ROOT = join(import.meta.dir, "..", "..", "..");
const SITES = [
  join(ROOT, "engine", "src", "create", "runs.ts"),
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
  "WebCalls",
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

describe("the reviewer boxes (0002, DIPO-347)", () => {
  test("reach each review session through the engine's box workers", () => {
    const source = readFileSync(join(ROOT, "engine", "src", "create", "compose.ts"), "utf8");
    expect(source).toContain('...given("boxes", ports.reviewBoxes),');
    const factory = readFileSync(join(ROOT, "engine", "src", "create", "runs.ts"), "utf8");
    expect(factory).toContain("reviewBoxes: boxWorkers");
  });
});
