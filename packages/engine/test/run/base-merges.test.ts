// The worker's message after dipo merged a moved base into its branch before its session
// (DIPO-464, `caughtUpText`): the base is already merged, the files the merge changed are named,
// and the box cannot fetch the base. The merge itself on real git is in conflict-resume.ci.test.ts.

import { describe, expect, it } from "bun:test";

import { SHOWN_PATHS_MAX } from "../../src/box/collisions";
import { caughtUpText } from "../../src/run/base-merges";

const ONTO = "0123456789abcdef0123456789abcdef01234567";

describe("the worker's message after a merge of a moved base (DIPO-464)", () => {
  it("says the base is already merged, names the merged files, and says the box cannot fetch it", () => {
    const text = caughtUpText({
      base: "main",
      onto: ONTO,
      files: ["docs/later.md", "src/other.ts"],
      conflicts: [],
    });
    expect(text).toStartWith(
      "dipo: main moved, so before this session dipo merged main at 0123456789ab",
    );
    expect(text).toContain("main is already merged into your branch");
    expect(text).toContain("committed in your box's git as a commit of its own");
    expect(text).toContain("The merge changed 2 files: docs/later.md, src/other.ts.");
    expect(text).toContain("Your box cannot fetch main: it has no route to the remote.");
    expect(text).toContain("Do not try to fetch, pull or merge main yourself");
    expect(text).not.toContain("conflicted");
  });

  it("counts the files past the shown ones, and says which conflicted", () => {
    const files = Array.from({ length: SHOWN_PATHS_MAX + 3 }, (_, n) => `src/f${n}.ts`);
    const text = caughtUpText({
      base: "trunk",
      onto: ONTO,
      files,
      conflicts: [{ path: "src/f1.ts", kind: "content" }],
    });
    expect(text).toContain(`The merge changed ${SHOWN_PATHS_MAX + 3} files:`);
    expect(text).toContain("and 3 more");
    expect(text).toContain("1 file conflicted and stays as git left it");
    expect(text).toContain("Your box cannot fetch trunk");
  });

  it("says so when the merge changed no file outside the story folders", () => {
    expect(caughtUpText({ base: "main", onto: ONTO, files: [], conflicts: [] })).toContain(
      "The merge changed no file outside the story folders.",
    );
  });
});
