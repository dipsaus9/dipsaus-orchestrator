// `work.run` (DIPO-48 test plan), fast and local: the command runs through the one executor with
// a migrated state database and fakes for the base, the claim, the gate and the lane, so every rule
// is checked without git or the Backlog CLI. The full flow on real git and the pinned Backlog CLI
// is in work-run.ci.test.ts.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  type CommandReply,
  type OfficeId,
  RequestId,
  RunId,
  StoryId,
  type StoryKey,
  type StoryView,
} from "@dipsaus-orchestrator/contract";

import type { JournalEntry, LaneOp } from "../../src/backlog/lane/journal";
import { insertEntry } from "../../src/backlog/lane/journal";
import type { PlainTask } from "../../src/backlog/plain";
import { cursorAt, readLogState } from "../../src/changelog/log";
import { replay } from "../../src/changelog/replay";
import { executeCommand, type ExecutorDeps } from "../../src/commands/execute";
import { stateOfficeDirectory } from "../../src/commands/offices";
import { buildRegistry, type Registry } from "../../src/commands/registry";
import { MemoryRequestTable } from "../../src/commands/requests";
import { OFFICE_DEFAULTS, type OfficeConfig } from "../../src/config";
import type { OfficeHandle } from "../../src/db/office";
import { insertParkQuestion } from "../../src/hooks/questions";
import { storeGateDecision } from "../../src/gate/store/decisions";
import type { GateMode, GateResult } from "../../src/gate/types";
import { executeRead } from "../../src/reads/execute";
import { type SlotEntry, SlotTableError } from "../../src/worktree/slots";
import { GitError } from "../../src/git/runner";
import { createLogger } from "../../src/log/logger";
import { OfficeManager } from "../../src/office/manager";
import { systemSpawn } from "../../src/platform/process";
import { runCriteriaMet } from "../../src/run/criteria";
import {
  createRunOutcomes,
  endRun,
  findRun,
  hasActiveRun,
  insertRun,
  placeHolders,
  Places,
  PLACE_NOTICES,
  type Resumption,
  type RunEnder,
  runSteps,
  START_KINDS,
  type BaseRead,
  type NewRun,
  waitForPlace,
  waitingStarts,
  WorkRun,
  type WorkRunDeps,
} from "../../src/run";
import type { StoredRun } from "../../src/run/records";
import { SoftwareStream } from "../../src/software-stream";
import { addStory } from "../../src/stories/keys";
import { AdapterHolds } from "../../src/workers/hold";
import { encode } from "../../src/workers/claude-cli/encode";
import type { ClaimOutcome, ClaimRequest } from "../../src/worktree/claim";
import { insertClaim } from "../../src/worktree/records";
import { addOffice, countRows, openTestState, type TestState } from "../commands/helpers";

import { addAgent, storyRun } from "./rounds-helpers";

const BLOCK = (id: string) =>
  ["```dipo", `branch: "${id}/a-story"`, "unknowns: []", "```"].join("\n");

function task(id: string, status: string, overrides: Partial<PlainTask> = {}): PlainTask {
  return {
    file: `/base/backlog/tasks/${id.toLowerCase()} - Story.md`,
    id,
    title: `Story ${id}`,
    status,
    assignee: [],
    created: "2026-10-12 11:28",
    labels: ["tier:S"],
    subtasks: [],
    references: ["src/"],
    documentation: [],
    dependencies: [],
    description: `Outcome: a story.\n\n${BLOCK(id)}`,
    acceptanceCriteria: [
      { index: 1, checked: true, text: "It works as described." },
      { index: 2, checked: false, text: "It is tested." },
    ],
    definitionOfDone: [],
    modifiedFiles: [],
    comments: [],
    unknown: [],
    ...overrides,
  };
}

const passed = (mode: GateMode): GateResult => ({ mode, passed: true, failures: [] });
const failedR15 = (id: string): GateResult => ({
  mode: "pickup",
  passed: false,
  failures: [
    {
      rule: "R15",
      message: `ready ${id} failed R15: unknown "Which format?" is open; resolve it with an answer`,
    },
  ],
});

interface World {
  readonly t: TestState;
  readonly office: OfficeHandle;
  readonly officeId: OfficeId;
  registry: Registry;
  deps: ExecutorDeps;
  readonly tasks: PlainTask[];
  readonly keys: Map<string, StoryKey>;
  readonly claims: ClaimRequest[];
  readonly gates: { key: StoryKey; mode: GateMode; inQueue: boolean; inSession: boolean }[];
  readonly lane: { journaled: LaneOp[]; flushes: number };
  readonly holds: AdapterHolds;
  config: OfficeConfig;
  configErrors: { message: string }[];
  statuses: string | null;
  verify: string | null;
  fetchError: Error | null;
  gate: (key: StoryKey, mode: GateMode) => GateResult;
  /** The plan-limit hold (DIPO-61): why a run on the model must wait, or null. */
  planLimit: (adapter: string, model: string | null) => string | null;
  /** The live port slot entries (DIPO-197). */
  slots: SlotEntry[];
  /** Thrown by the slot read instead of returning `slots`, when set. */
  slotsError: SlotTableError | null;
  /** The office's places: the serialized steps of `work.run` and the drains (DIPO-208). */
  readonly places: Places;
  /** The stories the places started as a resume, in order. */
  readonly resumeStarts: string[];
  /** Holds the claim open when set: `entered` is called as it starts, `open` lets it go on (DIPO-208). */
  claimGate: { readonly entered: () => void; readonly open: Promise<void> } | null;
  /** Starts a queued resume through the park resume when set (DIPO-229); else the place only records it. */
  queuedStart: ((office: OfficeId, run: StoredRun) => Promise<boolean>) | null;
}

