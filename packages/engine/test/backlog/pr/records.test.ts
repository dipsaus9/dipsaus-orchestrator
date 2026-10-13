// The stored backlog PRs and blocks (DIPO-35, migration 15): a PR is mergeable only with a passed
// check on exactly its head, and a story stays blocked until a later merged PR clears it.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { StoryKey } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import {
  backlogCheckBlocked,
  backlogPrMergeable,
  blockStories,
  clearBlocks,
  closePrRecord,
  insertPr,
  openPrs,
  recordCheck,
} from "../../../src/backlog/pr/records";
import { addOffice, openTestState } from "../../commands/helpers";

const KEY = StoryKey.parse("sto_01HZZZZZZZZZZZZZZZZZZZZZZ1");
const FAILURE = {
  rule: "ready-decision" as const,
  task: "TASK-1",
  key: KEY,
  message: "no decision",
};

describe("backlog PR records", () => {
  it("is mergeable only when open with a passed check on exactly its head", async () => {
    await withTempDir(async (dir) => {
      const t = await openTestState(join(dir, "state"));
      const office = addOffice(t);
      office.immediate(() => {
        insertPr(
          office,
          { number: 3, url: "https://github.com/o/r/pull/3", branch: "dipo/backlog-x", title: "t" },
          1,
        );
      });
      expect(backlogPrMergeable(office, 3, "aaa")).toBe(false);
      office.immediate(() =>
        recordCheck(office, 3, { head: "aaa", passed: true, failures: [], touched: [KEY] }, 2),
      );
      expect(backlogPrMergeable(office, 3, "aaa")).toBe(true);
      expect(backlogPrMergeable(office, 3, "bbb")).toBe(false);
      office.immediate(() =>
        recordCheck(
          office,
          3,
          { head: "bbb", passed: false, failures: [FAILURE], touched: [KEY] },
          3,
        ),
      );
      expect(backlogPrMergeable(office, 3, "bbb")).toBe(false);
      office.immediate(() => closePrRecord(office, 3, "merged", 4));
      expect(openPrs(office)).toEqual([]);
    });
  });

  it("blocks a story until a later PR clears it", async () => {
    await withTempDir(async (dir) => {
      const t = await openTestState(join(dir, "state"));
      const office = addOffice(t);
      office.immediate(() => blockStories(office, 3, [{ key: KEY, failures: [FAILURE] }], 1));
      expect(backlogCheckBlocked(office, KEY)).toEqual({
        reason: "notRunnable",
        prs: [3],
        failures: [FAILURE],
      });
      // The same PR does not clear its own block; a later one does.
      expect(office.immediate(() => clearBlocks(office, 3, [KEY], 2))).toBe(0);
      expect(office.immediate(() => clearBlocks(office, 4, [KEY], 2))).toBe(1);
      expect(backlogCheckBlocked(office, KEY)).toBeNull();
    });
  });
});
