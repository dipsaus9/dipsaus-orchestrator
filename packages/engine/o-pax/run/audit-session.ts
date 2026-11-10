// An idea's audit session as a `session` run (0022, 0008, DIPO-452). It implements
// `AuditSessionRunner` through the worker port only, so nothing here names the model:
//
// - A `runs` row of kind `session`, role `auditor`: no story, branch or key. It holds no run slot
//   (the places never count a session run, 0002) and is not the office's planning session: the
//   planning sessions never see it. The model proxy counts its usage like any session's (0008), so
//   it counts in the office's usage and spend alerts.
// - It runs in a planning box of its own (`BoxWorkers.planning`): a read-only copy of the base
//   branch's tip with the backlog, nothing mounted, the box firewall and web proxy, and the model
//   proxy. The worker port plans its own kind, `audit`, which has exactly the planning session's
//   tools; the office's `audit` block gives the model, effort, turns and minutes; the plan passes
//   the contract's `AuditAnswer` as its structured-output schema.
// - It takes one turn: dipo closes its stdin at its first turn end, so it ends after its answer.
//   The watchdog watches it as any session; at `audit.maxMinutes` dipo stops it, and a host that
//   never reports its exit is given up two minutes later. Its box is deleted when it ends.
// - At daemon stop every audit session still running gets the stop; at daemon start an audit run a
//   stopped daemon left open is ended (`recover`), and its ideas, still held, are audited again.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  AgentId,
  AuditAnswer,
  type Clock,
  type IdSource,
  type OfficeId,
  RunId,
} from "@dipsaus-orchestrator/contract";

import { baseCommit } from "../box/image";
import type { BoxSession, BoxWorkers } from "../box/workers";
import type { OfficeConfig } from "../config";
import { configHash } from "../config/merge";
import type { OfficeHandle } from "../db/office";
import type { OfficeGit } from "../git/office";
import { Ingestor, type IngestAdapter, type IngestedExit } from "../ingest/ingestor";
import { ensurePrivateDir } from "../platform/paths";
import { promptParts, recordPromptParts, recordPromptTexts } from "../prompts/parts";
import { recordAgent } from "../records/agents";
import { AUDITOR_ROLE } from "../records/caps";
import type { RunEnd } from "../records/lifecycle";
import { currentProfileId, endRun, insertRun, recordConfigSnapshot } from "../records/run-records";
import { proxyRefusalOf } from "../records/proxy-refusals";
import type { LaunchedHost } from "../records/worker-hosts";
import { toJsonSchema } from "../workers/json-schema";
import type { RunLaunchPaths, WorkerPort } from "../workers/port";
import { PlanError, type JsonSchema, type WorkerEvent, type WorkerSpec } from "../workers/types";

import type { RunSteering } from "./control-types";
import { claimHost, connectWhenBound } from "./hosts";
import type { AuditSessionRequest, AuditSessionResult, AuditSessionRunner } from "./idea-audits";
import { type HostStarter, runLaunchPaths } from "./launch";
import { sessionUuid } from "./prompts";
import { prepareRunTempDirs } from "./temp-dirs";
import { Watchdog, type WatchdogTimeouts } from "./watchdog";

/** The worker kind of an audit session: its own, with the planning session's tools (DIPO-452). */
export const AUDIT_WORKER_KIND = "audit";
/** The daemon's recovery step that ends the audit runs a stopped daemon left open. */
export const AUDIT_RECOVERY_STEP = "audit-recover";
/** The session's system file in its run directory. */
export const AUDIT_SYSTEM_FILE = "system-audit.md";
/** How long after its minute cap dipo waits for a stopped session's exit before it gives up. */
export const AUDIT_EXIT_GRACE_MS = 2 * 60_000;
/** The structured output an audit session's answer must follow: the contract's `AuditAnswer`. */
export const AUDIT_ANSWER_JSON_SCHEMA: JsonSchema = toJsonSchema(AuditAnswer, "input");

