// Plan-limit waits (DIPO-61), fast and local, on the manual clock: the 0017 scenarios
// `plan-limit-rejected` (a committed recording), `plan-limit-credits` and `api-retry-rate-limit`
// (the adapter's events, as interpret.test.ts reads them), with a restart between the reject and
// the reset. A migrated state database with one claimed story run, the real DIPO-45 ingestion with
// run control as its hooks, worker outcomes and the plan-limit schedule wired in, and the run's
// next session stubbed as the real resumer records it (a new agent, the named signals cleared).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  type AgentId,
  type OfficeId,
  StoryId,
  type RunId,
  type WorkRef,
} from "@dipsaus-orchestrator/contract";
import { readRecording } from "@dipsaus-orchestrator/testkit";

import type { AsyncCommandContext, CommandContext } from "../../src/commands/registry";
import { CommandError } from "../../src/commands/errors";
import type { OfficeConfig } from "../../src/config";
import { type IngestAdapter, Ingestor } from "../../src/ingest/ingestor";
import {
  type BranchPark,
  findRun,
  inFamily,
  insertRun,
  type NextSessionRequest,
  openWait,
  PLAN_LIMIT_PROBE_MS,
  PLAN_LIMIT_RESUME_AFTER_MS,
  PLAN_LIMIT_RETRY_MS,
  PlanLimits,
  RunControl,
  createRunOutcomes,
  type Resumption,
  type RunOutcomes,
  scopeHolds,
  wakeAt,
} from "../../src/run";
import { allowLimits, readLimits } from "../../src/run/plan-allowance";
import { clearSignals } from "../../src/run/signals";
import { addStory } from "../../src/stories/keys";
import { workView } from "../../src/views/work";
import { encode } from "../../src/workers/claude-cli/encode";
import {
  type ClaudeParseState,
  initialState,
  interpret,
} from "../../src/workers/claude-cli/interpret";
import { result as claudeResult } from "../../src/workers/claude-cli/result";
import type { AdapterHold, HoldNotice } from "../../src/workers/hold";
import type { Caps, ParseState, WorkerEvent } from "../../src/workers/types";
import { insertClaim } from "../../src/worktree/records";
import {
  appendLines,
  hostLines,
  type IngestFixture,
  ingestFixture,
  target,
} from "../ingest/helpers";
import { RECORDINGS_DIR } from "../workers/replay";

const claude: IngestAdapter = {
  interpret: (line, state) =>
    interpret(line, state as unknown as ClaudeParseState) as unknown as {
      events: [];
      state: ParseState;
    },
};

const ROOMY: Caps = { budgetTokens: 1_000_000, maxTurns: 100, maxMinutes: 30 };
const ADAPTER = "claude-cli";
const CONFIG = { worker: { adapter: ADAPTER } } as unknown as OfficeConfig;
/** `resetsAt` of the committed `plan-limit-rejected` recording. */
const RECORDED_RESET = 1_791_827_400 * 1000;

interface World {
  readonly dir: string;
  readonly f: IngestFixture;
  readonly control: RunControl;
  readonly outcomes: RunOutcomes;
  readonly resumption: Resumption;
  plans: PlanLimits;
  readonly next: NextSessionRequest[];
  readonly notices: HoldNotice[];
  readonly lifted: string[];
  readonly work: WorkRef;
  hold: AdapterHold | null;
  scheduling: boolean;
  ingestor: Ingestor | null;
  /** The office was forgotten: `offices.get` answers undefined. */
  officeGone: boolean;
  /** The office has no configuration, so no adapter. */
  unconfigured: boolean;
  readonly logged: string[];
}

let w: World;

function planLimits(): PlanLimits {
  return new PlanLimits({
    clock: w.f.t.clock,
    offices: {
      get: () => (w.officeGone ? undefined : w.f.office),
      config: () => (w.unconfigured ? undefined : CONFIG),
    },
    warn: (message) => w.logged.push(message),
    resume: (office, run, why) => w.resumption.resumeWait(office, run, why),
    scheduling: () => w.scheduling,
    holds: {
      adapterHeld: () => w.hold,
      lift: (adapter) => {
        w.lifted.push(adapter);
        w.hold = null;
        return true;
      },
    },
    notify: (notice) => w.notices.push(notice),
    commands: w.resumption.feature,
  });
}

