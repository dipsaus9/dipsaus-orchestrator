// CI only (0017 section 1): the worker start of a claimed run on real git with a bare `origin` and
// the pinned Backlog CLI (DIPO-74 test plan, AC #9 and #10). Setup is stubbed (DIPO-39 has its own
// tests) and the launch checks are DIPO-43's hold gate with scripted outcomes, so no `claude`
// process ever starts:
// - with the worker start stubbed, `work.run` creates the branch named in the field block, the
//   locked worktree at `<root>/<ID>` and the claim commit, and stops before any worker starts;
// - with the `success-single` recording replayed through FakeProcess in an in-process worker host,
//   the story is claimed with one claim commit, the run emits `work.assigned`, `work.phase setup`
//   and `work.phase build`, and the replay's usage is ingested;
// - a failed sandbox self-test removes the worktree, deletes the new branch, keeps the story Ready
//   and holds the adapter;
// - `work.preview` changes no fact, branch, worktree or run.
// Each case needs several CLI calls, an office load, a fetch and a claim, well over the local
// per-test budget; the same rules run locally against fakes in start.test.ts.

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type CommandReply,
  type OfficeId,
  type ReadReply,
  RequestId,
} from "@dipsaus-orchestrator/contract";
import {
  fakeSpawn,
  ManualClock,
  type TempRepoWithRemote,
  withBareRemote,
} from "@dipsaus-orchestrator/testkit";

import { BacklogLane } from "../../src/backlog/lane";
import { cursorAt, readLogState } from "../../src/changelog/log";
import { replay } from "../../src/changelog/replay";
import { executeCommand } from "../../src/commands/execute";
import type { OfficeConfig } from "../../src/config";
import type { OfficeHandle } from "../../src/db/office";
import { GateStore } from "../../src/gate";
import { EngineGit } from "../../src/git";
import { WorkerHost } from "../../src/host/main";
import { EVENTS_FILE, hostSocketPath, HOSTS_DIR, LAUNCH_FILE } from "../../src/host/protocol";
import { officeStatusesReady } from "../../src/office/init";
import { ensurePrivateDir } from "../../src/platform/paths";
import { createSystemIds } from "../../src/platform/ids";
import { executeRead } from "../../src/reads/execute";
import { cliRunBase, type HostStarter, OfficeIngest, RunLauncher, WorkRun } from "../../src/run";
import { type LaunchedHost, recordWorkerHost, runDirectory } from "../../src/runs/worker-hosts";
import { StoryIndex } from "../../src/stories/feature";
import { claudeCliAdapter, claudeLaunchContext } from "../../src/workers/claude-cli/adapter";
import { initialState } from "../../src/workers/claude-cli/interpret";
import { AdapterHolds, gateLaunch, type LaunchCheckOutcome } from "../../src/workers/hold";
import type { RunLaunchPaths, WorkerPort } from "../../src/workers/port";
import type { LaunchPlan, ParseState } from "../../src/workers/types";
import { hasLiveClaim, StoryClaims } from "../../src/worktree";
import type { SetupOutcome } from "../../src/worktree/setup";
import { countRows } from "../commands/helpers";
import { backlog, CLI, publish } from "../gate/gated-office";
import { BACKLOG_FIXTURE, type OfficeSetup, officeSetup, resultOf, send } from "../office/helpers";
import { ROOMY } from "../worktree/helpers";
import { loadRecording } from "../workers/replay";

const CLAUDE = "/opt/claude/bin/claude";
const BRANCH = "TASK-1/add-the-csv-export-command";

type HostMode = "stub" | "replay";

function neverSpawn(): never {
  throw new Error("no claude process may start in this test");
}

const ctxOf = (paths: RunLaunchPaths, config: OfficeConfig) =>
  claudeLaunchContext(
    { claudePath: CLAUDE, home: "/home/maintainer", env: { PATH: "/usr/bin:/bin" } },
    paths,
    config,
  );

interface Running {
  readonly repo: TempRepoWithRemote;
  readonly s: OfficeSetup;
  readonly officeId: OfficeId;
  readonly office: OfficeHandle;
  readonly holds: AdapterHolds;
  readonly hosts: { runId: string; plan: LaunchPlan }[];
  readonly ingest: OfficeIngest;
}

