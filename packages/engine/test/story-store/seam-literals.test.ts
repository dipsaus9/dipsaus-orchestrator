// The StoryStore seam holds (0010, DIPO-379): no engine code outside `backlog/` names the folder
// Backlog.md keeps its stories in, or reads the planning lane's journal with its own SQL. Code is
// read as Bun's transpiler leaves it: no comments, no types, and the module paths of its imports
// dropped (the composition root imports the backlog module by its path, 0004).

import { readFileSync } from "node:fs";

import { describe, expect, it } from "bun:test";

const SRC = new URL("../../src/", import.meta.url).pathname;
const transpiler = new Bun.Transpiler({ loader: "ts" });

/** Every engine source file outside `skip`, with its code as the transpiler leaves it. */
function codeOutside(skip: readonly string[]): { readonly file: string; readonly code: string }[] {
  return [...new Bun.Glob("**/*.ts").scanSync(SRC)]
    .filter((file) => !file.endsWith(".test.ts") && !skip.some((dir) => file.startsWith(dir)))
    .toSorted()
    .map((file) => {
      const code = transpiler
        .transformSync(readFileSync(`${SRC}${file}`, "utf8"))
        .replace(/\bfrom\s*"[^"]*"/g, 'from ""')
        .replace(/\bimport\s*\(\s*"[^"]*"\s*\)/g, 'import("")')
        .replace(/\bimport\s*"[^"]*"/g, 'import ""');
      return { file, code };
    });
}

describe("the StoryStore seam (DIPO-379)", () => {
  it("names the story folder only inside backlog/", () => {
    const named = codeOutside(["backlog/"])
      .filter(({ code }) => /\.?backlog\//i.test(code))
      .map(({ file }) => file);
    expect(named).toEqual([]);
  });

  it("never has the folder's bare name as a string outside backlog/, but for three other names", () => {
    // Each allowed hit names something else: a PR kind in the merge slot's table, the Backlog CLI
    // program among the tools the daemon resolves, and the parts guard's kind of a story folder.
    const ALLOWED: Readonly<Record<string, string>> = {
      "db/migrations/0048-merge-slot.ts": "check (kind in ('story', 'backlog'))",
      "platform/tools.ts": `["claude", "backlog", "gh", "rg", "git"]`,
      "box/parts.ts": `return "backlog";`,
    };
    const hits = codeOutside(["backlog/"]).flatMap(({ file, code }) =>
      (code.match(/.{0,40}["'`]\.?backlog["'`].{0,30}/gi) ?? [])
        .filter((line) => ALLOWED[file] === undefined || !line.includes(ALLOWED[file]))
        .map((line) => `${file}: ${line.trim()}`),
    );
    expect(hits).toEqual([]);
  });

  it("reads the planning lane's journal only inside backlog/ and retention", () => {
    const reading = codeOutside(["backlog/", "retention/", "db/migrations/"])
      .filter(({ code }) => code.includes("backlog_journal"))
      .map(({ file }) => file);
    expect(reading).toEqual([]);
  });
});
