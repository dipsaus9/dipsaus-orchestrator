// The one comparison of a repository path with the story folders (DIPO-379, 0010): normalised,
// folded as the Mac's volume finds names, whole segments only.

import { describe, expect, it } from "bun:test";

import { inStoryFolder, linkTargetOf, repoPathOf } from "../../src/story-store/paths";

describe("a repository path, as a folder comparison sees it", () => {
  it("resolves . and .., drops repeated, leading and trailing slashes, and leaves nothing out", () => {
    for (const [path, normal] of [
      ["backlog/", "backlog"],
      ["./backlog//tasks/", "backlog/tasks"],
      ["/backlog/x", "backlog/x"],
      ["src/../backlog", "backlog"],
      ["./", ""],
      ["/", ""],
      [".", ""],
      ["a/..", ""],
      ["../", null],
      ["..//x", null],
      ["a/../../x", null],
    ] as const) {
      expect([path, repoPathOf(path)]).toEqual([path, normal]);
    }
  });

  it("is in a folder on whole segments, folded, and never when it leaves the repository", () => {
    const folders = ["backlog", "planning/board"];
    expect(inStoryFolder("BACKLOG/x", folders)).toBe(true);
    expect(inStoryFolder("planning/board", folders)).toBe(true);
    expect(inStoryFolder("planning", folders)).toBe(false);
    expect(inStoryFolder("backlog-x/y", folders)).toBe(false);
    expect(inStoryFolder("../backlog/x", folders)).toBe(false);
    expect(inStoryFolder("./", folders)).toBe(false);
  });

  it("follows a symlink's target from the link's folder", () => {
    expect(linkTargetOf("docs/t", "../backlog/tasks")).toBe("backlog/tasks");
    expect(linkTargetOf("docs/root", "../")).toBe("");
    expect(linkTargetOf("t", "../x")).toBeNull();
    expect(linkTargetOf("t", "/etc")).toBeNull();
  });
});
