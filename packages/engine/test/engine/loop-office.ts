// The review loop of one office, wired as the daemon wires it (DIPO-153; 0019 section 1), for the
// engine's end-to-end scenario test. Real git with a bare `origin` under DIPO_TMP, the pinned
// Backlog CLI and a migrated state database built from fixtures; the Backlog fixture with TASK-1
// made to pass the Ready gate. The engine's own services are real and built the way
// `packages/daemon/src/runs.ts` and `foreground.ts` build them: `composeRuns` (run control, worker
// outcomes, the resumer, the places, the review rounds and the fix rounds), In Review at done
// (`VerifyCommit`), the conflicts of DIPO-149, the story PR and its CI watch (`StoryPrs`), the
// auto-merge of story PRs and the merge gates' commands, and the Done poll. Only these are
// fakes:
//
// - the code host (`LoopHost`), in memory over the bare remote;
// - the worker and the reviewer: each session the engine starts asks the scenario's director for
//   its events (Worker events the Claude CLI adapter can produce, checked against its schema) and
//   the host starter writes them to the run's `events.ndjson` as a worker host would, with the
//   exit line and `exit.json`; a session the director holds stays live until the scenario
//   releases it;
// - the box: every run is a box run (0021, DIPO-240), and a checkout of the story branch the test
//   makes by hand stands in for its box (`standInBox`; dipo makes no worktree, DIPO-349), so a
//   developer session's edits are files the director writes there, and its last part at done is
//   committed on the story branch as dipo commits a part, outside `backlog/`;
// - the launch checks (always pass).
//
// `restart()` stops every service and builds them again over the same state database and
// repository, as a daemon restart does; the new manual clock starts after the old one's time.

import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type CommandReply,
  type IdPrefix,
  type OfficeId,
  RequestId,
  type RunId,
} from "@dipsaus-orchestrator/contract";
import { type TempRepoWithRemote, withBareRemote } from "@dipsaus-orchestrator/testkit";

import { BacklogLane } from "../../src/backlog/lane";
import { executeCommand } from "../../src/commands/execute";
import type { OfficeHandle } from "../../src/db/office";
import { GateStore } from "../../src/gate";
import { EngineGit } from "../../src/git";
import { EVENTS_FILE, EXIT_FILE, hostSocketPath } from "../../src/host/protocol";
import {
  AutoMerge,
  type AutoMergeGuard,
  MergeGates,
  gitStoryMergeOps,
  guardedParkWriter,
  guardedUnparkWriter,
  writeCloseOutSummary,
} from "../../src/merge";
import { officeStatusesReady } from "../../src/office/init";
import { ensurePrivateDir } from "../../src/platform/paths";
import { createSystemIds } from "../../src/platform/ids";
import {
  baseStoryFacts,
  capsOf,
  storyRunBase,
  composeRuns,
  type ComposedRuns,
  findRun,
  gitParkWriter,
  gitStoryOps,
  gitUnparkWriter,
  type HostStarter,
  markBoxCopied,
  pendingBoxCopy,
  runCaps,
  type RunSteering,
  type StoredRun,
  storyHoldsWork,
  StoryConflicts,
  VerifyCommit,
  WorkRun,
} from "../../src/run";
import { type LaunchedHost, recordWorkerHost, runDirectory } from "../../src/runs/worker-hosts";
import { detect } from "../../src/scan/detect";
import { StoryIndex } from "../../src/stories/feature";
import { gitStoryPrOps, StoryPrs } from "../../src/story-pr";
import { encode } from "../../src/workers/claude-cli/encode";
import { REPORT_JSON_SCHEMAS } from "../../src/workers/claude-cli/report-schema";
import { ClaudeWorkerEventSchema } from "../../src/workers/claude-cli/schema";
import { CLAUDE_LOCAL_SETTINGS } from "../../src/workers/claude-cli/settings-check";
import { AdapterHolds } from "../../src/workers/hold";
import type { WorkerPort } from "../../src/workers/port";
import { stubReviewBoxes } from "../run/review-boxes";
import { scriptProblems } from "../../src/workers/scripted";
import type {
  ExitRecord,
  ParseState,
  ReviewReport,
  WorkerEvent,
  WorkerReport,
  WorkerResult,
} from "../../src/workers/types";
import { hasLiveClaim, StoryClaims } from "../../src/worktree";
import { StoryTeardown } from "../../src/worktree/done";
import { backlog, CLI, publish } from "../gate/gated-office";
import { BACKLOG_FIXTURE, type OfficeSetup, officeSetup, resultOf, send } from "../office/helpers";
import { scriptedWorker } from "../workers/scripts";