/** The fixture on a bare `origin` with TASK-1 made to pass the Ready gate. */
async function withRunOffice(
  options: { readonly host: HostMode; readonly checks: LaunchCheckOutcome },
  fn: (r: Running) => Promise<void>,
): Promise<void> {
  await withBareRemote(
    async (repo) => {
      mkdirSync(join(repo.dir, "backlog", "archive", "tasks"), { recursive: true });
      await repo.commitAll("fixture");
      await repo.git("push", "--quiet", "-u", "origin", "main");
      await repo.git("remote", "set-head", "origin", "main");
      await backlog(repo, ["milestone", "add", "M0 Walking skeleton"]);
      await backlog(repo, [
        "task",
        "edit",
        "TASK-1",
        "--type",
        "feature",
        "-m",
        "m-0",
        "--ref",
        "packages/export/",
      ]);
      await publish(repo, "make TASK-1 pass the gate");

      let setup: OfficeSetup | undefined;
      const loaded = (): OfficeSetup => {
        if (setup === undefined) throw new Error("the office setup is not built yet");
        return setup;
      };
      const offices = {
        get: (office: OfficeId) => setup?.manager.get(office),
        config: (office: OfficeId) => setup?.manager.config(office),
      };
      const engineGit = new EngineGit({ spawn: CLI(repo).spawn, env: repo.env });
      const index = new StoryIndex({ git: engineGit, cli: CLI(repo), offices });
      const gates = new GateStore({
        git: engineGit,
        cli: CLI(repo),
        offices,
        get clock() {
          return loaded().clock;
        },
        get ids() {
          return loaded().ids;
        },
      });
      const claims = new StoryClaims({
        cli: CLI(repo),
        git: (office) => engineGit.forOffice(office),
        disk: ROOMY,
      });
      const lane = new BacklogLane({
        cli: CLI(repo),
        git: (office) => engineGit.forOffice(office),
        liveClaim: hasLiveClaim,
      });
      const base = cliRunBase({ git: (office) => engineGit.forOffice(office), cli: CLI(repo) });
      const holds = new AdapterHolds({ clock: new ManualClock(), notify: () => undefined });
      const clock = new ManualClock();
      const worker: WorkerPort = {
        id: "claude-cli",
        adapter: (paths, config) =>
          claudeCliAdapter(ctxOf(paths, config), { spawn: neverSpawn, clock }),
        prepare: async (spec, paths, config) => {
          const plan = claudeCliAdapter(ctxOf(paths, config), { spawn: neverSpawn, clock }).plan(
            spec,
          );
          const gate = await gateLaunch("claude-cli", holds, async () => options.checks);
          return gate.ok ? { ok: true, plan } : gate;
        },
        initialState: (spec) => initialState({ plannedModel: spec.model }) as unknown as ParseState,
      };
      const runtimeDir = join(repo.root, "rt");
      const hosts: Running["hosts"] = [];
      const hostStarter: HostStarter = {
        start: async (office, run) => {
          hosts.push({ runId: run.runId, plan: run.plan });
          const runDir = runDirectory(run.officeDir, run.runId);
          const socketPath = hostSocketPath(runtimeDir, run.runId);
          const host: LaunchedHost = {
            pid: 4242,
            startTimeMs: 0,
            runId: run.runId,
            agentId: run.agentId,
            socketPath,
            protocolVersion: 1,
            runDir,
            eventFile: join(runDir, EVENTS_FILE),
          };
          if (options.host === "replay") {
            // The DIPO-44 host in this process, its worker a FakeProcess replaying the recording.
            ensurePrivateDir(runDir);
            ensurePrivateDir(join(runtimeDir, HOSTS_DIR));
            writeFileSync(
              join(runDir, LAUNCH_FILE),
              JSON.stringify({
                version: 1,
                run: run.runId,
                agent: run.agentId,
                socket: socketPath,
                plan: run.plan,
              }),
              { mode: 0o600 },
            );
            const replayClock = new ManualClock();
            const started = WorkerHost.start({
              runId: run.runId,
              runDir,
              clock: replayClock,
              spawn: fakeSpawn(loadRecording("success-single"), replayClock).spawn,
              killGroup: () => undefined,
              pid: 4242,
            });
            await started.done;
          }
          recordWorkerHost(office, host, loaded().clock);
          return host;
        },
      };
      const ingest = new OfficeIngest({ clock: new ManualClock(), pricing: () => null });
      const launcher = new RunLauncher({
        worker,
        git: (office) => engineGit.forOffice(office),
        setup: async (): Promise<SetupOutcome> =>
          ({
            ok: true,
            slot: 1,
            env: {},
            files: { log: [], skipped: [], envFiles: [], settings: null },
            log: ["setup: done"],
            release: () => undefined,
          }) as unknown as SetupOutcome,
        dependencies: async () => [],
        runtimeDir,
        tmpRoot: join(repo.root, "tmp"),
        hosts: hostStarter,
        ingest,
        release: (office, claim, reason) => claims.releaseUnstarted(office, claim, reason),
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
        adapterHeld: (adapter) => holds.adapterHeld(adapter),
        claims,
        gates,
        lane: (office) => lane.forOffice(office),
        launcher,
      });
      const s = await officeSetup(repo.root, {
        features: [
          engineGit.feature,
          claims.feature,
          lane.feature,
          index.feature,
          gates.feature,
          workRun.feature,
        ],
      });
      setup = s;
      try {
        const { office: officeId } = resultOf<{ office: OfficeId }>(
          await send(s, "office.open", { path: repo.dir }),
        );
        const access = await s.manager.load(officeId);
        if (!access.ok) throw new Error(`${access.error.code}: ${access.error.message}`);
        await fn({ repo, s, officeId, office: access.office, holds, hosts, ingest });
      } finally {
        ingest.close();
        index.stop();
        s.state.close();
      }
    },
    { fixture: BACKLOG_FIXTURE },
  );
}