beforeEach(async () => {
  const dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "plan-limit-"));
  const f = await ingestFixture(dir);
  const world = {
    dir,
    f,
    next: [],
    notices: [],
    lifted: [],
    hold: null,
    scheduling: true,
    ingestor: null,
    officeGone: false,
    unconfigured: false,
    logged: [],
  } as unknown as World;
  const steering = { send: async () => ({ ok: true as const }) };
  let outcomes: RunOutcomes | null = null;
  const control = new RunControl({
    clock: f.t.clock,
    offices: { get: () => f.office },
    writer: {
      write: async (): Promise<BranchPark> => ({
        commit: "c".repeat(40),
        lastGoodCommit: "a".repeat(40),
        from: "In Progress",
        pushed: true,
        pushError: null,
      }),
    },
    steering,
    encode,
    outcomes: () => outcomes ?? undefined,
  });
  const built = createRunOutcomes(
    {
      clock: f.t.clock,
      offices: { get: () => f.office },
      steering,
      encode,
      worker: {
        id: ADAPTER,
        result: (state, exit) => claudeResult(state as unknown as ClaudeParseState, exit),
      },
      ender: () => control,
      // The next session as the real resumer records it: a new agent, the named signals cleared.
      resumer: {
        next: async (request) => {
          world.next.push(request);
          const at = f.t.clock.now();
          f.office.immediate(() => {
            f.office.run(
              `insert into agents (office_id, agent_id, run_id, role, model, started_at)
             values ($office_id, $agent, $run, 'developer', 'haiku', $at)`,
              { agent: f.t.ids.next("agt"), run: f.run, at: at + 1 },
            );
            clearSignals(f.office, f.run, request.clear ?? [], at);
            request.inRecord?.("agt_next" as AgentId, at);
          });
          return { kind: "started", agent: "agt_next" as AgentId, resumed: true };
        },
      },
      holds: {
        hold: (adapter, failures) => {
          world.hold = {
            adapter,
            check: failures[0]?.check ?? "",
            detail: failures[0]?.detail ?? "",
            failures,
            since: 0,
          };
          return world.hold;
        },
      },
      caps: () => ROOMY,
      waits: () => world.plans,
    },
    { planLimits: () => world.plans },
  );
  outcomes = built.outcomes;
  Object.assign(world, { control, outcomes, resumption: built.resumption });
  w = world;
  w.plans = planLimits();
  const { office, run } = f;
  const { key } = office.immediate(() =>
    addStory(office, f.t.ids, { story: StoryId.parse("DIPO-1") }, f.t.clock.now()),
  );
  (world as { work: WorkRef }).work = { ...f.work, key };
  office.immediate(() => {
    insertRun(office, {
      runId: run,
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
    insertClaim(office, {
      runId: run,
      key,
      story: "DIPO-1",
      branch: "DIPO-1/add-a-greeting",
      worktree: join(dir, "trees", "DIPO-1"),
      base: "main",
      baseSha: "b".repeat(40),
      startSha: "b".repeat(40),
      claimSha: "d".repeat(40),
      reused: false,
      snapshot: { path: "/x", adminDir: "/x", commondir: "/x", gitdir: "/x", pointer: "/x" },
      firstFeedback: null,
      claimedAt: f.t.clock.now(),
    });
    // The run's first agent, as `work.run` records it.
    office.run(
      `insert into agents (office_id, agent_id, run_id, role, model, started_at)
       values ($office_id, $agent, $run, 'developer', 'haiku', $at)`,
      { agent: f.agent, run, at: f.t.clock.now() },
    );
  });
});

afterEach(() => {
  w.ingestor?.close();
  w.plans.close();
  w.control.close();
  w.f.t.state.close();
  rmSync(w.dir, { recursive: true, force: true });
});

function track(): void {
  w.control.track(w.f.office.officeId, {
    runId: w.f.run,
    work: w.work,
    caps: ROOMY,
    startedAt: w.f.t.clock.now(),
  });
}

