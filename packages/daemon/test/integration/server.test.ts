// The contract over WebSocket on the Unix socket (DIPO-24, 0005 sections 3, 7, 8 and 11; 0006
// decisions 5 and 9): the server's own protocol against a hand-written engine surface (DIPO-318).
// A `ws+unix://` test client talks to the server in-process; every frame it receives must parse
// with `ServerFrame`. What the engine answers (hello, describe, daemon.*, the lifecycle checks, the
// change log and its cursors) is tested against `createEngine` in
// `packages/engine/test/create/surface.test.ts`.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  CONTRACT_VERSION,
  type Cursor,
  type Event,
  type OfficeSummary,
  type ReadReply,
} from "@dipsaus-orchestrator/contract";
import { makeTempDir, removeTempDir } from "@dipsaus-orchestrator/testkit";

import { SUMMARY_DEBOUNCE_MS } from "../../src/server";
import { requestId, settle, TestClient } from "../support/client";
import { startHarness, TEST_VERSION, type Harness, type HarnessOptions } from "../support/harness";

let dir: string;
let harness: Harness | null = null;
const clients: TestClient[] = [];

beforeEach(() => {
  dir = makeTempDir();
});

afterEach(async () => {
  for (const client of clients.splice(0)) {
    // Every frame the server sent in this test parses with ServerFrame.
    expect(client.invalid).toEqual([]);
    await client.close();
  }
  await harness?.close();
  harness = null;
  removeTempDir(dir);
});

async function start(options?: HarnessOptions): Promise<Harness> {
  harness = await startHarness(dir, options);
  return harness;
}

async function connect(h: Harness, hello = true): Promise<TestClient> {
  const client = await TestClient.connect(h.socketPath);
  clients.push(client);
  if (hello) {
    const reply = await client.hello();
    expect(reply.ok).toBe(true);
  }
  return client;
}

function okResult<T>(reply: ReadReply): T {
  if (!reply.ok) throw new Error(`expected ok, got ${reply.error.code}: ${reply.error.message}`);
  return reply.result as T;
}

function errorCode(reply: ReadReply): string {
  if (reply.ok) throw new Error("expected an error reply");
  return reply.error.code;
}

const types = (events: readonly Event[]) => events.map((event) => event.type);

function summary(office: string, running: number): OfficeSummary {
  return {
    office,
    name: "demo",
    path: "/repos/demo",
    running,
    parked: 0,
    waitingOnMaintainer: 0,
  } as OfficeSummary;
}

describe("handshake", () => {
  it("passes engine.hello to the engine and its reply back", async () => {
    const h = await start();
    const client = await connect(h, false);
    const hello = okResult<{ engine: string; cursor: Cursor }>(await client.hello());
    expect(hello.engine).toBe(TEST_VERSION);
    expect(hello.cursor).toEqual(h.engine.softwareHead());
    expect(h.engine.heard).toEqual([{ kind: "read", name: "engine.hello" }]);
  });

  it("answers any other first frame with an error and accepts engine.hello after it", async () => {
    const h = await start();
    const client = await connect(h, false);
    const first = await client.read("daemon.status");
    expect(errorCode(first)).toBe("not.permitted");
    const subscribe = await client.subscribe("software");
    expect(errorCode(subscribe)).toBe("not.permitted");
    expect((await client.hello()).ok).toBe(true);
    expect((await client.read("daemon.status")).ok).toBe(true);
    // Nothing but the handshake and the read after it reached the engine.
    expect(h.engine.heard.map((heard) => heard.name)).toEqual(["engine.hello", "daemon.status"]);
  });

  it("gives a client of another major only the frozen surface", async () => {
    const h = await start();
    const client = await connect(h, false);
    const hello = await client.hello({ major: CONTRACT_VERSION.major + 1, minor: 0 });
    if (hello.ok) throw new Error("expected contract.unsupported");
    expect(hello.error.code).toBe("contract.unsupported");

    const status = okResult<{ state: string; pid: number; version: string }>(
      await client.read("daemon.status"),
    );
    expect(status).toMatchObject({ state: "running", pid: process.pid, version: TEST_VERSION });
    expect(errorCode(await client.read("commands.describe"))).toBe("contract.unsupported");
    expect(errorCode(await client.subscribe("software"))).toBe("contract.unsupported");
    const stop = await client.command("daemon.stop", { stopWorkers: false });
    expect(stop.ok).toBe(true);
    // commands.describe and the subscription never reached the engine.
    expect(h.engine.heard.map((heard) => heard.name)).toEqual([
      "engine.hello",
      "daemon.status",
      "daemon.stop",
    ]);
  });

  it("closes a connection that sends something other than JSON", async () => {
    const h = await start();
    const client = await connect(h, false);
    client.sendRaw("not json");
    expect((await client.closed).code).toBe(1007);
  });

  it("answers a frame that is not a ClientFrame but carries a request id with args.invalid", async () => {
    const h = await start();
    const client = await connect(h);
    const reply = await client.request({ kind: "shout", requestId: requestId() });
    expect(errorCode(reply)).toBe("args.invalid");
  });

  it("gives each command the client name its engine.hello sent (DIPO-155)", async () => {
    const h = await start();
    const office = h.addOffice();
    const client = await connect(h);
    await client.command("fixture.scan", {}, { office });
    expect(h.engine.heard.at(-1)).toEqual({
      kind: "command",
      name: "fixture.scan",
      office,
      client: "test",
    });
  });
});

