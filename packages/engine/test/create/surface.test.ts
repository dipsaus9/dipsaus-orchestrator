// The engine's surface as `createEngine` builds it (DIPO-318; 0005 sections 3, 5, 7, 8, 9 and 11;
// 0006 decisions 5, 7 and 9), with fakes for the daemon's process concerns and a real office on a
// temporary repository: what `engine.hello`, `commands.describe` and the `daemon.*` operations
// answer, the lifecycle checks, the software stream and an office's change log with their cursors,
// the order of a command's reply and its office's change, and the time the last TUI left an office.
// The socket server's own protocol over these answers is tested in the daemon against a fake of
// this surface.

import { describe, expect, it } from "bun:test";

import {
  type CommandReply,
  type Cursor,
  type Event,
  type OfficeId,
  type ReadReply,
  type StreamName,
} from "@dipsaus-orchestrator/contract";

import { Renderer } from "../../src/changelog/render";
import type { Engine } from "../../src/create/deps";
import { TEST_VERSION, withEngine, type EngineFixture } from "./engine-fixture";

const TIMEOUT_MS = 30_000;

function okResult<T>(reply: ReadReply | CommandReply): T {
  if (!reply.ok) throw new Error(`expected ok, got ${reply.error.code}: ${reply.error.message}`);
  return reply.result as T;
}

function errorCode(reply: ReadReply | CommandReply | { ok: boolean; error?: { code: string } }) {
  if (reply.ok) throw new Error("expected an error reply");
  return (reply as { error: { code: string } }).error.code;
}

const stream = (office: OfficeId) => `office:${office}` as StreamName;

/** Every entry of `office`'s change log after `from`, page by page. */
function pages(engine: Engine, office: OfficeId, from: Cursor, limit = 100): Event[] {
  const events: Event[] = [];
  let position = from;
  for (;;) {
    const page = engine.officePage(office, position, limit);
    if (page.kind === "gone") throw new Error("the office is gone");
    events.push(...page.events);
    const last = page.events.at(-1);
    if (last !== undefined) position = last.cursor;
    if (page.last) return events;
  }
}

/** Loads `office` by subscribing to its stream and returns the head it subscribed at. */
async function head(f: EngineFixture, office: OfficeId): Promise<Cursor> {
  const subscribed = await f.engine.subscribe(stream(office), undefined);
  if (!subscribed.ok) throw new Error(subscribed.error.message);
  return subscribed.from;
}

/** The software events the engine appends from now on. */
function softwareEvents(engine: Engine): Event[] {
  const events: Event[] = [];
  engine.onSoftwareEvent((event) => events.push(event));
  return events;
}