import { LoopHost, REMOTE_URL } from "./loop-host";
import { backlogStoryStore } from "../../src/backlog/store";

export const TASK_1 = "TASK-1";
export const BRANCH_1 = "TASK-1/add-the-csv-export-command";
export const TASK_FILE_1 = "backlog/tasks/task-1 - Add-the-CSV-export-command.md";

/** The body dipo gives a part commit, so the run's parts are counted (`box/parts.ts`). */
const partBody = (story: string) => `Part 1 of ${story}, delivered from its box by dipo.`;

/** The office's run profile: its verify is `bun test` (CI runs it for a box run). */
const PROFILE = detect({
  texts: { "package.json": JSON.stringify({ name: "fixture", scripts: { verify: "bun test" } }) },
  lockfiles: ["bun.lock"],
  workspaceDirs: [],
  envFiles: [],
});

// ---- the scripted sessions ------------------------------------------------------------------------

export type SessionKind = "implement" | "review";

/** One session the engine started, as the director sees it. */
export interface Session {
  readonly kind: SessionKind;
  readonly runId: string;
  readonly agentId: string;
  /** The session's working directory: the stand-in box of the story or the reviewer's empty one. */
  readonly cwd: string;
  /** The first user message: the task message, a handoff or the fix round's feedback. */
  readonly message: string;
  /** The how-manyth session of this kind in the scenario, from 1. */
  readonly n: number;
}

/** The events a session plays, or `hold`: it stays live until the scenario releases it. */
export type Script = readonly WorkerEvent[] | "hold";

export type Director = (session: Session) => Script | Promise<Script>;

const MODEL = "claude-sonnet-5-5";
const REVIEW_MODEL = "claude-opus-5-5";

export function started(kind: SessionKind, n: number): WorkerEvent {
  return {
    t: "started",
    sessionId: `${kind}-session-${n}`,
    model: kind === "review" ? REVIEW_MODEL : MODEL,
    version: "2.1.296",
    permissionMode: "default",
    tools:
      kind === "review"
        ? ["Read", "Glob", "Grep", "WebSearch", "StructuredOutput"]
        : ["Read", "Edit", "Write", "Glob", "Grep", "Bash", "StructuredOutput"],
  };
}

function totals(kind: SessionKind) {
  return {
    [kind === "review" ? REVIEW_MODEL : MODEL]: {
      input: 1_000,
      output: 400,
      cacheCreate: 0,
      cacheRead: 0,
    },
  };
}

/** TASK-1's done report: both criteria met, the automated test-plan entry done. */
export const DONE: WorkerReport = {
  status: "done",
  criteria: [
    { n: 1, met: true, evidence: "packages/export/csv.ts writes one row per story" },
    { n: 2, met: true, evidence: "packages/export/csv.ts writes the header first" },
  ],
  summary: "The export command writes the stories as CSV.",
  commitSubject: "add the CSV export command",
  testPlan: [
    { n: 1, status: "done", evidence: "packages/export/csv.test.ts checks the rows" },
    { n: 2, status: "manual", evidence: "for the maintainer" },
  ],
};

/** A developer session that reports `report` after its edits. */
export function devScript(n: number, report: WorkerReport = DONE): WorkerEvent[] {
  return [
    started("implement", n),
    { t: "activity", kind: "text" },
    { t: "output", text: "Done." },
    { t: "turn", report, totals: totals("implement"), numTurns: 3, terminal: "completed" },
  ];
}

/** A reviewer session that reports `review`. */
export function reviewScript(n: number, review: ReviewReport): WorkerEvent[] {
  return [
    started("review", n),
    { t: "activity", kind: "tool", tool: "Read", path: "packages/export/csv.ts" },
    {
      t: "turn",
      report: null,
      review,
      totals: totals("review"),
      numTurns: 2,
      terminal: "completed",
    },
  ];
}

/** The reviewer's report that approves both criteria of TASK-1. */
export const APPROVE: ReviewReport = {
  criteria: [
    { n: 1, status: "met", evidence: "packages/export/csv.ts:2 writes one row per story" },
    { n: 2, status: "met", evidence: "packages/export/csv.ts:1 writes the header" },
  ],
  findings: [],
  summary: "The export writes a header and one row per story.",
};

/** The last turn among the events the scripted adapter's parser state holds. */
function lastTurn(state: ParseState): Extract<WorkerEvent, { t: "turn" }> | undefined {
  const list = state["events"];
  return (Array.isArray(list) ? (list as WorkerEvent[]) : [])
    .filter((event): event is Extract<WorkerEvent, { t: "turn" }> => event.t === "turn")
    .at(-1);
}

