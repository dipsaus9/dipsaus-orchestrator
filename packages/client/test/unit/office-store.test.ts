// The `OfficeStore` (DIPO-53, 0009 sections 2 and 7): snapshot then events by subject, duplicate
// cursors dropped, views replaced and never derived, `stream.resetRequired` reloads once, and
// `office.switch` replaces the office and its stream. A read refused with `engine.recovering` is
// sent again on a timer, so a daemon held without its state database ends it (DIPO-111). A stream
// ended with a retryable error is subscribed again on a backoff from 250 ms to 5 s that starts
// over when the daemon runs or the client reconnects; one that does not retry stays in
// `streamError` (DIPO-327).

import { describe, expect, it } from "bun:test";

import {
  type Cursor,
  type Event,
  type OfficeId,
  type OfficeSnapshot,
  type OfficeSummary,
  type StoryView,
  type WorkView,
} from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import {
  ClientError,
  cursorReached,
  type HelloResult,
  OfficeStore,
  RECOVERY_POLL_MS,
  RELOADED_NOTICE,
  STREAM_RETRY_MAX_MS,
  streamRetryDelay,
} from "../../src/index";
import { FakeStoreClient, settle } from "./fake-store-client";

const A = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0CAA" as OfficeId;
const B = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0CBB" as OfficeId;
const KEY1 = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C01";
const KEY2 = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C02";
const RUN1 = "run_01J9ZK5Q8W3V4X6Y7Z8A9B0C01";
const AT = "2026-10-14T10:00:00.000Z";

function summary(office: OfficeId, name: string, running = 0): OfficeSummary {
  return {
    office,
    name,
    path: `/work/${name}`,
    running,
    parked: 0,
    waitingOnMaintainer: 0,
  };
}

function cursor(stream: string, seq: number): Cursor {
  return { stream, seq } as Cursor;
}

function hello(seq = 10): HelloResult {
  return {
    engine: "0.1.0",
    daemon: "running",
    offices: [summary(A, "alpha", 1), summary(B, "beta")],
    cursor: cursor("software", seq),
  };
}

function story(
  key: string,
  id: string,
  lifecycle: StoryView["lifecycle"],
  run?: string,
): StoryView {
  return {
    key,
    story: id,
    provisional: false,
    title: `Story ${id}`,
    lifecycle,
    column: lifecycle === "In Progress" ? "running" : "ready",
    ...(run === undefined
      ? {}
      : {
          work: {
            story: id,
            key,
            run,
            agent: "agt_01J9ZK5Q8W3V4X6Y7Z8A9B0C01",
            role: "developer",
            tier: "M",
            model: "claude-sonnet",
          },
        }),
  } as StoryView;
}

function work(health: string, phase = "build"): WorkView {
  const totals = {
    inputTokens: 1,
    outputTokens: 1,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    turns: 1,
    elapsedMs: 1,
  };
  return {
    work: story(KEY1, "DIPO-1", "In Progress", RUN1).work,
    phase,
    progress: {
      criteriaMet: 0,
      criteriaTotal: 3,
      loop: 1,
      loopCap: 3,
      verify: "none",
      reviewRound: 0,
    },
    usage: {
      agent: totals,
      run: totals,
      budget: { unit: "tokens", limit: 100, used: 2 },
      budgetShare: 0.02,
    },
    health,
    startedAt: AT,
  } as WorkView;
}

function snapshot(office: OfficeId, seq: number, stories: StoryView[], runs: WorkView[] = []) {
  return {
    cursor: cursor(`office:${office}`, seq),
    stories,
    work: runs,
    gates: [],
    questions: [],
    tests: [],
  } as OfficeSnapshot;
}

function event(stream: string, seq: number, type: string, data: unknown): Event {
  return { cursor: cursor(stream, seq), at: AT, type, data } as Event;
}

