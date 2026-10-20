// The reviewer's story diff keeps `a/` and `b/` prefixes whatever the git config says (DIPO-219,
// from the DIPO-146 review): parseStoryDiff reads the changed paths from the `+++ b/<path>` lines.

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { parseStoryDiff } from "../../src/review/diff";
import { storyDiffArgs } from "../../src/run/review-launch";

function git(cwd: string, args: readonly string[]): string {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@example.test", ...args],
    { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

describe("the story diff", () => {
  it("passes fixed a/ and b/ prefixes", () => {
    expect(storyDiffArgs("base...HEAD")).toEqual(
      expect.arrayContaining(["--src-prefix=a/", "--dst-prefix=b/", "base...HEAD"]),
    );
  });

  for (const config of ["diff.noprefix=true", "diff.dstPrefix=new/"]) {
    it(`keeps the changed path readable with ${config}`, () =>
      withTempDir(async (dir) => {
        git(dir, ["init", "-q", "-b", "main"]);
        writeFileSync(join(dir, "a.txt"), "one\n");
        git(dir, ["add", "a.txt"]);
        git(dir, ["commit", "-q", "-m", "base"]);
        mkdirSync(join(dir, "src"));
        writeFileSync(join(dir, "src", "f.ts"), "export const x = 1;\n");
        git(dir, ["add", "src/f.ts"]);
        git(dir, ["commit", "-q", "-m", "change"]);

        const diff = git(dir, ["-c", config, ...storyDiffArgs("HEAD~1...HEAD")]);

        expect(diff).toContain("+++ b/src/f.ts");
        expect([...parseStoryDiff(diff).files.keys()]).toEqual(["src/f.ts"]);
      }));
  }
});
