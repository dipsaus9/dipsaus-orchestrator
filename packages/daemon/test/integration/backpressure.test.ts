// Slow clients (DIPO-24 review). Office catch-up is flow-controlled: it reads, renders and sends a
// page only while less than `PUMP_HIGH_WATER_BYTES` wait to be written, so a client that stops
// reading pauses its catch-up instead of growing the daemon's buffer. A connection that passes the
// backpressure limit anyway is closed, the server stops reading and rendering for it, and the
// client resumes from its cursor on a new connection (at least once, 0005 section 8). The slow
// client is a raw Unix socket that completes the WebSocket upgrade, sends its frames, and then
// stops reading.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createConnection, type Socket } from "node:net";

import { CONTRACT_VERSION, type Cursor, type OfficeId } from "@dipsaus-orchestrator/contract";
import { renderDelta, Renderer } from "@dipsaus-orchestrator/engine";
import { makeTempDir, removeTempDir } from "@dipsaus-orchestrator/testkit";

import { requestId, TestClient } from "../support/client";
import { BULK_ENTRIES, startHarness, type Harness, type HarnessOptions } from "../support/harness";

const COMMANDS = 5; // 5 x 120 entries of 16 KiB: about 9.4 MiB
const TOTAL = BULK_ENTRIES * COMMANDS;
const TIMEOUT_MS = 30_000;

let dir: string;
let harness: Harness | null = null;
let raw: Socket | null = null;
let rendered = 0;

beforeEach(() => {
  dir = makeTempDir();
  rendered = 0;
});

afterEach(async () => {
  raw?.destroy();
  raw = null;
  await harness?.close();
  harness = null;
  removeTempDir(dir);
});

/** A renderer that counts the `scan.finished` entries it renders. */
function countingRenderer(): Renderer {
  return new Renderer({
    "scan.finished": (entry) => {
      rendered += 1;
      return renderDelta(entry);
    },
  });
}

async function start(options: HarnessOptions = {}): Promise<Harness> {
  harness = await startHarness(dir, { renderer: countingRenderer(), ...options });
  return harness;
}

/** One masked client text frame (RFC 6455 section 5.2) with an all-zero mask key. */
function clientFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  const header =
    payload.length < 126
      ? Buffer.from([0x81, 0x80 | payload.length])
      : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([header, Buffer.alloc(4), payload]);
}

/** Upgrades a raw connection, sends `frames`, then stops reading. */
function slowClient(path: string, frames: readonly unknown[]): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(
        "GET / HTTP/1.1\r\nHost: dipo\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
      );
    });
    socket.once("data", (chunk) => {
      if (!chunk.toString("latin1").startsWith("HTTP/1.1 101")) {
        reject(new Error(`upgrade failed: ${chunk.toString("latin1").slice(0, 80)}`));
        return;
      }
      socket.pause();
      for (const frame of frames) socket.write(clientFrame(frame));
      resolve(socket);
    });
  });
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** Writes the bulk entries and returns the office and the cursor before the first one. */
async function fill(h: Harness): Promise<{ office: OfficeId; start: Cursor }> {
  const office = h.addOffice();
  const writer = await TestClient.connect(h.socketPath);
  expect((await writer.hello()).ok).toBe(true);
  for (let i = 0; i < COMMANDS; i++) {
    expect(await writer.command("fixture.bulk", {}, { office })).toMatchObject({ ok: true });
  }
  await writer.close();
  const stream = `office:${office}`;
  const epoch = h.state.connection.get<{ epoch: string }>(
    "select epoch from offices where office_id = $office",
    { office },
  )?.epoch;
  if (epoch === undefined) throw new Error("no office row");
  return { office, start: { stream, epoch, seq: 0 } as Cursor };
}

function subscribeFrames(from: Cursor): unknown[] {
  return [
    {
      kind: "read",
      requestId: requestId(),
      name: "engine.hello",
      args: { contract: CONTRACT_VERSION, client: { name: "slow", version: "0" } },
    },
    { kind: "subscribe", requestId: requestId(), stream: from.stream, after: from },
  ];
}

/** A fresh client that subscribes from `from` and must receive every entry, in order. */
async function resumeAll(h: Harness, from: Cursor): Promise<void> {
  const client = await TestClient.connect(h.socketPath);
  try {
    expect((await client.hello()).ok).toBe(true);
    expect((await client.subscribe(from.stream, from)).ok).toBe(true);
    await client.waitForEvent(from.stream, (e) => e.type === "stream.mark", "catch-up mark");
    const seqs = client
      .events(from.stream)
      .filter((e) => e.type === "scan.finished")
      .map((e) => e.cursor.seq);
    expect(seqs).toEqual(Array.from({ length: TOTAL }, (_, i) => i + 1));
    expect(client.invalid).toEqual([]);
  } finally {
    await client.close();
  }
}

describe("slow clients", () => {
  it(
    "pause their office catch-up while unsent data piles up, without holding up a fast client",
    async () => {
      const h = await start();
      const { start: from } = await fill(h);
      raw = await slowClient(h.socketPath, subscribeFrames(from));
      await until(() => rendered > 0, "the slow client's catch-up to start");
      await Bun.sleep(200);
      const forSlow = rendered;
      // The pump stopped near the high-water mark: far from the whole log.
      expect(forSlow).toBeLessThan(TOTAL / 2);
      expect(h.server.connections).toBe(1);

      await resumeAll(h, from);
      // The slow client is still connected, still paused.
      await until(() => h.server.connections === 1, "the fast client to be gone");
      expect(rendered - forSlow).toBe(TOTAL);
    },
    TIMEOUT_MS,
  );

  it(
    "are closed past the backpressure limit, stop costing reads, and resume from their cursor",
    async () => {
      // A limit below one page frame (100 entries of 16 KiB), so the slow client passes it.
      const h = await start({ backpressureLimitBytes: 256 * 1024 });
      const { start: from } = await fill(h);
      raw = await slowClient(h.socketPath, subscribeFrames(from));
      await until(() => h.server.connections === 0, "the slow client to be closed");
      const closedAfter = rendered;
      await Bun.sleep(100);
      // Nothing more was read or rendered for the closed connection.
      expect(rendered).toBe(closedAfter);
      expect(closedAfter).toBeLessThan(TOTAL);

      // A new connection to a daemon with the normal limit resumes from the same cursor: the
      // change log and its epoch are in the state database.
      raw.destroy();
      raw = null;
      await h.close();
      harness = null;
      const again = await start();
      await resumeAll(again, from);
    },
    TIMEOUT_MS,
  );
});
