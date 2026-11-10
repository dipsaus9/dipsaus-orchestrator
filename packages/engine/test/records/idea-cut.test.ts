// The one cut of an idea's or a draft's title (DIPO-488): on a word boundary, nothing added.

import { describe, expect, it } from "bun:test";

import { cutWords, ideaTitle } from "../../src/records/ideas";

describe("the shared cut of a title (DIPO-488)", () => {
  it("cuts a long title on a word boundary, adds no mark, and keeps a short one", () => {
    const words = "The overlays `open` and `shell` lines stay apart when the box reads them";
    expect(cutWords(words, 200)).toBe(words);
    for (const max of [10, 20, 31, 32, 33, 50]) {
      const cut = cutWords(words, max);
      expect(Array.from(cut).length).toBeLessThanOrEqual(max);
      expect(words.startsWith(cut)).toBe(true);
      expect(cut).toBe(cut.trimEnd());
      expect(words[cut.length] === " " || cut === words).toBe(true);
      expect(/^[ -~]*$/.test(cut)).toBe(true);
    }
    // A word longer than the cap is cut where the cap falls.
    expect(cutWords("x".repeat(400), 120)).toBe("x".repeat(120));
  });

  it("is what an idea's held title is cut by (a draft's title: `idea-answers.test.ts`), with no … added", () => {
    const long = "word ".repeat(100);
    const held = ideaTitle(long);
    expect(held).not.toContain("…");
    expect(held.endsWith("word")).toBe(true);
    expect(Array.from(held).length).toBeLessThanOrEqual(120);
  });
});