/** The worker port: the scripted adapter's parser, launch checks that pass, no Claude process. */
function scriptedPort(): WorkerPort {
  const adapter = scriptedWorker({ script: [] });
  return {
    id: "claude-cli",
    reportSchema: REPORT_JSON_SCHEMAS,
    localSettings: CLAUDE_LOCAL_SETTINGS,
    adapter: () => adapter,
    prepare: async (spec) => ({
      ok: true,
      plan: {
        // `argv[1]` names the session's kind for the host starter; nothing is spawned.
        argv: ["/usr/bin/true", spec.kind],
        env: {},
        cwd: spec.workdir,
        files: [],
        stdin: [spec.taskMessage],
      },
    }),
    initialState: () => ({}),
    encode,
    result: (state: ParseState, exit: ExitRecord): WorkerResult => {
      const turn = lastTurn(state);
      // A reviewer's turn carries its report in `review` (0019 section 5).
      if (turn?.review !== undefined && exit.code === 0 && exit.signal === null) {
        return {
          outcome: "done",
          report: null,
          review: turn.review,
          usage: turn.totals,
          sessionId: "review-session",
          resumable: false,
        };
      }
      return adapter.result(state, exit);
    },
    sessionFacts: (state) => ({
      contextTokens: null,
      contextWindow: null,
      lastReport: lastTurn(state)?.report ?? null,
    }),
  };
}

/**
 * The stand-in box of a story branch: a checkout the test makes by hand under the repository's temp
 * folder, made once per branch (dipo makes no worktree for a story, DIPO-349).
 */
async function standInBox(repo: TempRepoWithRemote, branch: string): Promise<string> {
  const dir = join(repo.root, "boxes", branch.replaceAll("/", "_"));
  if (!existsSync(dir)) {
    mkdirSync(join(repo.root, "boxes"), { recursive: true });
    const added = await repo.run(["git", "worktree", "add", "--quiet", dir, branch]);
    if (added.exitCode !== 0) throw new Error(`the stand-in box failed: ${added.stderr}`);
  }
  return dir;
}

// ---- the world --------------------------------------------------------------------------------------

/** One "daemon": the services over the office's state database. */
export interface Daemon {
  readonly s: OfficeSetup;
  readonly office: OfficeHandle;
  readonly engineGit: EngineGit;
  readonly runs: ComposedRuns;
  readonly storyPrs: StoryPrs;
  readonly merge: AutoMerge;
  readonly teardown: StoryTeardown;
  readonly holds: AdapterHolds;
  /** What the services warned about. */
  readonly warnings: string[];
  close(): void;
}

interface HeldSession {
  readonly session: Session;
  readonly eventFile: string;
  readonly runDir: string;
}

export interface LoopWorld {
  readonly repo: TempRepoWithRemote;
  readonly host: LoopHost;
  readonly officeId: OfficeId;
  /** The services in force: a restart replaces them. */
  readonly d: Daemon;
  readonly office: OfficeHandle;
  /** Every session the engine started, in order. */
  readonly sessions: Session[];
  /** Sessions the director holds, by agent id. */
  readonly held: Map<string, HeldSession>;
  director: Director;
  /** Sends a command as the CLI does, confirmed. */
  command(name: string, args: Record<string, unknown>): Promise<CommandReply>;
  /** Plays `events` in the held session of `agent` and ends it. */
  release(agent: string, events: readonly WorkerEvent[]): void;
  /**
   * Runs the engine's polls (the story PR poll, the auto-merge, the Done poll) and waits for its
   * background work, until `done()` holds; throws naming `what` and the office's state after
   * `maxPolls` rounds of polls (400 by default).
   */
  until(what: string, done: () => boolean | Promise<boolean>, maxPolls?: number): Promise<void>;
  /** Stops every service and builds them again over the same database (a daemon restart). */
  restart(): Promise<void>;
}

export interface LoopOptions {
  /** Runs on the fixture after TASK-1 passes the gate and before the office opens. */
  readonly prepare?: (repo: TempRepoWithRemote) => Promise<void>;
  /** `.dipo/office.yaml`, committed on the base before the office opens. */
  readonly officeYaml?: string;
}

let requests = 0;
function requestId(): RequestId {
  requests += 1;
  return RequestId.parse(`01J9ZK5Q8W3V4X6Y7Z${(60_000 + requests).toString().padStart(8, "0")}`);
}