async function setup() {
  const client = new FakeStoreClient(hello());
  const clock = new ManualClock();
  const snapshots = new Map<OfficeId, OfficeSnapshot>([
    [A, snapshot(A, 5, [story(KEY1, "DIPO-1", "In Progress", RUN1)], [work("busy")])],
    [B, snapshot(B, 20, [story(KEY2, "BETA-1", "Ready")])],
  ]);
  const answer = (args: Record<string, unknown>) => {
    const found = snapshots.get(args.office as OfficeId);
    return found === undefined
      ? { ok: false as const, error: { code: "office.unknown", message: "no", retryable: false } }
      : { ok: true as const, result: found };
  };
  client.answers.set("office.snapshot", answer);
  client.answers.set("office.switch", answer);
  client.answers.set("engine.hello", () => ({ ok: true, result: hello(30) }));
  const store = new OfficeStore({ client, clock, clientInfo: { name: "test", version: "0" } });
  store.start();
  await store.open(A);
  return { client, clock, store, snapshots };
}

describe("OfficeStore", () => {
  it("takes offices and the daemon state from engine.hello and follows the software stream", async () => {
    const { client, store } = await setup();
    expect(store.state.offices.map((entry) => entry.name)).toEqual(["alpha", "beta"]);
    expect(store.state.daemon).toBe("running");
    expect(client.active("software").after).toEqual(cursor("software", 10));
  });

  it("applies the snapshot, then events by subject, replacing views", async () => {
    const { client, store } = await setup();
    const stream = `office:${A}`;
    expect(client.active(stream).after).toEqual(cursor(stream, 5));
    expect(store.state.work.map((view) => view.health)).toEqual(["busy"]);

    const phase = work("looping", "review");
    client.emit(
      stream,
      event(stream, 6, "work.phase", {
        work: phase.work,
        phase: "review",
        progress: phase.progress,
        view: phase,
      }),
    );
    expect(store.state.work).toEqual([phase]);

    // A work event without a view changes nothing: the store never derives health or phase.
    client.emit(
      stream,
      event(stream, 7, "work.phase", {
        work: phase.work,
        phase: "review",
        progress: phase.progress,
      }),
    );
    expect(store.state.work).toEqual([phase]);

    const added = story(KEY2, "DIPO-2", "Ready");
    client.emit(
      stream,
      event(stream, 8, "story.state", {
        story: "DIPO-2",
        key: KEY2,
        from: "Refined",
        to: "Ready",
        view: added,
      }),
    );
    expect(store.state.stories.map((view) => String(view.story))).toEqual(["DIPO-1", "DIPO-2"]);

    // The story's new view names no run, so its run view goes.
    const parked = { ...story(KEY1, "DIPO-1", "Parked"), column: "desk" } as StoryView;
    client.emit(
      stream,
      event(stream, 9, "story.state", {
        story: "DIPO-1",
        key: KEY1,
        from: "In Progress",
        to: "Parked",
        view: parked,
      }),
    );
    expect(store.state.stories[0]).toEqual(parked);
    expect(store.state.work).toEqual([]);
  });

  it("drops events whose cursor it already applied", async () => {
    const { client, store } = await setup();
    const stream = `office:${A}`;
    const one = story(KEY2, "DIPO-2", "Ready");
    const two = { ...one, title: "renamed" };
    client.emit(
      stream,
      event(stream, 6, "story.state", {
        story: "DIPO-2",
        key: KEY2,
        from: "Refined",
        to: "Ready",
        view: one,
      }),
    );
    // The same cursor again, and an older one, carrying different data: both dropped.
    client.emit(
      stream,
      event(stream, 6, "story.state", {
        story: "DIPO-2",
        key: KEY2,
        from: "Refined",
        to: "Ready",
        view: two,
      }),
    );
    client.emit(
      stream,
      event(stream, 4, "story.state", {
        story: "DIPO-2",
        key: KEY2,
        from: "Refined",
        to: "Ready",
        view: two,
      }),
    );
    expect(store.state.stories.find((view) => view.key === KEY2)?.title).toBe("Story DIPO-2");
    // At or before the snapshot cursor is already in the snapshot.
    client.emit(
      stream,
      event(stream, 5, "story.state", {
        story: "DIPO-2",
        key: KEY2,
        from: "Refined",
        to: "Ready",
        view: two,
      }),
    );
    expect(store.state.stories.find((view) => view.key === KEY2)?.title).toBe("Story DIPO-2");

    // Derived events carry the position they were sent at and are applied every time.
    client.emit("software", event("software", 10, "office.summary", summary(A, "alpha", 3)));
    client.emit("software", event("software", 10, "office.summary", summary(A, "alpha", 4)));
    expect(store.state.offices[0]?.summary?.running).toBe(4);
  });

  it("on stream.resetRequired reads hello and the snapshot again and says so once", async () => {
    const { client, store, snapshots } = await setup();
    const stream = `office:${A}`;
    snapshots.set(A, snapshot(A, 50, [story(KEY2, "DIPO-2", "Ready")]));
    client.end(stream, { code: "stream.resetRequired", message: "gap", retryable: false });
    await settle();
    expect(client.reads.map((read) => read.name)).toEqual([
      "office.snapshot",
      "engine.hello",
      "office.snapshot",
    ]);
    expect(store.state.notice).toBe(RELOADED_NOTICE);
    expect(store.state.stories.map((view) => String(view.story))).toEqual(["DIPO-2"]);
    expect(store.state.work).toEqual([]);
    expect(client.active(stream).after).toEqual(cursor(stream, 50));
    store.dismissNotice();
    expect(store.state.notice).toBeNull();
  });

  it("switches with office.switch: replaces the state, unsubscribes and subscribes after its cursor", async () => {
    const { client, store } = await setup();
    const previous = client.active(`office:${A}`);
    await store.switchTo(B);
    expect(client.reads.at(-1)).toEqual({ name: "office.switch", args: { office: B } });
    expect(previous.active).toBe(false);
    expect(client.active(`office:${B}`).after).toEqual(cursor(`office:${B}`, 20));
    expect(store.state.office).toBe(B);
    expect(store.state.stories.map((view) => String(view.story))).toEqual(["BETA-1"]);
    expect(store.state.work).toEqual([]);
    // A late event of the old office is not applied.
    previous.options.onEvent(
      event(`office:${A}`, 9, "story.state", {
        story: "DIPO-9",
        key: KEY1,
        from: "Ready",
        to: "Ready",
        view: story(KEY1, "DIPO-9", "Ready"),
      }),
    );
    expect(store.state.stories.map((view) => String(view.story))).toEqual(["BETA-1"]);
  });

  it("keeps the office when a switch fails", async () => {
    const { store } = await setup();
    const outcome = await store.switchTo("off_01J9ZK5Q8W3V4X6Y7Z8A9B0CCC" as OfficeId);
    expect(outcome.ok).toBe(false);
    expect(store.state.office).toBe(A);
    expect(store.state.error?.code).toBe("office.unknown");
  });

  it("records when the connection was lost and goes live after catching up", async () => {
    const { client, clock, store } = await setup();
    const lostAt = clock.now();
    client.setState("reconnecting");
    expect(store.state.offlineSince).toBe(lostAt);
    clock.advance(5_000);
    client.setState("reconnecting");
    expect(store.state.offlineSince).toBe(lostAt);
    client.setState("open");
    expect(store.state.connection).toBe("open");
    expect(store.state.offlineSince).toBe(lostAt);
    client.active(`office:${A}`).options.onCaughtUp?.(cursor(`office:${A}`, 5));
    expect(store.state.offlineSince).toBeNull();
    expect(store.state.live).toBe(true);
  });

  it("applies office.summary, office.registered, office.forgotten and daemon.state", async () => {
    const { client, store } = await setup();
    const C = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0CCC" as OfficeId;
    client.emit(
      "software",
      event("software", 11, "office.registered", { office: C, path: "/work/gamma", name: "gamma" }),
    );
    expect(store.state.offices.at(-1)).toEqual({
      office: C,
      name: "gamma",
      path: "/work/gamma",
      summary: undefined,
    });
    client.emit("software", event("software", 12, "office.summary", summary(C, "gamma", 2)));
    expect(store.state.offices.at(-1)?.summary?.running).toBe(2);
    client.emit("software", event("software", 13, "office.forgotten", { office: B }));
    expect(store.state.offices.map((entry) => entry.name)).toEqual(["alpha", "gamma"]);
    client.emit(
      "software",
      event("software", 14, "daemon.state", { from: "running", to: "draining" }),
    );
    expect(store.state.daemon).toBe("draining");
  });

  it("retries a read refused with engine.recovering once the daemon runs", async () => {
    const { client, store, snapshots } = await setup();
    let recovering = true;
    client.answers.set("office.switch", (args) =>
      recovering
        ? { ok: false, error: { code: "engine.recovering", message: "wait", retryable: true } }
        : { ok: true, result: snapshots.get(args.office as OfficeId) },
    );
    await store.switchTo(B);
    expect(store.state.office).toBe(A);
    recovering = false;
    client.emit(
      "software",
      event("software", 11, "daemon.state", { from: "recovering", to: "running" }),
    );
    await settle();
    expect(store.state.office).toBe(B);
  });

  it("ends a read sent during recovery with database.unavailable from a held daemon", async () => {
    const { client, clock, store } = await setup();
    const unavailable = {
      code: "database.unavailable",
      message: "The state database is damaged. No office is loaded.",
      retryable: false,
      details: { reason: "damaged" },
    };
    let refusals = 2;
    let sent = 0;
    client.answers.set("office.switch", () => {
      sent += 1;
      return refusals-- > 0
        ? { ok: false, error: { code: "engine.recovering", message: "wait", retryable: true } }
        : { ok: false, error: unavailable };
    });
    await store.switchTo(B);
    expect(store.state.error?.code).toBe("engine.recovering");
    // No daemon.state ever comes: the daemon stays in recovering. The store asks again on a timer.
    for (let i = 0; i < 2; i++) {
      clock.advance(RECOVERY_POLL_MS);
      await settle();
    }
    expect(sent).toBe(3);
    expect(store.state.error).toEqual(unavailable);
    expect(store.state.office).toBe(A);
    expect(clock.pendingTimers).toBe(0);
  });

  it("retries on the timer without flipping loading, and publishes only a changed error", async () => {
    const { client, clock, store } = await setup();
    const recovering = { code: "engine.recovering", message: "wait", retryable: true };
    const unavailable = { code: "database.unavailable", message: "held", retryable: false };
    let answer: { code: string; message: string; retryable: boolean } = recovering;
    client.answers.set("office.switch", () => ({ ok: false, error: answer }));
    await store.switchTo(B);
    expect(store.state).toMatchObject({ loading: false, error: recovering });
    const seen: { loading: boolean; error: unknown }[] = [];
    store.subscribe(() => seen.push({ loading: store.state.loading, error: store.state.error }));
    for (let i = 0; i < 4; i++) {
      clock.advance(RECOVERY_POLL_MS);
      await settle();
    }
    // Four timed retries with the same answer: no change published, loading never set.
    expect(seen).toEqual([]);
    answer = unavailable;
    clock.advance(RECOVERY_POLL_MS);
    await settle();
    expect(seen).toEqual([{ loading: false, error: unavailable }]);
    expect(clock.pendingTimers).toBe(0);
  });

  it("stops asking again once closed", async () => {
    const { client, clock, store } = await setup();
    client.answers.set("office.switch", () => ({
      ok: false,
      error: { code: "engine.recovering", message: "wait", retryable: true },
    }));
    await store.switchTo(B);
    expect(clock.pendingTimers).toBe(1);
    store.close();
    expect(clock.pendingTimers).toBe(0);
  });

  it("turns a read the closed client refuses into an outcome, never a rejection", async () => {
    const { client, store } = await setup();
    client.answers.set("office.switch", () => {
      throw new ClientError("client.closed", "The client was closed.");
    });
    const outcome = await store.switchTo(B);
    expect(outcome).toEqual({
      ok: false,
      error: { code: "client.closed", message: "The client was closed.", retryable: false },
    });
    expect(store.state.office).toBe(A);
  });

  it("does not undo a switch made while a history-gap reload reads engine.hello", async () => {
    const { client, store } = await setup();
    const held = Promise.withResolvers<{ ok: true; result: HelloResult }>();
    client.answers.set("engine.hello", () => held.promise);
    client.end(`office:${A}`, { code: "stream.resetRequired", message: "gap", retryable: false });
    await store.switchTo(B);
    held.resolve({ ok: true, result: hello(30) });
    await settle();
    expect(store.state.office).toBe(B);
    expect(store.state.stories.map((view) => String(view.story))).toEqual(["BETA-1"]);
    expect(client.reads.filter((read) => read.name === "office.snapshot")).toHaveLength(1);
  });

  it("keeps the office cursor for read-your-writes: the snapshot, then each stored event (DIPO-54)", async () => {
    const { client, store } = await setup();
    const stream = `office:${A}`;
    expect(store.state.cursor).toEqual(cursor(stream, 5));
    const reply = cursor(stream, 7);
    expect(cursorReached(store.state.cursor, reply)).toBe(false);
    const added = story(KEY2, "DIPO-2", "Ready");
    const data = { story: "DIPO-2", key: KEY2, from: "Refined", to: "Ready", view: added };
    client.emit(stream, event(stream, 6, "story.state", data));
    expect(cursorReached(store.state.cursor, reply)).toBe(false);
    // An event that changes no view still moves the cursor.
    client.emit(
      stream,
      event(stream, 7, "work.phase", {
        work: work("busy").work,
        phase: "build",
        progress: work("busy").progress,
      }),
    );
    expect(store.state.cursor).toEqual(reply);
    expect(cursorReached(store.state.cursor, reply)).toBe(true);
    expect(cursorReached(store.state.cursor, cursor(stream, 3))).toBe(true);
    expect(cursorReached(cursor(stream, 2), cursor(stream, 3))).toBe(false);
    expect(cursorReached(store.state.cursor, cursor(`office:${B}`, 1))).toBe(false);
    expect(cursorReached(null, reply)).toBe(false);
  });

  it("counts the snapshots it applied, so a client sees a re-read after its reply (DIPO-54)", async () => {
    const { store } = await setup();
    expect(store.state.snapshots).toBe(1);
    await store.switchTo(B);
    expect(store.state.snapshots).toBe(2);
    await store.open(A);
    expect(store.state.snapshots).toBe(3);
  });

  it("passes work.output text to output listeners once per cursor and keeps none (DIPO-55)", async () => {
    const { client, store } = await setup();
    const stream = `office:${A}`;
    const chunks: unknown[] = [];
    const stop = store.onOutput((chunk) => chunks.push(chunk));
    const output = (seq: number, from: number, text: string, source = "worker") =>
      event(stream, seq, "work.output", {
        work: work("busy").work,
        source,
        from,
        to: from + text.length,
        text,
      });
    client.emit(stream, output(6, 0, "[tool] Read a.ts\n"));
    client.emit(stream, output(6, 0, "[tool] Read a.ts\n"));
    client.emit(stream, output(7, 0, "PASS\n", "verify"));
    expect(chunks).toEqual([
      { run: RUN1, source: "worker", from: 0, to: 17, text: "[tool] Read a.ts\n" },
      { run: RUN1, source: "verify", from: 0, to: 5, text: "PASS\n" },
    ]);
    expect(JSON.stringify(store.state)).not.toContain("[tool] Read");
    stop();
    client.emit(stream, output(8, 17, "more\n"));
    expect(chunks).toHaveLength(2);
  });

  it("passes each stored event of the selected office to office listeners once, after applying it (DIPO-308)", async () => {
    const { client, store } = await setup();
    const stream = `office:${A}`;
    const seen: { type: string; seq: number; stories: number }[] = [];
    const stop = store.onOfficeEvent((received) =>
      seen.push({
        type: received.type,
        seq: received.cursor.seq,
        stories: store.state.stories.length,
      }),
    );
    const parked = story(KEY2, "DIPO-2", "Parked");
    const state = event(stream, 6, "story.state", {
      story: "DIPO-2",
      key: KEY2,
      from: "Ready",
      to: "Parked",
      view: parked,
    });
    client.emit(stream, state);
    client.emit(stream, state);
    expect(seen).toEqual([{ type: "story.state", seq: 6, stories: 2 }]);
    stop();
    client.emit(stream, event(stream, 7, "question.closed", { question: "q" }));
    expect(seen).toHaveLength(1);
  });
});

