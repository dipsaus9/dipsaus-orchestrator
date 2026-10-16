// The output feed behind a detail pane (DIPO-55): the tail from `work.outputRange`, live ranges
// appended by byte offset (overlaps cut, gaps read), the tail kept while following, earlier text
// read in whole lines, and the clean-up of stored lines.

import { describe, expect, it } from "bun:test";

import type { OutputMarker } from "@dipsaus-orchestrator/contract";

import {
  byteLength,
  cleanLine,
  displayLine,
  type FeedChange,
  heldLines,
  isMarker,
  lastLine,
  markerRule,
  OutputFeed,
  type RangeOutcome,
  rowCount,
  splitLines,
  visibleRows,
  wrapLines,
} from "./output";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A store of output answering ranges by byte offset, at most `max` bytes per read. */
function stored(initial: string, max = 1024 * 1024) {
  let bytes = encoder.encode(initial);
  const reads: { from: number; to?: number }[] = [];
  return {
    reads,
    append(text: string) {
      const more = encoder.encode(text);
      const next = new Uint8Array(bytes.length + more.length);
      next.set(bytes);
      next.set(more, bytes.length);
      const range = { from: bytes.length, to: next.length, text };
      bytes = next;
      return range;
    },
    read: async (from: number, to?: number): Promise<RangeOutcome> => {
      reads.push(to === undefined ? { from } : { from, to });
      const start = Math.min(from, bytes.length);
      const end = Math.min(to ?? bytes.length, bytes.length, start + max);
      return {
        ok: true,
        result: { from: start, to: end, text: decoder.decode(bytes.subarray(start, end)) },
      };
    },
  };
}

function feedOf(store: ReturnType<typeof stored>, tail: number) {
  const changes: FeedChange[] = [];
  const feed = new OutputFeed(store.read, tail, (change) => changes.push(change));
  return { feed, changes };
}

const lines = (n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => `line ${String(from + i).padStart(2, "0")}\n`).join("");

describe("OutputFeed", () => {
  it("loads to the end in reads of the engine's cap and keeps whole lines of the tail", async () => {
    const store = stored(lines(20), 40);
    const { feed, changes } = feedOf(store, 30);
    await feed.load();
    // 20 lines of 8 bytes in reads of 40 bytes, then one empty read.
    expect(store.reads.map((read) => read.from)).toEqual([0, 40, 80, 120, 160]);
    expect(feed.lines).toEqual(["line 18", "line 19", "line 20"]);
    expect(feed.start).toBe(136);
    expect(feed.end).toBe(160);
    expect(feed.atStart).toBe(false);
    expect(changes).toEqual(["reset"]);
  });

  it("appends live ranges by byte offset, cutting what it holds already", async () => {
    const store = stored("héllo\n");
    const { feed } = feedOf(store, 1024);
    await feed.load();
    expect(feed.end).toBe(byteLength("héllo\n"));
    const range = store.append("wörld\n");
    feed.push(range);
    // The same range again, and one that overlaps by the multi-byte é line: only new text lands.
    feed.push(range);
    feed.push({ from: 0, to: range.to, text: "héllo\nwörld\n" });
    expect(feed.lines).toEqual(["héllo", "wörld"]);
    const partial = store.append("ab");
    feed.push(partial);
    feed.push(store.append("c\n"));
    expect(feed.lines).toEqual(["héllo", "wörld", "abc"]);
  });

  it("queues ranges that arrive while loading, and reads a gap after a missed range", async () => {
    const store = stored(lines(2));
    const { feed } = feedOf(store, 1024);
    const loading = feed.load();
    const during = store.append(lines(1, 3));
    feed.push(during);
    await loading;
    expect(feed.lines).toEqual(["line 01", "line 02", "line 03"]);

    store.append(lines(1, 4)); // missed: never pushed
    feed.push(store.append(lines(1, 5)));
    for (let i = 0; i < 10 && feed.busy; i++) await Bun.sleep(1);
    expect(feed.lines).toEqual(["line 01", "line 02", "line 03", "line 04", "line 05"]);
    expect(store.reads.at(-2)).toEqual({ from: 24 });
  });

  it("keeps about the tail while following and everything read while scrolled back", async () => {
    const store = stored(lines(4));
    const { feed } = feedOf(store, 16);
    await feed.load();
    expect(feed.lines).toEqual(["line 03", "line 04"]);
    feed.setFollowing(false);
    for (let n = 5; n <= 10; n++) feed.push(store.append(lines(1, n)));
    expect(feed.lines).toHaveLength(8);
    feed.setFollowing(true);
    expect(feed.lines).toEqual(["line 09", "line 10"]);
  });

  it("reads earlier text one step back and keeps only whole lines of it", async () => {
    const store = stored(lines(10));
    const { feed, changes } = feedOf(store, 20);
    await feed.load();
    expect(feed.lines).toEqual(["line 09", "line 10"]);
    expect(feed.start).toBe(64);
    await feed.loadEarlier();
    // [44, 64) starts inside line 06; that line comes with the next step.
    expect(store.reads.at(-1)).toEqual({ from: 44, to: 64 });
    expect(feed.lines).toEqual(["line 07", "line 08", "line 09", "line 10"]);
    expect(feed.start).toBe(48);
    await feed.loadEarlier();
    await feed.loadEarlier();
    await feed.loadEarlier();
    expect(feed.atStart).toBe(true);
    expect(feed.lines[0]).toBe("line 01");
    expect(feed.lines).toHaveLength(10);
    const reads = store.reads.length;
    await feed.loadEarlier();
    expect(store.reads).toHaveLength(reads);
    expect(changes.filter((change) => change === "prepend")).toHaveLength(4);
  });

  it("keeps a failed read as its error", async () => {
    const feed = new OutputFeed(
      async () => ({
        ok: false,
        error: { code: "office.unknown", message: "no such office", retryable: false },
      }),
      100,
      () => undefined,
    );
    await feed.load();
    expect(feed.loaded).toBe(true);
    expect(feed.error).toBe("office.unknown: no such office");
  });
});

