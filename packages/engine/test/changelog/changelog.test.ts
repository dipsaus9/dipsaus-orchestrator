// The office change log (DIPO-22; 0005 sections 6 and 8, 0007 sections 3, 4 and 7): migration,
// gap-free append, replay from a cursor, and rendering into contract events.

import { describe, expect, it } from "bun:test";

import {
  Event,
  findEvent,
  type Lifecycle,
  RequestId,
  StoryKey,
} from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import {
  appendEntries,
  headCursor,
  newEpoch,
  newLogState,
  readLogState,
  tierOf,
} from "../../src/changelog/log";
import {
  Renderer,
  RenderError,
  renderProblem,
  UNRENDERABLE_NOTICE_CODE,
  unrenderableNotice,
} from "../../src/changelog/render";
import { replay } from "../../src/changelog/replay";
import type { OfficeHandle } from "../../src/db/office";
import {
  addOffice,
  countingFill,
  countRows,
  openTestState,
  type TestState,
} from "../commands/helpers";
import { fixtureView } from "../commands/fixtures";

async function withOffice(fn: (t: TestState, office: OfficeHandle) => void | Promise<void>) {
  return withTempDir(async (dir) => {
    const t = await openTestState(dir);
    try {
      await fn(t, addOffice(t));
    } finally {
      t.state.close();
    }
  });
}

const CAUSE = RequestId.parse("01J9ZK5Q8W3V4X6Y7Z8A9B0C1D");

function storyEntry(t: TestState, to: Lifecycle = "Ready") {
  const key = StoryKey.parse(t.ids.next("sto"));
  return {
    type: "story.state",
    key,
    delta: { story: "DIPO-4", key, from: "Refined", to },
    view: fixtureView(key, "DIPO-4", to),
  };
}

const notice = (text: string) => ({
  type: "engine.notice",
  delta: { level: "info", code: "test.notice", text },
});

/**
 * Writes an entry the way a binary from before DIPO-124 could: straight into `change_log`, with
 * no render check, and advances `next_seq` as `appendEntries` does. Returns its seq.
 */
function storeAsOlderBinary(office: OfficeHandle, type: string, delta: unknown): number {
  return office.immediate(() => {
    const seq = readLogState(office).nextSeq;
    office.run(
      `insert into change_log (office_id, seq, at, type, tier, key, run_id, caused_by, delta, view)
       values ($office_id, $seq, 1, $type, $tier, null, null, null, $delta, null)`,
      { seq, type, tier: tierOf(type), delta: JSON.stringify(delta) },
    );
    office.run("update offices set next_seq = $next where office_id = $office_id", {
      next: seq + 1,
    });
    return seq;
  });
}