describe("OfficeStore database line (DIPO-120)", () => {
  const details = { reason: "damaged", backup: "/s/backups/pre-v3.db" };
  const unavailable = {
    code: "database.unavailable",
    message: "The state database is damaged. No office is loaded.",
    retryable: false,
    details,
  };

  /** A daemon held in `recovering` with its database unavailable, and no office selected. */
  async function held() {
    const client = new FakeStoreClient({ ...hello(), daemon: "recovering" });
    client.answers.set("office.snapshot", () => ({ ok: false, error: unavailable }));
    const store = new OfficeStore({
      client,
      clock: new ManualClock(),
      clientInfo: { name: "test", version: "0" },
    });
    store.start();
    await settle();
    return { client, store };
  }

  it("reads one office with no office selected, so the database details reach the state", async () => {
    const { store } = await held();
    expect(store.state.office).toBeNull();
    expect(store.state.database).toEqual(details);
  });

  it("keeps the line across an office switch", async () => {
    const { client, store } = await held();
    client.answers.set("office.switch", () => ({
      ok: true,
      result: snapshot(B, 20, [], []),
    }));
    await store.switchTo(B);
    expect(store.state.office).toBe(B);
    expect(store.state.database).toEqual(details);
  });

  it("clears the line when the daemon goes to draining", async () => {
    const { client, store } = await held();
    client.emit(
      "software",
      event("software", 11, "daemon.state", { from: "recovering", to: "draining" }),
    );
    expect(store.state.database).toBeNull();
    expect(store.state.daemon).toBe("draining");
  });

  it("clears the line on a fresh engine.hello from a daemon that answers reads again", async () => {
    const { client, store } = await held();
    expect(store.state.database).toEqual(details);
    client.setState("reconnecting");
    client.hello = hello(30);
    client.setState("open");
    await settle();
    expect(store.state.daemon).toBe("running");
    expect(store.state.database).toBeNull();
  });
});

