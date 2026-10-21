// The story's ignore rules (DIPO-273): dipo's own gitignore matcher, checked against what git
// itself says for the same rules and paths.

import { describe, expect, it } from "bun:test";

import { withTempRepo } from "@dipsaus-orchestrator/testkit";

import {
  IgnoreBudgetExceeded,
  ignoreFileDir,
  IgnoreRules,
  MAX_MATCH_DEPTH,
  MatchBudget,
} from "../../src/box/ignore";

function rules(text: string, dir = ""): IgnoreRules {
  return new IgnoreRules([{ dir, text }]);
}

describe("one .gitignore", () => {
  it("matches names at any depth, anchored paths, folders only and wildcards", () => {
    const r = rules(
      [
        "# a comment",
        "",
        "node_modules/",
        "*.log",
        "/root-only.txt",
        "docs/*.tmp",
        "build/",
        "a?c",
        "[Tt]emp",
        "trailing   ",
        "\\#hash",
        "\\!bang",
      ].join("\n"),
    );
    expect(r.ignored("node_modules/x/index.js")).toBe(true);
    expect(r.ignored("packages/a/node_modules/y.js")).toBe(true);
    expect(r.ignored("node_modules")).toBe(false);
    expect(r.ignored("node_modules", true)).toBe(true);
    expect(r.ignored("logs/run.log")).toBe(true);
    expect(r.ignored("root-only.txt")).toBe(true);
    expect(r.ignored("sub/root-only.txt")).toBe(false);
    expect(r.ignored("docs/x.tmp")).toBe(true);
    expect(r.ignored("docs/deep/x.tmp")).toBe(false);
    expect(r.ignored("build/out.js")).toBe(true);
    expect(r.ignored("abc")).toBe(true);
    expect(r.ignored("a/c")).toBe(false);
    expect(r.ignored("Temp")).toBe(true);
    expect(r.ignored("temp")).toBe(true);
    expect(r.ignored("trailing")).toBe(true);
    expect(r.ignored("#hash")).toBe(true);
    expect(r.ignored("!bang")).toBe(true);
    expect(r.ignored("src/index.ts")).toBe(false);
  });

  it("matches ** in front, in the middle and at the end", () => {
    const r = rules(["**/cache", "a/**/z", "out/**"].join("\n"));
    expect(r.ignored("cache")).toBe(true);
    expect(r.ignored("x/y/cache")).toBe(true);
    expect(r.ignored("a/z")).toBe(true);
    expect(r.ignored("a/b/c/z")).toBe(true);
    expect(r.ignored("out/x/y")).toBe(true);
    expect(r.ignored("out")).toBe(false);
  });

  it("re-includes with !, but never below an ignored folder", () => {
    const r = rules(["*.env", "!keep.env", "dist/", "!dist/keep.js"].join("\n"));
    expect(r.ignored("a.env")).toBe(true);
    expect(r.ignored("keep.env")).toBe(false);
    expect(r.ignored("dist/keep.js")).toBe(true);
    expect(r.reincludes("dist")).toBe(false);
    expect(r.reincludes("keep.env")).toBe(true);
    expect(rules("!vendor/**\n").reincludes("node_modules")).toBe(true);
  });

  it("names the plain patterns an in-box exclude list may use", () => {
    const r = rules(["node_modules/", ".cache", "*.log", "/dist", "a/b", "!x"].join("\n"));
    expect(r.plainNames).toEqual([".cache", "node_modules"]);
    expect(rules(".\n..\nbuild\n").plainNames).toEqual(["build"]);
  });

  it("lists no plain name of a deeper .gitignore: it applies only below its folder", () => {
    const r = new IgnoreRules([
      { dir: "", text: "node_modules/\n" },
      { dir: "pkg", text: "dist/\n" },
    ]);
    expect(r.plainNames).toEqual(["node_modules"]);
  });

  it("matches a hostile pattern quickly, and lets a pattern too long ignore nothing", () => {
    const hostile = rules(`${"*a".repeat(60)}b`);
    const started = performance.now();
    for (let i = 0; i < 50; i += 1) hostile.ignored(`src/${"a".repeat(250)}`);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(hostile.ignored(`src/${"a".repeat(250)}`)).toBe(false);
    expect(hostile.ignored(`x/${"a".repeat(60)}b`)).toBe(true);
    expect(rules(`${"x".repeat(300)}`).ignored("x".repeat(300))).toBe(false);
    const deep = rules(`${"**/".repeat(40)}z`);
    expect(deep.ignored(`${"d/".repeat(60)}z`)).toBe(true);
  });
});