/** Ingests a committed recording to its exit, then stops the ingestion's timers. */
async function ingestRecording(name: string): Promise<void> {
  track();
  appendLines(w.f.eventFile, hostLines(readRecording(join(RECORDINGS_DIR, name))));
  const ingestor = new Ingestor({
    office: w.f.office,
    clock: w.f.t.clock,
    pricing: null,
    hooks: w.control.hooks,
  });
  w.ingestor = ingestor;
  ingestor.track(
    target(w.f, claude, initialState({ plannedModel: "haiku" }) as unknown as ParseState, {
      budgetLimit: ROOMY.budgetTokens,
    }),
  );
  await w.control.idle();
  ingestor.close();
  w.ingestor = null;
}

/** The worker's events, as the adapter emits them, on a tracked run whose worker then exits. */
async function limitEvents(events: readonly WorkerEvent[], exit = true): Promise<void> {
  track();
  w.control.onWorkerEvents(w.f.run, events);
  await w.control.idle();
  if (!exit) return;
  endAgents();
  w.control.onEnded(w.f.run);
}

/** Every agent of the run exited (the worker closed after stdin). */
function endAgents(): void {
  w.f.office.immediate(() =>
    w.f.office.run(
      `update agents set ended_at = $at, end_reason = coalesce(end_reason, 'exited')
        where office_id = $office_id and run_id = $run and ended_at is null`,
      { at: w.f.t.clock.now(), run: w.f.run },
    ),
  );
}

async function advance(ms: number): Promise<void> {
  w.f.t.clock.advance(ms);
  await w.plans.idle();
}

async function advanceTo(at: number): Promise<void> {
  w.f.t.clock.advanceTo(at);
  await w.plans.idle();
}

const iso = (ms: number) => new Date(ms).toISOString();

function parks(): number {
  return (
    w.f.office.get<{ n: number }>("select count(*) as n from parks where office_id = $office_id")
      ?.n ?? 0
  );
}

/** The office's stored warning holds (migration 26). */
function storedWarnings(): { adapter: string; scope: string; until_at: number }[] {
  return w.f.office.all(
    `select adapter, scope, until_at from plan_limit_warnings where office_id = $office_id
     order by adapter, scope`,
  );
}

function expectActive(): void {
  expect(findRun(w.f.office, w.f.run)?.endedAt).toBeNull();
  expect(parks()).toBe(0);
}

function resumeCtx(): AsyncCommandContext {
  return {
    office: w.f.office,
    stories: { get: () => ({ story: "DIPO-1", key: w.work.key }) },
  } as unknown as AsyncCommandContext;
}

describe("the pure rules", () => {
  it("scopes of every model hold every model; a family only its own models", () => {
    for (const scope of ["session", "weekly", "unknown"] as const) {
      expect(scopeHolds(scope, null)).toBe(true);
      expect(scopeHolds(scope, "haiku")).toBe(true);
    }
    expect(scopeHolds("model:opus", null)).toBe(false);
    expect(scopeHolds("model:opus", "opus")).toBe(true);
    expect(scopeHolds("model:opus", "claude-opus-5")).toBe(true);
    expect(scopeHolds("model:opus", "sonnet")).toBe(false);
    expect(scopeHolds("credits", "opus")).toBe(false);
    expect(inFamily("claude-sonnet-5-5", "sonnet")).toBe(true);
  });

  it("wakes two minutes after resetsAt, else on the next whole hour after since; never for credits", () => {
    const since = 1_000_000;
    expect(wakeAt({ scope: "session", resetsAt: iso(5_000_000), since }, since)).toBe(
      5_000_000 + PLAN_LIMIT_RESUME_AFTER_MS,
    );
    expect(wakeAt({ scope: "unknown", since }, since)).toBe(since + PLAN_LIMIT_PROBE_MS);
    expect(wakeAt({ scope: "unknown", since }, since + 2.5 * PLAN_LIMIT_PROBE_MS)).toBe(
      since + 3 * PLAN_LIMIT_PROBE_MS,
    );
    expect(wakeAt({ scope: "credits", since }, since)).toBeNull();
  });
});

