// `waitForRecovery` (DIPO-86) against a fake daemon behind the real `DipoClient` on the manual
// clock: `engine.recovering` makes a command wait for `daemon.status` to leave `starting` and
// `recovering` and go again with the same `requestId`; a read goes again with a new one; a daemon
// that ends recovery in `safe` is reported once; `close` ends a wait at once.

import { describe, expect, it } from "bun:test";

import {
  type ClientFrame,
  CONTRACT_VERSION,
  type DaemonState,
  officeOpen,
  type OfficeId,
  type RequestId,
  officeSnapshot,
  type ServerFrame,
  workRun,
} from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import {
  ClientError,
  DipoClient,
  RECOVERY_NOTICE_MS,
  RECOVERY_POLL_MS,
  type Transport,
  waitForRecovery,
} from "../../src/index";

const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D" as OfficeId;
const RECOVERING = { code: "engine.recovering", message: "recovering", retryable: true };

type Answer = { ok: true; result: unknown; changed?: boolean } | { ok: false; error: unknown };
type Request = Extract<ClientFrame, { kind: "command" | "read" }>;

/**
 * A daemon on the far side of the transport: it answers `engine.hello` itself, `daemon.status`
 * with the next scripted state (the last one repeats) and every other request with `answer`.
 */
class FakeDaemon implements Transport {
  readonly requests: Request[] = [];
  states: DaemonState[] = ["running"];
  reason: string | undefined;
  answer: (request: Request) => Answer = () => ({ ok: true, result: {}, changed: false });

  connect(handlers: Parameters<Transport["connect"]>[0]) {
    queueMicrotask(() => handlers.onOpen());
    return {
      send: (text: string) => {
        const frame = JSON.parse(text) as ClientFrame;
        if (frame.kind !== "command" && frame.kind !== "read") return;
        const reply = this.#reply(frame);
        const server: ServerFrame = {
          kind: "reply",
          reply: { requestId: frame.requestId, ...reply } as never,
        };
        queueMicrotask(() => handlers.onMessage(JSON.stringify(server)));
      },
      close: () => undefined,
    };
  }

  /** The requests other than the handshake. */
  named(name: string): Request[] {
    return this.requests.filter((request) => request.name === name);
  }

  #reply(frame: Request): Answer {
    if (frame.name === "engine.hello") {
      const cursor = { stream: "software", epoch: "ep1", seq: 0 };
      const result = { engine: "0.0.0-test", contract: CONTRACT_VERSION, capabilities: [] };
      return { ok: true, result: { ...result, daemon: "recovering", offices: [], cursor } };
    }
    this.requests.push(frame);
    if (frame.name === "daemon.status") {
      const state = this.states.length > 1 ? this.states.shift() : this.states[0];
      return { ok: true, result: status(state ?? "running", this.reason) };
    }
    return this.answer(frame);
  }
}

function status(state: DaemonState, reason: string | undefined) {
  return {
    state,
    ...(reason === undefined ? {} : { stateReason: reason }),
    pid: 4242,
    version: "0.0.0-test",
    uptimeMs: 1_000,
    socket: "/tmp/dipo.sock",
    loadedOffices: [],
    activeRuns: 0,
    keepAwake: { held: false },
    upgradePending: false,
    tools: {},
  };
}

/** Lets queued replies and the code awaiting them run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

async function setup() {
  const clock = new ManualClock();
  const daemon = new FakeDaemon();
  const client = new DipoClient({
    transport: daemon,
    clock,
    client: { name: "test", version: "0.0.0" },
    origin: "cli",
  });
  await client.connect();
  const said: string[] = [];
  const session = waitForRecovery(client, {
    clock,
    onWaiting: () => said.push("waiting"),
    onSafe: (reason) => said.push(`safe: ${reason}`),
  });
  /** Moves the clock one poll at a time, letting replies through after each step. */
  const polls = async (count: number) => {
    for (let i = 0; i < count; i++) {
      clock.advance(RECOVERY_POLL_MS);
      await flush();
    }
  };
  return { clock, daemon, session, said, polls };
}

