// A passed idea for the desk tests (DIPO-454): held as an idea, then passed by an audit with its
// proposed user story, as the audit would write it.

import type { ProposedStory, StoryId, StoryKey } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../../src/db/office";
import { holdIdea, passIdea } from "../../src/records/ideas";

/** The audit run a fixture idea passed in. */
export const AUDIT_RUN = "run_01J9ZK5Q8W3V4X6Y7Z8A9B0AUD";

/** The proposed user story a fixture idea passed with, unless the test gives its own. */
export function proposedStory(over: Partial<ProposedStory> = {}): ProposedStory {
  return {
    found: "The PR poll retries a failed read at once, without a limit.",
    evidence: [{ file: "packages/engine/src/poll.ts", line: 42, quote: "retry();" }],
    storyLine:
      "As maintainer I want the PR poll to back off after a failed read so that a dead host is not hammered",
    proposed: "Back off the retry and cap it at five tries.",
    why: "A dead host gets one request per second.",
    serves: "m-3",
    ...over,
  };
}

/** Holds an idea of `origin` and passes it with `proposal`; returns its id. */
export function passedIdea(
  office: OfficeHandle,
  idea: {
    readonly key?: StoryKey | null;
    readonly run?: string | null;
    readonly story?: StoryId;
    readonly origin?: string;
    readonly title: string;
    readonly text?: string;
    readonly at: number;
    readonly proposal?: Partial<ProposedStory>;
  },
): string {
  return office.immediate(() => {
    const id = holdIdea(office, {
      origin: idea.origin ?? "proposal",
      key: idea.key ?? null,
      runId: idea.run ?? null,
      title: idea.title,
      text: idea.text ?? `Story: ${proposedStory().storyLine}`,
      at: idea.at,
    });
    if (id === null) throw new Error(`the idea ${idea.title} was held already`);
    const proposal = proposedStory({
      ...(idea.story === undefined ? {} : { sourceStory: idea.story }),
      ...idea.proposal,
    });
    passIdea(office, id, { proposal, auditRun: AUDIT_RUN, at: idea.at });
    return id;
  });
}