describe("change log", () => {
  it("adds stories, story_aliases, change_log and requests as STRICT office tables", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const tables = t.state.connection.all<{ name: string; strict: number }>(
          "select name, strict from pragma_table_list where schema = 'main' and name in ('stories', 'story_aliases', 'change_log', 'requests') order by name",
        );
        expect(tables).toEqual([
          { name: "change_log", strict: 1 },
          { name: "requests", strict: 1 },
          { name: "stories", strict: 1 },
          { name: "story_aliases", strict: 1 },
        ]);
        const columns = (table: string) =>
          t.state.connection
            .all<{ name: string }>("select name from pragma_table_info($table)", { table })
            .map((c) => c.name);
        expect(columns("change_log")).toEqual([
          "office_id",
          "seq",
          "at",
          "type",
          "tier",
          "key",
          "run_id",
          "caused_by",
          "delta",
          "view",
        ]);
        expect(columns("requests")).toEqual([
          "office_id",
          "request_id",
          "command",
          "args_hash",
          "reply",
          "at",
        ]);
      } finally {
        t.state.close();
      }
    }));

  it("gives each office a random epoch", () => {
    const a = newEpoch();
    const b = newEpoch();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
    const fill = countingFill();
    expect(newLogState(fill)).toEqual({
      epoch: "000102030405060708090a0b0c0d0e0f",
      nextSeq: 1,
      replayFloorSeq: 0,
    });
  });

  it("appends gap-free and advances next_seq in the same transaction", () =>
    withOffice((t, office) => {
      expect(headCursor(office).seq).toBe(0);
      const first = office.immediate(() =>
        appendEntries(office, [storyEntry(t), notice("a")], { at: 1, causedBy: CAUSE }),
      );
      expect(first?.seq).toBe(2);
      expect(readLogState(office).nextSeq).toBe(3);

      expect(() =>
        office.immediate(() => {
          appendEntries(office, [notice("lost")], { at: 2 });
          throw new Error("rolled back");
        }),
      ).toThrow("rolled back");
      expect(readLogState(office).nextSeq).toBe(3);

      const next = office.immediate(() => appendEntries(office, [notice("b")], { at: 3 }));
      expect(next?.seq).toBe(3);
      expect(
        office.all<{ seq: number }>(
          "select seq from change_log where office_id = $office_id order by seq",
        ),
      ).toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
      expect(office.immediate(() => appendEntries(office, [], { at: 4 }))).toBeUndefined();
    }));

  it("stores each entry with its tier and refuses derived, software and unknown types", () =>
    withOffice((t, office) => {
      expect(tierOf("work.output")).toBe("R");
      expect(tierOf("usage.updated")).toBe("R");
      expect(tierOf("story.state")).toBe("S");
      const append = (type: string) =>
        office.immediate(() => appendEntries(office, [{ type, delta: {} }], { at: 1 }));
      expect(() => append("stream.mark")).toThrow("derived");
      expect(() => append("office.registered")).toThrow("software stream");
      expect(() => append("story.unheardOf")).toThrow("Unknown event type");
      expect(countRows(office, "change_log")).toBe(0);
    }));

  it("replays entries after a cursor in order", () =>
    withOffice((t, office) => {
      office.immediate(() =>
        appendEntries(office, [notice("1"), storyEntry(t), notice("3")], { at: 7 }),
      );
      const head = headCursor(office);
      const all = replay(office, { ...head, seq: 0 });
      expect(all.ok && all.entries.map((e) => e.seq)).toEqual([1, 2, 3]);
      const tail = replay(office, { ...head, seq: 1 });
      expect(tail.ok && tail.entries.map((e) => e.seq)).toEqual([2, 3]);
      const limited = replay(office, { ...head, seq: 0 }, { limit: 2 });
      expect(limited.ok && limited.entries.map((e) => e.seq)).toEqual([1, 2]);
      const none = replay(office, head);
      expect(none.ok && none.entries).toEqual([]);
    }));

  it("asks for a reset when the cursor has another epoch or is below the replay floor", () =>
    withOffice((t, office) => {
      office.immediate(() =>
        appendEntries(office, [notice("1"), notice("2"), notice("3")], { at: 7 }),
      );
      const head = headCursor(office);
      t.state.connection.immediate(() =>
        t.state.connection.run(
          "update offices set replay_floor_seq = 2 where office_id = $office",
          { office: office.officeId },
        ),
      );
      const oldest = { ...head, seq: 2 };
      const expectReset = (after: typeof head) => {
        const result = replay(office, after);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("stream.resetRequired");
        expect(result.error.retryable).toBe(false);
        expect(result.error.details).toEqual({ oldest });
      };
      expectReset({ ...head, epoch: "another-epoch" });
      expectReset({ ...head, seq: 1 });
      expectReset({ ...head, seq: 4 });
      const other = addOffice(t, "other");
      expectReset({ ...headCursor(other), seq: 2 });
      const atFloor = replay(office, oldest);
      expect(atFloor.ok && atFloor.entries.map((e) => e.seq)).toEqual([3]);
    }));

  it("renders stored entries into contract events with the view stored on each entry", () =>
    withOffice((t, office) => {
      const entry = storyEntry(t, "In Progress");
      office.immediate(() =>
        appendEntries(office, [entry, notice("hello")], { at: 1_767_225_600_000, causedBy: CAUSE }),
      );
      const { epoch } = readLogState(office);
      const replayed = replay(office, { ...headCursor(office), seq: 0 });
      if (!replayed.ok) throw new Error(replayed.error.message);
      const events = new Renderer().renderAll(office.officeId, epoch, replayed.entries);

      for (const event of events) {
        expect(Event.parse(event)).toEqual(event);
        expect(findEvent(event.type)?.data.safeParse(event.data).success).toBe(true);
      }
      expect(events[0] as unknown).toEqual({
        cursor: { stream: `office:${office.officeId}`, epoch, seq: 1 },
        at: "2026-01-01T00:00:00.000Z",
        type: "story.state",
        causedBy: CAUSE,
        data: { ...entry.delta, view: entry.view },
      });
      expect(events[1]?.data).toEqual(notice("hello").delta);
    }));

  it("lets a renderer override one type and fails loudly on an entry that does not parse", () =>
    withOffice((t, office) => {
      office.immediate(() => appendEntries(office, [notice("x")], { at: 1 }));
      storeAsOlderBinary(office, "story.state", { story: "DIPO-1" });
      const { epoch } = readLogState(office);
      const replayed = replay(office, { ...headCursor(office), seq: 0 });
      if (!replayed.ok) throw new Error(replayed.error.message);
      const [first, broken] = replayed.entries;
      const renderer = new Renderer({
        "engine.notice": (e) => ({ ...(e.delta as object), text: "rewritten" }),
      });
      expect(renderer.render(office.officeId, epoch, first!).data).toMatchObject({
        text: "rewritten",
      });
      expect(() => renderer.render(office.officeId, epoch, broken!)).toThrow(RenderError);
    }));
});