describe("waitForRecovery", () => {
  it("sends a command again with the same request id after two engine.recovering replies", async () => {
    const { daemon, session, said, polls } = await setup();
    let refusals = 2;
    daemon.answer = () =>
      refusals-- > 0
        ? { ok: false, error: RECOVERING }
        : { ok: true, result: { office: OFFICE, registered: true }, changed: true };
    const done = session.command(officeOpen, { path: "/work/app" });
    await flush();
    expect(daemon.named("office.open")).toHaveLength(1);
    expect(session.waiting).toBe(true);
    await polls(2);
    const outcome = await done;

    expect(outcome).toEqual({
      ok: true,
      result: { office: OFFICE, registered: true },
      changed: true,
    });
    const sent = daemon.named("office.open");
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((request) => request.requestId)).size).toBe(1);
    expect(daemon.named("daemon.status")).toHaveLength(2);
    expect(session.waiting).toBe(false);
    // Two polls are half a second: no notice.
    expect(said).toEqual([]);
  });

  it("keeps a request id the caller chose", async () => {
    const { daemon, session, polls } = await setup();
    let refusals = 1;
    daemon.answer = () =>
      refusals-- > 0
        ? { ok: false, error: RECOVERING }
        : { ok: true, result: { started: [], skipped: [] }, changed: false };
    const id = "01J9ZK5Q8W3V4X6Y7Z8A9B0CRR" as RequestId;
    const done = session.command(workRun, {}, { office: OFFICE, requestId: id });
    await flush();
    await polls(1);
    await done;
    expect(daemon.named("work.run").map((request) => request.requestId)).toEqual([id, id]);
  });

  it("waits while daemon.status still says recovering and says so once after a second", async () => {
    const { daemon, session, said, polls } = await setup();
    daemon.states = ["starting", "recovering", "recovering", "recovering", "recovering", "running"];
    let refusals = 1;
    daemon.answer = () =>
      refusals-- > 0
        ? { ok: false, error: RECOVERING }
        : { ok: true, result: { office: OFFICE, registered: false }, changed: false };
    const done = session.command(officeOpen, { path: "/work/app" });
    await flush();
    await polls(RECOVERY_NOTICE_MS / RECOVERY_POLL_MS - 1);
    expect(said).toEqual([]);
    await polls(1);
    expect(said).toEqual(["waiting"]);
    await polls(2);
    expect(await done).toMatchObject({ ok: true, changed: false });
    expect(daemon.named("daemon.status")).toHaveLength(6);
    expect(said).toEqual(["waiting"]);
  });

  it("sends a read again with a new request id", async () => {
    const { daemon, session, polls } = await setup();
    let refusals = 1;
    daemon.answer = () =>
      refusals-- > 0
        ? { ok: false, error: RECOVERING }
        : { ok: false, error: { code: "x", message: "m", retryable: false } };
    const done = session.read(officeSnapshot, { office: OFFICE });
    await flush();
    await polls(1);
    expect(await done).toMatchObject({ ok: false, error: { code: "x" } });
    const ids = daemon.named("office.snapshot").map((request) => request.requestId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("reports a recovery that ends in safe and returns the command's own answer", async () => {
    const { daemon, session, said, polls } = await setup();
    daemon.states = ["recovering", "safe"];
    daemon.reason = "crash loop";
    let refusals = 1;
    const off = { code: "scheduling.off", message: "Scheduling is off", retryable: true };
    daemon.answer = () =>
      refusals-- > 0 ? { ok: false, error: RECOVERING } : { ok: false, error: off };
    const done = session.command(workRun, {}, { office: OFFICE });
    await flush();
    await polls(2);
    expect(await done).toEqual({ ok: false, error: off });
    expect(said).toEqual(["safe: crash loop"]);
    expect(daemon.named("work.run")).toHaveLength(2);
  });

  it("returns other errors at once without polling", async () => {
    const { daemon, session } = await setup();
    const error = { code: "office.notProject", message: "no", retryable: false };
    daemon.answer = () => ({ ok: false, error });
    expect(await session.command(officeOpen, { path: "/x" })).toEqual({ ok: false, error });
    expect(daemon.named("daemon.status")).toHaveLength(0);
  });

  it("ends a wait at once on close and leaves no timer behind", async () => {
    const { clock, daemon, session, said } = await setup();
    daemon.answer = () => ({ ok: false, error: RECOVERING });
    const done = session.command(officeOpen, { path: "/work/app" });
    await flush();
    expect(session.waiting).toBe(true);
    session.close();
    const failure = await done.then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ClientError);
    expect((failure as ClientError).code).toBe("client.closed");
    expect(clock.pendingTimers).toBe(0);
    expect(said).toEqual([]);
  });
});
