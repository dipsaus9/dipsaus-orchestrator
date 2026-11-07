// A triage refine that is undone no longer promotes its draft (DIPO-454): when its journal entry is
// withdrawn, fails, is dropped, or goes back to pending because its backlog PR closed unmerged and
// it is rebuilt on a new branch, the draft's key loses `promoted_to`, so the index never renumbers
// it to an id that may not reach the base. A drop because the target state is on the open branch
// already keeps it, and so does a change to applied or pushed.

import { describe, expect, it } from "bun:test";

import { StoryId, type StoryKey } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { ALREADY_ON_BRANCH } from "../../../src/backlog/lane";
import { type EntryChange, insertEntry, updateEntry } from "../../../src/backlog/lane/journal";
import type { OfficeHandle } from "../../../src/db/office";
import { addStory } from "../../../src/records/story-keys";
import { REFINE_KIND } from "../../../src/story-store/planning";
import { addOffice, openTestState } from "../../commands/helpers";

function promotedTo(office: OfficeHandle, key: StoryKey): string | null {
  return (
    office.get<{ promoted_to: string | null }>(
      "select promoted_to from stories where office_id = $office_id and key = $key",
      { key },
    )?.promoted_to ?? null
  );
}

describe("an undone triage refine (DIPO-454)", () => {
  it("clears promoted_to when withdrawn, failed, dropped or sent back to pending, and keeps it otherwise", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const office = addOffice(t);
        const { key } = office.immediate(() =>
          addStory(office, t.ids, { story: StoryId.parse("DRAFT-1") }, t.clock.now()),
        );
        const other = office.immediate(() =>
          addStory(office, t.ids, { story: StoryId.parse("DRAFT-2") }, t.clock.now()),
        );
        const cases: readonly [EntryChange, string | null][] = [
          [{ state: "pushed", branch: "dipo/backlog-1" }, "TASK-4"],
          [{ state: "dropped", notice: `${ALREADY_ON_BRANCH} dipo/backlog-1` }, "TASK-4"],
          [{ state: "pending", branch: null, commit: null, prRef: null }, null],
          [{ state: "withdrawn" }, null],
          [{ state: "failed", notice: "the Backlog CLI exited 1." }, null],
          [{ state: "dropped", notice: "DRAFT-1 is no longer the draft" }, null],
        ];
        for (const [change, left] of cases) {
          const entry = office.immediate(() =>
            insertEntry(office, { kind: REFINE_KIND, key, subject: "DRAFT-1", target: {} }, 0),
          );
          office.immediate(() => {
            office.run(
              "update stories set promoted_to = 'TASK-4' where office_id = $office_id and key in ($a, $b)",
              { a: key, b: other.key },
            );
            updateEntry(office, entry.opId, change, 1);
          });
          expect([change.state, change.notice ?? null, promotedTo(office, key)]).toEqual([
            change.state,
            change.notice ?? null,
            left,
          ]);
          // Another story's promotion is never touched.
          expect(promotedTo(office, other.key)).toBe("TASK-4");
        }
      } finally {
        t.state.close();
      }
    }));
});