export interface AuditSessionsDeps {
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly offices: {
    get(office: OfficeId): OfficeHandle | undefined;
    config(office: OfficeId): OfficeConfig | undefined;
  };
  readonly worker: WorkerPort;
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  /** The planning boxes (`BoxWorkers`); without them no audit session starts. */
  readonly boxes?: Pick<BoxWorkers, "planning" | "endPlanning">;
  readonly hosts: HostStarter;
  /** Sends host ops to the running session: stdin closed at its answer, the stop at its cap. */
  readonly steering: RunSteering;
  /** The base branch's tip the copy holds; `baseCommit` by default. */
  readonly baseCommit?: (git: OfficeGit) => Promise<string>;
  readonly runtimeDir: string;
  readonly tmpRoot: string;
  readonly tempOwner?: () => string | undefined;
  readonly onChanged?: (office: OfficeId) => void;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** One audit session being started or followed. */
interface Audit {
  readonly request: AuditSessionRequest;
  readonly config: OfficeConfig;
  readonly git: OfficeGit;
  readonly run: RunId;
  readonly agent: AgentId;
  readonly paths: RunLaunchPaths & { readonly officeDir: string };
}

/** What following one session saw. */
interface Followed {
  readonly end: IngestedExit | null;
  /** Why dipo stopped it (its cap, a refused start); null when it did not. */
  readonly stopped: string | null;
}

/** The real `AuditSessionRunner`: one `session` run of role `auditor` per call. */
export class AuditSessions implements AuditSessionRunner {
  readonly #deps: AuditSessionsDeps;
  /** The stop of each session this daemon follows now, by run id. */
  readonly #live = new Map<string, (why: string) => Promise<void>>();
  readonly #watchdog: Watchdog;

