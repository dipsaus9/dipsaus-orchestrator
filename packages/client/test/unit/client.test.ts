// The protocol core against a fake transport on the manual clock (DIPO-25 test plan): the
// handshake, reply matching, typed methods, reconnect with backoff, re-sending an unanswered
// command with the same `requestId`, re-subscribing after the last cursor and dropping duplicates.

import { describe, expect, it } from "bun:test";

import {
  CONTRACT_VERSION,
  type Cursor,
  daemonResumeScheduling,
  daemonSetLogLevel,
  daemonStatus,
  type Event,
  RequestId,
  type ServerFrame,
  type StreamName,
} from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import {
  ClientError,
  type ConnectionState,
  DipoClient,
  LIVENESS_MS,
  reconnectDelay,
  STREAM_MARK_MS,
  ulidRequestIds,
} from "../../src/index";
import { type FakeConnection, FakeTransport } from "./fake-transport";

const SOFTWARE = "software" as StreamName;

function cursor(seq: number, epoch = "ep1"): Cursor {
  return { stream: SOFTWARE, epoch, seq };
}

function hello(daemon: "running" | "safe" = "running", seq = 0) {
  return {
    engine: "0.0.0-test",
    contract: CONTRACT_VERSION,
    capabilities: [],
    daemon,
    offices: [],
    cursor: cursor(seq),
  };
}

function reply(requestId: string, result: unknown, changed?: boolean): ServerFrame {
  return {
    kind: "reply",
    reply:
      changed === undefined
        ? { ok: true, requestId: requestId as RequestId, result }
        : { ok: true, requestId: requestId as RequestId, result, changed },
  };
}

function errorReply(requestId: string, code: string, message = "refused"): ServerFrame {
  return {
    kind: "reply",
    reply: {
      ok: false,
      requestId: requestId as RequestId,
      error: { code, message, retryable: false },
    },
  };
}

function event(seq: number, type: string, data: unknown, epoch = "ep1"): Event {
  return { cursor: cursor(seq, epoch), at: "2026-01-01T00:00:00.000Z", type, data };
}

function requestIdOf(connection: FakeConnection, index = -1): string {
  const frame = connection.sent.at(index);
  if (frame === undefined || !("requestId" in frame)) throw new Error("no request frame");
  return frame.requestId;
}

function setup() {
  const clock = new ManualClock();
  const transport = new FakeTransport();
  let counter = 0;
  const client = new DipoClient({
    transport,
    clock,
    client: { name: "test", version: "1" },
    origin: "cli",
    requestIds: () => {
      counter += 1;
      return `0${String(counter).padStart(25, "0")}` as RequestId;
    },
  });
  const states: ConnectionState[] = [];
  client.onState((state) => states.push(state));
  return { clock, transport, client, states };
}

/** Opens the current connection and answers its `engine.hello`. */
function accept(transport: FakeTransport, result = hello()): FakeConnection {
  const connection = transport.current;
  connection.open();
  const first = connection.sent[0];
  if (first?.kind !== "read" || first.name !== "engine.hello") {
    throw new Error("the first frame was not engine.hello");
  }
  connection.deliver(reply(first.requestId, result));
  return connection;
}

