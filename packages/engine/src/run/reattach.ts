// Re-attach after a daemon restart (DIPO-57; 0005, 0007, 0008). A recovery step after reconcile:
// for every active story run of an office, the engine finds its newest worker host and re-attaches
// it or parks its story. Liveness is PID plus start time, never the socket.
//
// - Host alive and its socket answers the handshake with the run id: ingestion catches up from
//   `processed_offset`, then follows the host's `advanced` announcements; steering works.
// - Host alive, but its socket does not answer (gone, silent, or a protocol this binary does not
//   speak): once its PID, start time and command are verified (`verifyHostForSignal`), it gets one
//   SIGTERM, and its story parks `worker-failed` once it exits. A host that fails the check is
//   never signalled; its story parks at once.
// - Host dead with `exit.json`: the remaining events and the exit are processed as ingestion
//   always does; run control and worker outcomes decide the exit.
// - Host dead without `exit.json`: the remaining events are processed; an exit line among them is
//   an exit as above. Otherwise the host is lost: its agent ends `host-lost` and its story parks
//   `worker-failed`, with no resume.
// - No new host ever starts here, and the run's next session (`RunResumer`) waits for every earlier
//   host of the run to end.
// - After the catch-up the run's caps are checked once, so a run over its caps is stopped at once.
// - A living developer host of a run with no box record (an earlier binary's Mac session, from
//   before every run was a box run; DIPO-240) is stopped with an error notice, and its story parks
//   `worker-failed`; its next session runs in a box.
// - A run whose host event file changed parks `worker-failed` with the detail "event file
//   changed".
//
// Before the active runs, `worker_hosts` rows left pending (written before their spawn) are
// settled. Their `launch.json` is removed first, so a host that has not read it starts nothing. A
// host that answers on the row's socket with its PID, running `dipo daemon worker-host <run>` and
// started after the row, is recorded and re-attached. A pending host is never signalled: until its
// launch deadline (`hostLaunchDeadline` of the row, the value its `launch.json` carried) the row
// stays and its socket is asked again, in the background, so a host that binds late is still
// re-attached; a host no daemon claimed by then stops itself (DIPO-386). At the deadline the row
// goes and the story parks `worker-failed`. After them, the open hosts of runs that have ended are
// closed out when dead, or sent one verified SIGTERM and closed out once they exit.
//
// Exits ingested but not decided before the stop are `run-outcomes/redispatch`'s; runs whose host
// has an ended agent are left to it.

import { rmSync } from "node:fs";
import { join } from "node:path";

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

import { appendEntries } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import { connectHost, type ConnectHostResult } from "../host/client";
import { LAUNCH_FILE, OP_SINCE, type HostExitFile } from "../host/protocol";
import type { IngestAdapter, IngestedExit, IngestTarget, PassResult } from "../ingest/ingestor";
import {
  isWorkerHostArgv,
  type ProcessProbe,
  type SignalProcess,
  START_TIME_TOLERANCE_MS,
} from "../platform/process";
import { endAgent } from "../records/agents";
import {
  deletePendingHost,
  exitFileOf,
  hostAlive,
  readHostExit,
  recordHostExit,
  recordPendingPid,
  setProcessedOffset,
  signalVerifiedHost,
  type WorkerHostRow,
  workerHostsOf,
} from "../records/worker-hosts";
import { withWorkViews, workRefOf } from "../views/work";
import type { Caps, ParseState } from "../workers/types";

import { REVIEWER_ROLE, runCaps } from "../records/caps";
import { CAP_TICK_MS, type RunEnding, type TrackedRun } from "./control";
import {
  claimHost,
  HOST_CONNECT_RETRY_MS,
  HOST_CONNECT_TIMEOUT_MS,
  hostLaunchDeadline,
} from "./hosts";
import { HOST_LOST_WHY } from "./outcome-types";
import { HOST_LOST_END } from "./outcomes";
import type { ParkOutcome } from "./park";
import { activeRuns, capsStartedAt, findRun, type StoredRun } from "../records/run-records";

/** The daemon's recovery step that re-attaches worker hosts (0005). */
export const REATTACH_STEP = "reattach";

/** `engine.notice` codes of re-attach. */
export const REATTACH_NOTICES = {
  hostStopped: "run.hostStopped",
  macSession: "run.macSessionStopped",
} as const;

