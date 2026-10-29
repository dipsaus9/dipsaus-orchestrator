// The `OfficeStore` (0009 sections 2 and 7, 0005 section 8): the state every UI renders, fed by
// `engine.hello`, the software stream, one office's snapshot and that office's stream. It applies
// events by subject (story `key`, `run`, `gate`, `question`, `test`, `office`), drops stored
// events whose cursor it already has, and replaces the views the engine sends. It never computes
// column, health, phase, evidence or cost: an event without a view changes nothing it shows.
// `work.output` text is passed to `onOutput` listeners and never kept in the state (DIPO-55).
// A stream the daemon ends with any other error than `stream.resetRequired` (such as
// `engine.recovering` right after a daemon restart) is subscribed again after the store's last
// cursor, so an open view keeps following (DIPO-322): while the error is retryable on a backoff
// from 250 ms doubling to 5 s, and at once when the daemon runs again or the client reconnected.
// An error that does not retry stays in `streamError` until then (DIPO-327).
//
// Runtime-free like the rest of the client core: time comes from the injected clock.

import {
  type Clock,
  CONTRACT_VERSION,
  type Cursor,
  type DaemonState,
  daemonStateChanged,
  DatabaseUnavailableDetails,
  type EngineError,
  engineHello,
  type Event,
  findEvent,
  gateDecided,
  gateReached,
  type GateView,
  type OfficeId,
  officeForgotten,
  officeRegistered,
  officeSnapshot,
  type OfficeSnapshot,
  type OfficeSummary,
  type OutputMarker,
  type OutputSource,
  officeSummary,
  officeSwitch,
  questionAsked,
  questionClosed,
  type QuestionView,
  type ReadDefinition,
  type RunId,
  storyRenumbered,
  storyState,
  type StoryView,
  StreamName,
  testEnded,
  testRecorded,
  testStarted,
  type TestView,
  type TimerHandle,
  usageUpdated,
  workAssigned,
  workObserved,
  workOutput,
  workPhase,
  workProgress,
  type WorkView,
} from "@dipsaus-orchestrator/contract";

import type { z } from "zod";

import {
  ClientError,
  type ConnectionState,
  RECONNECT_MAX_MS,
  type DipoClient,
  type HelloResult,
  type ReadOutcome,
  type Subscription,
} from "../client";
import { RECOVERY_POLL_MS } from "../recovery";

/** What the store needs from a connected client; `DipoClient` is one. */
export type StoreClient = Pick<DipoClient, "state" | "hello" | "onState" | "read" | "subscribe">;

/** Shown once after a history gap made the store drop its view and read it again (0009 section 7). */
export const RELOADED_NOTICE = "view reloaded (history gap)";

const SOFTWARE = StreamName.parse("software");

/** The longest wait before a stream ended with a retryable error is subscribed again (DIPO-327). */
export const STREAM_RETRY_MAX_MS = RECONNECT_MAX_MS;

/**
 * The wait before stream retry `attempt` (0 for the first after the daemon ran again or the
 * client reconnected): `RECOVERY_POLL_MS`, doubling to `STREAM_RETRY_MAX_MS` (DIPO-327).
 */
export function streamRetryDelay(attempt: number): number {
  return Math.min(STREAM_RETRY_MAX_MS, RECOVERY_POLL_MS * 2 ** Math.max(0, attempt));
}

/**
 * One registered office. `summary` is the engine's `OfficeSummary`; it is absent for an office
 * known only from `office.registered` until its first `office.summary` arrives.
 */
export interface OfficeEntry {
  readonly office: OfficeId;
  readonly name: string;
  readonly path: string;
  readonly summary: OfficeSummary | undefined;
}

/**
 * The database line a failed read leaves (DIPO-120): the details of a `database.unavailable`
 * answer, null when they do not parse, or undefined for any other error, which leaves it as it is.
 */