async function connected() {
  const ctx = setup();
  const done = ctx.client.connect();
  accept(ctx.transport);
  await done;
  return ctx;
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("DipoClient handshake and requests", () => {
  it("sends engine.hello first with the contract version and holds requests until it is answered", async () => {
    const { transport, client, states } = setup();
    const done = client.connect();
    const status = client.read(daemonStatus, {});
    const connection = transport.current;
    connection.open();
    expect(connection.sent).toHaveLength(1);
    expect(connection.sent[0]).toMatchObject({
      kind: "read",
      name: "engine.hello",
      args: { contract: CONTRACT_VERSION, client: { name: "test", version: "1" } },
    });
    connection.deliver(reply(requestIdOf(connection, 0), hello("safe")));
    expect((await done).daemon).toBe("safe");
    expect(client.hello?.daemon).toBe("safe");
    expect(states).toEqual(["connecting", "open"]);
    // The read went out only after the hello reply.
    expect(connection.sent[1]).toMatchObject({ kind: "read", name: "daemon.status" });
    connection.deliver(errorReply(requestIdOf(connection, 1), "internal"));
    expect(await status).toMatchObject({ ok: false, error: { code: "internal" } });
  });

  it("matches replies by requestId in any order and parses results with the contract schema", async () => {
    const { transport, client } = await connected();
    const connection = transport.current;
    const first = client.command(daemonSetLogLevel, { level: "debug" });
    const second = client.command(daemonResumeScheduling, {});
    const [a, b] = [requestIdOf(connection, -2), requestIdOf(connection, -1)];
    expect(connection.sent.at(-2)).toMatchObject({
      kind: "command",
      name: "daemon.setLogLevel",
      args: { level: "debug" },
      origin: "cli",
      confirmed: false,
    });
    connection.deliver(errorReply(b, "daemon.notSafe", "not safe"));
    connection.deliver(reply(a, { level: "debug" }, true));
    expect(await first).toEqual({ ok: true, result: { level: "debug" }, changed: true });
    expect(await second).toEqual({
      ok: false,
      error: { code: "daemon.notSafe", message: "not safe", retryable: false },
    });
  });

  it("rejects invalid args before sending and a reply that does not match the contract", async () => {
    const { transport, client } = await connected();
    const connection = transport.current;
    const sent = connection.sent.length;
    const bad = client.command(daemonSetLogLevel, { level: "loud" as "debug" });
    await expect(bad).rejects.toMatchObject({ code: "client.invalidArgs" });
    expect(connection.sent).toHaveLength(sent);

    const wrong = client.command(daemonSetLogLevel, { level: "warn" });
    connection.deliver(reply(requestIdOf(connection), { level: "loud" }, true));
    await expect(wrong).rejects.toMatchObject({ code: "client.invalidReply" });
  });

  it("ignores frames that are not ServerFrames", async () => {
    const { transport, client } = await connected();
    const connection = transport.current;
    const pending = client.command(daemonSetLogLevel, { level: "info" });
    connection.deliver("not json");
    connection.deliver(JSON.stringify({ kind: "nonsense" }));
    connection.deliver(reply(requestIdOf(connection), { level: "info" }, false));
    expect(await pending).toMatchObject({ ok: true, changed: false });
  });

  it("fails the first connect with client.unreachable when the connection fails", async () => {
    const { transport, client } = setup();
    const done = client.connect();
    transport.current.drop();
    await expect(done).rejects.toMatchObject({ code: "client.unreachable" });
    expect(client.state).toBe("closed");
    expect(transport.connections).toHaveLength(1);
  });

  it("fails the first connect with client.unreachable when hello is not answered in time", async () => {
    const { clock, transport, client } = setup();
    const done = client.connect({ timeoutMs: 1000 });
    transport.current.open();
    clock.advance(999);
    expect(client.state).toBe("connecting");
    clock.advance(1);
    await expect(done).rejects.toMatchObject({ code: "client.unreachable" });
    expect(transport.current.closedByClient).toBe(true);
  });

  it("ends with the engine's code when engine.hello fails", async () => {
    const { transport, client } = setup();
    const done = client.connect();
    const connection = transport.current;
    connection.open();
    connection.deliver(errorReply(requestIdOf(connection, 0), "contract.unsupported"));
    const error = await done.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClientError);
    expect(error).toMatchObject({ code: "contract.unsupported" });
    expect(client.state).toBe("closed");
  });

  it("fails unanswered requests with client.closed on close and stops reconnecting", async () => {
    const { clock, transport, client } = await connected();
    const pending = client.command(daemonSetLogLevel, { level: "info" });
    client.close();
    await expect(pending).rejects.toMatchObject({ code: "client.closed" });
    clock.advance(60_000);
    expect(transport.connections).toHaveLength(1);
    await expect(client.read(daemonStatus, {})).rejects.toMatchObject({ code: "client.closed" });
  });
});

