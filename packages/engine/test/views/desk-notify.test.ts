// The desk notification (DIPO-357): one notification per item an office's desk gains, through a
// fake platform, never a real one. The first read of an office shows nothing; a repeated read
// shows nothing new; a failed post is logged and the rest still post.

import { describe, expect, it } from "bun:test";

import { type DeskItem, OfficeId, StoryId } from "@dipsaus-orchestrator/contract";

import { createLogger } from "../../src/log/logger";
import type { NotificationText } from "../../src/platform/notify";
import { DeskNotifier, deskItemKey, deskNotice } from "../../src/views/desk-notify";
import { systemClock } from "../../src/platform/clock";

const OFFICE = OfficeId.parse("off_01HZZZZZZZZZZZZZZZZZZZZZZZ");

function item(kind: string, story: string | undefined, detail = "waits"): DeskItem {
  return {
    kind,
    ...(story === undefined ? {} : { story: StoryId.parse(story) }),
    detail,
    since: "2026-10-30T10:00:00.000Z",
    blocks: [],
    actions: [],
  };
}

/** A notifier with a fake platform that records every post, and the lines the logger wrote. */
function fixture(options: { failFirst?: boolean } = {}) {
  const posted: NotificationText[] = [];
  const lines: string[] = [];
  let calls = 0;
  const logger = createLogger({
    clock: systemClock,
    sinks: [(line) => lines.push(line)],
    level: "info",
    component: "test",
  });
  const notifier = new DeskNotifier({
    post: async (notice) => {
      calls += 1;
      if (options.failFirst === true && calls === 1) throw new Error("osascript failed");
      posted.push(notice);
    },
    logger,
  });
  return { notifier, posted, lines };
}

describe("DeskNotifier", () => {
  it("posts each new desk item once and a repeated read posts nothing", async () => {
    const { notifier, posted } = fixture();
    const first = item("QUESTION", "DIPO-1");
    const second = item("MERGE", "DIPO-2");
    const third = item("PARKED", "DIPO-3");

    // The first read of an office shows what was already on its desk.
    await notifier.observe(OFFICE, "Acme", [first]);
    expect(posted).toEqual([]);

    await notifier.observe(OFFICE, "Acme", [first, second]);
    expect(posted).toEqual([deskNotice("Acme", second)]);

    await notifier.observe(OFFICE, "Acme", [first, second]);
    expect(posted.length).toBe(1);

    await notifier.observe(OFFICE, "Acme", [first, second, third]);
    expect(posted).toEqual([deskNotice("Acme", second), deskNotice("Acme", third)]);
  });

  it("names the office, the story and the kind of wait", () => {
    expect(deskNotice("Acme", item("MERGE", "DIPO-2", "gate open"))).toEqual({
      title: "dipo: Acme",
      body: "DIPO-2 · MERGE: gate open",
    });
    expect(deskNotice("Acme", item("PROPOSAL", undefined)).body).toBe("office · PROPOSAL: waits");
  });

  it("does not show an item again when only its detail or time changed", async () => {
    const { notifier, posted } = fixture();
    await notifier.observe(OFFICE, "Acme", [item("QUESTION", "DIPO-1", "time left 10 s")]);
    await notifier.observe(OFFICE, "Acme", [
      item("QUESTION", "DIPO-1", "time left 9 s"),
      item("MERGE", "DIPO-2"),
    ]);
    expect(posted.map((notice) => notice.body)).toEqual(["DIPO-2 · MERGE: waits"]);
    expect(deskItemKey(item("QUESTION", "DIPO-1", "a"))).toBe(
      deskItemKey(item("QUESTION", "DIPO-1", "b")),
    );
  });

  it("logs a failed post and still posts the rest", async () => {
    const { notifier, posted, lines } = fixture({ failFirst: true });
    await notifier.observe(OFFICE, "Acme", []);
    await notifier.observe(OFFICE, "Acme", [item("MERGE", "DIPO-2"), item("PARKED", "DIPO-3")]);
    expect(posted.map((notice) => notice.body)).toEqual(["DIPO-3 · PARKED: waits"]);
    expect(lines.some((line) => line.includes("desk notification failed"))).toBe(true);
    expect(lines.some((line) => line.includes("osascript failed"))).toBe(true);
  });
});
