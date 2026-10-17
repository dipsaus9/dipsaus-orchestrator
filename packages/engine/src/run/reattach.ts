// Re-attach after a daemon restart (DIPO-57; 0006 decisions 7 and 8, 0007 section 5, 0008
// sections 7 and 8, 0009 section 3). A recovery step after reconcile: for every active story run
// of an office, the engine finds its newest worker host and follows it again. Liveness is PID plus
// start time, never the socket.
//
// - Host alive and its socket answers the handshake with the run id: ingestion catches up from
//   `processed_offset`, then follows the host's `advanced` announcements; steering works.
// - Host alive without an answering socket (gone, silent, or a protocol this binary does not
//   speak): follow-only. The row's mode becomes `follow`, the run shows `work.observed
//   follow-only` with a notice, ingestion tails the event file until the exit line, and steering
//   fails with a message (`hostSocketSteering`), except a stop: that reaches the host as one
//   SIGTERM after its PID, start time and command are verified (DIPO-93).
// - Host dead with `exit.json`: the remaining events and the exit are processed as ingestion
//   always does; run control and worker outcomes decide the exit.
// - Host dead without `exit.json`: the remaining events are processed; an exit line among them is
//   an exit as above. Otherwise the host is lost: `work.observed host-lost`, then one resume when
//   budget remains and `canResume` holds, else the story parks `interrupted` (`RunOutcomes`).
// - No new host ever starts here: a living host is followed until its exit line, and the run's
//   next session (`RunResumer`) waits for every earlier host of the run to end.
// - After the catch-up the run's caps are checked once, so a run over its caps is stopped at once.
// - A living host whose run went through a Safe-Chain proxy this daemon does not run (DIPO-84) is
//   stopped and its story parks `interrupted` naming the missing proxy.
// - A run whose host event file changed (DIPO-45's `ingest.fileChanged`, also one reported before
//   the stop) parks `interrupted` with the detail "event file changed".
//
// Exits ingested but not decided before the stop are `run-outcomes/redispatch`'s; runs whose host
// has an ended agent are left to it.
//
// DIPO-93 adds three steps. First, `worker_hosts` rows left pending (written before their spawn)
// are settled by the host's claimed launch or PID marker, or their launch is revoked; a run whose
// only host never started parks `interrupted`. Then the active runs, as above, with the backstop
// snapshot stored with the run. Last, the open hosts of runs that have ended are closed out when
// dead, or followed until they exit, at every restart until their row ends.

import {
  AgentId,
  type Clock,
  type OfficeId,
  RoleId,
  type TimerHandle,
  RunId,
  StoryId,
  StoryKey,
  type WorkRef,
} from "@dipsaus-orchestrator/contract";

