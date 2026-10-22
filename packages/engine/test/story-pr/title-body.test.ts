// The title and body of a story PR (DIPO-144; 0019 section 3), pure.

import { describe, expect, it } from "bun:test";

import {
  STORY_PR_MAX_BASE_FAILURES,
  STORY_PR_MAX_BODY,
  STORY_PR_MAX_SUBJECT,
  storyPrBody,
  storyPrBodyHash,
  storyPrCommitType,
  storyPrSubject,
  storyPrTitle,
} from "../../src/story-pr";

describe("title", () => {
  it("maps each story type to a Conventional Commits type", () => {
    const types: [string | undefined, string][] = [
      ["feature", "feat"],
      ["enhancement", "feat"],
      ["bug", "fix"],
      ["docs", "docs"],
      ["spike", "docs"],
      ["task", "chore"],
      ["chore", "chore"],
      ["anything else", "chore"],
      [undefined, "chore"],
    ];
    for (const [type, expected] of types) expect(storyPrCommitType(type)).toBe(expected);
    expect(storyPrTitle({ id: "DIPO-7", title: "Add a thing", type: "bug" })).toBe(
      "fix(DIPO-7): add a thing",
    );
  });

  it("removes trailing full stops and lowercases the first letter unless it starts an acronym", () => {
    expect(storyPrSubject("Open the PR...")).toBe("open the PR");
    expect(storyPrSubject("Open and update the story PR.")).toBe("open and update the story PR");
    expect(storyPrSubject("CI runs on the PR")).toBe("CI runs on the PR");
    expect(storyPrSubject("A bug")).toBe("a bug");
    expect(storyPrSubject("X")).toBe("x");
  });

  it("cuts at 100 characters on a word boundary", () => {
    const words = Array.from({ length: 30 }, (_, n) => `word${n}`).join(" ");
    const subject = storyPrSubject(`Start ${words}`);
    expect([...subject].length).toBeLessThanOrEqual(STORY_PR_MAX_SUBJECT);
    expect(`start ${words}`.startsWith(subject)).toBe(true);
    expect(`start ${words}`[subject.length]).toBe(" ");
    // A single word over the limit is cut hard.
    expect([...storyPrSubject("x".repeat(150))]).toHaveLength(STORY_PR_MAX_SUBJECT);
  });
});

const STORY = {
  id: "DIPO-144",
  outcome: "each push opens or updates one PR",
  criteria: [
    { index: 1, text: "Looks for an open PR", checked: true },
    { index: 2, text: "Title is built", checked: false },
  ],
  testPlan: {
    entries: [
      { kind: "automated" as const, check: "title builder", expect: "maps types" },
      { kind: "manual" as const, check: "look at the PR" },
    ],
  },
  scope: ["packages/engine/src/story-pr/", "packages/daemon/src/"],
  taskFile: "backlog/tasks/dipo-144 - Open.md",
};

describe("body", () => {
  it("renders outcome, criteria, test plan, scope, status and footer in order", () => {
    const body = storyPrBody(STORY, { head: "abcdef0123456789" });
    const at = [
      "## Outcome",
      "## Acceptance criteria",
      "## Test plan",
      "## Declared scope",
      "## Status",
      "Opened by dipo",
    ].map((heading) => body.indexOf(heading));
    expect(at.every((n) => n >= 0)).toBe(true);
    expect([...at].toSorted((a, b) => a - b)).toEqual(at);
    expect(body).toContain("- [x] #1 Looks for an open PR");
    expect(body).toContain("- [ ] #2 Title is built");
    expect(body).toContain("passed at `abcdef01`");
    expect(body).toContain("backlog/tasks/dipo-144 - Open.md");
  });

  it("keeps the contract whole and cuts the scope list at the cap", () => {
    const scope = Array.from(
      { length: 2000 },
      (_, n) => `packages/engine/src/some/long/path/${n}.ts`,
    );
    const body = storyPrBody({ ...STORY, scope }, { head: "a".repeat(40) });
    expect(body.length).toBeLessThanOrEqual(STORY_PR_MAX_BODY);
    expect(body).toContain("more paths (cut to keep the body");
    for (const part of [STORY.outcome, "Looks for an open PR", "Title is built", "maps types"]) {
      expect(body).toContain(part);
    }
    expect(body).toContain("## Status");
  });

  it("names the tests a box verify passed with because they fail on the base in the box, inert (DIPO-294)", () => {
    expect(storyPrBody(STORY, { head: "a".repeat(40) })).toContain(
      "- verify: passed at `aaaaaaaa`\n- review: pending",
    );
    const many = Array.from({ length: STORY_PR_MAX_BASE_FAILURES + 2 }, (_, i) => `git > ${i}`);
    const body = storyPrBody(STORY, {
      head: "a".repeat(40),
      baseFailures: ["ping @someone <b>x</b> `tick`\nline two", ...many],
    });
    expect(body).toContain(
      `- verify: passed at \`aaaaaaaa\`, with ${many.length + 1} failing tests that also fail at the story's start commit in the same box image, so dipo did not count them against the story; CI runs the full suite:`,
    );
    // Each name in a code span on its own line, its backticks replaced: no mention or HTML acts.
    expect(body).toContain("  - `ping @someone <b>x</b> 'tick' line two`");
    expect(body).toContain("  - `git > 0`");
    expect(body).toContain("  - … and 3 more");
    expect(body.length).toBeLessThanOrEqual(STORY_PR_MAX_BODY);
  });

  it("hashes the text, so an unchanged body has an unchanged hash", () => {
    const a = storyPrBody(STORY, { head: "a".repeat(40) });
    expect(storyPrBodyHash(a)).toBe(storyPrBodyHash(storyPrBody(STORY, { head: "a".repeat(40) })));
    expect(storyPrBodyHash(a)).not.toBe(
      storyPrBodyHash(storyPrBody({ ...STORY, outcome: "other" }, { head: "a".repeat(40) })),
    );
  });
});
