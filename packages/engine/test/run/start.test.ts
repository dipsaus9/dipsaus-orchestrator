// The worker start of a claimed run and the dry run (DIPO-74), fast and local: `work.run` and
// `work.preview` run through the executors with a migrated state database, a claim fake that runs
// the launcher's setup as `claimStory` does, the real Claude CLI plan, the DIPO-43 hold gate with
// scripted checks, an in-memory workspace and stubs for the host and ingestion. The same flow on
// real git, the pinned Backlog CLI and a FakeProcess replay is in start.ci.test.ts.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  type CommandReply,
  type OfficeId,
  type ReadReply,
  RequestId,
  type RunId,
  StoryId,
  type StoryKey,
} from "@dipsaus-orchestrator/contract";

import type { PlainTask } from "../../src/backlog/plain";
import { cursorAt, readLogState } from "../../src/changelog/log";
import { replay } from "../../src/changelog/replay";
import { executeCommand, type ExecutorDeps } from "../../src/commands/execute";
import { stateOfficeDirectory } from "../../src/commands/offices";
import { buildRegistry, type Registry } from "../../src/commands/registry";
import { MemoryRequestTable } from "../../src/commands/requests";
import { OFFICE_DEFAULTS, type OfficeConfig } from "../../src/config";
import type { Workspace } from "../../src/context/types";
import type { OfficeHandle } from "../../src/db/office";
import type { GateResult } from "../../src/gate/types";
import { contextPathsOf, nudgeCount } from "../../src/hooks/nudges";
import type { OfficeGit } from "../../src/git/office";
import type { IngestTarget } from "../../src/ingest/ingestor";
import { promptPartsOf, promptTextsOf } from "../../src/prompts/parts";
import { executeRead } from "../../src/reads/execute";
import {
  type BaseRead,
  backstopSnapshotOf,
  type BackstopSnapshot,
  endRun,
  findRun,
  type HostStarter,
  LAUNCH_NOTICES,
  RunLauncher,
  runSteps,
  START_FAILED_END,
  WorkRun,
} from "../../src/run";
import { readShortTempRun, shortTempDir } from "../../src/run/temp-dirs";
import { recordWorkerHost, type LaunchedHost } from "../../src/runs/worker-hosts";
import { addStory } from "../../src/stories/keys";
import {
  claudeCliAdapter,
  claudeLaunchContext,
  claudeSessionFacts,
} from "../../src/workers/claude-cli/adapter";
import { encode } from "../../src/workers/claude-cli/encode";
import { type ClaudeParseState, initialState } from "../../src/workers/claude-cli/interpret";
import { REPORT_JSON_SCHEMAS } from "../../src/workers/claude-cli/report-schema";
import { CLAUDE_LOCAL_SETTINGS } from "../../src/workers/claude-cli/settings-check";
import { result as claudeResult } from "../../src/workers/claude-cli/result";
import { AdapterHolds, gateLaunch, type LaunchCheckOutcome } from "../../src/workers/hold";
import type { RunLaunchPaths, WorkerPort } from "../../src/workers/port";
import { type LaunchPlan, type ParseState, PlanError } from "../../src/workers/types";
import type { ClaimOutcome, ClaimRequest, ClaimSetupFailed } from "../../src/worktree/claim";
import { findClaim, insertClaim, releaseClaim, type ClaimRecord } from "../../src/worktree/records";
import type { SetupOutcome } from "../../src/worktree/setup";
import { addOffice, countRows, openTestState, type TestState } from "../commands/helpers";
import { storeResolvedVerify } from "./verify-profile";

const CLAUDE = "/opt/claude/bin/claude";
const BACKSTOP: BackstopSnapshot = {
  head: "a".repeat(40),
  branch: "refs/heads/TASK-1/add-a-greeting",
  stash: "",
  backlogStatus: "",
};
const HOME = "/home/maintainer";
const BLOCK = (id: string) =>
  ["```dipo", `branch: "${id}/add-a-greeting"`, "unknowns: []", "```"].join("\n");

function task(id: string, status: string, overrides: Partial<PlainTask> = {}): PlainTask {
  return {
    file: `/base/backlog/tasks/${id.toLowerCase()} - Story.md`,
    id,
    title: `Add a greeting ${id}`,
    status,
    assignee: [],
    created: "2026-10-12 11:28",
    labels: ["tier:M"],
    subtasks: [],
    references: ["src/greet.ts"],
    documentation: [],
    dependencies: [],
    description: `Outcome: the CLI greets by name.\n\n${BLOCK(id)}`,
    acceptanceCriteria: [{ index: 1, checked: false, text: "It greets the name it is given." }],
    definitionOfDone: [],
    modifiedFiles: [],
    comments: [],
    unknown: [],
    ...overrides,
  };
}