/** The Backlog fixture on a bare `origin` with TASK-1 made to pass the Ready gate. */
export async function withLoopOffice(
  options: LoopOptions,
  fn: (w: LoopWorld) => Promise<void>,
): Promise<void> {
  await withBareRemote(
    async (repo) => {
      mkdirSync(join(repo.dir, "backlog", "archive", "tasks"), { recursive: true });
      if (options.officeYaml !== undefined) {
        mkdirSync(join(repo.dir, ".dipo"), { recursive: true });
        writeFileSync(join(repo.dir, ".dipo", "office.yaml"), options.officeYaml);
      }
      await repo.commitAll("fixture");
      await repo.git("push", "--quiet", "-u", "origin", "main");
      await repo.git("remote", "set-head", "origin", "main");
      // The remote has a GitHub URL, as the code host reads it (PR repository, Done poll), which
      // git rewrites to the bare remote for every fetch and push.
      await repo.git("config", `url.${repo.remote}.insteadOf`, REMOTE_URL);
      await repo.git("remote", "set-url", "origin", REMOTE_URL);
      await backlog(repo, ["milestone", "add", "M0 Walking skeleton"]);
      await backlog(repo, [
        "task",
        "edit",
        TASK_1,
        "--type",
        "feature",
        "-m",
        "m-0",
        "--ref",
        "packages/export/",
      ]);
      await publish(repo, "make TASK-1 pass the gate");
      await options.prepare?.(repo);

      const host = new LoopHost(repo);
      const sessions: Session[] = [];
      const held = new Map<string, HeldSession>();
      let daemon: Daemon | null = null;
      let officeId: OfficeId | null = null;
      const counts: Record<SessionKind, number> = { implement: 0, review: 0 };
      const world: LoopWorld = {
        repo,
        host,
        get officeId() {
          if (officeId === null) throw new Error("the office is not open yet");
          return officeId;
        },
        get d() {
          if (daemon === null) throw new Error("no daemon runs");
          return daemon;
        },
        get office() {
          return world.d.office;
        },
        sessions,
        held,
        director: () => {
          throw new Error("the scenario set no director");
        },
        command: (name, args) =>
          executeCommand(
            { ...world.d.s.deps, ids: createSystemIds(world.d.s.clock) },
            {
              requestId: requestId(),
              name,
              args,
              origin: "cli",
              confirmed: true,
              office: world.officeId,
            },
          ),
        release: (agent, events) => {
          const entry = held.get(agent);
          if (entry === undefined) throw new Error(`no held session ${agent}`);
          held.delete(agent);
          appendSession(entry.eventFile, entry.runDir, entry.session, events, false);
          // The ingestion's stat poll reads the new lines.
          world.d.s.clock.advance(1_000);
        },
        until: async (what, done, maxPolls = 400) => {
          for (let poll = 0; ; poll += 1) {
            const d = world.d;
            await d.runs.control?.idle();
            await d.runs.resumption?.idle();
            await d.runs.fixRounds?.idle();
            if (await done()) return;
            if (poll >= maxPolls) {
              throw new Error(`gave up waiting for ${what} after ${poll} polls\n${stateOf(world)}`);
            }
            await d.storyPrs.retry(world.officeId);
            await d.merge.tick(world.officeId);
            await d.teardown.poll(world.officeId);
            await d.runs.places?.idle();
            if (await done()) return;
            await Bun.sleep(25);
          }
        },
        restart: async () => {
          const before = world.d;
          const at = before.s.clock.now();
          before.close();
          daemon = await buildDaemon(repo, host, hostStarter, {
            after: at + 60_000,
            officeId: world.officeId,
          });
          // The daemon's recovery steps: re-attach, then the fix rounds owed after the stop.
          await daemon.runs.reattacher?.reattach(world.officeId);
          await daemon.runs.fixRounds?.recover(world.officeId);
        },
      };

      // The worker host stand-in: writes the director's events as a host would.
      const hostStarter: HostStarter = {
        start: async (office, run) => {
          const runDir = runDirectory(run.officeDir, run.runId);
          ensurePrivateDir(runDir);
          const eventFile = join(runDir, EVENTS_FILE);
          const kind = run.plan.argv[1] === "review" ? "review" : "implement";
          counts[kind] += 1;
          const branch = findRun(office, run.runId as RunId)?.branch ?? null;
          const session: Session = {
            kind,
            runId: run.runId,
            agentId: run.agentId,
            cwd:
              kind === "implement" && branch !== null
                ? await standInBox(repo, branch)
                : run.plan.cwd,
            message: run.plan.stdin.join(""),
            n: counts[kind],
          };
          sessions.push(session);
          const script = await world.director(session);
          if (script === "hold") {
            held.set(run.agentId, { session, eventFile, runDir });
            appendSession(eventFile, runDir, session, [started(kind, session.n)], true);
          } else {
            appendSession(eventFile, runDir, session, script, false);
          }
          const launched: LaunchedHost = {
            pid: 4242,
            startTimeMs: 0,
            runId: run.runId,
            agentId: run.agentId,
            socketPath: hostSocketPath(join(repo.root, "rt"), run.runId),
            protocolVersion: 1,
            runDir,
            eventFile,
          };
          recordWorkerHost(office, launched, world.d.s.clock, {
            ...(run.processedOffset === undefined ? {} : { processedOffset: run.processedOffset }),
            ...(run.record === undefined ? {} : { record: run.record }),
          });
          return launched;
        },
      };

      daemon = await buildDaemon(repo, host, hostStarter, {});
      officeId = daemon.office.officeId as OfficeId;
      try {
        await fn(world);
      } finally {
        world.d.close();
      }
    },
    { fixture: BACKLOG_FIXTURE },
  );
}

