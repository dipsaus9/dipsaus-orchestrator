// The machine-wide port slot table (DIPO-39; 0010 section 9): lowest free slot from 1 to
// maxSlots, kept while the worktree exists, shared by every office, freed by name; an unreadable
// table is never overwritten.

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { SLOTS_FILE, SlotTable, SlotTableError } from "../../src/worktree";

function owner(worktree: string, office = "off_a", story = "TASK-1") {
  return { office, story, worktree, takenAt: 1 };
}

/** A table whose worktrees all exist unless listed in `gone`. */
function table(dir: string, gone: Set<string> = new Set()): SlotTable {
  return SlotTable.inState(dir, { exists: (path) => !gone.has(path) });
}

describe("the port slot table", () => {
  it("takes the lowest free slot from 1 and keeps it for the same worktree", async () => {
    await withTempDir((dir) => {
      const slots = table(dir);
      expect(slots.take(owner("/w/a"), 20)).toBe(1);
      expect(slots.take(owner("/w/b"), 20)).toBe(2);
      expect(slots.take(owner("/w/a"), 20)).toBe(1);
      expect(slots.slotOf("/w/b")).toBe(2);
      expect(slots.free("/w/a")).toBe(true);
      expect(slots.free("/w/a")).toBe(false);
      expect(slots.take(owner("/w/c"), 20)).toBe(1);
      expect(slots.entries().map((e) => [e.slot, e.worktree])).toEqual([
        [1, "/w/c"],
        [2, "/w/b"],
      ]);
    });
  });

  it("is machine-wide: offices share one table in <state>, and a full table returns null", async () => {
    await withTempDir((dir) => {
      expect(table(dir).take(owner("/w/a", "off_a"), 2)).toBe(1);
      // A second table object on the same state directory, as another office sees it.
      expect(table(dir).take(owner("/w/b", "off_b"), 2)).toBe(2);
      expect(table(dir).take(owner("/w/c", "off_b"), 2)).toBeNull();
      expect(existsSync(join(dir, SLOTS_FILE))).toBe(true);
      expect(statSync(join(dir, SLOTS_FILE)).mode & 0o777).toBe(0o600);
    });
  });

  it("drops the slot of a worktree that no longer exists when it next writes", async () => {
    await withTempDir((dir) => {
      const gone = new Set<string>();
      expect(table(dir, gone).take(owner("/w/a"), 20)).toBe(1);
      expect(table(dir, gone).take(owner("/w/b"), 20)).toBe(2);
      gone.add("/w/a");
      expect(table(dir, gone).take(owner("/w/c"), 20)).toBe(1);
      expect(
        table(dir, gone)
          .entries()
          .map((e) => e.worktree),
      ).toEqual(["/w/c", "/w/b"]);
    });
  });

  it("refuses an unreadable table and leaves it as it is", async () => {
    await withTempDir((dir) => {
      const path = join(dir, SLOTS_FILE);
      writeFileSync(path, "{ not json");
      expect(() => table(dir).take(owner("/w/a"), 20)).toThrow(SlotTableError);
      writeFileSync(path, JSON.stringify({ version: 1, slots: [{ slot: 0 }] }));
      expect(() => table(dir).entries()).toThrow(SlotTableError);
      expect(readFileSync(path, "utf8")).toBe(JSON.stringify({ version: 1, slots: [{ slot: 0 }] }));
    });
  });
});
