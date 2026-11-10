// The planning lane's work in progress (DIPO-481, 0010): `office.snapshot` lists each open journal
// entry in words and the open backlog PR with the CI the auto-merge round read through the code
// host port, and a `lane.progress` event says each change, with the lane and the round of
// `helpers.ts` as the fixture.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { type OfficeSnapshot, RequestId } from "@dipsaus-orchestrator/contract";

import { progressEntries } from "../../src/backlog/lane/progress";
import { appendEntries } from "../../src/changelog/log";
import { insertEntry, openEntries, updateEntry } from "../../src/backlog/lane/journal";
import type { OfficeHandle } from "../../src/db/office";
import { engineRegistry } from "../../src/features";
import { executeRead } from "../../src/reads/execute";
import {
  PENDING,
  RED,
  GREEN,
  BRANCH,
  type BacklogSetup,
  backlogSetup,
  openBacklogPr,
} from "./helpers";

const TMP = process.env.DIPO_TMP ?? "/tmp";
let dir: string;
let s: BacklogSetup;

beforeEach(async () => {
  dir = await mkdtemp(join(TMP, "merge-progress-"));
  s = await backlogSetup(dir);
});

afterEach(async () => {
  s.t.state.close();
  await rm(dir, { recursive: true, force: true });
});

/** `office.snapshot` through the engine's own registry, as a client reads it. */
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

/** The `lane.progress` events, oldest first. */
function progressEvents(office: OfficeHandle): { lane: OfficeSnapshot["lane"] }[] {
  return office
    .all<{ delta: string }>(
      "select delta from change_log where office_id = $office_id and type = 'lane.progress' order by seq",
    )
    .map((row) => JSON.parse(row.delta) as { lane: OfficeSnapshot["lane"] });
}

/** Appends the progress entry a change of the journal leaves, as the lane does. */
function publish(): void {
  s.office.immediate(() =>
    appendEntries(s.office, progressEntries(s.office), { at: s.t.clock.now() }),
  );
}

/** An accepted idea and a confirmed story, journaled as the planning commands leave them. */
function journalAcceptAndConfirm(): number[] {
  const now = s.t.clock.now();
  const ids = s.office.immediate(() => [
    insertEntry(
      s.office,
      { kind: "propose", subject: "an idea", target: { idea: "4f2a9c1e" } },
      now,
    ).opId,
    insertEntry(
      s.office,
      { kind: "file", key: s.keys.two, subject: "TASK-2", target: { title: "Export as XML" } },
      now,
    ).opId,
  ]);
  publish();
  return ids;
}

describe("office.snapshot: the lane's progress", () => {
  it("lists an accept and a confirm in words with their state and since, and the backlog PR with its CI and auto-merge", async () => {
    await openBacklogPr(s);
    journalAcceptAndConfirm();
    s.host.checks = PENDING;
    // The first round reads the PR; the second sees the auto-merge it turned on.
    await s.merge.tick(s.officeId);
    await s.merge.tick(s.officeId);
    const { lane } = await snapshot();
    expect(lane?.ops.map((op) => [op.what, op.subject, op.state])).toEqual([
      ["a story edited", "TASK-1", "pr"],
      ["an accepted idea filed as a draft", "an idea", "queued"],
      ["a confirmed story filed", "TASK-2", "queued"],
    ]);
    for (const op of lane?.ops ?? []) expect(Number.isNaN(Date.parse(op.since))).toBe(false);
    expect(lane?.pr).toEqual({
      number: 1,
      url: "https://github.com/o/r/pull/1",
      ci: "running",
      autoMerge: true,
      merged: false,
    });
    // The event says the same as the snapshot, and a round that changes nothing sends none.
    expect(progressEvents(s.office).at(-1)?.lane).toEqual(lane);
    const sent = progressEvents(s.office).length;
    await s.merge.tick(s.officeId);
    expect(progressEvents(s.office)).toHaveLength(sent);
  });

  it("is empty after the PR merges, and an event said so", async () => {
    await openBacklogPr(s);
    const [idea, story] = journalAcceptAndConfirm();
    // Both changes are on the PR's branch, as a flush leaves them.
    s.office.immediate(() => {
      updateEntry(
        s.office,
        idea!,
        { state: "pushed", branch: BRANCH, commit: "a".repeat(40) },
        s.t.clock.now(),
      );
      updateEntry(
        s.office,
        story!,
        { state: "pushed", branch: BRANCH, commit: "b".repeat(40) },
        s.t.clock.now(),
      );
    });
    publish();
    s.host.checks = GREEN;
    await s.merge.tick(s.officeId);
    await s.merge.tick(s.officeId);
    expect((await snapshot()).lane?.ops).toHaveLength(3);
    s.host.githubMerges(1);
    await s.merge.tick(s.officeId);
    expect(openEntries(s.office)).toEqual([]);
    const after = await snapshot();
    expect(after.lane).toBeUndefined();
    expect(progressEvents(s.office).at(-1)?.lane).toEqual({ ops: [] });
  });
});

describe("the lane's progress is built from the journal and the records", () => {
  it("takes the PR's CI from the code host port's required checks, in the round's one read", async () => {
    await openBacklogPr(s);
    let reads = 0;
    const read = s.host.requiredChecks.bind(s.host);
    s.host.requiredChecks = async () => {
      reads += 1;
      return read();
    };
    const ciAfter = async (checks: typeof GREEN) => {
      s.host.checks = checks;
      await s.merge.tick(s.officeId);
      return (await snapshot()).lane?.pr?.ci;
    };
    expect(await ciAfter(PENDING)).toBe("running");
    expect(await ciAfter(RED)).toBe("failed");
    expect(await ciAfter(GREEN)).toBe("passed");
    // One read of the required checks for each round: the lane adds no poll of its own.
    expect(reads).toBe(3);
  });

  it("adds no table of its own to the state database", () => {
    const tables = s.t.state.connection
      .all<{ name: string }>("select name from sqlite_master where type = 'table'")
      .map((row) => row.name);
    expect(tables.filter((name) => /lane|progress/.test(name))).toEqual([]);
  });
});
