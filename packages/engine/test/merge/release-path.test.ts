// The release path as data (DIPO-331; the 0016 amendment of 2026-10-23): CODEOWNERS parsed the way
// GitHub reads it, the last matching rule deciding, and the repository's own CODEOWNERS giving the
// release path the amendment names. No git here; the real-git cases are in
// story-slot.git.ci.test.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { parseCodeowners, releasePathsOf } from "../../src/merge/release-path";

const owned = (codeowners: string, paths: readonly string[]) =>
  releasePathsOf(parseCodeowners(codeowners), paths);

describe("the repository's own CODEOWNERS", () => {
  const text = readFileSync(join(import.meta.dir, "../../../../.github/CODEOWNERS"), "utf8");

  it("makes .github/, install.sh, the release-please files and renovate.json the release path", () => {
    expect(
      owned(text, [
        ".github/workflows/ci.yml",
        ".github/CODEOWNERS",
        ".github/actions/smoke/action.yml",
        "install.sh",
        "release-please-config.json",
        ".release-please-manifest.json",
        "renovate.json",
      ]),
    ).toEqual([
      ".github/CODEOWNERS",
      ".github/actions/smoke/action.yml",
      ".github/workflows/ci.yml",
      ".release-please-manifest.json",
      "install.sh",
      "release-please-config.json",
      "renovate.json",
    ]);
  });

  it("leaves code, docs, the backlog and look-alike paths outside it", () => {
    expect(
      owned(text, [
        "packages/engine/src/merge-slot/slot.ts",
        "docs/release.md",
        "backlog/tasks/dipo-1 - A.md",
        "scripts/install.sh",
        "docs/.github/notes.md",
        "renovate.json5",
        ".githubx/file",
      ]),
    ).toEqual([]);
  });
});

describe("CODEOWNERS patterns", () => {
  it("anchors a leading slash and a slash inside the pattern to the root", () => {
    expect(
      owned("/build/ @o\ndocs/api @o", ["build/x", "a/build/x", "docs/api/y", "a/docs/api"]),
    ).toEqual(["build/x", "docs/api/y"]);
  });

  it("matches a pattern without a slash at any depth, and a folder name with everything below it", () => {
    expect(
      owned("*.sh @o\napps/ @o\nlogs @o", ["a/b.sh", "x/apps/y/z", "deep/logs/1", "logsx"]),
    ).toEqual(["a/b.sh", "deep/logs/1", "x/apps/y/z"]);
  });

  it("matches `docs/*` one level only, and `**` across folders", () => {
    expect(owned("docs/* @o", ["docs/a.md", "docs/build/b.md"])).toEqual(["docs/a.md"]);
    expect(owned("**/secrets/** @o", ["a/b/secrets/c/d", "secrets/x"])).toEqual([
      "a/b/secrets/c/d",
      "secrets/x",
    ]);
    expect(owned("/src/**/gen.ts @o", ["src/gen.ts", "src/a/b/gen.ts", "lib/gen.ts"])).toEqual([
      "src/a/b/gen.ts",
      "src/gen.ts",
    ]);
    expect(owned("file?.txt @o", ["file1.txt", "file12.txt"])).toEqual(["file1.txt"]);
  });

  it("lets the last matching rule decide; a rule without owners leaves the path without one", () => {
    const text = "* @o\n/docs/ \n/docs/release.md @o\n";
    expect(owned(text, ["README.md", "docs/a.md", "docs/release.md"])).toEqual([
      "README.md",
      "docs/release.md",
    ]);
  });

  it("skips comments, blank lines and negations, and reads an escaped # as a path", () => {
    const text = [
      "# the release path",
      "",
      "   ",
      "/ci.yml @o # inline comment",
      "!/ci.yml",
      "\\#odd @o",
      "/plain.txt # no owner, only a comment",
    ].join("\n");
    expect(owned(text, ["ci.yml", "#odd", "plain.txt"])).toEqual(["#odd", "ci.yml"]);
  });

  it("treats regular expression characters in a pattern as text", () => {
    expect(owned("/a+b(c).json @o", ["a+b(c).json", "aab(c).json", "a+bc.json"])).toEqual([
      "a+b(c).json",
    ]);
  });
});

describe("syntax the matcher does not model (fails closed)", () => {
  const anyPaths = ["README.md", "packages/engine/src/x.ts", "docs/a b/c.md"];

  it.each([
    ["an escaped space", "/path\\ with\\ space/ @o"],
    ["a backslash inside the pattern", "/src/a\\b.ts @o"],
    ["a trailing backslash", "/src\\ @o"],
    ["an opening bracket", "/src/[ab].ts @o"],
    ["a closing bracket", "/src/a].ts @o"],
    ["a brace", "/src/{a,b}.ts @o"],
    ["a control character", "/src/a\u0001b @o"],
  ])("makes %s with an owner own every path", (_name, rule) => {
    expect(owned(rule, anyPaths)).toEqual(anyPaths.toSorted());
  });

  it("never lets such a rule without an owner take a path out of the release path", () => {
    expect(owned("* @o\n/src/[ab].ts\n/docs/{a}\n", ["src/a.ts", "docs/a"])).toEqual([
      "docs/a",
      "src/a.ts",
    ]);
  });

  it("still reads a leading \\# as a literal #", () => {
    expect(owned("\\#notes @o", ["#notes", "other"])).toEqual(["#notes"]);
  });
});
