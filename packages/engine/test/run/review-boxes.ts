// A stand-in for the reviewer boxes (`BoxWorkers.review` and `endReview`, 0002) in the run tests
// whose worker is scripted: each review session gets a box session that names the box, and every
// call is logged. The real reviewer box is tested on a real box (`review-box.box.test.ts`) and on
// the in-memory backend (`review-box.test.ts`).

import type { BoxSession, BoxWorkers } from "../../src/box/workers";
import { REVIEW_SESSION_DIR, reviewBoxName } from "../../src/box/review-box";

export interface StubReviewBoxes extends Pick<BoxWorkers, "review" | "endReview"> {
  /** `review <agent> <commit>` and `end <agent>`, in order. */
  readonly calls: string[];
}

/** Reviewer boxes that make nothing: each session's box is a name and two client commands. */
export function stubReviewBoxes(): StubReviewBoxes {
  const calls: string[] = [];
  return {
    calls,
    review: async (input): Promise<BoxSession> => {
      calls.push(`review ${input.agent} ${input.commit}`);
      const box = reviewBoxName(input.agent);
      return {
        box,
        workdir: REVIEW_SESSION_DIR,
        env: {},
        systemFile: "/dipo/system.md",
        exec: (command, env) => ({ argv: command, env: { ...env } }),
        stop: { argv: ["/usr/bin/true"], env: {} },
      };
    },
    endReview: async (agent) => {
      calls.push(`end ${agent}`);
    },
  };
}