let count = 0;
function requestId(): RequestId {
  count += 1;
  return RequestId.parse(`01J9ZK5Q8W3V4X6Y7Z${(70_000 + count).toString().padStart(8, "0")}`);
}

function workRunCommand(r: Running): Promise<CommandReply> {
  // Run ids are ULIDs, as the worker host requires.
  return executeCommand(
    { ...r.s.deps, ids: createSystemIds(r.s.clock) },
    {
      requestId: requestId(),
      name: "work.run",
      args: { from: r.repo.dir },
      origin: "cli",
      confirmed: false,
      office: r.officeId,
    },
  );
}

function workPreview(r: Running): Promise<ReadReply> {
  return executeRead(
    { registry: r.s.deps.registry, offices: r.s.deps.offices, clock: r.s.clock },
    { requestId: requestId(), name: "work.preview", args: { office: r.officeId } },
  );
}

function events(r: Running): { type: string; delta: Record<string, unknown> }[] {
  const { epoch } = readLogState(r.office);
  const result = replay(r.office, cursorAt(r.officeId, epoch, 0));
  if (!result.ok) throw new Error(result.error.message);
  return result.entries.map(({ type, delta }) => ({
    type,
    delta: delta as Record<string, unknown>,
  }));
}

/** Branches, worktrees and the base's view of TASK-1, to compare before and after. */
async function gitState(r: Running): Promise<string> {
  const refs = await r.repo.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads");
  const remote = await r.repo.git("ls-remote", "--heads", "origin");
  const worktrees = await r.repo.git("worktree", "list", "--porcelain");
  return [refs, remote, worktrees].join("\n---\n");
}

