// What the office lists as busy outside story runs (DIPO-527): the story PRs, the backlog PR, the
// daemon's update, the order and the ten minutes a done item stays, with the lane's fixture.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  type BackgroundItem,
  type OfficeSnapshot,
  type RunId,
  type StoryKey,
  RequestId,
} from "@dipsaus-orchestrator/contract";

import {
  backgroundEntries,
  backgroundItems,
  finishStoryPr,
  listedBackground,
  rememberStoryPr,
  trackUpdate,
} from "../../src/run/background";
import { insertEntry } from "../../src/backlog/lane/journal";
import { progressEntriesWithBackground } from "../../src/backlog/lane/progress";
import { appendEntries } from "../../src/changelog/log";
import { CommandError } from "../../src/commands/errors";
import { engineRegistry } from "../../src/features";
import { storeProposals } from "../../src/run/report-data";
import { executeRead } from "../../src/reads/execute";
import { PENDING, type BacklogSetup, backlogSetup, openBacklogPr } from "../merge/helpers";

const TMP = process.env.DIPO_TMP ?? "/tmp";
let dir: string;
let s: BacklogSetup;

beforeEach(async () => {
  dir = await mkdtemp(join(TMP, "background-"));
  s = await backlogSetup(dir);
});

afterEach(async () => {
  s.t.state.close();
  await rm(dir, { recursive: true, force: true });
});

async function snapshot(): Promise<OfficeSnapshot> {
  const reply = await executeRead(
    {
      registry: engineRegistry(),
      offices: {
        get: (id) => (id === s.officeId ? s.office : undefined),
        load: async () => ({ ok: true, office: s.office }),
      },
      clock: s.t.clock,
    },
    {
      requestId: RequestId.parse("01J9ZK5Q8W3V4X6Y7Z00000001"),
      name: "office.snapshot",
      args: { office: s.officeId },
    },
  );
  if (!reply.ok) throw new Error(`office.snapshot failed: ${reply.error.message}`);
  return reply.result as OfficeSnapshot;
}

function events(): { item: BackgroundItem; line: string }[] {
  return s.office
    .all<{ delta: string }>(
      "select delta from change_log where office_id = $office_id and type = 'background.changed' order by seq",
    )
    .map((row) => JSON.parse(row.delta) as { item: BackgroundItem; line: string });
}

const item = (
  state: BackgroundItem["state"],
  ref: string,
  since = "2026-11-28T10:00:00.000Z",
): BackgroundItem => ({ kind: "story-pr", ref, subject: ref, state, since });

