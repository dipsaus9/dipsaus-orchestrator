// The contract over WebSocket on the Unix socket (DIPO-24, 0005 sections 3, 7, 8 and 11; 0006
// decisions 5, 7 and 9). A `ws+unix://` test client talks to the server in-process; every frame it
// receives must parse with `ServerFrame`.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  CONTRACT_VERSION,
  type Cursor,
  type Event,
  type ReadReply,
} from "@dipsaus-orchestrator/contract";
import { Renderer } from "@dipsaus-orchestrator/engine";
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

describe("handshake", () => {
  it("answers engine.hello with versions, flags, daemon state, offices and the software cursor", async () => {
    const h = await start();
    const client = await connect(h, false);
    const hello = okResult<{
      engine: string;
      contract: unknown;
      capabilities: string[];
      daemon: string;
      offices: unknown[];
      cursor: Cursor;
    }>(await client.hello());
    expect(hello.engine).toBe(TEST_VERSION);
    expect(hello.contract).toEqual({ ...CONTRACT_VERSION });
    expect(hello.daemon).toBe("running");
    expect(hello.offices).toEqual([]);
    expect(hello.cursor).toEqual(h.software.head());
    expect(hello.cursor.seq).toBe(2); // starting -> recovering -> running
    expect(hello.capabilities).toContain("replay");
    expect(hello.capabilities).toContain("daemon.control");
    expect(hello.capabilities).toContain("daemon.logLevel");
    // `work.outputRange` backs `work.output` (DIPO-52); nothing backs `work.intervene` yet.
    expect(hello.capabilities).toContain("work.output");
    expect(hello.capabilities).not.toContain("work.intervene");
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
  });

  it("gives a client of another major contract.unsupported and only the frozen surface", async () => {
    const h = await start();
    const client = await connect(h, false);
    const hello = await client.hello({ major: CONTRACT_VERSION.major + 1, minor: 0 });
    if (hello.ok) throw new Error("expected contract.unsupported");
    expect(hello.error.code).toBe("contract.unsupported");
    expect(hello.error.retryable).toBe(false);
    expect(hello.error.details).toEqual({
      contract: { ...CONTRACT_VERSION },
      version: TEST_VERSION,
    });

    const status = okResult<{ state: string; pid: number; version: string }>(
      await client.read("daemon.status"),
    );
    expect(status).toMatchObject({ state: "running", pid: process.pid, version: TEST_VERSION });
    expect(errorCode(await client.read("commands.describe"))).toBe("contract.unsupported");
    expect(errorCode(await client.subscribe("software"))).toBe("contract.unsupported");
    const stop = await client.command("daemon.stop", { stopWorkers: false });
    expect(stop.ok).toBe(true);
    expect(h.stops).toEqual([{ reason: "daemon.stop", stopWorkers: false }]);
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
});

describe("commands.describe", () => {
  it("lists registered commands and reads with schemas and since, and leaves out provisional ones", async () => {
    const h = await start();
    const client = await connect(h);
    const described = okResult<{
      commands: {
        name: string;
        args: unknown;
        result: unknown;
        since: number;
        confirm: boolean;
        irreversible: boolean;
      }[];
      reads: { name: string; args: unknown; result: unknown; since: number }[];
    }>(await client.read("commands.describe"));
    const echo = described.reads.find((read) => read.name === "fixture.echo");
    expect(echo).toEqual({
      name: "fixture.echo",
      args: { type: "object", properties: {} },
      result: expect.objectContaining({ type: "object" }) as unknown,
      since: 0,
    });
    const reads = described.reads.map((read) => read.name);
    expect(reads).toEqual(
      expect.arrayContaining(["engine.hello", "commands.describe", "daemon.status"]),
    );
    const commands = described.commands.map((command) => command.name);
    expect(commands).toEqual(
      expect.arrayContaining([
        "daemon.stop",
        "daemon.setLogLevel",
        "daemon.resumeScheduling",
        "fixture.scan",
      ]),
    );
    expect(commands).not.toContain("fixture.draft");
    // Contract entries no engine module registered are absent too.
    expect(commands).not.toContain("story.park");
    // The view reads ship with DIPO-52.
    expect(reads).toEqual(expect.arrayContaining(["office.snapshot", "office.switch"]));
    const stop = described.commands.find((command) => command.name === "daemon.stop");
    expect(stop).toMatchObject({ confirm: true, irreversible: false, since: 0 });
  });
});

describe("daemon.* operations", () => {
  it("reports daemon.status from the lifecycle", async () => {
    const h = await start({ states: ["recovering", "safe"] });
    h.clock.advance(1234);
    const client = await connect(h);
    const status = okResult<Record<string, unknown>>(await client.read("daemon.status"));
    expect(status).toMatchObject({
      state: "safe",
      stateReason: "setup",
      pid: process.pid,
      version: TEST_VERSION,
      uptimeMs: 1234,
      socket: h.socketPath,
      loadedOffices: [],
      activeRuns: 0,
      keepAwake: { held: false },
      upgradePending: false,
      tools: {},
    });
  });

  it("reports the resolved tool paths and a pending upgrade in daemon.status", async () => {
    const tools = { git: "/usr/bin/git", claude: "/opt/bin/claude" };
    const h = await start({ tools });
    const client = await connect(h);
    const before = okResult<Record<string, unknown>>(await client.read("daemon.status"));
    expect(before).toMatchObject({ tools, upgradePending: false });
    h.upgrade.pending = true;
    const after = okResult<Record<string, unknown>>(await client.read("daemon.status"));
    expect(after).toMatchObject({ tools, upgradePending: true });
  });

  it("stops: daemon.stop moves to draining, asks for the drain once, and a repeat changes nothing", async () => {
    const h = await start();
    const client = await connect(h);
    const first = await client.command("daemon.stop", { stopWorkers: true });
    expect(first).toMatchObject({ ok: true, result: { state: "draining" }, changed: true });
    expect(h.lifecycle.state).toBe("draining");
    const again = await client.command("daemon.stop", { stopWorkers: true });
    expect(again).toMatchObject({ ok: true, result: { state: "draining" }, changed: false });
    expect(h.stops).toEqual([{ reason: "daemon.stop", stopWorkers: true }]);
  });

  it("returns the stored reply for a retried daemon command", async () => {
    const h = await start();
    const client = await connect(h);
    const id = requestId();
    const frame = {
      kind: "command",
      name: "daemon.setLogLevel",
      args: { level: "debug" },
      origin: "cli",
    };
    const first = await client.request({ ...frame, requestId: id });
    expect(first).toMatchObject({ ok: true, result: { level: "debug" }, changed: true });
    // A different request id with the same level is a no-op; the retry gets the stored reply.
    expect(await client.command("daemon.setLogLevel", { level: "debug" })).toMatchObject({
      changed: false,
    });
    client.frames.length = 0;
    expect(await client.request({ ...frame, requestId: id })).toEqual(first);
  });

  it("leaves safe with daemon.resumeScheduling and refuses it outside safe", async () => {
    const h = await start({ states: ["recovering", "safe"] });
    const client = await connect(h);
    okResult(await client.subscribe("software", h.software.head()));
    const resumed = await client.command("daemon.resumeScheduling", {});
    expect(resumed).toMatchObject({ ok: true, result: { state: "running" } });
    const event = await client.waitForEvent(
      "software",
      (e) => e.type === "daemon.state",
      "daemon.state",
    );
    expect(event.data).toEqual({ from: "safe", to: "running", reason: "scheduling resumed" });
    const again = await client.command("daemon.resumeScheduling", {});
    expect(errorCode(again)).toBe("daemon.notSafe");
  });
});

describe("lifecycle checks", () => {
  it("answers office commands and reads with engine.recovering while starting or recovering", async () => {
    for (const states of [[], ["recovering"]] as const) {
      const h = await start({ states });
      const office = h.addOffice();
      const client = await connect(h);
      const command = await client.command("fixture.scan", {}, { office });
      expect(command).toMatchObject({
        ok: false,
        error: { code: "engine.recovering", retryable: true },
      });
      const read = await client.read("fixture.echo");
      expect(errorCode(read)).toBe("engine.recovering");
      expect(errorCode(await client.subscribe(`office:${office}`))).toBe("engine.recovering");
      // The handshake, describe, daemon.* and the software stream work.
      expect((await client.read("commands.describe")).ok).toBe(true);
      expect((await client.read("daemon.status")).ok).toBe(true);
      expect((await client.subscribe("software")).ok).toBe(true);
      for (const c of clients.splice(0)) await c.close();
      await h.close();
      harness = null;
    }
  });

  it("answers work.run with scheduling.off in safe, while other office commands run", async () => {
    const h = await start({ states: ["recovering", "safe"] });
    const office = h.addOffice();
    const client = await connect(h);
    expect(await client.command("work.run", {}, { office })).toMatchObject({
      ok: false,
      error: { code: "scheduling.off", retryable: true },
    });
    expect(await client.command("fixture.scan", {}, { office })).toMatchObject({ ok: true });
  });
});

describe("software stream", () => {
  it("sends office.summary after catch-up and then, debounced, when an office changes", async () => {
    const h = await start({ officeSummaries: true });
    const office = h.addOffice();
    const client = await connect(h);
    okResult(await client.subscribe("software", h.software.head()));
    const summaries = () => client.events("software").filter((e) => e.type === "office.summary");
    await client.waitForEvent(
      "software",
      (e) => e.type === "office.summary",
      "summary at catch-up",
    );
    expect(summaries().map((e) => e.data)).toMatchObject([{ office, running: 0 }]);

    // A change starts the wait; changes during it are covered by the one summary sent after it.
    h.state.connection.immediate(() =>
      h.state.connection.run(
        `insert into runs (office_id, run_id, kind, role, model, budget_unit, budget_limit,
             loop_cap, config_hash, started_at)
           values ($office, 'run_1', 'session', 'developer', 'haiku', 'tokens', 1, 1, 'h', 0)`,
        { office },
      ),
    );
    h.server.notifyOffice(office);
    h.server.notifyOffice(office);
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
    expect(summaries()[1]?.cursor).toEqual(h.software.head());

    // A change that leaves the summary as it was sends nothing.
    h.server.notifyOffice(office);
    h.clock.advance(SUMMARY_DEBOUNCE_MS);
    await settle();
    expect(summaries()).toHaveLength(2);
  });

  it("replays after the cursor, marks catch-up, then sends live events", async () => {
    const h = await start({ states: [] });
    const client = await connect(h);
    const hello = okResult<{ cursor: Cursor }>(await client.hello());
    h.lifecycle.transition("recovering", "running recovery steps");
    h.lifecycle.transition("running", "recovered");

    const subscribed = okResult<{ stream: string; from: Cursor }>(
      await client.subscribe("software", hello.cursor),
    );
    expect(subscribed).toEqual({ stream: "software", from: hello.cursor });
    await client.waitForEvent("software", (e) => e.type === "stream.mark", "catch-up mark");
    h.lifecycle.transition("draining", "SIGTERM");
    await client.waitForEvent(
      "software",
      (e) => e.type === "daemon.state" && (e.data as { to: string }).to === "draining",
      "live daemon.state",
    );

    const events = client.events("software");
    expect(types(events)).toEqual(["daemon.state", "daemon.state", "stream.mark", "daemon.state"]);
    expect(events.map((e) => e.data)).toEqual([
      { from: "starting", to: "recovering", reason: "running recovery steps" },
      { from: "recovering", to: "running", reason: "recovered" },
      { caughtUp: true },
      { from: "running", to: "draining", reason: "SIGTERM" },
    ]);
    expect(events.map((e) => e.cursor.seq)).toEqual([1, 2, 2, 3]);
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

  it("answers a cursor of an old epoch, or one older than the ring buffer, with stream.resetRequired", async () => {
    const h = await start({ states: [], softwareCapacity: 2 });
    const client = await connect(h);
    const old = { stream: "software", epoch: "an-earlier-daemon", seq: 0 };
    const reset = await client.subscribe("software", old as Cursor);
    if (reset.ok) throw new Error("expected stream.resetRequired");
    expect(reset.error.code).toBe("stream.resetRequired");
    expect(reset.error.details).toEqual({
      oldest: { stream: "software", epoch: h.software.epoch, seq: 0 },
    });

    h.lifecycle.transition("recovering", "a");
    h.lifecycle.transition("safe", "b");
    h.lifecycle.transition("running", "c");
    const tooOld = await client.subscribe("software", {
      stream: "software",
      epoch: h.software.epoch,
      seq: 0,
    } as Cursor);
    if (tooOld.ok) throw new Error("expected stream.resetRequired");
    expect(tooOld.error.details).toEqual({
      oldest: { stream: "software", epoch: h.software.epoch, seq: 1 },
    });
    expect(
      (
        await client.subscribe("software", {
          stream: "software",
          epoch: h.software.epoch,
          seq: 1,
        } as Cursor)
      ).ok,
    ).toBe(true);
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
    expect(marks()[1]?.cursor).toEqual(h.software.head());
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
    const epoch = h.state.connection.get<{ epoch: string }>(
      "select epoch from offices where office_id = $office",
      { office },
    )?.epoch;
    if (epoch === undefined) throw new Error("no office row");

    const reader = await connect(h);
    const subscribed = okResult<{ from: Cursor }>(
      await reader.subscribe(stream, { stream, epoch, seq: 1 } as Cursor),
    );
    expect(subscribed.from).toEqual({ stream, epoch, seq: 1 } as Cursor);
    await reader.waitForEvent(stream, (e) => e.type === "stream.mark", "catch-up mark");
    const live = await writer.command("fixture.scan", {}, { office });
    expect(live).toMatchObject({ ok: true, cursor: { stream, epoch, seq: 4 } });
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
    expect(events[0]?.data).toEqual({ scripts: { test: "bun test" }, warnings: [] });
    expect(events[3]?.causedBy).toBe(live.requestId);
  });

  it("drops filtered event types but still marks catch-up", async () => {
    const h = await start();
    const office = h.addOffice();
    const client = await connect(h);
    await client.command("fixture.scan", {}, { office });
    const stream = `office:${office}`;
    const epoch = h.state.connection.get<{ epoch: string }>(
      "select epoch from offices where office_id = $office",
      { office },
    )?.epoch;
    okResult(await client.subscribe(stream, { stream, epoch, seq: 0 } as Cursor, ["scan."]));
    await client.waitForEvent(stream, (e) => e.type === "stream.mark", "catch-up mark");
    await client.command("fixture.scan", {}, { office });
    await settle();
    const events = client.events(stream);
    expect(types(events)).toEqual(["stream.mark"]);
    expect(events[0]?.cursor.seq).toBe(1);
  });

  it("answers an old or foreign cursor with stream.resetRequired and an unknown office with office.unknown", async () => {
    const h = await start();
    const office = h.addOffice();
    const client = await connect(h);
    const stream = `office:${office}`;
    const reply = await client.subscribe(stream, {
      stream,
      epoch: "restored-elsewhere",
      seq: 0,
    } as Cursor);
    if (reply.ok) throw new Error("expected stream.resetRequired");
    expect(reply.error.code).toBe("stream.resetRequired");
    expect((reply.error.details as { oldest: Cursor }).oldest).toMatchObject({ stream, seq: 0 });

    const other = h.addOffice("other");
    h.state.connection.immediate(() =>
      h.state.connection.run("update offices set forgotten_at = 1 where office_id = $office", {
        office: other,
      }),
    );
    expect(errorCode(await client.subscribe(`office:${other}`))).toBe("office.unknown");
  });

  it("sends a stored entry that does not render as an engine.notice and keeps the stream open (DIPO-124)", async () => {
    const h = await start();
    const office = h.addOffice();
    const writer = await connect(h);
    await writer.command("fixture.scan", {}, { office });
    // An entry an older binary stored without the write check: it does not render.
    h.state.connection.immediate(() => {
      h.state.connection.run(
        `insert into change_log (office_id, seq, at, type, tier, key, run_id, caused_by, delta, view)
         values ($office, 2, 1, 'story.state', 'S', null, null, null, '{"story":"DIPO-1"}', null)`,
        { office },
      );
      h.state.connection.run("update offices set next_seq = 3 where office_id = $office", {
        office,
      });
    });
    await writer.command("fixture.scan", {}, { office });
    const stream = `office:${office}`;
    const epoch = h.state.connection.get<{ epoch: string }>(
      "select epoch from offices where office_id = $office",
      { office },
    )?.epoch;
    const from = { stream, epoch, seq: 0 } as Cursor;

    // Two subscribers from the same cursor (as a reconnect would send) each catch up past it.
    const readers = [await connect(h), await connect(h)];
    for (const reader of readers) {
      okResult(await reader.subscribe(stream, from));
      await reader.waitForEvent(stream, (e) => e.type === "stream.mark", "catch-up mark");
      const events = reader.events(stream);
      expect(events.map((e) => [e.cursor.seq, e.type])).toEqual([
        [1, "scan.finished"],
        [2, "engine.notice"],
        [3, "scan.finished"],
        [3, "stream.mark"],
      ]);
      expect(events[1]?.data).toMatchObject({ level: "error", code: "changelog.unrenderable" });
    }
    await writer.command("fixture.scan", {}, { office });
    for (const reader of readers) {
      await reader.waitForEvent(stream, (e) => e.cursor.seq === 4, "live");
      expect(await Promise.race([reader.closed, settle().then(() => "open")])).toBe("open");
    }
  });

  it("still closes the stream with 1008 on an error that is not a render failure (DIPO-124)", async () => {
    const renderer = new Renderer({
      "scan.finished": () => {
        throw new Error("the renderer broke");
      },
    });
    const h = await start({ renderer });
    const office = h.addOffice();
    const writer = await connect(h);
    await writer.command("fixture.scan", {}, { office });
    const stream = `office:${office}`;
    const epoch = h.state.connection.get<{ epoch: string }>(
      "select epoch from offices where office_id = $office",
      { office },
    )?.epoch;
    const reader = await connect(h);
    okResult(await reader.subscribe(stream, { stream, epoch, seq: 0 } as Cursor));
    expect((await reader.closed).code).toBe(1008);
    expect(reader.events(stream)).toEqual([]);
  });

  it("subscribes from the head when no cursor is given", async () => {
    const h = await start();
    const office = h.addOffice();
    const client = await connect(h);
    await client.command("fixture.scan", {}, { office });
    const stream = `office:${office}`;
    const subscribed = okResult<{ from: Cursor }>(await client.subscribe(stream));
    expect(subscribed.from.seq).toBe(1);
    await client.waitForEvent(stream, (e) => e.type === "stream.mark", "catch-up mark");
    expect(types(client.events(stream))).toEqual(["stream.mark"]);
  });
});