/** The git session the fake claim hands its recheck, so a test can see the gate got it (DIPO-201). */
const CLAIM_SESSION = { claimSession: true } as never;

let dir = "";
let world: World;

beforeEach(async () => {
  dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "work-run-"));
  const t = await openTestState(dir);
  const office = addOffice(t);
  const officeId = office.officeId;
  const keys = new Map<string, StoryKey>();
  const tasks: PlainTask[] = [];
  const claims: ClaimRequest[] = [];
  const gates: World["gates"] = [];
  const lane = { journaled: [] as LaneOp[], flushes: 0 };
  const holds = new AdapterHolds({ clock: t.clock, notify: () => undefined });
  const resumeStarts: string[] = [];
  const places = new Places({
    clock: t.clock,
    offices: { get: () => office, config: () => OFFICE_DEFAULTS },
    starters: {
      resume: async (target, started) => {
        resumeStarts.push(started.story ?? "");
        return w.queuedStart === null ? true : w.queuedStart(target, started);
      },
    },
  });
  const w: World = {
    t,
    office,
    officeId,
    registry: undefined as unknown as Registry,
    deps: undefined as unknown as ExecutorDeps,
    tasks,
    keys,
    claims,
    gates,
    lane,
    holds,
    config: OFFICE_DEFAULTS,
    configErrors: [],
    statuses: null,
    verify: null,
    fetchError: null,
    gate: (_key, mode) => passed(mode),
    planLimit: () => null,
    slots: [],
    slotsError: null,
    places,
    resumeStarts,
    claimGate: null,
    queuedStart: null,
  };
  const read = (ids: readonly string[] | null): BaseRead => ({
    statuses: new Map(tasks.map((x) => [x.id, x.status])),
    views: tasks.filter((x) => (ids === null ? x.status === "Ready" : ids.includes(x.id))),
    unparsed: [],
    checkout: { path: "/base", base: "main" },
  });
  const runDeps: WorkRunDeps = {
    places,
    offices: {
      get: () => office,
      config: () => w.config,
      configHash: () => "hash-1",
      configBlocksRuns: () =>
        w.configErrors.map((error) => ({
          file: ".dipo/office.yaml",
          path: "tiers",
          expected: "object",
          message: error.message,
        })) as never,
    },
    base: {
      fetch: async () => {
        if (w.fetchError !== null) throw w.fetchError;
      },
      read: async (_office, ids) => read(ids),
    },
    stories: { indexStories: async () => undefined },
    profiles: { ensureFreshProfile: async () => undefined, verifyResolved: () => w.verify },
    statuses: async () => w.statuses,
    adapterHeld: (adapter, scope) => holds.adapterHeld(adapter, scope),
    planLimitHeld: (adapter, model) => w.planLimit(adapter, model),
    liveSlots: () => {
      if (w.slotsError !== null) throw w.slotsError;
      return w.slots;
    },
    claims: {
      claim: async (_office, request): Promise<ClaimOutcome> => {
        claims.push(request);
        if (w.claimGate !== null) {
          w.claimGate.entered();
          await w.claimGate.open;
        }
        const skip = await request.recheck?.(CLAIM_SESSION);
        if (skip !== null && skip !== undefined) return skip;
        const claim = {
          runId: request.runId,
          key: request.key,
          story: request.story,
          branch: request.branch,
          worktree: `/trees/${request.story}`,
          base: "main",
          baseSha: "b".repeat(40),
          startSha: "a".repeat(40),
          claimSha: "c".repeat(40),
          reused: false,
          snapshot: {
            path: `/trees/${request.story}`,
            adminDir: "/x",
            commondir: "/x",
            gitdir: "/x",
            pointer: "/x",
          },
          firstFeedback: null,
          claimedAt: t.clock.now(),
        };
        office.immediate(() => insertClaim(office, claim));
        return {
          ok: true,
          claim: {
            ...claim,
            pushedAt: null,
            releasedAt: null,
            releaseReason: null,
            teardownStartedAt: null,
          },
          pushed: true,
          setup: null,
        };
      },
    },
    gates: {
      recordGateDecision: async (_office, key, mode, checkout, session) => {
        gates.push({
          key,
          mode,
          inQueue: checkout !== undefined,
          inSession: session === CLAIM_SESSION,
        });
        const result = w.gate(key, mode);
        office.immediate(() =>
          storeGateDecision(office, t.ids, { key, result, contentHash: "h", at: t.clock.now() }),
        );
        return { passed: result.passed, result };
      },
    },
    lane: () => ({
      journal: async (op): Promise<JournalEntry> => {
        lane.journaled.push(op);
        return office.immediate(() => insertEntry(office, op, t.clock.now()));
      },
      flush: async () => {
        lane.flushes += 1;
      },
    }),
  };
  w.registry = buildRegistry([new WorkRun(runDeps).feature]);
  w.deps = {
    registry: w.registry,
    offices: stateOfficeDirectory(t.state),
    clock: t.clock,
    ids: t.ids,
    softwareRequests: new MemoryRequestTable(t.clock),
  };
  world = w;
});