describe("plan-limit-rejected (AC #2, #3, #4)", () => {
  it("holds every office, then resumes the session with continue two minutes after resetsAt", async () => {
    await ingestRecording("plan-limit-rejected");
    expect(openWait(w.f.office, w.f.run)?.scope).toBe("session");
    // A session limit holds every run, of every model.
    expect(w.plans.held(ADAPTER, null)).toContain("the session limit");
    expect(w.plans.held(ADAPTER, "opus")).not.toBeNull();

    await advanceTo(RECORDED_RESET + PLAN_LIMIT_RESUME_AFTER_MS - 1);
    expect(w.next).toEqual([]);
    expectActive();
    await advance(1);
    expect(w.next.map((r) => [r.mode, r.message, r.clear, r.why])).toEqual([
      ["resume", "continue", ["plan-limit"], "the plan limit reset"],
    ]);
    // The resume ended the wait: the signal is cleared and nothing is held.
    expect(openWait(w.f.office, w.f.run)).toBeNull();
    expect(w.plans.held(ADAPTER, null)).toBeNull();
    expect(workView(w.f.office, w.f.run as RunId)?.health).not.toBe("limited");
    expectActive();
  });

  it("a restart between the reject and the reset rearms the wait from the stored fact (AC #6)", async () => {
    await ingestRecording("plan-limit-rejected");
    // The daemon stops: its timers and memory are gone; the wait fact is in the database.
    w.plans.close();
    w.plans = planLimits();
    expect(w.plans.held(ADAPTER, null)).toBeNull();
    expect(w.plans.recover(w.f.office.officeId, w.f.office)).toBe(1);
    expect(w.plans.held(ADAPTER, null)).not.toBeNull();
    await advanceTo(RECORDED_RESET + PLAN_LIMIT_RESUME_AFTER_MS);
    expect(w.next.map((r) => r.message)).toEqual(["continue"]);
  });

  it("a reset that passed while the daemon was down resumes at once after the load", async () => {
    await ingestRecording("plan-limit-rejected");
    w.plans.close();
    w.f.t.clock.advanceTo(RECORDED_RESET + 3 * PLAN_LIMIT_PROBE_MS);
    w.plans = planLimits();
    w.plans.recover(w.f.office.officeId, w.f.office);
    expect(w.next).toEqual([]);
    await advance(0);
    expect(w.next).toHaveLength(1);
  });

  it("while scheduling is off or the held worker has not exited, tries again a minute later", async () => {
    const reset = w.f.t.clock.now() + 10 * 60_000;
    await limitEvents(
      [{ t: "limit", status: "rejected", resetsAt: iso(reset), scope: "weekly" }],
      false,
    );
    w.scheduling = false;
    await advanceTo(reset + PLAN_LIMIT_RESUME_AFTER_MS);
    expect(w.next).toEqual([]);
    w.scheduling = true;
    // The worker has not exited yet: busy, again a minute later.
    await advance(PLAN_LIMIT_RETRY_MS);
    expect(w.next).toEqual([]);
    expect(w.plans.held(ADAPTER, null)).toContain("the weekly limit");
    endAgents();
    await advance(PLAN_LIMIT_RETRY_MS);
    expect(w.next).toHaveLength(1);
  });

  it("a model-family limit holds only that family's runs", async () => {
    const reset = w.f.t.clock.now() + 60_000;
    await limitEvents([
      { t: "limit", status: "rejected", resetsAt: iso(reset), scope: "model:opus" },
    ]);
    expect(openWait(w.f.office, w.f.run)?.scope).toBe("model:opus");
    expect(w.plans.held(ADAPTER, null)).toBeNull();
    expect(w.plans.held(ADAPTER, "haiku")).toBeNull();
    expect(w.plans.held(ADAPTER, "opus")).toContain("the opus limit");
  });

  it("without resetsAt probes once an hour, for as long as the limit holds, and never parks", async () => {
    // plan-limit-429: a turn ended by a 429 has no reset time.
    await ingestRecording("plan-limit-429");
    expect(openWait(w.f.office, w.f.run)).toMatchObject({ scope: "unknown" });
    for (let probe = 1; probe <= 3; probe++) {
      await advance(PLAN_LIMIT_PROBE_MS - 1);
      expect(w.next).toHaveLength(probe - 1);
      await advance(1);
      expect(w.next).toHaveLength(probe);
      expect(w.next.at(-1)?.why).toBe("an hourly plan-limit probe");
      // The probe meets the limit again: a new wait from now.
      await limitEvents([
        {
          t: "turn",
          report: null,
          totals: {},
          numTurns: 1,
          terminal: "error",
          problem: { kind: "planLimit", detail: "429" },
        },
      ]);
      expect(openWait(w.f.office, w.f.run)?.since).toBe(w.f.t.clock.now());
    }
    // No maximum wait and no fallback: the run is held, never parked, on its own model.
    expectActive();
    expect(new Set(w.next.map((r) => r.run.model))).toEqual(new Set(["haiku"]));
    expect(findRun(w.f.office, w.f.run)?.model).toBe("haiku");
  });
});

