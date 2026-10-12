// The software stream ring buffer (0006 decision 9): seqs from 1, the last 1000 entries kept, a
// random epoch per start, and `stream.resetRequired { oldest }` for a cursor it cannot replay.

import { describe, expect, it } from "bun:test";

import { type Cursor, StreamName } from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import { SOFTWARE_STREAM_CAPACITY, SoftwareStream } from "../../src/software-stream/stream";

const software = StreamName.parse("software");
const fixedFill = (bytes: Uint8Array) => {
  bytes.fill(0xab);
};
const state = (from: string, to: string) => ({ from, to, reason: "test" });

function cursor(stream: SoftwareStream, seq: number): Cursor {
  return { stream: software, epoch: stream.epoch, seq };
}

describe("SoftwareStream", () => {
  it("numbers entries from 1 and replays every entry after a cursor", () => {
    const clock = new ManualClock();
    const stream = new SoftwareStream({ clock });
    expect(stream.head()).toEqual(cursor(stream, 0));
    stream.append("daemon.state", state("starting", "recovering"));
    clock.advance(10);
    const second = stream.append("daemon.state", state("recovering", "running"));
    expect(second).toEqual({
      cursor: cursor(stream, 2),
      at: new Date(clock.now()).toISOString(),
      type: "daemon.state",
      data: state("recovering", "running"),
    });
    const replay = stream.since(cursor(stream, 0));
    if (!replay.ok) throw new Error(replay.error.message);
    expect(replay.events.map((event) => event.cursor.seq)).toEqual([1, 2]);
    expect(replay.head).toEqual(cursor(stream, 2));
    const tail = stream.since(cursor(stream, 2));
    expect(tail.ok && tail.events).toEqual([]);
  });

  it("keeps the last 1000 entries by default and resets cursors older than the oldest", () => {
    const stream = new SoftwareStream({ clock: new ManualClock() });
    for (let i = 0; i < SOFTWARE_STREAM_CAPACITY + 5; i++) {
      stream.append("engine.notice", { level: "info", code: "test", text: String(i) });
    }
    expect(stream.oldest()).toEqual(cursor(stream, 5));
    const old = stream.since(cursor(stream, 4));
    if (old.ok) throw new Error("expected a reset");
    expect(old.error).toMatchObject({
      code: "stream.resetRequired",
      retryable: false,
      details: { oldest: cursor(stream, 5) },
    });
    const fromOldest = stream.since(cursor(stream, 5));
    expect(fromOldest.ok && fromOldest.events.length).toBe(SOFTWARE_STREAM_CAPACITY);
  });

  it("resets a cursor of another epoch, another stream or past the head", () => {
    const stream = new SoftwareStream({ clock: new ManualClock() });
    stream.append("daemon.state", state("starting", "recovering"));
    const other = new SoftwareStream({ clock: new ManualClock() });
    expect(other.epoch).not.toBe(stream.epoch);
    expect(stream.since({ ...cursor(stream, 0), epoch: other.epoch }).ok).toBe(false);
    expect(stream.since(cursor(stream, 2)).ok).toBe(false);
    const office = StreamName.parse("office:off_01J0000000000000000000000A");
    expect(stream.since({ ...cursor(stream, 0), stream: office }).ok).toBe(false);
  });

  it("tells listeners about each append", () => {
    const stream = new SoftwareStream({ clock: new ManualClock() });
    const seen: number[] = [];
    const stop = stream.onAppend((event) => seen.push(event.cursor.seq));
    stream.append("daemon.state", state("starting", "recovering"));
    stop();
    stream.append("daemon.state", state("recovering", "running"));
    expect(seen).toEqual([1]);
  });

  it("refuses derived, office and unknown event types and data that does not match", () => {
    const stream = new SoftwareStream({ clock: new ManualClock() });
    expect(() => stream.append("stream.mark", {})).toThrow("derived");
    expect(() => stream.append("office.summary", {})).toThrow("derived");
    expect(() => stream.append("scan.finished", { scripts: {}, warnings: [] })).toThrow(
      "office stream",
    );
    expect(() => stream.append("no.such", {})).toThrow("Unknown event type");
    expect(() => stream.append("daemon.state", { from: "nowhere" })).toThrow("schema");
    expect(stream.head().seq).toBe(0);
  });

  it("uses the injected randomness for its epoch", () => {
    const stream = new SoftwareStream({ clock: new ManualClock(), fill: fixedFill });
    expect(stream.epoch).toBe("ab".repeat(16));
  });
});
