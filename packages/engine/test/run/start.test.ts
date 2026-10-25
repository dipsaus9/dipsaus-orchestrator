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
import { contextPackOf } from "../../src/context/pack";
import type { Workspace } from "../../src/context/types";
import type { OfficeHandle } from "../../src/db/office";
import type { GateResult } from "../../src/gate/types";
import { nudgeCount } from "../../src/hooks/nudges";
import type { OfficeGit } from "../../src/git/office";
import type { IngestTarget } from "../../src/ingest/ingestor";
import { promptPartsOf, promptTextsOf } from "../../src/prompts/parts";
import { renderSystemFile } from "../../src/prompts/system";
import { executeRead } from "../../src/reads/execute";
import {
  type BaseRead,
  backstopSnapshotOf,
  findRun,
  type HostStarter,
  LAUNCH_NOTICES,
  packageCacheSkippedText,
  RunLauncher,
  runSteps,
  START_FAILED_END,
  WorkRun,
} from "../../src/run";
import { shortTempDir } from "../../src/run/temp-dirs";
import { recordWorkerHost, type LaunchedHost } from "../../src/runs/worker-hosts";
import { addStory } from "../../src/stories/keys";
import {
  claudeCliAdapter,
  claudeLaunchContext,
  claudeSessionFacts,
} from "../../src/workers/claude-cli/adapter";
import { encode } from "../../src/workers/claude-cli/encode";
import { standInPlan } from "./stand-in-plan";
import { type ClaudeParseState, initialState } from "../../src/workers/claude-cli/interpret";
import { REPORT_JSON_SCHEMAS } from "../../src/workers/claude-cli/report-schema";
import { CLAUDE_LOCAL_SETTINGS } from "../../src/workers/claude-cli/settings-check";
import { result as claudeResult } from "../../src/workers/claude-cli/result";
import { AdapterHolds, gateLaunch, type LaunchCheckOutcome } from "../../src/workers/hold";
import type { RunLaunchPaths, WorkerPort } from "../../src/workers/port";
import { type LaunchPlan, type ParseState } from "../../src/workers/types";
import type { ClaimOutcome, ClaimRequest, ClaimSetupFailed } from "../../src/worktree/claim";
import { findClaim, insertClaim, releaseClaim, type ClaimRecord } from "../../src/worktree/records";
import type { SetupOutcome } from "../../src/worktree/setup";
import type { RunBoxes } from "../../src/box/lifetime";
import type { StartTreeCheck } from "../../src/box/parts";
import { BoxError } from "../../src/box/port";
import type { BoxCacheUse, BoxWorkerInstall } from "../../src/box/workers";
import type { RunProfile } from "../../src/scan/detect";
import { addOffice, countRows, openTestState, type TestState } from "../commands/helpers";

const CLAUDE = "/opt/claude/bin/claude";
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
  /** What the box workers were asked (DIPO-271), and whether making a box fails. */
  readonly boxCalls: string[];
  boxFails: boolean;
  /**
   * Whether the launcher has box workers: with them every run is a box run (DIPO-240); the tests
   * of the launch itself leave them out, as a daemon with no box backend has none.
   */
  withBoxes: boolean;
  /** Each install in a box (DIPO-294): its commands, environment and deadline. */
  readonly boxInstalls: {
    commands: readonly (readonly string[])[];
    env: Readonly<Record<string, string>>;
    timeoutMs: number;
  }[];
  /** What the install in the box and the check of its /work give (DIPO-294). */
  boxInstall: BoxWorkerInstall;
  /** What a new box got of the package cache (DIPO-295). */
  boxCache: BoxCacheUse;
  /** Thrown by the install in the box instead of a result, when set. */
  boxInstallThrows: Error | null;
  boxTree: StartTreeCheck;
  /** The office's run profile the launcher reads for the box's install (DIPO-294). */
  profile: RunProfile | null;
  /** The reason of each failed setup, which `claimStory` puts in its `setup.failed` notice. */
  readonly setupFailures: string[];
}