/** What re-attach did with one run. */
export type ReattachOutcome =
  /** Followed live with steering. */
  | "steer"
  /** Alive, but its socket did not answer: stopped by one verified SIGTERM, or parked at once. */
  | "stopped"
  /** The host had ended; its exit was handed to run control. */
  | "exited"
  /** The host died without an exit file: its agent ends `host-lost` and the story parks. */
  | "hostLost"
  /** The event file changed; the story parks `worker-failed`. */
  | "fileChanged"
  /** A developer session on the Mac, outside a box (DIPO-240): stopped, and the story parks. */
  | "macSession"
  /** Its only host was still pending and no live process matched it: parks. */
  | "neverStarted"
  /** A living host of a run that has ended: one verified SIGTERM, closed out once it exits. */
  | "stopEnded"
  /** A dead host of a run that has ended: closed out. */
  | "closedOut";

/** Why a developer session on the Mac was stopped at re-attach (DIPO-240). */
export function macSessionText(run: Pick<StoredRun, "story" | "runId">): string {
  return (
    `${run.story ?? run.runId} was stopped: its developer session ran on the Mac, outside a box, ` +
    "as an earlier dipo started it. A developer runs only in its box now; resume the story to " +
    "go on in one."
  );
}

/** The park detail of a run whose pending worker host matched no live process (0005). */
export const HOST_NEVER_STARTED =
  "the daemon stopped while it was starting the worker host, and no live host matches its record; nothing ran";

/** The park detail of a run whose living host did not answer after a restart (0005). */
export function hostStoppedDetail(pid: number, why: string, refused: string | null): string {
  return refused === null
    ? `the worker host (pid ${pid}) still ran after the daemon restart, but ${why}; dipo sent it SIGTERM and it exited`
    : `the worker host (pid ${pid}) still ran after the daemon restart, but ${why}; dipo sent it no signal, because ${refused}`;
}

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
  /** The one-process signal for the verified SIGTERM: `signalProcess` in the daemon. */
  readonly signal: SignalProcess;
  /** Connects to a host's socket and handshakes; `connectHost` with the connect timeout by default. */
  readonly connect?: (socketPath: string, runId: string) => Promise<ConnectHostResult>;
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
  /** How often a signalled host's liveness is checked; `EXIT_CHECK_MS` by default. */
  readonly exitCheckMs?: number;
  /**
   * True when a run directory says its run is a box run (`BOX_RUN_FILE`, DIPO-240). With it, a
   * living developer host of a run without one (a Mac session an earlier binary started) is
   * stopped, never followed: a developer runs only in its box. Without it no host is checked.
   */
  readonly boxRecord?: (runDir: string) => boolean;
}

/** What one ask of a pending row found (DIPO-386). */
type PendingAsk =
  | { readonly kind: "live"; readonly pid: number; readonly startTimeMs: number }
  /** Nothing answered on the row's socket. */
  | { readonly kind: "waiting" }
  /** A host answered, but its PID failed the identity check. */
  | { readonly kind: "refused" };

/** True when the row's host carries a launch deadline: one this binary's protocol started. */
function hasLaunchDeadline(host: Pick<WorkerHostRow, "protocolVersion">): boolean {
  return host.protocolVersion >= OP_SINCE.claim;
}

/** How a pending row was settled by one ask (DIPO-386). */
type Settled = "matched" | "waiting" | "refused" | "unmatched";

/** How often a signalled host's liveness is checked by PID and start time: the cap tick. */
export const EXIT_CHECK_MS = CAP_TICK_MS;

interface AgentRow {
  model: string;
  session_id: string | null;
  ended_at: number | null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => clock.setTimeout(resolve, ms));
}

export class RunReattacher {
  readonly #deps: RunReattacherDeps;
  readonly #exitTimers = new Map<string, TimerHandle>();
  /** Pending rows whose socket is asked again until their launch deadline, by `run agent`. */
  readonly #waiting = new Set<string>();
  #closed = false;

  constructor(deps: RunReattacherDeps) {
    this.#deps = deps;
  }