/** What the office holds now, for a scenario that timed out. */
export function stateOf(w: LoopWorld): string {
  const office = w.office;
  const rows = (sql: string) => JSON.stringify(office.all(sql), null, 0);
  return [
    `sessions: ${JSON.stringify(w.sessions.map((s) => [s.kind, s.n, s.runId, s.agentId]))}`,
    `runs: ${rows("select run_id, story_id, ended_at, end_kind from runs where office_id = $office_id")}`,
    `agents: ${rows("select agent_id, role, ended_at, end_reason from agents where office_id = $office_id")}`,
    `parks: ${rows("select reason, detail, resolved_at from parks where office_id = $office_id")}`,
    `prs: ${rows("select pr_number, head_sha, state from story_prs where office_id = $office_id")}`,
    `verdicts: ${rows("select round, verdict, commit_sha from review_verdicts where office_id = $office_id")}`,
    `host: ${JSON.stringify(w.host.calls)}`,
    `warnings: ${JSON.stringify(w.d.warnings)}`,
    `steps: ${rows("select run_id, kind, value from run_steps where office_id = $office_id")}`,
    `log: ${JSON.stringify(
      office
        .all<{ type: string }>(
          "select type from change_log where office_id = $office_id order by seq",
        )
        .map((row) => row.type),
    )}`,
    `notices: ${JSON.stringify(
      office
        .all<{ type: string; delta: string }>(
          "select type, delta from change_log where office_id = $office_id order by seq",
        )
        .filter((row) => row.type === "engine.notice" || row.type === "story.parked")
        .map((row) => row.delta),
    )}`,
  ].join("\n");
}

/** Appends a session's host lines; without `live`, its exit line and `exit.json` too. */
function appendSession(
  eventFile: string,
  runDir: string,
  session: Session,
  events: readonly WorkerEvent[],
  live: boolean,
): void {
  const problems = scriptProblems(events, ClaudeWorkerEventSchema);
  if (problems.length > 0) {
    throw new Error(`the script holds events the adapter cannot produce: ${problems.join(", ")}`);
  }
  const lines = events.map((event, index) => ({
    t: session.n * 1_000 + index,
    ch: "stdout",
    data: JSON.stringify(event),
  }));
  const exit = { code: 0, signal: null };
  if (!live)
    lines.push({ t: session.n * 1_000 + events.length, ch: "exit", data: JSON.stringify(exit) });
  appendFileSync(eventFile, lines.map((line) => `${JSON.stringify(line)}\n`).join(""), {
    mode: 0o600,
  });
  if (live) return;
  const finalOffset = existsSync(eventFile) ? statSync(eventFile).size : 0;
  writeFileSync(
    join(runDir, EXIT_FILE),
    `${JSON.stringify({ run: session.runId, code: 0, signal: null, finalOffset, at: 0 })}\n`,
    { mode: 0o600 },
  );
}

