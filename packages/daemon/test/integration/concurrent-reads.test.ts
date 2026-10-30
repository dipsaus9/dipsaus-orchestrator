// Frames of one connection served side by side (DIPO-320), over a real Unix socket: a slow read
// never holds a fast read or a command back, commands start in order, only subscribes to the same
// stream wait for each other, and a read or subscribe past its deadline answers `request.timedOut`
// once, without a second reply or a subscription opened by its late answer.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  type CommandReply,
  type ReadReply,
  type ReadRequest,
  type ServerFrame,
  SOFTWARE_STREAM,
  StreamName,
} from "@dipsaus-orchestrator/contract";
import { makeTempDir, removeTempDir } from "@dipsaus-orchestrator/testkit";

import { READ_DEADLINE_MS } from "../../src/server";
import { requestId, settle, TestClient } from "../support/client";
import { startHarness, type Harness, type HarnessOptions } from "../support/harness";

let dir: string;
let harness: Harness | null = null;
const clients: TestClient[] = [];

beforeEach(() => {
  dir = makeTempDir();
});

afterEach(async () => {
  for (const client of clients.splice(0)) {
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

async function connect(h: Harness): Promise<TestClient> {
  const client = await TestClient.connect(h.socketPath);
  clients.push(client);
  expect((await client.hello()).ok).toBe(true);
  return client;
}

/** A read the test answers by hand: `fixture.slow` waits until `release` is called. */
function slowRead(h: Harness, name = "fixture.slow"): { release(): void; started: () => number } {
  const waiting: (() => void)[] = [];
  let started = 0;
  h.engine.reads.set(name, (request: ReadRequest) => {
    started += 1;
    const { promise, resolve } = Promise.withResolvers<ReadReply>();
    waiting.push(() => resolve({ ok: true, requestId: request.requestId, result: { slow: true } }));
    return promise;
  });
  return {
    release: () => {
      for (const done of waiting.splice(0)) done();
    },
    started: () => started,
  };
}

/** The replies received so far, in arrival order, as request ids. */
function replyOrder(client: TestClient): string[] {
  return client.frames.flatMap((frame: ServerFrame) =>
    frame.kind === "reply" ? [frame.reply.requestId] : [],
  );
}

function replyCount(client: TestClient, id: string): number {
  return replyOrder(client).filter((each) => each === id).length;
}

async function waitForReply(client: TestClient, id: string) {
  const frame = await client.waitFor(
    (f) => f.kind === "reply" && f.reply.requestId === id,
    `reply to ${id}`,
  );
  if (frame.kind !== "reply") throw new Error("unreachable");
  return frame.reply;
}

describe("reads side by side", () => {
  it("answers a fast read first while a slow read before it still runs", async () => {
    const h = await start();
    const slow = slowRead(h);
    const client = await connect(h);
    const slowId = requestId();
    client.sendRaw({ kind: "read", requestId: slowId, name: "fixture.slow", args: {} });
    const fast = await client.read("daemon.status");
    expect(fast.ok).toBe(true);
    expect(slow.started()).toBe(1);
    expect(replyCount(client, slowId)).toBe(0);

    slow.release();
    const late = await waitForReply(client, slowId);
    expect(late).toMatchObject({ ok: true, result: { slow: true } });
    expect(replyOrder(client).slice(-2)).toEqual([fast.requestId, slowId]);
  });

  it("starts commands behind a slow read at once and in their order", async () => {
    const h = await start();
    const slow = slowRead(h);
    const office = h.addOffice();
    const client = await connect(h);
    const slowId = requestId();
    client.sendRaw({ kind: "read", requestId: slowId, name: "fixture.slow", args: {} });
    const first = requestId();
    const second = requestId();
    client.sendRaw({
      kind: "command",
      requestId: first,
      office,
      name: "fixture.scan",
      args: {},
      origin: "other",
    });
    client.sendRaw({
      kind: "command",
      requestId: second,
      office,
      name: "fixture.scan",
      args: {},
      origin: "other",
    });
    const replies = [await waitForReply(client, first), await waitForReply(client, second)];
    expect(replies.map((reply) => reply.ok)).toEqual([true, true]);
    // The second command ran after the first: its entry is the next one in the change log.
    expect(replies.map((reply) => (reply as CommandReply & { ok: true }).cursor?.seq)).toEqual([
      1, 2,
    ]);
    expect(h.engine.heard.filter((heard) => heard.kind === "command").length).toBe(2);
    expect(replyCount(client, slowId)).toBe(0);
    slow.release();
    await waitForReply(client, slowId);
  });

  it("refuses a second read with a running id, and answers the first once", async () => {
    const h = await start();
    const slow = slowRead(h);
    const client = await connect(h);
    const id = requestId();
    client.sendRaw({ kind: "read", requestId: id, name: "fixture.slow", args: {} });
    client.sendRaw({ kind: "read", requestId: id, name: "daemon.status", args: {} });
    const refused = await waitForReply(client, id);
    expect(refused).toMatchObject({ ok: false, error: { code: "request.reused" } });
    slow.release();
    await client.waitFor(
      (frame) => frame.kind === "reply" && frame.reply.ok && frame.reply.requestId === id,
      "the slow read's answer",
    );
    expect(replyCount(client, id)).toBe(2);
  });
});

describe("the read deadline", () => {
  it("answers request.timedOut past the deadline and drops the late answer", async () => {
    const h = await start();
    const slow = slowRead(h);
    const client = await connect(h);
    const id = requestId();
    client.sendRaw({ kind: "read", requestId: id, name: "fixture.slow", args: {} });
    await settle();
    expect(slow.started()).toBe(1);
    h.clock.advance(READ_DEADLINE_MS - 1);
    await settle();
    expect(replyCount(client, id)).toBe(0);

    h.clock.advance(1);
    const reply = await waitForReply(client, id);
    expect(reply).toMatchObject({
      ok: false,
      error: { code: "request.timedOut", retryable: false, details: { name: "fixture.slow" } },
    });

    slow.release();
    // A later read's answer shows the late one had its chance to arrive.
    expect((await client.read("daemon.status")).ok).toBe(true);
    await settle();
    expect(replyCount(client, id)).toBe(1);
    // No deadline timer of the answered read is left.
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("gives engine.hello a deadline, and takes the frames that waited for it after", async () => {
    const h = await start();
    const hello = slowRead(h, "engine.hello");
    const client = await TestClient.connect(h.socketPath);
    clients.push(client);
    const helloId = requestId();
    client.sendRaw({
      kind: "read",
      requestId: helloId,
      name: "engine.hello",
      args: { client: { name: "test", version: "0" } },
    });
    const behind = requestId();
    client.sendRaw({ kind: "read", requestId: behind, name: "daemon.status", args: {} });
    await settle();
    expect(replyOrder(client)).toEqual([]);

    h.clock.advance(READ_DEADLINE_MS);
    expect(await waitForReply(client, helloId)).toMatchObject({
      ok: false,
      error: { code: "request.timedOut" },
    });
    // The hello failed, so the frame behind it is the first frame of a connection without one.
    expect(await waitForReply(client, behind)).toMatchObject({
      ok: false,
      error: { code: "not.permitted" },
    });
    hello.release();
    await settle();
    expect(replyCount(client, helloId)).toBe(1);
  });

  it("clears the deadlines of a connection that closes", async () => {
    const h = await start();
    slowRead(h);
    const client = await connect(h);
    client.sendRaw({ kind: "read", requestId: requestId(), name: "fixture.slow", args: {} });
    await settle();
    expect(h.clock.pendingTimers).toBeGreaterThan(0);
    await client.close();
    await settle();
    expect(h.server.connections).toBe(0);
    expect(h.clock.pendingTimers).toBe(0);
  });
});

describe("subscribes", () => {
  it("keeps subscribes to one stream in order, and lets other streams pass", async () => {
    const h = await start();
    const office = h.addOffice();
    const stream = StreamName.parse(`office:${office}`);
    const hold = Promise.withResolvers<void>();
    h.engine.subscribeHolds.set(stream, hold.promise);
    const client = await connect(h);
    const first = requestId();
    const second = requestId();
    client.sendRaw({ kind: "subscribe", requestId: first, stream });
    client.sendRaw({ kind: "subscribe", requestId: second, stream });
    const software = await client.subscribe(SOFTWARE_STREAM);
    expect(software.ok).toBe(true);
    expect(replyCount(client, first) + replyCount(client, second)).toBe(0);

    h.engine.subscribeHolds.delete(stream);
    hold.resolve();
    await waitForReply(client, second);
    const order = replyOrder(client);
    expect(order.indexOf(first)).toBeLessThan(order.indexOf(second));
    expect(h.server.connections).toBe(1);
  });

  it("opens no subscription for a subscribe that answered request.timedOut", async () => {
    const h = await start();
    const office = h.addOffice();
    const stream = StreamName.parse(`office:${office}`);
    const hold = Promise.withResolvers<void>();
    h.engine.subscribeHolds.set(stream, hold.promise);
    const client = await connect(h);
    const id = requestId();
    client.sendRaw({ kind: "subscribe", requestId: id, stream });
    await settle();
    h.clock.advance(READ_DEADLINE_MS);
    expect(await waitForReply(client, id)).toMatchObject({
      ok: false,
      error: { code: "request.timedOut" },
    });

    h.engine.subscribeHolds.delete(stream);
    hold.resolve();
    await settle();
    h.engine.appendOffice(office, "scan.finished", { scripts: {}, warnings: [] });
    h.engine.notifyOffice(office);
    expect((await client.read("daemon.status")).ok).toBe(true);
    await settle();
    expect(replyCount(client, id)).toBe(1);
    expect(client.events(stream)).toEqual([]);

    // The stream is free again: the next subscribe opens it.
    const again = await client.subscribe(stream);
    expect(again.ok).toBe(true);
    await client.waitForEvent(stream, (event) => event.type === "stream.mark", "the catch-up mark");
  });
});