/** A run profile with `install` as its install (DIPO-294); the launcher reads only it and ports. */
function profileWith(install: RunProfile["capabilities"]["install"]): RunProfile {
  return { capabilities: { install }, devPorts: [] } as unknown as RunProfile;
}

const FROZEN_INSTALL = profileWith({
  status: "resolved",
  value: { commands: [["bun", "install", "--frozen-lockfile"]], cwd: "." },
  source: "lockfile",
  confidence: "high",
  evidence: "bun.lock",
} as unknown as RunProfile["capabilities"]["install"]);

let world: World;

beforeEach(async () => {
  const dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "run-start-"));
  const t = await openTestState(dir);
  const office = addOffice(t);
  // The box-token check is sticky, as in the daemon (DIPO-271); memory only here.
  const holds = new AdapterHolds({
    clock: t.clock,
    notify: () => undefined,
    sticky: {
      checks: new Set(["box-token"]),
      liftedBy: "Replace the box login with dipo login box.",
    },
  });
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
    boxCalls: [] as string[],
    boxFails: false,
    withBoxes: false,
    boxInstalls: [] as World["boxInstalls"],
    boxInstall: { ok: true } as BoxWorkerInstall,
    boxCache: { kind: "off" } as BoxCacheUse,
    boxInstallThrows: null,
    boxTree: { kind: "same" } as StartTreeCheck,
    profile: FROZEN_INSTALL,
    setupFailures: [] as string[],
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
    // The Claude parser with a stand-in plan: the Claude CLI plans no developer on the Mac, and
    // these tests launch without box workers (DIPO-240).
    adapter: (paths, config) => ({
      ...claudeCliAdapter(ctxOf(paths, config), { spawn: neverSpawn, clock: t.clock }),
      plan: (spec) => standInPlan(spec, paths, CLAUDE),
    }),
    prepare: async (spec, paths) => {
      const plan = standInPlan(spec, paths, CLAUDE);
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
    // Box workers (DIPO-271), scripted, while the test gives them.
    get boxes(): RunBoxes {
      return (w.withBoxes ? boxes : undefined) as RunBoxes;
    },
    profile: () => w.profile,
  });
  const boxes: RunBoxes = {
    create: async (input) => {
      w.boxCalls.push(`create ${input.runId} at ${input.startCommit} in ${input.runDir}`);
      if (w.boxFails) throw new Error("the image build failed");
      return { name: `dipo-${input.runId}`, cache: w.boxCache };
    },
    discard: async (runId) => {
      w.boxCalls.push(`discard ${runId}`);
    },
    install: async (input) => {
      w.boxCalls.push(`install ${input.runId}`);
      w.boxInstalls.push({
        commands: input.commands,
        env: input.env,
        timeoutMs: input.timeoutMs,
      });
      if (w.boxInstallThrows !== null) throw w.boxInstallThrows;
      return w.boxInstall;
    },
    changedSinceStart: async (input) => {
      w.boxCalls.push(`check ${input.runId} at ${input.startSha}`);
      return w.boxTree;
    },
    has: async () => "ready" as const,
  };

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
          w.setupFailures.push((setup as ClaimSetupFailed).reason);
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