  /**
   * Re-attaches every active story run of the office, after settling host rows left pending,
   * then closes out or stops the open hosts of runs that have ended; returns what it did per run.
   */
  async reattach(officeId: OfficeId): Promise<ReattachedRun[]> {
    const office = this.#deps.offices.get(officeId);
    if (office === undefined) return [];
    const done: ReattachedRun[] = [];
    const { unmatched, waiting, matched } = await this.#settlePending(office);
    // A host matched to its pending row is claimed when its run is re-attached, before its launch
    // deadline: those runs go first, so other runs' re-attach cannot push a claim past it.
    const runs = activeRuns(office).toSorted(
      (a, b) => Number(matched.has(b.runId)) - Number(matched.has(a.runId)),
    );
    for (const run of runs) {
      if (run.kind !== "story" || waiting.has(run.runId)) continue;
      try {
        const outcome = await this.#reattachRun(office, run, unmatched.get(run.runId));
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
   * recording the spawned host (0005). Returns the agent of each run whose pending row matched no
   * live process by its launch deadline, and the runs whose row is still asked (DIPO-386).
   */
  async #settlePending(
    office: OfficeHandle,
  ): Promise<{ unmatched: Map<string, string>; waiting: Set<string>; matched: Set<string> }> {
    const unmatched = new Map<string, string>();
    const waiting = new Set<string>();
    const matched = new Set<string>();
    const rows = office.all<{ run_id: string; agent_id: string }>(
      `select run_id, agent_id from worker_hosts where office_id = $office_id and pending = 1
        order by started_at, rowid`,
    );
    for (const row of rows) {
      const host = workerHostsOf(office, row.run_id).find((h) => h.agentId === row.agent_id);
      if (host === undefined) continue;
      if (this.#waiting.has(`${row.run_id} ${row.agent_id}`)) {
        waiting.add(row.run_id);
        continue;
      }
      try {
        const settled = await this.#settleOne(office, host);
        if (settled === "unmatched") unmatched.set(row.run_id, row.agent_id);
        if (settled === "matched") matched.add(row.run_id);
        if (settled === "waiting" || settled === "refused") {
          waiting.add(row.run_id);
          this.#waitPending(office, host, settled);
        }
        this.#deps.warn?.("a worker host was still pending at the restart", {
          run: row.run_id,
          agent: row.agent_id,
          settled,
          deadline: hostLaunchDeadline(host.startedAt),
        });
      } catch (error) {
        this.#deps.warn?.("settling a pending worker host failed", {
          run: row.run_id,
          agent: row.agent_id,
          reason: messageOf(error),
        });
      }
    }
    return { unmatched, waiting, matched };
  }

  /**
   * Asks a pending row's host once: records the live host it names ("matched"); keeps the row
   * while its launch deadline has not passed, because nothing answered ("waiting") or what
   * answered failed the identity check ("refused"); or removes it ("unmatched"). Nothing is
   * signalled and nothing claimed here: the PID of a pending host is known only from its own
   * handshake, and only a recorded host is claimed (`claimHost`), so a host this daemon cannot
   * verify or keep stops itself at its deadline.
   */
  async #settleOne(office: OfficeHandle, host: WorkerHostRow): Promise<Settled> {
    // A host an earlier binary started (protocol before the claim) has no launch deadline and never
    // stops itself: it is asked once, as before, and its row goes when it does not match.
    const deadline = hasLaunchDeadline(host)
      ? hostLaunchDeadline(host.startedAt)
      : this.#deps.clock.now() + HOST_CONNECT_TIMEOUT_MS;
    const asked = await this.#pendingHost(host, deadline);
    if (asked.kind === "live") {
      // A daemon that stops, or a run that ended, during the ask keeps nothing: no record, so no
      // claim, and the host stops itself at its deadline.
      const run = findRun(office, host.runId as RunId);
      if (this.#closed || run === null || run.endedAt !== null) return "waiting";
      recordPendingPid(office, host, asked.pid, asked.startTimeMs);
      return "matched";
    }
    if (hasLaunchDeadline(host) && this.#deps.clock.now() < deadline) return asked.kind;
    deletePendingHost(office, host.runId, host.agentId);
    return "unmatched";
  }

  /**
   * Asks a pending row's socket again, in the background, until its launch deadline (DIPO-386),
   * then re-attaches the run whose host answered, or parks it as never started. A run that ended
   * meanwhile gets no handshake: its row goes, and its unclaimed host stops itself.
   */
  #waitPending(office: OfficeHandle, host: WorkerHostRow, first: Settled): void {
    const key = `${host.runId} ${host.agentId}`;
    if (this.#waiting.has(key)) return;
    this.#waiting.add(key);
    void this.#askUntilDeadline(office, host, first)
      .catch((error: unknown) => {
        this.#deps.warn?.("asking a pending worker host again failed", {
          run: host.runId,
          agent: host.agentId,
          reason: messageOf(error),
        });
      })
      .finally(() => this.#waiting.delete(key));
  }

  async #askUntilDeadline(
    office: OfficeHandle,
    pending: WorkerHostRow,
    first: Settled,
  ): Promise<void> {
    const { clock } = this.#deps;
    const deadline = hostLaunchDeadline(pending.startedAt);
    let settled = first;
    while (settled === "waiting" || settled === "refused") {
      // A host that answered but failed the check is not asked again: the row waits for the deadline.
      const wait = settled === "refused" ? deadline - clock.now() : HOST_CONNECT_RETRY_MS;
      await sleep(clock, Math.max(HOST_CONNECT_RETRY_MS, wait));
      if (this.#closed) return;
      const host = workerHostsOf(office, pending.runId).find((h) => h.agentId === pending.agentId);
      // Settled by another pass.
      if (host === undefined || !host.pending) return;
      const run = findRun(office, pending.runId as RunId);
      if (run === null || run.endedAt !== null) {
        deletePendingHost(office, host.runId, host.agentId);
        return;
      }
      settled = await this.#settleOne(office, host);
    }
    // A run that ended, or a daemon that stops, claims nothing: the host stops at its deadline.
    const run = findRun(office, pending.runId as RunId);
    if (run === null || run.endedAt !== null || run.kind !== "story" || this.#closed) return;
    const outcome = await this.#reattachRun(
      office,
      run,
      settled === "unmatched" ? pending.agentId : undefined,
    );
    this.#deps.warn?.("a pending worker host was settled at its launch deadline or before", {
      run: pending.runId,
      agent: pending.agentId,
      settled,
      outcome: outcome?.outcome ?? null,
    });
  }

  /**
   * The live host a pending row stands for, with its start time, or null. Its `launch.json` goes
   * first, so a host that has not read it yet starts nothing; a host that has read it binds its
   * socket, so the socket is asked until the connect timeout, never past the launch deadline. The
   * PID it names counts only when the process runs `dipo daemon worker-host <run>` and started
   * after the row was written.
   */
  async #pendingHost(host: WorkerHostRow, launchDeadline: number): Promise<PendingAsk> {
    const { clock, probe } = this.#deps;
    for (const name of [LAUNCH_FILE, `${LAUNCH_FILE}.tmp`]) {
      rmSync(join(host.runDir, name), { force: true });
    }
    // Past the deadline the host is unclaimed, so it has stopped itself and refuses a handshake.
    if (clock.now() >= launchDeadline) return { kind: "waiting" };
    const deadline = Math.min(clock.now() + HOST_CONNECT_TIMEOUT_MS, launchDeadline);
    let connected: ConnectHostResult;
    for (;;) {
      connected = await (this.#deps.connect ?? this.#connect.bind(this))(
        host.socketPath,
        host.runId,
      );
      if (connected.ok || connected.reason !== "unreachable" || this.#closed) break;
      if (deadline - clock.now() <= HOST_CONNECT_RETRY_MS) break;
      await sleep(clock, HOST_CONNECT_RETRY_MS);
    }
    if (!connected.ok) return { kind: "waiting" };
    const pid = connected.client.hostPid;
    connected.client.close();
    const info = await probe(pid);
    const matches =
      info !== null &&
      !info.zombie &&
      isWorkerHostArgv(info.argv, host.runId) &&
      info.startTimeMs >= host.startedAt - START_TIME_TOLERANCE_MS;
    return matches ? { kind: "live", pid, startTimeMs: info.startTimeMs } : { kind: "refused" };
  }

  /**
   * The open hosts of runs that have ended: a dead one is closed out now (its `exit.json`, or
   * lost); a living one gets one verified SIGTERM and is closed out once its process is gone. Its
   * row stays open until then, so every later restart does the same.
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
      if (this.#exitTimers.has(`${row.run_id} ${row.agent_id}`)) continue;
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
    const target = this.#targetOf(office, run, hosts, host);
    if (target === null) return null;
    if (await hostAlive(host, deps.probe)) {
      await this.#signal(host);
      this.#watchUntilExit(office, run, host, () => this.#closeOut(office, run, host, target));
      return { run: run.runId, agent: agentId, outcome: "stopEnded" };
    }
    this.#closeOut(office, run, host, target);
    return { run: run.runId, agent: agentId, outcome: "closedOut" };
  }

  /** The ingestion target of a host, for its close-out; null without a worker adapter. */
  #targetOf(
    office: OfficeHandle,
    run: StoredRun,
    hosts: readonly WorkerHostRow[],
    host: WorkerHostRow,
  ): IngestTarget | null {
    const adapter = this.#deps.adapter(office.officeId, run);
    if (adapter === null) {
      this.#deps.warn?.("no worker adapter to close out a worker host with", { run: run.runId });
      return null;
    }
    const agent = this.#agentRow(office, host.agentId);
    const work = this.#workOf(office, run, host.agentId, agent);
    const model = work?.model ?? agent?.model ?? run.model;
    return {
      run: run.runId,
      agent: host.agentId,
      role: run.role,
      tier: run.tier ?? "",
      budgetLimit: runCaps(office, run).budgetTokens,
      model,
      ...(work === null ? {} : { work }),
      adapter,
      initialState: this.#initialState(office, run, hosts, host, agent, model),
    };
  }

  /** One verified SIGTERM (`signalVerifiedHost`); why it sent nothing, or null when it did. */
  #signal(host: WorkerHostRow): Promise<string | null> {
    return signalVerifiedHost(host, this.#deps.probe, this.#deps.signal);
  }

  /**
   * A run whose only host was still pending and matched no live process: no worker runs. The story
   * parks `worker-failed`, keeping its branch, as for a run lost while the daemon was down.
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
    unmatchedAgent: string | undefined,
  ): Promise<ReattachedRun | null> {
    const deps = this.#deps;
    // Followed by this daemon already, or an exit of it is being decided.
    if (deps.control.isTracked(run.runId) || deps.outcomes?.busy(run.runId) === true) return null;
    const hosts = workerHostsOf(office, run.runId);
    const host = hosts.at(-1);
    if (host === undefined) {
      return unmatchedAgent === undefined ? null : this.#neverStarted(office, run, unmatchedAgent);
    }
    // A host stopped at an earlier pass parks its story once it exits.
    if (this.#exitTimers.has(`${run.runId} ${host.agentId}`)) return null;
    const agent = this.#agentRow(office, host.agentId);
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

    // A host event file reported changed before the stop (0007).
    if (this.#fileChanged(office, run.runId, host.agentId)) {
      const ending = deps.control.interruptedEnding();
      await deps.control.park(office, run, work, alive ? ending : { ...ending, ops: [] });
      return { run: run.runId, agent: host.agentId, outcome: "fileChanged" };
    }

    // A living developer on the Mac, outside a box: stopped, never followed (DIPO-240).
    const onMac =
      alive &&
      work.role !== REVIEWER_ROLE &&
      deps.boxRecord !== undefined &&
      !deps.boxRecord(host.runDir);
    if (onMac) {
      const text = macSessionText(run);
      const ending = deps.control.interruptedEnding();
      await deps.control.park(office, run, work, {
        ...ending,
        detail: text,
        notice: { level: "error", code: REATTACH_NOTICES.macSession, text },
      });
      return { run: run.runId, agent: host.agentId, outcome: "macSession" };
    }

    const adapter = deps.adapter(office.officeId, run);
    if (adapter === null) {
      deps.warn?.("no worker adapter to re-attach a run with", { run: run.runId });
      return null;
    }

    let client: Extract<ConnectHostResult, { ok: true }>["client"] | null = null;
    if (alive) {
      const connected = await (deps.connect ?? this.#connect.bind(this))(
        host.socketPath,
        run.runId,
      );
      if (!connected.ok) {
        const why =
          connected.reason === "refused"
            ? `it refused the handshake (${connected.error?.code ?? "refused"}: ${connected.error?.message ?? ""})`
            : connected.reason === "timeout"
              ? "it did not answer the handshake in time"
              : "its socket is gone";
        await this.#stopUnanswered(office, run, host, work, why);
        return { run: run.runId, agent: host.agentId, outcome: "stopped" };
      }
      client = connected.client;
    }

    this.#catchUpOffset(office, hosts, host, agent);
    // The run's start snapshot plus its grants (DIPO-143), for the usage share and the caps.
    const caps = runCaps(office, run);
    const target: IngestTarget = {
      run: run.runId,
      agent: host.agentId,
      role: run.role,
      tier: run.tier ?? "",
      budgetLimit: caps.budgetTokens,
      model: work.model,
      work,
      adapter,
      initialState: this.#initialState(office, run, hosts, host, agent, work.model),
    };
    deps.control.track(office.officeId, {
      runId: run.runId,
      work,
      caps: deps.caps(office.officeId, run) ?? {
        budgetTokens: caps.budgetTokens,
        maxTurns: caps.maxTurns,
        maxMinutes: caps.maxMinutes,
      },
      // The run's caps count from its first host, as worker outcomes count them.
      startedAt: capsStartedAt(run, hosts[0]?.startedAt),
    });

    if (client !== null) {
      // Recorded and followed now: the claim keeps the host's worker past its launch deadline.
      const unclaimed = await claimHost(client, host.pid);
      if (unclaimed !== null) {
        deps.warn?.("the worker host was not claimed; it stops its worker at its launch deadline", {
          run: run.runId,
          reason: unclaimed,
        });
      }
      const pass = deps.ingest.attach(office, host, target, client);
      if (pass.status === "fileChanged") {
        return { run: run.runId, agent: host.agentId, outcome: "fileChanged" };
      }
      deps.control.checkCaps(run.runId);
      return { run: run.runId, agent: host.agentId, outcome: "steer" };
    }

    return {
      run: run.runId,
      agent: host.agentId,
      outcome: await this.#closeDead(office, run, host, target),
    };
  }

  /**
   * A living host whose socket did not answer (0005): one verified SIGTERM and a notice, then the
   * story parks `worker-failed` once the host's process is gone, and the host is closed out. A host
   * that fails the check gets no signal, and its story parks at once.
   */
  async #stopUnanswered(
    office: OfficeHandle,
    run: StoredRun,
    host: WorkerHostRow,
    work: WorkRef,
    why: string,
  ): Promise<void> {
    const deps = this.#deps;
    const refused = await this.#signal(host);
    const detail = hostStoppedDetail(host.pid, why, refused);
    const at = deps.clock.now();
    const appended = office.immediate(() => {
      const viewed = withWorkViews(office, [
        {
          type: "engine.notice",
          key: work.key,
          run: work.run,
          delta: {
            level: "warn",
            code: REATTACH_NOTICES.hostStopped,
            text:
              refused === null
                ? `${work.story}: the worker host (pid ${host.pid}) still ran after the daemon restart, but ${why}. dipo sent it SIGTERM after checking its PID and start time, and parks the story worker-failed once it exits.`
                : `${work.story}: ${detail}; the story parks worker-failed.`,
          },
        },
      ]);
      appendEntries(office, viewed, { at });
      return viewed.length;
    });
    if (appended > 0) deps.onChanged?.(office.officeId);
    const park = async (): Promise<void> => {
      const current = findRun(office, run.runId);
      if (current === null || current.endedAt !== null) return;
      const ending = deps.control.interruptedEnding();
      await deps.control.park(office, current, work, { ...ending, ops: [], detail });
      const ended = findRun(office, run.runId) ?? current;
      const hosts = workerHostsOf(office, run.runId);
      const row = hosts.find((h) => h.agentId === host.agentId) ?? host;
      const target = this.#targetOf(office, ended, hosts, row);
      if (target !== null && row.endedAt === null) this.#closeOut(office, ended, row, target);
    };
    if (refused !== null) {
      await park();
      return;
    }
    this.#watchUntilExit(office, run, host, park);
  }

  /**
   * A dead host: process what it wrote, then the exit (or its loss). A host lost without an exit
   * file ends `host-lost`, and its story parks `worker-failed` with no resume (0005, 0008).
   */
  async #closeDead(
    office: OfficeHandle,
    run: StoredRun,
    host: WorkerHostRow,
    target: IngestTarget,
  ): Promise<ReattachOutcome> {
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
    // Lost: its usage is final when the agent ends, the run is untracked, and it parks at once.
    office.immediate(() => {
      endAgent(office, {
        runId: run.runId,
        agentId: host.agentId,
        at: deps.clock.now(),
        reason: HOST_LOST_END,
        finalizeUsage: true,
        endHost: true,
      });
    });
    deps.control.onEnded(run.runId);
    await deps.control.park(office, run, target.work, {
      ...deps.control.interruptedEnding(),
      ops: [],
      detail: HOST_LOST_WHY,
    });
    return "hostLost";
  }

  /**
   * Checks every `EXIT_CHECK_MS` whether a signalled host's process is gone, by PID and start time,
   * then runs `then` once.
   */
  #watchUntilExit(
    office: OfficeHandle,
    run: StoredRun,
    host: WorkerHostRow,
    then: () => void | Promise<void>,
  ): void {
    const key = `${run.runId} ${host.agentId}`;
    const check = async (): Promise<void> => {
      this.#exitTimers.delete(key);
      if (await hostAlive(host, this.#deps.probe)) {
        this.#armExitCheck(key, check);
        return;
      }
      await then();
    };
    this.#armExitCheck(key, check);
  }

  #armExitCheck(key: string, check: () => Promise<void>): void {
    if (this.#closed) return;
    const timer = this.#deps.clock.setTimeout(() => {
      check().catch((error: unknown) => {
        this.#deps.warn?.("checking a stopped worker host failed", {
          host: key,
          reason: messageOf(error),
        });
      });
    }, this.#deps.exitCheckMs ?? EXIT_CHECK_MS);
    this.#exitTimers.set(key, timer);
  }

  /** True when ingestion reported the agent's event file changed (0007). */
  #fileChanged(office: OfficeHandle, run: string, agent: string): boolean {
    return (
      office.get<{ found: number }>(
        `select 1 as found from ingest_cursors where office_id = $office_id and run_id = $run
          and agent_id = $agent and changed_at is not null`,
        { run, agent },
      ) !== null
    );
  }

  #agentRow(office: OfficeHandle, agent: string): AgentRow | null {
    return office.get<AgentRow>(
      `select model, session_id, ended_at from agents
        where office_id = $office_id and agent_id = $agent`,
      { agent },
    );
  }

  /**
   * A dead host of a run that has ended: nothing is decided any more, so the host row, the agent
   * and its cursor end. One last pass takes the lines the host wrote after the last poll (an exit
   * line among them ends the agent as ingestion always does), unless the event file was reported
   * changed. The exit is the host's own `exit.json` when there is one; without it the agent ends
   * `host-lost` unless an end reason (the park's) is already recorded.
   */
  #closeOut(
    office: OfficeHandle,
    run: StoredRun,
    ended: WorkerHostRow,
    target: IngestTarget,
  ): void {
    const deps = this.#deps;
    if (
      this.#agentRow(office, ended.agentId)?.ended_at == null &&
      !this.#fileChanged(office, run.runId, ended.agentId)
    ) {
      deps.ingest.attach(office, ended, target, null);
    }
    deps.ingest.untrack(office.officeId, run.runId, ended.agentId);
    const agentEnded = this.#agentRow(office, ended.agentId)?.ended_at != null;
    // The row as the last pass left it, with its processed offset.
    const host = workerHostsOf(office, run.runId).find((h) => h.agentId === ended.agentId) ?? ended;
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
    // The exit as `exit.json` says (its own transaction), then the rest of the close-out.
    if (exit !== null) recordHostExit(office, host.agentId, exit);
    office.immediate(() => {
      // An agent ingestion ended already keeps its end and its final usage.
      endAgent(office, {
        runId: run.runId,
        agentId: host.agentId,
        at,
        reason: exit === null ? HOST_LOST_END : "exited",
        finalizeUsage: !agentEnded,
        endHost: true,
      });
    });
    deps.onChanged?.(office.officeId);
  }

  /** Stops the liveness checks of signalled hosts. */
  close(): void {
    this.#closed = true;
    this.#waiting.clear();
    for (const timer of this.#exitTimers.values()) this.#deps.clock.clearTimeout(timer);
    this.#exitTimers.clear();
  }

  #connect(socketPath: string, runId: string): Promise<ConnectHostResult> {
    return connectHost(socketPath, {
      runId,
      clock: this.#deps.clock,
      timeoutMs: HOST_CONNECT_TIMEOUT_MS,
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
    office.immediate(() => setProcessedOffset(office, host.runId, host.agentId, from));
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
        where office_id = $office_id and run_id = $run and agent_id = $agent and source_kind = 'host-events'`,
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
      // Its host row ended with `exit.json` (`#recordExit`).
      endAgent(office, {
        runId,
        agentId: agent,
        at,
        reason: "exited",
        finalizeUsage: true,
        endHost: false,
      });
      const cursor = office.get<{ parse_state: string }>(
        `select parse_state from ingest_cursors
          where office_id = $office_id and run_id = $run and agent_id = $agent and source_kind = 'host-events'`,
        { run: runId, agent },
      );
      return cursor === null ? {} : (JSON.parse(cursor.parse_state) as ParseState);
    });
  }
}