describe("allowed_warning and api-retry-rate-limit (AC #1)", () => {
  it("a warning lets the run go on and holds new runs on its scope until the reset", async () => {
    const reset = w.f.t.clock.now() + 30 * 60_000;
    track();
    const warning: WorkerEvent = {
      t: "limit",
      status: "allowed_warning",
      utilization: 0.9,
      resetsAt: iso(reset),
      scope: "session",
    };
    w.control.onWorkerEvents(w.f.run, [warning]);
    w.control.onWorkerEvents(w.f.run, [warning]);
    await w.control.idle();
    expect(openWait(w.f.office, w.f.run)).toBeNull();
    expect(w.control.live(w.f.run)).toBe(true);
    expect(w.plans.held(ADAPTER, null)).toContain("the plan warned");
    // One notice for the hold, not one per event.
    expect(w.notices.map((n) => n.code)).toEqual(["run.planLimitWarning"]);
    await advanceTo(reset);
    expect(w.plans.held(ADAPTER, null)).toBeNull();
    expect(w.next).toEqual([]);
  });

  it("a model-family warning without resetsAt holds that family for an hour", async () => {
    track();
    w.control.onWorkerEvents(w.f.run, [
      { t: "limit", status: "allowed_warning", scope: "model:sonnet" },
    ]);
    expect(w.plans.held(ADAPTER, "haiku")).toBeNull();
    expect(w.plans.held(ADAPTER, "sonnet")).not.toBeNull();
    await advance(PLAN_LIMIT_PROBE_MS);
    expect(w.plans.held(ADAPTER, "sonnet")).toBeNull();
  });

  it("a warning hold is stored and still holds after a restart, without a second notice (DIPO-92)", async () => {
    const reset = w.f.t.clock.now() + 30 * 60_000;
    track();
    w.control.onWorkerEvents(w.f.run, [
      { t: "limit", status: "allowed_warning", resetsAt: iso(reset), scope: "weekly" },
    ]);
    await w.control.idle();
    expect(storedWarnings()).toEqual([{ adapter: ADAPTER, scope: "weekly", until_at: reset }]);
    // The daemon stops: its memory is gone; the hold is in the database.
    w.plans.close();
    w.plans = planLimits();
    expect(w.plans.held(ADAPTER, null)).toBeNull();
    w.f.t.clock.advance(10 * 60_000);
    expect(w.plans.recover(w.f.office.officeId, w.f.office)).toBe(1);
    expect(w.plans.held(ADAPTER, null)).toBe(
      `New runs wait until ${iso(reset)}: the plan warned that the weekly limit is near.`,
    );
    // Like a rejected wait, the hold holds every adapter.
    expect(w.plans.held("other-cli", null)).toContain("the weekly limit is near");
    expect(w.notices.map((n) => n.code)).toEqual(["run.planLimitWarning"]);
    // It ends at its time, and its row goes with it.
    await advanceTo(reset);
    expect(w.plans.held(ADAPTER, null)).toBeNull();
    expect(storedWarnings()).toEqual([]);
  });

  it("a stored warning moves forward, never back, with a later warning (DIPO-92)", async () => {
    const reset = w.f.t.clock.now() + 30 * 60_000;
    track();
    w.control.onWorkerEvents(w.f.run, [
      { t: "limit", status: "allowed_warning", resetsAt: iso(reset), scope: "session" },
      { t: "limit", status: "allowed_warning", resetsAt: iso(reset - 60_000), scope: "session" },
    ]);
    await w.control.idle();
    expect(storedWarnings()).toEqual([{ adapter: ADAPTER, scope: "session", until_at: reset }]);
  });

  it("a warning hold whose time passed while the daemon was down is dropped (DIPO-92)", async () => {
    track();
    // Without resetsAt the hold lasts an hour.
    w.control.onWorkerEvents(w.f.run, [
      { t: "limit", status: "allowed_warning", scope: "model:sonnet" },
    ]);
    await w.control.idle();
    expect(storedWarnings()).toHaveLength(1);
    w.plans.close();
    w.f.t.clock.advance(PLAN_LIMIT_PROBE_MS);
    w.plans = planLimits();
    expect(w.plans.recover(w.f.office.officeId, w.f.office)).toBe(0);
    expect(w.plans.held(ADAPTER, "sonnet")).toBeNull();
    expect(storedWarnings()).toEqual([]);
  });

  it("a forgotten office's warning holds leave memory and come back from the row (DIPO-92)", async () => {
    track();
    w.control.onWorkerEvents(w.f.run, [
      { t: "limit", status: "allowed_warning", scope: "session" },
    ]);
    await w.control.idle();
    expect(w.plans.held(ADAPTER, null)).not.toBeNull();
    w.officeGone = true;
    expect(w.plans.held(ADAPTER, null)).toBeNull();
    expect(storedWarnings()).toHaveLength(1);
    // Opened again: the load step arms the stored hold.
    w.officeGone = false;
    expect(w.plans.held(ADAPTER, null)).toBeNull();
    expect(w.plans.recover(w.f.office.officeId, w.f.office)).toBe(1);
    expect(w.plans.held(ADAPTER, null)).toContain("the session limit is near");
  });

  it("a warning of an office with no adapter holds in memory and logs that it was not stored (DIPO-92)", async () => {
    w.unconfigured = true;
    track();
    w.control.onWorkerEvents(w.f.run, [{ t: "limit", status: "allowed_warning", scope: "weekly" }]);
    await w.control.idle();
    expect(w.plans.held(ADAPTER, null)).toContain("the weekly limit is near");
    expect(storedWarnings()).toEqual([]);
    expect(w.logged).toEqual(["a plan-limit warning was not stored: the office has no adapter"]);
  });

  it("a failure reading stored warnings still arms the reject waits (DIPO-92)", async () => {
    await ingestRecording("plan-limit-rejected");
    w.plans.close();
    w.plans = planLimits();
    const office = w.f.office;
    const broken = new Proxy(office, {
      get(handle, prop) {
        if (prop === "immediate") {
          return () => {
            throw new Error("disk I/O error");
          };
        }
        const value: unknown = Reflect.get(handle, prop);
        return typeof value === "function" ? value.bind(handle) : value;
      },
    });
    expect(w.plans.recover(office.officeId, broken)).toBe(1);
    expect(w.plans.held(ADAPTER, null)).toContain("the session limit");
    expect(w.logged).toEqual(["reading stored plan-limit warnings failed"]);
    await advanceTo(RECORDED_RESET + PLAN_LIMIT_RESUME_AFTER_MS);
    expect(w.next.map((r) => r.message)).toEqual(["continue"]);
  });

  it("api_retry rate_limit is a signal only: nothing waits and nothing is held", async () => {
    track();
    w.control.onWorkerEvents(w.f.run, [{ t: "limit", status: "rate_limit" }]);
    await w.control.idle();
    expect(openWait(w.f.office, w.f.run)).toBeNull();
    expect(w.plans.held(ADAPTER, null)).toBeNull();
    expect(w.control.live(w.f.run)).toBe(true);
  });
});