describe("the write check (DIPO-124)", () => {
  it("fails the writing transaction on a malformed engine.notice: no row, no fact, cursor unchanged", () =>
    withOffice((t, office) => {
      office.immediate(() => appendEntries(office, [notice("before")], { at: 1 }));
      const before = headCursor(office);
      const malformed = { type: "engine.notice", delta: { level: "loud", text: "no code" } };
      expect(() =>
        office.immediate(() => {
          // A fact written earlier in the same transaction rolls back with the entry.
          office.run("update offices set replay_floor_seq = 1 where office_id = $office_id");
          appendEntries(office, [notice("fine"), malformed], { at: 2, causedBy: CAUSE });
        }),
      ).toThrow("A engine.notice change-log entry would not render");
      expect(headCursor(office)).toEqual(before);
      expect(readLogState(office)).toMatchObject({ nextSeq: 2, replayFloorSeq: 0 });
      expect(countRows(office, "change_log")).toBe(1);
    }));

  it("checks the stored JSON, so a field only JSON drops is refused", () =>
    withOffice((t, office) => {
      const dropped = {
        type: "engine.notice",
        delta: { level: "info", code: "test.notice", text: undefined },
      };
      expect(() => office.immediate(() => appendEntries(office, [dropped], { at: 1 }))).toThrow(
        "would not render",
      );
      expect(countRows(office, "change_log")).toBe(0);
    }));

  it("passes a story.state entry with its view and refuses one without it", () =>
    withOffice((t, office) => {
      const entry = storyEntry(t);
      expect(office.immediate(() => appendEntries(office, [entry], { at: 1 }))?.seq).toBe(1);
      const { view: _view, ...withoutView } = entry;
      expect(() => office.immediate(() => appendEntries(office, [withoutView], { at: 2 }))).toThrow(
        "A story.state change-log entry would not render",
      );
      expect(renderProblem(entry)).toBeUndefined();
      expect(renderProblem(withoutView)).toContain("view");
      expect(headCursor(office).seq).toBe(1);
    }));

  it("still replays and renders entries stored before the check", () =>
    withOffice((t, office) => {
      const seq = storeAsOlderBinary(office, "engine.notice", notice("old").delta);
      const { epoch } = readLogState(office);
      const replayed = replay(office, { ...headCursor(office), seq: 0 });
      if (!replayed.ok) throw new Error(replayed.error.message);
      const [event] = new Renderer().renderAll(office.officeId, epoch, replayed.entries);
      expect(event?.cursor.seq).toBe(seq);
      expect(event?.data).toEqual(notice("old").delta);
    }));

  it("sends a stored entry that does not render as an engine.notice at its own cursor", () =>
    withOffice((t, office) => {
      office.immediate(() => appendEntries(office, [notice("1")], { at: 1 }));
      const bad = storeAsOlderBinary(office, "story.state", { story: "DIPO-1" });
      office.immediate(() => appendEntries(office, [notice("3")], { at: 3 }));
      const { epoch } = readLogState(office);
      const replayed = replay(office, { ...headCursor(office), seq: 0 });
      if (!replayed.ok) throw new Error(replayed.error.message);
      const heard: { error: unknown; seq: number }[] = [];
      const events = new Renderer().renderForStream(
        office.officeId,
        epoch,
        replayed.entries,
        (error, entry) => heard.push({ error, seq: entry.seq }),
      );
      expect(events.map((e) => [e.cursor.seq, e.type])).toEqual([
        [1, "engine.notice"],
        [bad, "engine.notice"],
        [3, "engine.notice"],
      ]);
      for (const event of events) expect(Event.parse(event)).toEqual(event);
      expect(events[1]?.data).toMatchObject({ level: "error", code: UNRENDERABLE_NOTICE_CODE });
      expect(events[1]).toEqual(unrenderableNotice(office.officeId, epoch, replayed.entries[1]!));
      expect(heard).toHaveLength(1);
      expect(heard[0]?.seq).toBe(bad);
      expect(heard[0]?.error).toBeInstanceOf(RenderError);
      expect(events[1]?.data).toMatchObject({
        text: expect.stringContaining("missing from the stream"),
      });
    }));

  it("throws an error that is not a RenderError instead of sending a notice", () =>
    withOffice((t, office) => {
      office.immediate(() => appendEntries(office, [notice("1")], { at: 1 }));
      const { epoch } = readLogState(office);
      const replayed = replay(office, { ...headCursor(office), seq: 0 });
      if (!replayed.ok) throw new Error(replayed.error.message);
      const heard: unknown[] = [];
      const renderer = new Renderer({
        "engine.notice": () => {
          throw new Error("the renderer broke");
        },
      });
      expect(() =>
        renderer.renderForStream(office.officeId, epoch, replayed.entries, (error) =>
          heard.push(error),
        ),
      ).toThrow("the renderer broke");
      expect(heard).toEqual([]);
    }));
});