/** An in-memory checkout with one source file. */
function memoryWorkspace(root: string): Workspace {
  const files: Record<string, string> = { "src/greet.ts": "export const greet = () => 'hi';\n" };
  return {
    root,
    headSha: async () => "c".repeat(40),
    trackedFiles: async () => Object.keys(files).toSorted(),
    files: async () => Object.keys(files).toSorted(),
    readFile: async (path) => {
      const text = files[path];
      return text === undefined ? undefined : new TextEncoder().encode(text);
    },
  };
}

const ctxOf = (paths: RunLaunchPaths, config: OfficeConfig) =>
  claudeLaunchContext(
    {
      claudePath: CLAUDE,
      home: HOME,
      env: { PATH: "/usr/bin:/bin", GH_TOKEN: "not-a-token" },
      dipoCommand: ["/opt/dipo/bin/dipo"],
      pluginFiles: { read: () => undefined, dirs: () => [] },
    },
    paths,
    config,
  );

function neverSpawn(): never {
  throw new Error("no process may start in this test");
}

const COUNTED_TABLES = [
  "claims",
  "runs",
  "agents",
  "run_steps",
  "worker_hosts",
  "gate_decisions",
  "change_log",
  "config_snapshots",
  "stories",
];

/** Row counts of the tables a run writes. */
function snapshot(): Record<string, number> {
  return Object.fromEntries(COUNTED_TABLES.map((table) => [table, countRows(world.office, table)]));
}

interface World {
  readonly t: TestState;
  readonly dir: string;
  readonly office: OfficeHandle;
  readonly officeId: OfficeId;
  readonly registry: Registry;
  readonly deps: ExecutorDeps;
  readonly tasks: PlainTask[];
  readonly keys: Map<string, StoryKey>;
  readonly holds: AdapterHolds;
  readonly hosts: { runId: string; agentId: string; officeDir: string; plan: LaunchPlan }[];
  readonly ingested: IngestTarget[];
  readonly released: { claim: ClaimRecord; reason: string }[];
  readonly setupReleases: number[];
  readonly claimCalls: ClaimRequest[];
  /** Stories read again after their claim commit (DIPO-56). */
  readonly refreshed: StoryKey[];
  config: OfficeConfig;
  setup: "ok" | "fail";
  checks: LaunchCheckOutcome;
  worktreeRoot: string;
  hostFails: boolean;
  /** Called as a host starts, with its run (DIPO-93). */
  onHostStart: ((runId: string) => void) | null;
  releaseFails: boolean;
  readonly warnings: string[];
  gate: GateResult;
  /** The verify tools check's refusal (DIPO-173); null passes. */
  verifyRefusal: string | null;
}

let world: World;