describe("engine.hello and commands.describe", () => {
  it(
    "answers engine.hello with the version, daemon state, offices and the software cursor",
    () =>
      withEngine(async (f) => {
        await f.engine.recover();
        const hello = okResult<{
          engine: string;
          daemon: string;
          offices: unknown[];
          cursor: Cursor;
        }>(await f.hello());
        expect(hello.engine).toBe(TEST_VERSION);
        expect(hello.daemon).toBe("running");
        expect(hello.offices).toEqual([]);
        // starting -> recovering -> running, counted from the stream's start time (0005).
        expect(hello.cursor.seq).toBe(f.clock.now() + 2);
        expect(hello).not.toHaveProperty("contract");
        expect(hello).not.toHaveProperty("capabilities");
      }),
    TIMEOUT_MS,
  );

  it(
    "lists registered commands and reads with schemas",
    () =>
      withEngine(async (f) => {
        await f.engine.recover();
        const described = okResult<{
          commands: { name: string; confirm: boolean; irreversible: boolean }[];
          reads: { name: string; args: unknown; result: unknown }[];
        }>(await f.read("commands.describe"));
        const echo = described.reads.find((read) => read.name === "fixture.echo");
        expect(echo).toEqual({
          name: "fixture.echo",
          args: { type: "object", properties: {} },
          result: expect.objectContaining({ type: "object" }) as unknown,
        });
        const reads = described.reads.map((read) => read.name);
        expect(reads).toEqual(
          expect.arrayContaining([
            "engine.hello",
            "commands.describe",
            "daemon.status",
            // The view reads ship with DIPO-52.
            "office.snapshot",
            "office.switch",
          ]),
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
        // Contract entries no engine module registered are absent too.
        expect(commands).not.toContain("work.intervene");
        const stop = described.commands.find((command) => command.name === "daemon.stop");
        expect(stop).toMatchObject({ confirm: true, irreversible: false });
      }),
    TIMEOUT_MS,
  );
});

describe("daemon.* operations", () => {
  it(
    "reports daemon.status from the lifecycle",
    () =>
      withEngine(async (f) => {
        await f.engine.recover();
        f.clock.advance(1234);
        const status = okResult<Record<string, unknown>>(await f.read("daemon.status"));
        expect(status).toMatchObject({
          state: "running",
          stateReason: "recovered",
          pid: process.pid,
          version: TEST_VERSION,
          uptimeMs: 1234,
          socket: f.deps.daemon.socket,
          loadedOffices: [],
          activeRuns: 0,
          keepAwake: { held: false },
          upgradePending: false,
        });
      }),
    TIMEOUT_MS,
  );

  it(
    "reports the resolved tool paths and a pending upgrade in daemon.status",
    () =>
      withEngine(async (f) => {
        await f.engine.recover();
        const before = okResult<Record<string, unknown>>(await f.read("daemon.status"));
        expect(before).toMatchObject({ tools: f.deps.tools, upgradePending: false });
        f.upgrade.pending = true;
        const after = okResult<Record<string, unknown>>(await f.read("daemon.status"));
        expect(after).toMatchObject({ tools: f.deps.tools, upgradePending: true });
      }),
    TIMEOUT_MS,
  );

  it(
    "stops: daemon.stop moves to draining, asks for the drain once, and a repeat changes nothing",
    () =>
      withEngine(async (f) => {
        await f.engine.recover();
        const first = await f.command("daemon.stop", { stopWorkers: true });
        expect(first).toMatchObject({ ok: true, result: { state: "draining" }, changed: true });
        expect(f.engine.state()).toBe("draining");
        const again = await f.command("daemon.stop", { stopWorkers: true });
        expect(again).toMatchObject({ ok: true, result: { state: "draining" }, changed: false });
        expect(f.stops).toEqual([{ reason: "daemon.stop", stopWorkers: true }]);
      }),
    TIMEOUT_MS,
  );

  it(
    "returns the stored reply for a retried daemon command",
    () =>
      withEngine(async (f) => {
        await f.engine.recover();
        const request = {
          requestId: "01J9ZK5Q8W3V4X6Y7Z99999999",
          name: "daemon.setLogLevel",
          args: { level: "debug" },
          origin: "cli" as const,
          confirmed: false,
        } as Parameters<Engine["executeCommand"]>[0];
        const first = await f.engine.executeCommand(request);
        expect(first).toMatchObject({ ok: true, result: { level: "debug" }, changed: true });
        // A different request id with the same level is a no-op; the retry gets the stored reply.
        expect(await f.command("daemon.setLogLevel", { level: "debug" })).toMatchObject({
          changed: false,
        });
        expect(await f.engine.executeCommand(request)).toEqual(first);
      }),
    TIMEOUT_MS,
  );

  it(
    "answers daemon.resumeScheduling with nothing paused as a change of nothing",
    () =>
      withEngine(async (f) => {
        await f.engine.recover();
        const events = softwareEvents(f.engine);
        const resumed = await f.command("daemon.resumeScheduling", {});
        expect(resumed).toMatchObject({ ok: true, result: { state: "running" }, changed: false });
        expect(events.filter((e) => e.type === "daemon.state")).toEqual([]);
      }),
    TIMEOUT_MS,
  );
});

/** Office requests get engine.recovering; the handshake, describe, daemon.* and software work. */
async function expectRecovering(f: EngineFixture): Promise<void> {
  const office = "off_01J9ZK5Q8W3V4X6Y7Z00000001" as OfficeId;
  const command = await f.command("fixture.scan", {}, office);
  expect(command).toMatchObject({
    ok: false,
    error: { code: "engine.recovering", retryable: true },
  });
  expect(errorCode(await f.read("fixture.echo"))).toBe("engine.recovering");
  expect(errorCode(await f.engine.subscribe(stream(office), undefined))).toBe("engine.recovering");
  expect((await f.hello()).ok).toBe(true);
  expect((await f.read("commands.describe")).ok).toBe(true);
  expect((await f.read("daemon.status")).ok).toBe(true);
  expect((await f.engine.subscribe("software" as StreamName, undefined)).ok).toBe(true);
}

describe("lifecycle checks", () => {
  it(
    "answers office commands and reads with engine.recovering while starting",
    () =>
      withEngine(async (f) => {
        expect(f.engine.state()).toBe("starting");
        await expectRecovering(f);
      }),
    TIMEOUT_MS,
  );

  it(
    "answers office commands and reads with engine.recovering while recovering",
    () => {
      const held = Promise.withResolvers<void>();
      const holding = Promise.withResolvers<void>();
      return withEngine(
        async (f) => {
          const recovered = f.engine.recover();
          await holding.promise;
          expect(f.engine.state()).toBe("recovering");
          await expectRecovering(f);
          held.resolve();
          await recovered;
          expect(f.engine.state()).toBe("running");
        },
        {
          recoverySteps: [
            {
              name: "test hold",
              run: async () => {
                holding.resolve();
                await held.promise;
              },
            },
          ],
        },
      );
    },
    TIMEOUT_MS,
  );
});

describe("the software stream", () => {
  it(
    "replays after a cursor and sends live events, and asks a cursor of an earlier daemon to reset",
    () =>
      withEngine(async (f) => {
        const hello = okResult<{ cursor: Cursor }>(await f.hello());
        await f.engine.recover();
        const subscribed = await f.engine.subscribe("software" as StreamName, hello.cursor);
        if (!subscribed.ok || subscribed.office !== null) throw new Error("expected a replay");
        expect(subscribed.from).toEqual(hello.cursor);
        // Seqs count from the stream's start, the daemon's start time (0005).
        const at = (n: number) => hello.cursor.seq + n;
        expect(subscribed.events.map((e) => [e.cursor.seq, e.type, e.data])).toEqual([
          [
            at(1),
            "daemon.state",
            { from: "starting", to: "recovering", reason: "running recovery steps" },
          ],
          [at(2), "daemon.state", { from: "recovering", to: "running", reason: "recovered" }],
        ]);
        expect(subscribed.head.seq).toBe(at(2));

        const live = softwareEvents(f.engine);
        await f.engine.drain({ reason: "SIGTERM", stopWorkers: false });
        expect(live.map((e) => e.data)).toEqual([
          { from: "running", to: "draining", reason: "SIGTERM" },
        ]);

        // The ring buffer's own limits are tested with the stream (software-stream/stream.test.ts).
        const reset = await f.engine.subscribe(
          "software" as StreamName,
          { stream: "software", seq: hello.cursor.seq - 1 } as Cursor,
        );
        if (reset.ok) throw new Error("expected stream.resetRequired");
        expect(reset.error.code).toBe("stream.resetRequired");
        expect(reset.error.details).toEqual({ oldest: hello.cursor });
      }),
    TIMEOUT_MS,
  );

  it(
    "summarises each office from what the engine stored",
    () =>
      withEngine(async (f) => {
        await f.engine.recover();
        const office = await f.open();
        expect(f.engine.officeSummaries()).toMatchObject([{ office, running: 0 }]);
        const state = await f.state();
        state.connection.immediate(() =>
          state.connection.run(
            `insert into runs (office_id, run_id, kind, role, model, budget_unit, budget_limit,
                 loop_cap, config_hash, started_at)
               values ($office, 'run_1', 'session', 'developer', 'haiku', 'tokens', 1, 1, 'h', 0)`,
            { office },
          ),
        );
        expect(f.engine.officeSummary(office)).toMatchObject({ office, running: 1 });
      }),
    TIMEOUT_MS,
  );
});

describe("an office's change log", () => {
  it(
    "replays after a cursor page by page, and a command's entries carry its request",
    () =>
      withEngine(async (f) => {
        await f.engine.recover();
        const office = await f.open();
        const loaded = await head(f, office);
        for (let i = 0; i < 3; i++) {
          expect(await f.command("fixture.scan", {}, office)).toMatchObject({ ok: true });
        }
        const from = { ...loaded, seq: loaded.seq + 1 };
        const subscribed = await f.engine.subscribe(stream(office), from);
        expect(subscribed).toEqual({ ok: true, from, office });
        const replayed = pages(f.engine, office, from, 1);
        expect(replayed.map((e) => [e.cursor.seq, e.type])).toEqual([
          [loaded.seq + 2, "scan.finished"],
          [loaded.seq + 3, "scan.finished"],
        ]);
        expect(replayed[0]?.data).toEqual({ scripts: { test: "bun test" }, warnings: [] });

        const live = await f.command("fixture.scan", {}, office);
        const next = pages(f.engine, office, replayed.at(-1)?.cursor ?? from);
        expect(next.map((e) => e.cursor.seq)).toEqual([loaded.seq + 4]);
        expect(next[0]?.causedBy).toBe(live.requestId);
        expect(live).toMatchObject({ ok: true, cursor: next[0]?.cursor });
      }),
    TIMEOUT_MS,
  );

  it(
    "subscribes from the head when no cursor is given",
    () =>
      withEngine(async (f) => {
        await f.engine.recover();
        const office = await f.open();
        const loaded = await head(f, office);
        await f.command("fixture.scan", {}, office);
        const subscribed = await f.engine.subscribe(stream(office), undefined);
        expect(subscribed).toMatchObject({ ok: true, from: { ...loaded, seq: loaded.seq + 1 } });
      }),
    TIMEOUT_MS,
  );

  it(
    "sends a command's reply before its office's subscribers hear of the entries (DIPO-318)",
    () =>
      withEngine(async (f) => {
        await f.engine.recover();
        const office = await f.open();
        await head(f, office);
        const order: string[] = [];
        f.engine.onOfficeChanged((changed) => order.push(`changed ${changed}`));
        const reply = await f.engine.executeCommand(
          {
            requestId: "01J9ZK5Q8W3V4X6Y7Z88888888",
            name: "fixture.scan",
            args: {},
            origin: "cli",
            confirmed: false,
            office,
          } as Parameters<Engine["executeCommand"]>[0],
          {},
          (sent) => order.push(`reply ${sent.ok}`),
        );
        expect(reply.ok).toBe(true);
        expect(order).toEqual(["reply true", `changed ${office}`]);
      }),
    TIMEOUT_MS,
  );

  it(
    "asks a cursor beyond the last entry to reset, and does not know a forgotten office",
    () =>
      withEngine(async (f) => {
        await f.engine.recover();
        const office = await f.open();
        // A log that was lost and started again: the cursor is beyond its last entry.
        const reset = await f.engine.subscribe(stream(office), {
          stream: stream(office),
          seq: 1_000,
        } as Cursor);
        if (reset.ok) throw new Error("expected stream.resetRequired");
        expect(reset.error.code).toBe("stream.resetRequired");
        expect((reset.error.details as { oldest: Cursor }).oldest).toMatchObject({
          stream: stream(office),
          seq: 0,
        });

        // An office row that was forgotten.
        const other = "off_01J9ZK5Q8W3V4X6Y7Z00000777" as OfficeId;
        const state = await f.state();
        state.connection.immediate(() =>
          state.connection.run(
            `insert into offices (office_id, path, display_name, added_at, next_seq, forgotten_at)
               values ($office, '/repos/other', 'other', 0, 1, 1)`,
            { office: other },
          ),
        );
        expect(errorCode(await f.engine.subscribe(stream(other), undefined))).toBe(
          "office.unknown",
        );
      }),
    TIMEOUT_MS,
  );

  it(
    "gives a stored entry that does not render as an engine.notice at its cursor (DIPO-124)",
    () =>
      withEngine(async (f) => {
        await f.engine.recover();
        const office = await f.open();
        const loaded = await head(f, office);
        await f.command("fixture.scan", {}, office);
        // An entry an older binary stored without the write check: it does not render.
        const bad = loaded.seq + 2;
        const state = await f.state();
        state.connection.immediate(() => {
          state.connection.run(
            `insert into change_log (office_id, seq, at, type, key, run_id, caused_by, delta, view)
             values ($office, $seq, 1, 'story.state', null, null, null, '{"story":"DIPO-1"}', null)`,
            { office, seq: bad },
          );
          state.connection.run("update offices set next_seq = $next where office_id = $office", {
            office,
            next: bad + 1,
          });
        });
        await f.command("fixture.scan", {}, office);
        // Two readers from the same cursor (as a reconnect would send) each read past it.
        for (let reader = 0; reader < 2; reader++) {
          const events = pages(f.engine, office, loaded);
          expect(events.map((e) => [e.cursor.seq, e.type])).toEqual([
            [loaded.seq + 1, "scan.finished"],
            [bad, "engine.notice"],
            [bad + 1, "scan.finished"],
          ]);
          expect(events[1]?.data).toMatchObject({ level: "error", code: "changelog.unrenderable" });
        }
      }),
    TIMEOUT_MS,
  );

  it(
    "throws from a page on an error that is not a render failure (DIPO-124)",
    () =>
      withEngine(
        async (f) => {
          await f.engine.recover();
          const office = await f.open();
          const loaded = await head(f, office);
          await f.command("fixture.scan", {}, office);
          expect(() => f.engine.officePage(office, loaded, 100)).toThrow("the renderer broke");
        },
        {
          renderer: new Renderer({
            "scan.finished": () => {
              throw new Error("the renderer broke");
            },
          }),
        },
      ),
    TIMEOUT_MS,
  );
});

describe("when the last TUI of an office left (DIPO-308)", () => {
  it(
    "stores the time the server tells, and office.digest counts from it",
    () =>
      withEngine(async (f) => {
        await f.engine.recover();
        const office = await f.open();
        await head(f, office);
        f.clock.advance(120_000);
        const closedAt = f.clock.now();
        f.engine.tuiLeft(office, closedAt);
        f.clock.advance(60_000);
        const digest = okResult<{ since: string }>(await f.read("office.digest", { office }));
        expect(digest.since).toBe(new Date(closedAt).toISOString());
      }),
    TIMEOUT_MS,
  );
});
