// The scan fallback's session as a `session` run (DIPO-310; 0007 and 0008 amendments of
// 2026-10-12, 0019 and 0021 amendments of 2026-10-22). It implements the scan's
// `ScanSessionRunner` through the worker port only, so nothing here names Claude:
//
// - A `runs` row of kind `session`, role `scanner`: no worktree, branch or story key. Its usage is
//   ingested under the office (`usage_totals`, `usage_daily`), so it counts in the office's usage
//   and in the spend alerts.
// - The session runs on the Mac with no box, in an empty folder dipo makes in its temp root
//   (`dipo-scan-<run>-<agent>/session`), every tool off: the worker port plans kind `session` with
//   an empty tool list and the scan's answer schema, the office `scan` block's model, effort,
//   budget and minutes, and one turn plus one schema retry. The launch checks run first, as for a
//   reviewer; a refused check holds the adapter and the session fails.
// - It holds neither the worker nor the reviewer place (0019 amendment of 2026-10-22); the scan
//   fallback runs one per office at a time.
// - dipo stops it at its minute cap and once its budget tokens pass the `scan` block's; a host that
//   never reports its exit is given up two minutes after the cap. At daemon stop `stopAll` sends
//   the stop to every session still running: its host is detached and no daemon follows it after
//   the stop, so without it the caps would no longer hold.
// - A plan limit the session meets ends it as `plan-limit`: the fallback pauses the office's
//   starts (0020) and starts a new session once they lift, never a park.
// - Its host is claimed once started, as a story's is (DIPO-386, 0008): an unclaimed host would
//   stop the session at its launch deadline.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";

import {
  AgentId,
  type Clock,
  type IdSource,
  type OfficeId,
  RunId,
} from "@dipsaus-orchestrator/contract";

import type { OfficeConfig } from "../config";
import { configHash } from "../config/merge";
import type { OfficeHandle } from "../db/office";
import type { OfficeGit } from "../git/office";
import { Ingestor, type IngestAdapter, type IngestedExit } from "../ingest/ingestor";
import { ensurePrivateDir } from "../platform/paths";
import { recordAgent } from "../runs/agents";
import type { LaunchedHost } from "../runs/worker-hosts";
import {
  SCAN_ROLE,
  type ScanSessionRequest,
  type ScanSessionResult,
  type ScanSessionRunner,
} from "../scan/fallback";
import type { RunLaunchPaths, WorkerPort } from "../workers/port";
import { PlanError, type WorkerEvent, type WorkerSpec } from "../workers/types";

import type { RunSteering } from "./control-types";
import { claimHost, connectWhenBound } from "./hosts";
import { type HostStarter, runLaunchPaths, systemHashOf } from "./launch";
import { sessionUuid } from "./prompts";
import type { RunEnd } from "./lifecycle";
import { currentProfileId, endRun, insertRun, recordConfigSnapshot } from "./records";
import { prepareRunTempDirs } from "./temp-dirs";

/** The name prefix of a session's folder in dipo's temp root. */
export const SESSION_FOLDER_PREFIX = "dipo-scan-";
/** The session's system file in its run directory. */
export const SESSION_SYSTEM_FILE = "system-scan.md";
/** How long after its minute cap dipo waits for a stopped session's exit before it gives up. */
export const SESSION_EXIT_GRACE_MS = 2 * 60_000;