describe("DipoClient reconnect", () => {
  it("waits 0.5 s, then doubles up to 5 s between attempts, and resets after a hello", async () => {
    expect([0, 1, 2, 3, 4, 5].map(reconnectDelay)).toEqual([500, 1000, 2000, 4000, 5000, 5000]);

    const { clock, transport, client, states } = await connected();
    transport.current.drop();
    expect(client.state).toBe("reconnecting");

    const opened: number[] = [];
    const start = clock.now();
    for (const delay of [500, 1000, 2000, 4000, 5000, 5000]) {
      const before = transport.connections.length;
      clock.advance(delay - 1);
      expect(transport.connections).toHaveLength(before);
      clock.advance(1);
      expect(transport.connections).toHaveLength(before + 1);
      opened.push(clock.now() - start);
      transport.current.drop(); // the attempt fails
    }
    expect(opened).toEqual([500, 1500, 3500, 7500, 12500, 17500]);

    clock.advance(5000);
    accept(transport);
    expect(client.state).toBe("open");
    // A later loss starts again at 0.5 s.
    transport.current.drop();
    const before = transport.connections.length;
    clock.advance(500);
    expect(transport.connections).toHaveLength(before + 1);
    expect(states).toContain("reconnecting");
  });

  it("re-sends an unanswered command with the same requestId after the new hello", async () => {
    const { clock, transport, client } = await connected();
    const first = transport.current;
    const pending = client.command(daemonSetLogLevel, { level: "debug" });
    const id = requestIdOf(first);
    first.drop();

    // A command sent while disconnected waits for the next connection.
    const later = client.command(daemonResumeScheduling, {});
    clock.advance(500);
    const second = transport.current;
    second.open();
    expect(second.sent).toHaveLength(1); // only engine.hello before its reply
    second.deliver(reply(requestIdOf(second, 0), hello()));
    expect(second.sent.slice(1)).toMatchObject([
      { kind: "command", name: "daemon.setLogLevel", requestId: id, args: { level: "debug" } },
      { kind: "command", name: "daemon.resumeScheduling" },
    ]);
    // The engine answers the retry from its request table; a late answer on the old connection is ignored.
    first.deliver(reply(id, { level: "warn" }, true));
    second.deliver(reply(id, { level: "debug" }, false));
    expect(await pending).toEqual({ ok: true, result: { level: "debug" }, changed: false });
    second.deliver(reply(requestIdOf(second), { state: "running" }, true));
    expect(await later).toMatchObject({ ok: true, result: { state: "running" } });
  });

  it("re-subscribes after the last cursor and drops events it already has", async () => {
    const { clock, transport, client } = await connected();
    const seen: Event[] = [];
    const caughtUp: Cursor[] = [];
    const subscription = client.subscribe(SOFTWARE, {
      after: cursor(0),
      onEvent: (e) => seen.push(e),
      onCaughtUp: (c) => caughtUp.push(c),
    });
    const first = transport.current;
    expect(first.last()).toMatchObject({ kind: "subscribe", stream: "software", after: cursor(0) });
    first.deliver(reply(requestIdOf(first), { stream: "software", from: cursor(0) }));
    first.deliver({
      kind: "events",
      events: [
        event(1, "daemon.state", { from: "safe", to: "running" }),
        event(2, "daemon.state", { from: "running", to: "draining" }),
        event(2, "stream.mark", { caughtUp: true }),
      ],
    });
    expect(subscription.cursor).toEqual(cursor(2));
    expect(caughtUp).toEqual([cursor(2)]);
    first.drop();

    clock.advance(500);
    const second = accept(transport);
    expect(second.last()).toMatchObject({
      kind: "subscribe",
      stream: "software",
      after: cursor(2),
    });
    second.deliver(reply(requestIdOf(second), { stream: "software", from: cursor(2) }));
    // At-least-once delivery: seq 2 again is dropped, seq 3 is new, derived events always pass.
    second.deliver({
      kind: "events",
      events: [
        event(2, "daemon.state", { from: "running", to: "draining" }),
        event(3, "engine.notice", { level: "info", code: "x", text: "y" }),
        event(3, "stream.mark", { caughtUp: true }),
      ],
    });
    expect(seen.map((e) => `${e.type}@${e.cursor.seq}`)).toEqual([
      "daemon.state@1",
      "daemon.state@2",
      "stream.mark@2",
      "engine.notice@3",
      "stream.mark@3",
    ]);
    expect(caughtUp).toEqual([cursor(2), cursor(3)]);

    subscription.unsubscribe();
    expect(second.last()).toEqual({ kind: "unsubscribe", stream: SOFTWARE });
    second.deliver({
      kind: "events",
      events: [event(4, "engine.notice", { level: "info", code: "x", text: "z" })],
    });
    expect(seen).toHaveLength(5);
  });

  it("starts a subscription without a cursor at the reply's from", async () => {
    const { transport, client } = await connected();
    const subscription = client.subscribe(SOFTWARE, { onEvent: () => {} });
    const connection = transport.current;
    expect(connection.last()).not.toHaveProperty("after");
    connection.deliver(reply(requestIdOf(connection), { stream: "software", from: cursor(7) }));
    expect(subscription.cursor).toEqual(cursor(7));
  });

  it("ends a subscription the daemon refuses with stream.resetRequired", async () => {
    const { clock, transport, client } = await connected();
    const ended: string[] = [];
    client.subscribe(SOFTWARE, {
      after: cursor(5),
      onEvent: () => {},
      onEnded: (error) => ended.push(error.code),
    });
    transport.current.deliver(
      reply(requestIdOf(transport.current), { stream: "software", from: cursor(5) }),
    );
    transport.current.drop();
    clock.advance(500);
    const second = accept(transport, { ...hello(), cursor: cursor(0, "ep2") });
    second.deliver(errorReply(requestIdOf(second), "stream.resetRequired"));
    expect(ended).toEqual(["stream.resetRequired"]);
    expect(client.hello?.cursor.epoch).toBe("ep2");
    // Not re-sent on the next reconnect.
    second.drop();
    clock.advance(500);
    const third = accept(transport);
    expect(third.sent).toHaveLength(1);
    await flush();
  });
});

