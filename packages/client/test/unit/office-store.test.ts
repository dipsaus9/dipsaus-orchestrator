// The `OfficeStore` (DIPO-53, 0009 sections 2 and 7): snapshot then events by subject, duplicate
// cursors dropped, views replaced and never derived, `stream.resetRequired` reloads once, and
// `office.switch` replaces the office and its stream.

import { describe, expect, it } from "bun:test";

import {
  CONTRACT_VERSION,
  type Cursor,
  type Event,
  type OfficeId,
  type OfficeSnapshot,
  type OfficeSummary,
  type StoryView,
  type WorkView,
} from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import { ClientError, type HelloResult, OfficeStore, RELOADED_NOTICE } from "../../src/index";
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
    onHold: 0,
    waitingOnMaintainer: 0,
  };
}

function cursor(stream: string, seq: number, epoch = "e1"): Cursor {
  return { stream, epoch, seq } as Cursor;
}

function hello(seq = 10): HelloResult {
  return {
    engine: "0.1.0",
    contract: CONTRACT_VERSION,
    capabilities: [],
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
    signals: [],
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

function event(stream: string, seq: number, type: string, data: unknown, epoch = "e1"): Event {
  return { cursor: cursor(stream, seq, epoch), at: AT, type, data } as Event;
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

    const phase = work("looping", "verify");
    client.emit(
      stream,
      event(stream, 6, "work.phase", {
        work: phase.work,
        phase: "verify",
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
    client.emit("software", event("software", 14, "daemon.state", { from: "running", to: "safe" }));
    expect(store.state.daemon).toBe("safe");
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
});