import { appendEntries, type NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import { connectHost, type ConnectHostResult } from "../host/client";
import type { HostExitFile } from "../host/protocol";
import type { IngestAdapter, IngestedExit, IngestTarget, PassResult } from "../ingest/ingestor";
import { finalizeAgentUsage } from "../ingest/usage";
import type { ProcessProbe } from "../platform/process";
import {
  exitFileOf,
  hostAlive,
  readHostExit,
  recordHostExit,
  resolvePendingHost,
  type WorkerHostRow,
  workerHostsOf,
} from "../runs/worker-hosts";
import { withWorkViews, workRefOf } from "../views/work";
import type { Caps, ParseState } from "../workers/types";

import { CAP_TICK_MS, type RunEnding, type RunSteering, type TrackedRun } from "./control";
import { HOST_CONNECT_TIMEOUT_MS } from "./hosts";
import { runIntents, sendAsIntent } from "./intents";
import { HOST_LOST_END } from "./outcomes";
import type { ParkOutcome } from "./park";
import { activeRuns, backstopSnapshotOf, capsStartedAt, findRun, type StoredRun } from "./records";
import { clearSignals, raiseSignal } from "./signals";

/** The daemon's recovery step that re-attaches worker hosts (0006 decision 7). */
export const REATTACH_STEP = "reattach";

/** `engine.notice` codes of re-attach. */
export const REATTACH_NOTICES = {
  followOnly: "run.followOnly",
  proxyGone: "run.safeChainProxyGone",
} as const;

/** What re-attach did with one run. */
export type ReattachOutcome =
  /** Followed live with steering. */
  | "steer"
  /** Followed without steering. */
  | "follow"
  /** The host had ended; its exit was handed to run control. */
  | "exited"
  /** The host died without an exit file; handed to worker outcomes. */
  | "hostLost"
  /** The event file changed; the story parks `interrupted`. */
  | "fileChanged"
  /** Its Safe-Chain proxy is gone (DIPO-84); the worker is stopped and the story parks. */
  | "proxyGone"
  /** Its only host was still pending and no host claimed the launch (DIPO-93): parks. */
  | "neverStarted"
  /** A living host of a run that has ended: followed until it exits (DIPO-93). */
  | "followEnded"
  /** A living host of an ended run whose stop had failed: stopped again, then followed (DIPO-93). */
  | "stopAgain"
  /** A dead host of a run that has ended: closed out (DIPO-93). */
  | "closedOut";

/** The intent kinds that end a run and send ops to its host. */
const ENDING_INTENTS: ReadonlySet<string> = new Set(["stop", "cap", "park"]);

/** The detail of the `stop` intent sent again to the host of an ended run (DIPO-93). */
export const STOP_AGAIN_DETAIL =
  "stop again after a restart: the stop that ended the run did not reach its worker host";

/** The park detail of a run whose worker host never started before the daemon stopped. */
export const HOST_NEVER_STARTED =
  "the daemon stopped while it was starting the worker host, and no host started; nothing ran";

export interface ReattachedRun {
  readonly run: RunId;
  readonly agent: string;
  readonly outcome: ReattachOutcome;
}

export interface RunReattacherDeps {
  readonly clock: Clock;
  readonly offices: { get(office: OfficeId): OfficeHandle | undefined };
  /** Liveness by PID and start time (DIPO-23). */
  readonly probe: ProcessProbe;
  /** Connects to a host's socket and handshakes; `connectHost` with the connect timeout by default. */
  readonly connect?: (
    socketPath: string,
    runId: string,
    /** The engine's token for the host (`worker_hosts.engine_token`, DIPO-59). */
    token: string | null,
  ) => Promise<ConnectHostResult>;
  /** Ingestion (`OfficeIngest`). */
  readonly ingest: {
    attach(
      office: OfficeHandle,
      host: Pick<WorkerHostRow, "runId" | "agentId">,
      target: IngestTarget,
      client: Extract<ConnectHostResult, { ok: true }>["client"] | null,
    ): PassResult;
    untrack(office: OfficeId, run: string, agent: string): void;
  };
  /** Run control (`RunControl`). */
  readonly control: {
    track(office: OfficeId, run: TrackedRun): void;
    isTracked(run: string): boolean;
    checkCaps(run: string): boolean;
    onEnded(run: string, agent?: string, end?: IngestedExit): void;
    onHostLost(run: string, agent: string): void;
    interruptedEnding(): RunEnding;
    park(
      office: OfficeHandle,
      run: StoredRun,
      work: WorkRef | undefined,
      ending: RunEnding,
    ): Promise<ParkOutcome>;
  };
  /** Worker outcomes; a run whose exit is being decided there is left alone. */
  readonly outcomes?: { busy(run: string): boolean };
  /** The worker adapter's `interpret` for a run's ingestion; null when the office has none. */
  readonly adapter: (office: OfficeId, run: StoredRun) => IngestAdapter | null;
  /**
   * The parser state an agent's ingestion starts from when it has no cursor yet (its host was
   * recorded, but its ingestion never started before the stop): `WorkerPort.initialState`.
   */
  readonly initialState: (input: {
    readonly office: OfficeId;
    readonly run: StoredRun;
    readonly agent: string;
    readonly model: string;
    readonly resume: boolean;
    readonly previous?: ParseState;
  }) => ParseState;
  /** The run's caps by its tier; the run's budget alone when null. */
  readonly caps: (office: OfficeId, run: StoredRun) => Caps | null;
  readonly onChanged?: (office: OfficeId) => void;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
  /** How often a followed host's liveness is checked; `FOLLOW_CHECK_MS` by default. */
  readonly followCheckMs?: number;
  /**
   * Why a living host cannot go on (DIPO-84): its run was launched through a Safe-Chain proxy
   * that this daemon does not run (it stopped with the previous daemon), so the worker's
   * `httpProxyPort` names a port nobody owns. Null when it can go on. Such a run is stopped and
   * parks `interrupted` with the reason.
   */
  readonly proxyGone?: (office: OfficeId, run: StoredRun, host: WorkerHostRow) => string | null;
  /**
   * Sends host ops (`hostSocketSteering`): a living host of an ended run whose ending could not
   * reach it (its last stop, cap or park intent failed, as when reconcile ran before re-attach) is
   * sent the stop sequence again, by socket or by verified signal (DIPO-93). Without it such a host
   * is only followed.
   */
  readonly steering?: RunSteering;
}

/** How often a follow-only host's liveness is checked by PID and start time: the cap tick. */
export const FOLLOW_CHECK_MS = CAP_TICK_MS;

interface AgentRow {
  model: string;
  session_id: string | null;
  ended_at: number | null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class RunReattacher {
  readonly #deps: RunReattacherDeps;
  readonly #followTimers = new Map<string, TimerHandle>();
  #closed = false;

  constructor(deps: RunReattacherDeps) {
    this.#deps = deps;
  }

  /**
   * Re-attaches every active story run of the office, after settling host rows left pending
   * (DIPO-93), then closes out or follows the open hosts of runs that have ended (DIPO-93);
   * returns what it did per run.
   */
  async reattach(officeId: OfficeId): Promise<ReattachedRun[]> {
    const office = this.#deps.offices.get(officeId);
    if (office === undefined) return [];
    const done: ReattachedRun[] = [];
    const revoked = await this.#resolvePending(office);
    for (const run of activeRuns(office)) {
      if (run.kind !== "story") continue;
      try {
        const outcome = await this.#reattachRun(office, run, revoked.get(run.runId));
        if (outcome !== null) done.push(outcome);
      } catch (error) {
        this.#deps.warn?.("re-attaching a run failed", {
          office: officeId,
          run: run.runId,
          reason: messageOf(error),
        });
      }
    }
    done.push(...(await this.#sweepEnded(office)));
    return done;
  }

  /**
   * Settles every `worker_hosts` row the previous daemon left pending between writing it and
   * recording the spawned host (DIPO-93, `resolvePendingHost`). Returns the agent of each run whose
   * pending host was revoked, which never ran.
   */
  async #resolvePending(office: OfficeHandle): Promise<Map<string, string>> {
    const revoked = new Map<string, string>();
    const rows = office.all<{ run_id: string; agent_id: string }>(
      `select run_id, agent_id from worker_hosts where office_id = $office_id and pending = 1
        order by started_at, rowid`,
    );
    for (const row of rows) {
      const host = workerHostsOf(office, row.run_id).find((h) => h.agentId === row.agent_id);
      if (host === undefined) continue;
      try {
        const resolved = await resolvePendingHost(office, host, this.#deps.probe);
        if (resolved.kind === "revoked") revoked.set(row.run_id, row.agent_id);
        this.#deps.warn?.("a worker host was still pending at the restart", {
          run: row.run_id,
          agent: row.agent_id,
          resolved: resolved.kind,
          ...(resolved.kind === "recorded" ? { pid: resolved.pid, alive: resolved.alive } : {}),
        });
      } catch (error) {
        this.#deps.warn?.("settling a pending worker host failed", {
          run: row.run_id,
          agent: row.agent_id,
          reason: messageOf(error),
        });
      }
    }
    return revoked;
  }

  /**
   * The open hosts of runs that have ended (DIPO-93): a host a park could not stop, still followed
   * when the daemon stopped. A dead one is closed out now (its `exit.json`, or lost); a living one
   * is followed by PID and start time until it exits, then closed out. Its row stays open until
   * then, so every later restart does the same.
   */
  async #sweepEnded(office: OfficeHandle): Promise<ReattachedRun[]> {
    const done: ReattachedRun[] = [];
    const rows = office.all<{ run_id: string; agent_id: string }>(
      `select h.run_id, h.agent_id from worker_hosts h
         join runs r on r.office_id = h.office_id and r.run_id = h.run_id
        where h.office_id = $office_id and h.ended_at is null and h.pending = 0
          and r.ended_at is not null
        order by h.started_at, h.rowid`,
    );
    for (const row of rows) {
      if (this.#followTimers.has(`${row.run_id} ${row.agent_id}`)) continue;
      try {
        const swept = await this.#sweepHost(office, row.run_id, row.agent_id);
        if (swept !== null) done.push(swept);
      } catch (error) {
        this.#deps.warn?.("closing out the worker host of an ended run failed", {
          run: row.run_id,
          agent: row.agent_id,
          reason: messageOf(error),
        });
      }
    }
    return done;
  }

  async #sweepHost(
    office: OfficeHandle,
    runId: string,
    agentId: string,
  ): Promise<ReattachedRun | null> {
    const deps = this.#deps;
    const run = findRun(office, runId as RunId);
    const hosts = workerHostsOf(office, runId);
    const host = hosts.find((h) => h.agentId === agentId);
    if (run === null || host === undefined) return null;
    const adapter = deps.adapter(office.officeId, run);
    if (adapter === null) {
      deps.warn?.("no worker adapter to close out a worker host with", { run: runId });
      return null;
    }
    const agent = office.get<AgentRow>(
      `select model, session_id, ended_at from agents
        where office_id = $office_id and agent_id = $agent`,
      { agent: agentId },
    );
    const work = this.#workOf(office, run, agentId, agent);
    const model = work?.model ?? agent?.model ?? run.model;
    const target: IngestTarget = {
      run: runId,
      agent: agentId,
      role: run.role,
      tier: run.tier ?? "",
      budgetLimit: run.budgetLimit,
      model,
      ...(work === null ? {} : { work }),
      adapter,
      initialState: this.#initialState(office, run, hosts, host, agent, model),
    };
    if (await hostAlive(host, deps.probe)) {
      const stopped = await this.#stopUnreached(office, run);
      this.#watchFollowed(office, run, host, target);
      return { run: run.runId, agent: agentId, outcome: stopped ? "stopAgain" : "followEnded" };
    }
    this.#closeFollowed(office, run, host, target);
    return { run: run.runId, agent: agentId, outcome: "closedOut" };
  }

  /**
   * Sends the stop sequence again to the living host of an ended run when the ending that ended
   * the run could not reach it (DIPO-93): its newest stop, cap or park intent failed, for example
   * because reconcile stopped the run before re-attach had settled its pending host. The stop goes
   * as a new `stop` intent through steering, so a follow-only host gets the verified SIGTERM and
   * nothing unverified is signalled. True when it was sent.
   */
  async #stopUnreached(office: OfficeHandle, run: StoredRun): Promise<boolean> {
    const deps = this.#deps;
    if (deps.steering === undefined) return false;
    const ending = runIntents(office, run.runId)
      .filter((intent) => ENDING_INTENTS.has(intent.kind))
      .at(-1);
    if (ending?.state !== "failed") return false;
    const { error } = await sendAsIntent(office, deps.steering, run.runId, {
      kind: "stop",
      detail: STOP_AGAIN_DETAIL,
      ops: deps.control.interruptedEnding().ops,
      clock: deps.clock,
    }).done;
    if (error !== null) {
      deps.warn?.("stopping the worker host of an ended run again failed", {
        run: run.runId,
        reason: error,
      });
    }
    return error === null;
  }

  /**
   * A run whose only host was revoked while pending (DIPO-93): no worker ever ran. The story parks
   * `interrupted`, keeping its worktree and branch, as for a run lost while the daemon was down.
   */
  async #neverStarted(
    office: OfficeHandle,
    run: StoredRun,
    agentId: string,
  ): Promise<ReattachedRun | null> {
    const work = this.#workOf(office, run, agentId, null);
    if (work === null) return null;
    const ending = this.#deps.control.interruptedEnding();
    await this.#deps.control.park(office, run, work, {
      ...ending,
      ops: [],
      detail: HOST_NEVER_STARTED,
    });
    return { run: run.runId, agent: agentId, outcome: "neverStarted" };
  }

  async #reattachRun(
    office: OfficeHandle,
    run: StoredRun,
    revokedAgent: string | undefined,
  ): Promise<ReattachedRun | null> {
    const deps = this.#deps;
    // Followed by this daemon already, or an exit of it is being decided.
    if (deps.control.isTracked(run.runId) || deps.outcomes?.busy(run.runId) === true) return null;
    const hosts = workerHostsOf(office, run.runId);
    const host = hosts.at(-1);
    if (host === undefined) {
      return revokedAgent === undefined ? null : this.#neverStarted(office, run, revokedAgent);
    }
    const agent = office.get<AgentRow>(
      `select model, session_id, ended_at from agents
        where office_id = $office_id and agent_id = $agent`,
      { agent: host.agentId },
    );
    if (agent?.ended_at != null) {
      // The exit was ingested before the stop: redispatch decides it. Its exit file, which ends
      // where the processed exit line ends, is recorded on the host row.
      const exit = readHostExit(host.runDir);
      if (host.endedAt === null && exit?.run === host.runId) {
        if (exit.finalOffset === host.processedOffset) this.#recordExit(office, host, exit);
      }
      return null;
    }
    const work = this.#workOf(office, run, host.agentId, agent);
    if (work === null) return null;
    const alive = await hostAlive(host, deps.probe);

    // A host event file reported changed before the stop (0007 section 5).
    if (this.#fileChanged(office, run.runId, host.agentId)) {
      const ending = deps.control.interruptedEnding();
      await deps.control.park(office, run, work, alive ? ending : { ...ending, ops: [] });
      return { run: run.runId, agent: host.agentId, outcome: "fileChanged" };
    }

    // A living worker whose Safe-Chain proxy is gone: stopped, never left on a port nobody owns.
    const gone = alive ? (deps.proxyGone?.(office.officeId, run, host) ?? null) : null;
    if (gone !== null) {
      const ending = deps.control.interruptedEnding();
      await deps.control.park(office, run, work, {
        ...ending,
        detail: gone,
        notice: { level: "error", code: REATTACH_NOTICES.proxyGone, text: gone },
      });
      return { run: run.runId, agent: host.agentId, outcome: "proxyGone" };
    }

    const adapter = deps.adapter(office.officeId, run);
    if (adapter === null) {
      deps.warn?.("no worker adapter to re-attach a run with", { run: run.runId });
      return null;
    }
    this.#catchUpOffset(office, hosts, host, agent);
    const target: IngestTarget = {
      run: run.runId,
      agent: host.agentId,
      role: run.role,
      tier: run.tier ?? "",
      budgetLimit: run.budgetLimit,
      model: work.model,
      work,
      adapter,
      initialState: this.#initialState(office, run, hosts, host, agent, work.model),
    };
    deps.control.track(office.officeId, {
      runId: run.runId,
      work,
      caps: deps.caps(office.officeId, run) ?? {
        budgetTokens: run.budgetLimit,
        maxTurns: Number.POSITIVE_INFINITY,
        maxMinutes: Number.POSITIVE_INFINITY,
      },
      // The run's caps count from its first host, as worker outcomes count them.
      startedAt: capsStartedAt(run, hosts[0]?.startedAt),
      // The backstop goes on from the run-start snapshot stored with the run (DIPO-93).
      snapshot: backstopSnapshotOf(office, run.runId),
    });

    if (alive) {
      // As the engine (DIPO-59): only a connection with the token answers the run's hook calls.
      const connected = await (deps.connect ?? this.#connect.bind(this))(
        host.socketPath,
        run.runId,
        host.engineToken,
      );
      if (connected.ok) {
        this.#setMode(office, host, "steer");
        const pass = deps.ingest.attach(office, host, target, connected.client);
        if (pass.status === "fileChanged") {
          return { run: run.runId, agent: host.agentId, outcome: "fileChanged" };
        }
        deps.control.checkCaps(run.runId);
        return { run: run.runId, agent: host.agentId, outcome: "steer" };
      }
      const why =
        connected.reason === "refused"
          ? `it refused the handshake (${connected.error?.code ?? "refused"}: ${connected.error?.message ?? ""})`
          : connected.reason === "timeout"
            ? "it did not answer the handshake in time"
            : "its socket is gone";
      this.#followOnly(office, host, work, why);
      const pass = deps.ingest.attach(office, host, target, null);
      if (pass.status === "fileChanged") {
        return { run: run.runId, agent: host.agentId, outcome: "fileChanged" };
      }
      deps.control.checkCaps(run.runId);
      this.#watchFollowed(office, run, host, target);
      return { run: run.runId, agent: host.agentId, outcome: "follow" };
    }

    return {
      run: run.runId,
      agent: host.agentId,
      outcome: this.#closeDead(office, run, host, target),
    };
  }

  /** A dead host: process what it wrote, then the exit (or its loss). */
  #closeDead(
    office: OfficeHandle,
    run: StoredRun,
    host: WorkerHostRow,
    target: IngestTarget,
  ): ReattachOutcome {
    const deps = this.#deps;
    const exit = exitFileOf(host);
    if (exit !== null) this.#recordExit(office, host, exit);
    const pass = deps.ingest.attach(office, host, target, null);
    if (pass.status === "ended") return "exited";
    if (pass.status === "fileChanged" || pass.status === "stopped") return "fileChanged";
    deps.ingest.untrack(office.officeId, run.runId, host.agentId);
    if (exit !== null) {
      // An exit file without an exit line: the exit as the file says.
      const state = this.#endAgent(office, run.runId, host.agentId);
      deps.control.onEnded(run.runId, host.agentId, {
        exit: { code: exit.code, signal: exit.signal },
        state,
      });
      return "exited";
    }
    deps.control.onHostLost(run.runId, host.agentId);
    return "hostLost";
  }

  /**
   * A followed host is never asked over its socket, so its death without an exit line would go
   * unnoticed: every `FOLLOW_CHECK_MS` its liveness is checked again by PID and start time until
   * its process is gone. The run may have ended meanwhile (a park whose stop could not reach the
   * host), or its agent with an exit line; the checks go on regardless. A dead host of a running
   * run whose agent has not ended is closed out as at the restart (exit file, or lost); any other
   * dead host is closed out on its own (`#closeFollowed`).
   */
  #watchFollowed(
    office: OfficeHandle,
    run: StoredRun,
    host: WorkerHostRow,
    target: IngestTarget,
  ): void {
    const key = `${run.runId} ${host.agentId}`;
    const check = async (): Promise<void> => {
      this.#followTimers.delete(key);
      if (await hostAlive(host, this.#deps.probe)) {
        this.#armFollowed(key, check);
        return;
      }
      const current = findRun(office, run.runId);
      if (current === null) return;
      const row = workerHostsOf(office, run.runId).find((h) => h.agentId === host.agentId) ?? host;
      if (current.endedAt === null && this.#agentEndedAt(office, host.agentId) === null) {
        this.#closeDead(office, current, row, target);
        return;
      }
      this.#closeFollowed(office, current, row, target);
    };
    this.#armFollowed(key, check);
  }

  /** True when ingestion reported the agent's event file changed (0007 section 5). */
  #fileChanged(office: OfficeHandle, run: string, agent: string): boolean {
    return (
      office.get<{ found: number }>(
        `select 1 as found from ingest_cursors where office_id = $office_id and run_id = $run
          and agent_id = $agent and changed_at is not null`,
        { run, agent },
      ) !== null
    );
  }

  #agentEndedAt(office: OfficeHandle, agent: string): number | null {
    return (
      office.get<{ ended_at: number | null }>(
        "select ended_at from agents where office_id = $office_id and agent_id = $agent",
        { agent },
      )?.ended_at ?? null
    );
  }

  /**
   * A followed host that died after its run or its agent ended: nothing is decided any more, so
   * the host row, the agent and its cursor end, its pending output is sent, and the run's
   * `follow-only` signal is cleared while this is the run's newest host. The exit is the host's
   * own `exit.json` when there is one; without it the agent ends `host-lost` unless an end reason
   * (the park's) is already recorded.
   */
  #closeFollowed(
    office: OfficeHandle,
    run: StoredRun,
    followed: WorkerHostRow,
    target: IngestTarget,
  ): void {
    const deps = this.#deps;
    if (run.endedAt !== null) {
      // An ended run is followed by nobody else: one last pass takes the lines the host wrote
      // after the last poll (an exit line among them ends the agent as ingestion always does),
      // then its ingestion stops here. A running run whose agent ended has moved on, and its
      // ingestion and watchdog belong to the next session.
      // An event file reported changed is not read again (0007 section 5).
      if (
        this.#agentEndedAt(office, followed.agentId) === null &&
        !this.#fileChanged(office, run.runId, followed.agentId)
      ) {
        deps.ingest.attach(office, followed, target, null);
      }
      deps.ingest.untrack(office.officeId, run.runId, followed.agentId);
    }
    const agentEnded = this.#agentEndedAt(office, followed.agentId) !== null;
    // The row as the last pass left it, with its processed offset.
    const host =
      workerHostsOf(office, run.runId).find((h) => h.agentId === followed.agentId) ?? followed;
    const own = readHostExit(host.runDir);
    // After its exit line the host's own file ends where the processed lines end; before it, past.
    const exit =
      own?.run === host.runId &&
      (agentEnded
        ? own.finalOffset === host.processedOffset
        : own.finalOffset > host.processedOffset)
        ? own
        : null;
    const at = deps.clock.now();
    const newest = workerHostsOf(office, run.runId).at(-1)?.agentId === host.agentId;
    // The exit as `exit.json` says (its own transaction), then the rest of the close-out.
    if (exit !== null) recordHostExit(office, host.agentId, exit);
    const appended = office.immediate(() => {
      office.run(
        `update worker_hosts set ended_at = coalesce(ended_at, $at)
          where office_id = $office_id and run_id = $run and agent_id = $agent`,
        { at, run: run.runId, agent: host.agentId },
      );
      if (!agentEnded) {
        finalizeAgentUsage(office, run.runId, host.agentId, at);
        office.run(
          `update agents set ended_at = coalesce(ended_at, $at),
             end_reason = coalesce(end_reason, $reason)
           where office_id = $office_id and agent_id = $agent`,
          { at, agent: host.agentId, reason: exit === null ? HOST_LOST_END : "exited" },
        );
      }
      office.run(
        `update ingest_cursors set ended_at = coalesce(ended_at, $at)
          where office_id = $office_id and run_id = $run and agent_id = $agent`,
        { at, run: run.runId, agent: host.agentId },
      );
      const work = target.work;
      if (!newest || work === undefined) return 0;
      const entries: NewEntry[] = clearSignals(office, run.runId, ["follow-only"], at).map(
        (cleared) => ({
          type: "work.observed",
          key: work.key,
          run: work.run,
          delta: {
            work,
            signal: cleared.signal,
            since: new Date(cleared.since).toISOString(),
            clearedAt: new Date(at).toISOString(),
          },
        }),
      );
      if (entries.length === 0) return 0;
      appendEntries(office, withWorkViews(office, entries), { at });
      return entries.length;
    });
    if (appended > 0) deps.onChanged?.(office.officeId);
  }

  #armFollowed(key: string, check: () => Promise<void>): void {
    if (this.#closed) return;
    const timer = this.#deps.clock.setTimeout(() => {
      check().catch((error: unknown) => {
        this.#deps.warn?.("checking a followed worker host failed", {
          host: key,
          reason: messageOf(error),
        });
      });
    }, this.#deps.followCheckMs ?? FOLLOW_CHECK_MS);
    this.#followTimers.set(key, timer);
  }

  /** Stops the liveness checks of followed hosts. */
  close(): void {
    this.#closed = true;
    for (const timer of this.#followTimers.values()) this.#deps.clock.clearTimeout(timer);
    this.#followTimers.clear();
  }

  #connect(socketPath: string, runId: string, token: string | null): Promise<ConnectHostResult> {
    return connectHost(socketPath, {
      runId,
      clock: this.#deps.clock,
      timeoutMs: HOST_CONNECT_TIMEOUT_MS,
      token,
    });
  }

  /** Who works on the run: its newest host's agent. */
  #workOf(
    office: OfficeHandle,
    run: StoredRun,
    agentId: string,
    agent: AgentRow | null,
  ): WorkRef | null {
    const known = workRefOf(office, run.runId);
    if (known !== null) {
      return {
        ...known,
        agent: AgentId.parse(agentId),
        model: agent?.model ?? known.model,
      };
    }
    if (run.key === null || run.story === null) return null;
    return {
      story: StoryId.parse(run.story),
      key: StoryKey.parse(run.key),
      run: RunId.parse(run.runId),
      agent: AgentId.parse(agentId),
      role: RoleId.parse(run.role),
      tier: run.tier ?? "",
      model: agent?.model ?? run.model,
    };
  }

  /**
   * A host recorded without its agent (a binary from before DIPO-57 stopped between the two
   * writes) has no start offset of its own: it starts where the earlier host's lines end.
   */
  #catchUpOffset(
    office: OfficeHandle,
    hosts: readonly WorkerHostRow[],
    host: WorkerHostRow,
    agent: AgentRow | null,
  ): void {
    const previous = hosts.at(-2);
    if (agent !== null || previous === undefined) return;
    const from = previous.finalOffset ?? previous.processedOffset;
    if (host.processedOffset >= from) return;
    office.immediate(() =>
      office.run(
        `update worker_hosts set processed_offset = $from
          where office_id = $office_id and run_id = $run and agent_id = $agent`,
        { from, run: host.runId, agent: host.agentId },
      ),
    );
  }

  /** The parser state for an agent with no cursor yet; ignored when it has one. */
  #initialState(
    office: OfficeHandle,
    run: StoredRun,
    hosts: readonly WorkerHostRow[],
    host: WorkerHostRow,
    agent: AgentRow | null,
    model: string,
  ): ParseState {
    const previous = hosts.at(-2);
    const base = { office: office.officeId, run, agent: host.agentId, model };
    if (previous === undefined) return this.#deps.initialState({ ...base, resume: false });
    const cursor = office.get<{ parse_state: string }>(
      `select parse_state from ingest_cursors
        where office_id = $office_id and run_id = $run and agent_id = $agent`,
      { run: host.runId, agent: previous.agentId },
    );
    const session = office.get<{ session_id: string | null }>(
      "select session_id from agents where office_id = $office_id and agent_id = $agent",
      { agent: previous.agentId },
    )?.session_id;
    const resume = session != null && agent?.session_id === session;
    return this.#deps.initialState({
      ...base,
      resume,
      ...(cursor === null ? {} : { previous: JSON.parse(cursor.parse_state) as ParseState }),
    });
  }

  #setMode(office: OfficeHandle, host: WorkerHostRow, mode: "steer" | "follow"): void {
    if (host.mode === mode) return;
    office.immediate(() =>
      office.run(
        `update worker_hosts set mode = $mode
          where office_id = $office_id and run_id = $run and agent_id = $agent`,
        { mode, run: host.runId, agent: host.agentId },
      ),
    );
  }

  /** Follow-only (0006 decision 8): the mode, the signal and a notice why, in one transaction. */
  #followOnly(office: OfficeHandle, host: WorkerHostRow, work: WorkRef, why: string): void {
    const at = this.#deps.clock.now();
    const appended = office.immediate(() => {
      office.run(
        `update worker_hosts set mode = 'follow'
          where office_id = $office_id and run_id = $run and agent_id = $agent`,
        { run: host.runId, agent: host.agentId },
      );
      const entries: NewEntry[] = [];
      if (raiseSignal(office, work.run, "follow-only", at) !== null) {
        entries.push({
          type: "work.observed",
          key: work.key,
          run: work.run,
          delta: { work, signal: "follow-only", since: new Date(at).toISOString() },
        });
      }
      entries.push({
        type: "engine.notice",
        key: work.key,
        run: work.run,
        delta: {
          level: "warn",
          code: REATTACH_NOTICES.followOnly,
          text: `${work.story}: the worker host (pid ${host.pid}) still runs after the daemon restart, but ${why}. dipo follows its output until it exits; steering is unavailable.`,
        },
      });
      const viewed = withWorkViews(office, entries);
      appendEntries(office, viewed, { at });
      return viewed.length;
    });
    if (appended > 0) this.#deps.onChanged?.(office.officeId);
  }

  #recordExit(office: OfficeHandle, host: WorkerHostRow, exit: HostExitFile | null): void {
    if (exit === null) return;
    recordHostExit(office, host.agentId, exit);
  }

  /**
   * Ends an agent whose exit file was found without its exit line, as ingestion ends one at an
   * exit line: ended `exited`, usage final, cursor ended. Returns its parser state.
   */
  #endAgent(office: OfficeHandle, runId: string, agent: string): ParseState {
    const at = this.#deps.clock.now();
    return office.immediate(() => {
      finalizeAgentUsage(office, runId, agent, at);
      office.run(
        `update agents set ended_at = coalesce(ended_at, $at),
           end_reason = coalesce(end_reason, 'exited')
         where office_id = $office_id and agent_id = $agent`,
        { at, agent },
      );
      office.run(
        `update ingest_cursors set ended_at = coalesce(ended_at, $at)
          where office_id = $office_id and run_id = $run and agent_id = $agent`,
        { at, run: runId, agent },
      );
      const cursor = office.get<{ parse_state: string }>(
        `select parse_state from ingest_cursors
          where office_id = $office_id and run_id = $run and agent_id = $agent`,
        { run: runId, agent },
      );
      return cursor === null ? {} : (JSON.parse(cursor.parse_state) as ParseState);
    });
  }
}
