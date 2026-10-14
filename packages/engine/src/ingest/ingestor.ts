// Worker event ingestion (0007 sections 4, 5 and 8; 0006 decision 8; 0005 section 6). For each
// tracked run and agent the engine reads the complete lines of the host's `events.ndjson` from the
// stored `processed_offset`, runs the adapter's pure `interpret` over them, and in one
// transaction writes the derived facts (agent details, usage rows, output chunks), any change-log
// entries that are due, the parser state and the new offset. A crash before the commit leaves
// offset and facts as they were, so the next pass neither skips nor repeats an event.
//
// Debounce before the log (0005 section 6): stored output becomes a `work.output` entry per run
// every 250 ms or at 16 KiB, and `usage.updated` at most once per second, on the injected clock.
// A pass starts when the host announces `advanced` on its socket, with a `stat` poll every second
// as fallback; `fs.watch` is not used. A host event file that shrank below the offset or was
// replaced stops ingestion for that run and reports `ingest.fileChanged`; parking the run is
// DIPO-57's.

import { createHash } from "node:crypto";

import type { Clock, Cursor, RunId, TimerHandle, WorkRef } from "@dipsaus-orchestrator/contract";

import { appendEntries, type NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import type { PriceBook } from "../pricing/estimate";
import { checkCatalogGap, priceAgentUsage, recordCliCost } from "../pricing/usage";
import { clearSignals, LIVENESS_SIGNALS } from "../run/signals";
import { withWorkViews } from "../views/work";
import type { HostLine, ParseState, WorkerEvent } from "../workers/types";
import { readCompleteLines, readRange, statEventFile, type FileIdentity } from "./event-file";
import { byteLength, outputText } from "./output";
import {
  applyTurnTotals,
  finalizeAgentUsage,
  readUsage,
  recordUsageMessage,
  setElapsed,
  type UsageScope,
} from "./usage";

/** The engine notice code a changed host event file reports (M0 review, DIPO-15). */
export const FILE_CHANGED_CODE = "ingest.fileChanged";

/** Debounce and poll defaults (0005 section 6 open question 5, 0007 section 5). */
export interface IngestTimings {
  readonly outputFlushMs: number;
  readonly outputFlushBytes: number;
  readonly usageIntervalMs: number;
  readonly pollMs: number;
}

export const INGEST_DEFAULTS: IngestTimings = {
  outputFlushMs: 250,
  outputFlushBytes: 16 * 1024,
  usageIntervalMs: 1000,
  pollMs: 1000,
};

/** The interpret half of a worker adapter (0008 section 1). */
export interface IngestAdapter {
  interpret(
    line: HostLine,
    state: ParseState,
  ): { readonly events: readonly WorkerEvent[]; readonly state: ParseState };
}

/** One run and agent to ingest; its `worker_hosts` row names the event file and offset. */
export interface IngestTarget extends UsageScope {
  /** The model the run planned; replaced by the model the worker reports at start. */
  readonly model: string;
  /**
   * Who works on what, for `work.output` and `usage.updated`. A run with no story (a `session`
   * run, 0007 amendment of 2026-10-12) has none: its facts are stored, but no work event.
   */
  readonly work?: WorkRef;
  readonly adapter: IngestAdapter;
  /** The parser state the first pass starts from; later passes use the stored one. */
  readonly initialState: ParseState;
}

export interface FileChangedReport {
  readonly run: string;
  readonly agent: string;
  readonly path: string;
  readonly detail: string;
}

export interface IngestHooks {
  /** The host event file changed; ingestion for the run stopped (DIPO-57 parks it). */
  readonly onFileChanged?: (report: FileChangedReport) => void;
  /** The worker failed its start checks; the caller stops it at once. */
  readonly onInitRejected?: (run: string, agent: string, reason: string) => void;
  /** Every worker event of a committed pass, in order, for health and caps. */
  readonly onWorkerEvents?: (run: string, agent: string, events: readonly WorkerEvent[]) => void;
  /** The worker's exit line was ingested; its usage is final. */
  readonly onEnded?: (run: string, agent: string) => void;
  /**
   * A pass committed complete lines of the run (DIPO-52): the worker is alive, so the watchdog
   * starts its quiet and stall timers again. `quiet` and `no-output` were cleared in the pass.
   */
  readonly onLines?: (run: string, agent: string) => void;
  /**
   * Change-log entries were appended (DIPO-52), so the daemon sends them to subscribers. Called
   * after the transaction that appended them, once per transaction.
   */
  readonly onAppended?: () => void;
}

export interface IngestorOptions {
  readonly office: OfficeHandle;
  readonly clock: Clock;
  /**
   * The pricing catalog usage is estimated with (`StateDatabase.pricing`, DIPO-62). Required so
   * a caller cannot leave it out by accident; with null, `est_cost_micros` stays null and no
   * catalog check runs.
   */
  readonly pricing: PriceBook | null;
  readonly hooks?: IngestHooks;
  readonly timings?: Partial<IngestTimings>;
  /** Called for a host line that is not a `{ t, ch, data }` object; the line is skipped. */
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

export type PassStatus = "ingested" | "idle" | "stopped" | "ended" | "fileChanged";

export interface PassResult {
  readonly status: PassStatus;
  readonly lines: number;
  readonly offset: number;
}

/** Something that can announce `advanced` offsets: the host client (DIPO-44). */
export interface AdvancedSource {
  watch(listener: (offset: number) => void): Promise<number | null>;
}

interface CursorRow {
  path: string;
  device: number | null;
  inode: number | null;
  read_offset: number;
  last_line_hash: string | null;
  last_line_bytes: number | null;
  parse_state: string;
  first_line_t: number | null;
  last_line_t: number | null;
  output_emitted_to: number;
  ended_at: number | null;
  changed_at: number | null;
}

interface Tracked {
  readonly target: IngestTarget;
  poll: TimerHandle | null;
  outputTimer: TimerHandle | null;
  usageTimer: TimerHandle | null;
  lastUsageAt: number | null;
  usageDirty: boolean;
  done: boolean;
}

const SOURCE = "host-events";
const decoder = new TextDecoder();

function keyOf(run: string, agent: string): string {
  return `${run}\u0000${agent}`;
}

function parseHostLine(text: string): HostLine | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { t, ch, data } = value as Record<string, unknown>;
  if (typeof t !== "number" || typeof ch !== "string" || typeof data !== "string") return null;
  return { t, ch, data };
}

/** Runs whose host event file changed and that have not ended, for DIPO-57. */
export function fileChangedRuns(office: OfficeHandle): FileChangedReport[] {
  return office
    .all<{ run_id: string; agent_id: string; path: string; changed_detail: string }>(
      `select run_id, agent_id, path, changed_detail from ingest_cursors
       where office_id = $office_id and changed_at is not null and ended_at is null
       order by changed_at, run_id`,
    )
    .map((row) => ({
      run: row.run_id,
      agent: row.agent_id,
      path: row.path,
      detail: row.changed_detail,
    }));
}

export class Ingestor {
  readonly #office: OfficeHandle;
  readonly #clock: Clock;
  readonly #pricing: PriceBook | null;
  readonly #hooks: IngestHooks;
  readonly #timings: IngestTimings;
  readonly #warn: NonNullable<IngestorOptions["warn"]>;
  readonly #tracked = new Map<string, Tracked>();

  constructor(options: IngestorOptions) {
    this.#office = options.office;
    this.#clock = options.clock;
    this.#pricing = options.pricing;
    this.#hooks = options.hooks ?? {};
    this.#timings = { ...INGEST_DEFAULTS, ...options.timings };
    this.#warn = options.warn ?? (() => {});
  }

  /**
   * Starts ingesting a run's agent: records the agent and its cursor if they are new, runs a
   * first pass and starts the 1 s `stat` poll. The `worker_hosts` row must exist.
   */
  track(target: IngestTarget): PassResult {
    const key = keyOf(target.run, target.agent);
    if (this.#tracked.has(key)) return this.pass(target.run, target.agent);
    const now = this.#clock.now();
    this.#office.immediate(() => {
      const host = this.#office.get<{ event_file: string; processed_offset: number }>(
        `select event_file, processed_offset from worker_hosts
         where office_id = $office_id and run_id = $run and agent_id = $agent`,
        { run: target.run, agent: target.agent },
      );
      if (host === null) {
        throw new Error(`No worker host is recorded for ${target.run} agent ${target.agent}.`);
      }
      this.#office.run(
        `insert or ignore into agents (office_id, agent_id, run_id, role, model, started_at)
         values ($office_id, $agent, $run, $role, $model, $now)`,
        { agent: target.agent, run: target.run, role: target.role, model: target.model, now },
      );
      // A new agent's output continues the run's stored output, after what earlier agents wrote.
      const end = this.#outputEnd(target.run);
      this.#office.run(
        `insert or ignore into ingest_cursors (office_id, run_id, agent_id, source_kind, path,
           read_offset, parse_state, output_emitted_to, updated_at)
         values ($office_id, $run, $agent, $kind, $path, $offset, $state, $end, $now)`,
        {
          run: target.run,
          agent: target.agent,
          kind: SOURCE,
          path: host.event_file,
          offset: host.processed_offset,
          state: JSON.stringify(target.initialState),
          end,
          now,
        },
      );
    });
    this.#tracked.set(key, {
      target,
      poll: null,
      outputTimer: null,
      usageTimer: null,
      lastUsageAt: null,
      usageDirty: false,
      done: false,
    });
    const result = this.pass(target.run, target.agent);
    const tracked = this.#tracked.get(key);
    if (tracked !== undefined && !tracked.done) {
      // Output stored before a restart but not yet sent as an event goes out on the timer.
      this.#armOutput(tracked);
      this.#armPoll(tracked);
    }
    return result;
  }

  /** The host announced `advanced` (DIPO-44): run a pass now. */
  announce(run: string, agent: string): PassResult {
    return this.pass(run, agent);
  }

  /** Subscribes to a host's `advanced` announcements and catches up once. */
  async watch(run: string, agent: string, source: AdvancedSource): Promise<void> {
    await source.watch(() => {
      this.announce(run, agent);
    });
    this.announce(run, agent);
  }

  /** Stops timers for one agent; stored facts and the cursor stay. */
  untrack(run: string, agent: string): void {
    const tracked = this.#tracked.get(keyOf(run, agent));
    if (tracked === undefined) return;
    this.#stopTimers(tracked);
    this.#tracked.delete(keyOf(run, agent));
  }

  /** Stops every timer; nothing pending is lost, because it is all stored. */
  close(): void {
    for (const tracked of this.#tracked.values()) this.#stopTimers(tracked);
    this.#tracked.clear();
  }

  /**
   * Writes pending `work.output` of the run now. Call it before a state change of the run
   * (0005 section 6: state changes flush pending output first). Returns the last cursor written.
   */
  flushOutput(run: string): Cursor | undefined {
    let cursor: Cursor | undefined;
    for (const tracked of this.#tracked.values()) {
      if (tracked.target.run !== run) continue;
      this.#clearOutputTimer(tracked);
      const at = this.#clock.now();
      cursor =
        this.#office.immediate(() => this.#append(this.#outputEntries(tracked.target), at)) ??
        cursor;
    }
    return cursor;
  }

  /** One pass for a tracked agent: read, interpret and commit the complete lines past the offset. */
  pass(run: string, agent: string): PassResult {
    const tracked = this.#tracked.get(keyOf(run, agent));
    if (tracked === undefined) throw new Error(`${run} agent ${agent} is not tracked.`);
    const { target } = tracked;
    const cursor = this.#cursor(target);
    const offset = this.#processedOffset(target);
    if (cursor.changed_at !== null) return this.#finish(tracked, "stopped", 0, offset);
    if (cursor.ended_at !== null) return this.#finish(tracked, "ended", 0, offset);

    const identity = statEventFile(cursor.path);
    const changed = this.#changeOf(cursor, identity, offset);
    if (changed !== null) {
      this.#fileChanged(tracked, cursor.path, changed);
      return this.#finish(tracked, "fileChanged", 0, offset);
    }
    if (identity === null) return { status: "idle", lines: 0, offset };
    const lines = readCompleteLines(cursor.path, offset, identity.size);
    if (lines.length === 0) {
      // Record the identity as soon as the file exists, so a replacement is caught even before the
      // first complete line.
      if (cursor.device === null) this.#recordIdentity(target, identity);
      return { status: "idle", lines: 0, offset };
    }

    const now = this.#clock.now();
    const events: WorkerEvent[] = [];
    const rejected: string[] = [];
    let exited = false;
    let usageDirty = false;
    let usageSent = false;
    const end = lines[lines.length - 1]?.end ?? offset;

    this.#office.immediate(() => {
      let state = JSON.parse(cursor.parse_state) as ParseState;
      let firstT = cursor.first_line_t;
      let lastT = cursor.last_line_t;
      let model = this.#agentModel(target);
      let usageChanged = false;
      let turnEnded = false;
      let text = "";
      for (const line of lines) {
        const hostLine = parseHostLine(line.text);
        if (hostLine === null) {
          this.#warn("skipped an event line that is not a host line", {
            run,
            agent,
            end: line.end,
          });
          continue;
        }
        firstT ??= hostLine.t;
        lastT = hostLine.t;
        if (hostLine.ch === "exit") exited = true;
        const step = target.adapter.interpret(hostLine, state);
        state = step.state;
        for (const event of step.events) {
          events.push(event);
          text += outputText(event);
          switch (event.t) {
            case "usage":
              usageChanged = recordUsageMessage(this.#office, target, event, now) || usageChanged;
              break;
            case "turn":
              applyTurnTotals(
                this.#office,
                target,
                event.totals,
                { model, count: event.numTurns },
                now,
              );
              for (const missing of recordCliCost(
                this.#office,
                run,
                agent,
                event.costUsd ?? null,
              )) {
                this.#warn("the CLI reported a cost for a model without a usage row", {
                  run,
                  agent,
                  model: missing,
                });
              }
              usageChanged = true;
              turnEnded = true;
              break;
            case "started":
              model = event.model;
              this.#office.run(
                `update agents set model = $model, session_id = $session,
                   claude_code_version = $version
                 where office_id = $office_id and agent_id = $agent`,
                {
                  model: event.model,
                  session: event.sessionId,
                  version: event.version,
                  agent,
                },
              );
              break;
            case "initRejected":
              rejected.push(event.reason);
              this.#office.run(
                `update agents set init_rejected = coalesce(init_rejected, $reason)
                 where office_id = $office_id and agent_id = $agent`,
                { reason: event.reason, agent },
              );
              break;
            default:
              break;
          }
        }
      }

      if (text !== "") {
        const from = this.#outputEnd(run);
        this.#office.run(
          `insert into output_chunks (office_id, run_id, source, from_offset, to_offset, agent_id,
             text, at)
           values ($office_id, $run, 'worker', $from, $to, $agent, $text, $now)`,
          { run, from, to: from + byteLength(text), agent, text, now },
        );
      }
      if (firstT !== null && lastT !== null && (usageChanged || this.#hasTotals(target))) {
        setElapsed(this.#office, target, model, lastT - firstT, now);
      }
      // Estimated cost follows every usage update, in the same transaction (0008 section 4).
      if (usageChanged) priceAgentUsage(this.#office, this.#pricing, run, agent);
      const stale = turnEnded
        ? checkCatalogGap(this.#office, this.#pricing, run, target.work, now)
        : null;

      const last = lines[lines.length - 1]?.text ?? "";
      const lastStart = lines.length > 1 ? (lines[lines.length - 2]?.end ?? offset) : offset;
      this.#office.run(
        `update ingest_cursors set read_offset = $end, device = $device, inode = $inode,
           size = $size, last_line_hash = $hash, last_line_bytes = $bytes, parse_state = $state, first_line_t = $first,
           last_line_t = $last, updated_at = $now, ended_at = $ended
         where office_id = $office_id and run_id = $run and agent_id = $agent
           and source_kind = $kind`,
        {
          end,
          device: identity.device,
          inode: identity.inode,
          size: identity.size,
          hash: createHash("sha256").update(last).digest("hex"),
          bytes: end - lastStart,
          state: JSON.stringify(state),
          first: firstT,
          last: lastT,
          now,
          ended: exited ? now : null,
          run,
          agent,
          kind: SOURCE,
        },
      );
      this.#office.run(
        `update worker_hosts set processed_offset = $end
         where office_id = $office_id and run_id = $run and agent_id = $agent`,
        { end, run, agent },
      );

      // Change-log entries that are due now, output first so order stays causal.
      const entries: NewEntry[] = [];
      const pending = this.#outputEnd(run) - this.#emittedTo(target);
      if (exited || rejected.length > 0 || pending >= this.#timings.outputFlushBytes) {
        entries.push(...this.#outputEntries(target));
      }
      if (stale !== null) entries.push(stale);
      usageDirty = tracked.usageDirty || usageChanged;
      const dueAt = (tracked.lastUsageAt ?? -Infinity) + this.#timings.usageIntervalMs;
      if (usageDirty && (exited || now >= dueAt)) {
        entries.push(...this.#usageEntries(target));
        usageSent = true;
      }
      // A line clears `quiet` and `no-output` (0009 section 3, DIPO-52).
      for (const cleared of clearSignals(this.#office, run, LIVENESS_SIGNALS, now)) {
        if (target.work === undefined) continue;
        entries.push({
          type: "work.observed",
          key: target.work.key,
          run: target.work.run,
          delta: {
            work: target.work,
            signal: cleared.signal,
            since: new Date(cleared.since).toISOString(),
            clearedAt: new Date(now).toISOString(),
          },
        });
      }
      if (exited) {
        finalizeAgentUsage(this.#office, run, agent, now);
        this.#office.run(
          `update agents set ended_at = $now, end_reason = coalesce(end_reason, 'exited')
           where office_id = $office_id and agent_id = $agent`,
          { now, agent },
        );
      }
      this.#append(entries, now);
    });

    // Only a committed `usage.updated` counts as sent; a rolled-back one is sent again.
    tracked.usageDirty = usageDirty;
    if (usageSent) this.#usageSent(tracked, now);

    if (exited) {
      tracked.done = true;
      this.#stopTimers(tracked);
    } else {
      this.#armOutput(tracked);
      this.#armUsage(tracked);
    }
    this.#hooks.onLines?.(run, agent);
    if (events.length > 0) this.#hooks.onWorkerEvents?.(run, agent, events);
    for (const reason of rejected) this.#hooks.onInitRejected?.(run, agent, reason);
    if (exited) this.#hooks.onEnded?.(run, agent);
    return { status: exited ? "ended" : "ingested", lines: lines.length, offset: end };
  }

  // ---- timers --------------------------------------------------------------------------------

  #armPoll(tracked: Tracked): void {
    if (tracked.done || tracked.poll !== null) return;
    tracked.poll = this.#clock.setTimeout(() => {
      tracked.poll = null;
      if (tracked.done) return;
      this.pass(tracked.target.run, tracked.target.agent);
      this.#armPoll(tracked);
    }, this.#timings.pollMs);
  }

  #armOutput(tracked: Tracked): void {
    if (tracked.done || tracked.outputTimer !== null) return;
    if (this.#outputEnd(tracked.target.run) <= this.#emittedTo(tracked.target)) return;
    tracked.outputTimer = this.#clock.setTimeout(() => {
      tracked.outputTimer = null;
      const at = this.#clock.now();
      this.#office.immediate(() => this.#append(this.#outputEntries(tracked.target), at));
    }, this.#timings.outputFlushMs);
  }

  #clearOutputTimer(tracked: Tracked): void {
    if (tracked.outputTimer !== null) this.#clock.clearTimeout(tracked.outputTimer);
    tracked.outputTimer = null;
  }

  #armUsage(tracked: Tracked): void {
    if (tracked.done || !tracked.usageDirty || tracked.usageTimer !== null) return;
    const dueAt = (tracked.lastUsageAt ?? this.#clock.now()) + this.#timings.usageIntervalMs;
    tracked.usageTimer = this.#clock.setTimeout(
      () => {
        tracked.usageTimer = null;
        if (!tracked.usageDirty) return;
        const at = this.#clock.now();
        this.#office.immediate(() => this.#append(this.#usageEntries(tracked.target), at));
        this.#usageSent(tracked, at);
      },
      Math.max(0, dueAt - this.#clock.now()),
    );
  }

  #stopTimers(tracked: Tracked): void {
    for (const handle of [tracked.poll, tracked.outputTimer, tracked.usageTimer]) {
      if (handle !== null) this.#clock.clearTimeout(handle);
    }
    tracked.poll = null;
    tracked.outputTimer = null;
    tracked.usageTimer = null;
  }

  #finish(tracked: Tracked, status: PassStatus, lines: number, offset: number): PassResult {
    tracked.done = true;
    this.#stopTimers(tracked);
    return { status, lines, offset };
  }

  // ---- entries (inside a transaction) --------------------------------------------------------

  /**
   * Appends `entries`, each work entry with the run's `WorkView` derived now (DIPO-52), and has
   * `onAppended` called once the transaction is done. Runs inside the caller's transaction.
   */
  #append(entries: readonly NewEntry[], at: number): Cursor | undefined {
    const cursor = appendEntries(this.#office, withWorkViews(this.#office, entries), { at });
    const notify = this.#hooks.onAppended;
    if (cursor !== undefined && notify !== undefined) queueMicrotask(notify);
    return cursor;
  }

  /** `work.output` for the agent's output not yet sent; advances the emitted mark. */
  #outputEntries(target: IngestTarget): NewEntry[] {
    const from = this.#emittedTo(target);
    const chunks = this.#office.all<{ from_offset: number; to_offset: number; text: string }>(
      `select from_offset, to_offset, text from output_chunks
       where office_id = $office_id and run_id = $run and source = 'worker'
         and agent_id = $agent and from_offset >= $from
       order by from_offset`,
      { run: target.run, agent: target.agent, from },
    );
    const first = chunks[0];
    const last = chunks[chunks.length - 1];
    if (first === undefined || last === undefined) return [];
    this.#office.run(
      `update ingest_cursors set output_emitted_to = $to
       where office_id = $office_id and run_id = $run and agent_id = $agent
         and source_kind = $kind`,
      { to: last.to_offset, run: target.run, agent: target.agent, kind: SOURCE },
    );
    if (target.work === undefined) return [];
    return [
      {
        type: "work.output",
        key: target.work.key,
        run: target.work.run,
        delta: {
          work: target.work,
          source: "worker",
          from: first.from_offset,
          to: last.to_offset,
          text: chunks.map((chunk) => chunk.text).join(""),
        },
      },
    ];
  }

  /** `usage.updated` with the agent's and run's usage now; the caller marks it sent on commit. */
  #usageEntries(target: IngestTarget): NewEntry[] {
    if (target.work === undefined) return [];
    return [
      {
        type: "usage.updated",
        key: target.work.key,
        run: target.work.run,
        delta: { work: target.work, usage: readUsage(this.#office, target) },
      },
    ];
  }

  /** After a committed `usage.updated`: nothing pending, and the next one waits its interval. */
  #usageSent(tracked: Tracked, at: number): void {
    tracked.usageDirty = false;
    tracked.lastUsageAt = at;
  }

  // ---- file change ---------------------------------------------------------------------------

  #changeOf(cursor: CursorRow, identity: FileIdentity | null, offset: number): string | null {
    if (identity === null) return offset > 0 ? "event file missing" : null;
    if (
      cursor.device !== null &&
      (cursor.device !== identity.device || cursor.inode !== identity.inode)
    ) {
      return "event file replaced";
    }
    if (identity.size < offset) {
      return `event file is ${identity.size} bytes, below the processed offset ${offset}`;
    }
    // The last processed line must still be where it was: same bytes, ending in a newline.
    const length = cursor.last_line_bytes;
    if (cursor.last_line_hash !== null && length !== null && length > 0 && length <= offset) {
      const bytes = readRange(cursor.path, offset - length, length);
      const intact =
        bytes.byteLength === length &&
        bytes[length - 1] === 0x0a &&
        createHash("sha256")
          .update(decoder.decode(bytes.subarray(0, length - 1)))
          .digest("hex") === cursor.last_line_hash;
      if (!intact) return "event file rewritten before the processed offset";
    }
    return null;
  }

  #fileChanged(tracked: Tracked, path: string, detail: string): void {
    const { target } = tracked;
    const now = this.#clock.now();
    this.#office.immediate(() => {
      const entries: NewEntry[] = [...this.#outputEntries(target)];
      if (tracked.usageDirty) entries.push(...this.#usageEntries(target));
      this.#office.run(
        `update ingest_cursors set changed_at = $now, changed_detail = $detail, updated_at = $now
         where office_id = $office_id and run_id = $run and agent_id = $agent
           and source_kind = $kind`,
        { now, detail, run: target.run, agent: target.agent, kind: SOURCE },
      );
      entries.push({
        type: "engine.notice",
        ...(target.work === undefined ? {} : { key: target.work.key }),
        run: target.run as RunId,
        delta: {
          level: "warn",
          code: FILE_CHANGED_CODE,
          text: `The event file of ${target.run} changed (${detail}); ingestion for the run stopped.`,
        },
      });
      this.#append(entries, now);
    });
    if (tracked.usageDirty && target.work !== undefined) this.#usageSent(tracked, now);
    this.#hooks.onFileChanged?.({ run: target.run, agent: target.agent, path, detail });
  }

  // ---- reads ---------------------------------------------------------------------------------

  #cursor(target: IngestTarget): CursorRow {
    const row = this.#office.get<CursorRow>(
      `select path, device, inode, read_offset, last_line_hash, last_line_bytes, parse_state,
         first_line_t, last_line_t, output_emitted_to, ended_at, changed_at
       from ingest_cursors
       where office_id = $office_id and run_id = $run and agent_id = $agent
         and source_kind = $kind`,
      { run: target.run, agent: target.agent, kind: SOURCE },
    );
    if (row === null) throw new Error(`${target.run} agent ${target.agent} has no cursor.`);
    return row;
  }

  #processedOffset(target: IngestTarget): number {
    return (
      this.#office.get<{ processed_offset: number }>(
        `select processed_offset from worker_hosts
         where office_id = $office_id and run_id = $run and agent_id = $agent`,
        { run: target.run, agent: target.agent },
      )?.processed_offset ?? 0
    );
  }

  #recordIdentity(target: IngestTarget, identity: FileIdentity): void {
    this.#office.immediate(() =>
      this.#office.run(
        `update ingest_cursors set device = $device, inode = $inode
         where office_id = $office_id and run_id = $run and agent_id = $agent
           and source_kind = $kind and device is null`,
        {
          device: identity.device,
          inode: identity.inode,
          run: target.run,
          agent: target.agent,
          kind: SOURCE,
        },
      ),
    );
  }

  #agentModel(target: IngestTarget): string {
    return (
      this.#office.get<{ model: string }>(
        "select model from agents where office_id = $office_id and agent_id = $agent",
        { agent: target.agent },
      )?.model ?? target.model
    );
  }

  #hasTotals(target: IngestTarget): boolean {
    return (
      this.#office.get(
        `select 1 as found from usage_totals
         where office_id = $office_id and run_id = $run and agent_id = $agent`,
        { run: target.run, agent: target.agent },
      ) !== null
    );
  }

  #outputEnd(run: string): number {
    return (
      this.#office.get<{ end: number | null }>(
        `select max(to_offset) as end from output_chunks
         where office_id = $office_id and run_id = $run and source = 'worker'`,
        { run },
      )?.end ?? 0
    );
  }

  #emittedTo(target: IngestTarget): number {
    return (
      this.#office.get<{ output_emitted_to: number }>(
        `select output_emitted_to from ingest_cursors
         where office_id = $office_id and run_id = $run and agent_id = $agent
           and source_kind = $kind`,
        { run: target.run, agent: target.agent, kind: SOURCE },
      )?.output_emitted_to ?? 0
    );
  }
}