function databaseOf(error: EngineError): DatabaseUnavailableDetails | null | undefined {
  if (error.code !== "database.unavailable") return undefined;
  const details = DatabaseUnavailableDetails.safeParse(error.details);
  return details.success ? details.data : null;
}

export interface OfficeStoreState {
  readonly connection: ConnectionState;
  /** When the connection was lost (clock milliseconds); null while connected. */
  readonly offlineSince: number | null;
  /** The office stream (else the software stream) caught up since the last (re)subscribe. */
  readonly live: boolean;
  readonly daemon: DaemonState | null;
  readonly engine: string | null;
  readonly capabilities: readonly string[];
  /** Registered offices in `engine.hello` order, then in order of registration. */
  readonly offices: readonly OfficeEntry[];
  /** The selected office; client state (0006). */
  readonly office: OfficeId | null;
  /** True while the selected office's snapshot is being read. */
  readonly loading: boolean;
  readonly stories: readonly StoryView[];
  readonly work: readonly WorkView[];
  readonly gates: readonly GateView[];
  readonly questions: readonly QuestionView[];
  readonly tests: readonly TestView[];
  /**
   * The last stored cursor of the selected office stream the store applied, starting at the
   * snapshot cursor; null without an office. A client compares a command reply cursor with it to
   * wait for its own write (read-your-writes, 0009 section 5).
   */
  readonly cursor: Cursor | null;
  /**
   * How many office snapshots the store has applied (opens, switches and re-reads after a history
   * gap). A client waiting for its own write counts a re-read after the reply as caught up,
   * whatever the epoch (read-your-writes, 0009 section 5).
   */
  readonly snapshots: number;
  /** A one-time message, such as `RELOADED_NOTICE`; cleared by `dismissNotice`. */
  readonly notice: string | null;
  /** The last failed read or ended subscription, until the next success. */
  readonly error: EngineError | null;
  /**
   * The error of a stream the daemon ended that is not subscribed again on the backoff, because
   * the error does not retry (DIPO-327); null otherwise. A reconnect or a change of the daemon
   * state subscribes it again and clears it.
   */
  readonly streamError: EngineError | null;
  /**
   * Why the daemon's state database is unavailable (DIPO-111), from a `database.unavailable` answer;
   * null otherwise. Kept across office switches; cleared by `draining` and by a fresh `engine.hello`
   * (DIPO-120).
   */
  readonly database: DatabaseUnavailableDetails | null;
}

/**
 * One `work.output` byte range of the selected office (0005 section 5). The store passes it on to
 * `onOutput` listeners and keeps none of it: an output pane holds the text it shows and reads the
 * rest with `work.outputRange` (0009 section 9).
 */
export interface OutputChunk {
  readonly run: RunId;
  readonly source: OutputSource;
  /** Byte offsets in the run's stored output of `source`. */
  readonly from: number;
  readonly to: number;
  readonly text: string;
  /** The engine markers in the range (DIPO-95); a client draws a marker only from this flag. */
  readonly markers?: readonly OutputMarker[];
}

export interface OfficeStoreOptions {
  readonly client: StoreClient;
  readonly clock: Clock;
  /** Sent when the store reads `engine.hello` again after a history gap. */
  readonly clientInfo: { readonly name: string; readonly version: string };
}

const EMPTY_OFFICE = {
  stories: [],
  work: [],
  gates: [],
  questions: [],
  tests: [],
  cursor: null,
} as const;

/** Event types whose data carries `work` and an optional engine-derived `view` of that run. */
const WORK_EVENTS = [workAssigned, workPhase, workProgress, workOutput, workObserved, usageUpdated];

/** True when `cursor` was delivered already: same epoch, not past the last one (0005 section 8). */
function seen(last: Cursor | undefined, cursor: Cursor): boolean {
  return last !== undefined && last.epoch === cursor.epoch && cursor.seq <= last.seq;
}

/**
 * True when `current`, the store's office cursor, is at or past `target`, a command reply cursor
 * of the same office stream (read-your-writes, 0009 section 5). A reply from another epoch counts
 * only once the store itself is on that epoch, that is after it read the stream again; epochs have
 * no order, so a store still on the old one has not seen the write.
 */
