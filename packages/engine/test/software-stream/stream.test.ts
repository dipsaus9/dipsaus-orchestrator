// The software stream ring buffer (0005): seqs that start at the daemon's start time, the last
// 1000 entries kept, and `stream.resetRequired { oldest }` for a cursor it cannot replay, which a
// cursor of an earlier daemon always is.

import { describe, expect, it } from "bun:test";

import { type Cursor, StreamName } from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import { SOFTWARE_STREAM_CAPACITY, SoftwareStream } from "../../src/software-stream/stream";

const software = StreamName.parse("software");
const state = (from: string, to: string) => ({ from, to, reason: "test" });

const START = 1_000;

/** The cursor `n` entries after the stream's start. */
function cursor(n: number): Cursor {
  return { stream: software, seq: START + n };
}

describe("SoftwareStream", () => {
  it("numbers entries from its start time and replays every entry after a cursor", () => {
    const clock = new ManualClock(START);
    const stream = new SoftwareStream({ clock });
    expect(stream.head()).toEqual(cursor(0));
    stream.append("daemon.state", state("starting", "recovering"));
    clock.advance(10);
    const second = stream.append("daemon.state", state("recovering", "running"));
    expect(second).toEqual({
      cursor: cursor(2),
      at: new Date(clock.now()).toISOString(),
      type: "daemon.state",
      data: state("recovering", "running"),
    });
    const replay = stream.since(cursor(0));
    if (!replay.ok) throw new Error(replay.error.message);
    expect(replay.events.map((event) => event.cursor.seq)).toEqual([START + 1, START + 2]);
    expect(replay.head).toEqual(cursor(2));
    const tail = stream.since(cursor(2));
    expect(tail.ok && tail.events).toEqual([]);
  });

  it("keeps the last 1000 entries by default and resets cursors older than the oldest", () => {
    const stream = new SoftwareStream({ clock: new ManualClock(START) });
    for (let i = 0; i < SOFTWARE_STREAM_CAPACITY + 5; i++) {
      stream.append("engine.notice", { level: "info", code: "test", text: String(i) });
    }
    expect(stream.oldest()).toEqual(cursor(5));
    const old = stream.since(cursor(4));
    if (old.ok) throw new Error("expected a reset");
    expect(old.error).toMatchObject({
      code: "stream.resetRequired",
      retryable: false,
      details: { oldest: cursor(5) },
    });
    const fromOldest = stream.since(cursor(5));
    expect(fromOldest.ok && fromOldest.events.length).toBe(SOFTWARE_STREAM_CAPACITY);
  });

  it("resets a cursor of an earlier daemon, of another stream or past the head", () => {
    const clock = new ManualClock(START);
    const earlier = new SoftwareStream({ clock });
    earlier.append("daemon.state", state("starting", "recovering"));
    earlier.append("daemon.state", state("recovering", "running"));
    const seen = earlier.head();
    // A restart a second later: the earlier daemon's cursors are all older than the new start.
    clock.advance(1_000);
    const stream = new SoftwareStream({ clock });
    stream.append("daemon.state", state("starting", "recovering"));
    expect(stream.since(seen).ok).toBe(false);
    expect(stream.since(earlier.oldest()).ok).toBe(false);
    expect(stream.since({ ...stream.head(), seq: stream.head().seq + 1 }).ok).toBe(false);
    const office = StreamName.parse("office:off_01J0000000000000000000000A");
    expect(stream.since({ ...stream.oldest(), stream: office }).ok).toBe(false);
    expect(stream.since(stream.oldest()).ok).toBe(true);
  });

  it("tells listeners about each append", () => {
    const stream = new SoftwareStream({ clock: new ManualClock(START) });
    const seen: number[] = [];
    const stop = stream.onAppend((event) => seen.push(event.cursor.seq));
    stream.append("daemon.state", state("starting", "recovering"));
    stop();
    stream.append("daemon.state", state("recovering", "running"));
    expect(seen).toEqual([START + 1]);
  });

  it("refuses derived, office and unknown event types and data that does not match", () => {
    const stream = new SoftwareStream({ clock: new ManualClock(START) });
    expect(() => stream.append("stream.mark", {})).toThrow("derived");
    expect(() => stream.append("office.summary", {})).toThrow("derived");
    expect(() => stream.append("scan.finished", { scripts: {}, warnings: [] })).toThrow(
      "office stream",
    );
    expect(() => stream.append("no.such", {})).toThrow("Unknown event type");
    expect(() => stream.append("daemon.state", { from: "nowhere" })).toThrow("schema");
    expect(stream.head().seq).toBe(START);
  });
});