beforeEach(async () => {
  const dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "run-start-"));
  const t = await openTestState(dir);
  const office = addOffice(t);
  const holds = new AdapterHolds({ clock: t.clock, notify: () => undefined });
  const w = {
    t,
    dir,
    office,
    officeId: office.officeId,
    tasks: [] as PlainTask[],
    keys: new Map<string, StoryKey>(),
    holds,
    hosts: [] as World["hosts"],
    ingested: [] as IngestTarget[],
    released: [] as World["released"],
    setupReleases: [] as number[],
    claimCalls: [] as ClaimRequest[],
    refreshed: [] as StoryKey[],
    config: OFFICE_DEFAULTS,
    setup: "ok" as "ok" | "fail",
    checks: { ok: true } as LaunchCheckOutcome,
    worktreeRoot: join(dir, "trees"),
    hostFails: false,
    onHostStart: null,
    releaseFails: false,
    warnings: [] as string[],
    gate: { mode: "pickup", passed: true, failures: [] } as GateResult,
    verifyRefusal: null,
  } as unknown as World;

  const git = {
    commonDir: join(dir, "repo", ".git"),
    mainWorktree: join(dir, "repo"),
    worktreeRoot: () => w.worktreeRoot,
  } as unknown as OfficeGit;
  const worker: WorkerPort = {
    id: "claude-cli",
    reportSchema: REPORT_JSON_SCHEMAS,
    localSettings: CLAUDE_LOCAL_SETTINGS,
    adapter: (paths, config) =>
      claudeCliAdapter(ctxOf(paths, config), { spawn: neverSpawn, clock: t.clock }),
    // The verify tools check (DIPO-173), scripted: it refuses with `w.verifyRefusal` when set.
    checkVerify: async () => {
      if (w.verifyRefusal !== null) throw new PlanError(w.verifyRefusal);
    },
    prepare: async (spec, paths, config, _checkSession, verify) => {
      if (verify !== undefined && w.verifyRefusal !== null) throw new PlanError(w.verifyRefusal);
      const plan = claudeCliAdapter(ctxOf(paths, config), {
        spawn: neverSpawn,
        clock: t.clock,
      }).plan(spec);
      const gate = await gateLaunch("claude-cli", holds, async () => w.checks);
      return gate.ok ? { ok: true, plan } : gate;
    },
    initialState: (spec) => initialState({ plannedModel: spec.model }) as unknown as ParseState,
    encode,
    result: (state, exit) => claudeResult(state as unknown as ClaudeParseState, exit),
    sessionFacts: (state) => claudeSessionFacts(state as unknown as ClaudeParseState),
  };
  const hosts: HostStarter = {
    start: async (handle, started) => {
      if (w.hostFails) throw new Error("spawn failed: no such file");
      w.onHostStart?.(started.runId);
      w.hosts.push({ ...started });
      const host: LaunchedHost = {
        pid: 4242,
        startTimeMs: 0,
        runId: started.runId,
        agentId: started.agentId,
        socketPath: join(dir, "host.sock"),
        protocolVersion: 1,
        runDir: join(started.officeDir, "runs", started.runId),
        eventFile: join(started.officeDir, "runs", started.runId, "events.ndjson"),
      };
      recordWorkerHost(handle, host, t.clock);
      return host;
    },
  };
  const launcher = new RunLauncher({
    worker,
    git: () => git,
    setup: async (): Promise<SetupOutcome> =>
      w.setup === "ok"
        ? ({
            ok: true,
            slot: 3,
            env: { PORT: "3030" },
            files: { log: [], skipped: [], envFiles: [], settings: null },
            log: ["slot: 3", "setup: done"],
            release: () => w.setupReleases.push(3),
          } as unknown as SetupOutcome)
        : { ok: false, reason: "install (bun install) failed: exit 1", log: "install: exit 1" },
    dependencies: async () => [],
    runtimeDir: join(dir, "runtime"),
    tmpRoot: join(dir, "tmp"),
    // The backstop's run-start snapshot (DIPO-49), stored with the run (DIPO-93).
    snapshot: async () => BACKSTOP,
    hosts,
    ingest: { start: (_office, _host, target) => w.ingested.push(target) },
    release: async (_office, claim, reason) => {
      if (w.releaseFails) throw new Error("git worktree remove failed: busy");
      w.released.push({ claim, reason });
      office.immediate(() =>
        releaseClaim(office, claim.runId, { at: t.clock.now(), reason, keepBranch: true }),
      );
    },
    workspace: (_git, path) => memoryWorkspace(path),
    warn: (message, fields) => w.warnings.push(`${message}: ${String(fields["reason"])}`),
  });

  const read = (ids: readonly string[] | null): BaseRead => ({
    statuses: new Map(w.tasks.map((x) => [x.id, x.status])),
    views: w.tasks.filter((x) => (ids === null ? x.status === "Ready" : ids.includes(x.id))),
    unparsed: [],
    checkout: { path: "/base", base: "main" },
  });
  const workRun = new WorkRun({
    offices: {
      get: () => office,
      config: () => w.config,
      configHash: () => "hash-1",
      configBlocksRuns: () => [],
    },
    base: { fetch: async () => undefined, read: async (_office, ids) => read(ids) },
    stories: {
      indexStories: async () => undefined,
      refreshStory: async (_office, key) => {
        w.refreshed.push(key);
      },
    },
    profiles: { ensureFreshProfile: async () => undefined, verifyResolved: () => null },
    statuses: async () => null,
    adapterHeld: (adapter) => holds.adapterHeld(adapter),
    // As `claimStory`: the re-check, the claim record, setup (a failure rolls back), the claim.
    claims: {
      claim: async (_office, request): Promise<ClaimOutcome> => {
        w.claimCalls.push(request);
        const skip = await request.recheck?.(undefined as never);
        if (skip !== null && skip !== undefined) return skip;
        const path = join(w.worktreeRoot, request.story);
        office.immediate(() =>
          insertClaim(office, {
            runId: request.runId,
            key: request.key,
            story: request.story,
            branch: request.branch,
            worktree: path,
            base: "main",
            baseSha: "b".repeat(40),
            startSha: "b".repeat(40),
            claimSha: null,
            reused: false,
            snapshot: { path, adminDir: "/x", commondir: "/x", gitdir: "/x", pointer: "/x" },
            firstFeedback: null,
            claimedAt: t.clock.now(),
          }),
        );
        const claim = findClaim(office, request.runId) as ClaimRecord;
        const setup = request.setup === undefined ? null : await request.setup(claim);
        if (setup !== null && !setup.ok) {
          office.immediate(() =>
            office.run(
              `update claims set released_at = $at, release_reason = 'setup-failed'
               where office_id = $office_id and run_id = $run`,
              { at: t.clock.now(), run: request.runId },
            ),
          );
          return {
            ok: false,
            reason: "pickupCheckFailed",
            notice: (setup as ClaimSetupFailed).reason,
            code: "setup.failed",
            log: (setup as ClaimSetupFailed).log,
          };
        }
        return { ok: true, claim, pushed: true, setup };
      },
    },
    gates: {
      recordGateDecision: async () => ({ passed: w.gate.passed, result: w.gate }),
      checkGate: async () => w.gate,
    },
    lane: () => undefined,
    launcher,
  });
  const registry = buildRegistry([workRun.feature]);
  Object.assign(w, {
    registry,
    deps: {
      registry,
      offices: stateOfficeDirectory(t.state),
      clock: t.clock,
      ids: t.ids,
      softwareRequests: new MemoryRequestTable(t.clock),
    },
  });
  world = w;
});