export function cursorReached(current: Cursor | null, target: Cursor): boolean {
  if (current === null || current.stream !== target.stream) return false;
  return current.epoch === target.epoch && current.seq >= target.seq;
}

export class OfficeStore {
  readonly #client: StoreClient;
  readonly #clock: Clock;
  readonly #clientInfo: { readonly name: string; readonly version: string };
  readonly #listeners = new Set<() => void>();
  readonly #outputListeners = new Set<(chunk: OutputChunk) => void>();
  readonly #officeListeners = new Set<(event: Event) => void>();
  #state: OfficeStoreState;

  #software: Subscription | null = null;
  /** The error the software stream ended with, other than `stream.resetRequired`; see `#resume`. */
  #softwareEnded: EngineError | null = null;
  #officeSub: Subscription | null = null;
  /**
   * Identifies the current office subscription: its callbacks act only while it is this one. A
   * switch that is still reading, or that failed, leaves the current office's stream in force.
   */
  #officeToken: object | null = null;
  /**
   * The selected office's stream, ended by the daemon with an error other than
   * `stream.resetRequired` (DIPO-322). A daemon that restarts answers the client's re-sent
   * subscription with `engine.recovering` until it has recovered its offices; the store then
   * subscribes again after its last cursor on the backoff while the error is retryable, at once
   * when the daemon leaves `recovering`, and after every reconnect.
   */
  #ended: { readonly office: OfficeId; readonly error: EngineError } | null = null;
  /** The one retry timer of both streams (DIPO-327). */
  #resubscribeTimer: TimerHandle | null = null;
  /** Stream retries since the daemon last ran again or the client reconnected (DIPO-327). */
  #retries = 0;
  /** The last stored cursor applied, per stream. */
  readonly #last = new Map<StreamName, Cursor>();
  /** Bumped on every office change; replies for an older one are dropped. */
  #generation = 0;
  /**
   * An office read refused with `engine.recovering`, sent again every `RECOVERY_POLL_MS` and at
   * once when the daemon reaches `running`. A daemon held in `recovering` without its state
   * database answers it with `database.unavailable`, which ends the retry (DIPO-111).
   */
  #retry: { readonly office: OfficeId; readonly read: "snapshot" | "switch" } | null = null;
  #retryTimer: TimerHandle | null = null;
  #stopState: (() => void) | null = null;
  #closed = false;