describe("output lines", () => {
  it("strips escapes and control characters, keeps the last carriage-return frame", () => {
    expect(cleanLine("\u001b[31mFAIL\u001b[0m\ta")).toBe("FAIL  a");
    expect(cleanLine("10%\r50%\r100%")).toBe("100%");
    expect(cleanLine("bell\u0007")).toBe("bell");
  });

  it("splits on newlines without an empty last line, and wraps to the width", () => {
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a\n\nb\n")).toEqual(["a", "", "b"]);
    expect(splitLines("a\nb")).toEqual(["a", "b"]);
    expect(wrapLines(["abcdefg", "", "hi"], 3)).toEqual(["abc", "def", "g", "", "hi"]);
  });

  it("cuts only the lines that reach the screen into rows", () => {
    const held = ["one", "abcdefg", "", "two", "three"];
    expect(rowCount(held, 3)).toBe(8);
    // Rows: one | abc def g | (empty) | two | thr ee.
    expect(visibleRows(held, 3, 3, 0)).toEqual(["two", "thr", "ee"]);
    expect(visibleRows(held, 3, 3, 3)).toEqual(["def", "g", ""]);
    expect(visibleRows(held, 3, 3, 5)).toEqual(["one", "abc", "def"]);
    expect(visibleRows(held, 3, 3, 9)).toEqual([]);
  });

  it("finds the newest non-empty line", () => {
    expect(lastLine(["[tool] Read a.ts", "  ", ""])).toBe("[tool] Read a.ts");
    expect(lastLine([])).toBeNull();
  });
});