afterEach(() => {
  world.t.state.close();
  rmSync(world.dir, { recursive: true, force: true });
});

function story(id: string, status: string, overrides: Partial<PlainTask> = {}): StoryKey {
  world.tasks.push(task(id, status, overrides));
  const identity = world.office.immediate(() =>
    addStory(world.office, world.t.ids, { story: StoryId.parse(id) }, world.t.clock.now()),
  );
  world.keys.set(id, identity.key);
  return identity.key;
}

let requests = 0;
function requestId(): RequestId {
  requests += 1;
  return RequestId.parse(`01J9ZK5Q8W3V4X6Y7Z${requests.toString().padStart(8, "0")}`);
}

function run(args: Record<string, unknown> = {}): Promise<CommandReply> {
  return executeCommand(world.deps, {
    requestId: requestId(),
    name: "work.run",
    args,
    origin: "cli",
    confirmed: false,
    office: world.officeId,
  });
}

function preview(args: Record<string, unknown> = {}): Promise<ReadReply> {
  return executeRead(
    { registry: world.registry, offices: world.deps.offices, clock: world.t.clock },
    { requestId: requestId(), name: "work.preview", args: { office: world.officeId, ...args } },
  );
}

interface RunResult {
  started: { story: string; run: string }[];
  skipped: { story: string; key?: string; reason: string }[];
}

