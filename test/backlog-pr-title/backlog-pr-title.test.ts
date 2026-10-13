// The engine's backlog PR titles (DIPO-35) pass this repository's `pr-title` check
// (`scripts/check-pr-title.ts`, 0016 rule 1), for one operation, several, and more than fit.

import { describe, expect, it } from "bun:test";

import { MAX_SUBJECT, prTitle } from "../../packages/engine/src/backlog/pr/title";
import { checkPrTitle } from "../../scripts/check-pr-title";

describe("backlog PR titles", () => {
  it("pass the pr-title check however many operations the branch holds", () => {
    const one = prTitle([{ kind: "edit", subject: "DIPO-12" }]);
    expect(one).toBe("chore(backlog): edit DIPO-12");
    const many = prTitle(
      Array.from({ length: 40 }, (_, i) => ({ kind: "ready", subject: `DIPO-${i + 1}` })),
    );
    expect(many.startsWith("chore(backlog): 40 backlog operations on DIPO-1, DIPO-2")).toBe(true);
    expect(Array.from(many.slice("chore(backlog): ".length)).length).toBeLessThanOrEqual(
      MAX_SUBJECT,
    );
    const trailing = prTitle([{ kind: "edit", subject: "config." }]);
    for (const title of [one, many, trailing, prTitle([])]) {
      expect(checkPrTitle(title)).toEqual({ ok: true });
    }
  });
});