describe("ulidRequestIds", () => {
  it("makes request ids the contract accepts, with the time from the clock", () => {
    const clock = new ManualClock();
    const ids = ulidRequestIds(clock, (bytes) => bytes.fill(255));
    const id = ids();
    expect(RequestId.safeParse(id).success).toBe(true);
    expect(id.endsWith("Z".repeat(16))).toBe(true);
    clock.advance(1);
    expect(ids() > id).toBe(true);
    expect(ulidRequestIds(clock)()).not.toBe(ulidRequestIds(clock)());
  });
});

describe("DipoClient liveness (DIPO-52)", () => {
  it("closes a subscribed connection with no frame for three stream.mark intervals and reconnects", async () => {
    const { clock, transport, client } = await connected();
    const events: Event[] = [];
    client.subscribe(SOFTWARE, { onEvent: (e) => events.push(e) });
    const first = transport.current;
    first.deliver(reply(requestIdOf(first), { stream: SOFTWARE, from: cursor(0) }));
    // Heartbeats keep it alive.
    for (let i = 1; i <= 4; i++) {
      clock.advance(STREAM_MARK_MS);
      first.deliver({ kind: "events", events: [event(0, "stream.mark", {})] });
    }
    expect(first.closedByClient).toBe(false);
    // A hung daemon: nothing for LIVENESS_MS.
    clock.advance(LIVENESS_MS - 1);
    expect(first.closedByClient).toBe(false);
    clock.advance(1);
    expect(first.closedByClient).toBe(true);
    expect(client.state).toBe("reconnecting");
    clock.advance(reconnectDelay(0));
    expect(transport.connections).toHaveLength(2);
    const second = accept(transport);
    // It subscribes again after the last cursor it has.
    expect(second.last()).toMatchObject({ kind: "subscribe", stream: SOFTWARE, after: cursor(0) });
    expect(client.state).toBe("open");
  });

  it("closes the connection when a request passes its deadline and sends it again after reconnecting", async () => {
    const { clock, transport, client } = await connected();
    const first = transport.current;
    const status = client.read(daemonStatus, {}, { deadlineMs: 10_000 });
    const id = requestIdOf(first);
    clock.advance(9_999);
    expect(first.closedByClient).toBe(false);
    clock.advance(1);
    expect(first.closedByClient).toBe(true);
    clock.advance(reconnectDelay(0));
    const second = accept(transport);
    expect(requestIdOf(second)).toBe(id);
    second.deliver(
      reply(id, {
        state: "running",
        pid: 1,
        version: "0.0.0-test",
        uptimeMs: 1,
        socket: "/s",
        loadedOffices: [],
        activeRuns: 0,
        keepAwake: { held: false },
        upgradePending: false,
        tools: {},
      }),
    );
    expect((await status).ok).toBe(true);
    // Nothing waits any more, so an idle open connection stays open.
    clock.advance(10 * LIVENESS_MS);
    expect(second.closedByClient).toBe(false);
  });

  it("starts the liveness window at a subscribe sent after a long idle spell", async () => {
    const { clock, transport, client } = await connected();
    const first = transport.current;
    clock.advance(LIVENESS_MS + 10_000);
    client.subscribe(SOFTWARE, { onEvent: () => undefined });
    clock.advance(LIVENESS_MS - 1);
    expect(first.closedByClient).toBe(false);
    clock.advance(1);
    expect(first.closedByClient).toBe(true);
  });

  it("leaves a connection with no subscription and no deadline open however long it is idle", async () => {
    const { clock, transport, client } = await connected();
    void client.read(daemonStatus, {});
    clock.advance(10 * LIVENESS_MS);
    expect(transport.current.closedByClient).toBe(false);
    expect(transport.connections).toHaveLength(1);
  });
});