describe("software stream", () => {
  it("sends office.summary after catch-up and then, debounced, when an office changes", async () => {
    const h = await start();
    const office = h.addOffice();
    h.engine.summaries = [summary(office, 0)];
    const client = await connect(h);
    okResult(await client.subscribe("software", h.engine.softwareHead()));
    const summaries = () => client.events("software").filter((e) => e.type === "office.summary");
    await client.waitForEvent(
      "software",
      (e) => e.type === "office.summary",
      "summary at catch-up",
    );
    expect(summaries().map((e) => e.data)).toMatchObject([{ office, running: 0 }]);

    // A change starts the wait; changes during it are covered by the one summary sent after it.
    h.engine.summaries = [summary(office, 1)];
    h.engine.notifyOffice(office);
    h.engine.notifyOffice(office);
    h.clock.advance(SUMMARY_DEBOUNCE_MS - 1);
    await settle();
    expect(summaries()).toHaveLength(1);
    h.clock.advance(1);
    await client.waitForEvent(
      "software",
      (e) => e.type === "office.summary" && (e.data as { running: number }).running === 1,
      "debounced summary",
    );
    expect(summaries()).toHaveLength(2);
    // Derived: the cursor repeats the stream position.
    expect(summaries()[1]?.cursor).toEqual(h.engine.softwareHead());

    // A change that leaves the summary as it was sends nothing.
    h.engine.notifyOffice(office);
    h.clock.advance(SUMMARY_DEBOUNCE_MS);
    await settle();
    expect(summaries()).toHaveLength(2);
  });

  it("replays after the cursor, marks catch-up, then sends live events", async () => {
    const h = await start();
    const client = await connect(h);
    const from = h.engine.softwareHead();
    h.engine.appendSoftware("daemon.state", { from: "starting", to: "recovering", reason: "a" });
    h.engine.appendSoftware("daemon.state", { from: "recovering", to: "running", reason: "b" });

    const subscribed = okResult<{ stream: string; from: Cursor }>(
      await client.subscribe("software", from),
    );
    expect(subscribed).toEqual({ stream: "software", from });
    await client.waitForEvent("software", (e) => e.type === "stream.mark", "catch-up mark");
    h.engine.appendSoftware("daemon.state", { from: "running", to: "draining", reason: "SIGTERM" });
    await client.waitForEvent(
      "software",
      (e) => e.type === "daemon.state" && (e.data as { to: string }).to === "draining",
      "live daemon.state",
    );

    const events = client.events("software");
    expect(types(events)).toEqual(["daemon.state", "daemon.state", "stream.mark", "daemon.state"]);
    expect(events[2]?.data).toEqual({ caughtUp: true });
    const at = (n: number) => from.seq + n;
    expect(events.map((e) => e.cursor.seq)).toEqual([at(1), at(2), at(2), at(3)]);
    // The subscribe reply came before the replay.
    const replyIndex = client.frames.findIndex(
      (f) =>
        f.kind === "reply" &&
        f.reply.ok &&
        "result" in f.reply &&
        (f.reply.result as { stream?: string }).stream === "software",
    );
    const firstEvents = client.frames.findIndex((f) => f.kind === "events");
    expect(replyIndex).toBeLessThan(firstEvents);
  });

  it("passes a cursor the engine cannot replay back as its error", async () => {
    const h = await start();
    const client = await connect(h);
    const old = { stream: "software", seq: 0 };
    const reset = await client.subscribe("software", old as Cursor);
    if (reset.ok) throw new Error("expected stream.resetRequired");
    expect(reset.error.code).toBe("stream.resetRequired");
    expect(client.events("software")).toEqual([]);
  });

  it("sends stream.mark every 15 s on an idle subscription", async () => {
    const h = await start();
    const client = await connect(h);
    okResult(await client.subscribe("software"));
    const marks = () => client.events("software").filter((e) => e.type === "stream.mark");
    // The catch-up mark is its own frame after the reply: wait for it rather than a fixed settle.
    await client.waitFor(() => marks().length >= 1, "catch-up mark");
    expect(marks()).toHaveLength(1);
    h.clock.advance(14_999);
    await settle();
    expect(marks()).toHaveLength(1);
    h.clock.advance(1);
    await client.waitFor(() => marks().length === 2, "heartbeat");
    expect(marks()[1]?.data).toEqual({});
    expect(marks()[1]?.cursor).toEqual(h.engine.softwareHead());
    h.clock.advance(15_000);
    await client.waitFor(() => marks().length === 3, "second heartbeat");
  });
});

