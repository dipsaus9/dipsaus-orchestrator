// A story's current park is Backlog.md's (DIPO-360; 0001, 0007, 0010): `openPark` takes the reason
// and origin from the story's F16 park record as the index read it (or an open planning-lane
// operation writes it), never from `parks`, which keeps run detail and the reason a park was made
// with as history. A park writes the record on the story branch and its read-back reaches the
// mirror in the park's own transaction; a park never written there is no park.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { NewEntry } from "../../src/changelog/log";
import { appendEntries } from "../../src/changelog/log";
import { insertEntry } from "../../src/backlog/lane/journal";
import { findRun } from "../../src/run";
import {
  backlogPark,
  type BranchPark,
  openPark,
  type ParkDeps,
  type ParkWriter,
  parkStory,
} from "../../src/run/park";
import { recordIntent } from "../../src/run/intents";
import { heldByPark, MAINTAINER_RESUME_TAG, parkedRun } from "../../src/run/park-state";
import { desk, PARK_HELD, PARK_NOT_WRITTEN } from "../../src/views/desk";
import { storyView } from "../../src/views/story";
import { insertPark, mirrorParked, mirrorStory } from "./park-fixture";
import { type RoundsWorld, roundsWorld, type StoryRun, storyRun } from "./rounds-helpers";

let w: RoundsWorld;
let s: StoryRun;

beforeEach(async () => {
  w = await roundsWorld("park-state-");
  s = storyRun(w, { story: "DIPO-7" });
});

afterEach(() => w.close());

function deps(writer: ParkWriter): ParkDeps {
  return {
    office: w.office,
    writer,
    now: () => w.t.clock.now(),
    write: (fn: () => readonly NewEntry[]) =>
      w.office.immediate(() => {
        appendEntries(w.office, fn(), { at: w.t.clock.now() });
      }),
    implemented: () => true,
  };
}

/** A park writer that wrote and read back the park on the branch, from In Review. */
const written: ParkWriter = {
  write: async (): Promise<BranchPark> => ({
    commit: "c".repeat(40),
    lastGoodCommit: "a".repeat(40),
    from: "In Review",
    pushed: true,
    pushError: null,
  }),
};

const failing: ParkWriter = {
  write: async () => {
    throw new Error("the push was refused");
  },
};

function parkRows(): { reason: string; detail: string }[] {
  return w.office.all(
    "select reason, detail from parks where office_id = $office_id order by park_id",
  );
}

describe("a park (DIPO-360)", () => {
  it("writes its reason through the branch write, mirrors the read-back at once, and keeps no origin in parks", async () => {
    const run = findRun(w.office, s.run)!;
    await parkStory(deps(written), {
      run,
      reason: "review-blocked",
      detail: "round 3 blocked",
      endKind: "review-blocked",
    });
    // Backlog.md's record, as the index holds it now: status Parked with reason and origin.
    expect(backlogPark(w.office, s.key)).toEqual({
      reason: "review-blocked",
      from: "In Review",
      note: "round 3 blocked",
    });
    expect(storyView(w.office, s.key)?.lifecycle).toBe("Parked");
    expect(openPark(w.office, s.key)).toMatchObject({
      reason: "review-blocked",
      from: "In Review",
      detail: "round 3 blocked",
      runId: s.run,
    });
    // `parks` is run detail and history: the reason it was made with (no origin column, migration 60).
    expect(parkRows()).toEqual([{ reason: "review-blocked", detail: "round 3 blocked" }]);
  });

  it("is no park when it was never written to Backlog.md: only its run detail row stays", async () => {
    const run = findRun(w.office, s.run)!;
    await parkStory(deps(failing), {
      run,
      reason: "conflict",
      detail: "conflict in a.ts",
      endKind: "conflict",
    });
    expect(parkRows()).toEqual([{ reason: "conflict", detail: "conflict in a.ts" }]);
    expect(backlogPark(w.office, s.key)).toBeNull();
    expect(openPark(w.office, s.key)).toBeNull();
    expect(parkedRun(w.office, s.run)).toBe(false);
    expect(storyView(w.office, s.key)?.lifecycle).toBe("In Review");
  });
});