describe("engine markers, flagged (DIPO-83, DIPO-95)", () => {
  const iso = "2026-10-15T12:04:31.000Z";
  const local = new Date(Date.parse(iso));
  const hms = [local.getHours(), local.getMinutes(), local.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
  const phaseText = `[dipo] ${iso} phase verify\n`;
  const phase = (from: number): OutputMarker => ({
    from,
    to: from + byteLength(phaseText),
    kind: "phase",
    value: "verify",
    at: iso,
  });
  const ended: OutputMarker = { ...phase(0), kind: "ended", value: "in-review" };

  it("read as a rule with the local time, `--` in ASCII mode", () => {
    expect(markerRule(phase(0))).toBe(`── ${hms} phase: verify ──`);
    expect(markerRule(phase(0), true)).toBe(`-- ${hms} phase: verify --`);
    expect(markerRule(ended)).toBe(`── ${hms} run ended: in-review ──`);
    expect(markerRule({ ...ended, kind: "paused", value: "by you" })).toBe(
      `── ${hms} paused: by you ──`,
    );
    expect(displayLine(phase(0))).toBe(`── ${hms} phase: verify ──`);
    expect(isMarker(phase(0))).toBe(true);
  });

  it("a worker line that reads like a marker stays plain text", () => {
    const forged = phaseText.trimEnd();
    expect(displayLine(forged)).toBe(forged);
    expect(isMarker(forged)).toBe(false);
    expect(heldLines(`${forged}\n`, 0, [])).toEqual([forged]);
    expect(lastLine([forged])).toBe(forged);
  });

  it("turn flagged ranges into marker lines; a marker inside a line ends that line", () => {
    const text = `working\n${phaseText}half${phaseText}done\n`;
    const first = phase(byteLength("working\n"));
    const second = phase(byteLength(`working\n${phaseText}half`));
    // Flags arrive in any order and may reach outside the held text.
    expect(heldLines(text, 0, [second, first, phase(5000)])).toEqual([
      "working",
      first,
      "half",
      second,
      "done",
    ]);
    // Held from byte 8 on: the same lines without the first.
    expect(heldLines(text.slice(8), 8, [first, second])).toEqual([first, "half", second, "done"]);
  });

  it("take their shown width in rows and on screen, and never become the newest line", () => {
    const held = ["[tool] Read a.ts", phase(0), "done"];
    expect(visibleRows(held, 80, 3, 0, true)).toEqual([
      "[tool] Read a.ts",
      `-- ${hms} phase: verify --`,
      "done",
    ]);
    // The raw marker is 44 characters; shown it is 28, one row at 30 columns.
    expect(rowCount([phase(0)], 30)).toBe(1);
    expect(lastLine(["working", phase(0)])).toBe("working");
    expect(lastLine([phase(0)])).toBeNull();
  });

  it("the feed draws markers from the flags of reads and live ranges, and only from them", async () => {
    // Stored: worker text, a flagged marker, and a worker line forging one.
    const head = `building\n${phaseText}`;
    const store = stored(`${head}${phaseText}`);
    const real = phase(byteLength("building\n"));
    const flagged = (outcome: RangeOutcome): RangeOutcome =>
      outcome.ok
        ? {
            ok: true,
            result: {
              ...outcome.result,
              markers: [real].filter(
                (m) => m.from < outcome.result.to && m.to > outcome.result.from,
              ),
            },
          }
        : outcome;
    const feed = new OutputFeed(
      async (from, to) => flagged(await store.read(from, to)),
      1024,
      () => {},
    );
    await feed.load();
    const forged = phaseText.trimEnd();
    expect(feed.lines).toEqual(["building", real, forged]);

    // Live: a range flagged by the engine is a marker; an unflagged lookalike is text.
    const marker = store.append(phaseText);
    feed.push({ ...marker, markers: [phase(marker.from)] });
    feed.push(store.append(phaseText));
    expect(feed.lines).toEqual(["building", real, forged, phase(marker.from), forged]);
    expect(lastLine(feed.lines)).toBe(forged);
  });

  it("drops the flags of text it no longer holds", async () => {
    const store = stored("");
    const feed = new OutputFeed(store.read, 40, () => {});
    await feed.load();
    const marker = store.append(phaseText);
    feed.push({ ...marker, markers: [phase(marker.from)] });
    feed.push(store.append(lines(10)));
    expect(feed.lines.some((line) => isMarker(line))).toBe(false);
    expect(feed.lines.at(-1)).toBe("line 10");
  });
});