describe("office streams", () => {
  it("replays the change log after the cursor, marks catch-up, then sends live events", async () => {
    const h = await start();
    const office = h.addOffice();
    const writer = await connect(h);
    for (let i = 0; i < 3; i++) {
      expect(await writer.command("fixture.scan", {}, { office })).toMatchObject({ ok: true });
    }
    const stream = `office:${office}`;

    const reader = await connect(h);
    const subscribed = okResult<{ from: Cursor }>(
      await reader.subscribe(stream, { stream, seq: 1 } as Cursor),
    );
    expect(subscribed.from).toEqual({ stream, seq: 1 } as Cursor);
    await reader.waitForEvent(stream, (e) => e.type === "stream.mark", "catch-up mark");
    const live = await writer.command("fixture.scan", {}, { office });
    expect(live).toMatchObject({ ok: true, cursor: { stream, seq: 4 } });
    await reader.waitForEvent(
      stream,
      (e) => e.cursor.seq === 4 && e.type === "scan.finished",
      "live",
    );

    const events = reader.events(stream);
    expect(types(events)).toEqual([
      "scan.finished",
      "scan.finished",
      "stream.mark",
      "scan.finished",
    ]);
    expect(events.map((e) => e.cursor.seq)).toEqual([2, 3, 3, 4]);
    expect(events[3]?.causedBy).toBe(live.requestId);
  });

  it("sends a command's reply as soon as the engine gives it, before the office events (DIPO-318)", async () => {
    const h = await start();
    const office = h.addOffice();
    const stream = `office:${office}`;
    const client = await connect(h);
    okResult(await client.subscribe(stream));
    await client.waitForEvent(stream, (e) => e.type === "stream.mark", "catch-up mark");
    const reply = await client.command("fixture.scan", {}, { office });
    expect(reply).toMatchObject({ ok: true });
    await client.waitForEvent(stream, (e) => e.type === "scan.finished", "the written entry");
    const replyAt = client.frames.findIndex(
      (frame) => frame.kind === "reply" && frame.reply.requestId === reply.requestId,
    );
    const eventAt = client.frames.findIndex(
      (frame) => frame.kind === "events" && frame.events.some((e) => e.type === "scan.finished"),
    );
    expect(replyAt).toBeGreaterThanOrEqual(0);
    expect(replyAt).toBeLessThan(eventAt);
  });

  it("drops filtered event types but still marks catch-up", async () => {
    const h = await start();
    const office = h.addOffice();
    const client = await connect(h);
    await client.command("fixture.scan", {}, { office });
    const stream = `office:${office}`;
    okResult(await client.subscribe(stream, { stream, seq: 0 } as Cursor, ["scan."]));
    await client.waitForEvent(stream, (e) => e.type === "stream.mark", "catch-up mark");
    await client.command("fixture.scan", {}, { office });
    await settle();
    const events = client.events(stream);
    expect(types(events)).toEqual(["stream.mark"]);
    expect(events[0]?.cursor.seq).toBe(1);
  });

  it("passes the engine's refusal of a subscription back: a foreign cursor, an unknown office", async () => {
    const h = await start();
    const office = h.addOffice();
    const client = await connect(h);
    const stream = `office:${office}`;
    // Beyond the last entry: a log that was lost and started again.
    const reset = await client.subscribe(stream, { stream, seq: 7 } as Cursor);
    expect(errorCode(reset)).toBe("stream.resetRequired");
    h.engine.forget(office);
    expect(errorCode(await client.subscribe(stream))).toBe("office.unknown");
  });

  it("ends a subscription whose office the engine no longer has loaded", async () => {
    const h = await start();
    const office = h.addOffice();
    const stream = `office:${office}`;
    const client = await connect(h);
    okResult(await client.subscribe(stream));
    await client.waitForEvent(stream, (e) => e.type === "stream.mark", "catch-up mark");
    h.engine.forget(office);
    h.engine.notifyOffice(office);
    await settle();
    // The connection stays open; the subscription is gone, so no heartbeat follows.
    h.clock.advance(15_000);
    await settle();
    expect(types(client.events(stream))).toEqual(["stream.mark"]);
    expect(await Promise.race([client.closed, settle().then(() => "open")])).toBe("open");
  });

  it("closes the stream with 1008 when the engine fails to read a page (DIPO-124)", async () => {
    const h = await start();
    const office = h.addOffice();
    const writer = await connect(h);
    await writer.command("fixture.scan", {}, { office });
    const stream = `office:${office}`;
    h.engine.broken.add(office);
    const reader = await connect(h);
    okResult(await reader.subscribe(stream, { stream, seq: 0 } as Cursor));
    expect((await reader.closed).code).toBe(1008);
    expect(reader.events(stream)).toEqual([]);
  });

  it("subscribes from where the engine says when no cursor is given", async () => {
    const h = await start();
    const office = h.addOffice();
    const client = await connect(h);
    await client.command("fixture.scan", {}, { office });
    const stream = `office:${office}`;
    const subscribed = okResult<{ from: Cursor }>(await client.subscribe(stream));
    expect(subscribed.from).toEqual(h.engine.officeHead(office));
    await client.waitForEvent(stream, (e) => e.type === "stream.mark", "catch-up mark");
    expect(types(client.events(stream))).toEqual(["stream.mark"]);
  });
});
