// The engine commits an office base has after the daemon's build commit (DIPO-198): only commits
// that change files under `packages/` count, and an office whose repository lacks the build commit
// gets no count.

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { withBareRemote } from "@dipsaus-orchestrator/testkit";

import { buildCommitSha, engineCommitsAfter } from "../../src/git";

import { officeGit, published } from "./helpers";

describe("engineCommitsAfter", () => {
  it("counts the base commits after the build commit that change packages/", async () => {
    await withBareRemote(async (repo) => {
      const build = await published(repo);
      const write = (file: string) => {
        mkdirSync(dirname(join(repo.dir, file)), { recursive: true });
        writeFileSync(join(repo.dir, file), `${file}\n`);
      };
      write("packages/engine/prompt.md");
      await repo.commitAll("engine change");
      write("docs/notes.md");
      await repo.commitAll("docs only");
      await repo.git("push", "--quiet", "origin", "main");
      const office = officeGit(repo);
      await office.fetch();

      expect(await engineCommitsAfter(office, build)).toBe(1);
      expect(await engineCommitsAfter(office, `${build}-dirty`)).toBe(1);
      expect(await engineCommitsAfter(office, build.slice(0, 12))).toBe(1);
    });
  });

  it("gives no count to an office whose repository lacks the build commit", async () => {
    await withBareRemote(async (repo) => {
      await published(repo);
      const office = officeGit(repo);
      await office.fetch();
      expect(await engineCommitsAfter(office, "0123456789ab")).toBeNull();
      expect(await engineCommitsAfter(office, "not-a-commit")).toBeNull();
    });
  });

  it("reads the commit out of a stamp", () => {
    expect(buildCommitSha("1a2b3c4d5e6f-dirty")).toBe("1a2b3c4d5e6f");
    expect(buildCommitSha("--upload-pack=x")).toBeNull();
  });
});