/** The office's services, as the daemon builds them; `after` moves the new clock past a stop. */
async function buildDaemon(
  repo: TempRepoWithRemote,
  host: LoopHost,
  hostStarter: HostStarter,
  restart: { readonly after?: number; readonly officeId?: OfficeId },
): Promise<Daemon> {
  let setup: OfficeSetup | undefined;
  const loaded = (): OfficeSetup => {
    if (setup === undefined) throw new Error("the office setup is not built yet");
    return setup;
  };
  const offices = {
    get: (office: OfficeId) => setup?.manager.get(office),
    config: (office: OfficeId) => setup?.manager.config(office),
  };
  const cli = CLI(repo);
  // dipo's temp root: each reviewer session's read-only copy is made in it.
  mkdirSync(join(repo.root, "tmp"), { recursive: true, mode: 0o700 });
  const engineGit = new EngineGit({ spawn: cli.spawn, env: repo.env });
  const gitOf = (office: OfficeId) => engineGit.forOffice(office);
  const index = new StoryIndex({ git: engineGit, stories: backlogStoryStore(cli), offices });
  const gates = new GateStore({
    git: engineGit,
    stories: backlogStoryStore(cli),
    offices,
    index,
    get clock() {
      return loaded().clock;
    },
    get ids() {
      return loaded().ids;
    },
  });
  const claims = new StoryClaims({ stories: backlogStoryStore(cli), git: gitOf });
  const lane = new BacklogLane({ cli, git: gitOf, liveClaim: hasLiveClaim });
  const base = storyRunBase({ git: gitOf, stories: backlogStoryStore(cli) });
  const officeClock = {
    now: () => loaded().clock.now(),
    setTimeout: (callback: () => void, delayMs: number) =>
      loaded().clock.setTimeout(callback, delayMs),
    clearTimeout: (handle: Parameters<OfficeSetup["clock"]["clearTimeout"]>[0]) =>
      loaded().clock.clearTimeout(handle),
  };
  const warnings: string[] = [];
  const warn = (message: string, fields: Readonly<Record<string, unknown>>) =>
    void warnings.push(`${message} ${JSON.stringify(fields)}`);
  const holds = new AdapterHolds({ clock: officeClock, notify: () => undefined });
  const implemented = (name: string) => loaded().registry.command(name as never) !== undefined;
  // As the daemon wires them: no park or lift reaches a branch while its PR has auto-merge on.
  let mergeRef: AutoMerge | null = null;
  const guard: AutoMergeGuard = (office, branch, write) =>
    mergeRef === null ? write() : mergeRef.guarded(office, branch, write);
  const rawParkWriter = gitParkWriter({ git: gitOf, stories: backlogStoryStore(cli) });
  const parkWriter = guardedParkWriter(rawParkWriter, guard);
  const unparkWriter = guardedUnparkWriter(
    gitUnparkWriter({ git: gitOf, stories: backlogStoryStore(cli) }),
    guard,
  );

  // The story PR and its CI watch (DIPO-144, DIPO-147); every run is a box run (DIPO-299).
  const storyPrs = new StoryPrs({
    host,
    git: gitStoryPrOps({ git: gitOf, stories: backlogStoryStore(cli) }),
    offices,
    clock: officeClock,
    review: host,
    park: { writer: parkWriter, implemented },
    boxRun: () => true,
    mergesStories: true,
    required: host,
    checkout: () => repo.dir,
    secrets: () => [],
  });

  // Conflicts with the base (DIPO-149): no box, so no sync in the held turn; the marker check of
  // dipo's conflicted merges and the record of each merge the auto-merge's hand-off makes stay.
  const conflicts = new StoryConflicts({
    clock: officeClock,
    ids: { next: (prefix: IdPrefix) => loaded().ids.next(prefix) },
    offices,
    git: gitOf,
  });

  // The run of a part, whose stand-in box holds its work.
  const runOf = (runId: string): StoredRun => {
    for (const office of loaded().manager.loadedOffices()) {
      const handle = loaded().manager.get(office);
      const run = handle === undefined ? null : findRun(handle, runId as RunId);
      if (run !== null) return run;
    }
    throw new Error(`no run ${runId}`);
  };
  // The run's caps by its tier, as the daemon reads them (`runCaps` with the tier in force).
  const capsFor = (office: OfficeId, run: StoredRun) => {
    const handle = loaded().manager.get(office);
    const tier = loaded().manager.config(office)?.tiers[run.tier as "S" | "M" | "L"];
    return handle === undefined || tier === undefined ? null : runCaps(handle, run, capsOf(tier));
  };
  const finisher = new VerifyCommit({
    clock: officeClock,
    story: gitStoryOps({ git: gitOf, stories: backlogStoryStore(cli) }),
    profile: () => PROFILE,
    storyPr: storyPrs,
    storyFacts: baseStoryFacts(base),
    conflicts,
    // The stand-in box: its last part is what the worker wrote there outside `backlog/`, committed
    // on top of the branch's tip as dipo commits a part (the branch moves with dipo's own commits).
    parts: {
      isBoxRun: () => true,
      finishLast: async (runId, message, finish) => {
        const run = runOf(runId);
        const box = await standInBox(repo, run.branch ?? "");
        await repo.run(["git", "read-tree", "HEAD"], box);
        await repo.run(["git", "add", "--all", "--", ".", ":(exclude)backlog"], box);
        const staged = await repo.run(["git", "diff", "--cached", "--quiet"], box);
        if (staged.exitCode !== 0) {
          const body = partBody(run.story ?? runId);
          await repo.run(["git", "commit", "--quiet", "-m", message, "-m", body], box);
        }
        const tipOf = async () => (await repo.run(["git", "rev-parse", "HEAD"], box)).stdout.trim();
        const result = await finish({ tip: await tipOf(), branchTip: tipOf });
        return { outcome: { kind: "empty" }, finished: { result } };
      },
    },
  });

  // The daemon's box copy (DIPO-324) for the stand-in box: what the branch got outside it since the
  // oldest pending merge's tip, outside `backlog/`, written into or removed from the stand-in box.
  const copyIntoWorktree = async (office: OfficeId, run: StoredRun): Promise<void> => {
    const handle = loaded().manager.get(office);
    const pending = handle === undefined ? null : pendingBoxCopy(handle, run.runId);
    if (handle === undefined || pending === null || run.branch === null) return;
    const worktree = await standInBox(repo, run.branch);
    const tip = (await repo.run(["git", "rev-parse", "HEAD"], worktree)).stdout.trim();
    const changed = await repo.run(
      ["git", "diff-tree", "-r", "-z", "--no-renames", "--name-status", pending.from, tip],
      worktree,
    );
    const fields = changed.stdout.split("\0").filter((field) => field !== "");
    for (let at = 0; at + 1 < fields.length; at += 2) {
      const status = fields[at] as string;
      const path = fields[at + 1] as string;
      if (path === "backlog" || path.startsWith("backlog/")) continue;
      if (status === "D") {
        await repo.run(["git", "rm", "--quiet", "--force", "--", path], worktree);
      } else {
        await repo.run(["git", "checkout", tip, "--", path], worktree);
      }
    }
    handle.immediate(() => markBoxCopied(handle, run.runId, pending.ids));
  };

  // Nothing is ever sent to a scripted session: its host has its lines already.
  const steering: RunSteering = {
    send: async () => ({ ok: false, reason: "the worker host has exited" }),
  };
  const runs = composeRuns({
    clock: officeClock,
    ids: { next: (prefix: IdPrefix) => loaded().ids.next(prefix) },
    offices,
    worker: scriptedPort(),
    steering,
    hosts: hostStarter,
    git: gitOf,
    base,
    runtimeDir: join(repo.root, "rt"),
    tmpRoot: join(repo.root, "tmp"),
    release: (office, claim, reason) => claims.releaseUnstarted(office, claim, reason),
    warn,
    refreshStory: (office, key) => index.refreshStory(office, key, { quiet: true }),
    mergeReentry: () => mergeRef ?? undefined,
    ingest: { pricing: () => null },
    control: { writer: parkWriter, finisher, implemented },
    outcomes: {
      holds,
      holdsWork: storyHoldsWork(gitStoryOps({ git: gitOf, stories: backlogStoryStore(cli) })),
      unpark: unparkWriter,
      caps: capsFor,
    },
    startsPaused: { holds },
    // Re-attach after a restart (DIPO-57): no scripted host outlives its daemon.
    reattach: {
      probe: async () => null,
      steering,
      adapter: () => scriptedWorker({ script: [] }),
      initialState: () => ({}),
      caps: capsFor,
    },
    ci: (office, runId) => storyPrs.ciState(office, runId),
    boxRun: () => true,
    // Each review session's box is a stand-in: the scripted reviewer needs none (0002).
    reviewBoxes: stubReviewBoxes(),
    // The merges the auto-merge's conflict hand-off made on the branch reach the stand-in box before the worker's
    // next session (DIPO-324), as `BoxCollisions.copyPending` copies them into a real box.
    boxSync: (office, run) => copyIntoWorktree(office, run),
  });
  const { control, outcomes, resumption, permissions, startsPaused, places, fixRounds, launcher } =
    runs;
  if (
    control === null ||
    outcomes === null ||
    resumption === null ||
    startsPaused === null ||
    places === null ||
    fixRounds === null
  ) {
    throw new Error("the run services are not all wired");
  }
  // Each head whose CI stops being pending may start its fix round (DIPO-148).
  storyPrs.onCiFinal((office, runId) => void fixRounds.consider(office, runId));

  const storyMergeGit = gitStoryMergeOps({ git: gitOf, stories: backlogStoryStore(cli) });
  const merge = new AutoMerge({
    host,
    lane: () => undefined,
    offices,
    clock: officeClock,
    labels: host,
    stories: {
      git: storyMergeGit,
      ids: { next: (prefix: IdPrefix) => loaded().ids.next(prefix) },
      labels: host,
      ci: (office, runId) => storyPrs.ciState(office, runId),
      prSync: (office, runId) => storyPrs.sync(office, runId),
      story: baseStoryFacts(base),
      summary: writeCloseOutSummary,
      recordMerge: async (office, run, merged) => {
        if (run.story === null || run.branch === null) return;
        await conflicts.recorded(
          {
            runId: run.runId,
            office,
            story: run.story,
            branch: run.branch,
            startSha: run.startSha ?? "",
            box: "none",
          },
          merged,
        );
      },
      conflict: (office, runId, input) => fixRounds.conflict(office, runId, input),
      // Unguarded, as the daemon wires it: the auto-merge parks inside its own round.
      park: { writer: rawParkWriter, implemented },
      itemMax: () => 3_000,
    },
  });
  mergeRef = merge;
  const mergeGates = new MergeGates({
    labels: host,
    unpark: unparkWriter,
    reject: (office, runId, reject) => fixRounds.reject(office, runId, reject),
    kick: (office) => merge.kick(office),
    view: host,
    prSync: (office, runId) => storyPrs.sync(office, runId),
    refreshStory: (office, key) => index.refreshStory(office, key, { quiet: true }),
    holds: (office, gate, head) => merge.gateHolds(office, gate, head),
    repark: parkWriter,
  });
  const teardown = new StoryTeardown({
    git: gitOf,
    host,
    prCloser: host,
    stories: backlogStoryStore(cli),
    offices,
  });
  const workRun = new WorkRun({
    offices: {
      get: (office) => loaded().manager.get(office),
      config: (office) => loaded().manager.config(office),
      configHash: (office) => loaded().manager.configHash(office),
      configBlocksRuns: (office) => loaded().manager.configBlocksRuns(office),
    },
    base,
    stories: index,
    profiles: { ensureFreshProfile: async () => undefined, verifyResolved: () => null },
    statuses: async (office) => {
      const git = engineGit.forOffice(office);
      if (git === undefined) throw new Error("no git");
      return officeStatusesReady(git);
    },
    startsPaused: (office) => startsPaused.state(office),
    claims,
    gates,
    lane: (office) => lane.forOffice(office),
    launcher,
    places,
  });
  const s = await officeSetup(repo.root, {
    // In the daemon's order (`foreground.ts`).
    features: [
      engineGit.feature,
      claims.feature,
      teardown.feature,
      storyPrs.feature,
      lane.feature,
      index.feature,
      merge.feature,
      gates.feature,
      workRun.feature,
      mergeGates.feature,
      control.feature,
      outcomes.feature,
      permissions.feature,
      startsPaused.feature,
      resumption.feature,
      places.feature,
    ],
  });
  setup = s;
  if (restart.after !== undefined) s.clock.advanceTo(restart.after);
  let officeId = restart.officeId;
  if (officeId === undefined) {
    officeId = resultOf<{ office: OfficeId }>(
      await send(s, "office.open", { path: repo.dir }),
    ).office;
  }
  const access = await s.manager.load(officeId);
  if (!access.ok) throw new Error(`${access.error.code}: ${access.error.message}`);
  return {
    s,
    office: access.office,
    engineGit,
    runs,
    storyPrs,
    merge,
    teardown,
    holds,
    warnings,
    close: () => {
      merge.stop();
      storyPrs.stop();
      teardown.stop();
      startsPaused.close();
      places.close();
      permissions.close();
      control.close();
      runs.ingest.close();
      runs.reattacher?.close();
      index.stop();
      s.state.close();
    },
  };
}

/** The run id `work.run` started for `story`. */
export async function startStory(w: LoopWorld, story: string): Promise<RunId> {
  const result = resultOf<{ started: { story: string; run: string }[] }>(
    await w.command("work.run", { from: w.repo.dir }),
  );
  const run = result.started.find((entry) => entry.story === story)?.run;
  if (run === undefined) {
    throw new Error(`work.run started ${JSON.stringify(result.started)}, not ${story}`);
  }
  return run as RunId;
}