export interface SessionRunsDeps {
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly offices: {
    get(office: OfficeId): OfficeHandle | undefined;
    config(office: OfficeId): OfficeConfig | undefined;
  };
  readonly worker: WorkerPort;
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  readonly hosts: HostStarter;
  /** Sends host ops to the running session: the stop at a cap. */
  readonly steering: RunSteering;
  readonly runtimeDir: string;
  /** dipo's temp root: the run temp directories and the session's folder. */
  readonly tmpRoot: string;
  readonly tempOwner?: () => string | undefined;
  readonly onChanged?: (office: OfficeId) => void;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What following one session saw. */
interface Followed {
  /** The ingested exit; null when the host never reported one. */
  readonly end: IngestedExit | null;
  /** Why dipo stopped it (a cap, a refused start); null when it did not. */
  readonly stopped: string | null;
  /** The reset time of a plan limit it met, when it said. */
  readonly resetsAt: number | undefined;
  /** True when the plan limit it met was `credits_required`. */
  readonly credits: boolean;
}

/** The real `ScanSessionRunner`: one `session` run per call. */
export class SessionRuns implements ScanSessionRunner {
  readonly #deps: SessionRunsDeps;
  /** The stop of each session this daemon follows now, by run id. */
  readonly #live = new Map<string, (why: string) => Promise<void>>();

  constructor(deps: SessionRunsDeps) {
    this.#deps = deps;
  }

