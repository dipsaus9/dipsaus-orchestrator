// The desk's proposals seam (DIPO-186): a stored decision note and a stored proposal are listed as
// open items with their story, and the note's detail holds its file, section and text.

import { describe, expect, it } from "bun:test";

import { RunId, StoryId } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { storeDecisionNotes, storeProposals } from "../../src/run/report-data";
import { addStory } from "../../src/records/story-keys";
import { openDecisionNotes, proposalItems } from "../../src/views/proposals";
import { addOffice, openTestState } from "../commands/helpers";

const RUN = RunId.parse("run_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D");

describe("the proposals group of the desk", () => {
  it("lists a stored decision note with its file, section and text, then a later proposal", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const office = addOffice(t);
        const { key } = office.immediate(() =>
          addStory(office, t.ids, { story: StoryId.parse("DIPO-9") }, t.clock.now()),
        );
        const at = t.clock.now();
        office.immediate(() => {
          storeDecisionNotes(office, {
            key,
            runId: RUN,
            notes: [
              {
                file: "docs/decisions/0019-review-loop.md",
                section: "4. The reviewer session",
                text: "The reviewer also reads the worker's deviations.",
              },
            ],
            at,
          });
          storeProposals(office, {
            key,
            runId: RUN,
            proposals: [{ kind: "tool", title: "jq", outcome: "jq runs", why: "to read JSON" }],
            at: at + 1,
          });
        });
        expect(openDecisionNotes(office)).toEqual([
          {
            kind: "decision-note",
            id: expect.stringMatching(/^[0-9a-f]{64}$/),
            storyKey: key,
            story: "DIPO-9",
            run: RUN,
            title: "Decision note for docs/decisions/0019-review-loop.md",
            detail:
              'docs/decisions/0019-review-loop.md, section "4. The reviewer session": The reviewer also reads the worker\'s deviations.',
            createdAt: at,
          },
        ]);
        expect(proposalItems(office).map((item) => [item.kind, item.title, item.detail])).toEqual([
          [
            "decision-note",
            "Decision note for docs/decisions/0019-review-loop.md",
            expect.stringContaining('section "4. The reviewer session"'),
          ],
          ["tool", "jq", "jq runs Why: to read JSON"],
        ]);
      } finally {
        t.state.close();
      }
    }));
});
