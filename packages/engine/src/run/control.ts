// Run control (DIPO-50; 0008 sections 6 and 7, 0005 section 4): the engine's caps, the parks a
// worker's report asks for and `work.stop`.
//
// - Caps. Each started run is tracked with its tier's caps and the time its worker started. After
//   every `usage` and `turn` event, as of that event inside its ingestion pass (`onEventApplied`),
//   and on a 1-minute tick of the injected clock (so the time cap fires without new events), the
//   run's budget tokens, summed turns and wall-clock minutes are compared with the caps
//   (`caps.ts`). After the pass commits, the engine acts at the first event that decides. At
//   100% of one it records a `cap` intent, sends the stop sequence and parks the story
//   `budget-exceeded` naming the cap and the total at the crossing. A turn that ended at the adapter's own turn cap (the CLI backstop, `error_max_turns`)
//   does the same at that turn, so a later turn of a queued message never overrides it.
// - Reports. A turn whose report is `blocked` parks the story: `needs-permission` with the tool and
//   action as detail when it carries `needsPermission` (a call `--permission-prompts none` denied,
//   0008 section 5), else `ambiguous-spec` with the question. The engine records a `park` intent
//   and closes the worker's stdin; worktree, branch and session are kept. Waiting for an answer
//   before the park is M1 (DIPO-15, decision D2).
// - `work.stop { story, note? }`. A story with no active run fails `story.notRunning`. Otherwise
//   the engine records a `stop` intent, sends the stop sequence through the host (the adapter's
//   `encode`: a now-priority message, stdin closed, SIGTERM after 10 s, SIGKILL after 30 s) and
//   parks the story `stopped`; branch and worktree are kept.
//
// Every op is stored as a pending intent before it is sent (`intents.ts`), and when the worker
// exits the intent that explains the exit is resolved with its outcome. After the first decision
// on a run nothing else is decided for it: later events of the same or a later pass are ignored.

import {
  type Clock,
  type CommandName,
  type OfficeId,
  type ParkReason,
  type RunId,
  type TimerHandle,
  type WorkRef,
  workStop,
} from "@dipsaus-orchestrator/contract";

import { appendEntries, type NewEntry } from "../changelog/log";
import { CommandError } from "../commands/errors";
import type { AsyncCommandContext, CommandOutcome, FeatureModule } from "../commands/registry";
import type { OfficeHandle } from "../db/office";
import type { IngestHooks } from "../ingest/ingestor";
import { withWorkViews, workRefOf } from "../views/work";
import type { Caps, HostOp, SteerOp, WorkerEvent } from "../workers/types";

import { type CapName, type FiredCap, firedCap, runTotals } from "./caps";
import {
  type IntentKind,
  markIntentSent,
  outcomeOfIntent,
  recordIntent,
  resolveIntent,
} from "./intents";
import { type ParkOutcome, type ParkWriter, parkStory } from "./park";
import { activeRuns, findRun, type StoredRun } from "./records";

/** The error of `work.stop` for a story with no active run (0005 section 4). */
export const STORY_NOT_RUNNING = "story.notRunning";

/** How often the caps are rechecked without new events (DIPO-15 M0 review): one minute. */
export const CAP_TICK_MS = 60_000;

/** The park detail of `work.stop` without a note. */
export const STOPPED_DETAIL = "Stopped by the maintainer.";

/** `engine.notice` codes of run control. */
export const CONTROL_NOTICES = {
  notSent: "run.stopNotSent",
} as const;