describe("plan-limit-credits (AC #5)", () => {
  it("holds the run and the adapter in every office with a notice, until work.resume", async () => {
    await limitEvents([{ t: "limit", status: "rejected", creditsRequired: true }]);
    expect(openWait(w.f.office, w.f.run)?.scope).toBe("credits");
    expect(w.hold?.check).toBe("credits");
    expect(w.plans.held(ADAPTER, null)).toContain("the plan needs credits");
    expect(w.plans.held("another-adapter", null)).toBeNull();
    // No reset is coming: no probe, however long it waits, and no park.
    await advance(30 * 24 * PLAN_LIMIT_PROBE_MS);
    expect(w.next).toEqual([]);
    expectActive();

    const reply = await w.resumption.resumeCommand(resumeCtx(), { story: StoryId.parse("DIPO-1") });
    expect(reply.result).toEqual({
      story: "DIPO-1",
      key: w.work.key,
      to: "In Progress",
      run: w.f.run,
    });
    expect(w.lifted).toEqual([ADAPTER]);
    expect(w.next.map((r) => [r.message, r.why])).toEqual([
      ["continue", "work.resume of the held run"],
    ]);
    expect(w.plans.held(ADAPTER, null)).toBeNull();
  });

  it("credits come back after a restart until work.resume", async () => {
    await limitEvents([{ t: "limit", status: "rejected", creditsRequired: true }]);
    w.plans.close();
    w.plans = planLimits();
    w.plans.recover(w.f.office.officeId, w.f.office);
    expect(w.plans.held(ADAPTER, null)).toContain("credits");
  });

  it("work.resume refuses a story with no held run, and a held worker that has not exited", async () => {
    const refusal = async () => {
      try {
        await w.resumption.resumeCommand(resumeCtx(), { story: StoryId.parse("DIPO-1") });
      } catch (error) {
        return error instanceof CommandError ? error.error.code : String(error);
      }
      return "resumed";
    };
    expect(await refusal()).toBe("story.notPausedOrParked");
    await limitEvents([{ t: "limit", status: "rejected", creditsRequired: true }], false);
    expect(await refusal()).toBe("run.hostAlive");
    // The hold stays until the worker exited and work.resume is sent again.
    expect(w.plans.held(ADAPTER, null)).not.toBeNull();
    endAgents();
    expect(await refusal()).toBe("resumed");
  });
});