/** How many subscriptions to `stream` the store made. */
function subscribes(client: FakeStoreClient, stream: string): number {
  return client.subscriptions.filter((subscription) => subscription.stream === stream).length;
}

describe("OfficeStore stream retry backoff (DIPO-327)", () => {
  const recovering = { code: "engine.recovering", message: "wait", retryable: true };
  const internal = { code: "internal", message: "the stream broke", retryable: false };
  const OFFICE_STREAM = `office:${A}`;

  /**
   * Ends `stream` with `error` `times` times and returns the wait before each new subscription,
   * stepping the manual clock 50 ms at a time.
   */
  function delays(
    client: FakeStoreClient,
    clock: ManualClock,
    stream: string,
    times: number,
    error = recovering,
  ): number[] {
    const waited: number[] = [];
    for (let i = 0; i < times; i++) {
      const before = subscribes(client, stream);
      // A fresh object each time, as the client parses every refusal on its own.
      client.end(stream, { ...error });
      let ms = 0;
      while (subscribes(client, stream) === before) {
        if (ms > 60_000) throw new Error(`${stream} was not subscribed again`);
        clock.advance(50);
        ms += 50;
      }
      waited.push(ms);
    }
    return waited;
  }

  it("waits 250 ms, doubling to at most 5 s", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 30].map(streamRetryDelay)).toEqual([
      250, 500, 1_000, 2_000, 4_000, 5_000, 5_000, 5_000,
    ]);
    expect(STREAM_RETRY_MAX_MS).toBe(5_000);
  });

  it("subscribes the office stream again after its last cursor on the backoff", async () => {
    const { client, clock, store } = await setup();
    client.emit(OFFICE_STREAM, event(OFFICE_STREAM, 6, "question.closed", { question: "q" }));
    expect(delays(client, clock, OFFICE_STREAM, 7)).toEqual([
      250, 500, 1_000, 2_000, 4_000, 5_000, 5_000,
    ]);
    expect(client.active(OFFICE_STREAM).after).toEqual(cursor(OFFICE_STREAM, 6));
    expect(store.state.streamError).toBeNull();
  });

  it("starts over at 250 ms once the daemon runs again, which subscribes at once", async () => {
    const { client, clock } = await setup();
    expect(delays(client, clock, OFFICE_STREAM, 4)).toEqual([250, 500, 1_000, 2_000]);
    client.end(OFFICE_STREAM, recovering);
    const before = subscribes(client, OFFICE_STREAM);
    client.emit(
      "software",
      event("software", 11, "daemon.state", { from: "recovering", to: "running" }),
    );
    expect(subscribes(client, OFFICE_STREAM)).toBe(before + 1);
    // The 4 s retry that was waiting is gone: nothing more subscribes.
    clock.advance(10_000);
    expect(subscribes(client, OFFICE_STREAM)).toBe(before + 1);
    expect(delays(client, clock, OFFICE_STREAM, 2)).toEqual([250, 500]);
  });

  it("starts over at 250 ms after a reconnect, which subscribes at once", async () => {
    const { client, clock } = await setup();
    expect(delays(client, clock, OFFICE_STREAM, 4)).toEqual([250, 500, 1_000, 2_000]);
    client.end(OFFICE_STREAM, recovering);
    const before = subscribes(client, OFFICE_STREAM);
    client.setState("reconnecting");
    client.setState("open");
    await settle();
    expect(subscribes(client, OFFICE_STREAM)).toBe(before + 1);
    expect(delays(client, clock, OFFICE_STREAM, 2)).toEqual([250, 500]);
  });

  it("subscribes the software stream again after its last cursor on the same backoff", async () => {
    const { client, clock, store } = await setup();
    client.emit("software", event("software", 12, "office.forgotten", { office: B }));
    expect(delays(client, clock, "software", 4)).toEqual([250, 500, 1_000, 2_000]);
    expect(client.active("software").after).toEqual(cursor("software", 12));
    expect(store.state.error?.code).toBe("engine.recovering");
    client.active("software").options.onCaughtUp?.(cursor("software", 12));
    expect(store.state.error).toBeNull();
  });

  it("starts over at 250 ms once a subscription caught up", async () => {
    const { client, clock } = await setup();
    expect(delays(client, clock, OFFICE_STREAM, 4)).toEqual([250, 500, 1_000, 2_000]);
    client.active(OFFICE_STREAM).options.onCaughtUp?.(cursor(OFFICE_STREAM, 5));
    expect(delays(client, clock, OFFICE_STREAM, 2)).toEqual([250, 500]);
    expect(delays(client, clock, "software", 3)).toEqual([1_000, 2_000, 4_000]);
    client.active("software").options.onCaughtUp?.(cursor("software", 10));
    expect(delays(client, clock, "software", 1)).toEqual([250]);
  });

  it("subscribes both streams again on one timer when they end together", async () => {
    const { client, clock } = await setup();
    client.end("software", recovering);
    client.end(OFFICE_STREAM, recovering);
    expect(clock.pendingTimers).toBe(1);
    clock.advance(250);
    expect(subscribes(client, "software")).toBe(2);
    expect(subscribes(client, OFFICE_STREAM)).toBe(2);
  });

  it("keeps a stream error that does not retry in streamError until a reconnect", async () => {
    const { client, clock, store } = await setup();
    client.end(OFFICE_STREAM, internal);
    expect(store.state.streamError).toEqual(internal);
    expect(store.state.live).toBe(false);
    clock.advance(60_000);
    expect(subscribes(client, OFFICE_STREAM)).toBe(1);
    // A retryable end of the other stream does not take the office stream along on its timer.
    client.end("software", recovering);
    clock.advance(250);
    expect(subscribes(client, "software")).toBe(2);
    expect(subscribes(client, OFFICE_STREAM)).toBe(1);
    expect(store.state.streamError).toEqual(internal);

    client.setState("reconnecting");
    client.setState("open");
    await settle();
    expect(subscribes(client, OFFICE_STREAM)).toBe(2);
    expect(store.state.streamError).toBeNull();
  });

  it("keeps a software stream error that does not retry until a reconnect", async () => {
    const { client, clock, store } = await setup();
    client.end("software", internal);
    expect(store.state.streamError).toEqual(internal);
    clock.advance(60_000);
    expect(subscribes(client, "software")).toBe(1);
    client.setState("reconnecting");
    client.setState("open");
    await settle();
    expect(subscribes(client, "software")).toBe(2);
    expect(store.state.streamError).toBeNull();
  });
});