/** Sends host ops to a run's worker host. */
export interface RunSteering {
  send(
    office: OfficeHandle,
    runId: RunId,
    ops: readonly HostOp[],
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
}

export interface RunControlDeps {
  readonly clock: Clock;
  readonly offices: { get(office: OfficeId): OfficeHandle | undefined };
  readonly writer: ParkWriter;
  readonly steering: RunSteering;
  /** The worker adapter's pure `encode` (`WorkerPort.encode`). */
  readonly encode: (op: SteerOp) => HostOp[];
  /** True when the engine implements a command; parks offer only those. None by default. */
  readonly implemented?: (name: CommandName) => boolean;
  /** Writes pending `work.output` of a run before its state changes (0005 section 6). */
  readonly flushOutput?: (office: OfficeId, run: string) => void;
  /** Called after change-log entries were appended outside a command. */
  readonly onChanged?: (office: OfficeId) => void;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
  /** The cap tick; one minute by default. */
  readonly tickMs?: number;
}

/** What a started run is tracked with. */
export interface TrackedRun {
  readonly runId: RunId;
  readonly work: WorkRef;
  readonly caps: Caps;
  /** When the worker started (its host start), on the engine clock. */
  readonly startedAt: number;
}

interface Tracked extends TrackedRun {
  readonly office: OfficeId;
  timer: TimerHandle | null;
  /** Set at the first decision; nothing else is decided for the run after it. */
  ending: Promise<ParkOutcome | null> | null;
}

/** What ending a run does: the intent, the ops it sends and the park that follows. */
interface Ending {
  readonly intent: IntentKind;
  readonly ops: readonly HostOp[];
  readonly reason: ParkReason;
  readonly detail: string;
  readonly endKind: string;
}

type StopArgs = { readonly story: string; readonly note?: string | undefined };
type StopResult = { run: RunId };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class RunControl {
  readonly #deps: RunControlDeps;
  readonly #tracked = new Map<string, Tracked>();
  readonly #inflight = new Set<Promise<unknown>>();
  /** Events at which a cap was reached, as of that event inside its pass (`onEventApplied`). */
  readonly #crossings = new WeakMap<WorkerEvent, FiredCap>();

  constructor(deps: RunControlDeps) {
    this.#deps = deps;
  }

  /** The ingestion hooks: caps and reports after every committed pass, intents at the exit. */
  get hooks(): IngestHooks {
    return {
      onEventApplied: (run, _agent, event) => this.onEventApplied(run, event),
      onWorkerEvents: (run, _agent, events) => this.onWorkerEvents(run, events),
      onEnded: (run) => this.onEnded(run),
    };
  }

  /** Starts tracking a started run; call it before ingestion starts, so no event is missed. */
  track(office: OfficeId, run: TrackedRun): void {
    if (this.#tracked.has(run.runId)) return;
    const tracked: Tracked = { ...run, office, timer: null, ending: null };
    this.#tracked.set(run.runId, tracked);
    this.#arm(tracked);
  }

  /** True while the run is tracked (started here and not yet ended by an exit). */
  isTracked(run: string): boolean {
    return this.#tracked.has(run);
  }

  /** Resolves once every park this control started has finished. */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled(this.#inflight);
  }

  /** Stops every tick; tracked runs keep their stored facts. */
  close(): void {
    for (const tracked of this.#tracked.values()) this.#disarm(tracked);
    this.#tracked.clear();
  }

  /**
   * Inside an ingestion pass, right after a `usage` or `turn` event was folded into the stored
   * totals: compares the totals as of that event with the caps and remembers the event when one
   * is reached. Nothing is written or sent here; `onWorkerEvents` acts after the commit, at the
   * first event that decides, so a blocked report or backstop turn before the crossing wins and
   * the park detail names the total at the crossing. A rolled-back pass leaves only unused marks.
   */
  onEventApplied(run: string, event: WorkerEvent): void {
    const tracked = this.#tracked.get(run);
    if (tracked === undefined || tracked.ending !== null) return;
    const office = this.#deps.offices.get(tracked.office);
    if (office === undefined) return;
    const fired = firedCap(
      tracked.caps,
      runTotals(office, tracked.runId, tracked.startedAt, this.#deps.clock.now()),
    );
    if (fired !== null) this.#crossings.set(event, fired);
  }

  /** The events of one committed ingestion pass, in order. */
  onWorkerEvents(run: string, events: readonly WorkerEvent[]): void {
    const tracked = this.#tracked.get(run);
    if (tracked === undefined || tracked.ending !== null) return;
    for (const event of events) {
      if (event.t === "turn") {
        if (event.capped !== undefined) {
          this.#cap(tracked, "maxTurns", event.capped);
          return;
        }
        const report = event.report;
        if (report?.status === "blocked") {
          const permission = report.needsPermission;
          const reason: ParkReason =
            permission === undefined ? "ambiguous-spec" : "needs-permission";
          const detail =
            permission === undefined
              ? (report.question ?? report.summary)
              : `${permission.tool}: ${permission.action}`;
          this.#begin(tracked, {
            intent: "park",
            ops: [{ closeStdin: true }],
            reason,
            detail,
            endKind: "blocked",
          });
          return;
        }
      }
      // The cap as of this event, as the pass saw it (`onEventApplied`); the first crossing wins.
      const fired = this.#crossings.get(event);
      if (fired !== undefined) {
        this.#cap(tracked, fired.cap, fired.detail);
        return;
      }
    }
  }

  /** The worker's exit was ingested: the intent that explains it is resolved, the tick stops. */
  onEnded(run: string): void {
    const tracked = this.#tracked.get(run);
    if (tracked === undefined) return;
    this.#disarm(tracked);
    this.#tracked.delete(run);
    const office = this.#deps.offices.get(tracked.office);
    if (office === undefined) return;
    const at = this.#deps.clock.now();
    office.immediate(() => {
      const explained = outcomeOfIntent(office, tracked.runId);
      if (explained !== null && explained.intent.resolvedAt === null) {
        resolveIntent(office, tracked.runId, explained.intent.intentId, explained.outcome, at);
      }
    });
  }

  /** `work.stop`: see the file comment. */
  async stop(ctx: AsyncCommandContext, args: StopArgs): Promise<CommandOutcome<StopResult>> {
    const handle = ctx.office;
    const identity = ctx.stories.get(args.story);
    if (identity === undefined) throw new Error(`${args.story} was not resolved`);
    const find = () =>
      activeRuns(handle).find((run) => run.kind === "story" && run.key === identity.key);
    let run = find();
    // A decision already under way (a cap or a report) finishes first; then the run has ended.
    const pending = run === undefined ? undefined : this.#tracked.get(run.runId)?.ending;
    if (pending !== undefined && pending !== null) {
      await pending.catch(() => null);
      run = find();
    }
    if (run === undefined) {
      throw new CommandError(
        STORY_NOT_RUNNING,
        `${identity.story} has no running worker to stop.`,
        { story: identity.story },
      );
    }
    const note = args.note?.trim();
    const ending: Ending = {
      intent: "stop",
      ops: this.#deps.encode({ kind: "stop" }),
      reason: "stopped",
      detail: note === undefined || note === "" ? STOPPED_DETAIL : note,
      endKind: "stopped",
    };
    const tracked = this.#tracked.get(run.runId);
    const work = tracked?.work ?? workRefOf(handle, run.runId) ?? undefined;
    if (tracked !== undefined) this.#disarm(tracked);
    const done = this.#end(handle, run, work, ending, (fn) => ctx.commit(fn));
    if (tracked !== undefined) tracked.ending = done;
    await done;
    return { result: { run: run.runId } };
  }

  /** The command `work.stop`. */
  get feature(): FeatureModule {
    return {
      name: "run-control",
      register: (registry) => {
        registry.addAsyncOfficeCommand({
          definition: workStop,
          handle: (ctx, args) => this.stop(ctx, args),
        });
      },
    };
  }

  // ---- caps ------------------------------------------------------------------------------------

  #arm(tracked: Tracked): void {
    if (tracked.ending !== null || tracked.timer !== null) return;
    tracked.timer = this.#deps.clock.setTimeout(() => {
      tracked.timer = null;
      if (tracked.ending !== null || !this.#tracked.has(tracked.runId)) return;
      if (!this.#checkCaps(tracked)) this.#arm(tracked);
    }, this.#deps.tickMs ?? CAP_TICK_MS);
  }

  #disarm(tracked: Tracked): void {
    if (tracked.timer !== null) this.#deps.clock.clearTimeout(tracked.timer);
    tracked.timer = null;
  }

  /** Compares the run's totals with its caps; true when one fired and the run is ending. */
  #checkCaps(tracked: Tracked): boolean {
    const office = this.#deps.offices.get(tracked.office);
    if (office === undefined) return false;
    const fired = firedCap(
      tracked.caps,
      runTotals(office, tracked.runId, tracked.startedAt, this.#deps.clock.now()),
    );
    if (fired === null) return false;
    this.#cap(tracked, fired.cap, fired.detail);
    return true;
  }

  #cap(tracked: Tracked, cap: CapName, detail: string): void {
    this.#begin(tracked, {
      intent: "cap",
      ops: this.#deps.encode({ kind: "stop" }),
      reason: "budget-exceeded",
      detail: cap === "maxTurns" && !detail.startsWith("turn cap") ? `turn cap: ${detail}` : detail,
      endKind: "capped",
    });
  }

  // ---- ending a run ----------------------------------------------------------------------------

  /** The first decision on a tracked run, outside any command. */
  #begin(tracked: Tracked, ending: Ending): void {
    this.#disarm(tracked);
    const office = this.#deps.offices.get(tracked.office);
    if (office === undefined) return;
    const run = findRun(office, tracked.runId);
    if (run === null || run.endedAt !== null) return;
    const write = (fn: () => readonly NewEntry[]): void => {
      const at = this.#deps.clock.now();
      const appended = office.immediate(() => {
        const entries = fn() ?? [];
        appendEntries(office, entries, { at });
        return entries.length;
      });
      if (appended > 0) this.#deps.onChanged?.(tracked.office);
    };
    const done = this.#end(office, run, tracked.work, ending, write);
    tracked.ending = done;
    const settled = done.catch((error: unknown) => {
      this.#deps.warn?.("parking a run failed", { run: tracked.runId, reason: messageOf(error) });
      return null;
    });
    this.#inflight.add(settled);
    void settled.finally(() => this.#inflight.delete(settled));
  }

  /**
   * Records the intent (synchronously, before the first await), sends its ops through the host and
   * parks the story. A send that fails leaves the intent `failed` and puts a notice on the office;
   * the park still happens. Every entry it writes carries the run's work view where its type has
   * one (DIPO-52's `withWorkViews`), derived in the transaction that wrote the facts.
   */
  #end(
    office: OfficeHandle,
    run: StoredRun,
    work: WorkRef | undefined,
    ending: Ending,
    commit: (fn: () => readonly NewEntry[]) => void,
  ): Promise<ParkOutcome> {
    const write = (fn: () => readonly NewEntry[]): void =>
      commit(() => withWorkViews(office, fn()));
    const intentId = office.immediate(() =>
      recordIntent(office, run.runId, ending.intent, ending.detail, this.#deps.clock.now()),
    );
    return (async () => {
      let error: string | null = null;
      if (ending.ops.length > 0) {
        try {
          const sent = await this.#deps.steering.send(office, run.runId, ending.ops);
          if (!sent.ok) error = sent.reason;
        } catch (thrown) {
          error = messageOf(thrown);
        }
      }
      const at = this.#deps.clock.now();
      office.immediate(() => markIntentSent(office, run.runId, intentId, at, error));
      if (error !== null) {
        write(() => [
          {
            type: "engine.notice",
            ...(run.key === null ? {} : { key: run.key }),
            run: run.runId,
            delta: {
              level: "warn",
              code: CONTROL_NOTICES.notSent,
              text: `${run.story ?? run.runId}: dipo could not send ${ending.intent} to its worker (${error}); if the worker still runs, it is no longer followed by a run.`,
            },
          },
        ]);
      }
      this.#deps.flushOutput?.(office.officeId, run.runId);
      return parkStory(
        {
          office,
          writer: this.#deps.writer,
          now: () => this.#deps.clock.now(),
          write,
          implemented: this.#deps.implemented ?? (() => false),
        },
        {
          run,
          ...(work === undefined ? {} : { work }),
          reason: ending.reason,
          detail: ending.detail,
          endKind: ending.endKind,
        },
      );
    })();
  }
}
