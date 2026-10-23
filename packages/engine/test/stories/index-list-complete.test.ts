// An index pass over a task list that lost a line (DIPO-323): the list disagrees with its
// `--count` on both reads, so the pass throws before it applies anything. The story the list lost
// is not closed as Removed, and nothing is written to the change log.

import { describe, expect, it } from "bun:test";

import { BacklogListIncompleteError } from "../../src/backlog/list";
import { withReconcileOffice } from "../reconcile/helpers";
import { lastSeq, storyRows } from "./helpers";

describe("an index pass over an incomplete task list", () => {
  it("throws before anything is applied, so no story is closed as Removed", () =>
    withReconcileOffice(
      {
        base: [
          { id: "TASK-1", status: "Ready" },
          { id: "TASK-2", status: "Done" },
        ],
      },
      async (o) => {
        await o.index.indexStories(o.officeId);
        const rows = storyRows(o.office);
        expect(rows.filter((row) => !row.removed).map((row) => row.story_id)).toEqual([
          "TASK-1",
          "TASK-2",
        ]);
        const seq = lastSeq(o.office);

        o.setBase([
          { id: "TASK-1", status: "Ready" },
          { id: "TASK-2", status: "Done", cutFromList: true },
        ]);
        await expect(o.index.indexStories(o.officeId)).rejects.toBeInstanceOf(
          BacklogListIncompleteError,
        );
        expect(storyRows(o.office)).toEqual(rows);
        expect(lastSeq(o.office)).toBe(seq);
      },
    ));
});