  /** The run ids of the sessions this daemon follows now. */
  liveRuns(): string[] {
    return [...this.#live.keys()];
  }

  /**
   * Sends the stop to every session still running (daemon stop, DIPO-310) and waits for the
   * sends; each host then ends its process. Never rejects.
   */
  async stopAll(): Promise<void> {
    await Promise.all([...this.#live.values()].map((stop) => stop("the daemon stopped")));
  }

  async run(request: ScanSessionRequest): Promise<ScanSessionResult> {
    const deps = this.#deps;
    const config = deps.offices.config(request.office);
    const git = deps.git(request.office);
    if (config === undefined || git === undefined) {
      return { kind: "failed", runId: null, reason: `office ${request.office} is not loaded` };
    }
    const runId = RunId.parse(deps.ids.next("run"));
    const agent = AgentId.parse(deps.ids.next("agt"));
    let folder: string;
    try {
      folder = join(await realpath(deps.tmpRoot), `${SESSION_FOLDER_PREFIX}${runId}-${agent}`);
      rmSync(folder, { recursive: true, force: true });
      mkdirSync(join(folder, "session"), { recursive: true, mode: 0o700 });
    } catch (error) {
      return {
        kind: "failed",
        runId: null,
        reason: `its folder could not be made: ${messageOf(error)}`,
      };
    }
    try {
      return await this.#run(request, config, git, runId, agent, join(folder, "session"));
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }

  async #run(
    request: ScanSessionRequest,
    config: OfficeConfig,
    git: OfficeGit,
    runId: RunId,
    agent: AgentId,
    workdir: string,
  ): Promise<ScanSessionResult> {
    const deps = this.#deps;
    const office = request.handle;
    const { settings } = request;
    const paths = runLaunchPaths(git, deps, runId, workdir);
    const spec: WorkerSpec = {
      run: runId,
      agent,
      kind: "session",
      workdir,
      model: settings.model,
      effort: settings.effort,
      caps: {
        budgetTokens: settings.budgetTokens,
        maxTurns: settings.maxTurns,
        maxMinutes: settings.maxMinutes,
      },
      systemFile: join(paths.runDir, SESSION_SYSTEM_FILE),
      taskMessage: request.taskMessage,
      web: false,
      session: { id: sessionUuid(agent), resume: false },
      reportSchema: request.schema,
    };
    try {
      ensurePrivateDir(paths.runDir);
      prepareRunTempDirs(paths, runId, deps.tempOwner?.());
      writeFileSync(spec.systemFile, request.systemFile, { mode: 0o600 });
    } catch (error) {
      return {
        kind: "failed",
        runId: null,
        reason: `the run directory could not be prepared: ${messageOf(error)}`,
      };
    }
    let prepared;
    try {
      prepared = await deps.worker.prepare(
        spec,
        paths,
        config,
        sessionUuid(`${agent}:launch-check`),
      );
    } catch (error) {
      const why =
        error instanceof PlanError
          ? `the launch plan refused it: ${error.message}`
          : messageOf(error);
      return { kind: "failed", runId: null, reason: why };
    }
    if (!prepared.ok) {
      return {
        kind: "failed",
        runId: null,
        reason: `a launch check holds the adapter: ${prepared.hold.failures.map((f) => f.detail).join("; ")}`,
      };
    }

    const startedAt = deps.clock.now();
    const hash = configHash(config);
    office.immediate(() => {
      recordConfigSnapshot(office, hash, config, startedAt);
      insertRun(office, {
        runId,
        kind: "session",
        key: null,
        story: null,
        tier: null,
        role: SCAN_ROLE,
        model: settings.model,
        startSha: null,
        branch: null,
        budgetUnit: "tokens",
        budgetLimit: settings.budgetTokens,
        loopCap: 0,
        maxTurns: settings.maxTurns,
        maxMinutes: settings.maxMinutes,
        reviewRoundCap: null,
        configHash: hash,
        overrideKeys: null,
        runProfileId: currentProfileId(office),
        startedAt,
      });
    });
    let host: LaunchedHost;
    try {
      host = await deps.hosts.start(office, {
        runId,
        agentId: agent,
        officeDir: paths.officeDir,
        plan: prepared.plan,
        record: () => {
          recordAgent(office, {
            agentId: agent,
            runId,
            role: SCAN_ROLE,
            model: settings.model,
            effort: settings.effort,
            sessionId: spec.session.id,
            systemHash: systemHashOf(request.systemFile),
            startedAt: deps.clock.now(),
          });
        },
      });
    } catch (error) {
      this.#end(request.office, office, runId, "dropped");
      return { kind: "failed", runId, reason: `its host did not start: ${messageOf(error)}` };
    }
    deps.onChanged?.(request.office);

    const followed = await this.#follow(request, spec, paths, config, host);
    if (followed.end === null) {
      this.#end(request.office, office, runId, "dropped");
      return { kind: "failed", runId, reason: "its host never reported an exit" };
    }
    const result = deps.worker.result(followed.end.state, followed.end.exit);
    if (result.outcome === "plan-limit") {
      this.#end(request.office, office, runId, "dropped");
      return {
        kind: "plan-limit",
        runId,
        ...(followed.resetsAt === undefined ? {} : { resetsAt: followed.resetsAt }),
        ...(followed.credits ? { credits: true } : {}),
      };
    }
    if (followed.stopped === null && result.outcome === "done" && result.answer !== undefined) {
      this.#end(request.office, office, runId, "done");
      return { kind: "answered", runId, answer: result.answer };
    }
    this.#end(request.office, office, runId, "dropped");
    const why =
      followed.stopped === null
        ? (result.detail ?? result.park?.detail ?? `the session ended ${result.outcome}`)
        : `dipo stopped it: ${followed.stopped}`;
    return { kind: "failed", runId, reason: why };
  }

  /**
   * Ingests the session's events until its exit, stopping it at its caps. The host is recorded
   * with its spawned PID and followed from here, so it is claimed (DIPO-386); unclaimed, it would
   * stop the session at its launch deadline.
   */
  #follow(
    request: ScanSessionRequest,
    spec: WorkerSpec,
    paths: RunLaunchPaths,
    config: OfficeConfig,
    host: LaunchedHost,
  ): Promise<Followed> {
    const deps = this.#deps;
    const office = request.handle;
    const runId = RunId.parse(spec.run);
    const { settings } = request;
    const { promise, resolve } = Promise.withResolvers<Followed>();
    let settled = false;
    let overBudget = false;
    let stopped: string | null = null;
    let resetsAt: number | undefined;
    let credits = false;
    const timers: ReturnType<Clock["setTimeout"]>[] = [];
    const finish = (end: IngestedExit | null) => {
      if (settled) return;
      settled = true;
      this.#live.delete(runId);
      for (const timer of timers) deps.clock.clearTimeout(timer);
      // Stopped after the exit's pass committed, outside its hooks.
      queueMicrotask(() => ingestor.close());
      resolve({ end, stopped, resetsAt, credits });
    };
    const stop = (why: string): Promise<void> => {
      if (stopped !== null || settled) return Promise.resolve();
      stopped = why;
      return deps.steering.send(office, runId, deps.worker.encode({ kind: "stop" })).then(
        (sent) => {
          if (!sent.ok) {
            deps.warn?.("stopping a scan session failed", { run: runId, reason: sent.reason });
          }
        },
        (error: unknown) => {
          deps.warn?.("stopping a scan session failed", { run: runId, reason: messageOf(error) });
        },
      );
    };
    const budgetUsed = (): number =>
      office.get<{ n: number }>(
        `select coalesce(sum(input + output + cache_create), 0) as n from usage_totals
          where office_id = $office_id and run_id = $run`,
        { run: runId },
      )?.n ?? 0;
    const ingestor = new Ingestor({
      office,
      clock: deps.clock,
      hooks: {
        // Inside the pass, once a usage or turn event is in the stored totals; it only reads.
        onEventApplied: (_run, _agent, event) => {
          if ((event.t === "usage" || event.t === "turn") && budgetUsed() > settings.budgetTokens) {
            overBudget = true;
          }
        },
        // After the pass committed: the stop is sent here.
        onWorkerEvents: (_run, _agent, events: readonly WorkerEvent[]) => {
          for (const event of events) {
            if (event.t === "limit" && event.creditsRequired === true) credits = true;
            if (event.t === "limit" && event.resetsAt !== undefined) {
              const at = Date.parse(event.resetsAt);
              if (Number.isFinite(at)) resetsAt = at;
            }
            if (event.t === "initRejected" || event.t === "startRefused") void stop(event.reason);
          }
          if (overBudget) void stop(`its budget of ${settings.budgetTokens} tokens was reached`);
        },
        onEnded: (_run, _agent, end) => finish(end),
        onAppended: () => deps.onChanged?.(request.office),
      },
      warn: (message, fields) => deps.warn?.(message, fields),
    });
    this.#live.set(runId, stop);
    void this.#claim(host, () => settled);
    const capMs = settings.maxMinutes * 60_000;
    timers.push(
      deps.clock.setTimeout(
        () => void stop(`its time cap of ${settings.maxMinutes} minutes was reached`),
        capMs,
      ),
      deps.clock.setTimeout(() => finish(null), capMs + SESSION_EXIT_GRACE_MS),
    );
    try {
      ingestor.track({
        run: spec.run,
        agent: spec.agent,
        role: SCAN_ROLE,
        tier: "",
        budgetLimit: settings.budgetTokens,
        model: settings.model,
        adapter: deps.worker.adapter(paths, config) as IngestAdapter,
        initialState: deps.worker.initialState(spec),
      });
    } catch (error) {
      deps.warn?.("ingesting a scan session failed", { run: runId, reason: messageOf(error) });
      void stop("its events could not be ingested");
    }
    return promise;
  }

  /** Connects to the session's new host and claims it; says so when it could not (DIPO-386). */
  async #claim(host: LaunchedHost, settled: () => boolean): Promise<void> {
    const deps = this.#deps;
    const unclaimed = (reason: string) =>
      deps.warn?.("the scan session's host was not claimed; it stops at its launch deadline", {
        run: host.runId,
        reason,
      });
    try {
      const connected = await connectWhenBound(host, deps.clock, settled);
      if (!connected.ok) {
        if (!settled()) unclaimed(connected.reason);
        return;
      }
      try {
        const refused = await claimHost(connected.client, host.pid);
        if (refused !== null) unclaimed(refused);
      } finally {
        connected.client.close();
      }
    } catch (error) {
      unclaimed(messageOf(error));
    }
  }

  /** A session run ends done with its answer, else dropped (0020): nothing waits on it. */
  #end(officeId: OfficeId, office: OfficeHandle, runId: RunId, ending: RunEnd): void {
    const at = this.#deps.clock.now();
    office.immediate(() => endRun(office, runId, at, ending));
    this.#deps.onChanged?.(officeId);
  }
}