  constructor(options: OfficeStoreOptions) {
    this.#client = options.client;
    this.#clock = options.clock;
    this.#clientInfo = options.clientInfo;
    this.#state = {
      connection: options.client.state,
      offlineSince: null,
      live: false,
      daemon: null,
      engine: null,
      capabilities: [],
      offices: [],
      office: null,
      loading: false,
      ...EMPTY_OFFICE,
      notice: null,
      snapshots: 0,
      error: null,
      streamError: null,
      database: null,
    };
  }

  get state(): OfficeStoreState {
    return this.#state;
  }

  /** Calls `listener` after every change; returns a function that stops it. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Calls `listener` with the text of every `work.output` event of the selected office, once per
   * stored cursor; returns a function that stops it. The state never holds output text.
   */
  onOutput(listener: (chunk: OutputChunk) => void): () => void {
    this.#outputListeners.add(listener);
    return () => this.#outputListeners.delete(listener);
  }

  /**
   * Calls `listener` with every stored event of the selected office stream, once per cursor, after
   * the store applied it; returns a function that stops it. A view that reads what no event carries
   * (the desk, DIPO-308) reads it again on the events that can change it.
   */
  onOfficeEvent(listener: (event: Event) => void): () => void {
    this.#officeListeners.add(listener);
    return () => this.#officeListeners.delete(listener);
  }

  /**
   * Takes the offices and daemon state from the client's `engine.hello` and subscribes to the
   * software stream after its cursor. Call once, after the client connected.
   */
  start(): void {
    const hello = this.#client.hello;
    if (hello !== null) this.#applyHello(hello);
    this.#stopState = this.#client.onState((state) => this.#onConnection(state));
    this.#update({ connection: this.#client.state });
    this.#subscribeSoftware(hello?.cursor);
  }

  /** Opens `office` from `office.snapshot` and follows its stream (0009 section 2). */
  open(office: OfficeId): Promise<ReadOutcome<OfficeSnapshot>> {
    return this.#load(office, "snapshot");
  }

  /**
   * Switches to `office` with the read `office.switch` (0005 section 8): the state is replaced by
   * the returned snapshot, the previous office stream is unsubscribed, and `office:<id>` is
   * subscribed after the returned cursor. A failed read keeps the current office.
   */
  switchTo(office: OfficeId): Promise<ReadOutcome<OfficeSnapshot>> {
    return this.#load(office, "switch");
  }

  dismissNotice(): void {
    if (this.#state.notice !== null) this.#update({ notice: null });
  }

  /** Stops following; the client stays open for its owner to close. */
  close(): void {
    this.#closed = true;
    this.#clearRetryTimer();
    this.#clearResubscribeTimer();
    this.#stopState?.();
    this.#software?.unsubscribe();
    this.#officeSub?.unsubscribe();
    this.#software = null;
    this.#officeSub = null;
    this.#officeToken = null;
    this.#ended = null;
    this.#listeners.clear();
    this.#outputListeners.clear();
    this.#officeListeners.clear();
  }

  /**
   * Applies one event as if it came from its stream: the event is dropped when its cursor was
   * applied already (stored events only; derived ones carry the position they were sent at).
   */
  apply(event: Event): void {
    const stream = event.cursor.stream;
    const derived = findEvent(event.type)?.derived ?? false;
    if (!derived) {
      if (seen(this.#last.get(stream), event.cursor)) return;
      this.#last.set(stream, event.cursor);
    }
    if (stream === SOFTWARE) this.#applySoftware(event);
    else if (this.#state.office !== null && stream === `office:${this.#state.office}`) {
      this.#applyOffice(event);
      if (!derived) this.#update({ cursor: event.cursor });
      if (!derived && !this.#closed) {
        for (const listener of this.#officeListeners) listener(event);
      }
    }
  }

  /** A read whose client-side failure (a closed client) is an outcome, never a rejection. */
  async #read<A extends z.ZodType, R extends z.ZodType>(
    definition: ReadDefinition<string, A, R>,
    args: z.input<A>,
  ): Promise<ReadOutcome<z.output<R>>> {
    try {
      return await this.#client.read(definition, args);
    } catch (error) {
      const code = error instanceof ClientError ? error.code : "client.failed";
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: { code, message, retryable: false } };
    }
  }

  // Loading and following an office

  /**
   * Reads the office and replaces the state with it. A `timed` load is the retry timer's (DIPO-111):
   * it sets no `loading` and publishes a failure only when the error changed, so a daemon that
   * stays in `recovering` does not make listeners render every `RECOVERY_POLL_MS`.
   */
  async #load(
    office: OfficeId,
    read: "snapshot" | "switch",
    timed = false,
  ): Promise<ReadOutcome<OfficeSnapshot>> {
    const generation = ++this.#generation;
    this.#retry = null;
    this.#clearRetryTimer();
    if (!timed) this.#update({ loading: true });
    const definition = read === "switch" ? officeSwitch : officeSnapshot;
    const outcome = await this.#read(definition, { office });
    if (this.#closed || generation !== this.#generation) return outcome;
    if (!outcome.ok) {
      if (outcome.error.code === "engine.recovering") {
        const retry = { office, read };
        this.#retry = retry;
        this.#retryTimer = this.#clock.setTimeout(() => {
          this.#retryTimer = null;
          if (!this.#closed && this.#retry === retry) void this.#load(office, read, true);
        }, RECOVERY_POLL_MS);
      }
      const unchanged =
        timed && JSON.stringify(this.#state.error) === JSON.stringify(outcome.error);
      const database = databaseOf(outcome.error);
      if (!unchanged) {
        this.#update({
          loading: false,
          error: outcome.error,
          ...(database === undefined ? {} : { database }),
        });
      }
      return outcome;
    }
    this.#replace(office, outcome.result);
    return outcome;
  }

  /**
   * A daemon held in `recovering` with no office selected: one office read, so that its
   * `database.unavailable` answer reaches `database` (DIPO-120). The snapshot is not applied.
   */
  async #probeDatabase(): Promise<void> {
    const office = this.#state.offices[0]?.office;
    if (office === undefined || this.#state.office !== null) return;
    const outcome = await this.#read(officeSnapshot, { office });
    if (this.#closed || this.#state.office !== null || outcome.ok) return;
    const database = databaseOf(outcome.error);
    if (database !== undefined) this.#update({ database });
  }

  #clearRetryTimer(): void {
    if (this.#retryTimer === null) return;
    this.#clock.clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  /** Replaces the office state with `snapshot` and follows `office:<id>` after its cursor. */
  #replace(office: OfficeId, snapshot: OfficeSnapshot): void {
    const previous = this.#officeSub;
    this.#officeSub = null;
    this.#officeToken = null;
    this.#ended = null;
    previous?.unsubscribe();
    const stream = StreamName.parse(`office:${office}`);
    for (const key of this.#last.keys()) if (key !== SOFTWARE) this.#last.delete(key);
    this.#last.set(stream, snapshot.cursor);
    this.#update({
      office,
      loading: false,
      live: false,
      error: null,
      stories: snapshot.stories,
      work: snapshot.work,
      gates: snapshot.gates,
      questions: snapshot.questions,
      tests: snapshot.tests,
      cursor: snapshot.cursor,
      snapshots: this.#state.snapshots + 1,
    });
    this.#follow(office);
  }

  /**
   * Subscribes to `office:<id>` after the last cursor the store applied of it: the snapshot's,
   * or the last event's when it subscribes again after an ended subscription (DIPO-322).
   */
  #follow(office: OfficeId): void {
    const stream = StreamName.parse(`office:${office}`);
    const after = this.#last.get(stream);
    const token = {};
    this.#officeToken = token;
    const current = () => this.#officeToken === token;
    // The error the ended subscription left, cleared once this one has caught up.
    const endedError = this.#state.error;
    this.#officeSub = this.#client.subscribe(stream, {
      ...(after === undefined ? {} : { after }),
      onEvent: (event) => {
        if (current()) this.apply(event);
      },
      onCaughtUp: () => {
        if (!current()) return;
        const cleared = endedError !== null && this.#state.error === endedError;
        this.#update({ live: true, offlineSince: null, ...(cleared ? { error: null } : {}) });
      },
      onEnded: (error) => {
        if (!current()) return;
        this.#officeSub = null;
        this.#officeToken = null;
        if (error.code === "stream.resetRequired") void this.#reload(office);
        else this.#officeEnded(office, error);
      },
    });
  }

  /**
   * The daemon ended the office stream (DIPO-322): the view says it is no longer live and the
   * store subscribes again later, so an open view keeps following once the daemon serves it. A
   * repeated refusal with the same error publishes nothing, so a daemon that stays in
   * `recovering` does not make listeners render on every retry.
   */
  #officeEnded(office: OfficeId, error: EngineError): void {
    const unchanged =
      !this.#state.live && JSON.stringify(this.#state.error) === JSON.stringify(error);
    this.#ended = { office, error };
    const database = databaseOf(error);
    if (!unchanged) {
      this.#update({ error, live: false, ...(database === undefined ? {} : { database }) });
    }
    if (error.retryable) this.#scheduleRetry();
  }

  /**
   * Subscribes again to what the daemon ended with a retryable error after the backoff:
   * `streamRetryDelay` of the retries so far (DIPO-327). One timer serves both streams; a retry
   * that already waits is left as it is, so two streams ended together advance the backoff once.
   */
  #scheduleRetry(): void {
    if (this.#closed || this.#resubscribeTimer !== null) return;
    const delay = streamRetryDelay(this.#retries);
    this.#retries += 1;
    this.#resubscribeTimer = this.#clock.setTimeout(() => {
      this.#resubscribeTimer = null;
      this.#resume(true);
    }, delay);
  }

  /** The daemon runs again or the client reconnected: subscribe again now, the backoff starts over. */
  #resumeNow(): void {
    this.#retries = 0;
    this.#resume();
  }

  /** The error of an ended stream that is not subscribed again on the backoff (DIPO-327). */
  #streamError(): EngineError | null {
    for (const error of [this.#softwareEnded, this.#ended?.error ?? null]) {
      if (error !== null && !error.retryable) return error;
    }
    return null;
  }

  /**
   * Subscribes again to what the daemon ended: the selected office's stream after its last
   * cursor (DIPO-322), and the software stream after its own. A no-op while nothing ended. The
   * backoff timer passes `retryableOnly`: a stream whose error does not retry stays ended.
   */
  #resume(retryableOnly = false): void {
    if (this.#closed || this.#client.state === "closed") return;
    this.#clearResubscribeTimer();
    const shown = this.#state.streamError;
    const due = (error: EngineError) => !retryableOnly || error.retryable;
    const softwareEnded = this.#softwareEnded;
    if (softwareEnded !== null && due(softwareEnded) && this.#software === null) {
      this.#softwareEnded = null;
      this.#subscribeSoftware(this.#last.get(SOFTWARE), softwareEnded);
    }
    const ended = this.#ended;
    if (ended !== null && due(ended.error) && this.#officeSub === null) {
      this.#ended = null;
      if (this.#state.office === ended.office) this.#follow(ended.office);
    }
    // A stream error the header showed is gone once its stream is subscribed again.
    if (shown !== null && this.#streamError() === null) this.#update({});
  }

  #clearResubscribeTimer(): void {
    if (this.#resubscribeTimer === null) return;
    this.#clock.clearTimeout(this.#resubscribeTimer);
    this.#resubscribeTimer = null;
  }

  /** A history gap: drop the view, read `engine.hello` and the snapshot again, say so once. */
  async #reload(office: OfficeId): Promise<void> {
    const generation = this.#generation;
    const hello = await this.#read(engineHello, {
      contract: CONTRACT_VERSION,
      client: this.#clientInfo,
    });
    // A switch during the read owns the state now; reloading the old office would undo it.
    if (this.#closed || generation !== this.#generation) return;
    if (hello.ok) this.#applyHello(hello.result);
    this.#update({ ...EMPTY_OFFICE, notice: RELOADED_NOTICE });
    await this.#load(office, "snapshot");
  }

  // The software stream

  /** `ended` is the error the ended subscription left; it is cleared once this one caught up. */
  #subscribeSoftware(after: Cursor | undefined, ended: EngineError | null = null): void {
    if (after !== undefined) this.#last.set(SOFTWARE, after);
    this.#software = this.#client.subscribe(SOFTWARE, {
      ...(after === undefined ? {} : { after }),
      onEvent: (event) => this.apply(event),
      onCaughtUp: () => {
        const cleared = ended !== null && this.#state.error === ended;
        if (this.#state.office === null) {
          this.#update({ live: true, offlineSince: null, ...(cleared ? { error: null } : {}) });
        } else if (cleared) this.#update({ error: null });
      },
      onEnded: (error) => {
        this.#software = null;
        if (error.code === "stream.resetRequired") void this.#reloadSoftware();
        else this.#softwareEndedWith(error);
      },
    });
  }

  /**
   * The daemon ended the software stream with `error` (DIPO-327): subscribed again on the
   * backoff while it is retryable, like the office stream. A repeated refusal with the same error
   * publishes nothing.
   */
  #softwareEndedWith(error: EngineError): void {
    const unchanged = JSON.stringify(this.#state.error) === JSON.stringify(error);
    this.#softwareEnded = error;
    if (!unchanged) this.#update({ error });
    if (error.retryable) this.#scheduleRetry();
  }

  async #reloadSoftware(): Promise<void> {
    const hello = await this.#read(engineHello, {
      contract: CONTRACT_VERSION,
      client: this.#clientInfo,
    });
    if (this.#closed) return;
    if (!hello.ok) {
      this.#softwareEndedWith(hello.error);
      return;
    }
    this.#last.delete(SOFTWARE);
    this.#applyHello(hello.result);
    this.#update({ notice: RELOADED_NOTICE });
    this.#subscribeSoftware(hello.result.cursor);
  }

  #applyHello(hello: HelloResult): void {
    this.#update({
      daemon: hello.daemon,
      engine: hello.engine,
      capabilities: hello.capabilities,
      offices: hello.offices.map((summary) => ({
        office: summary.office,
        name: summary.name,
        path: summary.path,
        summary,
      })),
      // A fresh hello starts without the database line; a daemon still held answers it again.
      database: null,
    });
    if (hello.daemon === "recovering" && this.#state.office === null) void this.#probeDatabase();
  }

  #applySoftware(event: Event): void {
    switch (event.type) {
      case officeSummary.type: {
        const data = officeSummary.data.safeParse(event.data);
        if (!data.success) return;
        const summary = data.data;
        this.#upsertOffice({
          office: summary.office,
          name: summary.name,
          path: summary.path,
          summary,
        });
        return;
      }
      case officeRegistered.type: {
        const data = officeRegistered.data.safeParse(event.data);
        if (!data.success) return;
        const known = this.#state.offices.find((entry) => entry.office === data.data.office);
        this.#upsertOffice({
          office: data.data.office,
          name: data.data.name,
          path: data.data.path,
          summary: known?.summary,
        });
        return;
      }
      case officeForgotten.type: {
        const data = officeForgotten.data.safeParse(event.data);
        if (!data.success) return;
        this.#update({
          offices: this.#state.offices.filter((entry) => entry.office !== data.data.office),
        });
        return;
      }
      case daemonStateChanged.type: {
        const data = daemonStateChanged.data.safeParse(event.data);
        if (!data.success) return;
        const to = data.data.to;
        this.#update({ daemon: to, ...(to === "draining" ? { database: null } : {}) });
        const retry = this.#retry;
        if (to === "running" && retry !== null) void this.#load(retry.office, retry.read);
        // Out of `recovering`, the daemon serves office streams again (DIPO-322).
        if (to === "running" || to === "safe") this.#resumeNow();
        if (to === "recovering" && this.#state.office === null) void this.#probeDatabase();
        return;
      }
      default:
        return;
    }
  }

  #upsertOffice(entry: OfficeEntry): void {
    const offices = this.#state.offices;
    const index = offices.findIndex((candidate) => candidate.office === entry.office);
    this.#update({
      offices: index === -1 ? [...offices, entry] : offices.with(index, entry),
    });
  }

  // The office stream

  #applyOffice(event: Event): void {
    for (const definition of WORK_EVENTS) {
      if (event.type !== definition.type) continue;
      const data = definition.data.safeParse(event.data);
      // Without a view the event changes nothing shown: the store never derives one.
      if (data.success && data.data.view !== undefined) this.#putWork(data.data.view);
      if (event.type === workOutput.type) this.#emitOutput(event);
      return;
    }
    switch (event.type) {
      case storyState.type: {
        const data = storyState.data.safeParse(event.data);
        if (data.success) this.#putStory(data.data.view);
        return;
      }
      case storyRenumbered.type: {
        const data = storyRenumbered.data.safeParse(event.data);
        if (!data.success) return;
        const { key, to } = data.data;
        this.#update({
          stories: this.#state.stories.map((view) =>
            view.key === key ? { ...view, story: to } : view,
          ),
        });
        return;
      }
      case gateReached.type: {
        const data = gateReached.data.safeParse(event.data);
        if (!data.success) return;
        const gates = this.#state.gates.filter((gate) => gate.gate !== data.data.gate);
        this.#update({ gates: [...gates, data.data] });
        return;
      }
      case gateDecided.type: {
        const data = gateDecided.data.safeParse(event.data);
        if (!data.success) return;
        this.#update({ gates: this.#state.gates.filter((gate) => gate.gate !== data.data.gate) });
        return;
      }
      case questionAsked.type: {
        const data = questionAsked.data.safeParse(event.data);
        if (!data.success) return;
        const rest = this.#state.questions.filter((q) => q.question !== data.data.question);
        this.#update({ questions: [...rest, data.data] });
        return;
      }
      case questionClosed.type: {
        const data = questionClosed.data.safeParse(event.data);
        if (!data.success) return;
        this.#update({
          questions: this.#state.questions.filter((q) => q.question !== data.data.question),
        });
        return;
      }
      case testStarted.type: {
        const data = testStarted.data.safeParse(event.data);
        if (!data.success) return;
        const rest = this.#state.tests.filter((test) => test.test !== data.data.test);
        this.#update({ tests: [...rest, data.data] });
        return;
      }
      case testRecorded.type: {
        const data = testRecorded.data.safeParse(event.data);
        if (!data.success) return;
        this.#update({ tests: this.#state.tests.filter((test) => test.test !== data.data.test) });
        return;
      }
      case testEnded.type: {
        const data = testEnded.data.safeParse(event.data);
        if (!data.success) return;
        this.#update({ tests: this.#state.tests.filter((test) => test.test !== data.data.test) });
        return;
      }
      default:
        return;
    }
  }

  /** Replaces the story's view; a run the new view no longer names is no longer shown. */
  #putStory(view: StoryView): void {
    const stories = this.#state.stories;
    const index = stories.findIndex((candidate) => candidate.key === view.key);
    const work = this.#state.work.filter(
      (candidate) => candidate.work.key !== view.key || candidate.work.run === view.work?.run,
    );
    this.#update({
      stories: index === -1 ? [...stories, view] : stories.with(index, view),
      work,
    });
  }

  #emitOutput(event: Event): void {
    if (this.#closed) return;
    const data = workOutput.data.safeParse(event.data);
    if (!data.success) return;
    const { work, source, from, to, text, markers } = data.data;
    const chunk: OutputChunk = {
      run: work.run,
      source,
      from,
      to,
      text,
      ...(markers === undefined ? {} : { markers }),
    };
    for (const listener of this.#outputListeners) listener(chunk);
  }

  /** Replaces the run's view by `run`. */
  #putWork(view: WorkView): void {
    const work = this.#state.work;
    const index = work.findIndex((candidate) => candidate.work.run === view.work.run);
    this.#update({ work: index === -1 ? [...work, view] : work.with(index, view) });
  }

  // Connection

  #onConnection(connection: ConnectionState): void {
    if (connection === "reconnecting" || connection === "closed") {
      this.#update({
        connection,
        live: false,
        offlineSince: this.#state.offlineSince ?? this.#clock.now(),
      });
      return;
    }
    if (connection === "open") {
      // A new connection answered `engine.hello` again; its offices and daemon state are current.
      const hello = this.#client.hello;
      if (hello !== null) this.#applyHello(hello);
      // After the client re-sent its subscriptions on the new connection: what the daemon ended
      // is no longer among them (DIPO-322). The backoff starts over at once (DIPO-327).
      this.#retries = 0;
      queueMicrotask(() => this.#resume());
    }
    this.#update({ connection });
  }

  #update(patch: Partial<OfficeStoreState>): void {
    if (this.#closed) return;
    // `streamError` follows the ended streams; it is never patched on its own.
    this.#state = { ...this.#state, ...patch, streamError: this.#streamError() };
    for (const listener of this.#listeners) listener();
  }
}
