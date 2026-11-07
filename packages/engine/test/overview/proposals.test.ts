// The desk's ideas and notes seam (DIPO-454, DIPO-404): an idea that passed its audit and that the
// maintainer has not decided is listed with its card, in the order the ideas passed; a held,
// rejected, accepted or dismissed idea is not; an open decision note is listed with its file,
// section and text.

import { describe, expect, it } from "bun:test";

import { RunId, StoryId } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { storeDecisionNotes } from "../../src/run/report-data";
import { decideIdea, holdIdea, rejectIdea } from "../../src/records/ideas";
import { addStory } from "../../src/records/story-keys";
import { ideaItems, openDecisionNotes } from "../../src/overview/proposals";
import { addOffice, openTestState } from "../commands/helpers";
import { passedIdea } from "../run/idea-fixture";

const RUN = RunId.parse("run_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D");

describe("the ideas and notes of the desk", () => {
  it("lists the passed ideas the maintainer has not decided, and the open decision notes", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const office = addOffice(t);
        const { key } = office.immediate(() =>
          addStory(office, t.ids, { story: StoryId.parse("DIPO-9") }, t.clock.now()),
        );
        const at = t.clock.now();
        office.immediate(() =>
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
          }),
        );
        const later = passedIdea(office, { key, run: RUN, title: "Second", at: at + 2 });
        const first = passedIdea(office, { key, run: RUN, title: "First", at: at + 1 });
        const accepted = passedIdea(office, { key, run: RUN, title: "Accepted", at: at + 3 });
        const dismissed = passedIdea(office, { key, run: RUN, title: "Dismissed", at: at + 4 });
        office.immediate(() => {
          decideIdea(office, accepted, "accepted", at + 5);
          decideIdea(office, dismissed, "dismissed", at + 5);
          const held = holdIdea(office, {
            origin: "quick",
            key: null,
            runId: null,
            title: "Held",
            text: "Waits.",
            at,
          });
          const rejected = holdIdea(office, {
            origin: "quick",
            key: null,
            runId: null,
            title: "Rejected",
            text: "No.",
            at,
          });
          expect(held).not.toBeNull();
          rejectIdea(office, rejected ?? "", {
            by: "code",
            reason: "a duplicate",
            auditRun: null,
            at,
          });
        });

        expect(openDecisionNotes(office)).toEqual([
          {
            id: expect.stringMatching(/^[0-9a-f]{64}$/),
            storyKey: key,
            story: "DIPO-9",
            run: RUN,
            file: "docs/decisions/0019-review-loop.md",
            section: "4. The reviewer session",
            text: "The reviewer also reads the worker's deviations.",
            createdAt: at,
          },
        ]);
        const items = ideaItems(office);
        expect(items.map((item) => [item.card.id, item.card.title, item.since])).toEqual([
          [first, "First", at + 1],
          [later, "Second", at + 2],
        ]);
        expect(items[0]).toMatchObject({
          storyKey: key,
          card: { origin: "proposal", run: RUN, sourceStory: "DIPO-9", serves: "m-3" },
        });
      } finally {
        t.state.close();
      }
    }));
});