describe("the current park's reason and origin (DIPO-360)", () => {
  it("come from Backlog.md, never from the reason parks recorded as history", () => {
    w.office.immediate(() => {
      insertPark(w.office, {
        key: s.key,
        story: "DIPO-7",
        runId: s.run,
        reason: "conflict",
        from: "In Progress",
        detail: "conflict in a.ts",
        at: 1,
      });
      // The maintainer changed the task file by hand: Backlog.md wins.
      mirrorParked(w.office, {
        key: s.key,
        story: "DIPO-7",
        reason: "by-maintainer",
        from: "In Review",
        detail: "conflict in a.ts",
        at: 1,
      });
    });
    expect(openPark(w.office, s.key)).toMatchObject({ reason: "by-maintainer", from: "In Review" });
    expect(parkRows()[0]?.reason).toBe("conflict");
    const [row] = desk(w.office, () => true).filter((item) => item.story === "DIPO-7");
    expect(row).toMatchObject({ kind: "PARKED BY YOU", reason: "by-maintainer" });
  });

  it("are none while Backlog.md does not hold the story as Parked, whatever parks holds", () => {
    w.office.immediate(() =>
      w.office.run(
        `insert into parks (office_id, park_id, key, story_id, run_id, reason, detail, at)
         values ($office_id, 1, $key, 'DIPO-7', $run, 'conflict', 'x', 1)`,
        { key: s.key, run: s.run },
      ),
    );
    expect(openPark(w.office, s.key)).toBeNull();
    // Not a PARKED row: a park dipo could not write, which holds the story's work (fail-closed).
    const items = desk(w.office, () => true).filter((item) => item.story === "DIPO-7");
    expect(items.map((item) => item.kind)).toEqual([PARK_NOT_WRITTEN]);
    expect(heldByPark(w.office, s.key)).toBe(true);
  });

  it("shows a held park on the desk by why it is held, offering only what can act on it", () => {
    // A park dipo wrote, then lifted by hand in Backlog.md.
    const parkId = w.office.immediate(() =>
      insertPark(w.office, {
        key: s.key,
        story: "DIPO-7",
        runId: s.run,
        reason: "conflict",
        detail: "conflict in a.ts",
        at: 1,
        lastGoodCommit: "a".repeat(40),
      }),
    );
    w.office.immediate(() => mirrorStory(w.office, { key: s.key, story: "DIPO-7" }));
    const row = () => desk(w.office, () => true).find((item) => item.story === "DIPO-7");
    expect(row()).toMatchObject({ kind: PARK_HELD });
    expect(row()?.detail).toContain("Backlog.md no longer holds this park");
    expect(row()?.actions.map((action) => action.cli)).toEqual(["dipo office rescan"]);
    // A maintainer resume is lifting it: nothing to offer until it finishes.
    w.office.immediate(() =>
      recordIntent(
        w.office,
        s.run,
        "answer",
        `${MAINTAINER_RESUME_TAG} ${JSON.stringify({ parkId })}`,
        2,
      ),
    );
    expect(row()).toMatchObject({ kind: PARK_HELD });
    expect(row()?.detail).toContain("a resume is lifting this park");
    // A restart retries it; drop or discard is the way out of one that never finishes (DIPO-362).
    expect(row()?.detail).toContain("a daemon restart tries it again");
    expect(row()?.actions.map((action) => action.cli)).toEqual([
      expect.stringMatching(/^dipo drop /),
      expect.stringMatching(/^dipo discard .* --note "<why>"$/),
    ]);
  });

  it("follow an open planning-lane operation before its backlog PR merges", () => {
    w.office.immediate(() => {
      insertPark(w.office, {
        key: s.key,
        story: "DIPO-7",
        reason: "by-maintainer",
        from: "Ready",
        detail: "later",
        at: 1,
      });
      // The base still reads the story as before the park: only the journaled hold says Parked.
      w.office.run(
        `update backlog_mirror set status = 'Ready', park = null, park_since = null
          where office_id = $office_id and key = $key`,
        { key: s.key },
      );
      insertEntry(
        w.office,
        {
          kind: "hold",
          key: s.key,
          subject: "DIPO-7",
          target: {
            from: ["Refined", "Ready"],
            status: "Parked",
            fields: { park: { reason: "by-maintainer", from: "Ready", note: "later" } },
          },
        },
        1,
      );
    });
    expect(openPark(w.office, s.key)).toMatchObject({ reason: "by-maintainer", from: "Ready" });
    w.office.immediate(() =>
      insertEntry(
        w.office,
        {
          kind: "resume",
          key: s.key,
          subject: "DIPO-7",
          target: { from: ["Parked"], status: "Ready", unset: ["park"] },
        },
        2,
      ),
    );
    expect(openPark(w.office, s.key)).toBeNull();
  });
});
