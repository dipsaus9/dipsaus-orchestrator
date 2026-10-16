// A client session for TUI tests, fed from the golden event log in `fixtures/three-offices.json`:
// `engine.hello` knows one office, the software stream registers two more and sends summaries,
// and each office answers `office.snapshot` and `office.switch` with its snapshot. Every event and
// snapshot is parsed with its contract schema first, so the log stays a valid contract recording.
// `fixtures/live-output.json` holds the stored output `work.outputRange` answers from (DIPO-55).

import type {
  ConnectionState,
  HelloResult,
  SubscribeOptions,
  Subscription,
} from "@dipsaus-orchestrator/client";
import {
  type Cursor,
  type EngineError,
  type Event,
  Event as EventSchema,
  engineHello,
  findEvent,
  type OfficeId,
  type OutputMarker,
  OfficeSnapshot,
  type RunRecord,
  type StreamName,
} from "@dipsaus-orchestrator/contract";

import type { TuiSession } from "../run";
import outputLog from "./fixtures/live-output.json";
import log from "./fixtures/three-offices.json";

export const OFFICES = {
  dipsaus: "off_01J9ZK5Q8W3V4X6Y7Z8A9B0CAA" as OfficeId,
  couchcade: "off_01J9ZK5Q8W3V4X6Y7Z8A9B0CBB" as OfficeId,
  slaydoku: "off_01J9ZK5Q8W3V4X6Y7Z8A9B0CCC" as OfficeId,
};

function parseEvent(raw: unknown): Event {
  const event = EventSchema.parse(raw);
  const definition = findEvent(event.type);
  if (definition === undefined) throw new Error(`unknown event ${event.type}`);
  definition.data.parse(event.data);
  return event;
}

export const goldenHello: HelloResult = engineHello.result.parse(log.hello);
export const goldenSoftware: readonly Event[] = log.software.map(parseEvent);
export const goldenSnapshots: ReadonlyMap<string, OfficeSnapshot> = new Map(
  Object.entries(log.snapshots).map(([office, snapshot]) => [
    office,
    OfficeSnapshot.parse(snapshot),
  ]),
);

/** The `work.output` events of `fixtures/live-output.json`, after the stored output they extend. */
export const goldenOutputEvents: readonly Event[] = outputLog.events.map(parseEvent);

export interface RecordedSubscription {
  readonly stream: StreamName;
  readonly after: unknown;
  readonly options: SubscribeOptions;
  active: boolean;
}

export class FakeSession implements TuiSession {
  state: ConnectionState = "open";
  hello: HelloResult | null = goldenHello;
  readonly reads: { readonly name: string; readonly args: unknown }[] = [];
  readonly commands: {
    readonly name: string;
    readonly args: unknown;
    readonly options?: unknown;
  }[] = [];
  /** Answers `work.run`; by default every story asked for starts. */
  runReply: (args: { stories?: string[] }) => unknown = (args) => ({
    ok: true,
    result: {
      started: (args.stories ?? []).map((story) => ({ story, key: story, run: "run_x" })),
      skipped: [],
    },
    changed: true,
  });
  /** Answers `work.stop`; by default the run stops with no reply cursor. */
  stopReply: (args: { story?: string }) => unknown = () => ({
    ok: true,
    result: { run: "run_01J9ZK5Q8W3V4X6Y7Z8A9B0C24" },
    changed: true,
  });
  readonly subscriptions: RecordedSubscription[] = [];
  /** Replies to `office.open` by path; a missing path answers `office.notFound`. */
  readonly opened = new Map<string, OfficeId>();
  /** Snapshots answered instead of the golden ones, for example after a history gap. */
  readonly nextSnapshots = new Map<string, OfficeSnapshot>();
  closed = false;
  readonly #listeners = new Set<(state: ConnectionState) => void>();

