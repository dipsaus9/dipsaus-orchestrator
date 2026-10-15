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
//   fails with a message (`hostSocketSteering`).
// - Host dead with `exit.json`: the remaining events and the exit are processed as ingestion
//   always does; run control and worker outcomes decide the exit.
// - Host dead without `exit.json`: the remaining events are processed; an exit line among them is
//   an exit as above. Otherwise the host is lost: `work.observed host-lost`, then one resume when
//   budget remains and `canResume` holds, else the story parks `interrupted` (`RunOutcomes`).
// - No new host ever starts here: a living host is followed until its exit line, and the run's
//   next session (`RunResumer`) waits for every earlier host of the run to end.
// - After the catch-up the run's caps are checked once, so a run over its caps is stopped at once.
// - A run whose host event file changed (DIPO-45's `ingest.fileChanged`, also one reported before
//   the stop) parks `interrupted` with the detail "event file changed".
//
// Exits ingested but not decided before the stop are `run-outcomes/redispatch`'s; runs whose host
// has an ended agent are left to it.

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
  type WorkerHostRow,
  workerHostsOf,
} from "../runs/worker-hosts";
import { withWorkViews, workRefOf } from "../views/work";
import type { Caps, ParseState } from "../workers/types";

import { CAP_TICK_MS, type RunEnding, type TrackedRun } from "./control";
import { HOST_CONNECT_TIMEOUT_MS } from "./hosts";
import { HOST_LOST_END } from "./outcomes";
import type { ParkOutcome } from "./park";
import { activeRuns, findRun, type StoredRun } from "./records";
import { clearSignals, raiseSignal } from "./signals";

/** The daemon's recovery step that re-attaches worker hosts (0006 decision 7). */
export const REATTACH_STEP = "reattach";

/** `engine.notice` codes of re-attach. */
export const REATTACH_NOTICES = {
  followOnly: "run.followOnly",
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
  | "fileChanged";

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

  /** Re-attaches every active story run of the office; returns what it did per run. */
  async reattach(officeId: OfficeId): Promise<ReattachedRun[]> {
    const office = this.#deps.offices.get(officeId);
    if (office === undefined) return [];
    const done: ReattachedRun[] = [];
    for (const run of activeRuns(office)) {
      if (run.kind !== "story") continue;
      try {
        const outcome = await this.#reattachRun(office, run);
        if (outcome !== null) done.push(outcome);
      } catch (error) {
        this.#deps.warn?.("re-attaching a run failed", {
          office: officeId,
          run: run.runId,
          reason: messageOf(error),
        });
      }
    }
    return done;
  }

  async #reattachRun(office: OfficeHandle, run: StoredRun): Promise<ReattachedRun | null> {
    const deps = this.#deps;
    // Followed by this daemon already, or an exit of it is being decided.
    if (deps.control.isTracked(run.runId) || deps.outcomes?.busy(run.runId) === true) return null;
    const hosts = workerHostsOf(office, run.runId);
    const host = hosts.at(-1);
    if (host === undefined) return null;
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
    const work = this.#workOf(office, run, host, agent);
    if (work === null) return null;
    const alive = await hostAlive(host, deps.probe);

    // A host event file reported changed before the stop (0007 section 5).
    const changed = office.get<{ found: number }>(
      `select 1 as found from ingest_cursors where office_id = $office_id and run_id = $run
        and agent_id = $agent and changed_at is not null`,
      { run: run.runId, agent: host.agentId },
    );
    if (changed !== null) {
      const ending = deps.control.interruptedEnding();
      await deps.control.park(office, run, work, alive ? ending : { ...ending, ops: [] });
      return { run: run.runId, agent: host.agentId, outcome: "fileChanged" };
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
      startedAt: hosts[0]?.startedAt ?? run.startedAt,
      snapshot: null,
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
      if (this.#agentEndedAt(office, followed.agentId) === null) {
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
    host: WorkerHostRow,
    agent: AgentRow | null,
  ): WorkRef | null {
    const known = workRefOf(office, run.runId);
    if (known !== null) {
      return {
        ...known,
        agent: AgentId.parse(host.agentId),
        model: agent?.model ?? known.model,
      };
    }
    if (run.key === null || run.story === null) return null;
    return {
      story: StoryId.parse(run.story),
      key: StoryKey.parse(run.key),
      run: RunId.parse(run.runId),
      agent: AgentId.parse(host.agentId),
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