const HOUR = 60 * 60_000;
const office = () => w.f.office.officeId as OfficeId;

/** The code of the error `fn` throws. */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof CommandError ? error.error.code : String(error);
  }
  return undefined;
}

function ctx(): CommandContext {
  return {
    office: w.f.office,
    now: w.f.t.clock.now(),
    origin: "cli",
  } as unknown as CommandContext;
}

function allow(args: { until?: string; note?: string; clear?: true }) {
  return w.f.office.immediate(() => allowLimits(ctx(), args, w.plans));
}

function warn(scope: "session" | "weekly", reset: number): void {
  track();
  w.control.onWorkerEvents(w.f.run, [
    { t: "limit", status: "allowed_warning", utilization: 0.8, resetsAt: iso(reset), scope },
  ]);
}

function heldHere(model: string | null = null): string | null {
  return w.plans.held(ADAPTER, model, office());
}

describe("the maintainer's allowance past a warning (DIPO-338)", () => {
  it("a weekly warning holds the next session; the allowance lets it start until its time", async () => {
    const reset = w.f.t.clock.now() + 72 * HOUR;
    warn("weekly", reset);
    await w.control.idle();
    expect(heldHere()).toContain("the weekly limit is near");
    const outcome = allow({ until: iso(w.f.t.clock.now() + HOUR), note: "finish M1b" });
    expect(outcome.result.allowance).toEqual({
      by: "cli",
      at: iso(w.f.t.clock.now()),
      until: iso(w.f.t.clock.now() + HOUR),
      note: "finish M1b",
    });
    expect(heldHere()).toBeNull();
    expect(heldHere("opus")).toBeNull();
    // Asked without the office (another office), the hold stays.
    expect(w.plans.held(ADAPTER, null)).toContain("the weekly limit is near");
    // Every new session reports the warning again: it does not hold while the allowance is in force.
    warn("weekly", reset);
    await w.control.idle();
    expect(heldHere()).toBeNull();
    // It ends by itself at its time.
    await advance(HOUR);
    expect(heldHere()).toContain("the weekly limit is near");
  });

  it("--clear ends it early, and until is cut to the reset the warning names", async () => {
    const reset = w.f.t.clock.now() + 72 * HOUR;
    warn("weekly", reset);
    await w.control.idle();
    expect(
      allow({ until: iso(reset + 120 * HOUR), note: "all week" }).result.allowance?.until,
    ).toBe(iso(reset));
    expect(heldHere()).toBeNull();
    expect(allow({ clear: true })).toEqual({ result: {}, changed: true });
    expect(heldHere()).toContain("the weekly limit is near");
    expect(allow({ clear: true })).toEqual({ result: {}, changed: false });
  });

  it("refuses limits.noWarning with no warning an allowance lifts, and an until in the past", async () => {
    expect(codeOf(() => allow({ until: iso(w.f.t.clock.now() + HOUR), note: "x" }))).toBe(
      "limits.noWarning",
    );
    // The five-hour window is never allowed.
    warn("session", w.f.t.clock.now() + 3 * HOUR);
    await w.control.idle();
    expect(codeOf(() => allow({ until: iso(w.f.t.clock.now() + HOUR), note: "x" }))).toBe(
      "limits.noWarning",
    );
    warn("weekly", w.f.t.clock.now() + 72 * HOUR);
    await w.control.idle();
    expect(codeOf(() => allow({ until: iso(w.f.t.clock.now() - 1), note: "x" }))).toBe(
      "args.invalid",
    );
  });

  it("never lifts a rejected limit or the five-hour window", async () => {
    const reset = w.f.t.clock.now() + 72 * HOUR;
    warn("weekly", reset);
    await w.control.idle();
    allow({ until: iso(reset), note: "go on" });
    expect(heldHere()).toBeNull();
    w.plans.close();
    w.plans = planLimits();
    // A reviewer's rejected weekly limit still holds, and stays rejected after a restart.
    w.plans.warned(office(), {
      scope: "weekly",
      resetsAt: iso(reset),
      rejected: true,
    });
    expect(heldHere()).toContain("the weekly limit");
    w.plans.close();
    w.plans = planLimits();
    w.plans.recover(office(), w.f.office);
    expect(heldHere()).toContain("the weekly limit");
    expect(
      readLimits(w.f.office, w.f.t.clock.now(), w.plans).holds.find((h) => h.scope === "weekly"),
    ).toEqual({
      scope: "weekly",
      until: iso(reset),
      utilization: 0.8,
      rejected: true,
      allowed: false,
    });
    // A five-hour warning still holds.
    w.plans.close();
    w.plans = planLimits();
    warn("session", w.f.t.clock.now() + 3 * HOUR);
    await w.control.idle();
    expect(heldHere()).toContain("the session limit is near");
  });

  it("a worker's rejected limit (its wait fact) still holds under an allowance", async () => {
    w.plans.warned(office(), {
      scope: "weekly",
      resetsAt: iso(RECORDED_RESET + 72 * HOUR),
    });
    allow({ until: iso(RECORDED_RESET + HOUR), note: "go on" });
    expect(heldHere()).toBeNull();
    await ingestRecording("plan-limit-rejected");
    expect(heldHere()).toContain("the session limit");
  });

  it("office.limits shows the warning, its utilization and reset, and the allowance", async () => {
    const reset = w.f.t.clock.now() + 72 * HOUR;
    warn("weekly", reset);
    await w.control.idle();
    expect(readLimits(w.f.office, w.f.t.clock.now(), w.plans)).toEqual({
      holds: [
        { scope: "weekly", until: iso(reset), utilization: 0.8, rejected: false, allowed: false },
      ],
    });
    allow({ until: iso(reset), note: "go on" });
    expect(readLimits(w.f.office, w.f.t.clock.now(), w.plans)).toEqual({
      holds: [
        { scope: "weekly", until: iso(reset), utilization: 0.8, rejected: false, allowed: true },
      ],
      allowance: { by: "cli", at: iso(w.f.t.clock.now()), until: iso(reset), note: "go on" },
    });
  });

  it("the wait for the reset is left out of the run's minute cap when its session resumes", async () => {
    const startedAt = findRun(w.f.office, w.f.run)?.startedAt ?? 0;
    await ingestRecording("plan-limit-rejected");
    const since =
      w.f.office.get<{ since: number }>(
        "select since from run_signals where office_id = $office_id and signal = 'plan-limit'",
      )?.since ?? 0;
    await advanceTo(RECORDED_RESET + PLAN_LIMIT_RESUME_AFTER_MS);
    const waited = RECORDED_RESET + PLAN_LIMIT_RESUME_AFTER_MS - since;
    expect(waited).toBeGreaterThan(0);
    expect(w.next).toHaveLength(1);
    expect(w.next[0]?.startedAt).toBe(startedAt + waited);
    expect(findRun(w.f.office, w.f.run)?.parkedMs).toBe(waited);
  });
});