  constructor(deps: AuditSessionsDeps) {
    this.#deps = deps;
    this.#watchdog = new Watchdog({
      clock: deps.clock,
      timeouts: (office): WatchdogTimeouts | undefined => deps.offices.config(office)?.timeouts,
      onAppended: (office) => deps.onChanged?.(office),
      storyless: () => [],
    });
  }

  /** The run ids of the audit sessions this daemon follows now. */
  liveRuns(): string[] {
    return [...this.#live.keys()];
  }

  /** Daemon stop: the stop to every audit session still running. Never rejects. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.#live.values()].map((stop) => stop("the daemon stopped")));
    this.#watchdog.close();
  }

  /** Daemon start: ends the audit runs of `offices` a stopped daemon left open; returns how many. */
  recover(offices: readonly OfficeId[]): number {
    let ended = 0;
    const at = this.#deps.clock.now();
    const followed = new Set(this.liveRuns());
    for (const office of offices) {
      const handle = this.#deps.offices.get(office);
      if (handle === undefined) continue;
      const left = handle
        .all<{ run_id: string }>(
          `select run_id from runs where office_id = $office_id and kind = 'session'
             and role = $role and ended_at is null`,
          { role: AUDITOR_ROLE },
        )
        .filter((row) => !followed.has(row.run_id));
      for (const row of left) {
        handle.immediate(() => endRun(handle, RunId.parse(row.run_id), at, "dropped"));
        ended += 1;
      }
      if (left.length > 0) this.#deps.onChanged?.(office);
    }
    return ended;
  }

  async run(request: AuditSessionRequest): Promise<AuditSessionResult> {
    const deps = this.#deps;
    const config = deps.offices.config(request.office);
    const git = deps.git(request.office);
    if (config === undefined || git === undefined) {
      return { kind: "failed", runId: null, reason: `office ${request.office} is not loaded` };
    }
    if (deps.boxes === undefined) {
      return {
        kind: "failed",
        runId: null,
        reason: "this daemon has no box backend, and an audit runs only in a read-only box (0008)",
      };
    }
    const run = RunId.parse(deps.ids.next("run"));
    const agent = AgentId.parse(deps.ids.next("agt"));
    const audit: Audit = {
      request,
      config,
      git,
      run,
      agent,
      paths: runLaunchPaths(git, deps, run),
    };
    this.#insert(audit);
    let end: RunEnd = "dropped";
    try {
      const result = await this.#launch(audit, deps.boxes);
      if (result.kind === "answered") end = "done";
      return result;
    } catch (error) {
      return { kind: "failed", runId: run, reason: messageOf(error) };
    } finally {
      const at = deps.clock.now();
      request.handle.immediate(() => endRun(request.handle, run, at, end));
      deps.onChanged?.(request.office);
      await deps.boxes.endPlanning(agent);
    }
  }

  /** The session's run row: no story, no slot, no budget cap beyond its own minutes. */
  #insert(audit: Audit): void {
    const { request, config, run } = audit;
    const handle = request.handle;
    const startedAt = this.#deps.clock.now();
    const hash = configHash(config);
    handle.immediate(() => {
      recordConfigSnapshot(handle, hash, config, startedAt);
      insertRun(handle, {
        runId: run,
        kind: "session",
        key: null,
        story: null,
        tier: null,
        role: AUDITOR_ROLE,
        model: request.settings.model,
        startSha: null,
        branch: null,
        budgetUnit: "tokens",
        budgetLimit: 0,
        loopCap: 0,
        maxTurns: request.settings.maxTurns,
        maxMinutes: request.settings.maxMinutes,
        reviewRoundCap: null,
        configHash: hash,
        overrideKeys: null,
        runProfileId: currentProfileId(handle),
        startedAt,
      });
    });
    this.#deps.onChanged?.(request.office);
  }

  /** The session's spec: kind `audit`, the office's audit settings and the answer's schema. */
  #spec(audit: Audit, taskMessage: string): WorkerSpec {
    const { settings } = audit.request;
    return {
      run: audit.run,
      agent: audit.agent,
      kind: AUDIT_WORKER_KIND,
      workdir: audit.paths.runDir,
      model: settings.model,
      effort: settings.effort,
      caps: { budgetTokens: 0, maxTurns: settings.maxTurns, maxMinutes: settings.maxMinutes },
      systemFile: join(audit.paths.runDir, AUDIT_SYSTEM_FILE),
      taskMessage,
      web: false,
      session: { id: sessionUuid(audit.agent) },
      reportSchema: AUDIT_ANSWER_JSON_SCHEMA,
    };
  }

  async #launch(
    audit: Audit,
    boxes: NonNullable<AuditSessionsDeps["boxes"]>,
  ): Promise<AuditSessionResult> {
    const deps = this.#deps;
    const { request, run, agent, paths } = audit;
    const commit = await (deps.baseCommit ?? defaultBaseCommit)(audit.git);
    const spec = this.#spec(audit, request.taskMessage(commit));
    try {
      ensurePrivateDir(paths.runDir);
      prepareRunTempDirs(paths, run, deps.tempOwner?.());
      writeFileSync(spec.systemFile, request.systemFile, { mode: 0o600 });
    } catch (error) {
      throw new Error(`the run directory could not be prepared: ${messageOf(error)}`, {
        cause: error,
      });
    }
    let place: BoxSession;
    try {
      place = await boxes.planning({
        office: request.office,
        runId: run,
        agent,
        git: audit.git,
        commit,
        systemFile: spec.systemFile,
      });
    } catch (error) {
      throw new Error(`its box could not be made: ${messageOf(error)}`, { cause: error });
    }
    const host = await this.#start(audit, spec, place);
    const followed = await this.#follow(audit, spec, host);
    return this.#resultOf(audit, followed);
  }

  /** Plans the session in its box and starts its host, recording its agent and prompt. */
  async #start(audit: Audit, spec: WorkerSpec, place: BoxSession): Promise<LaunchedHost> {
    const deps = this.#deps;
    const { request, run, agent, paths, config } = audit;
    let prepared;
    try {
      prepared = await deps.worker.prepare(
        spec,
        paths,
        config,
        sessionUuid(`${agent}:launch-check`),
        place,
      );
    } catch (error) {
      throw new Error(
        error instanceof PlanError
          ? `the launch plan refused it: ${error.message}`
          : messageOf(error),
        { cause: error },
      );
    }
    if (!prepared.ok) {
      throw new Error(
        `a launch check holds the adapter: ${prepared.pause.failures.map((f) => f.detail).join("; ")}`,
      );
    }
    const handle = request.handle;
    try {
      return await deps.hosts.start(handle, {
        runId: run,
        agentId: agent,
        officeDir: paths.officeDir,
        plan: prepared.plan,
        record: () => {
          recordAgent(handle, {
            agentId: agent,
            runId: run,
            role: AUDITOR_ROLE,
            model: request.settings.model,
            effort: request.settings.effort,
            sessionId: spec.session.id,
            startedAt: deps.clock.now(),
          });
          const texts = [
            { part: "system" as const, text: request.systemFile },
            { part: "message" as const, text: spec.taskMessage },
          ];
          recordPromptParts(
            handle,
            run,
            agent,
            promptParts(request.systemFile, spec.taskMessage, []),
            deps.clock,
          );
          recordPromptTexts(handle, run, agent, texts, config, deps.clock);
        },
      });
    } catch (error) {
      throw new Error(`its host did not start: ${messageOf(error)}`, { cause: error });
    }
  }

  /** The audit's result from what following it saw: its answer, or why it has none. */
  #resultOf(audit: Audit, followed: Followed): AuditSessionResult {
    const { run } = audit;
    if (followed.end === null) {
      return { kind: "failed", runId: run, reason: "its host never reported an exit" };
    }
    if (followed.stopped !== null) {
      return { kind: "failed", runId: run, reason: `dipo stopped it: ${followed.stopped}` };
    }
    const result = this.#deps.worker.result(followed.end.state, followed.end.exit);
    if (result.outcome === "done" && result.answer !== undefined) {
      return { kind: "answered", runId: run, answer: result.answer };
    }
    // A 429 the model proxy sent at the audit's token cap is that cap, not the plan (DIPO-484).
    const refusal =
      result.outcome === "plan-limit" && result.http429 === true
        ? proxyRefusalOf(audit.request.handle, run, audit.agent, this.#deps.clock.now())
        : null;
    if (refusal !== null) {
      return { kind: "failed", runId: run, reason: `ended capped: ${refusal}` };
    }
    const why =
      result.outcome === "plan-limit"
        ? "the plan's limit stopped the session"
        : (result.detail ?? result.park?.detail ?? `the session ended ${result.outcome}`);
    return { kind: "failed", runId: run, reason: why };
  }

  /**
   * Ingests the session's events until its exit: stdin closed at its first turn end, the stop at
   * its minute cap or a refused start. Its host is claimed once started (DIPO-386).
   */
  #follow(audit: Audit, spec: WorkerSpec, host: LaunchedHost): Promise<Followed> {
    const deps = this.#deps;
    const { request, run, agent, paths, config } = audit;
    const handle = request.handle;
    const { promise, resolve } = Promise.withResolvers<Followed>();
    let settled = false;
    let stopped: string | null = null;
    let closed = false;
    const timers: ReturnType<Clock["setTimeout"]>[] = [];
    const send = (ops: Parameters<RunSteering["send"]>[2], what: string) =>
      deps.steering.send(handle, run, ops).then(
        (sent) => {
          if (!sent.ok)
            deps.warn?.(`${what} of an audit session failed`, { run, reason: sent.reason });
        },
        (error: unknown) => {
          deps.warn?.(`${what} of an audit session failed`, { run, reason: messageOf(error) });
        },
      );
    const finish = (end: IngestedExit | null) => {
      if (settled) return;
      settled = true;
      this.#live.delete(run);
      this.#watchdog.untrack(run);
      for (const timer of timers) deps.clock.clearTimeout(timer);
      // Stopped after the exit's pass committed, outside its hooks.
      queueMicrotask(() => ingestor.close());
      resolve({ end, stopped });
    };
    const stop = (why: string): Promise<void> => {
      if (stopped !== null || settled) return Promise.resolve();
      stopped = why;
      return send(deps.worker.encode({ kind: "stop" }), "the stop");
    };
    // At its first turn end: the session ends after its one answer.
    const closeStdin = () => {
      if (closed || settled) return;
      closed = true;
      void send([{ closeStdin: true }], "closing stdin");
    };
    const ingestor = new Ingestor({
      office: handle,
      clock: deps.clock,
      hooks: {
        onLines: () => this.#watchdog.lineSeen(run),
        onWorkerEvents: (_run, _agent, events: readonly WorkerEvent[]) => {
          for (const event of events) {
            if (event.t === "initRejected" || event.t === "startRefused") void stop(event.reason);
            if (event.t === "turn") closeStdin();
          }
        },
        onEnded: (_run, _agent, end) => finish(end),
        onAppended: () => deps.onChanged?.(request.office),
      },
      warn: (message, fields) => deps.warn?.(message, fields),
    });
    this.#live.set(run, stop);
    this.#watchdog.track(handle, run);
    void this.#claim(host, () => settled);
    const capMs = request.settings.maxMinutes * 60_000;
    timers.push(
      deps.clock.setTimeout(
        () => void stop(`its time cap of ${request.settings.maxMinutes} minutes was reached`),
        capMs,
      ),
      deps.clock.setTimeout(() => finish(null), capMs + AUDIT_EXIT_GRACE_MS),
    );
    try {
      ingestor.track({
        run,
        agent,
        role: AUDITOR_ROLE,
        tier: "",
        budgetLimit: 0,
        model: spec.model,
        adapter: deps.worker.adapter(paths, config) as IngestAdapter,
        initialState: deps.worker.initialState(spec),
      });
    } catch (error) {
      deps.warn?.("ingesting an audit session failed", { run, reason: messageOf(error) });
      void stop("its events could not be ingested");
    }
    return promise;
  }

  /** Connects to the session's new host and claims it; says so when it could not (DIPO-386). */
  async #claim(host: LaunchedHost, settled: () => boolean): Promise<void> {
    const deps = this.#deps;
    const unclaimed = (reason: string) =>
      deps.warn?.("the audit session's host was not claimed; it stops at its launch deadline", {
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
}

/** The tip of `<remote>/<base>`, the commit the audit's copy holds. */
async function defaultBaseCommit(git: OfficeGit): Promise<string> {
  const { commit } = await git.run((session) => baseCommit(git, session));
  return commit;
}
