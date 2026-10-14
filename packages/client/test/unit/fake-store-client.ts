// A `StoreClient` the test drives by hand: reads answer from a table, subscriptions are recorded
// and fed events by the test, and the connection state changes when the test says so.

import type { Cursor, EngineError, Event, StreamName } from "@dipsaus-orchestrator/contract";

import type {
  ConnectionState,
  HelloResult,
  ReadOutcome,
  StoreClient,
  SubscribeOptions,
  Subscription,
} from "../../src/index";

export interface FakeSubscription {
  readonly stream: StreamName;
  readonly after: Cursor | undefined;
  readonly options: SubscribeOptions;
  active: boolean;
}

type Answer = (
  args: Record<string, unknown>,
) => ReadOutcome<unknown> | Promise<ReadOutcome<unknown>>;

export class FakeStoreClient implements StoreClient {
  state: ConnectionState = "open";
  hello: HelloResult | null;
  readonly reads: { name: string; args: Record<string, unknown> }[] = [];
  readonly subscriptions: FakeSubscription[] = [];
  readonly answers = new Map<string, Answer>();
  readonly #listeners = new Set<(state: ConnectionState) => void>();

  constructor(hello: HelloResult) {
    this.hello = hello;
  }

  onState(listener: (state: ConnectionState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  setState(state: ConnectionState): void {
    this.state = state;
    for (const listener of this.#listeners) listener(state);
  }

  read: StoreClient["read"] = (async (
    definition: { name: string },
    args: Record<string, unknown>,
  ) => {
    this.reads.push({ name: definition.name, args });
    const answer = this.answers.get(definition.name);
    if (answer === undefined) throw new Error(`no answer for ${definition.name}`);
    return answer(args);
  }) as StoreClient["read"];

  subscribe: StoreClient["subscribe"] = (stream, options) => {
    const entry: FakeSubscription = { stream, after: options.after, options, active: true };
    this.subscriptions.push(entry);
    const subscription: Subscription = {
      stream,
      cursor: options.after,
      unsubscribe: () => {
        entry.active = false;
      },
    };
    return subscription;
  };

  /** The newest active subscription to `stream`. */
  active(stream: string): FakeSubscription {
    const found = this.subscriptions.findLast((s) => s.stream === stream && s.active);
    if (found === undefined) throw new Error(`no active subscription to ${stream}`);
    return found;
  }

  emit(stream: string, event: Event): void {
    this.active(stream).options.onEvent(event);
  }

  end(stream: string, error: EngineError): void {
    const subscription = this.active(stream);
    subscription.active = false;
    subscription.options.onEnded?.(error);
  }
}

/** Lets pending promise callbacks run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}
