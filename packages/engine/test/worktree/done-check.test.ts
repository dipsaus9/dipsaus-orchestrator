// The one Done check (DIPO-363; 0002, 0020): `decideDone` over every combination of its inputs.
// Done is the claim's own PR merged into its base, else the story Done on the base, else not Done.
// Nothing else counts: no ancestry and no `git merge-tree` (0010).

import { describe, expect, it } from "bun:test";

import { decideDone, type DoneAnswer, type DonePr } from "../../src/worktree/done-check";

const CLAIM = { branch: "TASK-1/add-csv", base: "main" } as const;

function pr(state: DonePr["state"], change: Partial<DonePr> = {}): DonePr {
  return {
    number: 9,
    url: "https://github.com/o/r/pull/9",
    state,
    branch: CLAIM.branch,
    base: CLAIM.base,
    headSha: "2".repeat(40),
    ...change,
  };
}

/** Each PR fact, and whether it is the claim's own PR merged into its base. */
const PRS: readonly (readonly [string, DonePr | null, boolean])[] = [
  ["no PR", null, false],
  ["an open PR", pr("open"), false],
  ["a closed PR", pr("closed"), false],
  ["a merged PR", pr("merged"), true],
  ["a merged PR of another branch", pr("merged", { branch: "TASK-1/other" }), false],
  ["a merged PR into another base", pr("merged", { base: "release" }), false],
];

/** Each base fact, and whether it reads Done. Only the 0012 status `Done` does. */
const BASES: readonly (readonly [string | null, boolean])[] = [
  [null, false],
  ["Done", true],
  ["In Progress", false],
  ["In Review", false],
  ["Parked", false],
  ["Ready", false],
  ["Refined", false],
  ["To Do", false],
  ["done", false],
  ["Completed", false],
];

const CLAIMS = [
  ["a claim", CLAIM],
  ["no claim", null],
] as const;

describe("the one Done check (DIPO-363)", () => {
  for (const [claimName, claim] of CLAIMS) {
    for (const [prName, fact, own] of PRS) {
      for (const [base, onBase] of BASES) {
        const expected: DoneAnswer =
          own && claim !== null ? "merged" : onBase ? "doneOnBase" : "notDone";
        it(`answers ${expected} for ${claimName}, ${prName} and the base status ${base ?? "unread"}`, () => {
          expect(decideDone({ claim, pr: fact, baseStatus: base })).toBe(expected);
        });
      }
    }
  }

  it("lets the claim's own merged PR win over a Done on the base (DIPO-332)", () => {
    expect(decideDone({ claim: CLAIM, pr: pr("merged"), baseStatus: "Done" })).toBe("merged");
  });

  it("does not look at the merged head: a branch that moved past it is still merged", () => {
    const moved = pr("merged", { headSha: "6".repeat(40) });
    expect(decideDone({ claim: CLAIM, pr: moved, baseStatus: null })).toBe("merged");
  });
});