afterEach(() => {
  world.t.state.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Adds a story to the base and to the office's index. */
function story(id: string, status: string, overrides: Partial<PlainTask> = {}): StoryKey {
  const w = world;
  w.tasks.push(task(id, status, overrides));
  const identity = w.office.immediate(() =>
    addStory(w.office, w.t.ids, { story: StoryId.parse(id) }, w.t.clock.now()),
  );
  w.keys.set(id, identity.key);
  return identity.key;
}

let requests = 0;
function run(args: Record<string, unknown> = {}): Promise<CommandReply> {
  requests += 1;
  return executeCommand(world.deps, {
    requestId: RequestId.parse(`01J9ZK5Q8W3V4X6Y7Z${requests.toString().padStart(8, "0")}`),
    name: "work.run",
    args,
    origin: "cli",
    confirmed: false,
    office: world.officeId,
  });
}

interface RunResult {
  started: { story: string; key: string; run: string }[];
  skipped: { story: string; key: string; reason: string }[];
}

function resultOf(reply: CommandReply): RunResult {
  if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`);
  return reply.result as RunResult;
}

function entries(): { type: string; delta: unknown; view?: unknown }[] {
  const { epoch } = readLogState(world.office);
  const result = replay(world.office, cursorAt(world.officeId, epoch, 0));
  if (!result.ok) throw new Error(result.error.message);
  return result.entries.map(({ type, delta, view }) => ({ type, delta, view }));
}

describe("work.run picks and claims one Ready story", () => {
  it("claims the first eligible Ready story, records the run and emits work.assigned and work.phase setup", async () => {
    // TASK-2 comes first by priority but waits on TASK-9; TASK-3 is next by ordinal.
    story("TASK-1", "Ready", { priority: "low" });
    story("TASK-2", "Ready", {
      priority: "high",
      ordinal: 1000,
      dependencies: [{ id: "TASK-9", state: "resolved", status: "In Progress" }],
    });
    const key3 = story("TASK-3", "Ready", {
      priority: "high",
      ordinal: 2000,
      dependencies: [{ id: "TASK-8", state: "resolved", status: "Done" }],
    });
    story("TASK-4", "Refined");

    const reply = await run();
    const result = resultOf(reply);
    expect(result.started.map((s) => s.story)).toEqual(["TASK-3"]);
    expect(result.skipped).toEqual([
      { story: "TASK-2", key: world.keys.get("TASK-2") as string, reason: "dependency" },
      { story: "TASK-1", key: world.keys.get("TASK-1") as string, reason: "capacity" },
    ]);
    expect(reply.ok && reply.changed).toBe(true);
    // work.assigned, the setup marker's work.output (DIPO-83) and work.phase setup.
    expect(reply.ok && reply.cursor?.seq).toBe(3);

    // The claim got the frozen branch and ran the pickup re-check inside its queue item.
    expect(world.claims.map((c) => [c.story, c.branch])).toEqual([["TASK-3", "TASK-3/a-story"]]);
    expect(world.gates).toEqual([{ key: key3, mode: "pickup", inQueue: true, inSession: true }]);
    expect(countRows(world.office, "gate_decisions")).toBe(1);

    const runId = RunId.parse(result.started[0]?.run);
    expect(findRun(world.office, runId)).toMatchObject({
      kind: "story",
      key: key3,
      story: "TASK-3",
      tier: "S",
      role: "developer",
      model: OFFICE_DEFAULTS.tiers.S.model,
      startSha: "a".repeat(40),
      branch: "TASK-3/a-story",
      worktree: "/trees/TASK-3",
      budgetUnit: "tokens",
      budgetLimit: OFFICE_DEFAULTS.tiers.S.budgetTokens,
      loopCap: OFFICE_DEFAULTS.tiers.S.loops,
      configHash: "hash-1",
      runProfileId: null,
      endedAt: null,
    });
    expect(runSteps(world.office, runId).map((s) => [s.kind, s.value])).toEqual([
      ["phase", "setup"],
    ]);
    expect(countRows(world.office, "config_snapshots")).toBe(1);
    expect(countRows(world.office, "agents")).toBe(1);
    // The story's criteria the worker reports are counted against (DIPO-85).
    expect(runCriteriaMet(world.office, runId, null)).toEqual({ met: 1, known: 2 });

    const log = entries();
    expect(log.map((e) => e.type)).toEqual(["work.assigned", "work.output", "work.phase"]);
    const work = (log[0]?.delta as { work: Record<string, unknown> } | undefined)?.work;
    expect(work).toMatchObject({
      story: "TASK-3",
      key: key3,
      run: runId,
      role: "developer",
      tier: "S",
      model: OFFICE_DEFAULTS.tiers.S.model,
    });
    // The setup marker opens the worker output at byte 0 (DIPO-83).
    const marker = log[1]?.delta as { from: number; text: string } | undefined;
    expect(marker?.from).toBe(0);
    expect(marker?.text).toMatch(/^\[dipo\] \S+ phase setup\n$/);
    expect(log[2]?.delta).toEqual({
      work,
      phase: "setup",
      progress: {
        criteriaMet: 1,
        criteriaTotal: 2,
        loop: 0,
        loopCap: OFFICE_DEFAULTS.tiers.S.loops,
        verify: "none",
        reviewRound: 0,
      },
    });

    // One active run per office: the next run starts nothing; the claimed story is notRunnable.
    expect(hasActiveRun(world.office)).toBe(true);
    const again = resultOf(await run());
    expect(again.started).toEqual([]);
    expect(again.skipped.map((s) => [s.story, s.reason])).toEqual([
      ["TASK-2", "capacity"],
      ["TASK-3", "notRunnable"],
      ["TASK-1", "capacity"],
    ]);
    expect(world.claims).toHaveLength(1);
  });

  it("snapshots the review loop caps from the review and merge slot settings at run start (DIPO-146)", async () => {
    world.config = {
      ...OFFICE_DEFAULTS,
      review: {
        ...OFFICE_DEFAULTS.review,
        maxRounds: 4,
        maxTurns: 70,
        maxMinutes: 25,
        budgetTokens: 150_000,
      },
      mergeSlot: { ...OFFICE_DEFAULTS.mergeSlot, ciAttempts: 5, conflictAttempts: 3 },
    };
    story("TASK-1", "Ready");
    const runId = RunId.parse(resultOf(await run()).started[0]?.run);
    const expected = {
      reviewRoundCap: 4,
      ciCap: 5,
      conflictCap: 3,
      reviewMaxTurns: 70,
      reviewMaxMinutes: 25,
      reviewAllowance: 150_000,
    };
    expect(findRun(world.office, runId)).toMatchObject(expected);
    expect(
      world.office.get<Record<string, unknown>>(
        `select review_round_cap, ci_cap, conflict_cap, review_max_turns, review_max_minutes,
           review_allowance from runs where office_id = $office_id and run_id = $run`,
        { run: runId },
      ),
    ).toEqual({
      review_round_cap: 4,
      ci_cap: 5,
      conflict_cap: 3,
      review_max_turns: 70,
      review_max_minutes: 25,
      review_allowance: 150_000,
    });

    // A config edit after the start never changes the running story's limits.
    world.config = OFFICE_DEFAULTS;
    expect(findRun(world.office, runId)).toMatchObject(expected);
  });

  it("counts only the worker place: an open session run takes none (DIPO-142)", async () => {
    story("TASK-1", "Ready");
    world.office.immediate(() =>
      insertRun(world.office, {
        runId: RunId.parse(world.t.ids.next("run")),
        kind: "session",
        key: null,
        story: null,
        tier: null,
        role: "developer",
        model: "haiku",
        startSha: null,
        branch: null,
        worktree: null,
        slot: null,
        budgetUnit: "tokens",
        budgetLimit: 1,
        loopCap: 1,
        reviewRoundCap: null,
        configHash: "h",
        overrideKeys: null,
        runProfileId: null,
        startedAt: world.t.clock.now(),
      }),
    );
    // `office.forget` still sees the session run.
    expect(hasActiveRun(world.office)).toBe(true);
    expect(resultOf(await run()).started.map((s) => s.story)).toEqual(["TASK-1"]);
  });

  it("runs only the named stories and skips each by its state", async () => {
    story("TASK-1", "Refined");
    story("TASK-2", "Parked");
    story("TASK-3", "Done");
    const lane = story("TASK-4", "Ready");
    const blocked = story("TASK-5", "Ready");
    story("TASK-6", "Ready");
    world.office.immediate(() => {
      insertEntry(
        world.office,
        { kind: "edit", key: lane, subject: "TASK-4", target: { status: "Refined" } },
        0,
      );
      world.office.run(
        `insert into backlog_pr_blocks (office_id, key, pr_number, failures, blocked_at)
         values ($office_id, $key, 7, '[]', 0)`,
        { key: blocked },
      );
    });
    const result = resultOf(
      await run({ stories: ["TASK-1", "TASK-2", "TASK-3", "TASK-4", "TASK-5"] }),
    );
    expect(result.started).toEqual([]);
    expect(result.skipped.map((s) => [s.story, s.reason])).toEqual([
      ["TASK-1", "notReady"],
      ["TASK-2", "parked"],
      ["TASK-3", "notRunnable"],
      ["TASK-4", "notRunnable"],
      ["TASK-5", "notRunnable"],
    ]);
    expect(world.claims).toEqual([]);
    // An unknown story fails the whole command.
    const unknown = await run({ stories: ["TASK-99"] });
    expect(!unknown.ok && unknown.error.code).toBe("story.unknown");
  });

  it("returns a story whose pickup re-check fails to Refined through the lane with the gate messages", async () => {
    const key = story("TASK-1", "Ready");
    world.gate = () => failedR15("TASK-1");
    const result = resultOf(await run());
    expect(result).toEqual({
      started: [],
      skipped: [{ story: "TASK-1", key, reason: "pickupCheckFailed" }],
    });
    expect(world.lane.journaled).toEqual([
      { kind: "edit", key, subject: "TASK-1", target: { from: ["Ready"], status: "Refined" } },
    ]);
    expect(world.lane.flushes).toBe(1);
    expect(countRows(world.office, "gate_decisions")).toBe(1);
    expect(countRows(world.office, "runs")).toBe(0);
    const log = entries();
    expect(log.map((e) => e.type)).toEqual(["story.state"]);
    expect(log[0]?.delta).toEqual({
      story: "TASK-1",
      key,
      from: "Ready",
      to: "Refined",
      detail: [
        'ready TASK-1 failed R15: unknown "Which format?" is open; resolve it with an answer',
      ],
    });
    expect(log[0]?.view).toMatchObject({ lifecycle: "Refined", column: "refined" });
    // The view carries the rule id as data next to the message (DIPO-97).
    expect((log[0]?.view as StoryView | undefined)?.gateFailures).toEqual([
      {
        rule: "R15",
        message:
          'ready TASK-1 failed R15: unknown "Which format?" is open; resolve it with an answer',
        text: 'unknown "Which format?" is open; resolve it with an answer',
      },
    ]);
  });

  it("returns a story over prompt.contractMax to Refined with the assembly error, before any claim", async () => {
    const key = story("TASK-1", "Ready");
    world.config = { ...OFFICE_DEFAULTS, prompt: { ...OFFICE_DEFAULTS.prompt, contractMax: 10 } };
    const result = resultOf(await run());
    expect(result.skipped).toEqual([{ story: "TASK-1", key, reason: "pickupCheckFailed" }]);
    expect(world.claims).toEqual([]);
    expect(world.lane.journaled).toHaveLength(1);
    const detail = (entries()[0]?.delta as { detail: string[] } | undefined)?.detail ?? [];
    expect(detail).toHaveLength(1);
    expect(detail[0]).toStartWith(
      "TASK-1 cannot start: prompt.contractTooLarge: story contract is ",
    );
    expect(detail[0]).toEndWith("characters; the limit is 10");
    // No rule gave it, so the view has the message but no rule entry (DIPO-97).
    const view = entries()[0]?.view as StoryView | undefined;
    expect(view?.gateMessages).toEqual(detail);
    expect(view).not.toHaveProperty("gateFailures");
  });

  it("sends a story with no frozen branch through the pickup gate on its own", async () => {
    const key = story("TASK-1", "Ready", { description: "Outcome: a story." });
    world.gate = () => ({
      mode: "pickup",
      passed: false,
      failures: [{ rule: "R18", message: "ready TASK-1 failed R18: branch is missing" }],
    });
    const result = resultOf(await run());
    expect(result.skipped).toEqual([{ story: "TASK-1", key, reason: "pickupCheckFailed" }]);
    expect(world.gates).toEqual([{ key, mode: "pickup", inQueue: false, inSession: false }]);
    expect(world.claims).toEqual([]);
  });
});

async function codeOf(args: Record<string, unknown> = {}) {
  const reply = await run(args);
  if (reply.ok) throw new Error("expected a refusal");
  return reply.error;
}

/** The launch checks a scoped hold repeats; these pass. */
async function recheck() {
  return { ok: true } as const;
}

describe("work.run refusals", () => {
  it("refuses with each predicate's message and starts nothing", async () => {
    story("TASK-1", "Ready");

    expect(await codeOf({ maxAgents: 2 })).toMatchObject({ code: "args.invalid" });

    world.configErrors = [{ message: "tiers.S.loops must be an integer" }];
    expect(await codeOf()).toMatchObject({
      code: "config.invalid",
      retryable: false,
      message:
        "New runs are refused until `dipo office reload-config` reads a valid configuration: tiers.S.loops must be an integer",
    });
    world.configErrors = [];

    world.holds.hold("claude-cli", [{ check: "probe", detail: "claude is not logged in" }]);
    const held = await codeOf();
    expect(held).toMatchObject({ code: "run.refused", details: { check: "adapter" } });
    expect(held.message).toStartWith(
      "New runs on claude-cli are held in every office: probe: claude is not logged in.",
    );
    world.holds.lift("claude-cli");

    world.fetchError = new GitError("git.fetchFailed", "Fetching origin failed (offline).", true);
    expect(await codeOf()).toMatchObject({
      code: "git.fetchFailed",
      retryable: true,
      message: "Fetching origin failed (offline).",
    });
    world.fetchError = null;

    world.statuses =
      "The office's base branch has no Backlog.md status `Parked`, so dipo runs no story yet: run `dipo office init` and let its backlog PR merge.";
    expect(await codeOf()).toMatchObject({
      code: "run.refused",
      details: { check: "statuses" },
      message: world.statuses,
    });
    world.statuses = null;

    world.verify =
      "Verify is unresolved: the office has no run profile yet. Run `dipo office rescan`.";
    expect(await codeOf()).toMatchObject({
      code: "run.refused",
      details: { check: "verify" },
      message: world.verify,
    });
    world.verify = null;

    expect(world.claims).toEqual([]);
    expect(resultOf(await run()).started).toHaveLength(1);
  });

  it("refuses a run only for the worker kind a could-not-run hold names, in that office (DIPO-257)", async () => {
    story("TASK-1", "Ready");
    const couldNotRun = [
      { check: "self-test", detail: "the sandbox self-test could not run", couldNotRun: true },
    ] as const;

    // The reviewer kind of this office, and the worker kind of another office, still launch.
    world.holds.holdScoped(
      "claude-cli",
      { office: world.officeId, kind: "reviewer" },
      couldNotRun,
      recheck,
    );
    world.holds.holdScoped(
      "claude-cli",
      { office: "office-other", kind: "worker" },
      couldNotRun,
      recheck,
    );
    expect(resultOf(await run()).started).toHaveLength(1);

    story("TASK-2", "Ready");
    world.holds.holdScoped(
      "claude-cli",
      { office: world.officeId, kind: "worker" },
      couldNotRun,
      recheck,
    );
    const held = await codeOf();
    expect(held).toMatchObject({ code: "run.refused", details: { check: "adapter" } });
    expect(held.message).toStartWith(
      "New worker sessions on claude-cli are held in this office; other offices and the other session kind still launch: self-test: the sandbox self-test could not run.",
    );

    // An unsafe verdict holds the adapter in every office, as before.
    world.holds.liftScoped("claude-cli", { office: world.officeId, kind: "worker" });
    world.holds.hold("claude-cli", [{ check: "self-test", detail: "a probe write got through" }]);
    expect(await codeOf()).toMatchObject({ code: "run.refused", details: { check: "adapter" } });
  });

  it("refuses every run while a plan limit of every model holds, and skips a held model as planLimit (DIPO-61, DIPO-92)", async () => {
    story("TASK-1", "Ready");
    const asked: (string | null)[] = [];
    world.planLimit = (_adapter, model) => {
      asked.push(model);
      return model === null ? "New runs wait for the session limit." : null;
    };
    // Named stories too: a plan limit is not lifted by the launch checks.
    for (const args of [{}, { stories: ["TASK-1"] }]) {
      expect(await codeOf(args)).toMatchObject({
        code: "run.refused",
        details: { check: "plan-limit" },
        message: "New runs wait for the session limit.",
      });
    }
    expect(asked).toEqual([null, null]);

    // A model-family limit: only stories whose tier runs that model are skipped, with their own
    // reason, not capacity (DIPO-92).
    const model = world.config.tiers.S.model;
    world.planLimit = (_adapter, asking) => (asking === model ? "the opus limit" : null);
    expect(resultOf(await run())).toMatchObject({
      started: [],
      skipped: [{ story: "TASK-1", reason: "planLimit" }],
    });
    world.planLimit = () => null;
    expect(world.claims).toEqual([]);
    expect(resultOf(await run()).started).toHaveLength(1);
  });

  it("skips as capacity, not planLimit, when the office is full and a model-family hold also applies (DIPO-92)", async () => {
    story("TASK-1", "Ready", { priority: "high" });
    story("TASK-2", "Ready", { priority: "low" });
    expect(resultOf(await run()).started.map((s) => s.story)).toEqual(["TASK-1"]);
    const model = world.config.tiers.S.model;
    world.planLimit = (_adapter, asking) => (asking === model ? "the opus limit" : null);
    expect(resultOf(await run()).skipped.map((s) => [s.story, s.reason])).toEqual([
      ["TASK-1", "notRunnable"],
      ["TASK-2", "capacity"],
    ]);
  });

  it("answers engine.recovering for from while the state database is not open", async () => {
    const t = world.t;
    const manager = new OfficeManager({
      database: () => null,
      registry: () => world.registry,
      software: new SoftwareStream({ clock: t.clock }),
      clock: t.clock,
      ids: t.ids,
      git: { spawn: systemSpawn },
      logger: createLogger({ clock: t.clock, sinks: [], component: "office", level: "error" }),
    });
    expect(manager.registeredPath(world.officeId)).toMatchObject({
      ok: false,
      error: { code: "engine.recovering", retryable: true },
    });
    world.deps = { ...world.deps, offices: manager };
    const reply = await run({ from: "/repos/demo" });
    expect(!reply.ok && reply.error).toMatchObject({ code: "engine.recovering", retryable: true });
  });

  it("refuses office.unknown when from is an unopened copy of the office", async () => {
    story("TASK-1", "Ready");
    const reply = await run({ from: "/repos/demo-copy" });
    expect(!reply.ok && reply.error).toMatchObject({
      code: "office.unknown",
      message: `/repos/demo-copy is not office ${world.officeId}, which is registered at /repos/demo.`,
      details: { office: world.officeId, from: "/repos/demo-copy", reason: "path" },
    });
    expect(world.claims).toEqual([]);
    expect(resultOf(await run({ from: "/repos/demo" })).started).toHaveLength(1);
  });

  it("registers the active-run check office.forget asks", () => {
    const check = world.registry.activeWorkChecks().find((entry) => entry.name === "runs");
    expect(check?.check(world.office)).toBe(false);
  });
});

describe("the runs table", () => {
  const base: NewRun = {
    runId: RunId.parse("run_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D"),
    kind: "session",
    key: null,
    story: null,
    tier: null,
    role: "developer",
    model: "sonnet",
    startSha: null,
    branch: null,
    worktree: null,
    slot: null,
    budgetUnit: "tokens",
    budgetLimit: 1000,
    loopCap: 0,
    reviewRoundCap: null,
    configHash: "hash-1",
    overrideKeys: null,
    runProfileId: null,
    startedAt: 0,
  };

  it("takes a session run with no key, worktree or branch, and keeps its usage under the office", () => {
    const { office } = world;
    office.immediate(() => {
      insertRun(office, base);
      office.run(
        `insert into agents (office_id, agent_id, run_id, role, model, started_at)
         values ($office_id, 'agt_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D', $run, 'developer', 'sonnet', 0)`,
        { run: base.runId },
      );
      office.run(
        `insert into usage_totals (office_id, run_id, agent_id, model, role, tier, input, updated_at)
         values ($office_id, $run, 'agt_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D', 'sonnet', 'developer', '-', 42, 0)`,
        { run: base.runId },
      );
    });
    expect(findRun(office, base.runId)).toMatchObject({ kind: "session", key: null });
    expect(
      office.get<{ n: number }>(
        "select sum(input) as n from usage_totals where office_id = $office_id",
      )?.n,
    ).toBe(42);
    // A session run is active until it ends, without a claim.
    expect(hasActiveRun(office)).toBe(true);
    // A story run needs its key, branch, worktree and start SHA.
    expect(() =>
      office.immediate(() =>
        insertRun(office, {
          ...base,
          runId: RunId.parse("run_01J9ZK5Q8W3V4X6Y7Z8A9B0C2E"),
          kind: "story",
        }),
      ),
    ).toThrow();
  });
});

const heldSlot = (slot: number, owner: string, office = "off_other"): SlotEntry => ({
  slot,
  office,
  story: owner,
  worktree: `/trees/${owner}`,
  takenAt: 1,
});

function twoSlots(): void {
  world.config = { ...OFFICE_DEFAULTS, worktree: { ...OFFICE_DEFAULTS.worktree, maxSlots: 2 } };
}

function previewRun(): Promise<Awaited<ReturnType<typeof executeRead>>> {
  return executeRead(
    { registry: world.registry, offices: world.deps.offices, clock: world.t.clock },
    {
      requestId: RequestId.parse("01J9ZK5Q8W3V4X6Y7Z00009999"),
      name: "work.preview",
      args: { office: world.officeId },
    },
  );
}

describe("port slots (DIPO-197)", () => {
  it("refuses work.run and work.preview with check slots when every slot is held by other worktrees", async () => {
    twoSlots();
    story("TASK-1", "Ready");
    world.slots = [heldSlot(1, "TASK-8"), heldSlot(2, "TASK-9")];

    const refusal = await codeOf();
    expect(refusal).toMatchObject({ code: "run.refused", details: { check: "slots" } });
    expect(refusal.message).toContain(
      "slot 1: office off_other, story TASK-8, worktree /trees/TASK-8",
    );
    expect(refusal.message).toContain(
      "slot 2: office off_other, story TASK-9, worktree /trees/TASK-9",
    );
    expect(world.claims).toEqual([]);

    const dry = await previewRun();
    if (!dry.ok) throw new Error(dry.error.message);
    const result = dry.result as { refusals: { check: string; message: string }[]; story: unknown };
    expect(result.refusals.map((r) => r.check)).toEqual(["slots"]);
    expect(result.refusals[0]?.message).toBe(refusal.message);
    expect(result.story).toBeNull();
  });

  it("does not refuse with one slot free, and names the story the preview would start", async () => {
    twoSlots();
    story("TASK-1", "Ready");
    world.slots = [heldSlot(1, "TASK-8")];
    const dry = await previewRun();
    if (!dry.ok) throw new Error(dry.error.message);
    const result = dry.result as { refusals: unknown[]; story: { story: string } | null };
    expect(result.refusals).toEqual([]);
    expect(result.story?.story).toBe("TASK-1");
    expect(resultOf(await run()).started).toHaveLength(1);
  });

  it("does not refuse a story whose own worktree already holds a slot", async () => {
    twoSlots();
    story("TASK-1", "Ready");
    world.slots = [heldSlot(1, "TASK-8"), heldSlot(2, "TASK-1", world.officeId)];
    const dry = await previewRun();
    if (!dry.ok) throw new Error(dry.error.message);
    expect((dry.result as { refusals: unknown[] }).refusals).toEqual([]);
    expect(resultOf(await run()).started).toHaveLength(1);
  });

  it("refuses with check slots and the table's reason when the slot table cannot be read", async () => {
    story("TASK-1", "Ready");
    const reason = "The port slot table /home/slots.json cannot be read: SyntaxError: bad json";
    world.slotsError = new SlotTableError(reason);

    const refusal = await codeOf();
    expect(refusal).toMatchObject({ code: "run.refused", details: { check: "slots" } });
    expect(refusal.message).toContain(reason);
    expect(world.claims).toEqual([]);

    const dry = await previewRun();
    if (!dry.ok) throw new Error(dry.error.message);
    const result = dry.result as { refusals: { check: string; message: string }[]; story: unknown };
    expect(result.refusals).toEqual([{ check: "slots", message: reason }]);
    expect(result.story).toBeNull();
  });
});

describe("a queued resume and a pickup never take the worker place together (DIPO-208)", () => {
  it("drains a resume queued inside the pickup's claim only after the pickup's run is recorded", async () => {
    story("TASK-1", "Ready");
    // Hold work.run's claim open: the pickup has passed its worker place check and not recorded its run.
    const entered = Promise.withResolvers<void>();
    const opened = Promise.withResolvers<void>();
    world.claimGate = { entered: () => entered.resolve(), open: opened.promise };
    const pickup = run();
    await entered.promise;

    // A maintainer resume queued and drained inside that window.
    const resume = storyRun(
      { dir, t: world.t, office: world.office, close: () => undefined },
      { story: "DIPO-7" },
    );
    world.office.immediate(() => waitForPlace(world.office, resume.run, START_KINDS.resume, 0));
    const drained = world.places.drain(world.officeId);
    opened.resolve();

    const result = resultOf(await pickup);
    await drained;
    world.places.close();

    expect(world.resumeStarts).toEqual([]);
    expect(result.started.map((s) => s.story)).toEqual(["TASK-1"]);
    expect(placeHolders(world.office).worker.map((r) => r.story)).toEqual(["TASK-1"]);
    expect(waitingStarts(world.office).map((s) => s.runId)).toEqual([resume.run]);
  });
});

/** A story run parked `needs-permission`, ended, with its permission question open (DIPO-229). */
function parkedRun(id: string): { run: RunId; parkId: number; question: string } {
  const started = storyRun(
    { dir, t: world.t, office: world.office, close: () => undefined },
    { story: id },
  );
  const { office, t } = world;
  const agent = addAgent(
    { dir, t, office, close: () => undefined },
    started.run,
    "developer",
    false,
  );
  const at = t.clock.now();
  const question = t.ids.next("qst");
  let parkId = 0;
  office.immediate(() => {
    office.run(
      `insert into parks (office_id, park_id, key, story_id, run_id, reason, from_state, detail, at)
       values ($office_id, (select coalesce(max(park_id), 0) + 1 from parks
         where office_id = $office_id), $key, $story, $run, 'needs-permission', 'In Progress', 'x', $at)`,
      { key: started.key, story: id, run: started.run, at },
    );
    parkId = office.get<{ id: number }>(
      "select max(park_id) as id from parks where office_id = $office_id",
    )?.id as number;
    endRun(office, started.run, at, "blocked");
    insertParkQuestion(office, {
      questionId: question,
      runId: started.run,
      agentId: agent,
      parkId,
      tool: "Bash",
      action: "docker ps",
      text: "Bash(docker ps)",
      at,
    });
  });
  return { run: started.run, parkId, question };
}

/** The park resumption; a resume's session start counts into `sessions` (DIPO-229). */
function resumption(sessions: { count: number }): Resumption {
  const ender = { isTracked: () => false } as unknown as RunEnder;
  return createRunOutcomes(
    {
      clock: world.t.clock,
      offices: { get: () => world.office },
      steering: { send: async () => ({ ok: true }) },
      encode,
      worker: { id: "claude-cli", result: () => ({ outcome: "done", resumable: true }) as never },
      ender: () => ender,
      resumer: {
        next: async () => {
          sessions.count += 1;
          return { kind: "started", agent: "agt_x" as never, resumed: true };
        },
      },
      caps: () => ({ budgetTokens: 1_000_000, maxTurns: 100, maxMinutes: 60 }),
      unpark: { lift: async () => ({ commit: null, pushed: true, pushError: null }) },
    },
    { places: () => world.places },
  ).resumption;
}

function answer(of: Resumption, parked: { run: RunId; parkId: number; question: string }) {
  return of.resumePark(world.officeId, parked.run, {
    parkId: parked.parkId,
    question: parked.question,
    decision: "allow",
    text: "",
  });
}

function noticeCodes(): string[] {
  return entries()
    .filter((e) => e.type === "engine.notice")
    .map((e) => (e.delta as { code?: string }).code ?? "");
}

/** Lets the pending microtasks run: an answer started before this has reached its serialized step. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
}

/** Holds work.run's claim open until the answer has queued behind it, then lets the pickup go on. */
async function pickupWithAnswerInClaim(
  of: Resumption,
  parked: { run: RunId; parkId: number; question: string },
) {
  const entered = Promise.withResolvers<void>();
  const opened = Promise.withResolvers<void>();
  world.claimGate = { entered: () => entered.resolve(), open: opened.promise };
  const pickup = run();
  await entered.promise;
  const reply = answer(of, parked);
  await settle();
  opened.resolve();
  return { pickup, reply };
}

describe("a park resume and a pickup never take the worker place together (DIPO-229)", () => {
  it("holds a park answer inside work.run's claim window: the pickup takes the worker place and the resume waits", async () => {
    story("TASK-1", "Ready");
    const parked = parkedRun("DIPO-7");
    const sessions = { count: 0 };
    const { pickup, reply } = await pickupWithAnswerInClaim(resumption(sessions), parked);

    const result = resultOf(await pickup);
    expect(await reply).toEqual({ kind: "started", queued: true });
    await world.places.drain(world.officeId);
    world.places.close();

    expect(sessions.count).toBe(0);
    expect(world.resumeStarts).toEqual([]);
    expect(result.started.map((s) => s.story)).toEqual(["TASK-1"]);
    expect(placeHolders(world.office).worker.map((r) => r.story)).toEqual(["TASK-1"]);
    expect(waitingStarts(world.office).map((s) => s.runId)).toEqual([parked.run]);
    expect(noticeCodes()).toContain(PLACE_NOTICES.queued);
  });

  it("skips a pickup for the worker place when the park resume went first", async () => {
    story("TASK-1", "Ready");
    const parked = parkedRun("DIPO-7");
    const sessions = { count: 0 };
    const resuming = resumption(sessions);
    expect(await answer(resuming, parked)).toEqual({ kind: "started" });
    await resuming.idle();

    const result = resultOf(await run());
    world.places.close();

    expect(sessions.count).toBe(1);
    expect(result.started).toEqual([]);
    expect(result.skipped.map((s) => [s.story, s.reason])).toEqual([["TASK-1", "capacity"]]);
  });

  it("starts a queued park resume from a drain without waiting on the office's serialized steps", async () => {
    story("TASK-1", "Ready");
    const parked = parkedRun("DIPO-7");
    const sessions = { count: 0 };
    const resuming = resumption(sessions);
    const { pickup, reply } = await pickupWithAnswerInClaim(resuming, parked);
    const result = resultOf(await pickup);
    expect(await reply).toEqual({ kind: "started", queued: true });

    // The pickup ends, so the worker place frees; the drain starts the queued resume through startQueued.
    world.queuedStart = (officeId, started) => resuming.startQueued(officeId, started);
    expect(result.started).toHaveLength(1);
    endRun(world.office, RunId.parse(result.started[0]?.run ?? ""), world.t.clock.now(), "done");
    await world.places.drain(world.officeId);
    await resuming.idle();
    world.places.close();

    expect(sessions.count).toBe(1);
    expect(waitingStarts(world.office)).toEqual([]);
  });
});