function resultOf<T>(reply: CommandReply | ReadReply): T {
  if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`);
  return reply.result as T;
}

function entries(): { type: string; delta: Record<string, unknown> }[] {
  const { epoch } = readLogState(world.office);
  const result = replay(world.office, cursorAt(world.officeId, epoch, 0));
  if (!result.ok) throw new Error(result.error.message);
  return result.entries.map(({ type, delta }) => ({
    type,
    delta: delta as Record<string, unknown>,
  }));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("work.run starts the worker of a claimed run", () => {
  it("starts the host with the tier's model, effort and caps and the stored session id, ingests it and emits work.phase build", async () => {
    story("TASK-1", "Ready");
    const result = resultOf<RunResult>(await run());
    expect(result.started.map((s) => s.story)).toEqual(["TASK-1"]);
    const runId = result.started[0]?.run as RunId;

    const caps = OFFICE_DEFAULTS.tiers.M;
    const [host] = world.hosts;
    expect(world.hosts).toHaveLength(1);
    const argv: readonly string[] = host?.plan.argv ?? [];
    const flag = (name: string) => argv[argv.indexOf(name) + 1];
    expect(argv[0]).toBe(CLAUDE);
    // The claim commit is read again on the branch at once, so the views say In Progress.
    expect(world.refreshed).toEqual([world.keys.get("TASK-1") as StoryKey]);
    expect(flag("--model")).toBe(caps.model);
    expect(flag("--effort")).toBe(caps.effort);
    expect(flag("--max-turns")).toBe(String(caps.maxTurns));
    expect(flag("--tools")).toBe("Read,Edit,Write,Glob,Grep,Bash");
    expect(host?.plan.cwd).toBe(join(world.worktreeRoot, "TASK-1"));

    // The session id is engine-made, stored on the run's agent and passed to the worker.
    const agent = world.office.get<{
      agent_id: string;
      session_id: string;
      effort: string;
      model: string;
    }>(
      "select agent_id, session_id, effort, model from agents where office_id = $office_id and run_id = $run",
      { run: runId },
    );
    expect(agent?.session_id).toMatch(UUID);
    expect(flag("--session-id")).toBe(agent?.session_id);
    expect(agent).toMatchObject({ effort: caps.effort, model: caps.model });

    // The context pack's paths are stored for the context nudge (DIPO-60), with no nudge yet.
    expect(contextPathsOf(world.office, runId, agent?.agent_id ?? "")).toEqual(["src/greet.ts"]);
    expect(nudgeCount(world.office, runId)).toBe(0);

    // The system file is in the run directory; the task message is the first stdin line.
    const systemFile = flag("--append-system-prompt-file") as string;
    expect(systemFile).toBe(join(world.dir, "repo", ".git", "dipo", "runs", runId, "system.md"));
    expect(readFileSync(systemFile, "utf8")).toContain("developer");
    expect(host?.plan.stdin[0]).toContain("TASK-1");
    expect(host?.plan.env["GH_TOKEN"]).toBeUndefined();
    // The short temp root (DIPO-118) is made before the plan, names its run and is DIPO_TMP.
    const shortTmp = shortTempDir(join(world.dir, "tmp"), runId);
    expect(host?.plan.env["DIPO_TMP"]).toBe(shortTmp);
    expect(readShortTempRun(shortTmp)).toBe(runId);

    // The run row has the slot setup took; ingestion runs with the tier's budget.
    expect(findRun(world.office, runId)).toMatchObject({ slot: 3, model: caps.model, tier: "M" });
    expect(world.ingested).toHaveLength(1);
    expect(world.ingested[0]).toMatchObject({
      run: runId,
      budgetLimit: caps.budgetTokens,
      model: caps.model,
      tier: "M",
    });
    expect(runSteps(world.office, runId).map((step) => step.value)).toEqual(["setup", "build"]);
    const events = entries();
    expect(events.map((e) => [e.type, e.delta["phase"] ?? null])).toEqual([
      ["work.assigned", null],
      // Each phase's marker line goes out right before its `work.phase` (DIPO-83).
      ["work.output", null],
      ["work.phase", "setup"],
      ["work.output", null],
      ["work.phase", "build"],
    ]);
  });

  it("stores the system file and the task message of the first session, keyed by run and agent (DIPO-137)", async () => {
    story("TASK-1", "Ready");
    const result = resultOf<RunResult>(await run());
    const runId = result.started[0]?.run as RunId;
    const [host] = world.hosts;
    const agent = world.office.get<{ agent_id: string }>(
      "select agent_id from agents where office_id = $office_id and run_id = $run",
      { run: runId },
    );
    const systemFile = readFileSync(
      join(world.dir, "repo", ".git", "dipo", "runs", runId, "system.md"),
      "utf8",
    );
    const sent = JSON.parse(host?.plan.stdin[0] ?? "").message.content as string;
    expect(promptTextsOf(world.office, runId, agent?.agent_id ?? "")).toEqual([
      { part: "system", text: systemFile },
      { part: "message", text: sent },
    ]);
  });

  it("stores no prompt text with storePrompts off (DIPO-137)", async () => {
    world.config = {
      ...OFFICE_DEFAULTS,
      privacy: { ...OFFICE_DEFAULTS.privacy, storePrompts: false },
    };
    story("TASK-1", "Ready");
    const result = resultOf<RunResult>(await run());
    expect(result.started).toHaveLength(1);
    expect(world.office.all("select * from prompt_texts where office_id = $office_id")).toEqual([]);
    // The measurements stay.
    expect(world.office.all("select * from prompt_parts where office_id = $office_id")).not.toEqual(
      [],
    );
  });

  it("stores the measured prompt parts of the first session: system, task and each section (DIPO-177)", async () => {
    story("TASK-1", "Ready");
    const result = resultOf<RunResult>(await run());
    const runId = result.started[0]?.run as RunId;
    const [host] = world.hosts;
    const agent = world.office.get<{ agent_id: string }>(
      "select agent_id from agents where office_id = $office_id and run_id = $run",
      { run: runId },
    );
    const systemFile = readFileSync(
      join(world.dir, "repo", ".git", "dipo", "runs", runId, "system.md"),
    );
    // The task message is the content of the first stdin line (stream-json user message).
    const sent = JSON.parse(host?.plan.stdin[0] ?? "").message.content as string;
    const parts = promptPartsOf(world.office, runId, agent?.agent_id ?? "");
    const system = parts.find((part) => part.name === "system");
    const taskPart = parts.find((part) => part.name === "task");
    expect(system).toMatchObject({ sha256: sha(systemFile), bytes: systemFile.length });
    expect(taskPart).toMatchObject({ sha256: sha(sent), bytes: Buffer.byteLength(sent) });
    // The test story's message has these five sections, each a `<name>` block of the sent text.
    const names = ["context", "story", "outcome", "criteria", "scope"];
    expect(parts.map((part) => part.name)).toEqual(
      ["system", "task", ...names.map((name) => `task.${name}`)].toSorted(),
    );
    for (const name of names) {
      const text = new RegExp(`^<${name}>\\n[\\s\\S]*?\\n</${name}>$`, "m").exec(sent)?.[0] ?? "";
      expect(text).not.toBe("");
      expect(parts.find((part) => part.name === `task.${name}`)).toMatchObject({
        sha256: sha(text),
        bytes: Buffer.byteLength(text),
      });
    }
  });

  it("stores the backstop snapshot with the run before the host starts (DIPO-93 AC #4)", async () => {
    story("TASK-1", "Ready");
    let atStart = null as BackstopSnapshot | null;
    world.onHostStart = (runId) => {
      atStart = backstopSnapshotOf(world.office, runId);
    };
    const result = resultOf<RunResult>(await run());
    const runId = result.started[0]?.run as RunId;
    expect(atStart).toEqual(BACKSTOP);
    expect(backstopSnapshotOf(world.office, runId)).toEqual(BACKSTOP);
    // The run's end clears it: the engine's own commit at the end moves what it compares.
    world.office.immediate(() => endRun(world.office, runId, world.t.clock.now(), "done"));
    expect(backstopSnapshotOf(world.office, runId)).toBeNull();
  });

  it("rolls back on a refused launch check: no host, the slot freed, the hold kept, the story skipped", async () => {
    story("TASK-1", "Ready");
    world.checks = {
      ok: false,
      failures: [{ check: "self-test", detail: "the worker wrote into <main>/.git" }],
    };
    const result = resultOf<RunResult>(await run({ stories: ["TASK-1"] }));
    expect(result.started).toEqual([]);
    expect(result.skipped).toEqual([
      { story: "TASK-1", key: world.keys.get("TASK-1") as string, reason: "pickupCheckFailed" },
    ]);
    expect(world.hosts).toEqual([]);
    expect(world.setupReleases).toEqual([3]);
    expect(world.holds.adapterHeld("claude-cli")?.check).toBe("self-test");
    expect(countRows(world.office, "runs")).toBe(0);
    expect(existsSync(join(world.dir, "repo", ".git", "dipo", "runs"))).toBe(true);
    const runs = join(world.dir, "repo", ".git", "dipo", "runs");
    expect(readdirSync(runs)).toEqual([]);
    // Both run temp directories went with the rollback (DIPO-118).
    expect(readdirSync(join(world.dir, "tmp"))).toEqual([]);
  });

  it("repeats the launch checks on a run that names its story while the adapter is held, and lifts the hold", async () => {
    story("TASK-1", "Ready");
    world.holds.hold("claude-cli", [{ check: "probe", detail: "claude is not logged in" }]);
    const unnamed = await run();
    expect(unnamed.ok).toBe(false);
    const named = resultOf<RunResult>(await run({ stories: ["TASK-1"] }));
    expect(named.started.map((s) => s.story)).toEqual(["TASK-1"]);
    expect(world.holds.adapterHeld("claude-cli")).toBeNull();
  });

  it("starts no worker when setup fails", async () => {
    story("TASK-1", "Ready");
    world.setup = "fail";
    const result = resultOf<RunResult>(await run());
    expect(result.skipped.map((s) => s.reason)).toEqual(["pickupCheckFailed"]);
    expect(world.hosts).toEqual([]);
    expect(countRows(world.office, "runs")).toBe(0);
  });

  it("refuses a worktree path the plan cannot use with a notice naming the path and the character", async () => {
    story("TASK-1", "Ready");
    world.worktreeRoot = join(world.dir, "trees (old)");
    const result = resultOf<RunResult>(await run());
    expect(result.skipped.map((s) => s.reason)).toEqual(["pickupCheckFailed"]);
    expect(world.hosts).toEqual([]);
    const notice = entries().find(
      (e) => e.type === "engine.notice" && e.delta["code"] === LAUNCH_NOTICES.planRefused,
    );
    const text = String(notice?.delta["text"]);
    expect(text).toContain(join(world.worktreeRoot, "TASK-1"));
    expect(text).toContain('"("');
    expect(text).toContain("Move the checkout, or set worktree.root");
  });

  it("releases the claim and ends the run as start-failed when the host does not start", async () => {
    story("TASK-1", "Ready");
    world.hostFails = true;
    const result = resultOf<RunResult>(await run());
    expect(result.started).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toEqual(["pickupCheckFailed"]);
    expect(world.released.map((r) => r.reason)).toEqual([START_FAILED_END]);
    const runId = world.released[0]?.claim.runId as RunId;
    expect(findRun(world.office, runId)).toMatchObject({ endKind: START_FAILED_END });
    expect(findRun(world.office, runId)?.endedAt).not.toBeNull();
    expect(world.setupReleases).toEqual([3]);
    const notice = entries().find((e) => e.delta["code"] === LAUNCH_NOTICES.startFailed);
    expect(String(notice?.delta["text"])).toContain("spawn failed: no such file");
  });
});

describe("a failed release after a failed host start", () => {
  it("is logged and named in the run.startFailed notice", async () => {
    story("TASK-1", "Ready");
    world.hostFails = true;
    world.releaseFails = true;
    const result = resultOf<RunResult>(await run());
    expect(result.started).toEqual([]);
    expect(world.warnings).toEqual([
      "releasing the claim after a failed host start failed: git worktree remove failed: busy",
    ]);
    const notice = entries().find((e) => e.delta["code"] === LAUNCH_NOTICES.startFailed);
    expect(String(notice?.delta["text"])).toContain(
      "releasing its claim also failed (git worktree remove failed: busy)",
    );
  });
});

describe("work.preview, the dry run", () => {
  interface PreviewResult {
    refusals: { check: string; message: string }[];
    story: { story: string } | null;
    skipped: { story: string; reason: string; detail?: string[] }[];
    launch: {
      branch: string;
      worktree: string;
      argv: string[];
      model: string;
      effort: string;
      caps: Record<string, number>;
      envNames: string[];
      files: { name: string; content: string }[];
      systemFile: { path: string; text: string };
      taskMessage: string;
    } | null;
    problem: string | null;
  }

  it("shows the branch, worktree, full launch and prompts, and changes no fact, claim or run", async () => {
    story("TASK-1", "Ready");
    story("TASK-2", "Ready");
    const before = snapshot();
    const result = resultOf<PreviewResult>(await preview());
    expect(snapshot()).toEqual(before);
    expect(world.claimCalls).toEqual([]);
    expect(world.hosts).toEqual([]);

    expect(result.refusals).toEqual([]);
    expect(result.story?.story).toBe("TASK-1");
    expect(result.skipped.map((s) => [s.story, s.reason])).toEqual([["TASK-2", "capacity"]]);
    const launch = result.launch;
    const caps = OFFICE_DEFAULTS.tiers.M;
    expect(launch?.branch).toBe("TASK-1/add-a-greeting");
    expect(launch?.worktree).toBe(join(world.worktreeRoot, "TASK-1"));
    expect(launch?.argv[0]).toBe(CLAUDE);
    expect(launch?.argv).toContain("--settings");
    expect(launch).toMatchObject({ model: caps.model, effort: caps.effort });
    expect(launch?.caps).toEqual({
      budgetTokens: caps.budgetTokens,
      maxTurns: caps.maxTurns,
      maxMinutes: caps.maxMinutes,
      loops: caps.loops,
    });
    // Variable names only: the token the daemon holds is neither passed nor shown.
    expect(launch?.envNames).toContain("PATH");
    expect(launch?.envNames).not.toContain("GH_TOKEN");
    expect(JSON.stringify(launch)).not.toContain("/usr/bin:/bin");
    const settings = launch?.files.find((file) => file.name === "claude-settings.json");
    expect(JSON.parse(settings?.content ?? "{}").sandbox.enabled).toBe(true);
    // The short temp root (DIPO-118) is a placeholder, as its name hashes the real run id.
    expect(launch?.envNames).toContain("DIPO_TMP");
    expect(JSON.parse(settings?.content ?? "{}").sandbox.filesystem.allowWrite).toContain(
      join(world.dir, "tmp", "dipo-t-<hash>"),
    );
    expect(existsSync(join(world.dir, "tmp"))).toBe(false);
    expect(launch?.systemFile.text).toContain("developer");
    expect(launch?.taskMessage).toContain("TASK-1");
    expect(launch?.taskMessage).toContain("It greets the name it is given.");
    expect(result.problem).toBeNull();
  });

  it("names the failed pickup gate without storing anything", async () => {
    story("TASK-1", "Ready");
    world.holds.hold("claude-cli", [{ check: "probe", detail: "claude is not logged in" }]);
    world.gate = {
      mode: "pickup",
      passed: false,
      failures: [{ rule: "R15", message: "ready TASK-1 failed R15: unknown is open" }],
    };
    const before = snapshot();
    const result = resultOf<PreviewResult>(await preview({ stories: ["TASK-1"] }));
    expect(snapshot()).toEqual(before);
    // Named, the hold is a note (work.run repeats the checks); the failed gate still skips.
    expect(result.refusals).toEqual([]);
    expect(result.story).toBeNull();
    expect(result.skipped).toEqual([
      {
        story: "TASK-1",
        key: world.keys.get("TASK-1") as string,
        reason: "pickupCheckFailed",
        detail: ["ready TASK-1 failed R15: unknown is open"],
      } as never,
    ]);
  });

  it("shows a hold as a note, not a refusal, when the story is named, as work.run repeats the checks", async () => {
    story("TASK-1", "Ready");
    world.holds.hold("claude-cli", [{ check: "probe", detail: "claude is not logged in" }]);
    const named = resultOf<PreviewResult & { notes?: string[] }>(
      await preview({ stories: ["TASK-1"] }),
    );
    expect(named.refusals).toEqual([]);
    expect(named.notes?.[0]).toContain("The launch checks will be repeated for the named story.");
    expect(named.notes?.[0]).toContain("`dipo run <ID>`");
    expect(named.launch).not.toBeNull();
    const unnamed = resultOf<PreviewResult & { notes?: string[] }>(await preview());
    expect(unnamed.refusals.map((r) => r.check)).toEqual(["adapter"]);
    expect(unnamed.notes).toBeUndefined();
  });

  it("reports a path the plan refuses as the problem", async () => {
    story("TASK-1", "Ready");
    world.worktreeRoot = join(world.dir, "trees [x]");
    const result = resultOf<PreviewResult>(await preview());
    expect(result.launch).toBeNull();
    expect(result.problem).toContain('"["');
  });

  it("reports a refused verify tool as the problem, in the text of the launch's planRefused notice (DIPO-173)", async () => {
    story("TASK-1", "Ready");
    storeResolvedVerify(world.office, { commands: [["bun", "run", "verify"]], cwd: "." });
    world.verifyRefusal =
      "verify runs oxfmt (node_modules/.bin), which needs node (#! line), but node does not resolve on the worker's PATH";
    const before = snapshot();
    const result = resultOf<PreviewResult>(await preview());
    expect(snapshot()).toEqual(before);
    expect(result.story?.story).toBe("TASK-1");
    expect(result.launch).toBeNull();

    // The real launch of the same story refuses with the same PlanError: its notice is the problem.
    const started = resultOf<RunResult>(await run());
    expect(started.started).toEqual([]);
    expect(world.hosts).toEqual([]);
    const notice = entries().find(
      (e) => e.type === "engine.notice" && e.delta["code"] === LAUNCH_NOTICES.planRefused,
    );
    expect(notice).toBeDefined();
    expect(result.problem).toBe(String(notice?.delta["text"]));
    expect(result.problem).toContain(world.verifyRefusal);
  });
});