describe("nested .gitignore files", () => {
  it("applies a file only below its folder, a deeper file deciding first", () => {
    const r = new IgnoreRules([
      { dir: "", text: "*.gen\n" },
      { dir: "pkg", text: "!keep.gen\nlocal/\n" },
    ]);
    expect(r.ignored("x.gen")).toBe(true);
    expect(r.ignored("pkg/keep.gen")).toBe(false);
    expect(r.ignored("other/keep.gen")).toBe(true);
    expect(r.ignored("pkg/local/a")).toBe(true);
    expect(r.ignored("local/a")).toBe(false);
  });

  it("finds the folder of a .gitignore path", () => {
    expect(ignoreFileDir(".gitignore")).toBe("");
    expect(ignoreFileDir("a/b/.gitignore")).toBe("a/b");
    expect(ignoreFileDir("a/.gitignore.bak")).toBeNull();
  });
});

describe("against git check-ignore", () => {
  it("agrees with git for every path of a fixture", () =>
    withTempRepo(
      async (repo) => {
        const paths = [
          "node_modules/a.js",
          "src/node_modules/b.js",
          "src/index.ts",
          "debug.log",
          "src/keep.log",
          "dist/x.js",
          "dist/keep.js",
          "pkg/local/a",
          "pkg/keep.gen",
          "x.gen",
          "docs/a/b/z.md",
          "docs/z.md",
          "Temp",
          "build",
        ];
        const listed = await repo.run([
          "git",
          "check-ignore",
          "--no-index",
          "--verbose",
          "--non-matching",
          ...paths,
        ]);
        const gitSays = new Map(
          listed.stdout
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => {
              const [source, path] = line.split("\t");
              // A matching `!` line prints a source too; it re-includes.
              const ignored = source !== "::" && !(source ?? "").split(":")[2]?.startsWith("!");
              return [path ?? "", ignored] as const;
            }),
        );
        const r = new IgnoreRules([
          {
            dir: "",
            text: "node_modules/\n*.log\n!src/keep.log\ndist/\n!dist/keep.js\n*.gen\ndocs/**/z.md\n[Tt]emp\n",
          },
          { dir: "pkg", text: "!keep.gen\nlocal/\n" },
        ]);
        for (const path of paths)
          expect([path, r.ignored(path)]).toEqual([path, gitSays.get(path) ?? false]);
      },
      {
        fixture: {
          ".gitignore":
            "node_modules/\n*.log\n!src/keep.log\ndist/\n!dist/keep.js\n*.gen\ndocs/**/z.md\n[Tt]emp\n",
          "pkg/.gitignore": "!keep.gen\nlocal/\n",
        },
      },
    ));
});

describe("the matching budget (DIPO-273)", () => {
  it("merges runs of ** and leaves a pattern with too many ** ignoring nothing", () => {
    const merged = rules(`${"**/".repeat(40)}q`);
    expect(merged.ignored(`${"d/".repeat(60)}q`)).toBe(true);
    expect(rules("a/**/b/**/c/**/d/**/e/**/f").ignored("a/b/c/d/e/f")).toBe(false);
    expect(rules("a/**/b/**/c/**/d/**/e").ignored("a/b/c/d/e")).toBe(true);
  });

  it("stops at once when a match passes its budget, and refuses a path deeper than it matches", () => {
    const budget = new MatchBudget(50);
    const r = rules(`${"*a".repeat(60)}b`).withBudget(budget);
    expect(() => r.ignored(`src/${"a".repeat(250)}`)).toThrow(IgnoreBudgetExceeded);
    expect(budget.steps).toBe(51);
    expect(() => rules("x").ignored(`${"d/".repeat(MAX_MATCH_DEPTH)}x`)).toThrow(
      IgnoreBudgetExceeded,
    );
  });

  it("refuses a 64 KiB .gitignore of `**/**/.../q` lines against a 200-level path, fast", () => {
    const line = `${"**/".repeat(40)}q${"/**".repeat(40)}`;
    const text = Array.from({ length: Math.floor((64 * 1024) / (line.length + 1)) }, () => line)
      .join("\n")
      .slice(0, 64 * 1024);
    const r = rules(text).withBudget(new MatchBudget(10_000_000));
    const started = performance.now();
    expect(() => r.ignored(`${"q/".repeat(200)}file`)).toThrow(IgnoreBudgetExceeded);
    expect(() => r.ignored(`${"q/".repeat(60)}file`)).not.toThrow();
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