function entries(): { type: string; delta: Record<string, unknown>; run?: string }[] {
  const { epoch } = readLogState(world.office);
  const result = replay(world.office, cursorAt(world.officeId, epoch, 0));
  if (!result.ok) throw new Error(result.error.message);
  return result.entries.map((entry) => ({
    type: entry.type,
    delta: entry.delta as Record<string, unknown>,
    ...(entry.run === undefined ? {} : { run: entry.run }),
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
    // worker.web is on by default (DIPO-164): the developer also has the web tools.
    expect(flag("--tools")).toBe("Read,Edit,Write,Glob,Grep,Bash,WebSearch,WebFetch");
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

    // No nudge yet (DIPO-60).
    expect(nudgeCount(world.office, runId)).toBe(0);
    // The task message's context pack is recorded for the worktree with the head it read and the
    // blob ids of its files (0020 section 6).
    const pack = contextPackOf(world.office, join(world.worktreeRoot, "TASK-1"));
    expect(pack?.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(pack?.blobIds ?? {})).toContain("src/greet.ts");
    expect(pack?.blobIds["src/greet.ts"]).toMatch(/^[0-9a-f]{40}$/);

    // The system file is in the run directory; the task message is the first stdin line.
    const systemFile = flag("--append-system-prompt-file") as string;
    expect(systemFile).toBe(join(world.dir, "repo", ".git", "dipo", "runs", runId, "system.md"));
    expect(readFileSync(systemFile, "utf8")).toContain("developer");
    expect(host?.plan.stdin[0]).toContain("TASK-1");
    expect(host?.plan.env["GH_TOKEN"]).toBeUndefined();
    // No run temp directory or short temp root is made on the Mac: the developer's temp files live
    // in its box (DIPO-240).
    const shortTmp = shortTempDir(join(world.dir, "tmp"), runId);
    expect(existsSync(shortTmp)).toBe(false);
    expect(existsSync(join(world.dir, "tmp"))).toBe(false);

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

  it("plans the M0 developer tools with worker.web false (DIPO-164)", async () => {
    world.config = { ...OFFICE_DEFAULTS, worker: { ...OFFICE_DEFAULTS.worker, web: false } };
    story("TASK-1", "Ready");
    expect(resultOf<RunResult>(await run()).started).toHaveLength(1);
    const [host] = world.hosts;
    const argv: readonly string[] = host?.plan.argv ?? [];
    expect(argv[argv.indexOf("--tools") + 1]).toBe("Read,Edit,Write,Glob,Grep,Bash");
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

  it("takes no backstop snapshot: the developer never works in the Mac worktree (DIPO-240)", async () => {
    story("TASK-1", "Ready");
    const result = resultOf<RunResult>(await run());
    const runId = result.started[0]?.run as RunId;
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
    // No run temp directory was made to begin with (DIPO-240).
    expect(existsSync(join(world.dir, "tmp"))).toBe(false);
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

describe("a box worker's run (DIPO-271)", () => {
  beforeEach(() => {
    world.withBoxes = true;
  });

  it("makes the box of every run, with or without work.run's box (DIPO-240)", async () => {
    story("TASK-1", "Ready");
    const plain = resultOf<RunResult>(await run({ stories: ["TASK-1"] }));
    expect(plain.started).toHaveLength(1);
    expect(world.boxCalls.map((call) => call.split(" ")[0])).toEqual([
      "create",
      "install",
      "check",
    ]);
  });

  it("makes the run's box from the claim's start commit before the launch checks", async () => {
    story("TASK-1", "Ready");
    const boxed = resultOf<RunResult>(await run({ stories: ["TASK-1"], box: true }));
    const runId = boxed.started[0]?.run as string;
    expect(world.boxCalls).toEqual([
      `create ${runId} at ${"b".repeat(40)} in ${join(world.dir, "repo", ".git", "dipo", "runs", runId)}`,
      // Then the box is prepared before the worker (DIPO-294).
      `install ${runId}`,
      `check ${runId} at ${"b".repeat(40)}`,
    ]);
  });

  it("gives a box worker the box contract (DIPO-272)", async () => {
    story("TASK-1", "Ready");
    const boxed = resultOf<RunResult>(await run({ stories: ["TASK-1"], box: true }));
    const runId = boxed.started[0]?.run as string;
    const system = join(world.dir, "repo", ".git", "dipo", "runs", runId, "system.md");
    expect(readFileSync(system, "utf8")).toBe(renderSystemFile("implement-box", "developer"));
    // Its scope section is the forecast, never the write fence (0021 section 13).
    const sent = JSON.parse(world.hosts.at(-1)?.plan.stdin[0] ?? "").message.content as string;
    expect(sent).toContain(
      "The paths the planner expects this story to change (a forecast, not a fence):",
    );
    expect(sent).not.toContain("You may write only these paths");
  });

  it("rolls the claim back when the box cannot be made, with nothing left to delete", async () => {
    story("TASK-1", "Ready");
    world.boxFails = true;
    const result = resultOf<RunResult>(await run({ stories: ["TASK-1"], box: true }));
    expect(result.skipped.map((s) => s.reason)).toEqual(["pickupCheckFailed"]);
    expect(world.hosts).toEqual([]);
    expect(world.setupReleases).toEqual([3]);
    expect(world.boxCalls.filter((call) => call.startsWith("discard"))).toEqual([]);
  });

  it("refuses even a named run while the sticky box-token hold stands, claiming nothing", async () => {
    story("TASK-1", "Ready");
    world.holds.hold("claude-cli", [
      { check: "box-token", detail: "the token was found in a box" },
    ]);
    const reply = await run({ stories: ["TASK-1"], box: true });
    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.error.message).toContain("Replace the box login with dipo login box.");
    expect(world.claimCalls).toEqual([]);
    expect(world.boxCalls).toEqual([]);
  });

  it("deletes the box when the launch checks refuse the run or its host does not start", async () => {
    story("TASK-1", "Ready");
    world.checks = { ok: false, failures: [{ check: "box", detail: "the routes did not start" }] };
    await run({ stories: ["TASK-1"], box: true });
    expect(world.boxCalls.at(-1)).toMatch(/^discard run_/);

    world.checks = { ok: true };
    world.hostFails = true;
    world.boxCalls.length = 0;
    await run({ stories: ["TASK-1"], box: true });
    // The release after a failed host start deletes the box without waiting on it.
    for (let i = 0; i < 10 && world.boxCalls.length < 2; i++) await Promise.resolve();
    expect(world.boxCalls.map((call) => call.split(" ")[0])).toEqual([
      "create",
      "install",
      "check",
      "discard",
    ]);
  });
});

/** The notices of a box run without the package cache (DIPO-295). */
function cacheNotices(): ReturnType<typeof entries> {
  return entries().filter(
    (e) => e.type === "engine.notice" && e.delta["code"] === LAUNCH_NOTICES.packageCacheSkipped,
  );
}

describe("the package cache of a box run (DIPO-295)", () => {
  beforeEach(() => {
    world.withBoxes = true;
  });

  it("starts the run without a notice when the box got the cache", async () => {
    story("TASK-1", "Ready");
    world.boxCache = { kind: "mounted", path: "/cache/key", manager: "bun", filled: false };
    const boxed = resultOf<RunResult>(await run({ stories: ["TASK-1"], box: true }));
    expect(boxed.started).toHaveLength(1);
    expect(cacheNotices()).toEqual([]);
  });

  it("goes on without the cache when the fill failed, and says why in a notice on the run", async () => {
    story("TASK-1", "Ready");
    world.boxCache = { kind: "skipped", reason: "bun exited 1 in the fill box" };
    const boxed = resultOf<RunResult>(await run({ stories: ["TASK-1"], box: true }));
    expect(boxed.started).toHaveLength(1);
    const runId = boxed.started[0]?.run as string;
    expect(world.boxCalls.map((call) => call.split(" ")[0])).toEqual([
      "create",
      "install",
      "check",
    ]);
    const notices = cacheNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.run).toBe(runId);
    expect(notices[0]?.delta["level"]).toBe("warn");
    expect(notices[0]?.delta["text"]).toBe(
      packageCacheSkippedText("TASK-1", "bun exited 1 in the fill box", false),
    );
    expect(String(notices[0]?.delta["text"])).toContain(
      "TASK-1 runs without the package cache: bun exited 1 in the fill box.",
    );
  });

  it("goes on without the cache for an unsupported lockfile, with the reason in the notice", async () => {
    story("TASK-1", "Ready");
    world.boxCache = {
      kind: "skipped",
      reason:
        "the package cache cannot be filled from this base: dipo cannot fill a package cache from yarn.lock; use bun.lock, pnpm-lock.yaml or package-lock.json.",
    };
    const boxed = resultOf<RunResult>(await run({ stories: ["TASK-1"], box: true }));
    expect(boxed.started).toHaveLength(1);
    expect(String(cacheNotices()[0]?.delta["text"])).toContain(
      "from yarn.lock; use bun.lock, pnpm-lock.yaml or package-lock.json. The install in the box",
    );
  });

  it("says so when the install from the cache failed and passed again without it", async () => {
    story("TASK-1", "Ready");
    world.boxCache = { kind: "mounted", path: "/cache/key", manager: "bun", filled: true };
    world.boxInstall = {
      ok: true,
      cacheFallback: "the install (bun install --frozen-lockfile) exited 1 in the box",
    };
    const boxed = resultOf<RunResult>(await run({ stories: ["TASK-1"], box: true }));
    expect(boxed.started).toHaveLength(1);
    expect(cacheNotices().map((e) => e.delta["text"])).toEqual([
      packageCacheSkippedText(
        "TASK-1",
        "the install (bun install --frozen-lockfile) exited 1 in the box",
        true,
      ),
    ]);
  });
});

/**
 * The skipped run's setup failure: the reason `claimStory` puts in the `setup.failed` notice
 * the maintainer sees.
 */
function skipped(result: RunResult): { notice: string } {
  expect(result.started).toEqual([]);
  expect(result.skipped.map((s) => s.reason)).toEqual(["pickupCheckFailed"]);
  return { notice: world.setupFailures.at(-1) ?? "" };
}

describe("the install in a box run's box before its worker (DIPO-294)", () => {
  beforeEach(() => {
    world.withBoxes = true;
  });

  it("runs the profile's install in the box after it is made and before the launch checks and the worker", async () => {
    story("TASK-1", "Ready");
    world.config = {
      ...OFFICE_DEFAULTS,
      timeouts: {
        ...OFFICE_DEFAULTS.timeouts,
        scriptMinutes: { ...OFFICE_DEFAULTS.timeouts.scriptMinutes, install: 7 },
      },
    };
    const boxed = resultOf<RunResult>(await run({ stories: ["TASK-1"], box: true }));
    expect(boxed.started).toHaveLength(1);
    expect(world.boxCalls.map((call) => call.split(" ")[0])).toEqual([
      "create",
      "install",
      "check",
    ]);
    // The run profile's install, the office's install deadline, and the run environment for the
    // box's /work (the box adds its web route); nothing of the Mac worktree's path.
    expect(world.boxInstalls).toEqual([
      {
        commands: [["bun", "install", "--frozen-lockfile"]],
        env: expect.objectContaining({
          DIPO_SLOT: "3",
          DIPO_STORY: "TASK-1",
          DIPO_WORKTREE: "/work",
        }),
        timeoutMs: 7 * 60_000,
      },
    ]);
    expect(JSON.stringify(world.boxInstalls)).not.toContain(world.worktreeRoot);
    expect(world.hosts).toHaveLength(1);
  });

  it("stops the launch on a failed install with its reason in the notice, and deletes the box", async () => {
    story("TASK-1", "Ready");
    world.boxInstall = {
      ok: false,
      reason: "the install (bun install --frozen-lockfile) exited 1 in the box",
      output: "error: lockfile had changes, but lockfile is frozen",
      ended: null,
    };
    const result = resultOf<RunResult>(await run({ stories: ["TASK-1"], box: true }));
    const skip = skipped(result);
    expect(skip.notice).toContain(
      "the install (bun install --frozen-lockfile) exited 1 in the box",
    );
    // The box output stays in the daemon's log, out of the notice.
    expect(skip.notice).not.toContain("lockfile had changes");
    expect(world.boxCalls.map((call) => call.split(" ")[0])).toEqual([
      "create",
      "install",
      "discard",
    ]);
    expect(world.hosts).toEqual([]);
    expect(world.setupReleases).toEqual([3]);
  });

  it("stops the launch on a timed-out install the box could not end, and deletes the box", async () => {
    story("TASK-1", "Ready");
    world.boxInstall = {
      ok: false,
      reason:
        "the install (bun install --frozen-lockfile) timed out after 15 min in the box, and could be ended neither inside the box nor by stopping it",
      output: "",
      ended: "failed",
    };
    const result = resultOf<RunResult>(await run({ stories: ["TASK-1"], box: true }));
    expect(skipped(result).notice).toContain("timed out after 15 min in the box");
    expect(world.boxCalls.at(-1)).toMatch(/^discard run_/);
    expect(world.hosts).toEqual([]);
  });

  it("stops the launch when /work holds files git does not ignore after the install", async () => {
    story("TASK-1", "Ready");
    world.boxTree = { kind: "changed", paths: ["bun.lock", "src/generated.ts"] };
    const result = resultOf<RunResult>(await run({ stories: ["TASK-1"], box: true }));
    const notice = skipped(result).notice;
    expect(notice).toContain(
      "the install left files git does not ignore in the box's /work (bun.lock, src/generated.ts)",
    );
    expect(notice).toContain("bun install --frozen-lockfile");
    expect(world.boxCalls.map((call) => call.split(" ")[0])).toEqual([
      "create",
      "install",
      "check",
      "discard",
    ]);
    expect(world.hosts).toEqual([]);
  });

  it("stops the launch when dipo cannot check /work, as a check that cannot finish proves nothing", async () => {
    story("TASK-1", "Ready");
    world.boxTree = { kind: "unknown", reason: "dipo could not read the box's /work" };
    const result = resultOf<RunResult>(await run({ stories: ["TASK-1"], box: true }));
    expect(skipped(result).notice).toContain(
      "dipo could not check the box's /work against the start commit after the install (dipo could not read the box's /work)",
    );
    expect(world.boxCalls.at(-1)).toMatch(/^discard run_/);
  });

  it("names a box error preparing the box by a fixed text, and cleans any other error", async () => {
    story("TASK-1", "Ready");
    // A box error's message may quote the box or a proxy: only its code is named.
    world.boxInstallThrows = new BoxError(
      "box.routeFailed",
      "the box web route did not start: \u001b[31mquoted\u001b[0m",
    );
    let result = resultOf<RunResult>(await run({ stories: ["TASK-1"], box: true }));
    expect(skipped(result).notice).toBe(
      "the box could not be prepared: dipo's web route for the box did not start (box.routeFailed)",
    );
    expect(world.boxCalls.at(-1)).toMatch(/^discard run_/);
    world.boxInstallThrows = new Error(`a step \u001b]0;title\u0007failed\n${"x".repeat(400)}`);
    result = resultOf<RunResult>(await run({ stories: ["TASK-1"], box: true }));
    const notice = skipped(result).notice;
    expect(notice.startsWith("the box could not be prepared: a step failed x")).toBe(true);
    expect(notice).not.toContain("\u001b");
    expect(notice.length).toBeLessThan(400);
  });

  it("runs no install for a profile without one, but still checks /work", async () => {
    story("TASK-1", "Ready");
    world.profile = profileWith({ status: "unresolved" } as RunProfile["capabilities"]["install"]);
    const boxed = resultOf<RunResult>(await run({ stories: ["TASK-1"], box: true }));
    expect(boxed.started).toHaveLength(1);
    expect(world.boxCalls.map((call) => call.split(" ")[0])).toEqual(["create", "check"]);
  });

  it("stops the launch for an install in conflict or outside the root, as the Mac setup does", async () => {
    story("TASK-1", "Ready");
    world.profile = profileWith({
      status: "conflict",
      candidates: [],
    } as unknown as RunProfile["capabilities"]["install"]);
    let result = resultOf<RunResult>(await run({ stories: ["TASK-1"], box: true }));
    expect(skipped(result).notice).toContain("the run profile's install is in conflict");
    world.profile = profileWith({
      status: "resolved",
      value: { commands: [["bun", "install"]], cwd: "app" },
    } as unknown as RunProfile["capabilities"]["install"]);
    result = resultOf<RunResult>(await run({ stories: ["TASK-1"], box: true }));
    expect(skipped(result).notice).toContain("install runs in app");
    expect(world.boxInstalls).toEqual([]);
    expect(world.boxCalls.filter((call) => call.startsWith("discard"))).toHaveLength(2);
  });

  it("runs the install in the box of a run started without box too (DIPO-240)", async () => {
    story("TASK-1", "Ready");
    resultOf<RunResult>(await run({ stories: ["TASK-1"] }));
    expect(world.boxInstalls).toHaveLength(1);
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
    // The short temp root (DIPO-118) is a placeholder, as its name hashes the real run id.
    expect(launch?.envNames).toContain("DIPO_TMP");
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
});
