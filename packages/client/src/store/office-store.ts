// The `OfficeStore` (0009 sections 2 and 7, 0005 section 8): the state every UI renders, fed by
// `engine.hello`, the software stream, one office's snapshot and that office's stream. It applies
// events by subject (story `key`, `run`, `gate`, `question`, `test`, `office`), drops stored
// events whose cursor it already has, and replaces the views the engine sends. It never computes
// column, health, phase, evidence or cost: an event without a view changes nothing it shows.
//
// Runtime-free like the rest of the client core: time comes from the injected clock.

import {
  type Clock,
  CONTRACT_VERSION,
  type Cursor,
  type DaemonState,
  daemonStateChanged,
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
  officeSummary,
  officeSwitch,
  questionAsked,
  questionClosed,
  type QuestionView,
  type ReadDefinition,
  storyRenumbered,
  storyState,
  type StoryView,
  StreamName,
  testRecorded,
  testStarted,
  type TestView,
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
  type DipoClient,
  type HelloResult,
  type ReadOutcome,
  type Subscription,
} from "../client";

/** What the store needs from a connected client; `DipoClient` is one. */
export type StoreClient = Pick<DipoClient, "state" | "hello" | "onState" | "read" | "subscribe">;

/** Shown once after a history gap made the store drop its view and read it again (0009 section 7). */
export const RELOADED_NOTICE = "view reloaded (history gap)";

const SOFTWARE = StreamName.parse("software");

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
  /** A one-time message, such as `RELOADED_NOTICE`; cleared by `dismissNotice`. */
  readonly notice: string | null;
  /** The last failed read or ended subscription, until the next success. */
  readonly error: EngineError | null;
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
 * of the same office stream (read-your-writes, 0009 section 5). Another epoch means the stream
 * restarted and the store reads a fresh snapshot, so the write is not waited for any longer.
 */
export function cursorReached(current: Cursor | null, target: Cursor): boolean {
  if (current === null || current.stream !== target.stream) return false;
  return current.epoch !== target.epoch || current.seq >= target.seq;
}

export class OfficeStore {
  readonly #client: StoreClient;
  readonly #clock: Clock;
  readonly #clientInfo: { readonly name: string; readonly version: string };
  readonly #listeners = new Set<() => void>();
  #state: OfficeStoreState;

  #software: Subscription | null = null;
  #officeSub: Subscription | null = null;
  /** The last stored cursor applied, per stream. */
  readonly #last = new Map<StreamName, Cursor>();
  /** Bumped on every office change; replies for an older one are dropped. */
  #generation = 0;
  /** An office read refused with `engine.recovering`, retried when the daemon is `running`. */
  #retry: { readonly office: OfficeId; readonly read: "snapshot" | "switch" } | null = null;
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
      error: null,
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
    this.#stopState?.();
    this.#software?.unsubscribe();
    this.#officeSub?.unsubscribe();
    this.#software = null;
    this.#officeSub = null;
    this.#listeners.clear();
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

  async #load(office: OfficeId, read: "snapshot" | "switch"): Promise<ReadOutcome<OfficeSnapshot>> {
    const generation = ++this.#generation;
    this.#retry = null;
    this.#update({ loading: true });
    const definition = read === "switch" ? officeSwitch : officeSnapshot;
    const outcome = await this.#read(definition, { office });
    if (this.#closed || generation !== this.#generation) return outcome;
    if (!outcome.ok) {
      if (outcome.error.code === "engine.recovering") this.#retry = { office, read };
      this.#update({ loading: false, error: outcome.error });
      return outcome;
    }
    this.#replace(office, outcome.result);
    return outcome;
  }

  /** Replaces the office state with `snapshot` and follows `office:<id>` after its cursor. */
  #replace(office: OfficeId, snapshot: OfficeSnapshot): void {
    const previous = this.#officeSub;
    this.#officeSub = null;
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
    });
    const generation = this.#generation;
    this.#officeSub = this.#client.subscribe(stream, {
      after: snapshot.cursor,
      onEvent: (event) => {
        if (generation === this.#generation) this.apply(event);
      },
      onCaughtUp: () => {
        if (generation === this.#generation) this.#update({ live: true, offlineSince: null });
      },
      onEnded: (error) => {
        if (generation !== this.#generation) return;
        this.#officeSub = null;
        if (error.code === "stream.resetRequired") void this.#reload(office);
        else this.#update({ error, live: false });
      },
    });
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

  #subscribeSoftware(after: Cursor | undefined): void {
    if (after !== undefined) this.#last.set(SOFTWARE, after);
    this.#software = this.#client.subscribe(SOFTWARE, {
      ...(after === undefined ? {} : { after }),
      onEvent: (event) => this.apply(event),
      onCaughtUp: () => {
        if (this.#state.office === null) this.#update({ live: true, offlineSince: null });
      },
      onEnded: (error) => {
        this.#software = null;
        if (error.code === "stream.resetRequired") void this.#reloadSoftware();
        else this.#update({ error });
      },
    });
  }

  async #reloadSoftware(): Promise<void> {
    const hello = await this.#read(engineHello, {
      contract: CONTRACT_VERSION,
      client: this.#clientInfo,
    });
    if (this.#closed) return;
    if (!hello.ok) {
      this.#update({ error: hello.error });
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
    });
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
        this.#update({ daemon: data.data.to });
        const retry = this.#retry;
        if (data.data.to === "running" && retry !== null) void this.#load(retry.office, retry.read);
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
    }
    this.#update({ connection });
  }

  #update(patch: Partial<OfficeStoreState>): void {
    if (this.#closed) return;
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
}
