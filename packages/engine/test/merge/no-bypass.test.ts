// dipo never bypasses the base's merge rules (0002, 0016): the only merge call dipo makes through
// `gh` is `gh pr merge --auto --squash --match-head-commit <head>` with the subject and an empty
// body, so GitHub merges once its own required checks and reviews pass on exactly that head; the
// only other merge call turns auto-merge off. Neither passes `--admin`. `gh` is faked through the
// injected Spawn; no test reaches GitHub. The source check keeps `--admin` out of every package's
// code.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { GhHost, MIN_GH_VERSION } from "../../src/platform/host";
import { scriptedSpawn } from "../backlog/helpers";

const VERSION = `gh version ${MIN_GH_VERSION} (2024-05-29)\n`;

/** The code of a source file without its comment lines (comments may name the flag dipo never uses). */
function codeOf(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .map((line) => line.replace(/\s\/\/ .*$/, ""))
    .join("\n");
}

/** Every `.ts` file under `dir`. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") || name.endsWith(".tsx") ? [path] : [];
  });
}

describe("the merge call", () => {
  it("is gh pr merge --auto --squash --match-head-commit with the subject, and --disable-auto, and nothing that bypasses a rule", async () => {
    const stub = scriptedSpawn(
      (args) => (args[0] === "--version" ? { stdout: VERSION } : {}),
      ["gh"],
    );
    const gh = new GhHost({ spawn: stub.spawn, gh: "gh", env: { HOME: "/home/x" } });
    const head = "a".repeat(40);
    await gh.enableAutoMerge("o/r", 7, {
      headSha: head,
      subject: "feat(DIPO-7): add the greeting",
    });
    await gh.disableAutoMerge("o/r", 7);
    const merges = stub.calls
      .map((call) => call.cmd.slice(1))
      .filter((args) => args[1] === "merge");
    expect(merges).toEqual([
      [
        "pr",
        "merge",
        "7",
        "--repo",
        "o/r",
        "--auto",
        "--squash",
        "--match-head-commit",
        head,
        "--subject",
        "feat(DIPO-7): add the greeting",
        "--body",
        "",
      ],
      ["pr", "merge", "7", "--repo", "o/r", "--disable-auto"],
    ]);
    for (const merge of merges) expect(merge).not.toContain("--admin");
  });

  it("has no --admin anywhere in the code of any package, comments aside", () => {
    const root = join(import.meta.dir, "../../..");
    const found = readdirSync(root)
      .map((name) => join(root, name, "src"))
      .filter((dir) => statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true)
      .flatMap(sources)
      .filter((path) => codeOf(path).includes("--admin"));
    expect(found).toEqual([]);
  });
});