const READY: LaunchCheckOutcome = { ok: true };

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("the worker start on real git and the Backlog CLI", () => {
    it(
      "creates the branch, the locked worktree and the claim commit, and stops before any worker starts",
      () =>
        withRunOffice({ host: "stub", checks: READY }, async (r) => {
          const result = resultOf<{ started: { story: string; run: string }[] }>(
            await workRunCommand(r),
          );
          expect(result.started.map((s) => s.story)).toEqual(["TASK-1"]);
          const runId = result.started[0]?.run as string;

          const log = await r.repo.git("log", "--format=%s", BRANCH, "-n", "1");
          expect(log.trim()).toBe("TASK-1: status In Progress");
          const main = await r.repo.git("rev-parse", "origin/main");
          expect((await r.repo.git("rev-parse", `${BRANCH}~1`)).trim()).toBe(main.trim());
          const worktrees = await r.repo.git("worktree", "list", "--porcelain");
          const block = worktrees.split("\n\n").find((entry) => entry.includes(`/TASK-1\n`));
          expect(block).toContain(`branch refs/heads/${BRANCH}`);
          expect(block).toContain(`locked dipo ${runId}`);
          // The worker start was stubbed: it got the plan and nothing ran.
          expect(r.hosts.map((h) => h.runId)).toEqual([runId]);
          expect(r.hosts[0]?.plan.argv[0]).toBe(CLAUDE);
        }),
      30_000,
    );

    it(
      "replays success-single through FakeProcess: In Progress, setup and build phases, usage ingested",
      () =>
        withRunOffice({ host: "replay", checks: READY }, async (r) => {
          const result = resultOf<{ started: { story: string; run: string }[] }>(
            await workRunCommand(r),
          );
          expect(result.started.map((s) => s.story)).toEqual(["TASK-1"]);
          const commits = await r.repo.git("rev-list", "--count", `origin/main..${BRANCH}`);
          expect(commits.trim()).toBe("1");
          const phases = events(r)
            .filter((e) => e.type === "work.assigned" || e.type === "work.phase")
            .map((e) => (e.type === "work.phase" ? `phase ${String(e.delta["phase"])}` : e.type));
          expect(phases).toEqual(["work.assigned", "phase setup", "phase build"]);
          const usage = r.office.get<{ n: number; input: number }>(
            "select count(*) as n, sum(input) as input from usage_totals where office_id = $office_id",
          );
          expect(usage?.n).toBeGreaterThan(0);
          expect(usage?.input).toBeGreaterThan(0);
        }),
      30_000,
    );

    it(
      "rolls back a failed sandbox self-test: worktree removed, branch deleted, story Ready, adapter held",
      () =>
        withRunOffice(
          {
            host: "stub",
            checks: {
              ok: false,
              failures: [{ check: "self-test", detail: "the worker wrote into <main>/.git" }],
            },
          },
          async (r) => {
            const before = await gitState(r);
            const result = resultOf<{ started: unknown[]; skipped: { reason: string }[] }>(
              await workRunCommand(r),
            );
            expect(result.started).toEqual([]);
            expect(result.skipped.map((s) => s.reason)).toEqual(["pickupCheckFailed"]);
            expect(await gitState(r)).toBe(before);
            expect(r.hosts).toEqual([]);
            expect(r.holds.adapterHeld("claude-cli")?.check).toBe("self-test");
            const status = await r.repo.run(
              [...CLI(r.repo).command, "task", "view", "TASK-1", "--plain"],
              r.repo.dir,
            );
            expect(status.stdout).toContain("Status: ○ Ready");
            expect(countRows(r.office, "runs")).toBe(0);
          },
        ),
      30_000,
    );

    it(
      "dry-runs without changing any fact, branch, worktree or run",
      () =>
        withRunOffice({ host: "stub", checks: READY }, async (r) => {
          const tables = ["claims", "runs", "agents", "gate_decisions", "change_log", "stories"];
          const rows = () => tables.map((table) => countRows(r.office, table));
          const factsBefore = rows();
          const gitBefore = await gitState(r);
          const reply = await workPreview(r);
          if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`);
          const preview = reply.result as {
            story: { story: string } | null;
            launch: { branch: string; worktree: string; argv: string[] } | null;
          };
          expect(preview.story?.story).toBe("TASK-1");
          expect(preview.launch?.branch).toBe(BRANCH);
          expect(preview.launch?.worktree.endsWith("/TASK-1")).toBe(true);
          expect(preview.launch?.argv[0]).toBe(CLAUDE);
          expect(rows()).toEqual(factsBefore);
          expect(await gitState(r)).toBe(gitBefore);
          expect(r.hosts).toEqual([]);
        }),
      30_000,
    );
  });
}