  onState(listener: (state: ConnectionState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  setState(state: ConnectionState): void {
    this.state = state;
    for (const listener of this.#listeners) listener(state);
  }

  /**
   * Stored output by `<run>:<source>` for `work.outputRange`, ASCII so characters are bytes. The
   * golden output log fills it; tests append to it as the engine stores more.
   */
  readonly output = new Map<string, string>(
    Object.entries(outputLog.stored).map(([key, lines]) => [key, lines.join("")]),
  );
  /** Engine marker flags of the stored output by `<run>:<source>` (DIPO-95). */
  readonly markers = new Map<string, OutputMarker[]>();
  /** `story.detail` runs by story key (oldest first); a story not listed has run never (DIPO-81). */
  readonly runs = new Map<string, RunRecord[]>();

  /** The most bytes one `work.outputRange` returns, as the engine's cap. */
  rangeMax = 1024 * 1024;

  read = (async (
    definition: { name: string },
    args: {
      office?: string;
      run?: string;
      source?: string;
      from?: number;
      to?: number;
      story?: string;
    },
  ) => {
    this.reads.push({ name: definition.name, args });
    if (definition.name === "engine.hello") return { ok: true, result: goldenHello };
    if (definition.name === "story.detail") {
      const stories =
        (this.nextSnapshots.get(args.office ?? "") ?? goldenSnapshots.get(args.office ?? ""))
          ?.stories ?? [];
      const view = stories.find((story) => story.key === args.story);
      if (view === undefined) {
        return {
          ok: false,
          error: { code: "story.unknown", message: "no such story", retryable: false },
        };
      }
      return {
        ok: true,
        result: { view, runs: this.runs.get(args.story ?? "") ?? [], verdicts: [] },
      };
    }
    if (definition.name === "work.outputRange") {
      const text = this.output.get(`${args.run}:${args.source}`) ?? "";
      const from = Math.min(args.from ?? 0, text.length);
      const to = Math.min(args.to ?? text.length, text.length, from + this.rangeMax);
      const markers = (this.markers.get(`${args.run}:${args.source}`) ?? []).filter(
        (marker) => marker.from < to && marker.to > from,
      );
      return {
        ok: true,
        result: {
          run: args.run,
          source: args.source,
          from,
          to,
          text: text.slice(from, to),
          ...(markers.length === 0 ? {} : { markers }),
        },
      };
    }
    const snapshot =
      this.nextSnapshots.get(args.office ?? "") ?? goldenSnapshots.get(args.office ?? "");
    if (snapshot === undefined) {
      return {
        ok: false,
        error: { code: "office.unknown", message: "no such office", retryable: false },
      };
    }
    return { ok: true, result: snapshot };
  }) as unknown as TuiSession["read"];

  command = (async (
    definition: { name: string },
    args: { path?: string; stories?: string[]; story?: string },
    options?: unknown,
  ) => {
    this.commands.push(
      options === undefined
        ? { name: definition.name, args }
        : { name: definition.name, args, options },
    );
    if (definition.name === "work.run") return this.runReply(args);
    if (definition.name === "work.stop") return this.stopReply(args);
    if (definition.name === "office.open") {
      const office = this.opened.get(args.path ?? "");
      if (office === undefined) {
        const error: EngineError = {
          code: "office.notFound",
          message: "not a repository",
          retryable: false,
        };
        return { ok: false, error };
      }
      return { ok: true, result: { office, registered: true }, changed: true };
    }
    return { ok: true, result: { state: "running" }, changed: true };
  }) as unknown as TuiSession["command"];

  subscribe = ((stream: StreamName, options: SubscribeOptions): Subscription => {
    const entry: RecordedSubscription = { stream, after: options.after, options, active: true };
    this.subscriptions.push(entry);
    queueMicrotask(() => {
      if (stream === "software") {
        for (const event of goldenSoftware) if (entry.active) options.onEvent(event);
      }
      // Replay is done: the daemon's `stream.mark { caughtUp: true }`, as the client reports it.
      const cursor = (options.after ?? { stream, epoch: "e1", seq: 0 }) as Cursor;
      if (entry.active) options.onCaughtUp?.(cursor);
    });
    return {
      stream,
      cursor: options.after,
      unsubscribe: () => {
        entry.active = false;
      },
    };
  }) as TuiSession["subscribe"];

  close(): void {
    this.closed = true;
  }

  /** The newest active subscription to `stream`, or undefined. */
  active(stream: string): RecordedSubscription | undefined {
    return this.subscriptions.findLast((entry) => entry.stream === stream && entry.active);
  }

  /**
   * As the engine does for a `work.output` event: stores its text first, then sends it on the
   * office stream it names. `deliver: false` stores it without sending, a missed event.
   */
  storeOutput(event: Event, deliver = true): void {
    const data = event.data as {
      work: { run: string };
      source: string;
      text: string;
      markers?: OutputMarker[];
    };
    const key = `${data.work.run}:${data.source}`;
    this.output.set(key, (this.output.get(key) ?? "") + data.text);
    if (data.markers !== undefined) {
      this.markers.set(key, [...(this.markers.get(key) ?? []), ...data.markers]);
    }
    if (deliver) this.active(event.cursor.stream)?.options.onEvent(event);
  }
}