describe("office.snapshot: the background", () => {
  it("lists a story PR whose CI failed with attempts left as failed, with the retry time dipo scheduled", async () => {
    const now = s.t.clock.now();
    const retryAt = new Date(2026, 10, 28, 14, 20).getTime(); // 14:20 in the machine's time
    rememberStoryPr(s.office, {
      key: "TASK-1",
      number: 698,
      url: "https://github.com/o/r/pull/698",
      ci: "failed",
      failedCheck: "test (bun 1.4)",
      attempt: 2,
      of: 3,
      retryAt,
      since: now,
    });
    s.office.immediate(() => backgroundEntries(s.office, now));
    const [pr] = (await snapshot()).background ?? [];
    expect(pr).toEqual({
      kind: "story-pr",
      ref: "PR #698",
      subject: "TASK-1 · CI failed: test (bun 1.4) · attempt 2 of 3",
      state: "failed",
      ci: "failed",
      next: "retries at 14:20; after attempt 3 it goes to your Desk",
      since: new Date(now).toISOString(),
      url: "https://github.com/o/r/pull/698",
    });
    // Nothing in next is an estimate: a scheduled time or a plain fact.
    expect(pr?.next).not.toMatch(/about|around|~|\bin \d+ ?m|soon/);
  });

  it("lists the lane's backlog PR with its CI and auto-merge, and sends the change once", async () => {
    await openBacklogPr(s);
    s.office.immediate(() => {
      insertEntry(
        s.office,
        { kind: "file", key: s.keys.two, subject: "TASK-2", target: { title: "Export as XML" } },
        s.t.clock.now(),
      );
      appendEntries(s.office, progressEntriesWithBackground(s.office, s.t.clock.now()), {
        at: s.t.clock.now(),
      });
    });
    s.host.checks = PENDING;
    await s.merge.tick(s.officeId);
    await s.merge.tick(s.officeId);
    const backlog = (await snapshot()).background?.find((one) => one.kind === "backlog-pr");
    expect(backlog).toMatchObject({
      kind: "backlog-pr",
      state: "running",
      ci: "running",
      next: "auto-merges when green",
      url: "https://github.com/o/r/pull/1",
    });
    expect(backlog?.subject).toContain("CI running");
    const sent = events().filter((event) => event.item.kind === "backlog-pr");
    expect(sent.at(-1)?.line).toContain("CI running");
    const again = s.office.immediate(() =>
      progressEntriesWithBackground(s.office, s.t.clock.now()),
    );
    expect(again.filter((entry) => entry.type === "background.changed")).toEqual([]);
  });

  it("lists a refused dipo update under the daemon with its reason", async () => {
    const refusal = new CommandError(
      "update.refused",
      "dipo does not update: not while anything runs: 1 story run.",
      { reason: "busy" },
    );
    await expect(
      trackUpdate(
        s.office,
        () => s.t.clock.now(),
        async () => {
          throw refusal;
        },
      ),
    ).rejects.toBe(refusal);
    const daemon = (await snapshot()).background?.find((one) => one.kind === "daemon");
    expect(daemon).toMatchObject({
      ref: "update",
      subject: "dipo update refused: busy",
      state: "waiting",
      next: refusal.message,
    });
    expect(events().at(-1)?.item.subject).toBe("dipo update refused: busy");
  });

  it("turns a merged story PR into a done item, sent once, and forgets a closed one", () => {
    const at = s.t.clock.now();
    const pr = { key: "TASK-1", number: 7, url: "https://github.com/o/r/pull/7" };
    rememberStoryPr(s.office, { ...pr, ci: "passed", since: at });
    finishStoryPr(s.office, pr, "merged", at + 1000);
    const sent = s.office.immediate(() => backgroundEntries(s.office, at + 1000));
    expect(sent.map((one) => (one.delta as { item: { state: string } }).item.state)).toEqual([
      "done",
    ]);
    expect(backgroundItems(s.office, at + 1000 + 10 * 60_000, null)).toEqual([]);
    finishStoryPr(s.office, { ...pr, number: 8 }, "closed", at);
    expect(backgroundItems(s.office, at, null).some((one) => one.ref === "PR #8")).toBe(false);
  });

  it("sends background.changed when a worker's proposal is held as an idea", () => {
    const at = s.t.clock.now();
    s.office.immediate(() =>
      storeProposals(s.office, {
        key: "TASK-1" as StoryKey,
        runId: "run_1" as RunId,
        proposals: [
          { kind: "follow-up", title: "Export", story: "As a user I want export", why: "none" },
        ],
        at,
      }),
    );
    const sent = events().filter((one) => one.item.kind === "audit");
    expect(sent.map((one) => one.line)).toEqual(["audit 1 idea held (waiting)"]);
  });

  it("drops a done item after 10 minutes and orders failed, needs-you, running, waiting, done", async () => {
    const at = s.t.clock.now();
    rememberStoryPr(s.office, {
      key: "TASK-1",
      number: 5,
      url: "https://github.com/o/r/pull/5",
      ci: "passed",
      merged: true,
      since: at,
    });
    expect(backgroundItems(s.office, at + 10 * 60_000 - 1, null).map((one) => one.state)).toEqual([
      "done",
    ]);
    expect(backgroundItems(s.office, at + 10 * 60_000, null)).toEqual([]);
    const listed = listedBackground(
      [
        item("done", "a"),
        item("waiting", "b"),
        item("running", "c"),
        item("needs-you", "d"),
        item("failed", "e"),
      ],
      Date.parse("2026-11-28T10:05:00.000Z"),
    );
    expect(listed.map((one) => one.state)).toEqual([
      "failed",
      "needs-you",
      "running",
      "waiting",
      "done",
    ]);
  });
});
