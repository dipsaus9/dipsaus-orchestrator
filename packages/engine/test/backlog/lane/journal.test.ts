// The lane-b journal in the state database (DIPO-34; 0007 section 4): entries are numbered in
// journal order, and `pendingLaneOp` reports a story from journaling until its entry is merged,
// dropped or withdrawn.

import { describe, expect, it } from "bun:test";

import { StoryKey } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import {
  allEntries,
  findEntry,
  pendingLaneOp,
  recordPrRef,
  statusPaths,
} from "../../../src/backlog/lane";
import { insertEntry, updateEntry } from "../../../src/backlog/lane/journal";
import { addOffice, openTestState } from "../../commands/helpers";

describe("the backlog journal", () => {
  it("reports a pending lane operation until the entry is merged or dropped", async () => {
    await withTempDir(async (dir) => {
      const t = await openTestState(dir);
      const office = addOffice(t);
      const other = addOffice(t, "other");
      const key = StoryKey.parse(t.ids.next("sto"));
      const now = t.clock.now();

      expect(pendingLaneOp(office, key)).toBeNull();
      const first = office.immediate(() =>
        insertEntry(
          office,
          { kind: "edit", key, subject: "DIPO-3", target: { status: "Refined" } },
          now,
        ),
      );
      const second = office.immediate(() =>
        insertEntry(
          office,
          { kind: "edit", key, subject: "DIPO-3", target: { status: "Ready" } },
          now,
        ),
      );
      expect([first.opId, second.opId]).toEqual([1, 2]);
      expect(first).toMatchObject({
        state: "pending",
        branch: null,
        target: { status: "Refined" },
      });
      expect(pendingLaneOp(office, key)).toEqual({
        reason: "notRunnable",
        notice: "pending backlog PR",
        ops: [1, 2],
      });
      // Another office's journal never reports this office's stories.
      expect(pendingLaneOp(other, key)).toBeNull();

      for (const state of ["applied", "committed", "pushed"] as const) {
        office.immediate(() => updateEntry(office, 1, { state, branch: "dipo/backlog-x" }, now));
        expect(pendingLaneOp(office, key)?.ops).toEqual([1, 2]);
      }
      expect(office.immediate(() => recordPrRef(office, "dipo/backlog-x", "#12", now))).toBe(1);
      expect(findEntry(office, 1)?.prRef).toBe("#12");

      office.immediate(() => updateEntry(office, 1, { state: "merged" }, now + 5));
      expect(pendingLaneOp(office, key)?.ops).toEqual([2]);
      expect(findEntry(office, 1)).toMatchObject({ closedAt: now + 5, branch: "dipo/backlog-x" });
      office.immediate(() => updateEntry(office, 2, { state: "dropped", notice: "gone" }, now));
      expect(pendingLaneOp(office, key)).toBeNull();
      expect(allEntries(office).map((e) => e.state)).toEqual(["merged", "dropped"]);
    });
  });

  it("refuses a state outside the journal states", async () => {
    await withTempDir(async (dir) => {
      const t = await openTestState(dir);
      const office = addOffice(t);
      office.immediate(() =>
        insertEntry(office, { kind: "edit", subject: "config", target: null }, t.clock.now()),
      );
      expect(() =>
        office.immediate(() => updateEntry(office, 1, { state: "lost" as never }, t.clock.now())),
      ).toThrow();
    });
  });

  it("reads both paths of a rename from porcelain status", () => {
    expect(
      statusPaths(" M backlog/a.md\0R  backlog/b.md\0backlog/c.md\0?? .dipo/.gitignore\0"),
    ).toEqual(["backlog/a.md", "backlog/b.md", "backlog/c.md", ".dipo/.gitignore"]);
  });
});
